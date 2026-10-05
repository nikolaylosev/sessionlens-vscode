"use strict";
/* magic_number: a number on an assertion line inside a test, one low finding per test that lists up to four numbers.
   What must not count: 0, 1, 2, 100 and the common HTTP status codes, a number between -1 and 1, a number outside an
   assertion or inside a name, an assertion line with a comment that explains the number, a commented-out assertion
   (also inside a block comment), and the profiles without assertion patterns (qa-robot, qa-generic). Until 0.1.120 a
   "#" or "//" anywhere on the line counted as a comment, so a CSS id selector or a URL hid the numbers on that line. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");

const { Lens } = load();

// steps: ["write", file, content] | ["edit", file, old, new] | ["bash", command, output]
function transcript(steps) {
  const L = [JSON.stringify({ type: "user", message: { role: "user", content: "Write the tests" } })];
  steps.forEach(([kind, a, b, c], i) => {
    const id = "t" + i;
    const input = kind === "write" ? { file_path: a, content: b } : kind === "edit" ? { file_path: a, old_string: b, new_string: c } : { command: a };
    const name = kind === "write" ? "Write" : kind === "edit" ? "Edit" : "Bash";
    L.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } }));
    L.push(
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: kind === "bash" ? b : "ok" }] } }),
    );
  });
  return L.join("\n");
}
const found = (profile, steps) => {
  const cfg = Lens.profile(profile);
  return Lens.runChecks(Lens.importAny(transcript(steps), cfg), cfg)
    .filter((f) => f.check === "magic_number")
    .map((f) => `${f.severity}: ${f.message}`);
};
const pw = (body, name = "cart total") => `import { test, expect } from "@playwright/test";\n\ntest("${name}", async ({ page }) => {\n${body}});\n`;
const msg = (file, name, nums) => `low: ${file}: ${name} — unexplained numbers in assertions: ${nums} (Magic Number)`;

test("a number in an assertion is reported once per test, with the test's name", () => {
  assert.deepEqual(found("qa-ts", [["write", "e2e/cart.spec.ts", pw('  await expect(page.getByTestId("total")).toHaveText("1499");\n')]]), [
    msg("e2e/cart.spec.ts", "cart total", "1499"),
  ]);
  const two = pw("  expect(items).toHaveLength(3);\n") + 'test("cart discount", async () => {\n  expect(discount).toBe(15);\n});\n';
  assert.deepEqual(found("qa-ts", [["write", "e2e/cart.spec.ts", two]]), [
    msg("e2e/cart.spec.ts", "cart total", "3"),
    msg("e2e/cart.spec.ts", "cart discount", "15"),
  ]);
});

test("each number is listed once, at most four, decimals and negatives included", () => {
  const body = [7, 7, 2.5, -7, 13, 99].map((n) => `  expect(v).toBe(${n});\n`).join("");
  assert.deepEqual(found("qa-ts", [["write", "e2e/cart.spec.ts", pw(body)]]), [msg("e2e/cart.spec.ts", "cart total", "7, 2.5, -7, 13")]);
});

test("reported in the other profiles, each with its own assertion form", () => {
  assert.deepEqual(found("qa-python", [["write", "tests/test_cart.py", "def test_items():\n    assert len(cart.items) == 37\n"]]), [
    msg("tests/test_cart.py", "test_items", "37"),
  ]);
  assert.deepEqual(found("qa-java", [["write", "src/test/java/CartTest.java", "@Test\nvoid total() {\n  assertEquals(42, cart.total());\n}\n"]]), [
    msg("src/test/java/CartTest.java", "total", "42"),
  ]);
  assert.deepEqual(found("qa-c#", [["write", "Tests/CartTests.cs", "[Test]\npublic void Total() {\n  Assert.AreEqual(42, cart.Total());\n}\n"]]), [
    msg("Tests/CartTests.cs", "Total", "42"),
  ]);
  assert.deepEqual(found("qa-cypress", [["write", "cypress/e2e/cart.cy.js", 'it("rows", () => {\n  cy.get("tr").should("have.length", 12);\n});\n']]), [
    msg("cypress/e2e/cart.cy.js", "rows", "12"),
  ]);
});

test("not reported: 0, 1, 2, 100, HTTP status codes and numbers between -1 and 1", () => {
  const body = [0, 1, 2, 100, 200, 201, 204, 404, 422, 500, 503, -1, 0.5, "1.0"].map((n) => `  expect(v).toBe(${n});\n`).join("");
  assert.deepEqual(found("qa-ts", [["write", "e2e/cart.spec.ts", pw(body)]]), []);
  assert.deepEqual(found("qa-python", [["write", "tests/test_api.py", "def test_missing():\n    assert resp.status_code == 404\n"]]), []);
});

test("not reported: a number outside an assertion or inside a name", () => {
  const body = "  const attempts = 5;\n  await page.waitForTimeout(250);\n  expect(item2.price3).toBe(MAX_ATTEMPTS_5);\n";
  assert.deepEqual(found("qa-ts", [["write", "e2e/cart.spec.ts", pw(body)]]), []);
});

test("not reported: a comment that explains the number, and a commented-out assertion; the next line still is", () => {
  assert.deepEqual(found("qa-ts", [["write", "e2e/cart.spec.ts", pw("  expect(total).toBe(1499); // 14.99 in cents, spec 3.2\n")]]), []);
  assert.deepEqual(found("qa-python", [["write", "tests/test_cart.py", "def test_total():\n    assert total == 1499  # cents, spec 3.2\n"]]), []);
  assert.deepEqual(found("qa-ts", [["write", "e2e/cart.spec.ts", pw("  // expect(total).toBe(1499);\n  expect(total).toBe(PRICE);\n")]]), []);
  assert.deepEqual(found("qa-ts", [["write", "e2e/cart.spec.ts", pw("  // the old total\n  expect(total).toBe(1499);\n")]]), [
    msg("e2e/cart.spec.ts", "cart total", "1499"),
  ]);
});

test("a # or // inside a string is not a comment: a CSS id, a URL, a hash in Python (0.1.120)", () => {
  assert.deepEqual(found("qa-ts", [["write", "e2e/cart.spec.ts", pw('  await expect(page.locator("#total")).toHaveText("42");\n')]]), [
    msg("e2e/cart.spec.ts", "cart total", "42"),
  ]);
  assert.deepEqual(found("qa-ts", [["write", "e2e/cart.spec.ts", pw("  await expect(page).toHaveURL('https://shop.test/cart?page=7');\n")]]), [
    msg("e2e/cart.spec.ts", "cart total", "7"),
  ]);
  assert.deepEqual(found("qa-ts", [["write", "e2e/cart.spec.ts", pw("  expect(this.#count).toBe(12);\n")]]), [msg("e2e/cart.spec.ts", "cart total", "12")]);
  assert.deepEqual(found("qa-python", [["write", "tests/test_cart.py", 'def test_badge():\n    assert badge.text == "#3 of 15"\n']]), [
    msg("tests/test_cart.py", "test_badge", "3, 15"),
  ]);
  assert.deepEqual(
    found("qa-ts", [["write", "e2e/cart.spec.ts", pw('  await expect(page.locator("#total")).toHaveText("42"); // 42 = 6 × 7, spec 3.2\n')]]),
    [],
  );
});

test("a commented-out assertion inside a block comment does not count (0.1.120)", () => {
  assert.deepEqual(found("qa-ts", [["write", "e2e/cart.spec.ts", pw("  /*\n   * expect(total).toBe(1499);\n   */\n  expect(total).toBe(PRICE);\n")]]), []);
  assert.deepEqual(found("qa-ts", [["write", "e2e/cart.spec.ts", pw("  expect(total).toBe(1499); /* cents */\n")]]), []);
});

test("a number an Edit puts into an assertion is reported; the same number in later versions only once", () => {
  const named = pw("  expect(total).toBe(PRICE);\n");
  assert.deepEqual(found("qa-ts", [["write", "e2e/cart.spec.ts", named]]), []);
  assert.deepEqual(
    found("qa-ts", [
      ["write", "e2e/cart.spec.ts", named],
      ["edit", "e2e/cart.spec.ts", "toBe(PRICE)", "toBe(1499)"],
    ]),
    [msg("e2e/cart.spec.ts", "cart total", "1499")],
  );
  assert.deepEqual(
    found("qa-ts", [
      ["write", "e2e/cart.spec.ts", pw("  expect(total).toBe(1499);\n")],
      ["bash", "npx playwright test", "1 passed"],
      ["edit", "e2e/cart.spec.ts", "expect(total)", "expect(cart.total)"],
    ]),
    [msg("e2e/cart.spec.ts", "cart total", "1499")],
  );
});

test("not run on qa-robot and qa-generic, which have no assertion patterns", () => {
  const robot = "*** Test Cases ***\nCart Total\n    Should Be Equal    ${total}    1499\n";
  assert.deepEqual(found("qa-robot", [["write", "tests/cart.robot", robot]]), []);
  assert.deepEqual(found("qa-generic", [["write", "tests/cart.test.js", pw("  expect(total).toBe(1499);\n")]]), []);
  assert.equal(Lens.profile("qa-robot").checks.includes("magic_number"), false);
  assert.equal(Lens.profile("qa-generic").checks.includes("magic_number"), false);
});
