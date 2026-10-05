"use strict";
/* focused_test and debug_leftover (regex side; ESLint's playwright, jest, cypress and mocha rules replace them where they
   run, see supersedes.test.js).
   focused_test: .only on a test, a describe, a context or Playwright's test.describe, and Jasmine's fit / fdescribe,
   high, kind only, one finding per file naming the first line.
   debug_leftover: page.pause(), cy.pause(), cy.….debug(), browser.debug(), a `debugger;` statement, Python's
   breakpoint() and pdb / ipdb.set_trace(), medium, one finding per file and kind. Commented out: neither (0.1.121,
   commented-out-code.test.js).

   Detector gaps found while writing this file (5 Oct 2026), not pinned here, for the owner to decide:
   - focused_test: `\bfit\s*\(` matches any call named fit: `model.fit(data)` or `fit (x)` gives a high "focused test";
     `test.only.each([…])(…)` (Jest) is not reported;
   - debug_leftover: `import pdb; pdb.set_trace()` on one line, the usual way to write it, is not reported (the pattern
     wants the call at the start of a line); nor is `if (x) debugger;`; qa-python has no pattern for Playwright's
     `page.pause()`. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");

const { Lens } = load();

const found = (check, profile, file, content) =>
  Lens.runChecks([{ seq: 1, kind: file ? "write" : "message", file, text: "", new_content: content }], Lens.profile(profile))
    .filter((f) => f.check === check)
    .map((f) => `${f.severity} ${f.kind}: ${f.message}`);
const TS = "e2e/cart.spec.ts",
  PY = "tests/test_cart.py",
  CY = "cypress/e2e/cart.cy.ts";
const only = (file, line) => [`high only: ${file}: focused test “${line}” — only it runs, the rest of the suite is silently skipped`];
const debug = (file, kind, what) => `medium ${kind}: ${file}: debugging left in the test “${what}”`;

test("focused_test: .only on a test, a describe, a context, Playwright's test.describe; fit and fdescribe", () => {
  for (const line of [
    'test.only("total", async () => {});',
    'it.only("total", () => {});',
    'describe.only("cart", () => {});',
    'test.describe.only("cart", () => {});',
    'fit("total", () => {});',
    'fdescribe("cart", () => {});',
  ])
    assert.deepEqual(found("focused_test", "qa-ts", TS, line + "\n"), only(TS, line), line);
  assert.deepEqual(found("focused_test", "qa-cypress", CY, 'context.only("cart", () => {});\n'), only(CY, 'context.only("cart", () => {});'));
});

test("focused_test: one finding per file, naming the first line", () => {
  assert.deepEqual(found("focused_test", "qa-ts", TS, 'it.only("a", () => {});\nit.only("b", () => {});\n'), only(TS, 'it.only("a", () => {});'));
});

test("focused_test: not a method named only, not commented out", () => {
  assert.deepEqual(found("focused_test", "qa-ts", TS, "const first = items.only(1);\n"), []);
  assert.deepEqual(found("focused_test", "qa-ts", TS, '// test.only("total", async () => {});\n'), []);
});

test("debug_leftover: Playwright, Cypress, WebdriverIO and a debugger statement, one finding per kind", () => {
  assert.deepEqual(found("debug_leftover", "qa-ts", TS, "  await page.pause();\n"), [debug(TS, "pause", "page.pause(")]);
  assert.deepEqual(found("debug_leftover", "qa-ts", TS, "  debugger;\n"), [debug(TS, "debugger", "debugger;")]);
  assert.deepEqual(found("debug_leftover", "qa-ts", TS, "  await page.pause();\n  debugger;\n  await page.pause();\n"), [
    debug(TS, "pause", "page.pause("),
    debug(TS, "debugger", "debugger;"),
  ]);
  assert.deepEqual(found("debug_leftover", "qa-cypress", CY, "  cy.pause();\n"), [debug(CY, "pause", "cy.pause(")]);
  assert.deepEqual(found("debug_leftover", "qa-cypress", CY, '  cy.get("[data-test=total]").debug();\n'), [debug(CY, "debug", ").debug()")]);
  assert.deepEqual(found("debug_leftover", "qa-mobile", "tests/cart.spec.ts", "  await browser.debug();\n"), [
    debug("tests/cart.spec.ts", "debug", "browser.debug("),
  ]);
});

test("debug_leftover: Python's breakpoint() and pdb / ipdb.set_trace() on a line of their own", () => {
  assert.deepEqual(found("debug_leftover", "qa-python", PY, "def test_total():\n    breakpoint()\n"), [debug(PY, "breakpoint", "breakpoint()")]);
  assert.deepEqual(found("debug_leftover", "qa-python", PY, "def test_total():\n    pdb.set_trace()\n"), [debug(PY, "breakpoint", "pdb.set_trace()")]);
  assert.deepEqual(found("debug_leftover", "qa-python", PY, "def test_total():\n    ipdb.set_trace()\n"), [debug(PY, "breakpoint", "ipdb.set_trace()")]);
});

test("debug_leftover: not a name that contains debugger, not commented out", () => {
  assert.deepEqual(found("debug_leftover", "qa-ts", TS, "const debuggerEnabled = true;\n"), []);
  assert.deepEqual(found("debug_leftover", "qa-ts", TS, "  // await page.pause();\n"), []);
  assert.deepEqual(found("debug_leftover", "qa-python", PY, "def test_total():\n    # breakpoint()\n    pass\n"), []);
});

test("the profiles that run them", () => {
  const profiles = ["qa-ts", "qa-cypress", "qa-detox", "qa-python", "qa-java", "qa-c#", "qa-api", "qa-mobile", "qa-robot", "qa-generic"];
  const run = (c) => profiles.filter((p) => Lens.profile(p).checks.includes(c));
  assert.deepEqual(run("focused_test"), ["qa-ts", "qa-cypress", "qa-detox", "qa-api", "qa-mobile"]);
  assert.deepEqual(run("debug_leftover"), ["qa-ts", "qa-cypress", "qa-detox", "qa-python", "qa-api", "qa-mobile"]);
});
