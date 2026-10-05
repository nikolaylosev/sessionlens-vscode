"use strict";
/* focused_test and debug_leftover (regex side; ESLint's playwright, jest, cypress and mocha rules replace them where they
   run, see supersedes.test.js).
   focused_test: .only on a test, a describe, a context or Playwright's test.describe, and Jasmine's fit / fdescribe,
   high, kind only, one finding per file naming the first line.
   debug_leftover: page.pause(), cy.pause(), cy.….debug(), browser.debug(), a `debugger;` statement, Python's
   breakpoint() and pdb / ipdb.set_trace(), medium, one finding per file and kind. Commented out: neither (0.1.121,
   commented-out-code.test.js).

   Since 0.1.121 (gaps found while writing this file): .only.each; fit / fdescribe only as a call with a title, not a
   method named fit (model.fit(data) gave a high finding); a debugger statement or a pdb call after ";", ")" or "{" on
   its line (`import pdb; pdb.set_trace()` was missed); Playwright's page.pause() in qa-python. */
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

test("focused_test since 0.1.121: .only.each; fit only with a title, not a method named fit", () => {
  assert.deepEqual(
    found("focused_test", "qa-ts", TS, 'test.only.each([1, 2])("total %i", () => {});\n'),
    only(TS, 'test.only.each([1, 2])("total %i", () => {});'),
  );
  assert.deepEqual(found("focused_test", "qa-ts", TS, 'it.only.each`a | b`("x", () => {});\n'), only(TS, 'it.only.each`a | b`("x", () => {});'));
  assert.deepEqual(found("focused_test", "qa-ts", TS, "const curve = model.fit(data);\n"), []);
  assert.deepEqual(found("focused_test", "qa-ts", TS, "const curve = fit (points);\n"), []);
  assert.deepEqual(found("focused_test", "qa-ts", TS, "fit(`total`, () => {});\n"), only(TS, "fit(`total`, () => {});"));
});

test("debug_leftover since 0.1.121: after ; ) or { on the line, and page.pause() in Python", () => {
  assert.deepEqual(found("debug_leftover", "qa-python", PY, "def test_total():\n    import pdb; pdb.set_trace()\n"), [
    debug(PY, "breakpoint", "pdb.set_trace()"),
  ]);
  assert.deepEqual(found("debug_leftover", "qa-ts", TS, "  if (total === 0) debugger;\n"), [debug(TS, "debugger", "debugger;")]);
  assert.deepEqual(found("debug_leftover", "qa-ts", TS, "  page.on('load', () => { debugger; });\n"), [debug(TS, "debugger", "debugger;")]);
  assert.deepEqual(found("debug_leftover", "qa-python", PY, "def test_total(page):\n    page.pause()\n"), [debug(PY, "pause", "page.pause(")]);
  assert.deepEqual(found("debug_leftover", "qa-python", PY, "def test_total(cart):\n    cart.breakpoint()\n    debugger.attach()\n"), [], "a method, a name");
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
