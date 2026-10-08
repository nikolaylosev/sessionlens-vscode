"use strict";
/* 0.1.124: a finding's text that quotes a line of code, a command or what the person wrote cuts it at a word and ends
   it with "…" (Lens.clip). Until then about eighteen of them cut it with slice(), mid-word and with no sign of the cut:
   "{ x: 120, y: 34" read like a coordinate. The break is the last one between a word and what is not a word, not only
   a space, so a line of code keeps as much as fits. Made-up content only. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const { load, M } = require("./helpers");

const { Lens } = load();
const LensSpec = require(M("spec.js"));
const cfg = Lens.profile("qa-ts");

test("clip: a text that fits stays; a longer one ends at a word with …, never longer than the limit", () => {
  const c = Lens.clip;
  assert.equal(c("short", 10), "short");
  assert.equal(c("x".repeat(10), 10), "x".repeat(10), "exactly the limit");
  assert.equal(c("if (await banner.isVisible()) await banner.click();", 50), "if (await banner.isVisible()) await banner.click…", "the open bracket goes");
  assert.equal(
    c("await driver.execute('mobile: clickGesture', { x: 120, y: 340 });", 60),
    "await driver.execute('mobile: clickGesture', { x: 120, y…",
    "not y: 34",
  );
  assert.equal(c("The agent rewrote the whole checkout flow and then said everything passes", 40), "The agent rewrote the whole checkout…");
  assert.equal(c("Привет, это совсем не то, что я просил сделать", 30), "Привет, это совсем не то, что…", "letters of any alphabet are a word");
  assert.equal(c("a".repeat(30), 20), "a".repeat(19) + "…", "one long word: cut where it is");
  for (let n = 10; n < 60; n += 7) {
    const out = c("expect(page.getByRole('button', { name: 'Checkout' })).toBeVisible()", n);
    assert.ok(out.length <= n, `${n}: ${out}`);
    assert.ok(out.endsWith("…"), out);
  }
});

test("no finding text is cut with slice() any more (lens.js, spec.js)", () => {
  for (const f of ["lens.js", "spec.js"]) {
    const src = fs.readFileSync(M(f), "utf8");
    // a value of a T("…", { … }) cut with slice(0, n) and used as it is
    const bad = [...src.matchAll(/T\("[^"]+", \{[^}]*?\.slice\(0, \d+\)\s*[,}]/g)].map((m) => m[0]);
    assert.deepEqual(bad, [], f);
  }
});

test("the checks: a long line, a long request and a long requirement end with … at a word", () => {
  const long = "  expect(theCheckoutSummaryTotalAmountWithDiscountAndTaxesAfterTheCouponCode).toBeDefined();\n";
  const code = "import { test, expect } from '@playwright/test';\ntest('total', async ({ page }) => {\n" + long + "});\n";
  const weak = Lens.runChecks([{ seq: 1, kind: "write", file: "e2e/cart.spec.ts", new_content: code }], cfg).find((f) => f.check === "weak_assert");
  assert.match(weak.message, /“expect\(theCheckoutSummaryTotalAmountWithDiscountAndTaxesAfterTheCouponCode\)…”/);

  const ask = "Please do not touch the product code at all, only write the tests for the discount on the cart total";
  const users = [ask, ask].map((text, i) => ({ seq: i + 1, kind: "user", text }));
  const rep = Lens.runChecks(users, cfg).find((f) => f.check === "user_frustration");
  assert.equal(rep.message, "User repeated the same request: “Please do not touch the product code at all, only write the tests for the…”");

  const spec = "## Requirements\nR1. The cart shows the total with the discount applied after the coupon code is entered at checkout\n";
  const [unc] = LensSpec.checks(
    LensSpec.parse(spec),
    [{ seq: 1, kind: "write", file: "e2e/a.spec.ts", new_content: "test('x', () => {});\n" }],
    "typescript",
  ).findings.filter((f) => f.check === "spec_uncovered");
  assert.match(unc.message, /“The cart shows the total with the discount applied after the coupon code is entered at…”$/);
});

test("a verdict on a finding cut the old way stays with it", () => {
  const long = "  expect(theCheckoutSummaryTotalAmountWithDiscountAndTaxesAfterTheCouponCode).toBeDefined();\n";
  const code = "import { test, expect } from '@playwright/test';\ntest('total', async ({ page }) => {\n" + long + "});\n";
  const findings = Lens.runChecks([{ seq: 1, kind: "write", file: "e2e/cart.spec.ts", new_content: code }], cfg);
  const now = findings.find((f) => f.check === "weak_assert");
  const before = Object.assign({}, now, { message: now.message.replace(/“[^”]*”/, `“${long.trim().slice(0, 80)}”`) });
  const s = { findings, verdicts: { [Lens.fkey(before)]: { v: "ok", note: "seen" } } };
  Lens.carryVerdicts(s);
  assert.equal(s.verdicts[Lens.fkey(now)].note, "seen");
});
