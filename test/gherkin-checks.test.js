"use strict";
/* Gherkin checks that finding-pipeline.test.js does not pin: outline_no_examples, bloated_background,
   duplicate_step_text. scenario_no_then stays in finding-pipeline. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");

const { Lens } = load();

const found = (file, content, check) =>
  Lens.gherkinChecks([{ seq: 1, kind: "write", file, new_content: content }])
    .filter((f) => f.check === check)
    .map((f) => `${f.severity}: ${f.message}`);

test("outline_no_examples: a Scenario Outline with no Examples rows", () => {
  const body = "Feature: Pay\n  Scenario Outline: pay with <card>\n    Given a cart\n    When she pays with <card>\n    Then the order is paid\n";
  assert.deepEqual(found("features/pay.feature", body, "outline_no_examples"), [
    "high: features/pay.feature: pay with <card> — Scenario Outline with no Examples rows, so it never actually runs",
  ]);
  const withRows = body + "    Examples:\n      | card |\n      | visa |\n";
  assert.deepEqual(found("features/pay.feature", withRows, "outline_no_examples"), []);
});

test("bloated_background: more than six steps", () => {
  const steps = Array.from({ length: 7 }, (_, i) => `    Given step ${i + 1}`).join("\n");
  const body = `Feature: Shop\n  Background:\n${steps}\n  Scenario: buy\n    Given a cart\n    When she pays\n    Then paid\n`;
  assert.deepEqual(found("features/shop.feature", body, "bloated_background"), [
    "medium: features/shop.feature: Background has 7 steps (> 6) — a lot for every scenario in the file to share",
  ]);
  const six = Array.from({ length: 6 }, (_, i) => `    Given step ${i + 1}`).join("\n");
  assert.deepEqual(found("features/shop.feature", `Feature: Shop\n  Background:\n${six}\n  Scenario: buy\n    Then paid\n`, "bloated_background"), []);
});

test("duplicate_step_text: two scenarios with the same steps", () => {
  const sc = (name) => `  Scenario: ${name}\n    Given a cart\n    When she pays\n    Then paid\n`;
  assert.deepEqual(found("features/pay.feature", `Feature: Pay\n${sc("visa")}${sc("mastercard")}`, "duplicate_step_text"), [
    "low: features/pay.feature: 2 scenarios share the exact same steps — visa, mastercard",
  ]);
  assert.deepEqual(
    found("features/pay.feature", `Feature: Pay\n${sc("visa")}  Scenario: empty\n    Given no items\n    Then the cart is empty\n`, "duplicate_step_text"),
    [],
  );
});
