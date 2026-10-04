"use strict";
/* qa-mobile regex: mobile_raw_locator, no_driver_teardown and hardcoded_coordinates. Until 0.1.119 any call whose name
   started with tap, swipe, longPress or click counted (`page.clickRow(15, 30)`), and the x/y form of a gesture
   (`touchAction({ action: 'tap', x: 120, y: 340 })`, `tap(x=100, y=200)`) was missed. */
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

test("hardcoded_coordinates: the x/y form of a gesture, the gesture APIs of each client", () => {
  const coord = (file, line) => `medium: ${file}: tap/swipe at a literal screen coordinate — ${line.slice(0, 60)}`; // the line is cut at 60
  const F = "tests/cart.spec.ts";
  for (const line of [
    "await driver.touchAction({ action: 'tap', x: 120, y: 340 });",
    "await driver.execute('mobile: clickGesture', { x: 120, y: 340 });",
    "await driver.performActions([{ type: 'pointer', actions: [{ type: 'pointerMove', x: 120, y: 340 }] }]);",
  ])
    assert.deepEqual(found(F, `it('opens', async () => {\n  ${line}\n});\n`, "hardcoded_coordinates"), [coord(F, line)], line);
  const P = "tests/test_cart.py";
  for (const line of [
    "TouchAction(driver).tap(x=100, y=200).perform()",
    "driver.tap([(100, 200)])",
    "actions.w3c_actions.pointer_action.move_to_location(100, 200)",
  ])
    assert.deepEqual(found(P, `def test_open(driver):\n    ${line}\n`, "hardcoded_coordinates"), [coord(P, line)], line);
  const J = "src/test/java/CartTest.java";
  const line = "new TouchAction(driver).press(PointOption.point(100, 200)).release().perform();";
  assert.deepEqual(found(J, `class CartTest {\n  @Test\n  void open() {\n    ${line}\n  }\n}\n`, "hardcoded_coordinates"), [coord(J, line)]);
});

test("hardcoded_coordinates, not reported: a method that only starts with click or tap, x/y outside a gesture", () => {
  const F = "tests/cart.spec.ts";
  assert.deepEqual(found(F, "it('opens', async () => {\n  await page.clickRow(15, 30);\n  await list.tapItemAt(12, 40);\n});\n", "hardcoded_coordinates"), []);
  assert.deepEqual(found(F, "it('layout', async () => {\n  expect(await badge.getLocation()).toEqual({ x: 12, y: 40 });\n});\n", "hardcoded_coordinates"), []);
});
