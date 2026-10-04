"use strict";
/* hardcoded_date: a calendar date on an assertion line. What must not count: a date in a variable outside the
   assertion, an assertion without a date, a commented-out assertion (a comment never runs; reported until 0.1.118). */
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");

const { Lens } = load();

const found = (file, content, profile = "qa-ts") =>
  Lens.runChecks([{ seq: 1, kind: "write", file, new_content: content }], Lens.profile(profile))
    .filter((f) => f.check === "hardcoded_date")
    .map((f) => `${f.severity}: ${f.message}`);

test("a date in an assertion is reported", () => {
  assert.deepEqual(found("e2e/deadline.spec.ts", "expect(text).toHaveText('Deadline March 15, 2026');\n"), [
    "medium: e2e/deadline.spec.ts: date in an assertion “expect(text).toHaveText('Deadline March 15, 2026');” — will go red when content changes",
  ]);
  assert.deepEqual(found("e2e/deadline.spec.ts", "await expect(page.getByText('2026-03-15')).toBeVisible();\n"), [
    "medium: e2e/deadline.spec.ts: date in an assertion “await expect(page.getByText('2026-03-15')).toBeVisible();” — will go red when content changes",
  ]);
});

test("not reported: a date outside an assertion, or an assertion without a date", () => {
  assert.deepEqual(found("e2e/deadline.spec.ts", "const deadline = '2026-03-15';\nexpect(text).toMatch(/Deadline/);\n"), []);
  assert.deepEqual(found("e2e/deadline.spec.ts", "expect(page.getByRole('heading', { name: 'Paid' })).toBeVisible();\n"), []);
});

test("not reported: a commented-out assertion with a date; the code line next to it still is", () => {
  assert.deepEqual(found("e2e/deadline.spec.ts", "// expect(text).toHaveText('2026-03-15');\nexpect(text).toMatch(/Deadline/);\n"), []);
  assert.deepEqual(found("e2e/deadline.spec.ts", "/* expect(text).toHaveText('March 15, 2026'); */\n"), []);
  assert.deepEqual(found("e2e/deadline.spec.ts", "/**\n * expect(text).toHaveText('2026-03-15');\n */\n"), []);
  assert.deepEqual(
    found("tests/test_deadline.py", "def test_deadline():\n    # assert page.title == 'March 15, 2026'\n    assert page.title\n", "qa-python"),
    [],
  );
  assert.deepEqual(found("e2e/deadline.spec.ts", "// the old check\nexpect(text).toHaveText('2026-03-15');\n"), [
    "medium: e2e/deadline.spec.ts: date in an assertion “expect(text).toHaveText('2026-03-15');” — will go red when content changes",
  ]);
});
