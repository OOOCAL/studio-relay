#!/usr/bin/env node
// studio-relay — a local MCP server for Adobe desktop apps.
//
// Claude (Desktop / Code) <-stdio-> this server <-WebSocket-> CEP panel in each Adobe app
//
// The first server process to start owns the WebSocket hub on 127.0.0.1:PORT.
// Any later process (a second Claude window, Claude Code, ...) joins that hub as a
// "controller". If the owner goes away, a controller takes the hub over, and the
// panels reconnect to it on their own.
//
// Long scripts (renders, exports, big batch edits) run as jobs: a call waits up to
// `wait_ms` and, if the app is still busy, returns a job id instead of timing out.
// `job_result` picks the answer up later. Nothing is ever run twice by a retry.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION = "0.3.0";
const PORT = Number(process.env.STUDIO_RELAY_PORT || 8765);
const HOST = "127.0.0.1";
const DEFAULT_WAIT = Number(process.env.STUDIO_RELAY_WAIT_MS || 45_000);     // how long a tool call waits for an answer
const DEFAULT_JOB_TIMEOUT = 30 * 60_000;                                       // hard limit for one script
const HEARTBEAT_MS = 10_000;
const PANEL_GRACE_MS = 2 * 60_000;   // keep a running job alive while its panel reconnects
const JOB_KEEP_MS = 60 * 60_000;     // finished jobs are kept this long for job_result
const log = (...a) => console.error("[studio-relay]", ...a); // stderr only: stdout is MCP

process.on("uncaughtException", (e) => log("uncaught:", e?.stack || e));
process.on("unhandledRejection", (e) => log("unhandled:", e?.stack || e));

const APP_ALIASES = {
  AEFT: "AEFT", ae: "AEFT", aftereffects: "AEFT", "after effects": "AEFT",
  PPRO: "PPRO", pr: "PPRO", premiere: "PPRO", "premiere pro": "PPRO",
  PHXS: "PHXS", PHSP: "PHXS", ps: "PHXS", photoshop: "PHXS",
  ILST: "ILST", ai: "ILST", illustrator: "ILST",
  IDSN: "IDSN", id: "IDSN", indesign: "IDSN",
  AUDT: "AUDT", au: "AUDT", audition: "AUDT",
  AME: "AME", ame: "AME", "media encoder": "AME", mediaencoder: "AME", "adobe media encoder": "AME", encoder: "AME",
  KBRG: "KBRG", bridge: "KBRG", "adobe bridge": "KBRG", br: "KBRG",
};
const APP_NAMES = { AEFT: "After Effects", PPRO: "Premiere Pro", PHXS: "Photoshop", ILST: "Illustrator", IDSN: "InDesign", AUDT: "Audition", AME: "Media Encoder", KBRG: "Bridge" };
// BridgeTalk names: an app without its own panel is reached through any app that has one
const BT_TARGET = { AEFT: "aftereffects", PPRO: "premierepro", PHXS: "photoshop", ILST: "illustrator", IDSN: "indesign", AUDT: "audition", AME: "ame", KBRG: "bridge" };
const RELAY_ORDER = ["PPRO", "AEFT", "PHXS", "IDSN", "ILST", "AUDT", "KBRG", "AME"];
// installed Adobe apps that have no scripting interface Studio Relay can use
const NOT_SCRIPTABLE = {
  "Lightroom": "Lightroom only has a Lua plug-in SDK, no ExtendScript.",
  "Character Animator": "Character Animator has no scripting interface.",
  "XD": "XD is discontinued and only takes UXP plug-ins.",
  "Dimension": "Dimension is discontinued and has no scripting interface.",
  "Acrobat": "Acrobat uses its own JavaScript, not ExtendScript; not supported yet.",
  "Animate": "Animate uses JSFL; not supported yet.",
};
const normApp = (a) => APP_ALIASES[String(a ?? "").trim()] || APP_ALIASES[String(a ?? "").trim().toLowerCase()] || null;
const appName = (a) => APP_NAMES[a] || a;
// which connected panel carries a script for `app`: its own, or another one that relays it
function relayPanel(app) {
  for (const k of RELAY_ORDER) if (k !== app && panels.has(k)) return k;
  for (const k of panels.keys()) if (k !== app) return k;
  return null;
}
const route = (app) => panels.has(app) ? app : (BT_TARGET[app] ? relayPanel(app) : null);
const runMsg = (job) => job.via === job.app ? { type: "run", id: job.msgId, code: job.code }
  : { type: "run", id: job.msgId, code: job.code, target: BT_TARGET[job.app], launch: !!job.launch };
const versionLess = (a, b) => { const x = String(a || "0.1.0").split(".").map(Number), y = String(b || "0.1.0").split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); return false; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ================================================================ hub (owner mode)
const panels = new Map();   // app -> { ws, info, lastSeen }
const queues = new Map();   // app -> tail promise (one script at a time per app; survives reconnects)
const jobs = new Map();     // job id -> job
const waiting = new Map();  // panel message id -> job id
let wss = null;
let seq = 0;
const newId = (p = "j") => `${p}${process.pid.toString(36)}-${(++seq).toString(36)}-${Date.now().toString(36)}`;

function startHub() {
  return new Promise((resolve, reject) => {
    const server = new WebSocketServer({ host: HOST, port: PORT });
    server.once("listening", () => { wss = server; log(`hub listening on ws://${HOST}:${PORT}`); resolve(server); });
    server.once("error", reject);
    server.on("connection", onConnection);
    // heartbeat: drop sockets that stopped answering (sleeping laptop, crashed app)
    const hb = setInterval(() => {
      for (const ws of server.clients) {
        if (ws._alive === false) { log("dropping silent socket", ws._panelApp || "controller"); ws.terminate(); continue; }
        ws._alive = false;
        try { ws.ping(); ws.send(JSON.stringify({ type: "ping", t: Date.now() })); } catch {}
      }
      sweepJobs();
    }, HEARTBEAT_MS);
    server.on("close", () => clearInterval(hb));
  });
}

function onConnection(ws) {
  ws._alive = true;
  ws.on("pong", () => { ws._alive = true; });
  ws.on("error", (e) => log("socket error:", e.message));
  ws.on("message", (raw) => {
    ws._alive = true;
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    switch (msg.type) {
      case "hello":
        if (msg.role === "panel") registerPanel(ws, msg);
        else if (msg.role === "controller") ws._controller = true;
        break;
      case "pong": case "ping":
        if (ws._panelApp && panels.get(ws._panelApp)) panels.get(ws._panelApp).lastSeen = Date.now();
        break;
      case "result":
        onPanelResult(msg);
        break;
      case "ack": {
        const j = jobs.get(waiting.get(msg.id));
        if (j) j.acked = true;
        break;
      }
      case "doc":
        if (ws._panelApp && panels.get(ws._panelApp)) panels.get(ws._panelApp).info.document = msg.document;
        break;
      default:
        if (ws._controller && ["run", "list", "job"].includes(msg.type)) {
          handleRequest(msg).then(
            (result) => safeSend(ws, { type: "reply", id: msg.id, ok: true, result }),
            (err) => safeSend(ws, { type: "reply", id: msg.id, ok: false, error: String(err?.message || err) }),
          );
        }
    }
  });
  ws.on("close", () => {
    const app = ws._panelApp;
    if (app && panels.get(app)?.ws === ws) {
      panels.delete(app);
      log(`panel disconnected: ${app} (running jobs wait ${PANEL_GRACE_MS / 1000}s for it to come back)`);
    }
  });
}

function registerPanel(ws, msg) {
  const app = normApp(msg.app) || msg.app;
  const old = panels.get(app);
  if (old && old.ws !== ws && old.ws.readyState === WebSocket.OPEN && versionLess(msg.panelVersion, old.info.panel)) {
    // an outdated second panel (e.g. the old adobe-bridge panel still installed): keep the current one
    log(`ignoring outdated panel ${msg.panelVersion || "0.1"} for ${app}; remove it from the CEP extensions folder`);
    try { ws.close(4001, "outdated panel"); } catch {}
    return;
  }
  if (old && old.ws !== ws) { try { old.ws.close(4000, "replaced"); } catch {} }
  ws._panelApp = app;
  panels.set(app, { ws, lastSeen: Date.now(), info: { app, name: appName(app), version: msg.version, document: msg.document, panel: msg.panelVersion } });
  log(`panel connected: ${app} ${msg.version || ""} (panel ${msg.panelVersion || "?"})`);
  // the panel may be holding results it could not deliver while disconnected
  if (Array.isArray(msg.outbox)) msg.outbox.forEach(onPanelResult);
  // re-send anything that was dispatched but never acknowledged (lost in a reconnect)
  for (const job of jobs.values()) {
    if (job.via === app && job.status === "running" && !job.acked && job.msgId) {
      safeSend(ws, runMsg(job));
    }
  }
}

const safeSend = (ws, obj) => { try { if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(obj)); return true; } } catch {} return false; };

function onPanelResult(msg) {
  const jobId = waiting.get(msg.id);
  if (!jobId) return; // duplicate (already delivered via outbox) or unknown
  waiting.delete(msg.id);
  const job = jobs.get(jobId);
  if (!job || job.status !== "running") return;
  finish(job, msg.ok ? "done" : "error", msg.ok ? msg.result : null, msg.ok ? null : (msg.error || "Unknown error"));
}

function finish(job, status, result, error) {
  if (job.status !== "running" && job.status !== "queued") return;
  job.status = status; job.result = result; job.error = error; job.finished = Date.now();
  clearTimeout(job.timer);
  if (job.msgId) waiting.delete(job.msgId);
  job.code = null; // free the script text
  job._release?.();
  for (const w of job.watchers.splice(0)) w();
}

function sweepJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.status === "running" && !panels.has(job.via) && job.panelLostAt == null) job.panelLostAt = now;
    if (job.status === "running" && panels.has(job.via)) job.panelLostAt = null;
    if (job.status === "running" && job.panelLostAt && now - job.panelLostAt > PANEL_GRACE_MS) {
      finish(job, "error", null, `${appName(job.via)} panel did not come back. The script may or may not have finished; check the app before running it again.`);
    }
    if (job.finished && now - job.finished > JOB_KEEP_MS) jobs.delete(id);
  }
}

// Queue a script for an app. Returns the job immediately.
function submit(app, code, timeoutMs, launch) {
  const job = {
    id: newId(), app, via: null, launch: !!launch, code, status: "queued", created: Date.now(), started: null, finished: null,
    result: null, error: null, watchers: [], timeoutMs: timeoutMs || DEFAULT_JOB_TIMEOUT, acked: false, msgId: null,
  };
  jobs.set(job.id, job);
  const prev = queues.get(app) || Promise.resolve();
  const mine = prev.then(() => new Promise(async (release) => {
    job._release = release;
    if (job.status !== "queued") return release();
    // the app's panel may be reconnecting: give it the grace period before failing
    const until = Date.now() + PANEL_GRACE_MS;
    while (!route(app) && Date.now() < until && job.status === "queued") await sleep(500);
    const via = route(app);
    const panel = via && panels.get(via);
    if (!panel) { finish(job, "error", null, notConnected(app)); return; }
    job.via = via;
    job.status = "running"; job.started = Date.now();
    job.msgId = newId("m");
    waiting.set(job.msgId, job.id);
    job.timer = setTimeout(() => finish(job, "error", null,
      `Script still running after ${Math.round(job.timeoutMs / 1000)} s; stopped waiting. ${appName(app)} may still be working — check it before running again.`), job.timeoutMs);
    safeSend(panel.ws, runMsg(job)); // if this is lost, registerPanel re-sends it (not acked yet)
  }));
  queues.set(app, mine.catch(() => {}));
  return job;
}

function notConnected(app) {
  const open = [...panels.keys()].map(appName).join(", ") || "none";
  return `${appName(app)} is not connected. Open it (its Studio Relay panel loads by itself), or open any app that has the panel ` +
    `(Premiere Pro, After Effects, Photoshop…) so the script can be relayed to it. Connected now: ${open}.`;
}

// Adobe apps installed on this computer, and how Studio Relay reaches each one
let installedCache = null;
async function installedApps() {
  if (installedCache) return installedCache;
  const dirs = process.platform === "darwin" ? ["/Applications"]
    : process.platform === "win32" ? [path.join(process.env.ProgramFiles || "C:\\Program Files", "Adobe")] : [];
  const found = new Map();
  for (const d of dirs) {
    let names = [];
    try { names = await fs.readdir(d); } catch { continue; }
    for (const n of names) {
      const m = /^(?:Adobe )?(After Effects|Premiere Pro|Photoshop|Illustrator|InDesign|Audition|Media Encoder|Bridge|Lightroom(?: Classic)?|Character Animator|XD|Dimension|Acrobat(?: DC| Pro)?|Animate)(?: CC)?(?: (\d{4}))?(?:\.app)?$/i.exec(n.replace(/^Adobe /i, "Adobe "));
      if (!m || !/^adobe|acrobat/i.test(n)) continue;
      const title = /^acrobat/i.test(m[1]) ? "Acrobat" : m[1].replace(/ Classic$/i, "");
      const key = Object.keys(APP_NAMES).find((k) => APP_NAMES[k].toLowerCase() === title.toLowerCase());
      const prev = found.get(title);
      if (!prev || Number(m[2] || 0) > Number(prev.year || 0)) found.set(title, { name: title, year: m[2] || null, app: key || null });
    }
  }
  installedCache = [...found.values()].map((a) => ({ ...a, scriptable: !!a.app, note: a.app ? undefined : (NOT_SCRIPTABLE[a.name] || "No scripting interface.") }));
  setTimeout(() => { installedCache = null; }, 10 * 60_000);
  return installedCache;
}

function waitJob(job, waitMs) {
  if (job.status === "done" || job.status === "error") return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(() => { job.watchers = job.watchers.filter((w) => w !== done); resolve(); }, waitMs);
    const done = () => { clearTimeout(t); resolve(); };
    job.watchers.push(done);
  });
}

const jobView = (job) => {
  if (job.status === "done") return { status: "done", job: job.id, result: job.result ?? null };
  if (job.status === "error") return { status: "error", job: job.id, error: job.error };
  const ahead = [...jobs.values()].filter((j) => j.app === job.app && j.status === "queued" && j.created < job.created).length;
  return { status: job.status, job: job.id, app: job.app, seconds: Math.round((Date.now() - (job.started || job.created)) / 1000), queuedAhead: ahead };
};

async function handleRequest(msg) {
  if (msg.type === "list") {
    const busyFor = (app) => [...jobs.values()].filter((j) => j.app === app && (j.status === "running" || j.status === "queued")).length;
    const connected = [...panels.values()].map((p) => ({ ...p.info, busy: busyFor(p.info.app) > 0, queue: busyFor(p.info.app) }));
    const relayed = Object.keys(BT_TARGET).filter((a) => !panels.has(a) && relayPanel(a)).map((a) => ({
      app: a, name: appName(a), via: appName(relayPanel(a)), busy: busyFor(a) > 0,
      note: "Reached through BridgeTalk. If it is not running, pass launch: true to run_script to start it.",
    }));
    return { connected, relayed, installed: await installedApps() };
  }
  if (msg.type === "job") {
    const job = jobs.get(msg.job);
    if (!job) throw new Error(`Unknown job "${msg.job}". Jobs are kept for ${JOB_KEEP_MS / 60000} minutes after they finish, and are lost if the hub restarts.`);
    await waitJob(job, msg.waitMs ?? DEFAULT_WAIT);
    return jobView(job);
  }
  // run
  const app = normApp(msg.app);
  if (!app) throw new Error(`Unknown app "${msg.app}"`);
  if (!route(app)) {
    // a panel that is reconnecting right now gets a few seconds
    for (let i = 0; i < 10 && !route(app); i++) await sleep(500);
    if (!route(app)) throw new Error(notConnected(app));
  }
  const job = submit(app, msg.code, msg.timeoutMs, msg.launch);
  await waitJob(job, msg.waitMs ?? DEFAULT_WAIT);
  return jobView(job);
}

// ================================================================ controller mode
let mode = "owner";
let upstream = null;
const replies = new Map(); // id -> { resolve, reject, timer }

function connectUpstream() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${HOST}:${PORT}`);
    ws.once("open", () => { safeSend(ws, { type: "hello", role: "controller", version: VERSION }); resolve(ws); });
    ws.once("error", reject);
    ws.on("ping", () => {});
    ws.on("message", (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === "ping") return safeSend(ws, { type: "pong" });
      if (m.type !== "reply") return;
      const r = replies.get(m.id); if (!r) return;
      clearTimeout(r.timer); replies.delete(m.id);
      m.ok ? r.resolve(m.result) : r.reject(new Error(m.error));
    });
    ws.on("close", () => {
      if (upstream === ws) upstream = null;
      for (const [id, r] of replies) { clearTimeout(r.timer); r.reject(new Error("Lost the connection to the studio-relay hub (the Claude window that owned it closed). Check the app before running the script again; this window has taken over the hub.")); replies.delete(id); }
      // the owner is gone: try to become the hub so the panels have somewhere to reconnect
      setTimeout(() => takeOver().catch(() => {}), 300 + Math.random() * 700);
    });
  });
}

async function takeOver() {
  if (mode === "owner") return;
  try { await startHub(); mode = "owner"; log("took over the hub"); }
  catch (e) { if (e.code !== "EADDRINUSE") throw e; } // someone else was faster: stay controller
}

async function ensureRoute() {
  if (mode === "owner") return;
  if (upstream && upstream.readyState === WebSocket.OPEN) return;
  try { upstream = await connectUpstream(); }
  catch {
    await takeOver();
    if (mode !== "owner") upstream = await connectUpstream();
  }
}

async function request(msg) {
  await ensureRoute();
  if (mode === "owner") return handleRequest(msg);
  const id = newId("c");
  const waitMs = msg.waitMs ?? DEFAULT_WAIT;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { replies.delete(id); reject(new Error("The studio-relay hub did not answer. If an old \"adobe-bridge\" / \"Adobe Bridge\" extension is still installed in Claude (Settings > Extensions), remove it: it holds the same port.")); }, waitMs + 15_000);
    replies.set(id, { resolve, reject, timer });
    if (!safeSend(upstream, { ...msg, id })) { clearTimeout(timer); replies.delete(id); reject(new Error("Could not reach the studio-relay hub.")); }
  });
}

// ================================================================ snippets
const STATE = {
  AEFT: `
var out = { project: app.project.file ? app.project.file.fsName : "(unsaved)", activeComp: null, comps: [] };
for (var i = 1; i <= app.project.numItems; i++) {
  var it = app.project.item(i);
  if (it instanceof CompItem) out.comps.push({ name: it.name, w: it.width, h: it.height, fps: it.frameRate, duration: it.duration, layers: it.numLayers });
}
var c = app.project.activeItem;
if (c && c instanceof CompItem) {
  var L = [];
  for (var j = 1; j <= c.numLayers; j++) { var l = c.layer(j); L.push({ index: j, name: l.name, enabled: l.enabled, inPoint: l.inPoint, outPoint: l.outPoint }); }
  out.activeComp = { name: c.name, w: c.width, h: c.height, fps: c.frameRate, duration: c.duration, time: c.time, layers: L };
}
return out;`,
  PPRO: `
var p = app.project, out = { project: p.path, sequences: [], active: null };
for (var i = 0; i < p.sequences.numSequences; i++) { var s = p.sequences[i]; out.sequences.push({ name: s.name, id: s.sequenceID }); }
var a = p.activeSequence;
if (a) {
  var tracks = function (coll, kind) { var r = []; for (var t = 0; t < coll.numTracks; t++) { var tr = coll[t], cl = [];
    for (var k = 0; k < tr.clips.numItems; k++) { var c = tr.clips[k]; cl.push({ n: k + 1, name: c.name, start: c.start.seconds, end: c.end.seconds, inPoint: c.inPoint.seconds, outPoint: c.outPoint.seconds }); }
    r.push({ track: kind + (t + 1), clips: cl }); } return r; };
  out.active = { name: a.name, fps: a.getSettings ? 1 / a.getSettings().videoFrameRate.seconds : null, end: a.end / 254016000000,
                 playhead: a.getPlayerPosition().seconds, video: tracks(a.videoTracks, "V"), audio: tracks(a.audioTracks, "A") };
}
return out;`,
  PHXS: `
var out = { documents: [] };
for (var i = 0; i < app.documents.length; i++) { var d = app.documents[i]; out.documents.push({ name: d.name, w: d.width.as("px"), h: d.height.as("px"), layers: d.layers.length }); }
out.active = app.documents.length ? app.activeDocument.name : null;
return out;`,
  ILST: `
var out = { documents: [] };
for (var i = 0; i < app.documents.length; i++) { var d = app.documents[i]; out.documents.push({ name: d.name, artboards: d.artboards.length, layers: d.layers.length }); }
out.active = app.documents.length ? app.activeDocument.name : null;
return out;`,
  IDSN: `
var out = { documents: [] };
for (var i = 0; i < app.documents.length; i++) { var d = app.documents[i]; out.documents.push({ name: d.name, pages: d.pages.length }); }
out.active = app.documents.length ? app.activeDocument.name : null;
return out;`,
  AUDT: `
var out = { app: "Audition" };
try { out.document = app.activeDocument ? app.activeDocument.displayName : null; } catch (e) {}
return out;`,
  AME: `
var out = { app: "Media Encoder" };
try { out.version = app.version; } catch (e) {}
try { var fe = app.getFrontend(); out.frontend = !!fe; } catch (e) {}
try { var eh = app.getEncoderHost(); out.encoderHost = !!eh; if (eh && eh.isBatchRunning) out.batchRunning = eh.isBatchRunning(); } catch (e) {}
return out;`,
  KBRG: `
var out = { app: "Bridge", folder: null, selection: [], items: null };
try { out.folder = decodeURI(app.document.presentationPath); } catch (e) {}
try { var s = app.document.selections; for (var i = 0; i < s.length && i < 200; i++) out.selection.push(s[i].spec ? s[i].spec.fsName : s[i].name); } catch (e) {}
try { out.items = app.document.visibleThumbnailsLength; } catch (e) {}
return out;`,
};

const frameSnippet = (app, time, comp, file) => {
  const f = JSON.stringify(file);
  if (app === "AEFT") return `
var c = ${comp ? `(function(){ for (var i=1;i<=app.project.numItems;i++){ var it=app.project.item(i); if (it instanceof CompItem && it.name===${JSON.stringify(comp)}) return it; } return null; })()` : "app.project.activeItem"};
if (!c || !(c instanceof CompItem)) throw new Error("No comp found. Open a comp or pass comp name.");
var t = ${time == null ? "c.time" : Number(time)};
c.saveFrameToPng(t, new File(${f}));
return { comp: c.name, time: t, file: ${f} };`;
  if (app === "PPRO") return `
app.enableQE();
var s = qe.project.getActiveSequence();
if (!s) throw new Error("No active sequence.");
var seq = app.project.activeSequence;
var t = ${time == null ? "seq.getPlayerPosition().seconds" : Number(time)};
var tc = new Time(); tc.seconds = t;
var str = tc.getFormatted(seq.getSettings().videoFrameRate, seq.getSettings().videoDisplayFormat);
s.exportFramePNG(str, ${f});
return { sequence: seq.name, time: t, file: ${f} };`;
  if (app === "PHXS") return `
if (!app.documents.length) throw new Error("No open document.");
var d = app.activeDocument.duplicate("__bridge_preview", true);
var maxSide = 2000; var w = d.width.as("px"), h = d.height.as("px");
if (Math.max(w, h) > maxSide) d.resizeImage(UnitValue(w * maxSide / Math.max(w, h), "px"), null, 72, ResampleMethod.BICUBIC);
var o = new PNGSaveOptions(); d.saveAs(new File(${f}), o, true); d.close(SaveOptions.DONOTSAVECHANGES);
return { document: app.activeDocument.name, file: ${f} };`;
  if (app === "ILST") return `
if (!app.documents.length) throw new Error("No open document.");
var d = app.activeDocument; var o = new ExportOptionsPNG24(); o.artBoardClipping = true; o.antiAliasing = true;
d.exportFile(new File(${f}), ExportType.PNG24, o);
return { document: d.name, file: ${f} };`;
  if (app === "IDSN") return `
if (!app.documents.length) throw new Error("No open document.");
app.pngExportPreferences.pageString = String(app.activeWindow.activePage.name);
app.pngExportPreferences.exportResolution = 100;
app.activeDocument.exportFile(ExportFormat.PNG_FORMAT, new File(${f}), false);
return { document: app.activeDocument.name, page: app.pngExportPreferences.pageString, file: ${f} };`;
  throw new Error(`export_frame does not support ${appName(app)}. Use run_script to export.`);
};

async function waitForFile(file, ms = 30_000) {
  const end = Date.now() + ms;
  let last = -1;
  while (Date.now() < end) {
    try {
      const st = await fs.stat(file);
      if (st.size > 0 && st.size === last) return true; // size stable = write finished
      last = st.size;
    } catch {}
    await sleep(300);
  }
  return false;
}

// ================================================================ MCP tools
const text = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (err) => ({ isError: true, content: [{ type: "text", text: String(err?.message || err) }] });
const appParam = z.string().describe("Target app: AEFT/ae/aftereffects, PPRO/pr/premiere, PHXS/ps/photoshop, ILST/ai/illustrator, IDSN/id/indesign, AUDT/audition, AME/ame/media encoder, KBRG/bridge");
const waitParam = z.number().int().min(0).max(55_000).optional()
  .describe(`How long to wait for the answer before returning a job id instead (default ${DEFAULT_WAIT} ms). Keep under 55000 when the call goes through a remote bridge with a 60 s limit.`);

function jobReply(v) {
  if (v.status === "done") return text(v.result);
  if (v.status === "error") return fail(v.error);
  return text(`Still ${v.status} in ${appName(v.app)} after ${v.seconds} s (job ${v.job}${v.queuedAhead ? `, ${v.queuedAhead} queued ahead` : ""}). ` +
    `The script keeps running. Call job_result with job_id "${v.job}" to get the result. Do NOT run the script again.`);
}

const server = new McpServer({ name: "studio-relay", version: VERSION });

server.registerTool("list_apps", {
  title: "List connected Adobe apps",
  description: "Which Adobe apps are connected right now (own panel), which are reached through another app's panel (Media Encoder, Bridge, apps whose panel is not loaded), whether each is busy, and which Adobe apps are installed and scriptable. Call this first.",
  inputSchema: {},
}, async () => {
  try { return text(await request({ type: "list" })); } catch (e) { return fail(e); }
});

server.registerTool("app_state", {
  title: "Read app state",
  description: "Read the open project/document of an app: AE comps and active comp layers; Premiere sequences and active sequence clips per track; PS/AI/ID open documents; Media Encoder status; Bridge folder and selection. Call before editing.",
  inputSchema: { app: appParam },
}, async ({ app }) => {
  const a = normApp(app);
  if (!a) return fail(`Unknown app "${app}"`);
  try { return jobReply(await request({ type: "run", app: a, code: STATE[a] })); } catch (e) { return fail(e); }
});

server.registerTool("run_script", {
  title: "Run ExtendScript in an Adobe app",
  description:
    "Run ExtendScript (ES3 JavaScript) inside the app and return its result. The code runs as a function body: use `return` to send a value back (it is JSON-serialized). " +
    "Throw to report an error. Scripts for one app run one at a time, in order. If the script takes longer than wait_ms, you get a job id: call job_result with it — never re-run the script. " +
    "In After Effects wrap edits in app.beginUndoGroup('name') / app.endUndoGroup() so the user can undo them in one step. " +
    "Premiere: use app.project / app.project.activeSequence; call app.enableQE() for the qe DOM. No ES5+ features (no let/const, arrow functions, Array.map on older hosts). " +
    "Media Encoder and Bridge (and any app whose own panel is not loaded) are reached through BridgeTalk from another connected app; set launch: true to start the app if it is closed.",
  inputSchema: {
    app: appParam,
    code: z.string().describe("ExtendScript function body"),
    wait_ms: waitParam,
    timeout_ms: z.number().int().positive().max(6 * 60 * 60_000).optional().describe("Hard limit for the whole script (default 30 min). Renders can set more."),
    launch: z.boolean().optional().describe("Start the app if it is not running (only for apps reached through BridgeTalk, e.g. Media Encoder, Bridge). Default false."),
  },
}, async ({ app, code, wait_ms, timeout_ms, launch }) => {
  const a = normApp(app);
  if (!a) return fail(`Unknown app "${app}"`);
  try { return jobReply(await request({ type: "run", app: a, code, waitMs: wait_ms, timeoutMs: timeout_ms, launch })); } catch (e) { return fail(e); }
});

server.registerTool("job_result", {
  title: "Get the result of a long-running script",
  description: "Wait for (up to wait_ms) and return the result of a script that run_script, app_state or export_frame handed back as a job id.",
  inputSchema: { job_id: z.string(), wait_ms: waitParam },
}, async ({ job_id, wait_ms }) => {
  try { return jobReply(await request({ type: "job", job: job_id, waitMs: wait_ms })); } catch (e) { return fail(e); }
});

server.registerTool("export_frame", {
  title: "Render a frame and look at it",
  description: "Render one frame and return it as an image, to check visual work: After Effects (active or named comp), Premiere Pro (active sequence), Photoshop (active document), Illustrator (active document), InDesign (active page).",
  inputSchema: {
    app: appParam,
    time: z.number().optional().describe("Seconds; default = current time / playhead (AE, Premiere)"),
    comp: z.string().optional().describe("After Effects comp name; default = active comp"),
  },
}, async ({ app, time, comp }) => {
  const a = normApp(app);
  if (!a) return fail(`Unknown app "${app}"`);
  const dir = path.join(os.tmpdir(), "studio-relay-frames");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${a}-${Date.now()}.png`);
  try {
    const v = await request({ type: "run", app: a, code: frameSnippet(a, time, comp, file), timeoutMs: 5 * 60_000 });
    if (v.status !== "done") return jobReply(v);
    // some hosts append ".png" themselves; accept either name
    const found = (await waitForFile(file)) ? file : (await waitForFile(file + ".png", 3_000)) ? file + ".png" : null;
    if (!found) return fail(`Render did not produce ${file}`);
    const data = (await fs.readFile(found)).toString("base64");
    fs.unlink(found).catch(() => {});
    return { content: [{ type: "image", data, mimeType: "image/png" }, { type: "text", text: JSON.stringify(v.result) }] };
  } catch (e) { return fail(e); }
});

// ================================================================ panel install / update
// The CEP panel ships next to this file (./cep). On start the server copies it into
// the user's CEP extensions folder when it is missing or older, and allows unsigned
// panels, so installing the .mcpb in Claude Desktop is the whole setup.
async function ensurePanelInstalled() {
  if (process.env.STUDIO_RELAY_NO_PANEL_INSTALL) return;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = path.join(here, "cep", "com.orkun.studiorelay");
  const home = os.homedir();
  const cepRoot = process.platform === "darwin" ? path.join(home, "Library", "Application Support", "Adobe", "CEP", "extensions")
    : process.platform === "win32" ? path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Adobe", "CEP", "extensions")
    : null;
  if (!cepRoot) return;
  const dest = path.join(cepRoot, "com.orkun.studiorelay");
  // the panel used to be called "adobe-bridge"; two panels in one app would fight over the connection
  const legacy = path.join(cepRoot, "com.orkun.adobebridge");
  if (await fs.stat(legacy).then(() => true, () => false)) {
    await fs.rm(legacy, { recursive: true, force: true });
    log(`removed the old adobe-bridge panel (${legacy})`);
  }
  const ver = async (dir) => { try { return /ExtensionBundleVersion="([^"]+)"/.exec(await fs.readFile(path.join(dir, "CSXS", "manifest.xml"), "utf8"))?.[1] || null; } catch { return null; } };
  const have = await ver(dest), want = await ver(src);
  if (!want) return; // not bundled (running from somewhere else)
  const newer = (a, b) => { const x = a.split(".").map(Number), y = (b || "0").split(".").map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
  if (have && !newer(want, have)) return;
  await fs.mkdir(cepRoot, { recursive: true });
  await fs.rm(dest, { recursive: true, force: true });
  await fs.cp(src, dest, { recursive: true });
  const { execFile } = await import("node:child_process");
  const run = (cmd, args) => new Promise((r) => execFile(cmd, args, () => r()));
  for (const v of [9, 10, 11, 12, 13, 14, 15, 16, 17]) {
    if (process.platform === "darwin") await run("defaults", ["write", `com.adobe.CSXS.${v}`, "PlayerDebugMode", "1"]);
    else await run("reg", ["add", `HKCU\\Software\\Adobe\\CSXS.${v}`, "/v", "PlayerDebugMode", "/t", "REG_SZ", "/d", "1", "/f"]);
  }
  log(`panel ${want} installed to ${dest}${have ? ` (was ${have})` : ""}; restart the Adobe apps to load it`);
}
ensurePanelInstalled().catch((e) => log("panel install skipped:", e.message));

// ================================================================ boot
try {
  await startHub();
} catch (e) {
  if (e.code === "EADDRINUSE") { mode = "controller"; log(`hub already running on ${PORT}; joining as controller`); }
  else { log("could not start hub:", e.message); process.exit(1); }
}
await server.connect(new StdioServerTransport());
log(`MCP server ${VERSION} ready (${mode})`);
// when Claude closes, exit so the port is freed and another Claude window can take the hub over
const quit = () => { try { wss?.close(); } catch {} setTimeout(() => process.exit(0), 100); };
process.stdin.on("end", quit);
process.stdin.on("close", quit);
process.on("SIGTERM", quit);
process.on("SIGINT", quit);
