"use strict";
/* edit_churn: more writes/edits of one file than the profile threshold (4). What must not count: four writes,
   two files each edited a few times. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");

const { Lens } = load();

function transcript(steps) {
  const L = [JSON.stringify({ type: "user", message: { role: "user", content: "Write the tests" } })];
  steps.forEach(([kind, a, b], i) => {
    const id = "t" + i;
    const [name, input] = kind === "write" ? ["Write", { file_path: a, content: b || "export const x = 1;\n" }] : ["Bash", { command: a }];
    L.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } }));
    L.push(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } }));
  });
  return L.join("\n");
}
const found = (profile, steps) => {
  const cfg = Lens.profile(profile);
  return Lens.runChecks(Lens.importAny(transcript(steps), cfg), cfg)
    .filter((f) => f.check === "edit_churn")
    .map((f) => `${f.severity}: ${f.message}`);
};

test("five writes of one file: medium, counted at the fifth write", () => {
  const file = "e2e/cart.spec.ts";
  assert.deepEqual(
    found(
      "qa-ts",
      Array.from({ length: 5 }, () => ["write", file]),
    ),
    ["medium: e2e/cart.spec.ts: 5 edits in one session — poking instead of understanding"],
  );
});

test("not reported: four writes of one file, or five writes split across two files", () => {
  assert.deepEqual(
    found(
      "qa-ts",
      Array.from({ length: 4 }, () => ["write", "e2e/cart.spec.ts"]),
    ),
    [],
  );
  assert.deepEqual(
    found("qa-ts", [
      ["write", "e2e/a.spec.ts"],
      ["write", "e2e/b.spec.ts"],
      ["write", "e2e/a.spec.ts"],
      ["write", "e2e/b.spec.ts"],
      ["write", "e2e/a.spec.ts"],
    ]),
    [],
  );
});
