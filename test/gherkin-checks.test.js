"use strict";
/* The Gherkin checks: outline_no_examples, bloated_background, duplicate_step_text, scenario_no_then (also one case in
   finding-pipeline.test.js).

   Since 0.1.121 (gaps found on 5 Oct 2026): the keywords in Russian too, the synonyms Example, Scenario Template and
   Scenarios, a doc string's lines are text and not steps, and a scenario with "*" steps is not reported for a missing
   Then ("*" may stand for it). */
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

const pay = (steps, name = "pay") => `Feature: Pay\n  Scenario: ${name}\n${steps.map((x) => "    " + x).join("\n")}\n`;
const NO_THEN = (name) => `high: features/pay.feature: ${name} — no Then step: nothing in the scenario is actually verified`;

test("scenario_no_then: a scenario with no Then step, high; one finding per scenario", () => {
  assert.deepEqual(found("features/pay.feature", pay(["Given a cart", "When she pays"]), "scenario_no_then"), [NO_THEN("pay")]);
  assert.deepEqual(
    found("features/pay.feature", pay(["Given x"], "a") + `  Scenario: b\n    Given y\n    Then z\n  Scenario: c\n    When w\n`, "scenario_no_then"),
    [NO_THEN("a"), NO_THEN("c")],
  );
});

test("scenario_no_then: a Then step counts, with And after it, and inside a Rule", () => {
  assert.deepEqual(
    found("features/pay.feature", pay(["Given a cart", "When she pays", "Then the order is paid", "And a mail is sent"]), "scenario_no_then"),
    [],
  );
  assert.deepEqual(
    found(
      "features/pay.feature",
      "Feature: Pay\n  Rule: cards\n    Scenario: pay\n      Given a cart\n      When she pays\n      Then paid\n",
      "scenario_no_then",
    ),
    [],
  );
});

test("scenario_no_then: a Then in the Background or in a comment does not count", () => {
  assert.deepEqual(
    found("features/pay.feature", "Feature: Pay\n  Background:\n    Then the shop is open\n  Scenario: pay\n    When she pays\n", "scenario_no_then"),
    [NO_THEN("pay")],
  );
  assert.deepEqual(found("features/pay.feature", pay(["Given a cart", "# Then paid"]), "scenario_no_then"), [NO_THEN("pay")]);
});

test("Gherkin in Russian: scenarios, steps, outlines and examples are read (0.1.121)", () => {
  const ru = (body) => `# language: ru\nФункция: Оплата\n${body}`;
  assert.deepEqual(found("features/pay.feature", ru("  Сценарий: оплата\n    Дано корзина\n    Когда она платит\n"), "scenario_no_then"), [NO_THEN("оплата")]);
  assert.deepEqual(
    found(
      "features/pay.feature",
      ru("  Сценарий: оплата\n    Допустим корзина\n    Если она платит\n    То заказ оплачен\n    И письмо отправлено\n"),
      "scenario_no_then",
    ),
    [],
  );
  const outline = ru("  Структура сценария: оплата <карта>\n    Дано корзина\n    Тогда оплачено картой <карта>\n");
  assert.deepEqual(found("features/pay.feature", outline, "outline_no_examples"), [
    "high: features/pay.feature: оплата <карта> — Scenario Outline with no Examples rows, so it never actually runs",
  ]);
  assert.deepEqual(found("features/pay.feature", outline + "    Примеры:\n      | карта |\n      | visa |\n", "outline_no_examples"), []);
  const bg = ru("  Предыстория:\n" + Array.from({ length: 7 }, (_, k) => `    Дано шаг ${k + 1}`).join("\n") + "\n  Сценарий: a\n    Тогда b\n");
  assert.deepEqual(found("features/pay.feature", bg, "bloated_background").length, 1);
});

test("the synonyms: Example, Scenario Template, Scenarios (0.1.121)", () => {
  assert.deepEqual(found("features/pay.feature", "Feature: Pay\n  Example: pay\n    Given a cart\n    When she pays\n", "scenario_no_then"), [NO_THEN("pay")]);
  const tpl = "Feature: Pay\n  Scenario Template: pay with <card>\n    Given a cart\n    Then paid with <card>\n";
  assert.deepEqual(found("features/pay.feature", tpl, "outline_no_examples").length, 1);
  assert.deepEqual(found("features/pay.feature", tpl + "  Scenarios:\n    | card |\n    | visa |\n", "outline_no_examples"), []);
});

test("a doc string's lines are text, not steps (0.1.121)", () => {
  assert.deepEqual(found("features/pay.feature", pay(["Given a note", '  """', "  Then nothing", '  """']), "scenario_no_then"), [NO_THEN("pay")]);
  assert.deepEqual(found("features/pay.feature", pay(["Given a note", "  ```json", "  Then nothing", "  ```", "Then it is read"]), "scenario_no_then"), []);
});

test('a scenario with "*" steps is not reported for a missing Then: "*" may stand for it (0.1.121)', () => {
  assert.deepEqual(found("features/pay.feature", pay(["* a cart", "* she pays", "* the order is paid"]), "scenario_no_then"), []);
});
