"use strict";
/* product_code_edited (phase 10, step 4): an agent in a testing task changes the product code, worst of all right after
   a red run. What must not count: tests and test-side code inside src (a colocated test, test utils, fixtures, page
   objects, conftest.py), a runner config, files outside the profile's src_dirs, a file the approved plan names. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");

const { Lens } = load();

// steps: ["write", file] | ["bash", command, output] | ["say", text] | ["user", text]
function transcript(steps) {
  const L = [JSON.stringify({ type: "user", message: { role: "user", content: "Write the tests" } })];
  steps.forEach(([kind, a, b], i) => {
    const id = "t" + i;
    if (kind === "say") return L.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: a }] } }));
    if (kind === "user") return L.push(JSON.stringify({ type: "user", message: { role: "user", content: a } }));
    const [name, input] = kind === "write" ? ["Write", { file_path: a, content: "export const x = 1;\n" }] : ["Bash", { command: a }];
    L.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } }));
    L.push(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: b || "ok" }] } }));
  });
  return L.join("\n");
}
const found = (profile, steps) => {
  const cfg = Lens.profile(profile);
  return Lens.runChecks(Lens.importAny(transcript(steps), cfg), cfg)
    .filter((f) => f.check === "product_code_edited")
    .map((f) => `${f.severity}: ${f.message}`);
};

test("product code changed: high right after a red run, medium otherwise; one finding per file", () => {
  assert.deepEqual(
    found("qa-ts", [
      ["write", "e2e/cart.spec.ts"],
      ["bash", "npx playwright test", "0 passed, 1 failed"],
      ["write", "src/cart/total.ts"],
      ["write", "src/cart/total.ts"],
    ]),
    ["high: src/cart/total.ts: product code changed in a testing task — right after a failing run (seq 2)"],
  );
  assert.deepEqual(
    found("qa-ts", [
      ["write", "src/components/Cart.tsx"],
      ["write", "e2e/cart.spec.ts"],
    ]),
    ["medium: src/components/Cart.tsx: product code changed in a testing task"],
  );
  assert.deepEqual(
    found("qa-java", [
      ["bash", "mvn test", "Tests run: 3, Failures: 1, Errors: 0"],
      ["write", "src/main/java/shop/Cart.java"],
    ]),
    ["high: src/main/java/shop/Cart.java: product code changed in a testing task — right after a failing run (seq 1)"],
  );
  assert.deepEqual(found("qa-python", [["write", "app/cart.py"]]), ["medium: app/cart.py: product code changed in a testing task"]);
  assert.deepEqual(
    found("qa-ts", [
      ["write", "shop/src/cart.ts"],
      ["write", "/home/me/shop/src/cart.ts"],
      ["write", "shop/e2e/src/helper.ts"],
    ]),
    ["medium: shop/src/cart.ts: product code changed in a testing task", "medium: /home/me/shop/src/cart.ts: product code changed in a testing task"],
    "Claude Code started in a parent folder, or a path outside it",
  );
});

test("not product code: tests and test-side code in src, a runner config, other folders, non-code files", () => {
  const none = (profile, files, why) =>
    assert.deepEqual(
      found(
        profile,
        files.map((f) => ["write", f]),
      ),
      [],
      why,
    );
  none("qa-ts", ["src/cart/total.test.ts", "src/__tests__/cart.ts", "src/test-utils/render.tsx", "src/mocks/handlers.ts"], "test-side in src");
  none("qa-ts", ["src/pages/CartPage.ts", "src/fixtures/cart.ts", "src/support/commands.ts"], "page objects, fixtures, support");
  none("qa-ts", ["playwright.config.ts", "scripts/seed.ts", "e2e/cart.spec.ts", "src/data/prices.json"], "config, other folders, json");
  none("qa-python", ["src/conftest.py", "tests/test_cart.py"], "conftest, tests");
  none("qa-java", ["src/test/java/shop/CartTest.java", "src/test/java/shop/CartFixtures.java"], "Java test sources");
  none("qa-robot", ["resources/keywords.resource"], "Robot: its src_dirs hold keywords, not the product");
});

test("a file the approved plan names is not reported; an unapproved plan does not count", () => {
  const plan = ["say", "PLAN\n| Requirement | Test |\n|---|---|\n| R1 | e2e/cart.spec.ts |\nAlso add data-testid to src/cart/Total.tsx"];
  assert.deepEqual(found("qa-ts", [plan, ["user", "ok"], ["write", "src/cart/Total.tsx"]]), []);
  assert.deepEqual(found("qa-ts", [plan, ["write", "src/cart/Total.tsx"]]), ["medium: src/cart/Total.tsx: product code changed in a testing task"]);
});
