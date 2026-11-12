/**
 * Host page for a file-backed document (`/file/<session id>`).
 *
 * Frames the locally served draw.io in embed mode (`proto=json`) and acts as
 * its storage: it loads the file's XML into the editor on `init`, and on the
 * editor's `save` (and, when enabled, `autosave`) event it posts the XML to
 * `/api/files/<id>`, where the server writes the file. `mcp_file=<id>` in the
 * editor URL lets mcp-plugin.js report the document as belonging to the
 * session, so the server can map the tab to its file.
 *
 * Every message to the editor must be a JSON string; see
 * app-shell/embed-protocol.ts for why.
 */

function escape_html(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function build_file_editor_path(sessionId: string): string {
  const params = new URLSearchParams({
    embed: "1",
    proto: "json",
    local: "1",
    saveAndExit: "0",
    noExitBtn: "1",
    mcp_file: sessionId,
  });
  return `/index.html?${params.toString()}`;
}

export function render_file_shell(sessionId: string, title: string): string {
  const id = JSON.stringify(sessionId);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escape_html(title)} — draw.io</title>
<style>
  html, body { margin: 0; height: 100%; font: 13px/1.4 system-ui, sans-serif; }
  body { display: flex; flex-direction: column; }
  #bar { display: flex; gap: 1em; align-items: center; padding: 4px 10px;
         background: #f5f5f5; border-bottom: 1px solid #ddd; }
  #path { font-family: monospace; overflow: hidden; text-overflow: ellipsis;
          white-space: nowrap; flex: 1; }
  #status.error { color: #b00020; font-weight: 600; }
  #editor { flex: 1; width: 100%; border: 0; display: block; }
  button { font: inherit; }
</style>
</head>
<body>
<div id="bar">
  <span id="path"></span>
  <span id="status">Loading…</span>
  <button id="overwrite" hidden>Overwrite file</button>
</div>
<iframe id="editor" src="${escape_html(build_file_editor_path(sessionId))}"></iframe>
<script>
(function () {
  "use strict";
  var sessionId = ${id};
  var api = "/api/files/" + encodeURIComponent(sessionId);
  var editor = document.getElementById("editor");
  var statusEl = document.getElementById("status");
  var pathEl = document.getElementById("path");
  var overwriteBtn = document.getElementById("overwrite");
  var autosave = false;
  var pendingXml = null;

  function setStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.className = isError ? "error" : "";
  }

  function send(action, fields) {
    var message = { action: action };
    for (var key in fields) message[key] = fields[key];
    editor.contentWindow.postMessage(JSON.stringify(message), "*");
  }

  function parse(raw) {
    if (typeof raw !== "string") return null;
    try {
      var data = JSON.parse(raw);
      return data && typeof data.event === "string" ? data : null;
    } catch (e) {
      return null;
    }
  }

  function load() {
    fetch(api).then(function (response) {
      if (!response.ok) throw new Error("HTTP " + response.status);
      return response.json();
    }).then(function (file) {
      autosave = file.autosave === true;
      pathEl.textContent = file.path;
      pathEl.title = file.path;
      var fields = { title: file.title, autosave: autosave ? 1 : 0 };
      if (file.xml) fields.xml = file.xml;
      send("load", fields);
      setStatus(file.xml ? "Loaded" : "New file (created on first save)");
    }).catch(function (error) {
      setStatus("Could not load file: " + error.message, true);
    });
  }

  function save(xml, overwrite) {
    pendingXml = xml;
    setStatus("Saving…");
    fetch(api, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ xml: xml, overwrite: overwrite === true }),
    }).then(function (response) {
      return response.json().then(function (body) {
        return { ok: response.ok, status: response.status, body: body };
      });
    }).then(function (result) {
      if (result.ok) {
        overwriteBtn.hidden = true;
        send("status", { modified: false });
        setStatus("Saved " + new Date().toLocaleTimeString());
        return;
      }
      overwriteBtn.hidden = result.status !== 409;
      setStatus(result.body && result.body.error || "Save failed", true);
    }).catch(function (error) {
      setStatus("Save failed: " + error.message, true);
    });
  }

  overwriteBtn.addEventListener("click", function () {
    if (pendingXml !== null) save(pendingXml, true);
  });

  window.addEventListener("message", function (event) {
    if (event.source !== editor.contentWindow) return;
    var msg = parse(event.data);
    if (!msg) return;
    if (msg.event === "init") {
      load();
    } else if (msg.event === "configure") {
      send("configure", { config: {} });
    } else if (msg.event === "save") {
      save(msg.xml, false);
    } else if (msg.event === "autosave" && autosave) {
      save(msg.xml, false);
    }
  });
})();
</script>
</body>
</html>`;
}
