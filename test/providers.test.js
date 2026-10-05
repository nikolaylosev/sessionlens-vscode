"use strict";
/* providers.js: one HTTP call per ai:call, made by the host with the key from SecretStorage (phase 2). */
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const path = require("path");
const { M, root } = require("./helpers");

const I18N = require(M("i18n.js"));
const LensAI = require(M("ai.js"));
const { createProviderCall, nodeFetch } = require(path.join(root, "providers.js"));

const KEYS = { anthropic: "sk-ant-SECRET1", google: "AIza-SECRET2", openai: "sk-SECRET3", xai: "xai-SECRET4", deepseek: "sk-SECRET5", qwen: "sk-SECRET6" };

// fake fetch: records every request, answers with `respond(url, opts)` or a provider-shaped success
function recorder(respond) {
  const calls = [];
  const okFor = (url) =>
    url.includes("anthropic.com")
      ? { content: [{ type: "text", text: "[]" }] }
      : url.includes("generativelanguage")
        ? { candidates: [{ content: { parts: [{ text: "[]" }] }, finishReason: "STOP" }] }
        : { choices: [{ message: { content: "[]" }, finish_reason: "stop" }] };
  const f = async (url, opts) => {
    calls.push({ url, opts, body: opts.body ? JSON.parse(opts.body) : null });
    const r = respond ? respond(url, opts) : { status: 200, json: okFor(url) };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json, text: async () => JSON.stringify(r.json) };
  };
  f.calls = calls;
  return f;
}
const make = (fetchImpl, extra = {}) => createProviderCall(Object.assign({ LensAI, i18n: I18N, getKey: async (p) => KEYS[p] || "", fetchImpl }, extra));
const payload = (provider, more = {}) => Object.assign({ provider, model: "m-1", system: "SYS", user: "USER", maxTokens: 100, lang: "en" }, more);
const headerOf = (opts, name) => {
  const h = opts.headers || {};
  const k = Object.keys(h).find((x) => x.toLowerCase() === name);
  return k ? h[k] : undefined;
};

test("every HTTP provider: URL, key header, body parameters", async () => {
  const cases = {
    anthropic: { url: "https://api.anthropic.com/v1/messages", header: ["x-api-key", KEYS.anthropic] },
    google: { url: "https://generativelanguage.googleapis.com/v1beta/models/m-1:generateContent", header: ["x-goog-api-key", KEYS.google] },
    openai: { url: "https://api.openai.com/v1/chat/completions", header: ["authorization", "Bearer " + KEYS.openai] },
    xai: { url: "https://api.x.ai/v1/chat/completions", header: ["authorization", "Bearer " + KEYS.xai] },
    deepseek: { url: "https://api.deepseek.com/chat/completions", header: ["authorization", "Bearer " + KEYS.deepseek] },
    qwen: { url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions", header: ["authorization", "Bearer " + KEYS.qwen] },
    local: { url: "http://localhost:11434/v1/chat/completions", header: ["authorization", undefined] },
  };
  for (const [prov, c] of Object.entries(cases)) {
    const f = recorder();
    const r = await make(f)(payload(prov, { schema: { type: "ARRAY", items: { type: "OBJECT" } } }));
    assert.deepEqual(r, { text: "[]" }, prov);
    const { url, opts, body } = f.calls[0];
    assert.equal(url, c.url, prov + ": url");
    assert.equal(headerOf(opts, c.header[0]), c.header[1], prov + ": key header");
    assert.equal(headerOf(opts, "anthropic-dangerous-direct-browser-access"), undefined, prov + ": browser-access header");
    if (prov === "openai") {
      assert.ok("max_completion_tokens" in body);
      assert.ok(!("max_tokens" in body));
    }
    if (["openai", "xai", "deepseek"].includes(prov)) assert.ok(!("temperature" in body), prov + ": temperature");
    if (["deepseek", "qwen"].includes(prov)) assert.deepEqual(body.response_format, { type: "json_object" }, prov + ": json_object");
    if (prov === "local") assert.equal(body.response_format.type, "json_schema");
  }
});

test("payload.baseUrl is never used (phase 3): fixed endpoints, and the host's own address for local and qwen", async () => {
  const hostUrls = { local: "http://192.168.1.20:11434/v1", qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1" };
  const withHost = (f) => make(f, { getBaseUrl: async (p) => hostUrls[p] || "" });
  let f = recorder();
  await withHost(f)(payload("openai", { baseUrl: "https://evil.example/v1" }));
  assert.equal(f.calls[0].url, "https://api.openai.com/v1/chat/completions");
  f = recorder();
  await withHost(f)(payload("anthropic", { baseUrl: "https://evil.example" }));
  assert.equal(f.calls[0].url, "https://api.anthropic.com/v1/messages");
  f = recorder();
  await withHost(f)(payload("local", { baseUrl: "https://evil.example/v1" }));
  assert.equal(f.calls[0].url, "http://192.168.1.20:11434/v1/chat/completions");
  f = recorder();
  await withHost(f)(payload("qwen", { baseUrl: "https://evil.example/v1" }));
  assert.equal(f.calls[0].url, "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
  assert.equal(headerOf(f.calls[0].opts, "authorization"), "Bearer " + KEYS.qwen);
  // no stored address (or no getBaseUrl at all) → the default, whatever the payload says
  f = recorder();
  await make(f)(payload("qwen", { baseUrl: "https://evil.example/v1" }));
  assert.equal(f.calls[0].url, "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions");
  f = recorder();
  await make(f, { getBaseUrl: async () => "javascript:alert(1)" })(payload("local"));
  assert.equal(f.calls[0].url, "http://localhost:11434/v1/chat/completions");
});

test("a key in the payload is ignored: the host uses its own", async () => {
  const f = recorder();
  await make(f)(payload("anthropic", { apiKey: "from-webview" }));
  assert.equal(headerOf(f.calls[0].opts, "x-api-key"), KEYS.anthropic);
});

test("no key → {error:{code:'no_key'}} and no request", async () => {
  const f = recorder();
  const r = await make(f, { getKey: async () => "" })(payload("google"));
  assert.equal(r.error.code, "no_key");
  assert.equal(f.calls.length, 0);
});

test("CLI providers and unknown names are refused", async () => {
  for (const p of ["claudecli", "codexcli", "cursorcli", "nope"]) {
    const r = await make(recorder())(payload(p));
    assert.equal(r.error.code, "bad_provider", p);
  }
});

test("HTTP 429: the message is byte for byte what the direct call throws, so the retry loop reads it the same", async () => {
  const google429 = () => ({ status: 429, json: { error: { message: "Quota exceeded. Please retry in 12.5s." } } });
  const anthropic429 = () => ({ status: 429, json: { error: { message: "rate limit" } } });
  for (const [prov, respond, direct] of [
    ["google", google429, LensAI.callGoogle],
    ["anthropic", anthropic429, LensAI.callAnthropic],
    ["openai", anthropic429, LensAI.callOpenAICompatible],
  ]) {
    const hostR = await make(recorder(respond))(payload(prov));
    let msg = null;
    try {
      await direct({ apiKey: "k", model: "m-1", system: "s", user: "u", baseUrl: "https://api.openai.com/v1" }, recorder(respond));
    } catch (e) {
      msg = e.message;
    }
    assert.ok(msg && msg.startsWith("HTTP 429"), prov);
    assert.equal(hostR.error.message, msg, prov);
  }
});

test("the key never appears in an error message, even if a server echoes it", async () => {
  const echo = (url, opts) => ({ status: 401, json: { error: { message: "bad key " + (headerOf(opts, "x-api-key") || headerOf(opts, "authorization")) } } });
  for (const prov of ["anthropic", "openai"]) {
    const r = await make(recorder(echo))(payload(prov));
    assert.ok(!r.error.message.includes(KEYS[prov]), prov);
    assert.ok(r.error.message.includes("***"), prov);
  }
});

test("timeout and outer abort stop the request; a local server has no time limit by default", async () => {
  const hang = (url, opts) =>
    new Promise((resolve, reject) => opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  let r = await make(hang, { cloudTimeoutMs: 30 })(payload("anthropic"));
  assert.equal(r.error.code, "timeout");
  assert.match(r.error.message, /No reply within/);
  const ctl = new AbortController();
  const p = make(hang)(payload("local"), ctl.signal);
  setTimeout(() => ctl.abort("disposed"), 20);
  r = await p;
  assert.equal(r.error.code, "aborted");
  // local: no timer at all, so a slow model is never cut off by the host
  let seen;
  const peek = async (url, opts) => {
    seen = opts.signal;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "x" } }] }) };
  };
  r = await make(peek, { cloudTimeoutMs: 1 })(payload("local"));
  assert.deepEqual(r, { text: "x" });
  assert.equal(seen.aborted, false);
});

test("connection refused from a remote window: the local provider explains where the request left from", async () => {
  const refused = async () => {
    throw Object.assign(new Error("Failed to fetch (ECONNREFUSED)"), { network: true, code: "ECONNREFUSED" });
  };
  let r = await make(refused)(payload("local"));
  assert.equal(r.error.message, "Failed to fetch (ECONNREFUSED)");
  r = await make(refused, { remoteName: "ssh-remote" })(payload("local"));
  assert.match(r.error.message, /^Failed to fetch \(ECONNREFUSED\) This VS Code window is remote \(ssh-remote\)/);
});

// ---- nodeFetch against a real local server ----
function server(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
}
const base = (s) => `http://127.0.0.1:${s.address().port}`;

test("nodeFetch: POST body and headers, ok/status/json", async () => {
  const s = await server((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ method: req.method, auth: req.headers.authorization, body: JSON.parse(b) }));
    });
  });
  try {
    const r = await nodeFetch(base(s) + "/x", {
      method: "POST",
      headers: { authorization: "Bearer k", "content-type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    });
    assert.equal(r.ok, true);
    assert.equal(r.status, 201);
    assert.deepEqual(await r.json(), { method: "POST", auth: "Bearer k", body: { a: 1 } });
  } finally {
    s.close();
  }
});

test("nodeFetch: a cross-origin redirect drops the key headers, a same-origin one keeps them", async () => {
  const b = await server((req, res) => {
    res.writeHead(200);
    res.end(JSON.stringify({ auth: req.headers.authorization || null, key: req.headers["x-api-key"] || null, method: req.method }));
  });
  const a = await server((req, res) => {
    if (req.url === "/cross") {
      res.writeHead(307, { location: base(b) + "/end" });
      res.end();
    } else if (req.url === "/same") {
      res.writeHead(307, { location: "/end" });
      res.end();
    } else {
      req.resume();
      res.writeHead(200);
      res.end(JSON.stringify({ auth: req.headers.authorization || null, key: req.headers["x-api-key"] || null, method: req.method }));
    }
  });
  try {
    const h = { authorization: "Bearer k", "x-api-key": "k2", "content-type": "application/json" };
    let r = await nodeFetch(base(a) + "/cross", { method: "POST", headers: h, body: "{}" });
    assert.deepEqual(await r.json(), { auth: null, key: null, method: "POST" });
    r = await nodeFetch(base(a) + "/same", { method: "POST", headers: h, body: "{}" });
    assert.deepEqual(await r.json(), { auth: "Bearer k", key: "k2", method: "POST" });
  } finally {
    a.close();
    b.close();
  }
});

test("nodeFetch: connection refused → 'Failed to fetch (ECONNREFUSED)'; abort → AbortError", async () => {
  const s = await server(() => {});
  const url = base(s);
  await new Promise((r) => s.close(r));
  await assert.rejects(
    () => nodeFetch(url, {}),
    (e) => e.message === "Failed to fetch (ECONNREFUSED)" && e.network === true,
  );
  const slow = await server(() => {
    /* never answers */
  });
  try {
    const ctl = new AbortController();
    const p = nodeFetch(base(slow), { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 20);
    await assert.rejects(p, (e) => e.name === "AbortError");
  } finally {
    slow.closeAllConnections && slow.closeAllConnections();
    slow.close();
  }
});

test("end to end through nodeFetch: local provider against a fake OpenAI-compatible server", async () => {
  const s = await server((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: '[{"message":"ok"}]' } }] }));
    });
  });
  try {
    const call = createProviderCall({ LensAI, i18n: I18N, getKey: async () => "", getBaseUrl: async () => base(s) + "/v1" });
    const r = await call(payload("local"));
    assert.deepEqual(r, { text: '[{"message":"ok"}]' });
  } finally {
    s.close();
  }
});
