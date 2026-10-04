"use strict";
/* qa-mobile regex: mobile_raw_locator and no_driver_teardown. hardcoded_coordinates already has cases in
   rule-mapping; these two did not. */
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
