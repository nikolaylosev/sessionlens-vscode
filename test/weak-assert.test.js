"use strict";
/* weak_assert (the regex side): an assertion that only checks that something exists or is truthy, per the profile's
   weak_assert_patterns. High, one finding per weak line; the same line in a later version of the file is not reported
   again. What must not count: an assertion on a value, a commented-out line, a Python predicate such as
   `assert cart.is_empty()` (both reported until 0.1.119). In qa-cypress `.should('exist')` counts in a file with no
   "expect" or "assert" (missed until 0.1.119). The engine rules mapped to weak_assert are in
   lint-mapped-checks.test.js. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");

const { Lens } = load();

const found = (profile, versions) =>
  Lens.runChecks(
    versions.map(([file, content], i) => ({ seq: i + 1, kind: "write", file, new_content: content })),
    Lens.profile(profile),
  )
    .filter((f) => f.check === "weak_assert")
    .map((f) => `${f.severity}: ${f.message}`);
const weak = (file, line) => `high: ${file}: weak assertion “${line}” — checks “didn't crash”, not a value`;

const F = "e2e/cart.spec.ts";
const ts = (body) => `test('total', async () => {\n${body}\n});\n`;

test("TypeScript: toBeDefined, toBeTruthy and expect(true).toBe(true), one finding per line", () => {
  assert.deepEqual(found("qa-ts", [[F, ts("  expect(total).toBeDefined();")]]), [weak(F, "expect(total).toBeDefined()")]);
  assert.deepEqual(found("qa-ts", [[F, ts("  expect(ok).toBeTruthy();\n  expect(true).toBe(true);")]]), [
    weak(F, "expect(ok).toBeTruthy()"),
    weak(F, "expect(true).toBe(true)"),
  ]);
});

test("Python and Java", () => {
  const P = "tests/test_cart.py";
  assert.deepEqual(found("qa-python", [[P, "def test_cart():\n    assert True\n    assert result\n    assert user is not None\n"]]), [
    weak(P, "assert True"),
    weak(P, "assert result"),
    weak(P, "assert user is not None"),
  ]);
  const J = "src/test/java/CartTest.java";
  assert.deepEqual(found("qa-java", [[J, "class CartTest {\n  @Test\n  void total() {\n    assertNotNull(cart);\n    assertTrue(true);\n  }\n}\n"]]), [
    weak(J, "assertNotNull(cart);"),
    weak(J, "assertTrue(true)"),
  ]);
});

test("the same weak line in a later version of the file is reported once", () => {
  assert.deepEqual(
    found("qa-ts", [
      [F, ts("  expect(total).toBeDefined();")],
      [F, ts("  expect(total).toBeDefined();\n  expect(count).toBe(2);")],
    ]),
    [weak(F, "expect(total).toBeDefined()")],
  );
});

test("not reported: assertions on a value", () => {
  assert.deepEqual(found("qa-ts", [[F, ts("  expect(total).toBe(3);\n  await expect(page.getByText('Paid')).toBeVisible();")]]), []);
  assert.deepEqual(found("qa-python", [["tests/test_cart.py", "def test_cart():\n    assert result == 3\n    assert user.name == 'Ada'\n"]]), []);
  assert.deepEqual(
    found("qa-java", [["src/test/java/CartTest.java", "class CartTest {\n  @Test\n  void total() {\n    assertEquals(3, cart.total());\n  }\n}\n"]]),
    [],
  );
});

test("not reported: a commented-out weak assertion; the code line next to it still is", () => {
  assert.deepEqual(found("qa-ts", [[F, ts("  // expect(ok).toBeTruthy();\n  expect(total).toBe(3);")]]), []);
  assert.deepEqual(found("qa-ts", [[F, "/**\n * expect(ok).toBeTruthy();\n */\n" + ts("  expect(total).toBe(3);")]]), []);
  assert.deepEqual(found("qa-python", [["tests/test_cart.py", "def test_cart():\n    # assert True\n    assert total == 3\n"]]), []);
  assert.deepEqual(found("qa-ts", [[F, ts("  // the old check\n  expect(ok).toBeTruthy();")]]), [weak(F, "expect(ok).toBeTruthy()")]);
});

test("qa-cypress: .should('exist') counts also in a file with no expect or assert", () => {
  const C = "cypress/e2e/cart.cy.ts";
  assert.deepEqual(found("qa-cypress", [[C, "it('cart', () => {\n  cy.get('[data-test=total]').should('exist');\n});\n"]]), [weak(C, ".should('exist')")]);
  assert.deepEqual(found("qa-cypress", [[C, "it('cart', () => {\n  cy.get('[data-test=total]').should('have.text', '3');\n});\n"]]), []);
});

test("Python: a predicate (is_*, has_*, can_*, exists(), isdigit()) is a check of a value; a bare name or call is not", () => {
  const P = "tests/test_cart.py";
  assert.deepEqual(
    found("qa-python", [
      [
        P,
        "def test_cart():\n    assert cart.is_empty()\n    assert user.is_active\n    assert order.has_items()\n    assert path.exists()\n    assert code.isdigit()\n",
      ],
    ]),
    [],
  );
  assert.deepEqual(found("qa-python", [[P, "def test_cart():\n    assert resp.json()\n    assert data['id']\n    assert issues\n"]]), [
    weak(P, "assert resp.json()"),
    weak(P, "assert data['id']"),
    weak(P, "assert issues"),
  ]);
});
