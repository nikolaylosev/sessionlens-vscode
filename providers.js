// @ts-check
"use strict";
/* HTTP calls to the AI providers, made by the extension host instead of the webview (phase 2).

   Only the transport lives here. Prompts, per-task routing, the request queue, the pause between calls, the 429
   retries, parsing and verify stay in media/ai.js in the webview; the webview sends one `ai:call` per request and
   this module performs exactly that one call. The request itself is still built by the same functions the webview
   used (LensAI.PROVIDERS[p].call → callAnthropic / callGoogle / callOpenAICompatible), handed a fetch-compatible
   function and the key from SecretStorage — so there is one copy of every provider's request shape.

   Why not the global fetch: Node's built-in fetch (undici) gives up waiting for response headers after 300 s by
   default, and Ollama with stream:false sends its headers only when generation ends — a big local model on a CPU
   box easily needs longer. The webview's fetch had no such limit. node:http / node:https have none either, and
   VS Code has long routed them through its proxy settings. Nothing here requires "vscode". */

const http = require("http");
const https = require("https");

const CLOUD_TIMEOUT_MS = 10 * 60 * 1000; // one request to a cloud API; local servers get no limit
const MAX_REDIRECTS = 5;
const AUTH_HEADERS = ["authorization", "x-api-key", "x-goog-api-key"];

function networkError(code, message) {
  return Object.assign(new Error("Failed to fetch" + (code ? ` (${code})` : message ? ` (${message})` : "")), { network: true, code: code || "" });
}
function abortError(reason) {
  return Object.assign(new Error("aborted"), { name: "AbortError", reason });
}

/* The subset of fetch() the provider functions use: method, headers, body, signal → { ok, status, json(), text() }.
   Redirects are followed like fetch does; a cross-origin redirect drops the key headers, as fetch does. */
function nodeFetch(url, opts = {}, deps = {}) {
  const mods = { http: deps.http || http, https: deps.https || https };
  let redirects = 0;
  const once = (target, method, headers, body) =>
    new Promise((resolve, reject) => {
      let u;
      try {
        u = new URL(target);
      } catch (e) {
        reject(networkError("", "invalid URL"));
        return;
      }
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        reject(networkError("", "unsupported protocol " + u.protocol));
        return;
      }
      const signal = opts.signal;
      if (signal && signal.aborted) {
        reject(abortError(signal.reason));
        return;
      }
      const h = Object.assign({}, headers);
      if (body != null) h["content-length"] = Buffer.byteLength(body);
      const req = (u.protocol === "https:" ? mods.https : mods.http).request(u, { method, headers: h }, (res) => {
        const status = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          res.resume();
          if (++redirects > MAX_REDIRECTS) {
            reject(networkError("", "too many redirects"));
            return;
          }
          const next = new URL(res.headers.location, u);
          const nh = Object.assign({}, headers);
          if (next.origin !== u.origin) for (const k of Object.keys(nh)) if (AUTH_HEADERS.includes(k.toLowerCase())) delete nh[k];
          const keep = status === 307 || status === 308;
          if (!keep) for (const k of Object.keys(nh)) if (k.toLowerCase() === "content-type") delete nh[k];
          cleanup();
          once(next.toString(), keep ? method : "GET", nh, keep ? body : null).then(resolve, reject);
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("error", (e) => {
          cleanup();
          reject(networkError(e.code, e.message));
        });
        res.on("end", () => {
          cleanup();
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            ok: status >= 200 && status < 300,
            status,
            headers: {
              get: (n) => {
                const v = res.headers[String(n).toLowerCase()];
                return Array.isArray(v) ? v.join(", ") : v == null ? null : String(v);
              },
            },
            text: async () => text,
            json: async () => JSON.parse(text),
          });
        });
      });
      const onAbort = () => {
        req.destroy();
        reject(abortError(signal.reason));
      };
      const cleanup = () => {
        if (signal) signal.removeEventListener("abort", onAbort);
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      req.on("error", (e) => {
        cleanup();
        if (signal && signal.aborted) reject(abortError(signal.reason));
        else reject(networkError(e.code, e.message));
      });
      if (body != null) req.write(body);
      req.end();
    });
  return once(url, String(opts.method || "GET").toUpperCase(), opts.headers || {}, opts.body == null ? null : String(opts.body));
}

function validUrl(s) {
  if (typeof s !== "string" || !s.trim()) return "";
  try {
    const u = new URL(s.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? s.trim() : "";
  } catch {
    return "";
  }
}

// every occurrence of the key in a message → *** (a last line of defence: no provider should echo it)
function redact(message, key) {
  const s = String(message == null ? "" : message);
  return key && key.length >= 4 ? s.split(key).join("***") : s;
}

/* deps:
   - LensAI      media/ai.js as loaded in Node (PROVIDERS and their call functions);
   - i18n        media/i18n.js, so errors built by the provider functions come out in the panel's language;
   - getKey      async (provider) → key or "" (SecretStorage, see secrets.js resolveKey);
   - getBaseUrl  async (provider) → the confirmed address for local/qwen, or "" for the default;
   - fetchImpl   defaults to nodeFetch; a test injects a fake;
   - remoteName  vscode.env.remoteName: set in an SSH/WSL/container window, where the request leaves from the
                 remote side and "localhost" means that machine;
   - cloudTimeoutMs / localTimeoutMs  0 = no limit.
   → async call(payload, signal) → { text } | { error: { message, code? } } — never throws, never returns a key. */
function createProviderCall(deps) {
  const { LensAI, i18n, getKey } = deps;
  const fetchImpl = deps.fetchImpl || nodeFetch;
  const cloudTimeoutMs = deps.cloudTimeoutMs != null ? deps.cloudTimeoutMs : CLOUD_TIMEOUT_MS;
  const localTimeoutMs = deps.localTimeoutMs != null ? deps.localTimeoutMs : 0;
  const T = (k, v) => (i18n ? i18n.t(k, v) : k);

  return async function call(payload, signal) {
    payload = payload || {};
    const name = payload.provider;
    const p = LensAI.PROVIDERS[name];
    if (!p || p.cli) return { error: { code: "bad_provider", message: `SessionLens: provider "${name}" is not an HTTP provider` } };
    if (i18n && payload.lang) i18n.set(payload.lang);
    const needsKey = !p.local && !p.noKey;
    let key = "";
    if (needsKey) {
      try {
        key = await getKey(name);
      } catch (e) {
        return { error: { code: "secret_error", message: String((e && e.message) || e) } };
      }
      if (!key) return { error: { code: "no_key", message: T("err_no_key_for", { p: p.label || name }) } };
    }
    // The address never comes from the panel (phase 3): a webview could otherwise send the Qwen key, or make the
    // host request any URL. A local server and a provider with an editable address (Qwen: per-region endpoints)
    // use what the person confirmed in a VS Code dialog (getBaseUrl, see extension.js baseurl:set); every other
    // provider uses its fixed endpoint. payload.baseUrl is ignored.
    let stored = "";
    if ((p.local || p.editableBase) && deps.getBaseUrl) {
      try {
        stored = validUrl(await deps.getBaseUrl(name));
      } catch {
        stored = "";
      }
    }
    const baseUrl = stored || p.defaultBaseUrl;
    const args = {
      apiKey: key,
      model: typeof payload.model === "string" && payload.model ? payload.model : p.defaultModel,
      system: String(payload.system == null ? "" : payload.system),
      user: String(payload.user == null ? "" : payload.user),
      maxTokens: Number.isFinite(payload.maxTokens) ? payload.maxTokens : undefined,
      schema: payload.schema && typeof payload.schema === "object" ? payload.schema : undefined,
      baseUrl,
    };

    const ctl = new AbortController();
    const onOuter = () => ctl.abort(signal.reason);
    if (signal) {
      if (signal.aborted) ctl.abort(signal.reason);
      else signal.addEventListener("abort", onOuter, { once: true });
    }
    const limit = p.local ? localTimeoutMs : cloudTimeoutMs;
    let timedOut = false;
    const timer = limit
      ? setTimeout(() => {
          timedOut = true;
          ctl.abort("timeout");
        }, limit)
      : null;
    const f = (url, opts) => fetchImpl(url, Object.assign({}, opts, { signal: ctl.signal }));
    try {
      const text = await p.call(args, f);
      return { text: String(text == null ? "" : text) };
    } catch (e) {
      let message = String((e && e.message) || e);
      let code = e && e.code ? String(e.code) : undefined;
      if (timedOut) {
        message = T("err_timeout", { s: Math.round(limit / 1000) });
        code = "timeout";
      } else if (e && e.name === "AbortError") {
        message = "aborted";
        code = "aborted";
      } else if (e && e.network && p.local && deps.remoteName) message += " " + T("err_local_remote", { where: deps.remoteName, url: baseUrl });
      return { error: Object.assign({ message: redact(message, key) }, code ? { code } : {}) };
    } finally {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onOuter);
    }
  };
}

module.exports = { createProviderCall, nodeFetch, redact, validUrl, CLOUD_TIMEOUT_MS };
