"use strict";
/* The two specification checks that calibration can hide: test_without_requirement (a test that names no requirement,
   when the specification has explicit IDs) and out_of_scope_tested (a test that touches an item of the "Out of scope"
   section). Both medium, at the last step that wrote code, source "spec". What must not count: tests that name their
   requirement in the title or in a comment above, a specification without IDs, no out-of-scope section, tests that
   never touch an out-of-scope item. Since 0.1.119 out_of_scope_tested takes an item's first two words longer than
   four letters that are not common words and do not appear in a requirement, and finds them as words (at a word's
   start): one in the test's name is enough, its body needs all of them. Until then any of them anywhere, as a
   substring, counted: "#overflows" matched "Refund flows". */
const test = require("node:test");
const assert = require("node:assert/strict");
const { load, M } = require("./helpers");

load();
const LensSpec = require(M("spec.js"));

const found = (spec, code, check) =>
  LensSpec.checks(LensSpec.parse(spec), [{ seq: 1, kind: "write", file: "e2e/cart.spec.ts", new_content: code }], "typescript")
    .findings.filter((f) => f.check === check)
    .map((f) => `${f.severity}: ${f.message}`);
const findings = (spec, code) =>
  LensSpec.checks(LensSpec.parse(spec), [{ seq: 1, kind: "write", file: "e2e/cart.spec.ts", new_content: code }], "typescript").findings;

const SPEC = "## Requirements\nR1. The cart shows the total\nR2. An empty cart shows a hint\n\n## Out of scope\n- Payment by PayPal\n";
const t = (name) => `test("${name}", async () => {\n  expect(x).toBe(1);\n});\n`;

test("test_without_requirement: a test that names no requirement of a specification with IDs", () => {
  const f = findings(SPEC, t("R1 total") + t("R2 empty hint") + t("shows the logo")).filter((x) => x.check === "test_without_requirement");
  assert.deepEqual(
    f.map((x) => `${x.severity}: ${x.message}`),
    ["medium: Test shows the logo references no requirement — what does it check?"],
  );
  assert.equal(f[0].source, "spec");
});

test("test_without_requirement, not reported: an ID in the title or in a comment above, a specification without IDs", () => {
  assert.deepEqual(found(SPEC, t("R1 total") + t("R2 empty hint"), "test_without_requirement"), []);
  assert.deepEqual(found(SPEC, t("R1 total") + "// R2\n" + t("empty hint"), "test_without_requirement"), []);
  assert.deepEqual(
    found("The cart shows the total\nAn empty cart shows a hint\n", t("total") + t("empty"), "test_without_requirement"),
    [],
    "numbered automatically: no test can name them",
  );
});

test("out_of_scope_tested: a test of an out-of-scope item, in English or Russian", () => {
  assert.deepEqual(found(SPEC, t("R1 total") + t("R2 empty hint") + t("R1 pays with PayPal"), "out_of_scope_tested"), [
    "medium: There is a test for something explicitly out of scope: “Payment by PayPal”",
  ]);
  assert.deepEqual(
    found(SPEC + "- Loyalty points\n", t("R1 total") + t("R2 shows the loyalty badge"), "out_of_scope_tested"),
    ["medium: There is a test for something explicitly out of scope: “Loyalty points”"],
    "one of the item's first two long words is enough",
  );
  const ru = "## Требования\nR1. Корзина показывает сумму\n\n## Вне scope\n- Оплата через PayPal\n";
  assert.deepEqual(found(ru, t("R1 сумма") + t("R1 оплата через PayPal"), "out_of_scope_tested"), [
    "medium: There is a test for something explicitly out of scope: “Оплата через PayPal”",
  ]);
});

test("out_of_scope_tested, not reported: tests that stay in scope, no out-of-scope section", () => {
  assert.deepEqual(found(SPEC, t("R1 total") + t("R2 empty hint"), "out_of_scope_tested"), []);
  assert.deepEqual(found("## Requirements\nR1. The cart shows the total\n", t("R1 total"), "out_of_scope_tested"), []);
});

test("out_of_scope_tested, not reported: a keyword inside another word, one keyword in a body, a keyword the requirements use", () => {
  const body = (name, line) => `test("${name}", async () => {\n  ${line}\n});\n`;
  const oos = "## Requirements\nR1. The cart shows the total\n\n## Out of scope\n- Refund flows\n- Payment by PayPal\n";
  assert.deepEqual(found(oos, body("R1 total", 'await page.click("#overflows");'), "out_of_scope_tested"), [], '"flows" inside "overflows"');
  assert.deepEqual(
    found(oos, body("R1 total", 'await expect(page.getByText("Payment")).toBeVisible();'), "out_of_scope_tested"),
    [],
    "one of two keywords in the body",
  );
  assert.deepEqual(
    found(oos, body("R1 total", 'await page.getByText("Payment").click(); // PayPal button'), "out_of_scope_tested"),
    ["medium: There is a test for something explicitly out of scope: “Payment by PayPal”"],
    "both keywords in the body",
  );
  const inScope = "## Requirements\nR1. The payment total is shown\n\n## Out of scope\n- Payment by PayPal\n";
  assert.deepEqual(found(inScope, t("R1 payment total"), "out_of_scope_tested"), [], '"payment" is a word of R1');
  assert.deepEqual(found(inScope, t("R1 pays with PayPal"), "out_of_scope_tested"), [
    "medium: There is a test for something explicitly out of scope: “Payment by PayPal”",
  ]);
  const ru = "## Требования\nR1. Корзина показывает сумму\n\n## Вне scope\n- Доставка через курьера\n";
  assert.deepEqual(found(ru, t("R1 сумма через минуту"), "out_of_scope_tested"), [], '"через" is a common word, not a keyword');
});
