// @ts-check
/* Bridges the webview code to the VS Code extension host, which owns storage, the clipboard, the file system, the
   API keys and the model requests. The small keys go through a chrome.storage.local-shaped adapter. Must load
   before app.js. */
(function () {
  "use strict";
  const vscode = acquireVsCodeApi();

  // Set by extension.js as a data-attribute (not an inline <script> — the page's CSP has no
  // 'unsafe-inline' for script-src, so an inline script here is silently blocked). Read it into
  // a plain global before app.js runs, so a dedicated session tab boots straight into Review.
  if (document.body && document.body.dataset.openSession) {
    window.SL_OPEN_SESSION = document.body.dataset.openSession;
    // VS Code persists this across a restart and hands it back to the WebviewPanelSerializer
    // in extension.js, so this session's own editor tab reopens on its own next time.
    vscode.setState({ sessionId: window.SL_OPEN_SESSION });
  }

  // Same data-attribute mechanism, for the WASM assets the tree-sitter engines need (see extension.js's
  // WASM_ASSETS) and for the engine scripts themselves (data-engines, a JSON map file → webview URI). Only
  // stashed as plain globals here: lint.js loads an engine and calls its .boot() when a session of that
  // language is first analyzed (LensLint.ensure, phase 5).
  if (document.body) {
    const d = document.body.dataset;
    if (d.engines) {
      try {
        window.SL_ENGINE_URIS = JSON.parse(d.engines);
      } catch (e) {
        /* lint.js falls back to relative paths */
      }
    }
    if (d.treeSitterWasm) {
      if (d.treeSitterJavaWasm) window.SL_WASM_URIS_JAVA = { core: d.treeSitterWasm, java: d.treeSitterJavaWasm };
      if (d.treeSitterCSharpWasm) window.SL_WASM_URIS_CSHARP = { core: d.treeSitterWasm, csharp: d.treeSitterCSharpWasm };
      if (d.treeSitterPythonWasm) window.SL_WASM_URIS_PYTHON = { core: d.treeSitterWasm, python: d.treeSitterPythonWasm };
    }
  }

  let seq = 0;
  const pending = new Map();
  const COMMANDS = ["import", "exportVerdicts", "rename"];

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg && msg.__slReply && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg.result);
      return;
    }
    // Sent by the host when this view/tab regains focus, so it can pick up edits
    // made elsewhere (another session tab, or the sidebar) while it was hidden.
    // Since phase 4 the message says what changed ({ scope, sessionId, meta }), so a page re-reads only that.
    if (msg && msg.__slRefresh && typeof window.SL_REFRESH === "function") {
      window.SL_REFRESH(msg);
    }
    // Phase 6: a command from the palette, the Sessions tree's menu or the host itself, for this page to run with its
    // own code (import and export live here, not in the host). Names from a closed list; app.js's SL_COMMAND decides
    // what each one does on this kind of page (sidebar or session tab).
    if (msg && msg.__slCommand && COMMANDS.includes(msg.name) && typeof window.SL_COMMAND === "function") {
      window.SL_COMMAND(msg.name, typeof msg.value === "string" ? msg.value.slice(0, 500) : undefined);
    }
  });

  /* Phase 7 (7B.7): a reply that never comes (the host crashed, a message was lost) must not leave the page waiting
     forever. The limit depends on the message: dialogs wait for the person, local model servers have no limit on the
     host either, a CLI or cloud call gets the host's own limit plus 10 s, and messages that wait for the host's
     migrations (host.ready) get 5 minutes. On a timeout the promise RESOLVES with { error, code: "bridge-timeout" },
     like any other host error (app.js reads { error }, it never expects a rejection); a late reply is dropped. */
  const MARGIN_MS = 10000;
  const CLOUD_TIMEOUT_MS = 10 * 60 * 1000; // = providers.js CLOUD_TIMEOUT_MS (a test checks)
  const CLI_DEFAULT_MS = 300000; // = cli.js DEFAULT_TIMEOUT (a test checks)
  const NO_LIMIT = new Set(["open:transcript", "save:file", "save:folder-files", "baseurl:set"]);
  const WAITS_FOR_HOST = /^(?:storage:get|session:|secret:)/;
  function timeoutFor(type, payload) {
    if (NO_LIMIT.has(type)) return 0;
    if (type === "ai:call") {
      const p = typeof window.LensAI !== "undefined" && window.LensAI.PROVIDERS ? window.LensAI.PROVIDERS[payload && payload.provider] : null;
      return p && p.local ? 0 : CLOUD_TIMEOUT_MS + MARGIN_MS;
    }
    if (type === "claude:run" || type === "codex:run") {
      const t = payload && Number(payload.timeoutMs);
      return (Number.isFinite(t) && t > 0 ? t : CLI_DEFAULT_MS) + MARGIN_MS;
    }
    if (type === "claude:check" || type === "codex:check") return 90000;
    if (WAITS_FOR_HOST.test(type) || type === "session:open") return 300000;
    return 60000;
  }
  function call(type, payload) {
    return new Promise((resolve) => {
      const id = ++seq;
      const ms = timeoutFor(type, payload);
      const timer = ms
        ? setTimeout(() => {
            if (!pending.has(id)) return;
            pending.delete(id);
            resolve({ error: `SessionLens: no reply from VS Code (${type}, ${Math.round(ms / 1000)} s)`, code: "bridge-timeout" });
          }, ms)
        : null;
      pending.set(id, {
        resolve: (v) => {
          if (timer) clearTimeout(timer);
          resolve(v);
        },
      });
      vscode.postMessage({ __sl: true, id, type, payload: Object.assign({}, payload) });
    });
  }
  window.__slBridgeTimeoutFor = timeoutFor; // for tests only

  // Minimal chrome.storage.local shim — enough for store.get()/store.set() in app.js.
  window.chrome = {
    storage: {
      local: {
        get: (keys) => call("storage:get", { keys }),
        set: (values) => call("storage:set", { values }).then(() => undefined),
      },
    },
  };

  // Sessions (phase 4): each one is a file kept by the host; the page loads only the ones it needs.
  // list → { items: meta[] }; get → { session, rev, meta }; put → { ok, rev, meta } | { conflict, rev } | { skipped }
  window.__slSessionList = () => call("session:list", {});
  window.__slSessionGet = (id) => call("session:get", { id });
  window.__slSessionPut = (session, opts) => call("session:put", Object.assign({ session }, opts || {}));
  window.__slSessionDelete = (id) => call("session:delete", { id });
  window.__slSessionClear = () => call("session:clear", {});

  window.__slSaveFile = (name, content) => call("save:file", { name, content });
  window.__slSaveFolder = (skillName, files) => call("save:folder-files", { skillName, files });
  window.__slClipboardWrite = (text) => call("clipboard:write", { text });
  // Claude Code CLI (a Claude subscription instead of an API key): only the VS Code host can start the process.
  window.__slClaudeRun = (payload) => call("claude:run", payload);
  window.__slClaudeCheck = (payload) => call("claude:check", payload);
  window.__slCodexRun = (payload) => call("codex:run", payload);
  window.__slCodexCheck = (payload) => call("codex:check", payload);
  // The CLI paths are VS Code settings (a page cannot set them); this only opens the Settings editor at them.
  window.__slOpenSettings = () => call("settings:open", {});
  // The address of a local server or of Qwen is kept by the host; a new one is used only after the person confirms
  // it in a VS Code dialog. → { ok: true, url } | { ok: false, cancelled: true } | { error }
  window.__slBaseUrlSet = (provider, url) => call("baseurl:set", { provider, url });
  // API keys stay in the host's SecretStorage: this page can store, delete and ask whether one exists
  // ({provider: boolean}), never read one back. HTTP requests to the providers are made by the host,
  // which adds the key itself (see providers.js); the page's CSP no longer allows it any network access.
  window.__slSecretStatus = () => call("secret:status", {});
  window.__slSecretSet = (provider, key) => call("secret:set", { provider, key });
  window.__slSecretDelete = (provider) => call("secret:delete", { provider });
  window.__slAiCall = (payload) => call("ai:call", payload);
  // Ask the host to open (or reveal) this session in its own editor tab, instead of
  // switching the view in the current webview.
  window.__slOpenSession = (id) => call("session:open", { id });
  window.__slPickTranscript = (payload) => call("open:transcript", payload || {});
  // Ask the host to close this tab (the session it was showing no longer exists).
  window.__slCloseSelf = () => call("panel:close", {});
  // Tell the host which internal tab is showing, so it can show/hide the native Sessions
  // tree (see extension.js) only while the Sessions tab itself is the one in view.
  window.__slSetActiveTab = (tab) => call("tab:active", { tab });
  // Phase 6: this page has started (the host waits for it before sending a command to the sidebar), and one timing
  // line for the host's Output channel (numbers and names only, see validate.js).
  window.__slPageReady = () => call("page:ready", {});
  window.__slLogTiming = (event, profile, ms, events) => call("log:timing", { event, profile, ms, events });

  // Prefer the browser clipboard API when the webview allows it; fall back to the
  // host (vscode.env.clipboard), which always works regardless of focus/permissions.
  const nativeWrite = navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText.bind(navigator.clipboard) : null;
  /** @type {any} */ (navigator).clipboard = navigator.clipboard || {};
  navigator.clipboard.writeText = async (text) => {
    if (nativeWrite) {
      try {
        await nativeWrite(text);
        return;
      } catch (e) {
        /* fall through to host */
      }
    }
    await window.__slClipboardWrite(text);
  };
})();
