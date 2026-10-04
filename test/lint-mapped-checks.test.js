"use strict";
/* Engine-mapped checks with no regex fallback: positional_locator, no_app_reset, unannotated_test_method,
   swallowed_exception, assert_args_reversed, lint_valid_title; and the engine rules mapped to weak_assert (its regex
   side is in weak-assert.test.js). Real engines, same as supersedes.test.js. Severity and message are pinned too: the
   verdict key includes the start of the message. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { load, M } = require("./helpers");
const { loadEngines } = require("../perf/snapshot-lint");

const { Lens } = load();
const LensLint = require(M("lint.js"));

async function lintFound(profile, file, content, check) {
  await loadEngines();
  const cfg = Lens.profile(profile);
  const lr = LensLint.run({ events: [{ seq: 1, kind: "write", file, new_content: content }] }, cfg, {});
  assert.equal(lr.ran, true, `${profile}: the engine did not parse ${file}: ${lr.note}`);
  return lr.findings.filter((f) => f.check === check).map((f) => `${f.check}/${f.source} ${f.severity}: ${f.message}`);
}

test("positional_locator: Playwright .nth and Detox atIndex", async () => {
  assert.deepEqual(
    await lintFound(
      "qa-ts",
      "e2e/cart.spec.ts",
      "import { test, expect } from '@playwright/test';\ntest('cart', async ({ page }) => {\n  await page.locator('div > span').nth(2).click();\n  await expect(page.getByText('Total')).toBeVisible();\n});\n",
      "positional_locator",
    ),
    ["positional_locator/lint low: e2e/cart.spec.ts:3 — Unexpected use of nth() [playwright/no-nth-methods]"],
  );
  assert.deepEqual(
    await lintFound(
      "qa-detox",
      "e2e/cart.test.js",
      "describe('cart', () => {\n  beforeEach(async () => { await device.reloadReactNative(); });\n  it('opens', async () => {\n    await element(by.text('x')).atIndex(1).tap();\n    await expect(element(by.id('total'))).toBeVisible();\n  });\n});\n",
      "positional_locator",
    ),
    [
      "positional_locator/lint low: e2e/cart.test.js:4 — atIndex(n) used to disambiguate a matcher — prefer a stable by.id(...) matcher instead of a positional pick [detox/no-index-matcher]",
    ],
  );
  assert.deepEqual(
    await lintFound(
      "qa-ts",
      "e2e/cart.spec.ts",
      "import { test, expect } from '@playwright/test';\ntest('cart', async ({ page }) => {\n  await page.getByRole('button', { name: 'Pay' }).click();\n  await expect(page.getByText('Total')).toBeVisible();\n});\n",
      "positional_locator",
    ),
    [],
  );
});

test("no_app_reset: a Detox describe with tests and no reload", async () => {
  assert.deepEqual(
    await lintFound(
      "qa-detox",
      "e2e/app.test.js",
      "describe('app', () => {\n  it('opens', async () => {\n    await element(by.id('go')).tap();\n    await expect(element(by.id('home'))).toBeVisible();\n  });\n});\n",
      "no_app_reset",
    ),
    [
      "no_app_reset/lint medium: e2e/app.test.js:1 — describe block has tests but no beforeEach(device.reloadReactNative()) / launchApp({newInstance:true}) — app state can leak between tests [detox/require-reload-before-each]",
    ],
  );
  assert.deepEqual(
    await lintFound(
      "qa-detox",
      "e2e/app.test.js",
      "describe('app', () => {\n  beforeEach(async () => { await device.reloadReactNative(); });\n  it('opens', async () => {\n    await element(by.id('go')).tap();\n    await expect(element(by.id('home'))).toBeVisible();\n  });\n});\n",
      "no_app_reset",
    ),
    [],
  );
});

test("unannotated_test_method: Java and C# methods that look like tests", async () => {
  assert.deepEqual(
    await lintFound("qa-java", "src/test/java/CartTest.java", "class CartTest {\n  void testRemove() { cart.remove(1); }\n}\n", "unannotated_test_method"),
    [
      "unannotated_test_method/lint high: src/test/java/CartTest.java:2 — testRemove() looks like a test (class CartTest) but has no @Test/lifecycle annotation — the runner will never execute it [java/unannotated-test-method]",
    ],
  );
  assert.deepEqual(
    await lintFound(
      "qa-java",
      "src/test/java/CartTest.java",
      "class CartTest {\n  @Test\n  void testRemove() { assertEquals(0, cart.size()); }\n}\n",
      "unannotated_test_method",
    ),
    [],
  );
  assert.deepEqual(
    await lintFound("qa-c#", "tests/CartTests.cs", "public class CartTests {\n  public void TestRemove() { cart.Remove(1); }\n}\n", "unannotated_test_method"),
    [
      "unannotated_test_method/lint high: tests/CartTests.cs:2 — TestRemove() looks like a test (class CartTests) but has no [Test]/[Fact]/lifecycle attribute — the runner will never execute it [csharp/unannotated-test-method]",
    ],
  );
});

test("swallowed_exception: empty catch / except pass", async () => {
  assert.deepEqual(
    await lintFound(
      "qa-java",
      "src/test/java/CartTest.java",
      "class CartTest {\n  @Test\n  void add() {\n    try { cart.add(1); } catch (Exception e) {}\n    assertEquals(1, cart.size());\n  }\n}\n",
      "swallowed_exception",
    ),
    [
      "swallowed_exception/lint high: src/test/java/CartTest.java:4 — empty catch block — an exception here is silently swallowed and the test passes regardless [java/swallowed-exception]",
    ],
  );
  assert.deepEqual(
    await lintFound(
      "qa-python",
      "tests/test_cart.py",
      "def test_add(cart):\n    try:\n        cart.add(1)\n    except Exception:\n        pass\n    assert cart.size() == 1\n",
      "swallowed_exception",
    ),
    [
      "swallowed_exception/lint high: tests/test_cart.py:4 — except block only does pass/... — an exception here is silently swallowed and the test passes regardless [python/swallowed-exception]",
    ],
  );
  assert.deepEqual(
    await lintFound(
      "qa-java",
      "src/test/java/CartTest.java",
      "class CartTest {\n  @Test\n  void add() {\n    try { cart.add(1); } catch (Exception e) { fail(e.getMessage()); }\n    assertEquals(1, cart.size());\n  }\n}\n",
      "swallowed_exception",
    ),
    [],
  );
});

test("assert_args_reversed: literal in the actual slot", async () => {
  assert.deepEqual(
    await lintFound(
      "qa-java",
      "src/test/java/CartTest.java",
      "class CartTest {\n  @Test\n  void add() {\n    assertEquals(cart.size(), 1);\n  }\n}\n",
      "assert_args_reversed",
    ),
    [
      "assert_args_reversed/lint medium: src/test/java/CartTest.java:4 — assertEquals(cart.size(), 1) — the literal usually goes first (expected), the value under test second (actual); this reads reversed [java/assert-args-reversed]",
    ],
  );
  assert.deepEqual(
    await lintFound(
      "qa-java",
      "src/test/java/CartTest.java",
      "class CartTest {\n  @Test\n  void add() {\n    assertEquals(1, cart.size());\n  }\n}\n",
      "assert_args_reversed",
    ),
    [],
  );
  assert.deepEqual(await lintFound("qa-python", "tests/test_cart.py", "def test_add(self):\n    self.assertEqual(cart.size(), 1)\n", "assert_args_reversed"), [
    "assert_args_reversed/lint medium: tests/test_cart.py:2 — assertEqual(cart.size(), 1) — the literal usually goes first (expected), the value under test second (actual); this reads reversed [python/assert-args-reversed]",
  ]);
});

const PW = 'import { test, expect } from "@playwright/test";\n';

test("lint_valid_title: an empty title or a duplicate prefix (Playwright)", async () => {
  assert.deepEqual(
    await lintFound("qa-ts", "e2e/cart.spec.ts", PW + 'test("", async ({ page }) => {\n  await expect(page).toHaveTitle("Shop");\n});\n', "lint_valid_title"),
    ["lint_valid_title/lint low: e2e/cart.spec.ts:2 — test should not have an empty title [playwright/valid-title]"],
  );
  assert.deepEqual(
    await lintFound(
      "qa-ts",
      "e2e/cart.spec.ts",
      PW + 'test("test shows the title", async ({ page }) => {\n  await expect(page).toHaveTitle("Shop");\n});\n',
      "lint_valid_title",
    ),
    ["lint_valid_title/lint low: e2e/cart.spec.ts:2 — should not have duplicate prefix [playwright/valid-title]"],
  );
  assert.deepEqual(
    await lintFound(
      "qa-ts",
      "e2e/cart.spec.ts",
      PW + 'test("shows the title", async ({ page }) => {\n  await expect(page).toHaveTitle("Shop");\n});\n',
      "lint_valid_title",
    ),
    [],
  );
});

test("weak_assert from the engines: a useless .not, an expect with no matcher, an expect outside a test, a screenshot before any assertion", async () => {
  assert.deepEqual(
    await lintFound(
      "qa-ts",
      "e2e/cart.spec.ts",
      PW + 'test("hidden", async ({ page }) => {\n  await expect(page.getByText("x")).not.toBeVisible();\n});\n',
      "weak_assert",
    ),
    ["weak_assert/lint low: e2e/cart.spec.ts:3 — Unexpected usage of not.toBeVisible(). Use toBeHidden() instead [playwright/no-useless-not]"],
  );
  assert.deepEqual(await lintFound("qa-ts", "e2e/cart.spec.ts", PW + 'test("x", async ({ page }) => {\n  expect(page.getByText("x"));\n});\n', "weak_assert"), [
    "weak_assert/lint medium: e2e/cart.spec.ts:3 — Expect must have a corresponding matcher call [playwright/valid-expect]",
  ]);
  assert.deepEqual(
    await lintFound(
      "qa-ts",
      "e2e/cart.spec.ts",
      PW + 'expect(1).toBe(1);\ntest("x", async ({ page }) => {\n  await expect(page).toHaveTitle("Shop");\n});\n',
      "weak_assert",
    ),
    ["weak_assert/lint medium: e2e/cart.spec.ts:2 — Expect must be inside of a test block [playwright/no-standalone-expect]"],
  );
  assert.deepEqual(
    await lintFound(
      "qa-cypress",
      "cypress/e2e/cart.cy.ts",
      'describe("cart", () => {\n  it("shot", () => {\n    cy.visit("/");\n    cy.screenshot();\n  });\n});\n',
      "weak_assert",
    ),
    ["weak_assert/lint low: cypress/e2e/cart.cy.ts:4 — Make an assertion on the page state before taking a screenshot [cypress/assertion-before-screenshot]"],
  );
});

test("weak_assert from the engines, not reported: toBeHidden(), an awaited matcher inside a test, a screenshot after an assertion", async () => {
  assert.deepEqual(
    await lintFound(
      "qa-ts",
      "e2e/cart.spec.ts",
      PW + 'test("hidden", async ({ page }) => {\n  await expect(page.getByText("x")).toBeHidden();\n});\n',
      "weak_assert",
    ),
    [],
  );
  assert.deepEqual(
    await lintFound(
      "qa-cypress",
      "cypress/e2e/cart.cy.ts",
      'describe("cart", () => {\n  it("shot", () => {\n    cy.visit("/");\n    cy.get("h1").should("have.text", "Shop");\n    cy.screenshot();\n  });\n});\n',
      "weak_assert",
    ),
    [],
  );
});
