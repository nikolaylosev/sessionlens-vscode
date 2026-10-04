"use strict";
/* pass_claim_without_run: the agent says the tests pass, and in the 6 steps before that message there is no test run
   with a result, or the last one was red. What must not count: a claim after a green last run, a user who asks for
   passing tests, a message without a claim. The claim phrases are matched as substrings, so "bypassing" and
   "проходить" are reported too; that is a known false finding, not pinned here. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");

const { Lens } = load();

// steps: ["write", file, content] | ["bash", command, output] | ["say", text] (the agent) | ["user", text]
function transcript(steps) {
  const L = [JSON.stringify({ type: "user", message: { role: "user", content: "Write the tests" } })];
  steps.forEach(([kind, a, b], i) => {
    const id = "t" + i;
    if (kind === "say") return L.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: a }] } }));
    if (kind === "user") return L.push(JSON.stringify({ type: "user", message: { role: "user", content: a } }));
    const [name, input] = kind === "write" ? ["Write", { file_path: a, content: b }] : ["Bash", { command: a }];
    L.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } }));
    L.push(
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: kind === "bash" ? b : "ok" }] } }),
    );
  });
  return L.join("\n");
}
const findings = (steps) => {
  const cfg = Lens.profile("qa-ts");
  return Lens.runChecks(Lens.importAny(transcript(steps), cfg), cfg).filter((f) => f.check === "pass_claim_without_run");
};
const found = (steps) => findings(steps).map((f) => `${f.severity}: ${f.message}`);

const SPEC = ["write", "e2e/cart.spec.ts", "test('total', async () => {\n  expect(cart.total()).toBe(3);\n});\n"];
const RED = ["bash", "npx playwright test", "  1 passed\n  1 failed"];
const GREEN = ["bash", "npx playwright test", "  2 passed"];
const NO_RUN = "high: Claims tests pass, but no test run in the preceding steps";
const RED_RUN = "high: Claims tests pass while the last run was 1 passed / 1 failed";
const other = (n) => Array.from({ length: n }, (_, i) => ["write", `src/notes${i}.md`, "x\n"]);

test("a claim with no run before it: high, at the claim's step", () => {
  const f = findings([SPEC, ["say", "Done, all tests pass."]]);
  assert.deepEqual(
    f.map((x) => `${x.severity}: ${x.message}`),
    [NO_RUN],
  );
  assert.equal(f[0].seq, 2, "the message, not the write");
  assert.deepEqual(found([["say", "Готово, все тесты проходят."]]), [NO_RUN], "Russian claims are recognized");
});

test("a claim while the last run was red, also when an earlier run was green", () => {
  assert.deepEqual(found([SPEC, RED, ["say", "All tests pass now."]]), [RED_RUN]);
  assert.deepEqual(found([GREEN, RED, ["say", "Looks good, tests pass."]]), [RED_RUN], "the last run decides");
});

test("a run counts only within the 6 steps before the claim, and only with a result", () => {
  assert.deepEqual(found([GREEN, ...other(5), ["say", "All tests pass."]]), [], "the run is 6 steps back");
  assert.deepEqual(found([GREEN, ...other(6), ["say", "All tests pass."]]), [NO_RUN], "the run is 7 steps back");
  assert.deepEqual(
    found([
      ["bash", "npx playwright test", "Error: something went wrong"],
      ["say", "All tests pass."],
    ]),
    [NO_RUN],
    "no result to show",
  );
});

test("not reported: a claim after a green last run, a user asking for it, no claim at all", () => {
  assert.deepEqual(found([SPEC, GREEN, ["say", "All tests pass now."]]), []);
  assert.deepEqual(found([RED, GREEN, ["say", "Fixed, tests pass."]]), [], "red, then green: the last run decides");
  assert.deepEqual(found([["user", "Make sure all tests pass."]]), [], "the user's message is not the agent's claim");
  assert.deepEqual(found([SPEC, ["say", "I wrote the test, now I will run it."]]), []);
});
