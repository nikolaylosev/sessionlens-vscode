"use strict";
/* extension.js under a fake "vscode": the migration at activate(), the storage/secret/ai:call messages and the CSP.
   The point of phase 2 is checked where a key could actually leak: globalState, whatever the host posts back to a
   webview (storage:get, secret:status, ai:call replies), and error texts. Report/verdict exports and rules.json
   are built from sessions and rule overrides only and never touch settings. */
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { fakeVscode, loadExtension, fakeContext, fakeWebviewView } = require("./fake-vscode");

const KEY_A = "sk-ant-LEAKCHECK-aaaa",
  KEY_G = "AIza-LEAKCHECK-gggg",
  KEY_Q = "sk-LEAKCHECK-qqqq";
const OLD_SETTINGS = {
  profile: "qa-ts",
  provider: "anthropic",
  apiKey: KEY_A,
  model: "m",
  keys: { anthropic: KEY_A, google: KEY_G, qwen: KEY_Q },
  modelPool: [{ id: "m1", provider: "anthropic", model: "m" }],
  defaultModelId: "m1",
  baseUrls: {},
};

async function boot(opts = {}) {
  const { vscode, registered, calls, config } = fakeVscode(opts);
  const ext = loadExtension(vscode);
  const context = fakeContext({
    globalState: Object.assign({ settings: opts.settings === undefined ? OLD_SETTINGS : opts.settings, sessions: {} }, opts.globalState),
    failStore: opts.failStore,
  });
  ext.activate(context);
  const wv = fakeWebviewView();
  registered.views.sessionlensView.resolveWebviewView(wv.view);
  return { ext, context, wv, registered, calls, config };
}
const leaks = (x) => /LEAKCHECK/.test(JSON.stringify(x));

test("activate: keys move to SecretStorage, globalState keeps no key and no key fields", async () => {
  const { context, wv } = await boot();
  await wv.send("storage:get", { keys: ["settings"] }); // waits for the migration like any storage message
  const st = context.globalState.data.settings;
  assert.ok(!("apiKey" in st) && !("keys" in st));
  assert.equal(leaks(context.globalState.data), false);
  assert.equal(context.secrets.map.get("sessionlens.apiKey.anthropic"), KEY_A);
  assert.equal(context.secrets.map.get("sessionlens.apiKey.google"), KEY_G);
  assert.deepEqual(st.modelPool, OLD_SETTINGS.modelPool); // everything else untouched
});

test("activate twice (restart): no-op, SecretStorage unchanged", async () => {
  const first = await boot();
  await first.wv.send("secret:status", {});
  const { vscode, registered } = fakeVscode();
  const ext = loadExtension(vscode);
  const ctx2 = Object.assign({}, first.context, { subscriptions: [] });
  let stores = 0;
  const orig = ctx2.secrets.store;
  ctx2.secrets.store = async (...a) => {
    stores++;
    return orig(...a);
  };
  ext.activate(ctx2);
  const wv = fakeWebviewView();
  registered.views.sessionlensView.resolveWebviewView(wv.view);
  await wv.send("secret:status", {});
  assert.equal(stores, 0);
});

test("keychain failure: keys stay in globalState and still count as saved", async () => {
  const { context, wv } = await boot({ failStore: true });
  const st = await wv.send("secret:status", {});
  assert.equal(st.anthropic, true);
  assert.equal(st.google, true);
  assert.equal(context.globalState.data.settings.keys.google, KEY_G);
  // … but never reach the webview
  const got = await wv.send("storage:get", { keys: ["settings"] });
  assert.equal(leaks(got), false);
});

test("storage:get strips key fields; storage:set with keys moves them before writing", async () => {
  const { context, wv } = await boot({ settings: { provider: "openai" } });
  await wv.send("storage:set", { values: { settings: { provider: "openai", apiKey: "sk-LEAKCHECK-new", keys: {} }, rulesApplied: { a: "x" } } });
  assert.equal(leaks(context.globalState.data), false);
  assert.ok(!("apiKey" in context.globalState.data.settings));
  assert.equal(context.globalState.data.rulesApplied.a, "x");
  assert.equal(context.secrets.map.get("sessionlens.apiKey.openai"), "sk-LEAKCHECK-new");
  // something that slipped into globalState anyway is still not handed to a webview
  context.globalState.data.settings.keys = { google: KEY_G };
  const got = await wv.send("storage:get", { keys: ["settings", "rulesApplied"] });
  assert.equal(leaks(got), false);
  assert.ok(!("keys" in got.settings));
});

test("secret:set / secret:status / secret:delete: booleans only, other views told to refresh", async () => {
  const { registered, context } = await boot({ settings: {} });
  const a = fakeWebviewView(),
    b = fakeWebviewView();
  registered.views.sessionlensView.resolveWebviewView(a.view);
  registered.views.sessionlensView.resolveWebviewView(b.view);
  let st = await a.send("secret:set", { provider: "xai", key: "xai-LEAKCHECK-1" });
  assert.equal(st.xai, true);
  for (const v of Object.values(st)) assert.equal(typeof v, "boolean");
  assert.ok(
    b.posted.some((m) => m.__slRefresh),
    "the other view refreshes",
  );
  assert.ok(!a.posted.some((m) => m.__slRefresh), "the sender does not (its own reply carries the status)");
  st = await b.send("secret:status", {});
  assert.equal(st.xai, true);
  st = await b.send("secret:delete", { provider: "xai" });
  assert.equal(st.xai, false);
  assert.equal(context.secrets.map.size, 0);
  const bad = await a.send("secret:set", { provider: "claudecli", key: "x" });
  assert.ok(bad && typeof bad.error === "string");
  assert.equal(leaks(a.posted) || leaks(b.posted), false);
});

test("secret:delete also removes a key the migration could not move yet", async () => {
  const { context, wv } = await boot({ failStore: true });
  const st = await wv.send("secret:delete", { provider: "anthropic" });
  assert.equal(st.anthropic, false);
  assert.ok(!("apiKey" in context.globalState.data.settings));
  assert.ok(!("anthropic" in context.globalState.data.settings.keys));
});

function server(handler) {
  return new Promise((r) => {
    const s = http.createServer(handler);
    s.listen(0, "127.0.0.1", () => r(s));
  });
}

test("ai:call: the host adds the key; errors that echo it are redacted; replies never carry it", async () => {
  const s = await server((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url.startsWith("/bad")) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "invalid key " + req.headers.authorization } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "auth=" + (req.headers.authorization ? "yes" : "no") } }] }));
    });
  });
  try {
    const port = s.address().port;
    // phase 3: the address is the host's (confirmed in a dialog), never the payload's
    const { wv } = await boot({ globalState: { hostBaseUrls: { qwen: `http://127.0.0.1:${port}/ok`, local: `http://127.0.0.1:${port}/ok` } } });
    let r = await wv.send("ai:call", { provider: "qwen", model: "q", system: "s", user: "u", baseUrl: "http://attacker.invalid/steal" });
    assert.deepEqual(r, { text: "auth=yes" });
    const bad = await boot({ globalState: { hostBaseUrls: { qwen: `http://127.0.0.1:${port}/bad` } } });
    r = await bad.wv.send("ai:call", { provider: "qwen", model: "q", system: "s", user: "u" });
    assert.match(r.error.message, /^HTTP 401: invalid key Bearer \*\*\*$/);
    assert.equal(leaks(bad.wv.posted), false);
    r = await wv.send("ai:call", { provider: "local", model: "l", system: "s", user: "u" });
    assert.deepEqual(r, { text: "auth=no" });
    assert.equal(leaks(wv.posted), false);
  } finally {
    s.close();
  }
});

test("ai:call: closing the view aborts its request; the late reply goes nowhere and throws nothing", async () => {
  const s = await server(() => {
    /* never answers */
  });
  try {
    const { wv } = await boot({ globalState: { hostBaseUrls: { local: `http://127.0.0.1:${s.address().port}/v1` } } });
    const run = wv.started("ai:call", { provider: "local", model: "l", system: "s", user: "u" });
    await new Promise((r) => setTimeout(r, 50));
    wv.webview.postMessage = () => {
      throw new Error("Webview is disposed");
    };
    wv.dispose();
    // resolves promptly: aborted, reply swallowed (a local request has no host time limit, so without the abort it would hang)
    const outcome = await Promise.race([run.done.then(() => "done"), new Promise((r) => setTimeout(() => r("hung"), 2000))]);
    assert.equal(outcome, "done");
  } finally {
    s.closeAllConnections && s.closeAllConnections();
    s.close();
  }
});

test("CSP: connect-src is the extension's own resources only", async () => {
  const { wv } = await boot();
  const m = /Content-Security-Policy" content="([^"]+)"/.exec(wv.webview.html);
  assert.ok(m, "CSP meta present");
  const csp = m[1];
  assert.match(csp, /connect-src vscode-resource:(;|$)/);
  assert.ok(!/\bhttps?:(\s|;|$)/.test(csp), csp);
});
