"use strict";
/* The method and process checks that only the demo session counted: fix_after_fail_without_triage,
   peeked_at_src_before_plan, assumption_instead_of_question, scope_creep, stop_markers_missing. Paths are relative to
   the session's folder, as the import makes them. What must not count is next to each case. Until 0.1.119 a src
   folder deeper in the path was not seen by peeked_at_src_before_plan, scope_creep compared paths with the plan's
   exactly and did not see a plan that named only e2e/ files, and an upper-case word that contains PLAN counted as a
   plan. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");

const { Lens } = load();

// steps: ["user", text] | ["say", text] (the agent) | ["write", file, content] | ["edit", file, old, new]
//        | ["read", file] | ["grep", path] | ["bash", command, output]
function transcript(steps) {
  const L = [];
  steps.forEach(([kind, a, b, c], i) => {
    const id = "t" + i;
    if (kind === "say") return L.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: a }] } }));
    if (kind === "user") return L.push(JSON.stringify({ type: "user", message: { role: "user", content: a } }));
    const tools = {
      write: ["Write", { file_path: a, content: b }],
      edit: ["Edit", { file_path: a, old_string: b, new_string: c }],
      read: ["Read", { file_path: a }],
      grep: ["Grep", { pattern: "total", path: a }],
      bash: ["Bash", { command: a }],
    };
    const [name, input] = tools[kind];
    L.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } }));
    L.push(
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: kind === "bash" ? b : "ok" }] } }),
    );
  });
  return L.join("\n");
}
const findings = (steps, check) => {
  const cfg = Lens.profile("qa-ts");
  return Lens.runChecks(Lens.importAny(transcript(steps), cfg), cfg).filter((f) => f.check === check);
};
const found = (steps, check) => findings(steps, check).map((f) => `${f.severity}: ${f.message}`);

const TASK = ["user", "Write tests for the cart"];
const PLAN = ["say", "PLAN\n| Requirement | Test |\n|---|---|\n| R1 | tests/cart.spec.ts |"];
const APPROVED = ["user", "Approved"];
const SPEC = "tests/cart.spec.ts";
const WRITE = ["write", SPEC, "test('total', async () => {\n  expect(cart.total()).toBe(3);\n});\n"];
const RED = ["bash", "npx playwright test", "  1 passed\n  1 failed\n  1) [chromium] › tests/cart.spec.ts:3:1 › total"];
const FIX = ["edit", SPEC, "toBe(3)", "toBe(4)"];

test("fix_after_fail_without_triage: an edit right after a red run, once per run", () => {
  const f = findings([TASK, WRITE, RED, FIX, ["edit", SPEC, "toBe(4)", "toBe(5)"]], "fix_after_fail_without_triage");
  assert.deepEqual(
    f.map((x) => `${x.severity}: ${x.message}`),
    ["high: Edited tests/cart.spec.ts right after a failure (seq 2) with no triage: product bug / test bug / spec defect"],
  );
  assert.equal(f[0].seq, 3, "the first edit after the run");
});

test("fix_after_fail_without_triage, not reported: triage first (English or Russian), the user speaks first, a green run, a non-code file", () => {
  assert.deepEqual(found([TASK, WRITE, RED, ["say", "Hypothesis: a test bug, the total includes tax."], FIX], "fix_after_fail_without_triage"), []);
  assert.deepEqual(found([TASK, WRITE, RED, ["say", "Гипотеза: ошибка теста."], FIX], "fix_after_fail_without_triage"), []);
  assert.deepEqual(found([TASK, WRITE, RED, ["user", "It is a test bug, fix it"], FIX], "fix_after_fail_without_triage"), []);
  assert.deepEqual(found([TASK, WRITE, ["bash", "npx playwright test", "  2 passed"], FIX], "fix_after_fail_without_triage"), []);
  assert.deepEqual(found([TASK, WRITE, RED, ["write", "NOTES.md", "todo\n"]], "fix_after_fail_without_triage"), []);
});

test("peeked_at_src_before_plan: product code read or searched before the plan was approved", () => {
  const peeked = (file) => `high: Read ${file} before the plan was approved — product code is off-limits during generation`;
  assert.deepEqual(found([TASK, ["read", "src/cart.ts"], WRITE], "peeked_at_src_before_plan"), [peeked("src/cart.ts")], "no plan at all");
  assert.deepEqual(found([TASK, PLAN, ["read", "src/cart.ts"], APPROVED], "peeked_at_src_before_plan"), [peeked("src/cart.ts")], "a plan, not yet approved");
  assert.deepEqual(found([TASK, ["grep", "src"], PLAN, APPROVED], "peeked_at_src_before_plan"), [peeked("src")]);
  assert.deepEqual(found([TASK, ["read", "./src/cart.ts"], PLAN, APPROVED], "peeked_at_src_before_plan"), [peeked("./src/cart.ts")]);
});

test("peeked_at_src_before_plan, not reported: after the approval, test code, a folder that only starts with src", () => {
  assert.deepEqual(found([TASK, PLAN, APPROVED, ["read", "src/cart.ts"]], "peeked_at_src_before_plan"), []);
  assert.deepEqual(found([TASK, ["read", SPEC], PLAN, APPROVED], "peeked_at_src_before_plan"), []);
  assert.deepEqual(found([TASK, ["read", "srcgen/cart.ts"], PLAN, APPROVED], "peeked_at_src_before_plan"), []);
});

test("assumption_instead_of_question: the agent assumes instead of asking, in English or Russian", () => {
  assert.deepEqual(found([TASK, ["say", "I assume the total includes tax. Writing the test now."]], "assumption_instead_of_question"), [
    "medium: Assumption instead of a question: “I assume the total includes tax”",
  ]);
  assert.deepEqual(found([TASK, ["say", "Скорее всего, скидка считается от суммы. Пишу тест."]], "assumption_instead_of_question"), [
    "medium: Assumption instead of a question: “Скорее всего, скидка считается от суммы”",
  ]);
});

test("assumption_instead_of_question, not reported: a question, code, the user, a word that only contains a phrase", () => {
  assert.deepEqual(found([TASK, ["say", "Does the total include tax? Please confirm."]], "assumption_instead_of_question"), []);
  assert.deepEqual(found([TASK, ["say", "Here:\n```ts\n// probably flaky\n```"]], "assumption_instead_of_question"), [], "inside a code block");
  assert.deepEqual(found([["user", "I assume you know the cart API"]], "assumption_instead_of_question"), []);
  for (const text of ["That is improbably slow.", "An unassuming helper.", "Элемент невидимо отрисован."])
    assert.deepEqual(found([TASK, ["say", text]], "assumption_instead_of_question"), [], text);
});

test("scope_creep: a file the approved plan does not name", () => {
  assert.deepEqual(found([TASK, PLAN, APPROVED, WRITE, ["write", "tests/checkout.spec.ts", "test('pay', () => {});\n"]], "scope_creep"), [
    "medium: Edited tests/checkout.spec.ts, which is not in the plan",
  ]);
});

test("scope_creep, not reported: a planned file, README.md, a plan that names no file", () => {
  assert.deepEqual(found([TASK, PLAN, APPROVED, WRITE, FIX], "scope_creep"), []);
  assert.deepEqual(found([TASK, PLAN, APPROVED, WRITE, ["write", "README.md", "# Tests\n"]], "scope_creep"), []);
  assert.deepEqual(found([TASK, ["say", "PLAN: cover the cart total"], APPROVED, ["write", "tests/x.spec.ts", "test('x', () => {});\n"]], "scope_creep"), []);
});

test("stop_markers_missing: code with no plan, or a plan with no stop for approval", () => {
  assert.deepEqual(found([TASK, WRITE], "stop_markers_missing"), ["medium: Code written without a plan"]);
  assert.deepEqual(
    found([TASK, ["say", "My plan is to write the tests."], APPROVED, WRITE], "stop_markers_missing"),
    ["medium: Code written without a plan"],
    "a plan is marked (PLAN, ПЛАН, a requirement table), not any mention of the word",
  );
  const f = findings([TASK, PLAN, WRITE], "stop_markers_missing");
  assert.deepEqual(
    f.map((x) => `${x.severity}: ${x.message}`),
    ["medium: Plan produced, but no stop and approval — straight to code"],
  );
  assert.equal(f[0].seq, 2, "the first write");
});

test("stop_markers_missing, not reported: an approved plan (also in Russian), no code at all", () => {
  assert.deepEqual(found([TASK, PLAN, APPROVED, WRITE], "stop_markers_missing"), []);
  assert.deepEqual(found([TASK, ["say", "ПЛАН\n| Требование | Тест |\n| R1 | tests/cart.spec.ts |"], ["user", "Ок"], WRITE], "stop_markers_missing"), []);
  assert.deepEqual(found([TASK, ["say", "Here is what I found."]], "stop_markers_missing"), []);
});

test("peeked_at_src_before_plan: a src folder deeper in the path (Claude Code started in a parent folder)", () => {
  const peeked = (file) => `high: Read ${file} before the plan was approved — product code is off-limits during generation`;
  assert.deepEqual(found([TASK, ["read", "shop/src/cart.ts"], PLAN, APPROVED], "peeked_at_src_before_plan"), [peeked("shop/src/cart.ts")]);
  assert.deepEqual(found([TASK, ["grep", "shop/src"], PLAN, APPROVED], "peeked_at_src_before_plan"), [peeked("shop/src")]);
  assert.deepEqual(found([TASK, ["read", "shop/tests/lib/cart-helpers.ts"], PLAN, APPROVED], "peeked_at_src_before_plan"), [], "test-side code under lib/");
  assert.deepEqual(found([TASK, ["read", "node_modules/zod/lib/index.js"], PLAN, APPROVED], "peeked_at_src_before_plan"), [], "a dependency");
});

test("scope_creep: a planned file under another prefix is in the plan; a plan that names only e2e/ or cypress/ files counts", () => {
  assert.deepEqual(found([TASK, PLAN, APPROVED, ["write", "./tests/cart.spec.ts", "test('a', () => {});\n"]], "scope_creep"), []);
  assert.deepEqual(found([TASK, PLAN, APPROVED, ["write", "shop/tests/cart.spec.ts", "test('a', () => {});\n"]], "scope_creep"), []);
  const e2ePlan = ["say", "PLAN\n| Requirement | Test |\n|---|---|\n| R1 | e2e/cart.spec.ts |"];
  assert.deepEqual(
    found(
      [TASK, e2ePlan, APPROVED, ["write", "e2e/cart.spec.ts", "test('a', () => {});\n"], ["write", "e2e/checkout.spec.ts", "test('b', () => {});\n"]],
      "scope_creep",
    ),
    ["medium: Edited e2e/checkout.spec.ts, which is not in the plan"],
  );
});

test("a plan is marked by PLAN or ПЛАН as a word, not inside another word; a requirement table still marks one", () => {
  for (const text of ["EXPLANATION: the cart needs tests", "The PLANNED work: cart tests", "ПЛАНИРОВАНИЕ тестов"])
    assert.deepEqual(found([TASK, ["say", text], APPROVED, WRITE], "stop_markers_missing"), ["medium: Code written without a plan"], text);
  for (const text of ["PLAN: cover the cart total", "## ПЛАН\nпокрыть сумму", "| Requirements | Test |\n| R1 | tests/cart.spec.ts |"])
    assert.deepEqual(found([TASK, ["say", text], APPROVED, WRITE], "stop_markers_missing"), [], text);
});
