"use strict";
/* Just enough of the "vscode" module for extension.js to activate under node --test, plus a fake context
   (globalState, SecretStorage) and a fake webview that records what the host posts back. */
const Module = require("module");
const fs = require("fs");
const os = require("os");
const path = require("path");
const PKG = require("../package.json");

function fakeVscode(opts = {}) {
  const registered = { views: {}, commands: {}, trees: {}, serializers: {} };
  const calls = {
    info: [],
    warning: [],
    error: [],
    saveDialog: [],
    openDialog: [],
    commands: [],
    mkdir: [],
    writes: [],
    clipboard: [],
    configUpdates: [],
    output: [],
    quickPick: [],
    inputBox: [],
  };
  const config = { global: Object.assign({}, (opts.config || {}).global), workspace: Object.assign({}, (opts.config || {}).workspace) };
  // machine and application scope: a workspace value is ignored (phase 6: the five panel settings are "application")
  const machineScoped = new Set(
    opts.machineScoped || [
      "sessionlens.claudeCliPath",
      "sessionlens.codexCliPath",
      "sessionlens.cursorCliPath",
      "sessionlens.minGapMs",
      "sessionlens.maxCode",
      "sessionlens.verify",
      "sessionlens.lint",
      "sessionlens.rulesTarget",
    ],
  );
  class EventEmitter {
    constructor() {
      this.listeners = [];
      this.event = (cb) => {
        this.listeners.push(cb);
        return {
          dispose: () => {
            this.listeners = this.listeners.filter((x) => x !== cb);
          },
        };
      };
    }
    fire(e) {
      for (const cb of [...this.listeners]) cb(e);
    }
  }
  const configChanged = new EventEmitter();
  // setConfig(): a change made outside the extension (settings.json by hand, another window, Settings Sync)
  const fireConfig = (keys) => configChanged.fire({ affectsConfiguration: (sec) => keys.some((k) => k === sec || k.startsWith(sec + ".")) });
  // vscode.l10n: English strings are the keys; a bundle is read from l10n/ if there is one (none since 0.1.110: the
  // extension no longer calls vscode.l10n)
  const language = opts.language || "en";
  let bundle = {};
  if (language !== "en") {
    try {
      bundle = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "l10n", `bundle.l10n.${language}.json`), "utf8"));
    } catch {
      bundle = {};
    }
  }
  const l10n = {
    t: (message, ...args) =>
      String(bundle[message] !== undefined ? bundle[message] : message).replace(/\{(\d+)\}/g, (m, i) => (args[i] !== undefined ? String(args[i]) : m)),
  };
  const Uri = {
    file: (p) => ({ fsPath: p, toString: () => "file://" + p }),
    joinPath: (base, ...parts) => {
      const p = path.join(base.fsPath, ...parts);
      return { fsPath: p, toString: () => "file://" + p };
    },
  };
  const vscode = {
    Uri,
    EventEmitter,
    ViewColumn: { Active: -1 },
    ProgressLocation: { Window: 10 },
    TreeItem: class {
      constructor(label) {
        this.label = label;
      }
    },
    TreeItemCollapsibleState: { None: 0 },
    ThemeIcon: class {},
    ThemeColor: class {},
    l10n,
    env: {
      language,
      remoteName: opts.remoteName,
      clipboard: {
        writeText: async (t) => {
          calls.clipboard.push(t);
        },
      },
    },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    window: {
      registerWebviewViewProvider: (id, p) => {
        registered.views[id] = p;
        return { dispose() {} };
      },
      registerTreeDataProvider: (id, p) => {
        registered.trees[id] = p;
        return { dispose() {} };
      },
      registerWebviewPanelSerializer: (id, s) => {
        registered.serializers[id] = s;
        return { dispose() {} };
      },
      showInformationMessage: (m) => {
        calls.info.push(m);
      },
      showErrorMessage: async (...a) => {
        calls.error.push(a);
        return undefined;
      },
      // the "SessionLens" Output channel: every line lands in calls.output
      createOutputChannel: (name) => ({
        name,
        appendLine: (l) => {
          calls.output.push(l);
        },
        show() {},
        dispose() {},
      }),
      withProgress: async (o, task) => task({ report() {} }),
      // opts.warningAnswer: what the person clicks in a modal (undefined = cancel)
      showWarningMessage: async (...a) => {
        calls.warning.push(a);
        return typeof opts.warningAnswer === "function" ? opts.warningAnswer(...a) : opts.warningAnswer;
      },
      showSaveDialog: async (o) => {
        calls.saveDialog.push(o);
        return opts.saveDialogAnswer || null;
      },
      showOpenDialog: async (o) => {
        calls.openDialog.push(o);
        return opts.openDialogAnswer || null;
      },
      createWebviewPanel: () => {
        throw new Error("not in tests");
      },
      // opts.quickPickAnswer(items) / opts.inputBoxAnswer(options): what the person picks or types (undefined = Escape)
      showQuickPick: async (items, o) => {
        calls.quickPick.push({ items, o });
        return typeof opts.quickPickAnswer === "function" ? opts.quickPickAnswer(items, o) : undefined;
      },
      showInputBox: async (o) => {
        calls.inputBox.push(o);
        return typeof opts.inputBoxAnswer === "function" ? opts.inputBoxAnswer(o) : opts.inputBoxAnswer;
      },
    },
    commands: {
      registerCommand: (id, fn) => {
        registered.commands[id] = fn;
        return { dispose() {} };
      },
      executeCommand: async (...a) => {
        calls.commands.push(a);
      },
    },
    workspace: {
      workspaceFolders: opts.workspaceFolders,
      fs: {
        createDirectory: async (u) => {
          calls.mkdir.push(u.fsPath);
        },
        writeFile: async (u, buf) => {
          calls.writes.push({ path: u.fsPath, content: Buffer.from(buf).toString("utf8") });
        },
      },
      // settings: { global: {key: value}, workspace: {key: value} }; get() follows VS Code: a machine-scoped
      // setting ignores workspace values (the fake applies that to every key in `machineScoped`)
      getConfiguration: (section) => {
        const full = (k) => (section ? section + "." + k : k);
        return {
          get: (k, dflt) => {
            const f = full(k);
            if (f in config.global) return config.global[f];
            if (!machineScoped.has(f) && f in config.workspace) return config.workspace[f];
            return dflt;
          },
          inspect: (k) => {
            const f = full(k);
            return { key: f, globalValue: config.global[f], workspaceValue: config.workspace[f] };
          },
          update: async (k, v, target) => {
            if (opts.configFails) throw new Error("cannot write settings");
            calls.configUpdates.push([full(k), v, target]);
            if (v === undefined) delete config.global[full(k)];
            else config.global[full(k)] = v;
            fireConfig([full(k)]);
          },
        };
      },
      onDidChangeConfiguration: configChanged.event,
    },
  };
  const setConfig = (key, value) => {
    if (value === undefined) delete config.global[key];
    else config.global[key] = value;
    fireConfig([key]);
  };
  return { vscode, registered, calls, config, setConfig };
}

// Loads extension.js with the fake module in place of "vscode"; a fresh copy each time.
function loadExtension(vscode) {
  const root = path.join(__dirname, "..");
  const orig = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "vscode") return vscode;
    return orig.call(this, request, parent, isMain);
  };
  try {
    const file = require.resolve(path.join(root, "extension.js"));
    delete require.cache[file];
    return require(file);
  } finally {
    Module._load = orig;
  }
}

function fakeMemento(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial));
  return {
    data,
    get: (k) => (data[k] === undefined ? undefined : JSON.parse(JSON.stringify(data[k]))),
    update: async (k, v) => {
      if (v === undefined) delete data[k];
      else data[k] = JSON.parse(JSON.stringify(v));
    },
    keys: () => Object.keys(data),
  };
}

function fakeSecretStorage({ failStore = false } = {}) {
  const map = new Map();
  return {
    map,
    get: async (k) => map.get(k),
    store: async (k, v) => {
      if (failStore) throw new Error("no keyring");
      map.set(k, v);
    },
    delete: async (k) => {
      map.delete(k);
    },
    onDidChange: () => ({ dispose() {} }),
  };
}

// storageDir: the extension's globalStorageUri (sessions live in <storageDir>/sessions); a new temporary folder if not given
function fakeContext({ globalState = {}, failStore = false, storageDir } = {}) {
  const dir = storageDir || fs.mkdtempSync(path.join(os.tmpdir(), "sl-global-"));
  return {
    subscriptions: [],
    globalStorageUri: { fsPath: dir, toString: () => "file://" + dir },
    extensionUri: { fsPath: path.join(__dirname, ".."), toString: () => "file://ext" },
    globalState: fakeMemento(globalState),
    secrets: fakeSecretStorage({ failStore }),
    // what VS Code builds from package.json: <publisher>.<name>
    extension: { id: `${PKG.publisher}.${PKG.name}`, packageJSON: PKG },
  };
}

// A webview view as resolveWebviewView() receives it; send() posts a panel message and waits for the reply.
function fakeWebviewView() {
  let handler = null,
    seq = 0;
  const posted = [];
  const webview = {
    options: {},
    html: "",
    cspSource: "vscode-resource:",
    asWebviewUri: (u) => ({ toString: () => "vscode-resource:" + u.fsPath.replace(/\\/g, "/") }), // a URI: "/" on Windows too
    onDidReceiveMessage: (cb) => {
      handler = cb;
      webview.__handler = cb;
      return { dispose() {} };
    },
    postMessage: (m) => {
      posted.push(m);
      return Promise.resolve(true);
    },
  };
  let disposeCb = null;
  const view = {
    webview,
    visible: true,
    onDidDispose: (cb) => {
      disposeCb = cb;
    },
    onDidChangeVisibility: () => {},
  };
  async function send(type, payload) {
    const id = ++seq;
    await handler({ __sl: true, id, type, payload: Object.assign({ lang: "en" }, payload) });
    const r = posted.find((m) => m.__slReply && m.id === id);
    return r && r.result;
  }
  return {
    view,
    webview,
    posted,
    send,
    dispose: () => disposeCb && disposeCb(),
    started: (type, payload) => {
      const id = ++seq;
      return { id, done: handler({ __sl: true, id, type, payload: Object.assign({ lang: "en" }, payload) }) };
    },
  };
}

module.exports = { fakeVscode, loadExtension, fakeContext, fakeMemento, fakeSecretStorage, fakeWebviewView };
