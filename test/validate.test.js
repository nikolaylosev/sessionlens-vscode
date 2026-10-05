"use strict";
/* validate.js (phase 3): every message type, one good and at least one bad payload each, plus the path helpers. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { root } = require("./helpers");
const V = require(path.join(root, "validate.js"));

const ctx = {
  httpProviders: ["anthropic", "google", "openai", "xai", "deepseek", "qwen", "local"],
  keyProviders: ["anthropic", "google", "openai", "xai", "deepseek", "qwen"],
  baseUrlProviders: ["qwen", "local"],
  sessionExists: (id) => id === "s1",
};
const ok = (type, p) => assert.equal(V.validate(type, Object.assign({ lang: "en" }, p), ctx), null, `${type} ${JSON.stringify(p).slice(0, 120)}`);
const no = (type, p) =>
  assert.equal(typeof V.validate(type, Object.assign({ lang: "en" }, p), ctx), "string", `${type} should be refused: ${JSON.stringify(p).slice(0, 120)}`);

test("the storage whitelist is exactly what app.js store.get() reads", () => {
  const app = fs.readFileSync(path.join(root, "media", "app.js"), "utf8");
  const m = /chrome\.storage\.local\.get\((\[[^\]]*\])\)/.exec(app);
  assert.ok(m, "store.get() found");
  assert.deepEqual(JSON.parse(m[1]).sort(), [...V.STORAGE_KEYS].sort());
});

test("the tab list is every view app.js can show", () => {
  const html = fs.readFileSync(path.join(root, "media", "sidepanel.html"), "utf8");
  const views = [...html.matchAll(/data-view="([a-z]+)"/g)].map((x) => x[1]);
  for (const v of [...views, "review"]) assert.ok(V.TABS.includes(v), v);
});

test("unknown types, non-object payloads and a bad lang are refused", () => {
  assert.equal(typeof V.validate("fs:delete", {}, ctx), "string");
  assert.equal(typeof V.validate("storage:get", "keys", ctx), "string");
  assert.equal(typeof V.validate("storage:get", [], ctx), "string");
  no("secret:status", { lang: { x: 1 } });
  no("secret:status", { lang: "x".repeat(20) });
  ok("secret:status", {});
});

test("storage:get / storage:set", () => {
  ok("storage:get", { keys: ["settings", "analysisEpoch"] });
  no("storage:get", { keys: ["sessions"] });
  no("storage:get", { keys: ["settings", "evil"] });
  no("storage:get", { keys: [] });
  no("storage:get", {});
  ok("storage:set", { values: { settings: {}, external: [], calibLog: [], analysisEpoch: 3 } });
  no("storage:set", { values: { sessions: {} } });
  no("storage:set", { values: { analysisEpoch: -1 } });
  no("storage:set", { values: { analysisEpoch: "1" } });
  no("storage:set", { values: { evil: 1 } });
  no("storage:set", { values: { settings: {}, evil: {} } });
  no("storage:set", { values: { settings: "x" } });
  no("storage:set", { values: { external: {} } });
  no("storage:set", { values: {} });
  no("storage:set", { values: [] });
});

test("secret:set / secret:delete", () => {
  ok("secret:set", { provider: "qwen", key: "sk-1" });
  no("secret:set", { provider: "local", key: "x" });
  no("secret:set", { provider: "claudecli", key: "x" });
  no("secret:set", { provider: "qwen", key: "" });
  no("secret:set", { provider: "qwen", key: "a\nb" });
  no("secret:set", { provider: "qwen", key: "k".repeat(1001) });
  ok("secret:delete", { provider: "openai" });
  no("secret:delete", { provider: "__proto__" });
});

test("ai:call", () => {
  ok("ai:call", { provider: "qwen", model: "qwen3.8-max", system: "s", user: "u", maxTokens: 8000, schema: { type: "ARRAY" }, baseUrl: "https://whatever" });
  ok("ai:call", { provider: "local", model: "hf.co/user/model:Q4_K_M" });
  ok("ai:call", { provider: "openai" });
  no("ai:call", { provider: "claudecli" });
  no("ai:call", { provider: "evil" });
  no("ai:call", { provider: "google", model: "../../v1/x" });
  no("ai:call", { provider: "google", model: "a b" });
  no("ai:call", { provider: "openai", system: 5 });
  no("ai:call", { provider: "openai", maxTokens: -1 });
  no("ai:call", { provider: "openai", schema: "x" });
});

test("baseurl:set", () => {
  ok("baseurl:set", { provider: "qwen", url: "https://dashscope.aliyuncs.com/compatible-mode/v1" });
  ok("baseurl:set", { provider: "local", url: "" });
  no("baseurl:set", { provider: "openai", url: "https://x" });
  no("baseurl:set", { provider: "local", url: "javascript:alert(1)" });
  no("baseurl:set", { provider: "local", url: "file:///etc/passwd" });
  no("baseurl:set", { provider: "local" });
});

test("clipboard:write, save:file, open:transcript", () => {
  ok("clipboard:write", { text: "hello" });
  no("clipboard:write", { text: "x".repeat(10 * 1024 * 1024 + 1) });
  no("clipboard:write", {});
  ok("save:file", { name: "report.md", content: "x" });
  no("save:file", { name: "a.md" });
  no("save:file", { name: {}, content: "x" });
  ok("open:transcript", { source: "codex" });
  ok("open:transcript", { source: "cursor" });
  ok("open:transcript", {});
  no("open:transcript", { source: "/etc" });
  no("open:transcript", { source: "Cursor" });
});

test("claude/codex/cursor run and check: model, sizes, timeout; cliPath is simply ignored", () => {
  for (const t of ["claude:run", "codex:run", "cursor:run"]) {
    ok(t, { model: "sonnet", system: "s", user: "u", cliPath: "/tmp/evil", timeoutMs: 300000 });
    no(t, { model: "sonnet; rm -rf ~" });
    no(t, { timeoutMs: 10 ** 9 });
    no(t, { user: 5 });
  }
  ok("claude:check", { cliPath: "/tmp/evil" });
  ok("codex:check", {});
  ok("cursor:check", {});
});

test("session:open, tab:active, settings:open, panel:close", () => {
  ok("session:open", { id: "s1" });
  no("session:open", { id: "nope" });
  no("session:open", {});
  ok("tab:active", { tab: "sessions" });
  ok("tab:active", { tab: "review" });
  no("tab:active", { tab: "evil" });
  ok("settings:open", {});
  ok("panel:close", {});
});

test("save:folder-files: whitelisted segments only; one bad path refuses the whole message", () => {
  const f = (p) => ({ path: p, content: "x" });
  ok("save:folder-files", { skillName: "api-review.v2", files: [f("SKILL.md"), f("examples/fixed_sleep/1-login.spec.ts"), f("scripts/check it.sh")] });
  ok("save:folder-files", { skillName: "", files: [f("SKILL.md")] });
  for (const bad of [
    "../../x",
    "a/../../x",
    "..\\..\\x",
    "a\\b",
    "/abs",
    "C:/x",
    "a//b",
    "a:b",
    "./x",
    "CON.md",
    "con",
    "lpt1.txt",
    "x.",
    "x ",
    "a/<b>",
    "",
    "é.md",
    "a/" + "b".repeat(101),
  ]) {
    no("save:folder-files", { skillName: "s", files: [f("SKILL.md"), f(bad)] });
  }
  for (const bad of ["../x", "..", ".", "a/b", "a\\b", "x.", "CON", "a b"]) no("save:folder-files", { skillName: bad, files: [f("SKILL.md")] });
  no("save:folder-files", { skillName: "s", files: [] });
  no("save:folder-files", { skillName: "s", files: [{ path: "a" }] });
  no("save:folder-files", { skillName: "s", files: Array.from({ length: 201 }, (_, i) => f(`f${i}.md`)) });
  no("save:folder-files", { skillName: "s", files: [{ path: "a.md", content: "x".repeat(10 * 1024 * 1024 + 1) }] });
});

test("isInside: resolved, case-insensitive on Windows and macOS", () => {
  assert.equal(V.isInside("/p/skills/s", "/p/skills/s/a/b.md", "linux"), true);
  assert.equal(V.isInside("/p/skills/s", "/p/skills/s/../x", "linux"), false);
  assert.equal(V.isInside("/p/skills/s", "/p/skills/sx/a", "linux"), false);
  assert.equal(V.isInside("/p/skills/s", "/p/skills/s", "linux"), false);
  assert.equal(V.isInside("C:\\p\\skills\\s", "C:\\p\\skills\\s\\..\\..\\x", "win32"), false);
  assert.equal(V.isInside("C:\\p\\skills\\s", "c:\\P\\Skills\\S\\a.md", "win32"), true);
  assert.equal(V.isInside("/Users/a/skills/s", "/users/A/skills/s/x.md", "darwin"), true);
});

test("safeBasename: only a file name survives", () => {
  assert.equal(V.safeBasename("../../.bashrc"), ".bashrc");
  assert.equal(V.safeBasename("..\\..\\x.md"), "x.md");
  assert.equal(V.safeBasename("/etc/passwd"), "passwd");
  assert.equal(V.safeBasename("C:\\Windows\\win.ini"), "win.ini");
  assert.equal(V.safeBasename(".."), "sessionlens.md");
  assert.equal(V.safeBasename(""), "sessionlens.md");
  assert.equal(V.safeBasename("a:b.md"), "sessionlens.md");
  assert.equal(V.safeBasename("report.md"), "report.md");
});

test("session:* (phase 4)", () => {
  const s = { id: "abc", created: "2026-01-01", events: [], findings: [{ check: "x" }], verdicts: {} };
  ok("session:list", {});
  ok("session:clear", {});
  ok("session:get", { id: "abc" });
  ok("session:get", { id: "../x" }); // any single-line id: it never becomes a path
  no("session:get", {});
  no("session:get", { id: "" });
  no("session:get", { id: "a\nb" });
  no("session:get", { id: "x".repeat(201) });
  no("session:get", { id: 5 });
  ok("session:delete", { id: "abc" });
  no("session:delete", { id: null });
  ok("session:put", { session: s });
  ok("session:put", { session: s, baseRev: 3, analyzedGen: "0a1b2c3d", background: true });
  ok("session:put", { session: s, analyzedGen: "" });
  no("session:put", {});
  no("session:put", { session: "x" });
  no("session:put", { session: Object.assign({}, s, { events: {} }) });
  no("session:put", { session: Object.assign({}, s, { verdicts: [] }) });
  no("session:put", { session: Object.assign({}, s, { created: 1 }) });
  no("session:put", { session: Object.assign({}, s, { findings: [{}] }) });
  no("session:put", { session: s, baseRev: 1.5 });
  no("session:put", { session: s, analyzedGen: "ZZZZZZZZ" });
  no("session:put", { session: s, background: "yes" });
  no("session:put", { session: Object.assign({}, s, { events: [{ text: "x".repeat(V.MAX_SESSION) }] }) });
});
