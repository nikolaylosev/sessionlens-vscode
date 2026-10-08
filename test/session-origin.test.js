"use strict";
/* Summary schema 4 (0.1.124): the agent a session comes from and the folder it worked in (Lens.transcriptOrigin), and
   openCount, the findings shown that have no verdict yet. The Sessions tree groups by the agent and filters by
   openCount; the project is only kept for now. Made-up transcripts, one per format importAny reads. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");

const { Lens } = load();
const cfg = Lens.profile("qa-ts");
const J = (...recs) => recs.map((r) => JSON.stringify(r)).join("\n");

const claudeCode = J(
  { type: "summary", summary: "cart" },
  { type: "user", cwd: "/w/shop/", message: { role: "user", content: "Write the cart test" } },
  { type: "assistant", cwd: "/w/other", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } },
);
const codex = J(
  { timestamp: "2026-09-24T09:30:00.000Z", type: "session_meta", payload: { cwd: "/w/api", originator: "codex_vscode" } },
  {
    timestamp: "2026-09-24T09:30:01.000Z",
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fix it" }] },
  },
);
const cursor = J(
  { role: "user", message: { content: [{ type: "text", text: "<user_query>Run the tests</user_query>" }] } },
  { role: "assistant", message: { content: [{ type: "tool_use", name: "Shell", input: { command: "npx playwright test" } }] } },
);
const cursorCli = J(
  { type: "system", subtype: "init", cwd: "/w/app", session_id: "s1" },
  { type: "user", message: { role: "user", content: [{ type: "text", text: "Run" }] }, session_id: "s1" },
  { type: "tool_call", subtype: "started", call_id: "c1", tool_call: { shellToolCall: { args: { command: "ls" } } } },
);
const claudeAi = JSON.stringify([{ name: "chat", chat_messages: [{ sender: "human", text: "Write a test for the cart" }] }]);
const text = "User: write the cart test\nAssistant: here it is";

test("transcriptOrigin: the agent is the format importAny reads, the project its folder", () => {
  const got = (t, opts) => Lens.transcriptOrigin(t, opts);
  assert.deepEqual(got(claudeCode), { agent: "claude-code", project: "/w/shop" }, "the first cwd, without the slash at the end");
  assert.deepEqual(got(codex), { agent: "codex", project: "/w/api" });
  assert.deepEqual(got(cursor, { cursorProject: "Users-me-shop" }), { agent: "cursor", project: "Users-me-shop" }, "the folder in ~/.cursor/projects");
  assert.deepEqual(got(cursor), { agent: "cursor", project: "" }, "dropped or pasted: no folder");
  assert.deepEqual(got(cursorCli), { agent: "cursor", project: "/w/app" });
  assert.deepEqual(got(claudeAi), { agent: "claude-ai", project: "" });
  assert.deepEqual(got(text), { agent: "text", project: "" });
  assert.deepEqual(got("   \n" + claudeCode), { agent: "claude-code", project: "/w/shop" }, "leading blank lines");
  assert.deepEqual(got(""), { agent: "", project: "" });
  assert.deepEqual(got(undefined), { agent: "", project: "" });
  assert.deepEqual(got("[not json"), { agent: "text", project: "" }, "importAny reads it as text too");
  for (const a of ["claude-code", "codex", "cursor", "claude-ai", "text"]) assert.ok(Lens.AGENTS.includes(a), a);
});

test("transcriptOrigin agrees with the path importAny takes", () => {
  // each transcript gives steps, and the steps show the reader that made them
  const ev = (t, opts) => Lens.importAny(t, cfg, opts);
  assert.ok(ev(claudeCode).some((e) => e.kind === "user"));
  assert.ok(ev(codex).some((e) => e.kind === "user"));
  assert.equal(ev(cursor).find((e) => e.tool).tool, "Shell", "Cursor's own tool name: read by the Cursor import");
  assert.equal(ev(cursorCli).find((e) => e.cmd).cmd, "ls");
  const ai = Lens.importAny(claudeAi, cfg);
  assert.ok(ai.some((e) => e.kind === "user"));
  assert.ok(ev(text).length > 0);
});

test("transcriptOrigin: a project with control characters is dropped, a long one is cut", () => {
  assert.equal(Lens.transcriptOrigin(J({ type: "user", cwd: "/w/a\nb", message: { role: "user", content: "x" } })).project, "");
  assert.equal(Lens.transcriptOrigin(J({ type: "user", cwd: "/" + "a".repeat(600), message: { role: "user", content: "x" } })).project.length, 500);
  assert.equal(Lens.transcriptOrigin(J({ type: "user", cwd: "C:\\w\\shop\\", message: { role: "user", content: "x" } })).project, "C:\\w\\shop");
});

const f = (check, seq) => ({ check, severity: "high", seq, message: check + " " + seq });
const base = (extra) =>
  Object.assign({ id: "s1", name: "n", task: "", profile: "qa-ts", created: "2026-10-08T00:00:00.000Z", events: [], findings: [], verdicts: {} }, extra);

test("sessionSummary: the agent and project stored at import win; without them, the kept text gives them", () => {
  let m = Lens.sessionSummary(base({ agent: "codex", project: "/w/api", source_text: claudeCode }));
  assert.deepEqual([m.agent, m.project], ["codex", "/w/api"]);
  m = Lens.sessionSummary(base({ source_text: claudeCode }));
  assert.deepEqual([m.agent, m.project], ["claude-code", "/w/shop"], "imported before 0.1.124");
  m = Lens.sessionSummary(base({ source_text: cursor, source_project: "Users-me-shop" }));
  assert.deepEqual([m.agent, m.project], ["cursor", "Users-me-shop"]);
  m = Lens.sessionSummary(base({ source_text: "" }));
  assert.deepEqual([m.agent, m.project], ["", ""], "a long transcript was not kept: unknown until Import again");
  m = Lens.sessionSummary(base({ agent: "<img>", project: 5, source_text: codex }));
  assert.deepEqual([m.agent, m.project], ["codex", "/w/api"], "an agent not on the list is not trusted");
  m = Lens.sessionSummary(base({ agent: "text", project: "/w\u0007" }));
  assert.deepEqual([m.agent, m.project], ["text", ""]);
});

test("sessionSummary: openCount is the findings shown without a verdict; verdicts on findings that are gone do not count", () => {
  const a = f("weak_assert", 1),
    b = f("weak_assert", 2),
    c = f("raw_locator", 3),
    hidden = f("magic_number", 4);
  const s = base({
    findings: [a, b, c],
    calibHidden: [hidden],
    verdicts: { [Lens.fkey(a)]: { v: "ok" }, [Lens.fkey(c)]: { v: "fp" }, "gone@9": { v: "ok" } },
  });
  const m = Lens.sessionSummary(s);
  assert.equal(m.openCount, 1);
  assert.equal(m.verdictsCount, 3, "counts the verdict on a finding that is gone");
  assert.equal(Lens.sessionSummary(base({ findings: [a, b] })).openCount, 2, "not reviewed");
  assert.equal(Lens.sessionSummary(base()).openCount, 0, "no findings");
});
