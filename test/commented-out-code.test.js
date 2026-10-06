"use strict";
/* Commented-out code gives no finding in the checks that look for a pattern anywhere in a file (0.1.121): a sleep, a
   skip, .only, a debugger call, networkidle, a mock, a raw mobile locator, coordinates, a driver without teardown and
   test.fail() that are commented out never run. Each case has its live twin, which is still reported. What stays code:
   "#" and "//" inside a string, a URL, and Python's // (floor division). Assertion checks skip comments since 0.1.120.
   The checks that read a file line by line skip a line inside a block comment that does not start with "*" too
   (0.1.121; until then it was read as code). */
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

/* The checks that read a file line by line (0.1.121): the live line is reported, the same line inside a block comment,
   on a line of its own with no leading "*", is not. */
const BLOCK = [
  ["weak_assert", "qa-ts", TS, "  expect(ok).toBeTruthy();"],
  ["hardcoded_date", "qa-ts", TS, '  await expect(page.getByText("Date")).toHaveText("2026-03-15");'],
  ["magic_number", "qa-ts", TS, "  expect(sum).toBe(4217);"],
  ["conditional_logic", "qa-ts", TS, "  if (banner) await banner.close();"],
  ["hardcoded_base_url", "qa-ts", TS, '  await page.goto("https://staging.shop.io/cart");'],
  ["response_time_assert", "qa-api", "tests/cart.test.ts", "  expect(res.elapsed).toBeLessThan(500);"],
];
for (const [check, profile, file, live] of BLOCK)
  test(`${check} (${profile}): a line inside a block comment is not code (0.1.121)`, () => {
    const wrap = (body) => `test("total", async ({ page }) => {\n  await page.goto("/");\n${body}\n});\n`;
    assert.ok(checks(profile, file, wrap(live)).includes(check), "live: " + live);
    assert.ok(!checks(profile, file, wrap(`  /*\n${live}\n  */`)).includes(check), "in a block comment: " + live);
  });

test("duplicate_assert and assertion_roulette do not count an assertion inside a block comment (0.1.121)", () => {
  const ts = (body) => `test("total", async ({ page }) => {\n${body}\n});\n`;
  const line = "  expect(cart.total()).toBe(3);";
  assert.ok(checks("qa-ts", TS, ts(`${line}\n${line}`)).includes("duplicate_assert"));
  assert.ok(!checks("qa-ts", TS, ts(`${line}\n  /*\n${line}\n  */`)).includes("duplicate_assert"));
  const J = "src/test/java/CartTest.java";
  const java = (body) => `class CartTest {\n  @Test\n  void total() {\n${body}\n  }\n}\n`;
  const three = "    assertEquals(1, cart.a());\n    assertEquals(2, cart.b());\n";
  assert.ok(checks("qa-java", J, java(three + "    assertEquals(3, cart.c());")).includes("assertion_roulette"));
  assert.ok(!checks("qa-java", J, java(three + "    /*\n    assertEquals(3, cart.c());\n    */")).includes("assertion_roulette"));
});

test("an assertion inside a block comment is not one: status_only_assert and no_negative_cases see what runs (0.1.121)", () => {
  const F = "tests/cart.test.ts";
  const api = (name, body) => `test("${name}", async () => {\n  const res = await api.get("/cart");\n${body}\n});\n`;
  const status = "  expect(res.status).toBe(200);";
  const total = "  expect(res.body.total).toBe(3);";
  assert.ok(!checks("qa-api", F, api("total", `${status}\n${total}`)).includes("status_only_assert"));
  assert.ok(checks("qa-api", F, api("total", `${status}\n  /*\n${total}\n  */`)).includes("status_only_assert"), "only the status is checked");
  const two = (second) => api("total", status) + api("items", second);
  assert.ok(!checks("qa-api", F, two("  expect(res.status).toBe(404);")).includes("no_negative_cases"));
  assert.ok(checks("qa-api", F, two("  /*\n  expect(res.status).toBe(404);\n  */")).includes("no_negative_cases"), "the 404 never runs");
});

test("a line with code keeps its comment: magic_number still takes it for the number's explanation (0.1.121)", () => {
  const ts = (body) => `test("total", async ({ page }) => {\n${body}\n});\n`;
  assert.ok(!checks("qa-ts", TS, ts("  expect(sum).toBe(4217); // the order's total in cents")).includes("magic_number"));
  assert.ok(!checks("qa-ts", TS, ts("  expect(sum).toBe(4217); /* cents */")).includes("magic_number"));
});
