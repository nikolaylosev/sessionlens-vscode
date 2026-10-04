"use strict";
/* qa-mobile regex: mobile_raw_locator, no_driver_teardown and hardcoded_coordinates. Not pinned here, still open: any
   call whose name starts with tap, swipe, longPress or click counts, so `page.clickRow(15, 30)` is reported, and the
   object form `touchAction({ action: 'tap', x: 120, y: 340 })` is not. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");

const { Lens } = load();

const found = (file, content, check) =>
  Lens.runChecks([{ seq: 1, kind: "write", file, new_content: content }], Lens.profile("qa-mobile"))
    .filter((f) => f.check === check)
    .map((f) => `${f.severity}: ${f.message}`);

test("mobile_raw_locator: XPath / className, not accessibility id", () => {
  assert.deepEqual(
    found("tests/cart.spec.ts", "it('opens', async () => {\n  await driver.findElement(By.xpath('//android.widget.TextView'));\n});\n", "mobile_raw_locator"),
    ["low: tests/cart.spec.ts: 1 locator(s) by XPath/class name — an id or accessibility id survives layout changes"],
  );
  assert.deepEqual(
    found("tests/cart.spec.ts", "it('opens', async () => {\n  await driver.findElement(By.accessibilityId('cart'));\n});\n", "mobile_raw_locator"),
    [],
  );
});

test("no_driver_teardown: new AppiumDriver without quit", () => {
  assert.deepEqual(
    found(
      "tests/cart.spec.ts",
      "it('opens', async () => {\n  const driver = new AppiumDriver(caps);\n  await driver.findElement(By.accessibilityId('cart'));\n});\n",
      "no_driver_teardown",
    ),
    ["medium: tests/cart.spec.ts: creates a driver session with no matching quit()/teardown found"],
  );
  assert.deepEqual(
    found(
      "tests/cart.spec.ts",
      "afterEach(async () => { await driver.quit(); });\nit('opens', async () => {\n  const driver = new AppiumDriver(caps);\n});\n",
      "no_driver_teardown",
    ),
    [],
  );
});

test("hardcoded_coordinates: tap or swipe at literal screen coordinates, the first such line per file", () => {
  assert.deepEqual(
    found("tests/cart.spec.ts", "it('opens', async () => {\n  await driver.tap(120, 340);\n  await driver.tap(10, 20);\n});\n", "hardcoded_coordinates"),
    ["medium: tests/cart.spec.ts: tap/swipe at a literal screen coordinate — await driver.tap(120, 340);"],
  );
  assert.deepEqual(found("tests/test_cart.py", "def test_scroll(driver):\n    driver.swipe(100, 800, 100, 200)\n", "hardcoded_coordinates"), [
    "medium: tests/test_cart.py: tap/swipe at a literal screen coordinate — driver.swipe(100, 800, 100, 200)",
  ]);
});

test("hardcoded_coordinates, not reported: a tap on an element, single-digit arguments, another profile", () => {
  assert.deepEqual(found("tests/cart.spec.ts", "it('opens', async () => {\n  await (await $('~cart')).click();\n});\n", "hardcoded_coordinates"), []);
  assert.deepEqual(found("tests/cart.spec.ts", "it('opens', async () => {\n  await driver.tap(1, 2);\n});\n", "hardcoded_coordinates"), []);
  const ts = Lens.runChecks(
    [{ seq: 1, kind: "write", file: "tests/cart.spec.ts", new_content: "it('opens', async () => {\n  await driver.tap(120, 340);\n});\n" }],
    Lens.profile("qa-ts"),
  );
  assert.deepEqual(
    ts.filter((f) => f.check === "hardcoded_coordinates"),
    [],
    "a qa-mobile check",
  );
});
