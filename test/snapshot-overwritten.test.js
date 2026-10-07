"use strict";
/* snapshot_overwritten (phase 10, step 5): snapshots rewritten instead of read — an update flag on a test run, or a
   snapshot file written by hand. High right after a red run, medium otherwise (the first baselines of new tests).
   What must not count: -u outside a test runner (git push -u), a plain test run, a test file next to snapshots. After a
   red run, a run whose output is not in the transcript makes the finding medium; one whose output could not be parsed
   does not. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");

const { Lens } = load();

// steps: ["write", file] | ["bash", command, output]
function transcript(steps) {
  const L = [JSON.stringify({ type: "user", message: { role: "user", content: "Write the tests" } })];
  steps.forEach(([kind, a, b], i) => {
    const id = "t" + i;
    const [name, input] = kind === "write" ? ["Write", { file_path: a, content: "exports[`total 1`] = `10`;\n" }] : ["Bash", { command: a }];
    L.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } }));
    L.push(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: b || "ok" }] } }));
  });
  return L.join("\n");
}
const found = (profile, steps) => {
  const cfg = Lens.profile(profile);
  return Lens.runChecks(Lens.importAny(transcript(steps), cfg), cfg)
    .filter((f) => f.check === "snapshot_overwritten")
    .map((f) => `${f.severity}: ${f.message}`);
};
const RED = ["bash", "npx jest", "Tests: 1 failed, 2 passed, 3 total\nSnapshots: 1 failed"];

test("an update flag on a test run: high right after a red run, medium otherwise", () => {
  assert.deepEqual(found("qa-ts", [RED, ["bash", "npx jest -u", "Tests: 3 passed, 3 total"]]), [
    "high: Snapshots updated: npx jest -u — right after a failing run (seq 1)",
  ]);
  for (const cmd of [
    "npx playwright test --update-snapshots",
    "npx playwright test --update-snapshots=changed",
    "npx vitest run -u",
    "npm test -- --updateSnapshot",
    "UPDATE_SNAPSHOTS=1 npm test",
    "npx cypress run --env updateSnapshots=true",
    "./node_modules/.bin/jest -u",
    "cd web && CI=1 pnpm exec vitest run -u",
    "yarn test -u",
  ])
    assert.deepEqual(found("qa-ts", [["bash", cmd, ""]]), [`medium: Snapshots updated: ${cmd}`], cmd);
  assert.deepEqual(found("qa-python", [["bash", "pytest --snapshot-update tests/", "3 passed"]]), [
    "medium: Snapshots updated: pytest --snapshot-update tests/",
  ]);
});

// a red run, then a re-run whose result is not known, then the change (0.1.123): output that could not be parsed is
// skipped, so the red run decides (high); output that is not in the transcript (output_missing, a Cursor import) makes
// the result unknown (medium), as in pass_claim_without_run. → [severities with unparsed output, with output_missing]
function afterUnknownRerun(profile, steps, check) {
  const cfg = Lens.profile(profile);
  const ev = Lens.importAny(transcript(steps), cfg);
  const sev = () =>
    Lens.runChecks(ev, cfg)
      .filter((f) => f.check === check)
      .map((f) => f.severity);
  const unparsed = sev();
  for (const e of ev) if (e.kind === "run_tests" && !e.tests) e.output_missing = true;
  return [unparsed, sev()];
}

test("a run with no parsed result: unparsed output is skipped, output_missing makes the result unknown (0.1.123)", () => {
  assert.deepEqual(
    found("qa-ts", [
      ["bash", "npx playwright test", "browser launched"],
      ["bash", "npx jest -u", ""],
    ]),
    ["medium: Snapshots updated: npx jest -u"],
    "no red run before it",
  );
  const steps = [RED, ["bash", "npx jest", "Jest did not exit one second after the test run has completed."], ["bash", "npx jest -u", ""]];
  assert.deepEqual(afterUnknownRerun("qa-ts", steps, "snapshot_overwritten"), [["high"], ["medium"]]);
});

test("a snapshot file written by hand: one finding per file", () => {
  assert.deepEqual(
    found("qa-ts", [
      RED,
      ["write", "src/__snapshots__/cart.test.ts.snap"],
      ["write", "src/__snapshots__/cart.test.ts.snap"],
      ["write", "e2e/cart.spec.ts-snapshots/total-chromium-darwin.png"],
    ]),
    [
      "high: src/__snapshots__/cart.test.ts.snap: snapshot written by hand — right after a failing run (seq 1)",
      "high: e2e/cart.spec.ts-snapshots/total-chromium-darwin.png: snapshot written by hand — right after a failing run (seq 1)",
    ],
  );
});

test("Java and .NET: an ApprovalTests or Verify baseline written by hand", () => {
  assert.deepEqual(found("qa-java", [["write", "src/test/java/shop/CartTest.total.approved.txt"]]), [
    "medium: src/test/java/shop/CartTest.total.approved.txt: snapshot written by hand",
  ]);
  assert.deepEqual(
    found("qa-c#", [
      ["write", "Tests/CartTests.Total.verified.json"],
      ["write", "Tests/CartTests.Total.received.json"],
    ]),
    ["medium: Tests/CartTests.Total.verified.json: snapshot written by hand"],
  );
});

test("not reported: -u outside a test runner, a plain run, a test file, a folder merely named like snapshots", () => {
  const none = (steps, why) => assert.deepEqual(found("qa-ts", steps), [], why);
  none([["bash", "git push -u origin feat/x", ""]], "git push -u");
  none([["bash", "python3 - <<'EOF'\ncmds = [\n  \"npx jest -u\",\n  'npx playwright test --update-snapshots',\n]\nEOF", ""]], "commands quoted in a heredoc");
  none([["bash", "env -u ELECTRON_RUN_AS_NODE npm run test:integration", "3 passed"]], "env's -u before the runner (a real session)");
  none([["bash", "npm install -D jest && sort -u list.txt", ""]], "-u of another command");
  none([RED, ["bash", "npx jest --ci", "Tests: 3 passed, 3 total"]], "a plain run");
  none(
    [
      ["write", "src/__tests__/cart.test.ts"],
      ["write", "docs/snapshots.md"],
    ],
    "a test file, a doc",
  );
});
