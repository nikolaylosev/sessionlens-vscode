"use strict";
/* ai.js in the VS Code build: callModel() sends HTTP requests through the host (setTransport) and asks it whether
   a key exists (setKeyStatus); without them it behaves as before (Chrome build, tests). */
const test = require("node:test");
const assert = require("node:assert/strict");
const { M } = require("./helpers");

const I18N = require(M("i18n.js"));
I18N.set("en");
const LensAI = require(M("ai.js"));

const base = { provider: "anthropic", model: "claude-x", minGapMs: 0, maxRetries: 2 };
function reset() {
  LensAI.setTransport(null);
  LensAI.setKeyStatus(null);
}

test("with a transport: payload carries no key, the reply text comes back", async () => {
  reset();
  const seen = [];
  LensAI.setTransport(async (p) => {
    seen.push(p);
    return { text: "hello" };
  });
  const out = await LensAI.callModel(Object.assign({ apiKey: "should-not-travel" }, base), { system: "s", user: "u", maxTokens: 10 });
  assert.equal(out, "hello");
  assert.equal(seen.length, 1);
  assert.ok(!("apiKey" in seen[0]));
  assert.ok(!JSON.stringify(seen[0]).includes("should-not-travel"));
  assert.deepEqual(Object.keys(seen[0]).sort(), ["baseUrl", "maxTokens", "model", "provider", "schema", "system", "user"]);
  assert.equal(seen[0].provider, "anthropic");
  reset();
});

test("with a transport: an HTTP 429 from the host is retried like a direct 429", async () => {
  reset();
  let n = 0;
  LensAI.setTransport(async () => (++n === 1 ? { error: { message: "HTTP 429: retry-after 0.001s" } } : { text: "ok" }));
  const out = await LensAI.callModel(base, { system: "s", user: "u" });
  assert.equal(out, "ok");
  assert.equal(n, 2);
  reset();
});

test("with a transport: no_key from the host becomes the usual 'No API key' text", async () => {
  reset();
  LensAI.setTransport(async () => ({ error: { code: "no_key", message: "x" } }));
  await assert.rejects(
    () => LensAI.callModel(Object.assign({}, base, { provider: "google" }), { system: "s", user: "u" }),
    (e) => /No API key for Google/.test(e.message) && e.code === "no_key",
  );
  reset();
});

test("CLI providers never use the HTTP transport", async () => {
  reset();
  let used = false;
  LensAI.setTransport(async () => {
    used = true;
    return { text: "x" };
  });
  const host = async () => ({ text: "from-cli" });
  // the CLI path takes its host function as the injected second argument
  const out = await LensAI.callModel(Object.assign({}, base, { provider: "claudecli" }), { system: "s", user: "u" }, host);
  assert.equal(out, "from-cli");
  assert.equal(used, false);
  reset();
});

test("an injected fetchImpl wins over the transport (tests, and the direct path stays as it was)", async () => {
  reset();
  LensAI.setTransport(async () => {
    throw new Error("transport must not be used");
  });
  const calls = [];
  const f = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "direct" }] }) };
  };
  const out = await LensAI.callModel(Object.assign({ apiKey: "k" }, base), { system: "s", user: "u" }, f);
  assert.equal(out, "direct");
  assert.equal(calls[0].opts.headers["x-api-key"], "k");
  reset();
});

test("missingKey: the host's status when there is one, settings.apiKey otherwise (unchanged)", () => {
  reset();
  const s = { provider: "google", model: "g" };
  assert.equal(LensAI.missingKey(s, "review"), "Google (Gemini)");
  assert.equal(LensAI.missingKey(Object.assign({ apiKey: "k" }, s), "review"), "");
  LensAI.setKeyStatus({ google: true, anthropic: false });
  assert.equal(LensAI.missingKey(s, "review"), "");
  assert.equal(LensAI.missingKey({ provider: "anthropic" }, "review"), "Anthropic (Claude)");
  assert.equal(LensAI.missingKey({ provider: "local" }, "review"), "");
  assert.equal(LensAI.missingKey({ provider: "claudecli" }, "review"), "");
  // a route to another provider is checked against that provider
  assert.equal(LensAI.missingKey({ provider: "google", routes: { review: { provider: "anthropic", model: "x" } } }, "review"), "Anthropic (Claude)");
  reset();
});

test("hasKey: host status, else settings.keys / apiKey of the active provider", () => {
  reset();
  assert.equal(LensAI.hasKey({ keys: { openai: "k" } }, "openai"), true);
  assert.equal(LensAI.hasKey({ provider: "xai", apiKey: "k" }, "xai"), true);
  assert.equal(LensAI.hasKey({ provider: "xai", apiKey: "k" }, "openai"), false);
  LensAI.setKeyStatus({ openai: false, xai: true });
  assert.equal(LensAI.hasKey({ keys: { openai: "k" } }, "openai"), false);
  assert.equal(LensAI.hasKey({}, "xai"), true);
  assert.deepEqual(LensAI.getKeyStatus(), { openai: false, xai: true });
  reset();
  assert.equal(LensAI.getKeyStatus(), null);
});

test("direct call in Node (no window): no browser-access header", async () => {
  let headers;
  await LensAI.callAnthropic({ apiKey: "k", model: "m", system: "s", user: "u" }, async (url, opts) => {
    headers = opts.headers;
    return { ok: true, status: 200, json: async () => ({ content: [] }) };
  });
  assert.equal(headers["anthropic-dangerous-direct-browser-access"], undefined);
  assert.equal(headers["x-api-key"], "k");
});
