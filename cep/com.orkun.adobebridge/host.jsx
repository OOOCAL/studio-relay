// Adobe Bridge host script (ExtendScript, ES3). Loaded into the app by the CEP panel.

// Minimal JSON for hosts without a native one.
if (typeof JSON !== "object") { JSON = {}; }
(function () {
  if (typeof JSON.stringify === "function") return;
  function q(s) {
    return '"' + String(s).replace(/[\\"\x00-\x1f]/g, function (c) {
      var m = { "\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r", "\t": "\\t", "\b": "\\b", "\f": "\\f" };
      return m[c] || "\\u" + ("0000" + c.charCodeAt(0).toString(16)).slice(-4);
    }) + '"';
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
    if (v instanceof File || v instanceof Folder) return q(v.fsName);
    var o = []; for (var k in v) { if (v.hasOwnProperty && !v.hasOwnProperty(k)) continue; var val; try { val = v[k]; } catch (e) { continue; } if (typeof val === "function") continue; o.push(q(k) + ":" + s(val, depth + 1)); }
    return "{" + o.join(",") + "}";
  }
  JSON.stringify = function (v) { return s(v, 0); };
})();

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
    }
  } catch (e) {}
  return "";
}
