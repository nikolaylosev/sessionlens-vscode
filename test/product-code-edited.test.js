"use strict";
/* product_code_edited (phase 10, step 4): an agent in a testing task changes the product code, worst of all right after
   a red run. What must not count: tests and test-side code inside src (a colocated test, test utils, fixtures, page
   objects, conftest.py), a runner config, files outside the profile's src_dirs, a file the approved plan names. After a red
   run, a run whose output is not in the transcript makes the finding medium; one whose output could not be parsed does
   not. */
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
    ["medium: shop/src/cart.ts: product code changed in a testing task", "medium: ~/shop/src/cart.ts: product code changed in a testing task"], // the home folder as ~ (0.1.124)
    "Claude Code started in a parent folder, or a path outside it",
  );
});

// a red run, then a re-run whose result is not known, then the change (0.1.123): output that could not be parsed is
// skipped, so the red run decides (high); output that is not in the transcript (output_missing, a Cursor import) makes
// the result unknown (medium), as in pass_claim_without_run. → [severities with unparsed output, with output_missing]
function afterUnknownRerun(profile, steps, check) {
  const cfg = Lens.profile(profile);
  const ev = Lens.importAny(transcript(steps), cfg);
  const sev = () =>
    Lens.runChecks(ev, cfg)
      .filter((f) => f.check === check)
      .map((f) => f.severity);
  const unparsed = sev();
  for (const e of ev) if (e.kind === "run_tests" && !e.tests) e.output_missing = true;
  return [unparsed, sev()];
}

test("a run with no parsed result: unparsed output is skipped, output_missing makes the result unknown (0.1.123)", () => {
  assert.deepEqual(
    found("qa-ts", [
      ["write", "e2e/cart.spec.ts"],
      ["bash", "npx playwright test", "browser launched"],
      ["write", "src/cart/total.ts"],
    ]),
    ["medium: src/cart/total.ts: product code changed in a testing task"],
    "no red run before it",
  );
  const steps = [
    ["write", "e2e/cart.spec.ts"],
    ["bash", "npx playwright test", "0 passed, 1 failed"],
    ["bash", "npx playwright test", "browser launched"],
    ["write", "src/cart/total.ts"],
  ];
  assert.deepEqual(afterUnknownRerun("qa-ts", steps, "product_code_edited"), [["high"], ["medium"]]);
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
