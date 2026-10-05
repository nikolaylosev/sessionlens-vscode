"use strict";
/* Phase 3 at the host: what a (possibly compromised) webview can no longer make extension.js do. Runs the real
   extension.js under the fake "vscode" module, the same way test/host-messages.test.js does. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { fakeVscode, loadExtension, fakeContext, fakeWebviewView } = require("./fake-vscode");
const { root } = require("./helpers");

async function boot(opts = {}) {
  const { vscode, registered, calls, config } = fakeVscode(opts);
  const ext = loadExtension(vscode);
  const context = fakeContext({ globalState: Object.assign({ settings: {}, sessions: {} }, opts.globalState) });
  ext.activate(context);
  const wv = fakeWebviewView();
  registered.views.sessionlensView.resolveWebviewView(wv.view);
  await wv.send("secret:status", {}); // waits for host.ready (the migrations)
  return { context, wv, calls, config, registered };
}
const refused = (r) => assert.ok(r && typeof r.error === "string" && r.error.startsWith("SessionLens:"), JSON.stringify(r));

// ---------- 3.1 CLI path ----------
test("package.json: the CLI paths are machine-scoped settings", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const props = pkg.contributes.configuration.properties;
  for (const k of ["sessionlens.claudeCliPath", "sessionlens.codexCliPath", "sessionlens.cursorCliPath"]) {
    assert.equal(props[k].type, "string");
    assert.equal(props[k].scope, "machine", k);
  }
});

test("claude/codex/cursor run and check use the configured path, never the payload's", async () => {
  const cfgClaude = path.join(os.tmpdir(), "sl-no-such-dir", "claude-from-settings");
  const cfgCodex = path.join(os.tmpdir(), "sl-no-such-dir", "codex-from-settings");
  const cfgCursor = path.join(os.tmpdir(), "sl-no-such-dir", "cursor-from-settings");
  const { wv } = await boot({
    config: { global: { "sessionlens.claudeCliPath": cfgClaude, "sessionlens.codexCliPath": cfgCodex, "sessionlens.cursorCliPath": cfgCursor } },
  });
  let r = await wv.send("claude:check", { cliPath: "/tmp/evil" });
  assert.deepEqual(r, { installed: false, cmd: cfgClaude });
  r = await wv.send("codex:check", { cliPath: "/tmp/evil" });
  assert.deepEqual(r, { installed: false, cmd: cfgCodex });
  r = await wv.send("claude:run", { user: "u", cliPath: "/tmp/evil" });
  assert.equal(r.error.code, "notfound");
  assert.equal(r.error.message, cfgClaude);
  r = await wv.send("codex:run", { user: "u", cliPath: "/tmp/evil" });
  assert.equal(r.error.code, "notfound");
  assert.equal(r.error.message, cfgCodex);
  r = await wv.send("cursor:check", { cliPath: "/tmp/evil" });
  assert.deepEqual(r, { installed: false, cmd: cfgCursor });
  r = await wv.send("cursor:run", { user: "u", cliPath: "/tmp/evil" });
  assert.equal(r.error.code, "notfound");
  assert.equal(r.error.message, cfgCursor);
});

test("a workspace value of the CLI path is ignored (machine scope)", async () => {
  const { wv } = await boot({ config: { workspace: { "sessionlens.claudeCliPath": "/repo/evil-claude" } } });
  const r = await wv.send("claude:check", {});
  assert.notEqual(r.cmd, "/repo/evil-claude");
});

test("migration: panel CLI paths move to the user settings once, and leave settings", async () => {
  const { context, calls, config } = await boot({
    globalState: { settings: { profile: "qa-ts", cliPath: "/old/claude", cliPaths: { claudecli: "/opt/claude", codexcli: "/opt/codex" } } },
  });
  assert.equal(config.global["sessionlens.claudeCliPath"], "/opt/claude"); // cliPaths wins over the older cliPath
  assert.equal(config.global["sessionlens.codexCliPath"], "/opt/codex");
  assert.ok(
    calls.configUpdates.every(([, , target]) => target === 1),
    "user (global) settings only",
  );
  const st = context.globalState.data.settings;
  assert.ok(!("cliPath" in st) && !("cliPaths" in st));
  assert.equal(st.profile, "qa-ts");
  assert.equal(calls.info.length, 1);
});

test("migration: an already set user setting wins; a failed write keeps the old field", async () => {
  let b = await boot({ config: { global: { "sessionlens.claudeCliPath": "/mine" } }, globalState: { settings: { cliPaths: { claudecli: "/panel" } } } });
  assert.equal(b.config.global["sessionlens.claudeCliPath"], "/mine");
  assert.ok(!("cliPaths" in b.context.globalState.data.settings));
  b = await boot({ configFails: true, globalState: { settings: { cliPaths: { claudecli: "/panel" } } } });
  assert.deepEqual(b.context.globalState.data.settings.cliPaths, { claudecli: "/panel" });
});

test("storage:set drops CLI paths and local/Qwen addresses from settings", async () => {
  const { context, wv } = await boot();
  await wv.send("storage:set", {
    values: {
      settings: {
        profile: "qa-api",
        cliPath: "/x",
        cliPaths: { claudecli: "/x" },
        baseUrls: { qwen: "https://evil", local: "http://evil", openai: "https://api.openai.com/v1" },
      },
    },
  });
  const st = context.globalState.data.settings;
  assert.ok(!("cliPath" in st) && !("cliPaths" in st));
  assert.deepEqual(st.baseUrls, { openai: "https://api.openai.com/v1" });
  assert.equal(context.globalState.data.hostBaseUrls, undefined);
});

test("settings:open opens the Settings editor at a fixed query", async () => {
  const { wv, calls } = await boot();
  assert.equal(await wv.send("settings:open", { query: "evil" }), true);
  assert.deepEqual(calls.commands.at(-1), ["workbench.action.openSettings", "sessionlens."]);
});

// ---------- 3.2 / 3.3 files ----------
test("save:folder-files: a bad path is refused before any dialog, nothing is written", async () => {
  const picked = { fsPath: path.join(os.tmpdir(), "proj"), toString: () => "" };
  for (const bad of ["../../x", "..\\..\\x", "a/../../x", "/abs", "C:/x", "CON.md"]) {
    const { wv, calls } = await boot({ openDialogAnswer: [picked] });
    refused(
      await wv.send("save:folder-files", {
        skillName: "s",
        files: [
          { path: "SKILL.md", content: "x" },
          { path: bad, content: "x" },
        ],
      }),
    );
    assert.equal(calls.openDialog.length, 0, bad);
    assert.equal(calls.writes.length, 0, bad);
  }
  const { wv, calls } = await boot({ openDialogAnswer: [picked] });
  refused(await wv.send("save:folder-files", { skillName: "../x", files: [{ path: "SKILL.md", content: "x" }] }));
  assert.equal(calls.writes.length, 0);
});

test("save:folder-files: good files land under <picked>/skills/<name>/", async () => {
  const picked = { fsPath: path.join(os.tmpdir(), "proj"), toString: () => "" };
  const { wv, calls } = await boot({ openDialogAnswer: [picked] });
  const r = await wv.send("save:folder-files", {
    skillName: "api-review",
    files: [
      { path: "SKILL.md", content: "a" },
      { path: "examples/fixed_sleep/1-x.ts", content: "b" },
    ],
  });
  const base = path.join(picked.fsPath, "skills", "api-review");
  assert.equal(r, base);
  assert.deepEqual(
    calls.writes.map((w) => w.path),
    [path.join(base, "SKILL.md"), path.join(base, "examples", "fixed_sleep", "1-x.ts")],
  );
});

test("save:file: only the basename, in the workspace folder (or home)", async () => {
  const ws = { uri: { fsPath: path.join(os.tmpdir(), "ws"), toString: () => "" } };
  let b = await boot({ workspaceFolders: [ws] });
  await b.wv.send("save:file", { name: "../../.bashrc", content: "x" });
  assert.equal(b.calls.saveDialog[0].defaultUri.fsPath, path.join(ws.uri.fsPath, ".bashrc"));
  b = await boot();
  await b.wv.send("save:file", { name: "/etc/passwd", content: "x" });
  assert.equal(b.calls.saveDialog[0].defaultUri.fsPath, path.join(os.homedir(), "passwd"));
});

// ---------- 3.4 / 3.5 ----------
test("storage:set with an unknown key is refused whole; storage:get with one too", async () => {
  const { context, wv } = await boot();
  refused(await wv.send("storage:set", { values: { rulesApplied: { a: "x" }, evil: 1 } }));
  assert.equal(context.globalState.data.rulesApplied, undefined);
  // sessions are not a storage key any more (phase 4): they go through session:* only
  refused(await wv.send("storage:set", { values: { sessions: { a: { id: "a" } } } }));
  refused(await wv.send("storage:get", { keys: ["sessions"] }));
  assert.ok(!("evil" in context.globalState.data));
  refused(await wv.send("storage:get", { keys: ["hostBaseUrls"] }));
  refused(await wv.send("storage:get", { keys: ["evil"] }));
});

test("unknown types and out-of-range payloads are refused", async () => {
  const { wv, calls } = await boot();
  refused(await wv.send("fs:delete", { path: "/" }));
  refused(await wv.send("tab:active", { tab: 'x" onload="' }));
  refused(await wv.send("session:open", { id: "does-not-exist" }));
  refused(await wv.send("clipboard:write", { text: "x".repeat(10 * 1024 * 1024 + 1) }));
  assert.equal(calls.clipboard.length, 0);
  assert.equal(calls.commands.length, 0);
});

// ---------- 3.9 addresses ----------
function server(handler) {
  return new Promise((r) => {
    const s = http.createServer(handler);
    s.listen(0, "127.0.0.1", () => r(s));
  });
}

test("ai:call never goes to the payload's baseUrl, and the Qwen key never leaves for it", async () => {
  const hits = [];
  const evil = await server((req, res) => {
    hits.push(req.headers.authorization || "");
    req.resume();
    res.end("{}");
  });
  const good = await server((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    });
  });
  try {
    const { wv, context } = await boot({ globalState: { hostBaseUrls: { qwen: `http://127.0.0.1:${good.address().port}/v1` } } });
    await context.secrets.store("sessionlens.apiKey.qwen", "sk-LEAKCHECK");
    const r = await wv.send("ai:call", { provider: "qwen", model: "q", user: "u", baseUrl: `http://127.0.0.1:${evil.address().port}/v1` });
    assert.deepEqual(r, { text: "ok" });
    assert.equal(hits.length, 0);
  } finally {
    evil.close();
    good.close();
  }
});

test("baseurl:set: a new address needs the person's OK in a modal; cancel changes nothing", async () => {
  let b = await boot({ warningAnswer: undefined });
  let r = await b.wv.send("baseurl:set", { provider: "qwen", url: "https://dashscope.aliyuncs.com/compatible-mode/v1" });
  assert.deepEqual(r, { ok: false, cancelled: true });
  assert.equal(b.context.globalState.data.hostBaseUrls, undefined);
  assert.equal(b.calls.warning.length, 1);
  assert.equal(b.calls.warning[0][1].modal, true);

  b = await boot({ warningAnswer: (msg, o, yes) => yes });
  await b.context.secrets.store("sessionlens.apiKey.qwen", "sk-x");
  r = await b.wv.send("baseurl:set", { provider: "qwen", url: "https://dashscope.aliyuncs.com/compatible-mode/v1" });
  assert.deepEqual(r, { ok: true, url: "https://dashscope.aliyuncs.com/compatible-mode/v1" });
  assert.match(b.calls.warning[0][1].detail, /API key/, "the dialog says the saved key goes there too");
  assert.equal(b.context.globalState.data.hostBaseUrls.qwen, "https://dashscope.aliyuncs.com/compatible-mode/v1");
  // the same address again: no second question
  await b.wv.send("baseurl:set", { provider: "qwen", url: "https://dashscope.aliyuncs.com/compatible-mode/v1/" });
  assert.equal(b.calls.warning.length, 1);
  // back to the default: no question
  r = await b.wv.send("baseurl:set", { provider: "qwen", url: "" });
  assert.equal(r.ok, true);
  assert.equal(b.calls.warning.length, 1);
  assert.equal(b.context.globalState.data.hostBaseUrls.qwen, "");
});

test("storage:get shows the host's addresses; migration moves the panel's into the host", async () => {
  const { context, wv } = await boot({
    globalState: {
      settings: {
        provider: "local",
        baseUrl: "http://10.0.0.5:11434/v1",
        baseUrls: { qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1", openai: "https://api.openai.com/v1" },
      },
    },
  });
  assert.deepEqual(context.globalState.data.hostBaseUrls, { qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1", local: "http://10.0.0.5:11434/v1" });
  assert.deepEqual(context.globalState.data.settings.baseUrls, { openai: "https://api.openai.com/v1" });
  const got = await wv.send("storage:get", { keys: ["settings"] });
  assert.equal(got.settings.baseUrls.qwen, "https://dashscope.aliyuncs.com/compatible-mode/v1");
  assert.equal(got.settings.baseUrls.local, "http://10.0.0.5:11434/v1");
});
