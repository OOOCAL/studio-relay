// End-to-end tests without Adobe: fake panels + MCP clients (owner and controllers).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocket } from "ws";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.env.TEST_PORT || "8799";
const env = { ...process.env, STUDIO_RELAY_PORT: PORT, STUDIO_RELAY_WAIT_MS: "1500", STUDIO_RELAY_NO_PANEL_INSTALL: "1" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const txt = (r) => r.content.find((c) => c.type === "text").text;
let step = 0;
const ok = (name) => console.log(`  ✓ ${++step}. ${name}`);

async function client() {
  const c = new Client({ name: "test", version: "0" });
  const t = new StdioClientTransport({ command: "node", args: [path.join(root, "server.js")], env, stderr: "ignore" });
  await c.connect(t);
  return c;
}

// A fake panel that behaves like main.js: acks, dedupes, keeps an outbox across reconnects.
// Scripts run with Node's Function; `await`-free "sleep" is simulated with a SLEEP:<ms> prefix.
function fakePanel(app) {
  const p = { app, ws: null, outbox: [], seen: new Set(), runs: 0 };
  p.connect = () => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    p.ws = ws;
    ws.on("error", () => {});
    ws.on("open", () => {
      const out = p.outbox.splice(0);
      ws.send(JSON.stringify({ type: "hello", role: "panel", app, version: "test", panelVersion: "0.2.0", outbox: out }));
      resolve();
    });
    ws.on("message", (raw) => {
      const m = JSON.parse(raw);
      if (m.type === "ping") return ws.send(JSON.stringify({ type: "pong" }));
      if (m.type !== "run") return;
      ws.send(JSON.stringify({ type: "ack", id: m.id }));
      if (p.seen.has(m.id)) return;
      p.seen.add(m.id); p.runs++;
      const match = /^SLEEP:(\d+)\n/.exec(m.code);
      const delay = match ? Number(match[1]) : 0;
      const code = match ? m.code.slice(match[0].length) : m.code;
      setTimeout(() => {
        let reply;
        try { reply = { ok: true, result: new Function(code)() ?? null }; } catch (e) { reply = { ok: false, error: e.message }; }
        const msg = { type: "result", id: m.id, ...reply };
        if (p.ws.readyState === 1) p.ws.send(JSON.stringify(msg)); else p.outbox.push(msg);
      }, delay);
    });
  });
  p.drop = () => new Promise((r) => { p.ws.once("close", r); p.ws.terminate(); });
  return p;
}

console.log("studio-relay e2e");
const owner = await client();
await sleep(400);
const ae = fakePanel("AEFT");
await ae.connect();
await sleep(200);

const tools = (await owner.listTools()).tools.map((t) => t.name).sort();
assert.deepEqual(tools, ["app_state", "export_frame", "job_result", "list_apps", "run_script"]);
ok("tools listed");

const apps = JSON.parse(txt(await owner.callTool({ name: "list_apps", arguments: {} })));
assert.equal(apps[0].app, "AEFT"); assert.equal(apps[0].busy, false);
ok("list_apps");

const r1 = await owner.callTool({ name: "run_script", arguments: { app: "ae", code: "return { sum: 2 + 3 };" } });
assert.equal(JSON.parse(txt(r1)).sum, 5);
ok("run_script result");

const r2 = await owner.callTool({ name: "run_script", arguments: { app: "aftereffects", code: "throw new Error('boom')" } });
assert.equal(r2.isError, true); assert.match(txt(r2), /boom/);
ok("script error reported");

const r3 = await owner.callTool({ name: "run_script", arguments: { app: "premiere", code: "return 1" } });
assert.equal(r3.isError, true); assert.match(txt(r3), /not connected/);
ok("missing app reported");

// long script: returns a job id instead of timing out, job_result gets it later
const long = await owner.callTool({ name: "run_script", arguments: { app: "AEFT", code: "SLEEP:2500\nreturn 'rendered'", wait_ms: 500 } });
const jobId = /job_id "([^"]+)"/.exec(txt(long))?.[1];
assert.ok(jobId, "job id returned: " + txt(long));
const busy = JSON.parse(txt(await owner.callTool({ name: "list_apps", arguments: {} })));
assert.equal(busy[0].busy, true);
const jr = await owner.callTool({ name: "job_result", arguments: { job_id: jobId, wait_ms: 5000 } });
assert.equal(txt(jr), "rendered");
ok("long script becomes a job, job_result returns it");

// scripts for one app run one after another, never in parallel
const order = [];
await Promise.all([
  owner.callTool({ name: "run_script", arguments: { app: "AEFT", code: "SLEEP:400\nreturn 'a'", wait_ms: 5000 } }).then((r) => order.push(txt(r))),
  sleep(50).then(() => owner.callTool({ name: "run_script", arguments: { app: "AEFT", code: "return 'b'", wait_ms: 5000 } }).then((r) => order.push(txt(r)))),
]);
assert.deepEqual(order, ["a", "b"]);
ok("per-app queue keeps order");

// panel drops while a script is running: result is kept in its outbox and delivered after reconnect
const pend = await owner.callTool({ name: "run_script", arguments: { app: "AEFT", code: "SLEEP:800\nreturn 'survived'", wait_ms: 200 } });
const pendId = /job_id "([^"]+)"/.exec(txt(pend))[1];
await sleep(100);
await ae.drop();
await sleep(1200);           // script finishes while disconnected
await ae.connect();          // reconnect delivers the outbox
const pr = await owner.callTool({ name: "job_result", arguments: { job_id: pendId, wait_ms: 3000 } });
assert.equal(txt(pr), "survived");
assert.equal(ae.runs, 6, "nothing ran twice");
ok("result survives a panel reconnect, nothing re-run");

// an outdated panel (the old adobe-bridge 0.1 panel still installed) must not knock the current one off
const legacy = new WebSocket(`ws://127.0.0.1:${PORT}`);
await new Promise((r) => legacy.once("open", r));
const closed = new Promise((r) => legacy.once("close", (code) => r(code)));
legacy.send(JSON.stringify({ type: "hello", role: "panel", app: "AEFT", version: "old" }));
assert.equal(await closed, 4001);
assert.equal(txt(await owner.callTool({ name: "run_script", arguments: { app: "AEFT", code: "return 'still the new panel'" } })), "still the new panel");
ok("outdated panel is refused, current panel keeps working");

// second server process joins the running hub as a controller
const ctrl = await client();
await sleep(300);
const r4 = await ctrl.callTool({ name: "run_script", arguments: { app: "AEFT", code: "return 'from controller'" } });
assert.equal(txt(r4), "from controller");
const cl = await ctrl.callTool({ name: "run_script", arguments: { app: "AEFT", code: "SLEEP:1500\nreturn 'ctrl job'", wait_ms: 300 } });
const clId = /job_id "([^"]+)"/.exec(txt(cl))[1];
assert.equal(txt(await ctrl.callTool({ name: "job_result", arguments: { job_id: clId, wait_ms: 4000 } })), "ctrl job");
ok("controller runs scripts and jobs through the hub");

// the owner goes away: the controller takes the hub over and the panel finds it again
await owner.close();
await sleep(2500);
await ae.connect();
await sleep(300);
const r5 = await ctrl.callTool({ name: "run_script", arguments: { app: "AEFT", code: "return 'after takeover'", wait_ms: 5000 } });
assert.equal(txt(r5), "after takeover");
ok("controller takes over when the owner exits");

console.log("all e2e checks passed");
ae.ws.close(); await ctrl.close();
process.exit(0);
