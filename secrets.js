// @ts-check
"use strict";
/* API keys live in VS Code's SecretStorage (the OS keychain), never in globalState and never in the webview.
   Nothing here requires "vscode": the SecretStorage and the provider table are passed in, so this file runs
   under plain `node --test`.

   Until 0.1.98 the webview kept keys in globalState.settings:
     keys[provider] — the key of each provider;
     apiKey         — a copy of keys[settings.provider] (set by setDefaultModel() in app.js), which could go stale.
   extractSecrets() moves both into SecretStorage and strips them from settings. It runs once at activate() and
   again on every storage:set, so a settings object that still carries a key (old data, the Chrome code path)
   never lands in globalState. */

const PREFIX = "sessionlens.apiKey.";

// providers that take a key: every HTTP provider except the keyless local server; not the CLIs
function keyProviders(PROVIDERS) {
  return Object.keys(PROVIDERS).filter((name) => {
    const p = PROVIDERS[name] || {};
    return !p.local && !p.noKey;
  });
}

function createSecrets(storage, PROVIDERS) {
  const names = keyProviders(PROVIDERS);
  const check = (provider) => {
    if (!names.includes(provider)) throw new Error(`SessionLens: no API key is stored for provider "${provider}"`);
  };
  const api = {
    providers: () => names.slice(),
    async get(provider) {
      check(provider);
      return (await storage.get(PREFIX + provider)) || "";
    },
    async has(provider) {
      return !!(await api.get(provider));
    },
    async set(provider, key) {
      check(provider);
      const v = String(key == null ? "" : key).trim();
      if (!v) return api.delete(provider);
      await storage.store(PREFIX + provider, v);
    },
    async delete(provider) {
      check(provider);
      await storage.delete(PREFIX + provider);
    },
    // { provider: boolean } for every provider that takes a key — never the keys themselves
    async status() {
      const out = {};
      for (const n of names) out[n] = !!(await storage.get(PREFIX + n));
      return out;
    },
  };
  return api;
}

const hasSecretFields = (settings) =>
  !!settings &&
  typeof settings === "object" &&
  (Object.prototype.hasOwnProperty.call(settings, "apiKey") || Object.prototype.hasOwnProperty.call(settings, "keys"));

// A copy of settings without the two key fields.
function stripSecrets(settings) {
  if (!settings || typeof settings !== "object") return settings;
  const out = Object.assign({}, settings);
  delete out.apiKey;
  delete out.keys;
  return out;
}

/* Collects the keys a settings object carries, provider → key.
   keys[provider] wins over apiKey: apiKey is only a copy of keys[settings.provider], and a stale one at that when a
   second model of the same provider was added with a new key. apiKey counts only when keys has nothing for its
   provider; an empty or unknown settings.provider means Anthropic, as in callModel(). */
function collectKeys(settings, PROVIDERS) {
  const found = {};
  const keys = settings && settings.keys && typeof settings.keys === "object" ? settings.keys : {};
  for (const [prov, v] of Object.entries(keys)) if (typeof v === "string" && v.trim()) found[prov] = v.trim();
  const apiKey = settings && typeof settings.apiKey === "string" ? settings.apiKey.trim() : "";
  if (apiKey) {
    const prov = PROVIDERS[settings.provider] ? settings.provider : "anthropic";
    if (!found[prov]) found[prov] = apiKey;
  }
  return found;
}

/* Moves every key a settings object carries into SecretStorage.
   → { settings, changed, moved, dropped, error }
   - changed: false when settings has neither apiKey nor keys, which makes a second run a no-op;
   - keys of a provider that takes no key (local, the CLIs) or of an unknown provider are dropped; only their
     count is logged, never a value;
   - if any store fails (e.g. Linux with no keyring), the original settings come back untouched with `error`,
     so a key is never lost: it stays where it was until the next attempt. */
async function extractSecrets(settings, secrets, PROVIDERS, log) {
  if (!hasSecretFields(settings)) return { settings, changed: false, moved: 0, dropped: 0 };
  const found = collectKeys(settings, PROVIDERS);
  const allowed = new Set(secrets.providers());
  let moved = 0,
    dropped = 0;
  try {
    for (const [prov, key] of Object.entries(found)) {
      if (!allowed.has(prov)) {
        dropped++;
        continue;
      }
      await secrets.set(prov, key);
      moved++;
    }
  } catch (e) {
    return { settings, changed: false, moved: 0, dropped: 0, error: e };
  }
  if (dropped && log) log(`SessionLens: dropped ${dropped} API key(s) of providers that take no key or no longer exist`);
  return { settings: stripSecrets(settings), changed: true, moved, dropped };
}

/* Key lookup for an actual request. SecretStorage first; the legacy globalState copy only covers the case where
   the migration could not store it yet (no keyring) — otherwise the key would be unusable until it succeeds. */
async function resolveKey(secrets, provider, legacySettings, PROVIDERS) {
  const k = await secrets.get(provider);
  if (k) return k;
  return collectKeys(legacySettings || {}, PROVIDERS)[provider] || "";
}

async function keyStatus(secrets, legacySettings, PROVIDERS) {
  const st = await secrets.status();
  const legacy = collectKeys(legacySettings || {}, PROVIDERS);
  for (const n of Object.keys(st)) if (!st[n] && legacy[n]) st[n] = true;
  return st;
}

module.exports = { createSecrets, extractSecrets, stripSecrets, hasSecretFields, collectKeys, resolveKey, keyStatus, keyProviders, PREFIX };
