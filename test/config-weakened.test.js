"use strict";
/* config_weakened (phase 10, step 6): a test runner's config loosened — more retries, a longer timeout, tests
   excluded — compared with what the file was before. What must not count: a timeout made shorter, retries lowered, an
   unrelated config change, a config written for the first time (only its retries count, as before 0.1.113), and
   retries on a single test (that stays sleep_or_skip_added). */
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");

const { Lens } = load();

// steps: ["write", file, content] | ["edit", file, old, new] | ["bash", command, output]
function transcript(steps) {
  const L = [JSON.stringify({ type: "user", message: { role: "user", content: "Write the tests" } })];
  steps.forEach(([kind, a, b, c], i) => {
    const id = "t" + i;
    const input = kind === "write" ? { file_path: a, content: b } : kind === "edit" ? { file_path: a, old_string: b, new_string: c } : { command: a };
    const name = kind === "write" ? "Write" : kind === "edit" ? "Edit" : "Bash";
    L.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } }));
    L.push(
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: kind === "bash" ? b : "ok" }] } }),
    );
  });
  return L.join("\n");
}
const found = (profile, steps, check = "config_weakened") => {
  const cfg = Lens.profile(profile);
  return Lens.runChecks(Lens.importAny(transcript(steps), cfg), cfg)
    .filter((f) => f.check === check)
    .map((f) => `${f.severity}: ${f.message}`);
};
const PW = "export default defineConfig({\n  retries: 0,\n  timeout: 30_000,\n  expect: { timeout: 5000 },\n  use: { actionTimeout: 10 * 1000 },\n});\n";
const RED = ["bash", "npx playwright test", "2 passed, 1 failed"];

test("Playwright: retries, timeouts and an exclusion, compared with the previous version", () => {
  assert.deepEqual(
    found("qa-ts", [
      ["write", "playwright.config.ts", PW],
      RED,
      ["edit", "playwright.config.ts", "  retries: 0,\n  timeout: 30_000,", "  retries: 2,\n  timeout: 120_000,\n  testIgnore: ['**/checkout*'],"],
    ]),
    [
      "high: playwright.config.ts: test config loosened — retries 0 → 2; timeout 30000 → 120000; " +
        "tests excluded “testIgnore: ['**/checkout*'],” — right after a failing run (seq 2)",
    ],
  );
  assert.deepEqual(
    found("qa-ts", [
      ["write", "playwright.config.ts", PW],
      ["edit", "playwright.config.ts", "expect: { timeout: 5000 }", "expect: { timeout: 15000 }"],
    ]),
    ["medium: playwright.config.ts: test config loosened — timeout 5000 → 15000"],
    "the expect timeout, second of two timeouts",
  );
  assert.deepEqual(
    found("qa-ts", [
      ["write", "jest.config.js", "module.exports = { testEnvironment: 'node' };\n"],
      ["write", "jest.config.js", "module.exports = { testEnvironment: 'node', testTimeout: 60000 };\n"],
    ]),
    ["medium: jest.config.js: test config loosened — testTimeout 60000 added"],
  );
});

test("Cypress runMode retries and pytest reruns, timeout and --deselect", () => {
  assert.deepEqual(
    found("qa-cypress", [
      ["write", "cypress.config.ts", "export default defineConfig({ retries: { runMode: 0, openMode: 0 }, defaultCommandTimeout: 4000 });\n"],
      ["write", "cypress.config.ts", "export default defineConfig({ retries: { runMode: 3, openMode: 0 }, defaultCommandTimeout: 20000 });\n"],
    ]),
    ["medium: cypress.config.ts: test config loosened — retries 0 → 3; defaultCommandTimeout 4000 → 20000"],
  );
  assert.deepEqual(
    found("qa-python", [
      ["write", "pytest.ini", "[pytest]\nxfail_strict = true\naddopts = -q\ntimeout = 30\n"],
      ["bash", "pytest", "2 passed, 1 failed"],
      ["write", "pytest.ini", "[pytest]\nxfail_strict = true\naddopts = -q --reruns 2 --deselect tests/test_cart.py::test_discount\ntimeout = 300\n"],
    ]),
    [
      "high: pytest.ini: test config loosened — retries 0 → 2; timeout 30 → 300; " +
        "tests excluded “addopts = -q --reruns 2 --deselect tests/test_cart.py::test_discount” — right after a failing run (seq 2)",
    ],
  );
  assert.deepEqual(found("qa-python", [["write", "pytest.ini", "[pytest]\nxfail_strict = true\n"]], "expected_failure"), [], "pytest.ini is not code");
});

test("a config seen for the first time: only its retries count", () => {
  assert.deepEqual(found("qa-ts", [["write", "playwright.config.ts", PW.replace("retries: 0", "retries: 2")]]), [
    "medium: playwright.config.ts: test config loosened — retries 2",
  ]);
  assert.deepEqual(found("qa-ts", [["write", "playwright.config.ts", PW.replace("retries: 0", "retries: process.env.CI ? 2 : 0")]]), [], "the template");
  assert.deepEqual(found("qa-ts", [["write", "playwright.config.ts", PW.replace("30_000", "120_000")]]), [], "a timeout with nothing to compare");
});

test("not loosened: shorter timeouts, fewer retries, an unrelated change; retries on one test stay sleep_or_skip_added", () => {
  const none = (steps, why) => assert.deepEqual(found("qa-ts", steps), [], why);
  none(
    [
      ["write", "playwright.config.ts", PW],
      ["edit", "playwright.config.ts", "  timeout: 30_000,", "  timeout: 15_000,\n  reporter: 'html',"],
    ],
    "a shorter timeout, a reporter",
  );
  none(
    [
      ["write", "playwright.config.ts", PW.replace("retries: 0", "retries: 2")],
      ["edit", "playwright.config.ts", "retries: 2", "retries: 0"],
    ].slice(1),
    "an edit whose file the session never saw whole: a fragment",
  );
  const onTest = "import { test } from '@playwright/test';\ntest.describe.configure({ retries: 2 });\ntest('total', async () => {});\n";
  assert.deepEqual(found("qa-ts", [["write", "e2e/cart.spec.ts", onTest]]), []);
  assert.deepEqual(found("qa-ts", [["write", "e2e/cart.spec.ts", onTest]], "sleep_or_skip_added"), ["high: e2e/cart.spec.ts: skip / retry added"]);
});
