"use strict";
/* Engine-mapped checks with no regex fallback: positional_locator, no_app_reset, unannotated_test_method,
   swallowed_exception, assert_args_reversed, lint_valid_title, raw_locator, no_assertion_after_action,
   cypress_async_test, empty_test_case; and the engine rules mapped to weak_assert (its regex side is in
   weak-assert.test.js). Real engines, same as supersedes.test.js. Severity and message are pinned too: the verdict key
   includes the start of the message.

   Robot's assertions: see the test of that name (0.1.121; until then only a keyword that started with Should or Must
   counted). eslint-plugin-cypress's no-async-before (vendored, not changed here) reports only a hook with a title,
   `before("load", async () => …)`; the regex cypress_async_test finds the untitled one and after / afterEach (0.1.121,
   the cypress_async_test cases below). */
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

test("raw_locator: a CSS locator in Playwright; chained get, xpath and a class selector in Cypress", async () => {
  assert.deepEqual(
    await lintFound(
      "qa-ts",
      "e2e/cart.spec.ts",
      PW +
        'test("total", async ({ page }) => {\n  await page.locator(".cart > .total").click();\n  await expect(page.getByText("Total")).toBeVisible();\n});\n',
      "raw_locator",
    ),
    [
      "raw_locator/lint low: e2e/cart.spec.ts:3 — Usage of raw locator detected. Use methods like .getByRole() or .getByText() instead of raw locators [playwright/no-raw-locators]",
    ],
  );
  const CY = "cypress/e2e/cart.cy.ts";
  assert.deepEqual(await lintFound("qa-cypress", CY, 'it("total", () => {\n  cy.get(".cart").get(".total").should("contain", "42");\n});\n', "raw_locator"), [
    "raw_locator/lint low: cypress/e2e/cart.cy.ts:2 — Avoid chaining multiple cy.get() calls [cypress/no-chained-get]",
    "raw_locator/lint low: cypress/e2e/cart.cy.ts:2 — use data-* attribute selectors instead of classes or tag names [cypress/require-data-selectors]",
  ]);
  assert.deepEqual(await lintFound("qa-cypress", CY, 'it("total", () => {\n  cy.xpath("//div[@id=total]").should("contain", "42");\n});\n', "raw_locator"), [
    "raw_locator/lint low: cypress/e2e/cart.cy.ts:2 — cy.xpath() is deprecated and unsupported. Consider using cy.get() with appropriate selectors instead [cypress/no-xpath]",
  ]);
  // not reported: a role in Playwright, a data-* selector in Cypress
  assert.deepEqual(
    await lintFound(
      "qa-ts",
      "e2e/cart.spec.ts",
      PW +
        'test("total", async ({ page }) => {\n  await page.getByRole("button", { name: "Pay" }).click();\n  await expect(page.getByText("Paid")).toBeVisible();\n});\n',
      "raw_locator",
    ),
    [],
  );
  assert.deepEqual(await lintFound("qa-cypress", CY, 'it("total", () => {\n  cy.get("[data-test=total]").should("contain", "42");\n});\n', "raw_locator"), []);
});

test("no_assertion_after_action: a test with actions and no assertion, in Playwright, Detox, Java, C# and Robot", async () => {
  assert.deepEqual(
    await lintFound(
      "qa-ts",
      "e2e/cart.spec.ts",
      PW + 'test("total", async ({ page }) => {\n  await page.getByRole("button", { name: "Pay" }).click();\n});\n',
      "no_assertion_after_action",
    ),
    ["no_assertion_after_action/lint high: e2e/cart.spec.ts:2 — Test has no assertions [playwright/expect-expect]"],
  );
  assert.deepEqual(
    await lintFound(
      "qa-detox",
      "e2e/cart.test.js",
      'describe("cart", () => {\n  beforeEach(async () => { await device.reloadReactNative(); });\n  it("pays", async () => {\n    await element(by.id("pay")).tap();\n  });\n});\n',
      "no_assertion_after_action",
    ),
    [
      "no_assertion_after_action/lint high: e2e/cart.test.js:3 — Test performs actions (tap/typeText/swipe/…) but has no expect(...) anywhere — nothing is actually verified [detox/expect-after-action]",
    ],
  );
  assert.deepEqual(
    await lintFound(
      "qa-java",
      "src/test/java/CartTest.java",
      "import org.junit.jupiter.api.Test;\nclass CartTest {\n  @Test\n  void pays() {\n    page.getByRole(AriaRole.BUTTON).click();\n  }\n}\n",
      "no_assertion_after_action",
    ),
    [
      "no_assertion_after_action/lint high: src/test/java/CartTest.java:3 — pays() calls other code but has no assert*(...) anywhere in its body — nothing is actually verified [java/no-assertion-after-action]",
    ],
  );
  assert.deepEqual(
    await lintFound(
      "qa-c#",
      "tests/CartTests.cs",
      "public class CartTests {\n  [Test]\n  public async Task Pays() {\n    await Page.GetByRole(AriaRole.Button).ClickAsync();\n  }\n}\n",
      "no_assertion_after_action",
    ),
    [
      "no_assertion_after_action/lint high: tests/CartTests.cs:2 — Pays() calls other code but has no assertion (Assert.*/\u200b.Should()) anywhere in its body — nothing is actually verified [csharp/no-assertion-after-action]",
    ],
  );
  assert.deepEqual(await lintFound("qa-robot", "tests/cart.robot", "*** Test Cases ***\nPays\n    Click Button    pay\n", "no_assertion_after_action"), [
    "no_assertion_after_action/lint high: tests/cart.robot:2 — Pays: has steps but none of them is a Should */Must * keyword — nothing is actually verified [robot/no-assertion-after-action]",
  ]);
  // not reported: an assertion after the action
  assert.deepEqual(
    await lintFound(
      "qa-ts",
      "e2e/cart.spec.ts",
      PW +
        'test("total", async ({ page }) => {\n  await page.getByRole("button", { name: "Pay" }).click();\n  await expect(page.getByText("Paid")).toBeVisible();\n});\n',
      "no_assertion_after_action",
    ),
    [],
  );
  assert.deepEqual(
    await lintFound(
      "qa-robot",
      "tests/cart.robot",
      "*** Test Cases ***\nPays\n    Click Button    pay\n    Should Be Equal    ${status}    paid\n",
      "no_assertion_after_action",
    ),
    [],
  );
});

test("cypress_async_test: an async test, and an async hook with a title", async () => {
  const CY = "cypress/e2e/cart.cy.ts";
  assert.deepEqual(
    await lintFound("qa-cypress", CY, 'it("total", async () => {\n  cy.get("[data-test=total]").should("contain", "42");\n});\n', "cypress_async_test"),
    ["cypress_async_test/lint medium: cypress/e2e/cart.cy.ts:1 — Avoid using async functions with Cypress tests [cypress/no-async-tests]"],
  );
  assert.deepEqual(
    await lintFound(
      "qa-cypress",
      CY,
      'before("load", async () => {\n  cy.visit("/");\n});\nit("total", () => {\n  cy.get("[data-test=total]").should("contain", "42");\n});\n',
      "cypress_async_test",
    ),
    [
      "cypress_async_test/lint medium: cypress/e2e/cart.cy.ts:1 — Avoid using async functions with Cypress before / beforeEach functions [cypress/no-async-before]",
    ],
  );
  assert.deepEqual(
    await lintFound("qa-cypress", CY, 'it("total", () => {\n  cy.get("[data-test=total]").should("contain", "42");\n});\n', "cypress_async_test"),
    [],
  );
});

test("empty_test_case: a Robot test case with no steps, or only settings", async () => {
  assert.deepEqual(
    await lintFound(
      "qa-robot",
      "tests/cart.robot",
      "*** Test Cases ***\nEmpty Case\n\nPays\n    Click Button    pay\n    Should Be Equal    ${status}    paid\n",
      "empty_test_case",
    ),
    ["empty_test_case/lint high: tests/cart.robot:2 — Empty Case: no steps at all — an empty test case [robot/empty-test-case]"],
  );
  assert.deepEqual(await lintFound("qa-robot", "tests/cart.robot", "*** Test Cases ***\nOnly Docs\n    [Documentation]    nothing here\n", "empty_test_case"), [
    "empty_test_case/lint high: tests/cart.robot:2 — Only Docs: no steps at all — an empty test case [robot/empty-test-case]",
  ]);
  assert.deepEqual(
    await lintFound(
      "qa-robot",
      "tests/cart.robot",
      "*** Keywords ***\nOpen Cart\n\n*** Test Cases ***\nPays\n    Open Cart\n    Should Be Equal    ${a}    ${b}\n",
      "empty_test_case",
    ),
    [],
    "an empty keyword is not a test",
  );
});

test("no_assertion_after_action in Robot: the assertions of BuiltIn, SeleniumLibrary, Browser and the file's own keywords (0.1.121)", async () => {
  const R = "tests/cart.robot";
  const pays = (step, more = "") => `*** Test Cases ***\nPays\n    Click Button    pay\n    ${step}\n${more}`;
  for (const step of [
    "Page Should Contain    Paid",
    "Element Should Be Visible    id=paid",
    "Title Should Be    Shop",
    "SeleniumLibrary.Element Text Should Be    id=total    42",
    "Wait Until Page Contains    Paid",
    "Run Keyword And Expect Error    *    Pay Again",
    "Get Text    id=total    ==    42",
    "${total}=    Get Text    id=total    contains    42",
    "Verify Cart Total    42",
    "SeleniumLibrary.Wait Until Page Contains    Paid",
    "${error}=    Run Keyword And Expect Error    *    Pay Again",
  ])
    assert.deepEqual(await lintFound("qa-robot", R, pays(step), "no_assertion_after_action"), [], step);
  // the file's own keyword, with an assertion inside, through another keyword
  assert.deepEqual(
    await lintFound(
      "qa-robot",
      R,
      pays(
        "Order Is Paid",
        "\n*** Keywords ***\nOrder Is Paid\n    Status Is    paid\nStatus Is\n    [Arguments]    ${s}\n    Should Be Equal    ${status}    ${s}\n",
      ),
      "no_assertion_after_action",
    ),
    [],
  );
  const none = [
    "no_assertion_after_action/lint high: tests/cart.robot:2 — Pays: has steps but none of them is a Should */Must * keyword — nothing is actually verified [robot/no-assertion-after-action]",
  ];
  // still reported: actions only, a Get without an operator, an own keyword with no assertion, a keyword that calls itself
  assert.deepEqual(await lintFound("qa-robot", R, pays("Input Text    id=card    4242"), "no_assertion_after_action"), none);
  assert.deepEqual(await lintFound("qa-robot", R, pays("${t}=    Get Text    id=total"), "no_assertion_after_action"), none);
  assert.deepEqual(
    await lintFound("qa-robot", R, pays("Open Cart", "\n*** Keywords ***\nOpen Cart\n    Go To    /cart\n    Open Cart\n"), "no_assertion_after_action"),
    none,
  );
});

test("cypress_async_test from the regex: the hooks the engine misses, never one it finds (0.1.121)", async () => {
  const CY = "cypress/e2e/cart.cy.ts";
  const IT = 'it("total", () => {\n  cy.get("[data-test=total]").should("contain", "42");\n});\n';
  const regex = (code) =>
    Lens.runChecks([{ seq: 1, kind: "write", file: CY, new_content: code }], Lens.profile("qa-cypress"))
      .filter((f) => f.check === "cypress_async_test")
      .map((f) => `${f.severity}: ${f.message}`);
  const hook = (line) => [`medium: ${CY}: async Cypress hook “${line}” — Cypress queues its commands, so an async hook runs out of order`];
  for (const line of ["before(async () => {", "beforeEach(async function () {", "after(async () => {", 'afterEach("clean up", async () => {'])
    assert.deepEqual(regex(`${line}\n  cy.visit("/");\n});\n` + IT), hook(line), line);
  // the engine's: a titled before / beforeEach, an async it()
  for (const code of [`before("load", async () => {\n  cy.visit("/");\n});\n` + IT, 'it("total", async () => {\n  cy.visit("/");\n});\n'])
    assert.deepEqual(regex(code), [], code);
  // not async, or commented out
  assert.deepEqual(regex(`beforeEach(() => {\n  cy.visit("/");\n});\n// before(async () => {});\n` + IT), []);
  // with the engine on: an untitled hook is found once, by the regex; a titled one once, by the engine
  await loadEngines();
  const both = (code) => {
    const ev = [{ seq: 1, kind: "write", file: CY, new_content: code }];
    const lint = LensLint.run({ events: ev }, Lens.profile("qa-cypress"), {});
    assert.equal(lint.ran, true);
    return LensLint.merge(Lens.runChecks(ev, Lens.profile("qa-cypress")), lint.findings, "cypress")
      .filter((f) => f.check === "cypress_async_test")
      .map((f) => f.source);
  };
  assert.deepEqual(both(`before(async () => {\n  cy.visit("/");\n});\n` + IT), ["formal"]);
  assert.deepEqual(both(`before("load", async () => {\n  cy.visit("/");\n});\n` + IT), ["lint"]);
});
