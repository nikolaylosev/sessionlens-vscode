"use strict";
/* tests_never_run: the session wrote tests (a file or a message with a test in it) and never ran the profile's test
   runner. One finding, at the last step that wrote tests. What must not count: any run of the runner, red or with
   output nothing could parse; code without a test in it; a session that wrote nothing. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");

const { Lens } = load();

// steps: ["write", file, content] | ["bash", command, output] | ["say", text] (the agent's message)
function transcript(steps) {
  const L = [JSON.stringify({ type: "user", message: { role: "user", content: "Write the tests" } })];
  steps.forEach(([kind, a, b], i) => {
    const id = "t" + i;
    if (kind === "say") return L.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: a }] } }));
    const [name, input] = kind === "write" ? ["Write", { file_path: a, content: b }] : ["Bash", { command: a }];
    L.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } }));
    L.push(
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: kind === "bash" ? b : "ok" }] } }),
    );
  });
  return L.join("\n");
}
const findings = (profile, steps) => {
  const cfg = Lens.profile(profile);
  return Lens.runChecks(Lens.importAny(transcript(steps), cfg), cfg).filter((f) => f.check === "tests_never_run");
};
const found = (profile, steps) => findings(profile, steps).map((f) => `${f.severity}: ${f.message}`);

const TS = "test('total', async () => {\n  expect(cart.total()).toBe(3);\n});\n";
const PY = "def test_total():\n    assert cart.total() == 3\n";
const never = (n) => `high: Tests written in ${n} message(s), never executed — a hypothesis about tests, not tests`;

test("tests written and never run: one finding, at the last step that wrote tests", () => {
  assert.deepEqual(found("qa-ts", [["write", "e2e/cart.spec.ts", TS]]), [never(1)]);
  const two = findings("qa-ts", [
    ["write", "e2e/cart.spec.ts", TS],
    ["write", "e2e/checkout.spec.ts", TS],
  ]);
  assert.deepEqual(
    two.map((f) => `${f.severity}: ${f.message}`),
    [never(2)],
  );
  assert.equal(two[0].seq, 2, "the second write");
  assert.deepEqual(found("qa-python", [["write", "tests/test_cart.py", PY]]), [never(1)]);
  assert.deepEqual(found("qa-generic", [["write", "tests/test_cart.py", PY]]), [never(1)], "a process check: also in qa-generic");
});

test("a test shown only in a message counts as written (a chat session has no files)", () => {
  assert.deepEqual(found("qa-ts", [["say", "Here is the test:\n```ts\n" + TS + "```\n"]]), [never(1)]);
});

test("a command that is not the profile's test runner is not a run", () => {
  assert.deepEqual(
    found("qa-ts", [
      ["write", "e2e/cart.spec.ts", TS],
      ["bash", "npx tsc --noEmit", ""],
    ]),
    [never(1)],
  );
});

test("not reported: a run of the runner, red or unreadable; no test in the code; nothing written", () => {
  assert.deepEqual(
    found("qa-ts", [
      ["write", "e2e/cart.spec.ts", TS],
      ["bash", "npx playwright test", "  1 failed"],
    ]),
    [],
    "a red run is still a run",
  );
  assert.deepEqual(
    found("qa-ts", [
      ["write", "e2e/cart.spec.ts", TS],
      ["bash", "npx playwright test", "Error: something went wrong"],
    ]),
    [],
    "the runner ran, even if its output could not be parsed",
  );
  assert.deepEqual(
    found("qa-python", [
      ["write", "tests/test_cart.py", PY],
      ["bash", "pytest -q", "1 passed in 0.01s"],
    ]),
    [],
  );
  assert.deepEqual(found("qa-ts", [["write", "e2e/helpers.ts", "export const total = (xs) => xs.length;\n"]]), [], "a helper with no test in it");
  assert.deepEqual(found("qa-ts", [["say", "I will write the tests after the plan is approved."]]), []);
});
