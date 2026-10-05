"use strict";
/* fragile_wait (regex side; ESLint's playwright, cypress and detox rules replace it where they run, see supersedes.test.js):
   `waitUntil: 'networkidle'` in written code, medium, kind networkidle, and an exact element count read with
   `.count()` and compared with `.toBe(n)`, low, kind count. What must not count: another waitUntil value, and a count
   compared with toBeGreaterThan. Commented-out code: see commented-out-code.test.js (fixed in 0.1.121).
   Since 0.1.121 also the other ways to wait for network idle (waitForLoadState, Python, Java, C#), worded apart from
   the waitUntil finding so its verdicts keep their key, and a wider count pattern (spaces, toEqual, Python's ==): gaps
   found while writing this file.
   Open question, not a bug: `await expect(rows).toHaveCount(3)` is not reported. It is an exact count too, but it
   waits for the page, which is what Playwright advises. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");

const { Lens } = load();

const F = "e2e/cart.spec.ts";
const found = (code, kind = "write", profile = "qa-ts") =>
  Lens.runChecks([{ seq: 1, kind, file: kind === "message" ? undefined : F, text: "", new_content: code }], Lens.profile(profile))
    .filter((f) => f.check === "fragile_wait")
    .map((f) => `${f.severity} ${f.kind}: ${f.message}`);
const IDLE = `medium networkidle: ${F}: waitUntil: 'networkidle' on a live site — a flakiness source (Playwright advises against it)`;
const COUNT = `low count: ${F}: exact element count in an assertion — brittle when content changes`;

test("waitUntil: 'networkidle' is reported, medium, with either quote and without a space", () => {
  assert.deepEqual(found('await page.goto("/", { waitUntil: "networkidle" });'), [IDLE]);
  assert.deepEqual(found("await page.goto('/', { waitUntil: 'networkidle' });"), [IDLE]);
  assert.deepEqual(found('await page.goto("/",{waitUntil:"networkidle"});'), [IDLE]);
});

test("an exact count read with count() and compared with toBe is reported, low", () => {
  assert.deepEqual(found('expect(await page.getByRole("row").count()).toBe(3);'), [COUNT]);
});

test("both in one file: two findings", () => {
  assert.deepEqual(found('await page.goto("/", { waitUntil: "networkidle" });\nexpect(await rows.count()).toBe(3);'), [IDLE, COUNT]);
});

test("code shown in a message is checked too, named as such", () => {
  assert.deepEqual(found('await page.goto("/", { waitUntil: "networkidle" });', "message"), [
    "medium networkidle: code in message: waitUntil: 'networkidle' on a live site — a flakiness source (Playwright advises against it)",
  ]);
});

test("not reported: another waitUntil value, a count compared with toBeGreaterThan", () => {
  assert.deepEqual(found('await page.goto("/", { waitUntil: "domcontentloaded" });'), []);
  assert.deepEqual(found("expect(await rows.count()).toBeGreaterThan(0);"), []);
});

const foundIn = (profile, file, code) =>
  Lens.runChecks([{ seq: 1, kind: "write", file, new_content: code }], Lens.profile(profile))
    .filter((f) => f.check === "fragile_wait")
    .map((f) => `${f.severity} ${f.kind}: ${f.message}`);
const WAITS = (f) => `medium networkidle: ${f}: waits for 'networkidle' on a live site — a flakiness source (Playwright advises against it)`;

test("the other ways to wait for network idle, in TypeScript, Python, Java and C#: medium, worded apart", () => {
  assert.deepEqual(foundIn("qa-ts", F, 'await page.waitForLoadState("networkidle");'), [WAITS(F)]);
  const PY = "tests/test_cart.py";
  assert.deepEqual(foundIn("qa-python", PY, 'def test_total(page):\n    page.goto("/", wait_until="networkidle")\n'), [WAITS(PY)]);
  assert.deepEqual(foundIn("qa-python", PY, 'def test_total(page):\n    page.wait_for_load_state("networkidle")\n'), [WAITS(PY)]);
  const JAVA = "src/test/java/CartTest.java";
  assert.deepEqual(foundIn("qa-java", JAVA, "@Test void total() { page.waitForLoadState(LoadState.NETWORKIDLE); }\n"), [WAITS(JAVA)]);
  assert.deepEqual(
    foundIn("qa-java", JAVA, '@Test void total() { page.navigate("/", new Page.NavigateOptions().setWaitUntil(WaitUntilState.NETWORKIDLE)); }\n'),
    [WAITS(JAVA)],
  );
  const CS = "tests/CartTests.cs";
  assert.deepEqual(foundIn("qa-c#", CS, "[Test] public async Task Total() { await Page.WaitForLoadStateAsync(LoadState.NetworkIdle); }\n"), [WAITS(CS)]);
  assert.deepEqual(foundIn("qa-ts", F, 'await page.waitForLoadState("load");'), [], "another state");
  assert.deepEqual(foundIn("qa-python", PY, 'def test_total(page):\n    page.goto("/", wait_until="load")\n'), []);
});

test("one file with both forms: one networkidle finding, the waitUntil wording", () => {
  assert.deepEqual(found('await page.goto("/", { waitUntil: "networkidle" });\nawait page.waitForLoadState("networkidle");'), [IDLE]);
});

test("the count pattern: spaces, toEqual and toStrictEqual, and Python's ==", () => {
  assert.deepEqual(found("expect(await rows.count()).toBe( 3 );"), [COUNT]);
  assert.deepEqual(found("expect(await rows.count()).toEqual(3);"), [COUNT]);
  assert.deepEqual(found("expect(await rows.count()).toStrictEqual(3);"), [COUNT]);
  assert.deepEqual(foundIn("qa-python", "tests/test_cart.py", 'def test_rows(page):\n    assert page.get_by_role("row").count() == 3\n'), [
    "low count: tests/test_cart.py: exact element count in an assertion — brittle when content changes",
  ]);
  assert.deepEqual(foundIn("qa-python", "tests/test_cart.py", "def test_rows(page):\n    assert rows.count() >= 1\n"), []);
});

test("the profiles that run it", () => {
  const profiles = ["qa-ts", "qa-cypress", "qa-detox", "qa-python", "qa-java", "qa-c#", "qa-api", "qa-mobile", "qa-robot", "qa-generic"];
  assert.deepEqual(
    profiles.filter((p) => Lens.profile(p).checks.includes("fragile_wait")),
    ["qa-ts", "qa-cypress", "qa-detox", "qa-python", "qa-java", "qa-c#", "qa-api", "qa-mobile"],
  );
});
