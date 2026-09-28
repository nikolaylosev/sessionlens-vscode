"use strict";
/* secrets.js: the SecretStorage wrapper and the move of keys out of settings (phase 2). */
const test = require("node:test");
const assert = require("node:assert/strict");
const { M, root } = require("./helpers");
const path = require("path");
const { fakeSecretStorage } = require("./fake-vscode");

const LensAI = require(M("ai.js"));
const S = require(path.join(root, "secrets.js"));
const P = LensAI.PROVIDERS;

const make = (opts) => {
  const storage = fakeSecretStorage(opts);
  return { storage, secrets: S.createSecrets(storage, P) };
};
const val = (storage, prov) => storage.map.get(S.PREFIX + prov);

test("providers that take a key: every HTTP provider but local, no CLI", () => {
  assert.deepEqual(S.keyProviders(P).sort(), ["anthropic", "deepseek", "google", "openai", "qwen", "xai"]);
});

test("only apiKey, provider google → key under google, apiKey gone", async () => {
  const { storage, secrets } = make();
  const r = await S.extractSecrets({ provider: "google", apiKey: "AIza-1", model: "m" }, secrets, P);
  assert.equal(r.changed, true);
  assert.equal(val(storage, "google"), "AIza-1");
  assert.deepEqual(r.settings, { provider: "google", model: "m" });
});

test("only apiKey, empty provider → Anthropic, as callModel() does", async () => {
  const { storage, secrets } = make();
  await S.extractSecrets({ provider: "", apiKey: "sk-ant-1" }, secrets, P);
  assert.equal(val(storage, "anthropic"), "sk-ant-1");
});

test("keys for several providers → all moved", async () => {
  const { storage, secrets } = make();
  const r = await S.extractSecrets({ keys: { anthropic: "a", openai: "o", qwen: "q" }, modelPool: [] }, secrets, P);
  assert.equal(val(storage, "anthropic"), "a");
  assert.equal(val(storage, "openai"), "o");
  assert.equal(val(storage, "qwen"), "q");
  assert.equal(r.moved, 3);
  assert.deepEqual(r.settings, { modelPool: [] });
});

test("apiKey and keys[provider] disagree → keys[provider] wins (apiKey is a copy that can go stale)", async () => {
  const { storage, secrets } = make();
  await S.extractSecrets({ provider: "anthropic", apiKey: "old", keys: { anthropic: "new" } }, secrets, P);
  assert.equal(val(storage, "anthropic"), "new");
});

test("keys of a keyless or unknown provider are dropped; only their count is logged", async () => {
  const { storage, secrets } = make();
  const logs = [];
  const r = await S.extractSecrets({ keys: { local: "L-secret", gone: "G-secret", google: "g" } }, secrets, P, (m) => logs.push(m));
  assert.equal(r.dropped, 2);
  assert.equal(val(storage, "google"), "g");
  assert.equal(storage.map.size, 1);
  assert.equal(logs.length, 1);
  assert.ok(!/L-secret|G-secret/.test(logs[0]));
});

test("store fails (no keyring) → settings untouched, error returned", async () => {
  const { secrets } = make({ failStore: true });
  const input = { provider: "anthropic", apiKey: "sk", keys: { anthropic: "sk" } };
  const r = await S.extractSecrets(input, secrets, P);
  assert.ok(r.error);
  assert.equal(r.changed, false);
  assert.equal(r.settings, input);
});

test("second run is a no-op", async () => {
  const { storage, secrets } = make();
  const first = await S.extractSecrets({ keys: { openai: "o" } }, secrets, P);
  let stores = 0;
  const orig = storage.store;
  storage.store = async (...a) => {
    stores++;
    return orig(...a);
  };
  const second = await S.extractSecrets(first.settings, secrets, P);
  assert.equal(second.changed, false);
  assert.equal(stores, 0);
});

test("empty key fields are stripped too, without touching SecretStorage", async () => {
  const { storage, secrets } = make();
  const r = await S.extractSecrets({ apiKey: "", keys: {}, verify: true }, secrets, P);
  assert.equal(r.changed, true);
  assert.deepEqual(r.settings, { verify: true });
  assert.equal(storage.map.size, 0);
});

test("status() has only booleans, for every provider that takes a key", async () => {
  const { secrets } = make();
  await secrets.set("anthropic", "sk-ant-x");
  const st = await secrets.status();
  assert.deepEqual(Object.keys(st).sort(), S.keyProviders(P).sort());
  for (const v of Object.values(st)) assert.equal(typeof v, "boolean");
  assert.equal(st.anthropic, true);
  assert.equal(st.google, false);
});

test("set with an empty key deletes it; set/get for local, a CLI or an unknown provider throws", async () => {
  const { storage, secrets } = make();
  await secrets.set("openai", "o");
  await secrets.set("openai", "   ");
  assert.equal(storage.map.size, 0);
  for (const p of ["local", "claudecli", "codexcli", "nope"]) {
    await assert.rejects(() => secrets.set(p, "k"));
    await assert.rejects(() => secrets.get(p));
  }
});

test("resolveKey / keyStatus: SecretStorage first, a key the migration could not move yet still counts", async () => {
  const { secrets } = make();
  await secrets.set("google", "from-secrets");
  const legacy = { provider: "anthropic", apiKey: "legacy-a", keys: { google: "legacy-g" } };
  assert.equal(await S.resolveKey(secrets, "google", legacy, P), "from-secrets");
  assert.equal(await S.resolveKey(secrets, "anthropic", legacy, P), "legacy-a");
  assert.equal(await S.resolveKey(secrets, "openai", legacy, P), "");
  const st = await S.keyStatus(secrets, legacy, P);
  assert.equal(st.google, true);
  assert.equal(st.anthropic, true);
  assert.equal(st.openai, false);
});
