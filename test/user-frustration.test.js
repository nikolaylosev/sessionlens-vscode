"use strict";
/* user_frustration: a short user message that sounds like a correction, or the same request sent twice. What must
   not count: a long dump, a new request that only shares a word with the previous one. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");

const { Lens } = load();

function transcript(users) {
  return users.map((text) => JSON.stringify({ type: "user", message: { role: "user", content: text } })).join("\n");
}
const found = (users) => {
  const cfg = Lens.profile("qa-ts");
  return Lens.runChecks(Lens.importAny(transcript(users), cfg), cfg)
    .filter((f) => f.check === "user_frustration")
    .map((f) => `${f.severity}: ${f.message}`);
};

test("a correction phrase, and the same request twice", () => {
  assert.deepEqual(found(["Write the tests", "not what i asked"]), [
    "medium: User frustration signal: “not what i asked” — the agent misunderstood the task a step earlier",
  ]);
  assert.deepEqual(found(["Please cover the discount on the cart total", "Please cover the discount on the cart total"]), [
    "medium: User repeated the same request: “Please cover the discount on the cart total”",
  ]);
});

test("not reported: a long paste, or two different requests", () => {
  const dump = "again ".repeat(80);
  assert.deepEqual(found(["Write the tests", dump]), []);
  assert.deepEqual(found(["Cover the discount on the cart", "Then add a test for an empty cart"]), []);
});
