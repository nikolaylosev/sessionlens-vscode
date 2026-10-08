"use strict";
/* The real panel (media/sidepanel.html + scripts, jsdom) wired through the real vscode-bridge.js to the real
   extension.js under the fake "vscode" module: the VS Code code path end to end, without VS Code.
   `root` lets perf/baseline.js load another checkout (0.1.100) with the same harness.
   The lint engines are loaded by lint.js on demand (phase 5); test/engine-stub.js answers those loads (opts.engines,
   opts.engineError, opts.engineHold). SKIP is for an older checkout whose sidepanel.html still lists them. */
const fs = require("fs");
const path = require("path");
const Module = require("module");
const { JSDOM, VirtualConsole } = require("jsdom");
const { stubEngineLoader } = require("./engine-stub");
const { fakeVscode, fakeContext, fakeWebviewView } = require("./fake-vscode");

const SKIP = new Set([
  "vendor-eslint.js",
  "vendor-eslint-cypress.js",
  "vendor-eslint-detox.js",
  "tree-sitter.js",
  "lint-java.js",
  "lint-csharp.js",
  "lint-python.js",
]);
const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

function loadExtensionFrom(root, vscode) {
  const orig = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "vscode") return vscode;
    return orig.call(this, request, parent, isMain);
  };
  try {
    // a fresh copy of every module under root, so two roots (or two tests) never share state
    for (const k of Object.keys(require.cache)) if (k.startsWith(root + path.sep)) delete require.cache[k];
    return require(path.join(root, "extension.js"));
  } finally {
    Module._load = orig;
  }
}

/* → { ext, context, registered, calls, vscode, root, config, setConfig }. opts: { root, globalState, storageDir, vscode: fakeVscode opts } */
function bootHost(opts = {}) {
  const root = opts.root || path.join(__dirname, "..");
  const { vscode, registered, calls, config, setConfig } = fakeVscode(opts.vscode || {});
  const ext = loadExtensionFrom(root, vscode);
  const context = fakeContext({ globalState: opts.globalState || {}, storageDir: opts.storageDir });
  ext.activate(context);
  return { ext, context, registered, calls, vscode, root, config, setConfig };
}

// A session tab as VS Code revives it after a restart (the fake has no createWebviewPanel).
function fakePanel() {
  const wv = fakeWebviewView();
  let disposeCb = null,
    viewCb = null;
  // as in VS Code: a closed tab refuses its webview and reveal(), also inside its own onDidDispose
  const gone = () => {
    if (panel.disposed) throw new Error("Webview is disposed");
  };
  const panel = {
    get webview() {
      gone();
      return wv.webview;
    },
    title: "",
    iconPath: null,
    visible: true,
    onDidChangeViewState: (cb) => {
      viewCb = cb;
    },
    onDidDispose: (cb) => {
      disposeCb = cb;
    },
    reveal() {
      gone();
    },
    dispose() {
      panel.disposed = true;
      if (disposeCb) disposeCb();
    },
    focus() {
      if (viewCb) viewCb({ webviewPanel: panel });
    },
  };
  return { panel, wv };
}

/* Opens the sidebar (no sessionId) or a session tab, loads the panel into jsdom and wires it to the host.
   → page: { window, document, sent: [{type, payload}], errors, idle(), close() } */
async function openPage(host, opts = {}) {
  const { root, registered } = host;
  let webview,
    view = null,
    panel = null;
  if (opts.sessionId) {
    const p = fakePanel();
    panel = p.panel;
    webview = p.wv.webview;
    await registered.serializers.sessionlensSession.deserializeWebviewPanel(panel, { sessionId: opts.sessionId });
    if (panel.disposed) return null;
  } else {
    const v = fakeWebviewView();
    view = v;
    webview = v.webview;
    registered.views.sessionlensView.resolveWebviewView(v.view);
  }
  const media = path.join(root, "media");
  const html = fs.readFileSync(path.join(media, "sidepanel.html"), "utf8");
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(String((e && (e.stack || e.message)) || e)));
  const dom = new JSDOM(html.replace(/<script[^>]*><\/script>/g, ""), {
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole: vc,
    url: "https://panel.invalid/",
  });
  const w = dom.window;
  if (opts.sessionId) {
    w.document.body.dataset.openSession = opts.sessionId;
    w.document.body.classList.add("sl-session");
  }
  // the <body> attributes extension.js's buildHtml() wrote (WASM and engine URIs, phase 5), as the webview gets them
  const bodyTag = /<body([^>]*)>/.exec(webview.html || "");
  if (bodyTag) {
    const tmp = new JSDOM(`<body${bodyTag[1]}></body>`).window.document.body;
    for (const a of tmp.attributes) if (a.name.startsWith("data-")) w.document.body.setAttribute(a.name, a.value);
  }
  w.alert = () => {
    errors.push("alert() was called");
  };
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.addEventListener("error", (e) => errors.push(String(e.message)));
  const engineLoads = stubEngineLoader(w, opts);

  const sent = [];
  let inflight = 0,
    closed = false;
  // host → page: what webview.postMessage() posts
  const posted = [];
  webview.postMessage = (m) => {
    posted.push(m);
    if (closed) return Promise.resolve(false);
    const data = clone(m);
    setTimeout(() => {
      if (!closed) w.dispatchEvent(new w.MessageEvent("message", { data }));
      if (m && m.__slReply) {
        inflight--;
        page.lastReplyAt = Date.now();
      }
    }, 0);
    return Promise.resolve(true);
  };
  w.acquireVsCodeApi = () => ({
    postMessage: (m) => {
      const msg = clone(m);
      sent.push({ type: msg.type, payload: msg.payload, bytes: JSON.stringify(msg).length });
      inflight++;
      setTimeout(() => {
        deliver(msg);
      }, 0);
    },
    setState() {},
    getState() {
      return undefined;
    },
  });
  // page → host: the handler wireMessages() registered on this webview
  const deliver = (msg) => webview.__handler(msg);
  function scripts() {
    const list = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]).filter((f) => !SKIP.has(f));
    return ["vscode-bridge.js", ...list];
  }
  // A real webview loads its scripts from the extension's files, so the "toggle" events of <details open> elements
  // fire before any listener exists. jsdom queues them too: let them pass before the scripts run.
  await new Promise((r) => setTimeout(r, 5));
  const t0 = Date.now();
  for (const f of scripts()) {
    let src = fs.readFileSync(path.join(media, f), "utf8");
    if (f === "app.js" && opts.patchApp) src = opts.patchApp(src);
    w.eval(src + "\n//# sourceURL=" + f);
  }
  async function idle(quietMs = 30) {
    let quiet = 0;
    while (quiet < quietMs) {
      await new Promise((r) => setTimeout(r, 5));
      if (inflight > 0) quiet = 0;
      else quiet += 5;
    }
  }
  const page = {
    window: w,
    document: w.document,
    sent,
    posted,
    errors,
    webview,
    panel,
    idle,
    t0,
    engineLoads,
    close() {
      closed = true;
      if (panel) panel.dispose();
      else if (view) view.dispose();
      w.close();
    },
    ready: async () => {
      if (w.SL_READY) await w.SL_READY;
      await idle();
    },
  };
  return page;
}

module.exports = { bootHost, openPage, loadExtensionFrom };
