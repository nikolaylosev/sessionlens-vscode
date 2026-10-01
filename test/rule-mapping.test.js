"use strict";
/* Phase 10 (rules review), step 0: what each disputed case reports today (duplicates, engine rules filed under
   another check's name, gaps), through the same chain as analyzeNow(): regex checks, Gherkin, the real lint engines,
   LensLint.merge(). Pinned as it is in 0.1.112 plus #27, wrong mappings and gaps included, so every later step of the
   phase shows up as a change of the expected list below.
   A finding is "check/source" (plus "<rule>" for an engine's). Process and method checks are left out: they react to
   the shape of the made-up transcript, not to the case. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { load, M } = require("./helpers");
const { loadEngines } = require("../perf/snapshot-lint");

const { Lens } = load();
const LensLint = require(M("lint.js"));
const IGNORED = new Set(["method", "process", "spec"]);
const C = require(M("checks.js")).CHECKS;

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

function found(profile, steps) {
  const cfg = Lens.profile(profile);
  const res = Lens.importAny(transcript(steps), cfg);
  const events = Array.isArray(res) && res.length && res[0].events ? res[0].events : res;
  const lr = LensLint.run({ events }, cfg, {});
  const formal = Lens.runChecks(events, cfg);
  const base = lr.ran ? LensLint.merge(formal, lr.findings, cfg.language) : formal;
  return [...base, ...Lens.gherkinChecks(events)]
    .filter((f) => !IGNORED.has((C[f.check] || {}).group))
    .map((f) => `${f.check}/${f.source}${f.rule ? " <" + f.rule + ">" : ""}`)
    .sort();
}

const PW = (body) => `import { test, expect } from '@playwright/test';\n${body}\n`;
const CASES = [
  // ---- 1. duplicates ----
  [
    "1a xfail (Python)",
    "qa-python",
    [["write", "tests/test_cart.py", "import pytest\n\n@pytest.mark.xfail(reason='BUG-1')\ndef test_total():\n    assert cart.total() == expected_total\n"]],
  ],
  [
    "1a @Disabled (Java)",
    "qa-java",
    [["write", "src/test/java/CartTest.java", 'class CartTest {\n  @Disabled("BUG-1")\n  @Test\n  void total() { assertTrue(cart.isEmpty()); }\n}\n']],
  ],
  [
    "1a test.fail (Playwright)",
    "qa-ts",
    [["write", "e2e/cart.spec.ts", PW("test('total', async ({ page }) => {\n  test.fail();\n  await expect(page.getByText('Total')).toBeVisible();\n});")]],
  ],
  [
    "1b a test with no expect (Playwright)",
    "qa-ts",
    [["write", "e2e/cart.spec.ts", PW("test('opens the cart', async ({ page }) => {\n  await page.goto('/cart');\n});")]],
  ],
  // ---- 2. engine rules under someone else's name ----
  [
    "2 test.only (Playwright)",
    "qa-ts",
    [["write", "e2e/cart.spec.ts", PW("test.only('total', async ({ page }) => {\n  await expect(page.getByText('Total')).toBeVisible();\n});")]],
  ],
  [
    "2 it.only (Cypress)",
    "qa-cypress",
    [["write", "cypress/e2e/cart.cy.ts", "describe('cart', () => {\n  it.only('total', () => {\n    cy.contains('Total').should('be.visible');\n  });\n});\n"]],
  ],
  [
    "2 page.pause (Playwright)",
    "qa-ts",
    [
      [
        "write",
        "e2e/cart.spec.ts",
        PW("test('total', async ({ page }) => {\n  await page.pause();\n  await expect(page.getByText('Total')).toBeVisible();\n});"),
      ],
    ],
  ],
  [
    "2 cy.pause and cy.debug (Cypress)",
    "qa-cypress",
    [
      [
        "write",
        "cypress/e2e/cart.cy.ts",
        "describe('cart', () => {\n  it('total', () => {\n    cy.pause();\n    cy.contains('Total').debug().should('be.visible');\n  });\n});\n",
      ],
    ],
  ],
  ["2 breakpoint (Python)", "qa-python", [["write", "tests/test_cart.py", "def test_total():\n    breakpoint()\n    assert cart.total() == expected_total\n"]]],
  [
    "2 duplicate hooks (Playwright)",
    "qa-ts",
    [
      [
        "write",
        "e2e/cart.spec.ts",
        PW(
          "test.describe('cart', () => {\n  test.beforeEach(async ({ page }) => { await page.goto('/cart'); });\n  test.beforeEach(async ({ page }) => { await page.goto('/cart'); });\n  test('total', async ({ page }) => {\n    await expect(page.getByText('Total')).toBeVisible();\n  });\n});",
        ),
      ],
    ],
  ],
  [
    "2 nested test.step (Playwright)",
    "qa-ts",
    [
      [
        "write",
        "e2e/cart.spec.ts",
        PW(
          "test('total', async ({ page }) => {\n  await test.step('open', async () => {\n    await test.step('inner', async () => { await page.goto('/cart'); });\n  });\n  await expect(page.getByText('Total')).toBeVisible();\n});",
        ),
      ],
    ],
  ],
  [
    "2 .and() (Cypress)",
    "qa-cypress",
    [["write", "cypress/e2e/cart.cy.ts", "describe('cart', () => {\n  it('total', () => {\n    cy.get('[data-test=total]').and('be.visible');\n  });\n});\n"]],
  ],
  [
    "2 an async test (Cypress)",
    "qa-cypress",
    [
      [
        "write",
        "cypress/e2e/cart.cy.ts",
        "describe('cart', () => {\n  it('total', async () => {\n    await cy.contains('Total').should('be.visible');\n  });\n});\n",
      ],
    ],
  ],
  [
    "2 force: true (Playwright)",
    "qa-ts",
    [
      [
        "write",
        "e2e/cart.spec.ts",
        PW(
          "test('total', async ({ page }) => {\n  await page.getByRole('button', { name: 'Pay' }).click({ force: true });\n  await expect(page.getByText('Paid')).toBeVisible();\n});",
        ),
      ],
    ],
  ],
  // ---- 3. gaps ----
  [
    "3.1 a test deleted (Playwright)",
    "qa-ts",
    [
      [
        "write",
        "e2e/cart.spec.ts",
        PW(
          "test('total', async ({ page }) => {\n  await expect(page.getByText('Total')).toBeVisible();\n});\ntest('discount', async ({ page }) => {\n  await expect(page.getByText('Discount')).toBeVisible();\n});",
        ),
      ],
      ["bash", "npx playwright test", "1 passed, 1 failed"],
      ["edit", "e2e/cart.spec.ts", "test('discount', async ({ page }) => {\n  await expect(page.getByText('Discount')).toBeVisible();\n});", ""],
    ],
  ],
  [
    "3.1 a test file deleted (Playwright)",
    "qa-ts",
    [
      ["write", "e2e/discount.spec.ts", PW("test('discount', async ({ page }) => {\n  await expect(page.getByText('Discount')).toBeVisible();\n});")],
      ["bash", "npx playwright test", "0 passed, 1 failed"],
      ["bash", "rm e2e/discount.spec.ts", ""],
    ],
  ],
  [
    "3.2 product code edited (Playwright)",
    "qa-ts",
    [
      ["write", "e2e/cart.spec.ts", PW("test('total', async ({ page }) => {\n  await expect(page.getByText('Total')).toBeVisible();\n});")],
      ["bash", "npx playwright test", "0 passed, 1 failed"],
      ["edit", "src/cart/total.ts", "return sum - discount;", "return sum;"],
    ],
  ],
  [
    "3.3 snapshots overwritten (Jest)",
    "qa-ts",
    [
      ["bash", "npx jest", "Tests: 1 failed, 2 passed\nSnapshots: 1 failed"],
      ["bash", "npx jest -u", "Tests: 3 passed\nSnapshots: 1 updated"],
    ],
  ],
  [
    "3.4 retries and timeout raised (Playwright config)",
    "qa-ts",
    [["edit", "playwright.config.ts", "retries: 0,\n  timeout: 30000,", "retries: 3,\n  timeout: 120000,"]],
  ],
  [
    "3.5 a token and a host in a UI test (Playwright)",
    "qa-ts",
    [
      [
        "write",
        "e2e/api.spec.ts",
        PW(
          "const token = 'sk_live_51HxQ2bE8aZ0kLmN';\ntest('orders', async ({ page }) => {\n  await page.goto('https://staging.shop-acme.io/orders');\n  await expect(page.getByRole('heading', { name: 'Orders' })).toBeVisible();\n});",
        ),
      ],
    ],
  ],
  [
    "3.5 the same in qa-api",
    "qa-api",
    [
      [
        "write",
        "e2e/api.spec.ts",
        PW(
          "const token = 'sk_live_51HxQ2bE8aZ0kLmN';\ntest('orders', async ({ page }) => {\n  await page.goto('https://staging.shop-acme.io/orders');\n  await expect(page.getByRole('heading', { name: 'Orders' })).toBeVisible();\n});",
        ),
      ],
    ],
  ],
];

// as of 0.1.112 (plus #27): the phase changes this list, case by case
const EXPECTED = {
  "1a xfail (Python)": ["expected_failure/formal", "sleep_or_skip_added/formal"],
  "1a @Disabled (Java)": ["expected_failure/formal", "sleep_or_skip_added/formal"],
  "1a test.fail (Playwright)": ["expected_failure/formal"],
  "1b a test with no expect (Playwright)": ["weak_assert/lint <playwright/expect-expect>"],
  "2 test.only (Playwright)": ["sleep_or_skip_added/lint <playwright/no-focused-test>"],
  "2 it.only (Cypress)": ["sleep_or_skip_added/formal"],
  "2 page.pause (Playwright)": ["fragile_wait/lint <playwright/no-page-pause>"],
  "2 cy.pause and cy.debug (Cypress)": ["fragile_wait/lint <cypress/no-debug>", "sleep_or_skip_added/lint <cypress/no-pause>"],
  "2 breakpoint (Python)": [],
  "2 duplicate hooks (Playwright)": ["duplicate_assert/lint <playwright/no-duplicate-hooks>"],
  "2 nested test.step (Playwright)": ["conditional_logic/lint <playwright/no-nested-step>"],
  "2 .and() (Cypress)": ["conditional_logic/lint <cypress/no-and>"],
  "2 an async test (Cypress)": ["weak_assert/lint <cypress/no-async-tests>"],
  "2 force: true (Playwright)": ["fragile_wait/lint <playwright/no-force-option>"],
  "3.1 a test deleted (Playwright)": [],
  "3.1 a test file deleted (Playwright)": [],
  "3.2 product code edited (Playwright)": [],
  "3.3 snapshots overwritten (Jest)": [],
  "3.4 retries and timeout raised (Playwright config)": ["sleep_or_skip_added/formal"],
  "3.5 a token and a host in a UI test (Playwright)": [],
  "3.5 the same in qa-api": ["hardcoded_base_url/formal", "hardcoded_secret/formal"],
};

test("the rules review cases report what they report in 0.1.112 (phase 10 changes this table)", async () => {
  await loadEngines();
  const got = {};
  for (const [name, profile, steps] of CASES) got[name] = found(profile, steps);
  if (process.env.SL_PRINT_MAPPING) console.log(JSON.stringify(got, null, 2));
  assert.deepEqual(got, EXPECTED);
});
