// Studio Relay host script (ExtendScript, ES3). Loaded into the app by the CEP panel.

// JSON serializer that works in every ExtendScript host. It is also sent, as source,
// to apps reached through BridgeTalk (Media Encoder, Bridge, apps without a panel).
function __srStringify(v) {
  // no regex here: this function is sent to other apps as source text, and some
  // hosts rewrite regex escapes when they turn a function back into text
  function q(str) {
    str = String(str);
    var o = '"';
    for (var i = 0; i < str.length; i++) {
      var c = str.charAt(i), n = str.charCodeAt(i);
      if (c === '"') o += '\\"';
      else if (c === '\\') o += '\\\\';
      else if (n === 10) o += '\\n';
      else if (n === 13) o += '\\r';
      else if (n === 9) o += '\\t';
      else if (n < 32) o += '\\u' + ('0000' + n.toString(16)).slice(-4);
      else o += c;
    }
    return o + '"';
  }
  function s(v, depth) {
    if (depth > 12) return '"[depth]"';
    if (v === null || v === undefined) return "null";
    var t = typeof v;
    if (t === "number") return isFinite(v) ? String(v) : "null";
    if (t === "boolean") return String(v);
    if (t === "string") return q(v);
    if (t === "function") return "null";
    if (v instanceof Array) { var a = []; for (var i = 0; i < v.length; i++) a.push(s(v[i], depth + 1)); return "[" + a.join(",") + "]"; }
    try { if (v instanceof File || v instanceof Folder) return q(v.fsName); } catch (e) {}
    var o = []; for (var k in v) { if (v.hasOwnProperty && !v.hasOwnProperty(k)) continue; var val; try { val = v[k]; } catch (e) { continue; } if (typeof val === "function") continue; o.push(q(k) + ":" + s(val, depth + 1)); }
    return "{" + o.join(",") + "}";
  }
  return s(v, 0);
}
if (typeof JSON !== "object") { JSON = {}; }
if (typeof JSON.stringify !== "function") { JSON.stringify = __srStringify; }

function __bridgeRun(code) {
  try {
    var fn = new Function(code);
    var result = fn();
    return JSON.stringify({ ok: true, result: result === undefined ? null : result });
  } catch (e) {
    var msg = (e && e.message) ? e.message : String(e);
    if (e && e.line) msg += " (line " + e.line + ")";
    return JSON.stringify({ ok: false, error: msg });
  }
}

function __bridgeDocName() {
  try {
    if (typeof BridgeTalk !== "undefined") {
      var a = BridgeTalk.appName;
      if (a === "aftereffects") return app.project.file ? app.project.file.name : "(unsaved)";
      if (a === "premierepro") return app.project ? app.project.name : "";
      if (a === "photoshop" || a === "illustrator" || a === "indesign") return app.documents.length ? app.activeDocument.name : "";
      if (a === "audition") return app.activeDocument ? app.activeDocument.displayName : "";
      if (a === "bridge") return app.document ? decodeURI(app.document.presentationPath || "") : "";
    }
  } catch (e) {}
  return "";
}

// ---------------------------------------------------------------- BridgeTalk relay
// Runs a script in another Adobe app (Media Encoder, Bridge, or an app whose panel is
// not loaded) through this app. __relaySend starts it, the panel polls __relayPoll.
var __relayBox = {};

function __relayBody(code) {
  return "(function(){" + __srStringify.toString() +
    "try{var __r=(function(){\n" + code + "\n})();return __srStringify({ok:true,result:(__r===undefined?null:__r)});}" +
    "catch(e){var m=(e&&e.message)?e.message:String(e);if(e&&e.line)m+=' (line '+e.line+')';return __srStringify({ok:false,error:m});}" +
    "})();";
}

function __relaySend(id, target, code, launch) {
  try {
    if (typeof BridgeTalk === "undefined") return __srStringify({ ok: false, error: "BridgeTalk is not available in this app" });
    var running = false;
    try { running = BridgeTalk.isRunning(target); } catch (e) {}
    if (!running) {
      if (!launch) return __srStringify({ ok: false, error: target + " is not running. Open it, or call again with launch: true to start it." });
      try { BridgeTalk.launch(target); } catch (e) { return __srStringify({ ok: false, error: "Could not start " + target + ": " + e }); }
    }
    var bt = new BridgeTalk();
    bt.target = target;
    bt.body = __relayBody(code);
    bt.onResult = function (r) { __relayBox[id] = r.body; };
    bt.onError = function (r) { __relayBox[id] = __srStringify({ ok: false, error: "BridgeTalk error from " + target + ": " + r.body }); };
    bt.send();
    return "sent";
  } catch (e) {
    return __srStringify({ ok: false, error: "Relay to " + target + " failed: " + ((e && e.message) || e) });
  }
}

function __relayPoll(id) {
  try { if (typeof BridgeTalk !== "undefined" && BridgeTalk.pump) BridgeTalk.pump(); } catch (e) {}
  if (__relayBox[id] !== undefined) { var r = __relayBox[id]; delete __relayBox[id]; return r; }
  return "";
}
