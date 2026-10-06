"use strict";
/* The two specification facts that calibration never hides: no_spec (code was written and there is no specification)
   and spec_uncovered (a requirement no test names), both high, at the last step that wrote code, source "spec". A test
   names a requirement by its ID in the title or in a comment above (a ticket prefix, CART-12/R1, too); in Python, in
   its docstring. The last version of a file counts, and tests in several files add up. R10 does not cover R1.

   Since 0.1.121 (gaps found on 5 Oct 2026): a specification without IDs gets no spec_uncovered, since no test can
   name an ID it was never given; and a test name written the language's way names its requirement: test_r1_total,
   testR1Total, R1_Total. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { load, M } = require("./helpers");

load();
const LensSpec = require(M("spec.js"));

const facts = (spec, events, language = "typescript") =>
  LensSpec.checks(LensSpec.parse(spec), events, language)
    .findings.filter((f) => f.check === "no_spec" || f.check === "spec_uncovered")
    .map((f) => `${f.seq} ${f.check} ${f.severity} ${f.source}: ${f.message}`);
const write = (code, seq = 1, file = "e2e/cart.spec.ts") => ({ seq, kind: "write", file, new_content: code });
const t = (name) => `test("${name}", async () => {\n  expect(x).toBe(1);\n});\n`;
const SPEC = "## Requirements\nR1. The cart shows the total\nR2. An empty cart shows a hint\n";
const NO_SPEC = (seq) => `${seq} no_spec high spec: No specification: impossible to tell which checks are requirements and which are the agent's guesses`;
const UNCOVERED = (seq, id, text) => `${seq} spec_uncovered high spec: Requirement ${id} has no test: “${text}”`;

test("no_spec: code written with no specification, at the last step that wrote code", () => {
  assert.deepEqual(facts("", [write(t("total"), 1), { seq: 2, kind: "message", text: "done" }, write(t("hint"), 3)]), [NO_SPEC(3)]);
});

test("no_spec: nothing when no code was written", () => {
  assert.deepEqual(facts("", [{ seq: 1, kind: "message", text: "Here is my plan." }]), []);
});

test("spec_uncovered: a requirement no test names, at the last step that wrote code", () => {
  assert.deepEqual(facts(SPEC, [write(t("R1 total"), 2)]), [UNCOVERED(2, "R2", "An empty cart shows a hint")]);
});

test("spec_uncovered, not reported: the ID in the title, in a comment above, with a ticket prefix; tests in two files", () => {
  assert.deepEqual(facts(SPEC, [write(t("R1 total") + t("R2 hint"))]), []);
  assert.deepEqual(facts(SPEC, [write(t("R1 total") + "// R2\n" + t("hint"))]), []);
  assert.deepEqual(facts(SPEC, [write(t("CART-12/R1 total") + t("CART-12/R2 hint"))]), []);
  assert.deepEqual(facts(SPEC, [write(t("R1 total"), 1, "e2e/a.spec.ts"), write(t("R2 hint"), 2, "e2e/b.spec.ts")]), []);
});

test("spec_uncovered: the last version of a file counts; R10 does not cover R1", () => {
  assert.deepEqual(facts(SPEC, [write(t("R1 total") + t("R2 hint"), 1), write(t("R1 total"), 2)]), [UNCOVERED(2, "R2", "An empty cart shows a hint")]);
  assert.deepEqual(facts("## Requirements\nR1. a\nR10. b\n", [write(t("R10 b"))]), [UNCOVERED(1, "R1", "a")]);
});

test("spec_uncovered in Python: the ID in the docstring links the test", () => {
  assert.deepEqual(facts(SPEC, [write('def test_total():\n    """R1"""\n    assert x\n', 1, "tests/test_cart.py")], "python"), [
    UNCOVERED(1, "R2", "An empty cart shows a hint"),
  ]);
});

test("a specification without IDs gets no spec_uncovered: no test can name an ID it was never given (0.1.121)", () => {
  assert.deepEqual(facts("The cart shows the total\nAn empty cart shows a hint\n", [write(t("total") + t("empty"))]), []);
});

test("an ID in a test name written the language's way: snake_case, camelCase, lower case (0.1.121)", () => {
  assert.deepEqual(facts(SPEC, [write("def test_r1_total():\n    assert x\n\ndef test_R2_hint():\n    assert y\n", 1, "tests/test_cart.py")], "python"), []);
  const java =
    "class CartTest {\n  @Test\n  void testR1Total() {\n    assertEquals(1, x);\n  }\n\n  @Test\n  void testR2Hint() {\n    assertEquals(1, y);\n  }\n}\n";
  assert.deepEqual(facts(SPEC, [write(java, 1, "src/test/java/CartTest.java")], "java"), []);
  const cs =
    "public class CartTests {\n  [Test]\n  public void R1_Total() {\n    Assert.AreEqual(1, x);\n  }\n  [Test]\n  public void R2_Hint() {\n    Assert.AreEqual(1, y);\n  }\n}\n";
  assert.deepEqual(facts(SPEC, [write(cs, 1, "tests/CartTests.cs")], "csharp"), []);
  assert.deepEqual(facts(SPEC, [write(t("r1 total") + t("r2 hint"))]), []);
  // still not a link: R1 inside a longer ID or a word
  assert.deepEqual(facts(SPEC, [write(t("R1 total") + t("R20 hint") + t("Mr2 hint"))]), [UNCOVERED(1, "R2", "An empty cart shows a hint")]);
});

test("refs: the IDs named, in each way", () => {
  const ids = (x) => [...LensSpec.refs(x)];
  assert.deepEqual(ids("CART-12/R1 total"), ["R1"]);
  assert.deepEqual(ids("test_r1_total"), ["R1"]);
  assert.deepEqual(ids("testR1Total"), ["R1"]);
  assert.deepEqual(ids("test_s2_login"), ["S2"]);
  assert.deepEqual(ids("HTTP2 R10"), ["R10"]);
  assert.deepEqual(ids("r2d2 mr2 R1x"), []);
});
