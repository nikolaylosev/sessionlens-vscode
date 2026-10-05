"use strict";
/* The Cursor Agent CLI log (0.1.121): `agent -p --output-format stream-json`. Unlike the transcript, every tool call is
   there with its result: an edit with the whole file before and after, a shell call with its output and exit code.
   What is checked: detection (Claude Code's own stream-json, a Cursor transcript and a Claude Code transcript stay on
   their paths), each tool as the event the checks read, files and test results taken from the results, a run without
   a result, the times, the checks on top, and the question asked for a file whose tool calls the import cannot read.
   Made-up content only. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");
const { bootHost, openPage } = require("./host-panel");

const { Lens } = load();
const cfg = Lens.profile("qa-ts");

const CWD = "/w/shop";
const SPEC = CWD + "/e2e/cart.spec.ts";
const ONE =
  "import { test, expect } from '@playwright/test';\n\ntest('total', async ({ page }) => {\n  await expect(page.getByTestId('total')).toHaveText('42');\n});\n";
const WEAK = ONE.replace("toHaveText('42')", "toBeVisible()");
const T0 = Date.UTC(2026, 9, 5, 10, 0, 0);

let n = 0;
const at = (s) => ({ timestamp_ms: T0 + s * 1000 });
const init = () => ({ type: "system", subtype: "init", apiKeySource: "login", cwd: CWD, session_id: "s1", model: "Auto", permissionMode: "default" });
const user = (text) => ({ type: "user", message: { role: "user", content: [{ type: "text", text }] }, session_id: "s1" });
const say = (text, s) => Object.assign({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } }, at(s));
// a call as two lines, started and completed; result undefined: no completed line (a call cut off)
function call(kind, args, result, s) {
  const id = "call-" + n++;
  const started = Object.assign({ type: "tool_call", subtype: "started", call_id: id, tool_call: { [kind]: { args } } }, at(s));
  if (result === undefined) return [started];
  return [started, Object.assign({ type: "tool_call", subtype: "completed", call_id: id, tool_call: { [kind]: { args, result } } }, at(s + 1))];
}
const edit = (path, before, after, s) =>
  call(
    "editToolCall",
    { path, streamContent: after },
    { success: Object.assign({ path, afterFullFileContent: after, message: "ok" }, before == null ? {} : { beforeFullFileContent: before }) },
    s,
  );
const shell = (command, exitCode, stdout, s) =>
  call("shellToolCall", { command, workingDirectory: "" }, { [exitCode ? "failure" : "success"]: { command, exitCode, stdout, stderr: "" } }, s);
const log = (...lines) =>
  [init(), ...lines.flat(), { type: "result", subtype: "success", is_error: false, result: "done" }].map((l) => JSON.stringify(l)).join("\n");
const imp = (...lines) => Lens.importAny(log(...lines), cfg);
const brief = (e) => [e.kind, e.tool || "", e.file || "", e.cmd || ""].join(" | ");
const found = (events, check) =>
  Lens.runChecks(events, cfg)
    .filter((f) => f.check === check)
    .map((f) => f.severity);

const RED = "Running 1 test using 1 worker\n  1 failed\n    [chromium] › e2e/cart.spec.ts:3:5 › total\n  0 passed (2.1s)\n";
const GREEN = "Running 1 test using 1 worker\n  1 passed (2.0s)\n";

test("detected by its tool_call lines; Claude Code's stream-json and transcripts, and Cursor's transcript, stay on their paths", () => {
  assert.equal(Lens.isCursorStreamJson(log(user("Write the cart tests"), shell("npx playwright test", 0, GREEN, 1))), true);
  const claudeStream = [
    { type: "system", subtype: "init", cwd: CWD, session_id: "s", tools: ["Bash"], permissionMode: "default" },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npx playwright test" } }] } },
  ]
    .map((l) => JSON.stringify(l))
    .join("\n");
  assert.equal(Lens.isCursorStreamJson(claudeStream), false);
  const cursorTranscript = JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "<user_query>hi</user_query>" }] } });
  assert.equal(Lens.isCursorStreamJson(cursorTranscript), false);
  assert.equal(Lens.isCursorJsonl(cursorTranscript), true);
  const claude = JSON.stringify({ type: "user", message: { role: "user", content: "hi" }, timestamp: "2026-10-05T10:00:00Z" });
  assert.equal(Lens.isCursorStreamJson(claude), false);
});

test("each tool as the event the checks read, with Cursor's names; paths are relative to the cwd", () => {
  const ev = imp(
    user("Write the cart tests"),
    call("readToolCall", { path: CWD + "/package.json" }, { success: { content: '{"name":"shop"}', totalLines: 1 } }, 1),
    call("globToolCall", { targetDirectory: CWD + "/src", globPattern: "**/*.ts" }, { success: { files: [] } }, 3),
    call("grepToolCall", { pattern: "total", path: CWD }, { success: {} }, 5),
    call("mcpToolCall", { name: "browser_navigate", toolName: "browser_navigate", args: {} }, { success: { content: [] } }, 7),
    call("updateTodosToolCall", { todos: [] }, { success: {} }, 9),
    call("deleteToolCall", { path: CWD + "/e2e/old.spec.ts" }, { success: { path: CWD + "/e2e/old.spec.ts", prevContent: "x" } }, 11),
    shell("git status", 0, "clean", 13),
  );
  assert.deepEqual(ev.map(brief), [
    "user |  |  | ",
    "read | Read | package.json | ",
    "search | Glob | src | ",
    "search | Grep | /w/shop | ",
    "tool | browser_navigate |  | ",
    "tool | updateTodos |  | ",
    "delete | Delete | e2e/old.spec.ts | ",
    "git | Shell |  | git status",
  ]);
  assert.equal(ev[1].text, '{"name":"shop"}', "a read keeps what was read");
});

test("files come whole from the results: a new file is a write, a change is an edit with the file before it", () => {
  const ev = imp(user("Write the cart tests"), edit(SPEC, null, ONE, 1), edit(SPEC, ONE, WEAK, 3));
  const [w, e] = ev.filter((x) => x.kind === "write" || x.kind === "edit");
  assert.deepEqual([w.kind, w.tool, w.file, w.new_content], ["write", "Write", "e2e/cart.spec.ts", ONE]);
  assert.deepEqual([e.kind, e.tool, e.file, e.new_content, e.prev_content], ["edit", "Edit", "e2e/cart.spec.ts", WEAK, ONE]);
  assert.ok(!e.fragment_only);
  assert.deepEqual(found(ev, "assert_weakened").length, 1, "the weaker assertion is seen against the file before");
});

test("an edit that was not applied changes no file", () => {
  const ev = imp(user("Fix it"), call("editToolCall", { path: SPEC, streamContent: "x" }, { rejected: { reason: "user" } }, 1));
  assert.deepEqual(ev.map(brief), ["user |  |  | ", "tool | Edit | e2e/cart.spec.ts | "]);
  assert.equal(ev[1].new_content, undefined);
});

test("test runs: parsed from the output, red on a non-zero exit; a run with no result keeps its result unknown", () => {
  const ev = imp(
    user("Write the cart tests"),
    edit(SPEC, null, ONE, 1),
    shell("npx playwright test", 1, RED, 3),
    edit(SPEC, ONE, WEAK, 5),
    shell("npx playwright test", 0, GREEN, 7),
    call("shellToolCall", { command: "npx playwright test --repeat-each 5", isBackground: true }, undefined, 9),
    say("All tests pass.", 11),
  );
  const runs = ev.filter((e) => e.kind === "run_tests");
  assert.deepEqual(
    runs.map((r) => [r.tests && r.tests.passed, r.tests && r.tests.failed, r.exit_code, !!r.output_missing]),
    [
      [0, 1, 1, false],
      [1, 0, 0, false],
      [undefined, undefined, undefined, true],
    ],
  );
  assert.deepEqual(found(ev, "fix_after_fail_without_triage"), ["high"], "the test was edited right after the red run");
  assert.deepEqual(found(ev, "pass_claim_without_run"), [], "the last run's result is unknown, not absent");
});

test("a run whose output has no runner summary is still red by its exit code", () => {
  const ev = imp(user("Run the tests"), shell("npx playwright test", 1, "Error: browserType.launch: Executable doesn't exist", 1));
  const run = ev.find((e) => e.kind === "run_tests");
  assert.deepEqual([run.tests, run.exit_code, !!run.output_missing], [undefined, 1, false]);
});

test("times: each step has its own; the user's line takes the next time in the log", () => {
  const ev = imp(user("Write the cart tests"), say("I'll write them.", 1), edit(SPEC, null, ONE, 4));
  assert.deepEqual(
    ev.map((e) => e.ts),
    ["2026-10-05T10:00:01.000Z", "2026-10-05T10:00:01.000Z", "2026-10-05T10:00:04.000Z"],
  );
});

// a JSONL with tool calls in a format the import does not read: only the text is found
const UNREAD = [
  { type: "user", message: { role: "user", content: [{ type: "text", text: "Write the cart tests" }] } },
  { type: "function_call", name: "shell", arguments: '{"command":"npx playwright test"}' },
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "All tests pass." }] } },
]
  .map((l) => JSON.stringify(l))
  .join("\n");

test("unreadToolCalls: only for a file whose tool calls gave no event", () => {
  assert.equal(Lens.unreadToolCalls(UNREAD, Lens.importAny(UNREAD, cfg)), true);
  const stream = log(user("Write the cart tests"), shell("npx playwright test", 0, GREEN, 1));
  assert.equal(Lens.unreadToolCalls(stream, Lens.importAny(stream, cfg)), false, "read: it has a test run");
  const chat = JSON.stringify({ type: "user", message: { role: "user", content: "hi" } });
  assert.equal(Lens.unreadToolCalls(chat, Lens.importAny(chat, cfg)), false, "a text-only chat has no tool calls");
  const ai = JSON.stringify([{ name: "c", chat_messages: [{ sender: "human", content: [{ type: "tool_use", name: "artifacts" }] }] }]);
  assert.equal(Lens.unreadToolCalls(ai, [{ kind: "message" }]), false, "a claude.ai export: the chat's own tools");
});

async function pickInPanel(text, answer) {
  const host = bootHost({ globalState: { storageVersion: 2, settings: { profile: "qa-ts", lint: false, modelPool: [], defaultModelId: null } } });
  const p = await openPage(host);
  await p.ready();
  const asked = [];
  p.window.chooseDialog = async () => "other";
  p.window.__slPickTranscript = async () => ({ name: "run.jsonl", text });
  p.window.confirmDialog = async (m) => (asked.push(m), answer);
  p.document.querySelector("#file").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
  await p.idle();
  if (!p.document.querySelector("#name-row").hidden) p.document.querySelector("#name-go").click();
  await p.idle();
  return { p, asked, puts: p.sent.filter((m) => m.type === "session:put").length };
}

test("in the panel: a file with unread tool calls asks first; No keeps no session, a Cursor CLI log is not asked about", async () => {
  let r = await pickInPanel(UNREAD, false);
  assert.equal(r.asked.length, 1);
  assert.match(r.asked[0], /only the conversation text was found/);
  assert.equal(r.puts, 0);
  assert.deepEqual(r.p.errors, []);
  r.p.close();
  r = await pickInPanel(log(user("Write the cart tests"), edit(SPEC, null, ONE, 1), shell("npx playwright test", 0, GREEN, 3)), false);
  assert.equal(r.asked.length, 0);
  assert.equal(r.puts, 1);
  assert.deepEqual(r.p.errors, []);
  r.p.close();
});
