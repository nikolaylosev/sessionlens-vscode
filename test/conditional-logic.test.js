"use strict";
/* conditional_logic (regex side; ESLint's jest/no-conditional-in-test and the tree-sitter rules replace it where they
   run, see supersedes.test.js): an if, for, while, switch or try on a line of its own inside a test, low, kind branch,
   one finding per test naming the first such line. What must not count: a ternary, a comprehension, a with block, a
   hook or a helper outside a test, the word in a comment or a string.

   Since 0.1.121 (gaps found while writing this file): C#'s foreach, and a loop written as a call, rows.forEach(…) or
   list.ForEach(…). Not read, by design: a branch with no indentation, since in Python a test's block runs on past its
   end into the module's own code (`if __name__ == "__main__":`); until 0.1.121 such a line after a blank one counted. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");

const { Lens } = load();

const found = (profile, file, content) =>
  Lens.runChecks([{ seq: 1, kind: "write", file, new_content: content }], Lens.profile(profile))
    .filter((f) => f.check === "conditional_logic")
    .map((f) => `${f.severity} ${f.kind}: ${f.message}`);
const TS = "e2e/cart.spec.ts",
  PY = "tests/test_cart.py";
const ts = (body, name = "total") => `test("${name}", async ({ page }) => {\n${body}\n});\n`;
const branch = (file, name, line) =>
  `low branch: ${file}: ${name} — branching/loop inside the test “${line}”: more than one path under test (Conditional Test Logic)`;

test("if, for, while, switch and try inside a TypeScript test", () => {
  for (const line of [
    "if (await banner.isVisible()) await banner.click();",
    "for (const row of rows) await expect(row).toBeVisible();",
    "while (await more.isVisible()) await more.click();",
    "switch (kind) { case 1: break; }",
    "try { await pay(); } catch {}",
  ])
    assert.deepEqual(found("qa-ts", TS, ts("  " + line)), [branch(TS, "total", line.slice(0, 50))], line);
});

test("one finding per test, naming the first line; each test on its own", () => {
  assert.deepEqual(found("qa-ts", TS, ts("  if (a) {}\n  for (;;) {}")), [branch(TS, "total", "if (a) {}")]);
  assert.deepEqual(found("qa-ts", TS, ts("  if (a) {}") + ts("  if (b) {}", "second")), [branch(TS, "total", "if (a) {}"), branch(TS, "second", "if (b) {}")]);
});

test("Python, Java and Cypress", () => {
  assert.deepEqual(found("qa-python", PY, "def test_total():\n    if banner.is_visible():\n        banner.click()\n"), [
    branch(PY, "test_total", "if banner.is_visible():"),
  ]);
  assert.deepEqual(found("qa-python", PY, "def test_total():\n    for row in rows:\n        assert row\n"), [branch(PY, "test_total", "for row in rows:")]);
  assert.deepEqual(found("qa-java", "src/test/java/CartTest.java", "@Test\nvoid total() {\n  if (x) { click(); }\n}\n"), [
    branch("src/test/java/CartTest.java", "total", "if (x) { click(); }"),
  ]);
  assert.deepEqual(
    found(
      "qa-cypress",
      "cypress/e2e/cart.cy.ts",
      'it("total", () => {\n  cy.get("x").then(($el) => {\n    if ($el.length) cy.wrap($el).click();\n  });\n});\n',
    ),
    [branch("cypress/e2e/cart.cy.ts", "total", "if ($el.length) cy.wrap($el).click();")],
  );
});

test("not a branch: a ternary, a comprehension, a with block", () => {
  assert.deepEqual(found("qa-ts", TS, ts("  const v = ok ? 1 : 2;")), []);
  assert.deepEqual(found("qa-python", PY, "def test_total():\n    rows = [r for r in rows if r]\n"), []);
  assert.deepEqual(found("qa-python", PY, "def test_total():\n    with open(path) as fh:\n        assert fh.read()\n"), []);
});

test("not inside a test: a hook, a helper", () => {
  assert.deepEqual(found("qa-ts", TS, "test.beforeEach(async ({ page }) => {\n  if (x) await y();\n});\n"), []);
  assert.deepEqual(found("qa-ts", TS, "const helper = () => {\n  if (x) return 1;\n};\n"), []);
});

test("not the word in a comment or a string", () => {
  assert.deepEqual(found("qa-ts", TS, ts("  // if the banner shows, close it")), []);
  assert.deepEqual(found("qa-ts", TS, ts('  await expect(page.getByText("if you need help")).toBeVisible();')), []);
});

test("C#'s foreach and a loop written as a call (0.1.121)", () => {
  const CS = "tests/CartTests.cs";
  assert.deepEqual(found("qa-c#", CS, "[Test]\npublic void Total() {\n  foreach (var r in rows) { Assert.IsTrue(r.Visible); }\n}\n"), [
    branch(CS, "Total", "foreach (var r in rows) { Assert.IsTrue(r.Visible); }".slice(0, 50)),
  ]);
  assert.deepEqual(found("qa-ts", TS, ts("  rows.forEach((r) => expect(r).toBeVisible());")), [
    branch(TS, "total", "rows.forEach((r) => expect(r).toBeVisible());"),
  ]);
  assert.deepEqual(found("qa-c#", CS, "[Test]\npublic void Total() {\n  rows.ForEach(r => Assert.IsTrue(r.Visible));\n}\n"), [
    branch(CS, "Total", "rows.ForEach(r => Assert.IsTrue(r.Visible));"),
  ]);
  // not a loop: a word that only starts with the keyword, a method named like forEach
  assert.deepEqual(found("qa-c#", CS, "[Test]\npublic void Total() {\n  forecast.Refresh();\n  Assert.IsTrue(ok);\n}\n"), []);
  assert.deepEqual(found("qa-ts", TS, ts("  await cart.forEachItem();")), []);
});

test("a Python test's module code after it is not part of the test", () => {
  assert.deepEqual(found("qa-python", PY, 'def test_total():\n    assert total == PRICE\n\nif __name__ == "__main__":\n    main()\n'), []);
});

test("the profiles that run it", () => {
  const profiles = ["qa-ts", "qa-cypress", "qa-detox", "qa-python", "qa-java", "qa-c#", "qa-api", "qa-mobile", "qa-robot", "qa-generic"];
  assert.deepEqual(
    profiles.filter((p) => Lens.profile(p).checks.includes("conditional_logic")),
    ["qa-ts", "qa-cypress", "qa-detox", "qa-python", "qa-java", "qa-c#", "qa-api", "qa-mobile"],
  );
});
