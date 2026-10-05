"use strict";
/* assertion_roulette: Python and Java only, three or more assertions in one test with no messages. What must not
   count: two assertions, messages on the asserts, TypeScript, and commented-out asserts (counted until 0.1.120). */
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");

const { Lens } = load();

const found = (profile, file, content) =>
  Lens.runChecks([{ seq: 1, kind: "write", file, new_content: content }], Lens.profile(profile))
    .filter((f) => f.check === "assertion_roulette")
    .map((f) => `${f.severity}: ${f.message}`);

test("Python and Java: three asserts without messages", () => {
  assert.deepEqual(found("qa-python", "tests/test_cart.py", "def test_total():\n    assert cart.a == 1\n    assert cart.b == 2\n    assert cart.c == 3\n"), [
    "low: tests/test_cart.py: test_total — 3 assertions without messages: on failure you can't tell which one (Assertion Roulette)",
  ]);
  assert.deepEqual(
    found(
      "qa-java",
      "src/test/java/CartTest.java",
      "class CartTest {\n  @Test\n  void total() {\n    assertEquals(1, cart.a());\n    assertEquals(2, cart.b());\n    assertTrue(cart.c());\n  }\n}\n",
    ),
    ["low: src/test/java/CartTest.java: total — 3 assertions without messages: on failure you can't tell which one (Assertion Roulette)"],
  );
});

test("not reported: two asserts, a message on each, or TypeScript", () => {
  assert.deepEqual(found("qa-python", "tests/test_cart.py", "def test_total():\n    assert cart.a == 1\n    assert cart.b == 2\n"), []);
  assert.deepEqual(
    found("qa-python", "tests/test_cart.py", 'def test_total():\n    assert cart.a == 1, "a"\n    assert cart.b == 2, "b"\n    assert cart.c == 3, "c"\n'),
    [],
  );
  assert.deepEqual(
    found(
      "qa-java",
      "src/test/java/CartTest.java",
      'class CartTest {\n  @Test\n  void total() {\n    assertEquals("a", 1, cart.a());\n    assertEquals("b", 2, cart.b());\n    assertTrue("c", cart.c());\n  }\n}\n',
    ),
    [],
  );
  assert.deepEqual(
    found("qa-ts", "e2e/cart.spec.ts", "test('total', async () => {\n  expect(a).toBe(1);\n  expect(b).toBe(2);\n  expect(c).toBe(3);\n});\n"),
    [],
  );
});

test("commented-out asserts do not count (0.1.120)", () => {
  const java = (b) => `class CartTest {\n  @Test\n  void total() {\n${b}\n  }\n}\n`;
  assert.deepEqual(
    found(
      "qa-java",
      "src/test/java/CartTest.java",
      java("    assertEquals(1, cart.a());\n    assertEquals(2, cart.b());\n    // assertEquals(3, cart.c());\n    // assertTrue(cart.d());"),
    ),
    [],
  );
  assert.deepEqual(
    found(
      "qa-java",
      "src/test/java/CartTest.java",
      java("    assertEquals(1, cart.a());\n    assertEquals(2, cart.b());\n    assertTrue(cart.c());\n    /* assertTrue(cart.d()); */"),
    ),
    ["low: src/test/java/CartTest.java: total — 3 assertions without messages: on failure you can't tell which one (Assertion Roulette)"],
  );
});
