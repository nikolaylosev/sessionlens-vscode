"use strict";
/* assert_weakened: between two versions of a test the session saw (two writes, a write and an edit, or the same test
   shown twice in messages), an assertion became weaker or the test lost assertions. High, at the later version. What
   must not count: the first version of a file, a stronger or an equally strong assertion, an added assertion, a
   renamed test, a change in another test. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");

const { Lens } = load();

// steps: ["write", file, content] | ["edit", file, old, new] | ["say", text] (the agent's message)
function transcript(steps) {
  const L = [JSON.stringify({ type: "user", message: { role: "user", content: "Write the tests" } })];
  steps.forEach(([kind, a, b, c], i) => {
    const id = "t" + i;
    if (kind === "say") return L.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: a }] } }));
    const [name, input] = kind === "write" ? ["Write", { file_path: a, content: b }] : ["Edit", { file_path: a, old_string: b, new_string: c }];
    L.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } }));
    L.push(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } }));
  });
  return L.join("\n");
}
const findings = (profile, steps) => {
  const cfg = Lens.profile(profile);
  return Lens.runChecks(Lens.importAny(transcript(steps), cfg), cfg).filter((f) => f.check === "assert_weakened");
};
const found = (profile, steps) => findings(profile, steps).map((f) => `${f.severity}: ${f.message}`);

const F = "e2e/cart.spec.ts";
const ts = (body) => `test('total', async () => {\n${body}\n});\n`;
const py = (body) => `def test_total():\n${body}\n`;
const java = (body) => `class CartTest {\n  @Test\n  void total() {\n${body}\n  }\n}\n`;

test("TypeScript: a value assertion replaced by a weaker one, at the later version", () => {
  const f = findings("qa-ts", [
    ["write", F, ts("  expect(total).toBe(3);")],
    ["write", F, ts("  expect(total).toBeDefined();")],
  ]);
  assert.deepEqual(
    f.map((x) => `${x.severity}: ${x.message}`),
    ["high: e2e/cart.spec.ts: total — assertion weakened (expect(total).toBe(3); → expect(total).toBeDefined();)"],
  );
  assert.equal(f[0].seq, 2, "the second write");
  assert.deepEqual(
    found("qa-ts", [
      ["write", F, ts("  expect(total).toBe(3);")],
      ["edit", F, "toBe(3)", "toBeTruthy()"],
    ]),
    ["high: e2e/cart.spec.ts: total — assertion weakened (expect(total).toBe(3); → expect(total).toBeTruthy();)"],
    "an edit of a file the session wrote",
  );
  assert.deepEqual(
    found("qa-ts", [
      ["write", F, ts("  expect(order).toEqual({ id: 1 });")],
      ["write", F, ts("  expect(order).toMatchObject({ id: 1 });")],
    ]),
    ["high: e2e/cart.spec.ts: total — assertion weakened (expect(order).toEqual({ id: 1 }); → expect(order).toMatchObject({ id: 1 });)"],
  );
});

test("a test that loses assertions", () => {
  assert.deepEqual(
    found("qa-ts", [
      ["write", F, ts("  expect(a).toBe(1);\n  expect(b).toBe(2);")],
      ["write", F, ts("  expect(a).toBe(1);")],
    ]),
    ["high: e2e/cart.spec.ts: total — fewer assertions (2 → 1)"],
  );
});

test("Python and Java", () => {
  assert.deepEqual(
    found("qa-python", [
      ["write", "tests/test_cart.py", py("    assert total == 3")],
      ["write", "tests/test_cart.py", py("    assert total")],
    ]),
    ["high: tests/test_cart.py: test_total — assertion weakened (comparison → truthiness: assert total)"],
  );
  assert.deepEqual(
    found("qa-python", [
      ["write", "tests/test_cart.py", py("    assert total == 3")],
      ["write", "tests/test_cart.py", py("    assert total is not None")],
    ]),
    ["high: tests/test_cart.py: test_total — assertion weakened (assert total == 3 → assert total is not None)"],
  );
  assert.deepEqual(
    found("qa-java", [
      ["write", "src/test/java/CartTest.java", java("    assertEquals(3, cart.total());")],
      ["write", "src/test/java/CartTest.java", java("    assertNotNull(cart.total());")],
    ]),
    ["high: src/test/java/CartTest.java: total — assertion weakened (assertEquals(3, cart.total()); → assertNotNull(cart.total());)"],
  );
});

test("an assertion commented out counts as removed: TypeScript, Java, C#, Cypress (0.1.120)", () => {
  const removed = (file, test) => [`high: ${file}: ${test} — fewer assertions (2 → 1)`];
  const two = ts("  expect(a).toBe(1);\n  expect(b).toBe(2);");
  assert.deepEqual(
    found("qa-ts", [
      ["write", F, two],
      ["write", F, ts("  expect(a).toBe(1);\n  // expect(b).toBe(2);")],
    ]),
    removed(F, "total"),
  );
  assert.deepEqual(
    found("qa-ts", [
      ["write", F, two],
      ["edit", F, "  expect(b)", "  // expect(b)"],
    ]),
    removed(F, "total"),
    "by an Edit",
  );
  assert.deepEqual(
    found("qa-ts", [
      ["write", F, two],
      ["write", F, ts("  expect(a).toBe(1);\n  /* expect(b).toBe(2); */")],
    ]),
    removed(F, "total"),
  );
  const J = "src/test/java/CartTest.java";
  assert.deepEqual(
    found("qa-java", [
      ["write", J, java("    assertEquals(1, cart.a());\n    assertEquals(2, cart.b());")],
      ["write", J, java("    assertEquals(1, cart.a());\n    // assertEquals(2, cart.b());")],
    ]),
    removed(J, "total"),
  );
  const C = "Tests/CartTests.cs";
  const cs = (b) => `public class CartTests {\n  [Test]\n  public void Total() {\n${b}\n  }\n}\n`;
  assert.deepEqual(
    found("qa-c#", [
      ["write", C, cs("    Assert.AreEqual(1, cart.A);\n    Assert.AreEqual(2, cart.B);")],
      ["write", C, cs("    Assert.AreEqual(1, cart.A);\n    // Assert.AreEqual(2, cart.B);")],
    ]),
    removed(C, "Total"),
  );
  const Y = "cypress/e2e/cart.cy.js";
  const cy = (b) => `it('total', () => {\n${b}\n});\n`;
  assert.deepEqual(
    found("qa-cypress", [
      ["write", Y, cy("  cy.get('.total').should('have.text', '3');\n  cy.get('tr').should('have.length', 2);")],
      ["write", Y, cy("  cy.get('.total').should('have.text', '3');\n  // cy.get('tr').should('have.length', 2);")],
    ]),
    removed(Y, "total"),
  );
});

test("an assertion inside a block comment counts as removed, also on a line without a leading * (0.1.121)", () => {
  const two = ts("  expect(a).toBe(1);\n  expect(b).toBe(2);");
  assert.deepEqual(
    found("qa-ts", [
      ["write", F, two],
      ["write", F, ts("  expect(a).toBe(1);\n  /*\n  expect(b).toBe(2);\n  */")],
    ]),
    [`high: ${F}: total — fewer assertions (2 → 1)`],
  );
  const J = "src/test/java/CartTest.java";
  assert.deepEqual(
    found("qa-java", [
      ["write", J, java("    assertEquals(1, cart.a());\n    assertEquals(2, cart.b());")],
      ["edit", J, "    assertEquals(2, cart.b());", "    /*\n    assertEquals(2, cart.b());\n    */"],
    ]),
    [`high: ${J}: total — fewer assertions (2 → 1)`],
    "by an Edit",
  );
});

test("not reported: an assertion commented out in both versions, or one brought back from a comment (0.1.120)", () => {
  const was = ts("  expect(a).toBe(1);\n  // expect(b).toBe(2);");
  assert.deepEqual(
    found("qa-ts", [
      ["write", F, was],
      ["write", F, ts("  expect(a).toBe(3);\n  // expect(b).toBe(2);")],
    ]),
    [],
  );
  assert.deepEqual(
    found("qa-ts", [
      ["write", F, was],
      ["write", F, ts("  expect(a).toBe(1);\n  expect(b).toBe(2);")],
    ]),
    [],
  );
});

test("the same test shown twice in messages (a chat session)", () => {
  assert.deepEqual(
    found("qa-ts", [
      ["say", "```ts\n" + ts("  expect(total).toBe(3);") + "```"],
      ["say", "Fixed:\n```ts\n" + ts("  expect(total).toBeDefined();") + "```"],
    ]),
    ["high: code in messages (version 2): total — assertion weakened (expect(total).toBe(3); → expect(total).toBeDefined();)"],
  );
});

test("not reported: a first version, a stronger or equal assertion, an added one, a renamed test, another test changed", () => {
  assert.deepEqual(found("qa-ts", [["write", F, ts("  expect(total).toBeDefined();")]]), [], "nothing to compare with");
  assert.deepEqual(
    found("qa-ts", [
      ["write", F, ts("  expect(total).toBeDefined();")],
      ["write", F, ts("  expect(total).toBe(3);")],
    ]),
    [],
    "stronger",
  );
  assert.deepEqual(
    found("qa-ts", [
      ["write", F, ts("  expect(total).toBe(3);")],
      ["write", F, ts("  expect(total).toEqual(3);")],
    ]),
    [],
    "as strong",
  );
  assert.deepEqual(
    found("qa-ts", [
      ["write", F, ts("  expect(total).toBeDefined();")],
      ["write", F, ts("  expect(total).toBeTruthy();")],
    ]),
    [],
    "weak before and after: weak_assert reports it, nothing was weakened",
  );
  assert.deepEqual(
    found("qa-ts", [
      ["write", F, ts("  expect(a).toBe(1);")],
      ["write", F, ts("  expect(a).toBe(1);\n  expect(b).toBe(2);")],
    ]),
    [],
    "an assertion added",
  );
  assert.deepEqual(
    found("qa-ts", [
      ["write", F, ts("  expect(a).toBe(1);\n  expect(b).toBe(2);")],
      ["write", F, "test('sum', async () => {\n  expect(a).toBe(1);\n});\n"],
    ]),
    [],
    "a renamed test is another test (test_deleted looks at the old one)",
  );
  const two = (b) => `test('total', async () => {\n  expect(a).toBe(1);\n});\ntest('count', async () => {\n  ${b}\n});\n`;
  assert.deepEqual(
    found("qa-ts", [
      ["write", F, two("expect(b).toBe(2);")],
      ["write", F, two("expect(b).toBe(5);")],
    ]),
    [],
    "another value, as strong",
  );
});
