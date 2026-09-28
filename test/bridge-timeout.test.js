"use strict";
/* Phase 7 (7B.7): vscode-bridge.js gives up on a reply after a limit that depends on the message, and then resolves
   with { error, code: "bridge-timeout" } (never rejects). Dialogs and local model servers have no limit. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { root } = require("./helpers");
const { CLOUD_TIMEOUT_MS } = require("../providers.js");

function loadBridge() {
  const dom = new JSDOM("<body></body>", { runScripts: "outside-only", url: "https://panel.invalid/" });
  const w = dom.window,
    posted = [],
    timers = [];
  w.acquireVsCodeApi = () => ({ postMessage: (m) => posted.push(m), setState() {}, getState() {} });
  w.setTimeout = (fn, ms) => {
    const t = { fn, ms, cleared: false };
    timers.push(t);
    return t;
  };
  w.clearTimeout = (t) => {
    if (t) t.cleared = true;
  };
  w.LensAI = { PROVIDERS: { ollama: { local: true }, openai: {} } };
  w.eval(fs.readFileSync(path.join(root, "media", "vscode-bridge.js"), "utf8"));
  const fire = () => {
    for (const t of timers.splice(0)) if (!t.cleared) t.fn();
  };
  const reply = (id, result) => w.dispatchEvent(new w.MessageEvent("message", { data: { __slReply: true, id, result } }));
  return { w, posted, timers, fire, reply };
}

test("the limit per message type", () => {
  const { w } = loadBridge(),
    f = w.__slBridgeTimeoutFor;
  for (const t of ["open:transcript", "save:file", "save:folder-files", "baseurl:set"]) assert.equal(f(t, {}), 0, t);
  assert.equal(f("ai:call", { provider: "ollama" }), 0);
  assert.equal(f("ai:call", { provider: "openai" }), CLOUD_TIMEOUT_MS + 10000);
  assert.equal(f("claude:run", { timeoutMs: 120000 }), 130000);
  assert.equal(f("codex:run", {}), 300000 + 10000);
  assert.equal(f("claude:check", {}), 90000);
  for (const t of ["storage:get", "session:get", "session:put", "secret:status", "session:open"]) assert.equal(f(t, {}), 300000, t);
  assert.equal(f("storage:set", {}), 60000);
  assert.equal(f("tab:active", {}), 60000);
});

test("the constants match the host's own limits", () => {
  const src = fs.readFileSync(path.join(root, "media", "vscode-bridge.js"), "utf8");
  assert.match(src, /const CLOUD_TIMEOUT_MS = 10 \* 60 \* 1000;/);
  assert.equal(CLOUD_TIMEOUT_MS, 10 * 60 * 1000);
  assert.match(fs.readFileSync(path.join(root, "cli.js"), "utf8"), /const DEFAULT_TIMEOUT = 300000;/);
  assert.match(src, /const CLI_DEFAULT_MS = 300000;/);
});

test("no reply: the promise resolves with bridge-timeout, and a late reply changes nothing", async () => {
  const b = loadBridge();
  const p = b.w.__slSessionList();
  assert.equal(b.timers.length, 1);
  assert.equal(b.timers[0].ms, 300000);
  b.fire();
  const r = await p;
  assert.equal(r.code, "bridge-timeout");
  assert.match(r.error, /no reply from VS Code \(session:list, 300 s\)/);
  b.reply(b.posted[0].id, { items: [] }); // too late: ignored, no error
  assert.equal(b.posted[0].payload.lang, undefined, "lang is not sent any more");
});

test("a reply in time clears the timer; a dialog gets no timer at all", async () => {
  const b = loadBridge();
  const p = b.w.__slSetActiveTab("rules");
  b.reply(b.posted[0].id, { ok: true });
  assert.deepEqual(await p, { ok: true });
  assert.equal(b.timers[0].cleared, true);
  const n = b.timers.length;
  b.w.__slPickTranscript({});
  assert.equal(b.timers.length, n, "open:transcript waits for the person");
});
