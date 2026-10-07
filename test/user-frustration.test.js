"use strict";
/* user_frustration: a short user message that sounds like a correction, or the same request sent twice (the first 40
   characters). English and Russian. What must not count: a long dump, a new request that only shares a word, a phrase
   inside another word. */
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

test("a Russian correction, and a repeat of the first 40 characters", () => {
  assert.deepEqual(found(["Напиши тесты", "Не то, верни как было"]), [
    "medium: User frustration signal: “Не то, верни как было” — the agent misunderstood the task a step earlier",
  ]);
  // the same first 40 characters is a repeat, a difference at the 40th is not (the boundary from both sides)
  const head = "Please add a test for the cart discount ";
  assert.equal(head.length, 40);
  assert.deepEqual(found([head + "ten percent", head + "zero"]), [`medium: User repeated the same request: “${head}zero”`]);
  assert.deepEqual(found([head.slice(0, 39) + "s of ten percent", head.slice(0, 39) + "! zero"]), [], "different at the 40th");
});

test("not reported: a long paste, two different requests, or the phrase inside another word", () => {
  const dump = "again ".repeat(80);
  assert.deepEqual(found(["Write the tests", dump]), []);
  assert.deepEqual(found(["Cover the discount on the cart", "Then add a test for an empty cart"]), []);
  assert.deepEqual(found(["Write the tests", "wrongdoing is not what this word means"]), []);
});
