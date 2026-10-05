"use strict";
/* Commented-out code gives no finding in the checks that look for a pattern anywhere in a file (0.1.121): a sleep, a
   skip, .only, a debugger call, networkidle, a mock, a raw mobile locator, coordinates, a driver without teardown and
   test.fail() that are commented out never run. Each case has its live twin, which is still reported. What stays code:
   "#" and "//" inside a string, a URL, and Python's // (floor division). Assertion checks skip comments since 0.1.120. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");

const { Lens } = load();

const checks = (profile, file, content) => [
  ...new Set(Lens.runChecks([{ seq: 1, kind: file ? "write" : "message", file, text: "", new_content: content }], Lens.profile(profile)).map((f) => f.check)),
];
const TS = "e2e/cart.spec.ts",
  PY = "tests/test_cart.py";

// [check, profile, file, live code, the same code commented out]
const CASES = [
  ["sleep_or_skip_added", "qa-ts", TS, "  await page.waitForTimeout(2000);", "  // await page.waitForTimeout(2000);"],
  ["sleep_or_skip_added", "qa-ts", TS, 'test.skip("total", async () => {});', '/* test.skip("total", async () => {}); */'],
  ["sleep_or_skip_added", "qa-ts", TS, "test.describe.configure({ retries: 2 });", "/*\n * test.describe.configure({ retries: 2 });\n */"],
  ["sleep_or_skip_added", "qa-python", PY, "    time.sleep(2)", "    # time.sleep(2)"],
  ["fragile_wait", "qa-ts", TS, '  await page.goto("/", { waitUntil: "networkidle" });', '  // await page.goto("/", { waitUntil: "networkidle" });'],
  ["focused_test", "qa-ts", TS, 'test.only("total", async () => {});', '// test.only("total", async () => {});'],
  ["debug_leftover", "qa-ts", TS, "  await page.pause();", "  // await page.pause();"],
  ["debug_leftover", "qa-python", PY, "    breakpoint()", "    # breakpoint()"],
  ["expected_failure", "qa-ts", TS, "  test.fail();", "  // test.fail();"],
  [
    "mocked_service",
    "qa-api",
    "tests/cart.test.ts",
    '  nock("https://api.shop.io").get("/cart").reply(200, {});',
    '  // nock("https://api.shop.io").get("/cart").reply(200, {});',
  ],
  [
    "mobile_raw_locator",
    "qa-mobile",
    "tests/cart.spec.ts",
    '  await driver.$("//android.widget.Button").click();',
    '  // await driver.$("//android.widget.Button").click();',
  ],
  ["hardcoded_coordinates", "qa-mobile", "tests/cart.spec.ts", "  await driver.tap(120, 340);", "  // await driver.tap(120, 340);"],
  [
    "no_driver_teardown",
    "qa-mobile",
    "tests/test_cart.py",
    '    driver = webdriver.Remote("http://127.0.0.1:4723", options=opts)',
    '    # driver = webdriver.Remote("http://127.0.0.1:4723", options=opts)',
  ],
];

for (const [check, profile, file, live, commented] of CASES)
  test(`${check} (${profile}): the live line is reported, the commented-out one is not`, () => {
    const wrap = (body) => (file.endsWith(".py") ? `def test_total():\n${body}\n` : `test("total", async ({ page }) => {\n${body}\n});\n`);
    assert.ok(checks(profile, file, wrap(live)).includes(check), "live: " + live);
    assert.ok(!checks(profile, file, wrap(commented)).includes(check), "commented out: " + commented);
  });

test("a commented-out teardown does not count as one: the driver is still reported", () => {
  const create = 'def test_total():\n    driver = webdriver.Remote("http://127.0.0.1:4723", options=opts)\n';
  assert.ok(checks("qa-mobile", "tests/test_cart.py", create + "    # driver.quit()\n").includes("no_driver_teardown"));
  assert.ok(!checks("qa-mobile", "tests/test_cart.py", create + "    driver.quit()\n").includes("no_driver_teardown"));
});

test("still code: # and // inside a string, a URL, a trailing comment after the call", () => {
  const ts = (body) => `test("total", async ({ page }) => {\n${body}\n});\n`;
  assert.ok(checks("qa-ts", TS, ts('  const total = page.locator("#total // x"); await page.waitForTimeout(2000);')).includes("sleep_or_skip_added"));
  assert.ok(checks("qa-ts", TS, ts('  await page.goto("https://shop.io", { waitUntil: "networkidle" });')).includes("fragile_wait"));
  assert.ok(checks("qa-ts", TS, ts("  await page.waitForTimeout(2000); // the banner")).includes("sleep_or_skip_added"));
  assert.ok(checks("qa-ts", TS, ts("  /* the banner */ await page.waitForTimeout(2000);")).includes("sleep_or_skip_added"), "after a closed block comment");
  assert.ok(checks("qa-python", PY, 'def test_total():\n    page.locator("#total")\n    time.sleep(2)\n').includes("sleep_or_skip_added"));
});

test("Python's // is floor division, not a comment; a C-like file's # is not a comment", () => {
  assert.ok(checks("qa-python", PY, "def test_total():\n    half = total // 2; time.sleep(3)\n").includes("sleep_or_skip_added"));
  assert.ok(checks("qa-ts", TS, 'class Cart {\n  #items = []; static { test.only("x", () => {}); }\n}\n').includes("focused_test"));
});

test("code in a message (no file): both kinds of comment are comments", () => {
  assert.ok(!checks("qa-ts", undefined, "// await page.waitForTimeout(2000);\n# time.sleep(2)").includes("sleep_or_skip_added"));
  assert.ok(checks("qa-ts", undefined, "await page.waitForTimeout(2000);").includes("sleep_or_skip_added"));
});
