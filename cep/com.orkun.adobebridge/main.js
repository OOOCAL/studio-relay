/* Adobe Bridge panel: keeps a WebSocket open to the local adobe-bridge MCP server
   and runs the ExtendScript it receives through the host's evalScript.

   Built to survive drops: it reconnects on its own, notices a silent connection
   (sleeping Mac, server restart) through a heartbeat, and keeps finished results in an
   outbox until the server has them, so a long render that ends during a reconnect
   is not lost. A script id is never run twice. */
(function () {
  var PANEL_VERSION = "0.2.0";
  var PORT = 8765;
  var URL = "ws://127.0.0.1:" + PORT;
  var SILENCE_MS = 35000;   // no ping from the server for this long -> reconnect
  var cep = window.__adobe_cep__;
  var env = {};
  try { env = JSON.parse(cep.getHostEnvironment()); } catch (e) {}
  var APP = env.appName || "UNKNOWN";
  var VERSION = env.appVersion || "";

  var ws = null, retry = 500, timer = null, lastHeard = 0;
  var outbox = [];          // results not yet delivered
  var seen = {};            // message id -> true (never run the same script twice)
  var running = 0;
  var $ = function (id) { return document.getElementById(id); };

  function log(s) {
    var el = $("log"); if (!el) return;
    var line = document.createElement("div");
    line.textContent = new Date().toTimeString().slice(0, 8) + "  " + s;
    el.insertBefore(line, el.firstChild);
    while (el.childNodes.length > 30) el.removeChild(el.lastChild);
  }
  function setStatus(on, text) {
    if ($("dot")) $("dot").className = "dot" + (on ? " on" : "") + (running ? " busy" : "");
    if ($("status")) $("status").textContent = text;
  }
  function refreshStatus() {
    var open = ws && ws.readyState === 1;
    setStatus(open, open ? ("Claude'a bağlı · " + APP + " " + VERSION + (running ? " · çalışıyor…" : "")) : "Bağlı değil — sunucu bekleniyor");
  }

  function evalScript(script) {
    return new Promise(function (resolve) { cep.evalScript(script, resolve); });
  }

  function deliver(reply) {
    if (!send(reply)) outbox.push(reply);
  }

  function run(msg) {
    if (seen[msg.id]) { send({ type: "ack", id: msg.id }); return; }
    seen[msg.id] = true;
    send({ type: "ack", id: msg.id });
    running++; refreshStatus();
    var started = Date.now();
    // host.jsx defines __bridgeRun(codeString) -> JSON string {ok, result|error}
    var call = "__bridgeRun(" + JSON.stringify(msg.code) + ")";
    evalScript(call).then(function (res) {
      var reply;
      if (res === "EvalScript error.") {
        reply = { ok: false, error: "EvalScript error (host.jsx not loaded or syntax error)" };
      } else {
        try { reply = JSON.parse(res); } catch (e) { reply = { ok: true, result: res }; }
      }
      reply.type = "result";
      reply.id = msg.id;
      running--; deliver(reply); refreshStatus();
      log((reply.ok ? "ok " : "hata ") + Math.round((Date.now() - started) / 100) / 10 + " sn");
    });
  }

  function send(obj) {
    try { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); return true; } } catch (e) {}
    return false;
  }

  function scheduleReconnect() {
    clearTimeout(timer);
    timer = setTimeout(connect, retry);
    retry = Math.min(retry * 2, 5000);
  }

  function connect() {
    clearTimeout(timer);
    try { if (ws) { ws.onclose = null; ws.close(); } } catch (e) {}
    setStatus(false, "Bağlanıyor…");
    var sock;
    try { sock = new WebSocket(URL); } catch (e) { scheduleReconnect(); return; }
    ws = sock;
    sock.onopen = function () {
      retry = 500; lastHeard = Date.now();
      evalScript("__bridgeDocName()").then(function (doc) {
        var pendingOut = outbox.splice(0);
        if (!send({ type: "hello", role: "panel", app: APP, version: VERSION, panelVersion: PANEL_VERSION, document: doc, outbox: pendingOut })) {
          outbox = pendingOut.concat(outbox);
        }
      });
      refreshStatus();
      if ($("detail")) $("detail").textContent = URL;
    };
    sock.onmessage = function (ev) {
      lastHeard = Date.now();
      var msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type === "run") run(msg);
      else if (msg.type === "ping") send({ type: "pong", t: msg.t, running: running });
    };
    sock.onclose = function () {
      if (ws !== sock) return;
      refreshStatus();
      if ($("detail")) $("detail").textContent = "Claude açık mı? " + URL;
      scheduleReconnect();
    };
    sock.onerror = function () {};
  }

  // watchdog: a connection that looks open but has gone quiet is reconnected
  setInterval(function () {
    if (ws && ws.readyState === 1 && Date.now() - lastHeard > SILENCE_MS) { log("sessiz bağlantı, yeniden bağlanıyor"); connect(); }
  }, 5000);

  // keep the panel alive in Photoshop when it is closed or hidden
  try {
    if (APP === "PHXS" || APP === "PHSP") {
      var ev = { type: "com.adobe.PhotoshopPersistent", scope: "APPLICATION", appId: APP, extensionId: cep.getExtensionId(), data: "" };
      cep.dispatchEvent(ev);
    }
  } catch (e) {}

  // tell the server which document is open when the user switches documents
  try {
    var docEvents = ["documentAfterActivate", "afterActivate", "com.adobe.csxs.events.ApplicationActivate"];
    for (var i = 0; i < docEvents.length; i++) {
      cep.addEventListener(docEvents[i], function () {
        evalScript("__bridgeDocName()").then(function (doc) { send({ type: "doc", document: doc }); });
      });
    }
  } catch (e) {}

  if ($("reconnect")) $("reconnect").onclick = function () { retry = 500; connect(); };
  connect();
})();
