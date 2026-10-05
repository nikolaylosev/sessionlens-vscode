"use strict";
/* The Cursor Agent import (0.1.121): agent-transcripts/<id>/<id>.jsonl from the Cursor IDE or its CLI. A line has `role`
   at the top and `message.content`; a tool_use has no id and no result. What is checked: detection (and Claude Code and
   Codex files staying on their paths), the user's text and timestamp, each tool as the event the checks read, files
   rebuilt across Write and StrReplace, a deleted test, and test runs without output. Made-up content only. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");

const { Lens } = load();
const cfg = Lens.profile("qa-ts");

const user = (q) => ({
  role: "user",
  message: { content: [{ type: "text", text: `<timestamp>Monday, Oct 5, 2026, 1:06 AM (UTC+5)</timestamp>\n<user_query>\n${q}\n</user_query>` }] },
});
const say = (text) => ({ role: "assistant", message: { content: [{ type: "text", text }] } });
const call = (name, input) => ({ role: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
const jsonl = (...lines) => [...lines, { type: "turn_ended", status: "success" }].map((l) => JSON.stringify(l)).join("\n");
const imp = (...lines) => Lens.importAny(jsonl(...lines), cfg);
const brief = (e) => [e.kind, e.tool || "", e.file || "", e.cmd || ""].join(" | ");
const found = (events, check) =>
  Lens.runChecks(events, cfg)
    .filter((f) => f.check === check)
    .map((f) => `${f.severity}: ${f.message}`);

const SPEC = "e2e/cart.spec.ts";
const TWO =
  "import { test, expect } from '@playwright/test';\n\ntest('total', async ({ page }) => {\n  await expect(page.getByTestId('total')).toHaveText(TOTAL);\n  await expect(page.getByTestId('count')).toHaveText(COUNT);\n});\n";

test("detected by `role` at the top: a file that starts with the user's text gives events (0 before 0.1.121)", () => {
  const ev = imp(user("Write tests for the cart"), say("I'll write them."));
  assert.deepEqual(
    ev.map((e) => [e.kind, e.text]),
    [
      ["user", "Write tests for the cart"],
      ["message", "I'll write them."],
    ],
  );
  assert.equal(ev[0].ts, "2026-10-04T20:06:00.000Z", "the <timestamp> as ISO; lines have no time of their own");
});

test("a Claude Code or Codex file is not taken for a Cursor one", () => {
  const claude = JSON.stringify({ type: "user", message: { role: "user", content: "Write the tests" } });
  assert.deepEqual(
    Lens.importAny(claude, cfg).map((e) => e.kind),
    ["user"],
  );
  const codex = JSON.stringify({ type: "session_meta", payload: { cwd: "/w" } });
  assert.deepEqual(Lens.importAny(codex, cfg), []);
});

test("each tool becomes the event the checks read; Cursor's own names stay on the events", () => {
  const ev = imp(
    user("Write tests"),
    call("Read", { path: "src/cart.ts", limit: 50 }),
    call("Grep", { path: "src", pattern: "total" }),
    call("Glob", { glob_pattern: "**/*.ts", target_directory: "src" }),
    call("Shell", { command: "npx playwright test", description: "Run the tests" }),
    call("Shell", { command: "git status" }),
    call("Shell", { command: "ls -la" }),
    call("TodoWrite", { todos: [] }),
    call("StrReplace", { old_string: "a", new_string: "b" }),
  );
  assert.deepEqual(ev.slice(1).map(brief), [
    "read | Read | src/cart.ts | ",
    "search | Grep | src | ",
    "search | Glob | src | ",
    "run_tests | Shell |  | npx playwright test",
    "git | Shell |  | git status",
    "run_other | Shell |  | ls -la",
    "tool | TodoWrite |  | ",
    "tool | StrReplace |  | ",
  ]);
});

test("Write with `contents`, then StrReplace: the whole file after the edit, and a weakened test is seen", () => {
  const ev = imp(
    user("Write tests"),
    call("Write", { path: SPEC, contents: TWO }),
    call("StrReplace", { path: SPEC, old_string: "  await expect(page.getByTestId('count')).toHaveText(COUNT);\n", new_string: "" }),
  );
  const [w, e] = ev.slice(1);
  assert.deepEqual([w.kind, w.file, w.new_content], ["write", SPEC, TWO]);
  assert.equal(e.kind, "edit");
  assert.ok(e.new_content.startsWith("import { test, expect }") && !e.new_content.includes("COUNT"), "the whole file, not the fragment");
  assert.deepEqual(found(ev, "assert_weakened"), [`high: ${SPEC}: total — fewer assertions (2 → 1)`]);
});

test("Delete of a test file is test_deleted", () => {
  const ev = imp(user("Clean up"), call("Write", { path: SPEC, contents: TWO }), call("Delete", { path: SPEC }));
  assert.deepEqual(ev.slice(1).map(brief), [`write | Write | ${SPEC} | `, `delete | Delete | ${SPEC} | `]);
  assert.equal(found(ev, "test_deleted").length, 1);
});

test("a test run has no output: tests_never_run sees the run, a claim after it is not reported (unknown result)", () => {
  const wrote = [user("Write tests"), call("Write", { path: SPEC, contents: TWO })];
  const run = imp(...wrote, call("Shell", { command: "npx playwright test" }), say("All tests pass."));
  const r = run.find((e) => e.kind === "run_tests");
  assert.deepEqual([r.output_missing, r.tests], [true, undefined]);
  assert.deepEqual(found(run, "tests_never_run"), []);
  assert.deepEqual(found(run, "pass_claim_without_run"), []);
  assert.deepEqual(found(run, "fix_after_fail_without_triage"), [], "it starts from a red run, which a Cursor transcript cannot show");
  const noRun = imp(...wrote, say("All tests pass."));
  assert.equal(found(noRun, "tests_never_run").length, 1);
  assert.deepEqual(found(noRun, "pass_claim_without_run"), ["high: Claims tests pass, but no test run in the preceding steps"]);
});
