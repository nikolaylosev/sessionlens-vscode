"use strict";
/* expected_failure: a test marked as one that is expected to fail (Playwright's test.fail, pytest's xfail), medium, with
   the number of them in the file. What must not count: a skip (test.fixme, @Disabled, Ignore are sleep_or_skip_added's,
   since 0.1.113), an assertion about an exception, and commented-out code (0.1.121, commented-out-code.test.js).

   Since 0.1.121 (gaps found while writing this file): Jest's it.failing / test.failing, and pytest's xfail only as the
   marker or the call, not as a word in a docstring or a string.
   Not a gap: Java and C# have the check but no pattern, since JUnit, TestNG, NUnit, xUnit and MSTest have no "expected
   to fail" marker (`@Test(expected = …)` and `assertThrows` expect an exception, which is a passing test). */
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");

const { Lens } = load();

const found = (profile, file, content) =>
  Lens.runChecks([{ seq: 1, kind: file ? "write" : "message", file, text: "", new_content: content }], Lens.profile(profile))
    .filter((f) => f.check === "expected_failure")
    .map((f) => `${f.severity}: ${f.message}`);
const msg = (file, n) =>
  `medium: ${file}: ${n} ${n === 1 ? "test" : "tests"} marked as an expected failure — the suite reports green while the bug ${n === 1 ? "it documents" : "they document"} is open`;
const TS = "e2e/cart.spec.ts",
  PY = "tests/test_cart.py";

test("Playwright's test.fail: as a test, inside a test, with a condition", () => {
  assert.deepEqual(found("qa-ts", TS, 'test.fail("total", async () => {});\n'), [msg(TS, 1)]);
  assert.deepEqual(found("qa-ts", TS, 'test("total", async () => {\n  test.fail();\n});\n'), [msg(TS, 1)]);
  assert.deepEqual(found("qa-ts", TS, 'test("total", async ({ browserName }) => {\n  test.fail(browserName === "webkit", "bug 12");\n});\n'), [msg(TS, 1)]);
});

test("one finding per file, counting the marked tests", () => {
  assert.deepEqual(found("qa-ts", TS, 'test.fail("a", async () => {});\ntest.fail("b", async () => {});\n'), [msg(TS, 2)]);
});

test("pytest's xfail: the marker, strict, and the call inside a test", () => {
  assert.deepEqual(found("qa-python", PY, '@pytest.mark.xfail(reason="bug 12")\ndef test_total():\n    pass\n'), [msg(PY, 1)]);
  assert.deepEqual(found("qa-python", PY, "@pytest.mark.xfail(strict=True)\ndef test_total():\n    pass\n"), [msg(PY, 1)]);
  assert.deepEqual(found("qa-python", PY, 'def test_total():\n    pytest.xfail("bug 12")\n'), [msg(PY, 1)]);
});

test("Jest's expected failure: it.failing, test.failing, test.failing.each (0.1.121)", () => {
  assert.deepEqual(found("qa-ts", TS, 'it.failing("total", () => {});\n'), [msg(TS, 1)]);
  assert.deepEqual(found("qa-ts", TS, 'test.failing("total", () => {});\n'), [msg(TS, 1)]);
  assert.deepEqual(found("qa-ts", TS, 'test.failing.each([1, 2])("total %i", () => {});\n'), [msg(TS, 1)]);
});

test("xfail as a word is not a marker: a docstring, a string, a name (0.1.121)", () => {
  assert.deepEqual(found("qa-python", PY, 'def test_total():\n    """Shows xfail in the report."""\n'), []);
  assert.deepEqual(found("qa-python", PY, 'def test_status():\n    assert status != "xfail"\n'), []);
  assert.deepEqual(found("qa-python", PY, "def test_report():\n    assert report.xfailed == 0\n"), []);
  assert.deepEqual(found("qa-python", PY, '@mark.xfail(reason="bug 12")\ndef test_total():\n    pass\n'), [msg(PY, 1)], "mark imported from pytest");
});

test("code shown in a message is checked too", () => {
  assert.deepEqual(found("qa-ts", undefined, 'test.fail("total", async () => {});'), [msg("code in message", 1)]);
});

test("not an expected failure: a skip, an expected exception, a method named like one", () => {
  assert.deepEqual(found("qa-ts", TS, 'test.fixme("total", async () => {});\n'), [], "a skip: sleep_or_skip_added");
  assert.deepEqual(found("qa-java", "src/test/java/CartTest.java", '@Test\n@Disabled("bug 12")\nvoid total() {}\n'), []);
  assert.deepEqual(found("qa-c#", "tests/CartTests.cs", '[Test, Ignore("bug 12")] public void Total() {}\n'), []);
  assert.deepEqual(found("qa-java", "src/test/java/CartTest.java", "@Test void pay() { assertThrows(PaymentException.class, () -> cart.pay()); }\n"), []);
  assert.deepEqual(found("qa-ts", TS, "const failures = await test.failures();\n"), []);
});

test("not reported: commented out", () => {
  assert.deepEqual(found("qa-ts", TS, '// test.fail("total", async () => {});\n'), []);
  assert.deepEqual(found("qa-python", PY, '# @pytest.mark.xfail(reason="bug 12")\ndef test_total():\n    pass\n'), []);
});

test("the profiles that run it", () => {
  const profiles = ["qa-ts", "qa-cypress", "qa-detox", "qa-python", "qa-java", "qa-c#", "qa-api", "qa-mobile", "qa-robot", "qa-generic"];
  assert.deepEqual(
    profiles.filter((p) => Lens.profile(p).checks.includes("expected_failure")),
    ["qa-ts", "qa-cypress", "qa-detox", "qa-python", "qa-java", "qa-c#", "qa-api", "qa-mobile"],
  );
});
