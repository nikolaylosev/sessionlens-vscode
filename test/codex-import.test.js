"use strict";
/* The Codex import (fromCodexJsonl): file changes become write / edit / delete steps with the whole file, and commands
   become test runs with their results. Codex up to 0.154 wrote a change as an event_msg patch_apply_end; 0.155 and later
   (the VS Code extension and the desktop app, Sept 2026) write it as an event_msg item_completed whose item is a
   FileChange with the same `changes`. Until 0.1.121 the second form was skipped, so a session had no edits and the
   code checks saw nothing. The records below have the shape of a real 0.155 rollout. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");

const { Lens } = load();

const rec = (type, payload) => JSON.stringify({ timestamp: "2026-09-24T09:30:00.000Z", type, payload });
const META = rec("session_meta", { cwd: "/w", originator: "codex_vscode", cli_version: "0.155.0" });
const user = (text) => rec("response_item", { type: "message", role: "user", content: [{ type: "input_text", text }] });
// up to 0.154
const patchEnd = (changes) => rec("event_msg", { type: "patch_apply_end", changes });
// 0.155+
const fileChange = (changes, status = "completed") =>
  rec("event_msg", {
    type: "item_completed",
    thread_id: "t1",
    turn_id: "u1",
    item: { type: "FileChange", id: "exec-1", changes, status, stdout: "" },
    completed_at_ms: 0,
  });
// the code-mode harness of 0.155+: a JS snippet that calls tools.exec_command
const exec = (id, cmd) =>
  rec("response_item", {
    type: "custom_tool_call",
    name: "exec",
    call_id: id,
    input: `const r = await tools.exec_command(${JSON.stringify({ cmd, workdir: "/w", yield_time_ms: 30000 })});\ntext(r);\n`,
  });
const output = (id, text) => rec("response_item", { type: "custom_tool_call_output", call_id: id, output: text });

const SPEC = "e2e/cart.spec.ts";
const V1 = "import { test, expect } from '@playwright/test';\n\ntest('total', async () => {\n  expect(total).toBe(3);\n});\n";
const DIFF = "@@ -4 +4 @@\n-  expect(total).toBe(3);\n+  expect(total).toBeDefined();\n";
const V2 = V1.replace("toBe(3)", "toBeDefined()");

const importText = (lines) => Lens.importAny([META, user("Write the cart tests"), ...lines].join("\n"), Lens.profile("qa-ts"));
const steps = (ev) => ev.filter((e) => ["write", "edit", "delete"].includes(e.kind)).map((e) => `${e.kind} ${e.file}`);
const weakened = (ev) =>
  Lens.runChecks(ev, Lens.profile("qa-ts"))
    .filter((f) => f.check === "assert_weakened")
    .map((f) => `${f.severity}: ${f.message}`);
const WEAKENED = [`high: ${SPEC}: total — assertion weakened (expect(total).toBe(3); → expect(total).toBeDefined();)`];

test("0.155+: an item_completed FileChange is a write, then an edit with the whole file (none before 0.1.121)", () => {
  const ev = importText([
    fileChange({ "/w/e2e/cart.spec.ts": { type: "add", content: V1 } }),
    fileChange({ "/w/e2e/cart.spec.ts": { type: "update", unified_diff: DIFF, move_path: null } }),
  ]);
  assert.deepEqual(steps(ev), [`write ${SPEC}`, `edit ${SPEC}`]);
  assert.equal(ev.find((e) => e.kind === "edit").new_content, V2);
  assert.deepEqual(weakened(ev), WEAKENED, "the code checks see the edit");
});

test("up to 0.154: patch_apply_end gives the same steps as before", () => {
  const ev = importText([
    patchEnd({ "/w/e2e/cart.spec.ts": { type: "add", content: V1 } }),
    patchEnd({ "/w/e2e/cart.spec.ts": { type: "update", unified_diff: DIFF } }),
  ]);
  assert.deepEqual(steps(ev), [`write ${SPEC}`, `edit ${SPEC}`]);
  assert.deepEqual(weakened(ev), WEAKENED);
});

test("a patch written as both records is applied once", () => {
  const add = { "/w/e2e/cart.spec.ts": { type: "add", content: V1 } },
    upd = { "/w/e2e/cart.spec.ts": { type: "update", unified_diff: DIFF, move_path: null } };
  const ev = importText([patchEnd(add), fileChange(add), fileChange(upd), patchEnd(upd)]);
  assert.deepEqual(steps(ev), [`write ${SPEC}`, `edit ${SPEC}`]);
  assert.equal(ev.find((e) => e.kind === "edit").new_content, V2, "the diff is not applied twice");
});

test("a FileChange that did not complete changes nothing; a deleted file is a delete step", () => {
  const ev = importText([
    fileChange({ "/w/e2e/cart.spec.ts": { type: "add", content: V1 } }),
    fileChange({ "/w/e2e/cart.spec.ts": { type: "update", unified_diff: DIFF } }, "failed"),
    fileChange({ "/w/e2e/cart.spec.ts": { type: "delete" } }),
  ]);
  assert.deepEqual(steps(ev), [`write ${SPEC}`, `delete ${SPEC}`]);
});

test("0.155+: a command run through the exec harness is a test run with its result", () => {
  const ev = importText([exec("c1", "npx playwright test"), output("c1", "Running 2 tests using 1 worker\n\n  1 failed\n  1 passed (3.1s)\n")]);
  const run = ev.find((e) => e.kind === "run_tests");
  assert.equal(run.cmd, "npx playwright test");
  assert.deepEqual([run.tests.passed, run.tests.failed], [1, 1]);
});

test("a diff that ends with a line break keeps the line after each hunk (Codex's always does; lost until 0.1.121)", () => {
  const before = ["a", "b", "c", "d", "e", "f", "g"].join("\n") + "\n";
  const diff = "@@ -2 +2 @@\n-b\n+B\n@@ -5,2 +5,2 @@\n-e\n+E\n f\n";
  const ev = importText([
    fileChange({ "/w/notes.ts": { type: "add", content: before } }),
    fileChange({ "/w/notes.ts": { type: "update", unified_diff: diff } }),
  ]);
  assert.equal(ev.find((e) => e.kind === "edit").new_content, ["a", "B", "c", "d", "E", "f", "g"].join("\n") + "\n");
});

// 0.159+: the snippet is plain JS, so the key is unquoted: tools.exec_command({cmd:"…"})
const exec159 = (id, js) => rec("response_item", { type: "custom_tool_call", name: "exec", call_id: id, input: js });

test("0.159+: a command with an unquoted cmd key is a step with its command (a bare tool step before 0.1.121)", () => {
  const ev = importText([
    exec159("c1", 'const r = await tools.exec_command({cmd:"npx playwright test","workdir":"/w"});\ntext(r);\n'),
    output("c1", "  1 failed\n  1 passed (3.1s)\n"),
  ]);
  const run = ev.find((e) => e.kind === "run_tests");
  assert.equal(run.cmd, "npx playwright test");
  assert.deepEqual([run.tests.passed, run.tests.failed, run.tool], [1, 1, "exec"]);
});

test("a snippet that runs several commands gives them all", () => {
  const ev = importText([
    exec159("c1", 'const a = await tools.exec_command({cmd:"npm install"});\nconst b = await tools.exec_command({cmd:"npx playwright test"});\ntext(b);\n'),
    output("c1", "  2 passed (1.0s)\n"),
  ]);
  assert.deepEqual(
    ev.filter((e) => e.cmd).map((e) => `${e.kind} ${e.cmd}`),
    ["run_tests npm install; npx playwright test"],
  );
});

test("Import again: a stored bare exec step is the same step as its command now (transcriptMatch)", () => {
  const fresh = importText([exec159("c1", 'await tools.exec_command({cmd:"ls -la"});'), output("c1", "total 0")]);
  const stored = fresh.map((e) => (e.tool === "exec" ? { seq: e.seq, ts: e.ts, kind: "tool", tool: "exec" } : e));
  assert.equal(Lens.transcriptMatch(stored, fresh), 1);
});

test("a command that only lists the tests is not a test run (0.1.122)", () => {
  const ev = importText([exec("c1", "npx playwright test --list"), output("c1", "Total: 2 tests in 1 file\n")]);
  assert.deepEqual(
    ev.filter((e) => e.cmd).map((e) => `${e.kind} ${e.cmd}`),
    ["run_other npx playwright test --list"],
  );
});

/* "*** Move to:" in a Codex patch: an update with move_path, the file's new absolute name (0.1.122; until then the
   file kept its old name, and the next edit under the new one had no text to apply to). */
const MOVED = "e2e/checkout/cart.spec.ts";
test("a file moved by a patch is an edit of its new name, and the next edit applies to the whole file (0.1.122)", () => {
  for (const record of [patchEnd, fileChange]) {
    const ev = importText([
      record({ "/w/e2e/cart.spec.ts": { type: "add", content: V1 } }),
      record({ "/w/e2e/cart.spec.ts": { type: "update", unified_diff: "", move_path: "/w/" + MOVED } }),
      record({ ["/w/" + MOVED]: { type: "update", unified_diff: DIFF, move_path: null } }),
    ]);
    assert.deepEqual(steps(ev), [`write ${SPEC}`, `edit ${MOVED}`, `edit ${MOVED}`], record.name);
    const [, moved, edited] = ev.filter((e) => e.kind === "edit" || e.kind === "write");
    assert.equal(moved.new_content, V1, "a move with no hunk keeps the text");
    assert.equal(edited.new_content, V2, "the edit after the move has the whole file");
    assert.ok(!edited.fragment_only);
    assert.deepEqual(
      Lens.runChecks(ev, Lens.profile("qa-ts"))
        .filter((f) => f.check === "assert_weakened")
        .map((f) => f.message.split(":")[0]),
      [MOVED],
      "assert_weakened sees the edit under the new name",
    );
  }
});

test("a test moved with its file is not deleted; an edit made during the move is read (0.1.122)", () => {
  const ev = importText([
    fileChange({ "/w/e2e/cart.spec.ts": { type: "add", content: V1 } }),
    fileChange({ "/w/e2e/cart.spec.ts": { type: "update", unified_diff: DIFF, move_path: "/w/" + MOVED } }),
  ]);
  assert.deepEqual(steps(ev), [`write ${SPEC}`, `edit ${MOVED}`]);
  const found = Lens.runChecks(ev, Lens.profile("qa-ts")).map((f) => f.check);
  assert.ok(!found.includes("test_deleted"), found.join(", "));
  assert.ok(found.includes("assert_weakened"), "the old text is the edit's before");
});
