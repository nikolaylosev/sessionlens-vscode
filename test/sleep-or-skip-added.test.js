"use strict";
/* sleep_or_skip_added (regex side; the lint engines replace it where they run, see supersedes.test.js): a fixed delay,
   a skipped test or a retry in written code, high, with the kind LensLint.merge() compares ("sleep", "skip", "retry").
   What must not count: a delay under 100 ms, a Cypress wait on a route alias, retries in a runner config (that is
   config_weakened), retries: 0, and the same sleep again in a later version of the file.

   Detector bugs found while writing this file (5 Oct 2026), not pinned here, to be fixed in a PR of their own after the
   owner decides:
   - commented-out code counts: `// await page.waitForTimeout(2000)`, `/* test.skip *\/` and Python `# time.sleep(2)`
     each give a high finding (the same mistake duplicate_assert and weak_assert had before 0.1.120);
   - product code counts as a test: src/debounce.ts with `setTimeout(fn, 1000)` gives "fixed delay (sleep) in a test";
   - qa-python's `\breruns\b` matches the word in a docstring ("No reruns here.") and gives a high "retry".
   Open question, not a bug: `page.waitForTimeout(DELAY)` with a named constant is not reported (the pattern wants a
   number), although the rule says "no sleep with a constant". */
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");

const { Lens } = load();

const write = (file, content, seq = 1, kind = "write") => ({ seq, kind, file, new_content: content });
const found = (profile, ...events) =>
  Lens.runChecks(events, Lens.profile(profile))
    .filter((f) => f.check === "sleep_or_skip_added")
    .map((f) => `${f.seq} ${f.severity} ${f.kind}: ${f.message}`);
const ts = (body) => `test("total", async ({ page }) => {\n${body}\n});\n`;
const F = "e2e/cart.spec.ts";

test("a fixed delay in a test is reported, high, kind sleep: TypeScript, Python, Java, Cypress", () => {
  const sleep = (f) => [`1 high sleep: ${f}: fixed delay (sleep) in a test`];
  assert.deepEqual(found("qa-ts", write(F, ts("  await page.waitForTimeout(2000);"))), sleep(F));
  assert.deepEqual(found("qa-ts", write(F, ts("  await new Promise((r) => setTimeout(r, 1500));"))), sleep(F));
  assert.deepEqual(found("qa-python", write("tests/test_cart.py", "def test_total():\n    time.sleep(2)\n")), sleep("tests/test_cart.py"));
  assert.deepEqual(found("qa-python", write("tests/test_cart.py", "async def test_total():\n    await asyncio.sleep(0.5)\n")), sleep("tests/test_cart.py"));
  assert.deepEqual(
    found("qa-java", write("src/test/java/CartTest.java", "@Test void total() throws Exception {\n  Thread.sleep(500);\n}\n")),
    sleep("src/test/java/CartTest.java"),
  );
  assert.deepEqual(found("qa-cypress", write("cypress/e2e/cart.cy.ts", 'it("total", () => {\n  cy.wait(1000);\n});\n')), sleep("cypress/e2e/cart.cy.ts"));
});

test("a skipped test is reported, high, kind skip", () => {
  const skip = (f) => [`1 high skip: ${f}: skip / retry added`];
  assert.deepEqual(found("qa-ts", write(F, 'test.skip("total", async () => {});\n')), skip(F));
  assert.deepEqual(found("qa-ts", write(F, 'test.describe.skip("cart", () => {});\n')), skip(F));
  assert.deepEqual(found("qa-ts", write(F, 'test.fixme("total", async () => {});\n')), skip(F));
  assert.deepEqual(found("qa-ts", write(F, ts('  test.skip(browserName === "webkit", "no webkit");'))), skip(F), "a skip inside the test too");
  assert.deepEqual(
    found("qa-python", write("tests/test_cart.py", '@pytest.mark.skip(reason="later")\ndef test_total():\n    pass\n')),
    skip("tests/test_cart.py"),
  );
  assert.deepEqual(
    found("qa-python", write("tests/test_cart.py", '@pytest.mark.skipif(sys.platform == "win32", reason="x")\ndef test_total():\n    pass\n')),
    skip("tests/test_cart.py"),
  );
  assert.deepEqual(found("qa-java", write("src/test/java/CartTest.java", "@Disabled\n@Test void total() {}\n")), skip("src/test/java/CartTest.java"));
});

test("a retry in a test file is reported as kind retry", () => {
  assert.deepEqual(found("qa-ts", write(F, "test.describe.configure({ retries: 2 });\n")), [`1 high retry: ${F}: skip / retry added`]);
  assert.deepEqual(found("qa-python", write("tests/test_cart.py", "@flaky\ndef test_total():\n    pass\n")), [
    "1 high retry: tests/test_cart.py: skip / retry added",
  ]);
});

test("code shown in a message is checked too, named as such", () => {
  assert.deepEqual(found("qa-ts", { seq: 3, kind: "message", text: "Try this:", new_content: "await page.waitForTimeout(3000);" }), [
    "3 high sleep: code in message: fixed delay (sleep) in a test",
  ]);
});

test("not reported: a delay under 100 ms, a wait on a route alias, retries in a runner config, retries: 0", () => {
  assert.deepEqual(found("qa-ts", write(F, ts("  setTimeout(done, 50);"))), []);
  assert.deepEqual(found("qa-cypress", write("cypress/e2e/cart.cy.ts", 'it("total", () => {\n  cy.wait("@getCart");\n});\n')), []);
  assert.deepEqual(found("qa-ts", write("playwright.config.ts", "export default { retries: 2 };\n")), [], "config_weakened's case");
  assert.deepEqual(found("qa-ts", write(F, "test.describe.configure({ retries: 0 });\n")), []);
});

test("one finding per file: a later edit that keeps the same sleep does not report it again", () => {
  const first = ts("  await page.waitForTimeout(2000);");
  const second = ts("  await page.waitForTimeout(2000);\n  await expect(page.getByTestId('total')).toHaveText('42');");
  assert.deepEqual(found("qa-ts", write(F, first), write(F, second, 2, "edit")), [`1 high sleep: ${F}: fixed delay (sleep) in a test`]);
});
