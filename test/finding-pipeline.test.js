"use strict";
/* One finding per source, pushed through the same chain analyze() in app.js uses:
   detector → LensRules.apply(findings, overrides) → Lens.sortFindings.
   analyze() itself needs the DOM and app state, so the chain is rebuilt here by hand. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { load, M } = require("./helpers");

const { Lens, LensRules } = load();
// Robot is the one lint engine that runs in Node as is: synchronous, no WASM (tree-sitter engines load it
// asynchronously; the ESLint bundles only register browser globals). lint.js looks the engine up at call time.
global.LensLintRobot = require(M("lint-robot.js"));
const LensLint = require(M("lint.js"));
const LensSpec = require(M("spec.js"));
const LensAI = require(M("ai.js"));

const ev = (seq, file, new_content) => ({ seq, file, new_content });

function pipeline(findings, overrides = {}) {
  return Lens.sortFindings(LensRules.apply(findings, overrides));
}
function expectFinding(list, check, severity, group) {
  const f = list.find((x) => x.check === check);
  assert.ok(f, `${check} not found in ${JSON.stringify(list.map((x) => x.check))}`);
  assert.equal(f.severity, severity, `${check}: severity`);
  assert.equal(LensRules.groupOf(check), group, `${check}: group`);
  const text = LensRules.ruleText(check, {});
  assert.ok(text && !/^r_/.test(text), `${check}: rule text is empty or an unresolved key (${text})`);
  return f;
}

test("regex: sleep in a Playwright test → sleep_or_skip_added", () => {
  const cfg = Lens.profile("qa-ts");
  const events = [ev(1, "e2e/login.spec.ts", "test('login', async ({ page }) => {\n  await page.waitForTimeout(3000);\n});\n")];
  const res = Lens.runChecks(events, cfg, {});
  const f = expectFinding(pipeline([...res]), "sleep_or_skip_added", "high", "code");
  assert.equal(f.source, "formal", "a regex finding says so: per-source calibration (phase 8) tells it from an engine's");
});

test("regex: a check calibration switched off hides its findings, and they say formal too", () => {
  const cfg = Lens.profile("qa-ts");
  const events = [ev(1, "e2e/login.spec.ts", "test('login', async ({ page }) => {\n  await page.waitForTimeout(3000);\n});\n")];
  const res = Lens.calibrate(Lens.runChecks(events, cfg), { sleep_or_skip_added: { formal: { ok: 0, fp: 10 } } });
  assert.deepEqual(
    res.hidden.map((f) => [f.check, f.source]),
    [["sleep_or_skip_added", "formal"]],
  );
});

test("lint (Robot engine): empty test case → empty_test_case", () => {
  const cfg = Lens.profile("qa-robot");
  const session = { events: [ev(1, "tests/login.robot", "*** Test Cases ***\nLogin With Valid Creds\n\nLogout\n    Log    bye\n")] };
  const lr = LensLint.run(session, cfg, {});
  assert.equal(lr.ran, true, `robot engine did not run: ${lr.note || ""}`);
  const f = expectFinding(pipeline(lr.findings), "empty_test_case", "high", "robot");
  assert.equal(f.source, "lint");
});

test("gherkin: scenario without Then → scenario_no_then", () => {
  const events = [ev(1, "features/login.feature", "Feature: Login\n  Scenario: valid user\n    Given a registered user\n    When she logs in\n")];
  const f = expectFinding(pipeline(Lens.gherkinChecks(events)), "scenario_no_then", "high", "gherkin");
  assert.equal(f.source, "gherkin", "told apart from regex findings (source formal, §11.9)");
});

test("spec: no specification → no_spec, sorted above ordinary high findings", () => {
  const events = [ev(1, "e2e/a.spec.ts", "test('a', async () => { await page.waitForTimeout(1) })")];
  const sc = LensSpec.checks(LensSpec.parse(""), events, "typescript");
  const other = { check: "weak_assert", severity: "high", seq: 0, message: "x" };
  const out = pipeline([other, ...sc.findings]);
  const f = expectFinding(out, "no_spec", "high", "spec");
  assert.equal(f.source, "spec");
  assert.equal(out[0].check, "no_spec", "sortPriority from the registry puts no_spec first");
});

test("sortPriority: tests_never_run above no_spec above everything else", () => {
  const mk = (check, severity, seq) => ({ check, severity, seq, message: "" });
  const out = pipeline([mk("weak_assert", "high", 1), mk("no_spec", "high", 5), mk("tests_never_run", "high", 9)]);
  assert.deepEqual(
    out.map((f) => f.check),
    ["tests_never_run", "no_spec", "weak_assert"],
  );
});

test("ai: known category and an off-task one → ai_coverage + ai_other", () => {
  const raw = JSON.stringify([
    { check: "coverage", severity: "high", seq: 3, message: "Negative login path is not tested", evidence: "only happy path" },
    { check: "style_nitpick", severity: "low", seq: 4, message: "Variable names are long", evidence: "loginPageObjectInstance" },
  ]);
  const out = pipeline(LensAI.parseFindings(raw));
  expectFinding(out, "ai_coverage", "high", "ai");
  const other = expectFinding(out, "ai_other", "low", "ai");
  assert.equal(other.source, "ai");
  assert.notEqual(LensRules.ruleText("ai_other", {}), LensRules.ruleText("ai_coverage", {}), "ai_other has its own rule text");
});

test("apply(): a disabled check is dropped", () => {
  const f = { check: "weak_assert", severity: "high", seq: 1, message: "" };
  assert.deepEqual(pipeline([f], { weak_assert: { enabled: false } }), []);
});

test("apply(): manual severity applies, but not to a demoted finding", () => {
  const plain = { check: "magic_number", severity: "low", seq: 1, message: "" };
  const demoted = { check: "weak_assert", severity: "low", seq: 2, message: "", demoted: true };
  const out = pipeline([plain, demoted], { magic_number: { severity: "high" }, weak_assert: { severity: "high" } });
  assert.equal(out.find((f) => f.check === "magic_number").severity, "high");
  assert.equal(out.find((f) => f.check === "weak_assert").severity, "low");
});

test("calibLevel(): thresholds shared by calibrate() and the Rules panel", () => {
  assert.equal(Lens.calibLevel(undefined).level, "need");
  assert.equal(Lens.calibLevel({ ok: 2, fp: 8 }).level, "off");
  assert.equal(Lens.calibLevel({ ok: 4, fp: 6 }).level, "demoted");
  assert.equal(Lens.calibLevel({ ok: 5, fp: 5 }).level, "ok");
  const cfg = Lens.profile("qa-ts");
  const events = [ev(1, "e2e/a.spec.ts", "test('a', async ({ page }) => { await page.waitForTimeout(3000) })")];
  const found = Lens.runChecks(events, cfg);
  const demoted = Lens.calibrate(found, { sleep_or_skip_added: { formal: { ok: 4, fp: 6 } } }).findings;
  assert.ok(demoted.some((f) => f.check === "sleep_or_skip_added" && f.demoted && f.severity === "low"));
  const off = Lens.calibrate(found, { sleep_or_skip_added: { formal: { ok: 1, fp: 9 } } });
  assert.ok(!off.findings.some((f) => f.check === "sleep_or_skip_added"));
  assert.ok(off.suppressed.some((s) => s.check === "sleep_or_skip_added"));
});

test("fromJson(): reports ignored rows instead of dropping them silently", () => {
  const file = JSON.stringify({
    schema: "sessionlens/rules@1",
    rules: [
      { check: "weak_assert", severity: "low", enabled: false },
      { check: "renamed_long_ago", severity: "high" },
      { severity: "high" },
      { check: "magic_number", severity: "critical", rule: "no magic" },
    ],
  });
  const { overrides, ignored } = LensRules.fromJson(file);
  assert.deepEqual(overrides, { weak_assert: { severity: "low", enabled: false }, magic_number: { rule: "no magic" } });
  assert.deepEqual(ignored, [
    { index: 1, check: "renamed_long_ago", reason: "unknown_check" },
    { index: 2, check: "", reason: "no_check" },
    { index: 3, check: "magic_number", reason: "bad_severity" },
  ]);
  // round trip of our own export loses nothing
  const back = LensRules.fromJson(LensRules.toJson(overrides));
  assert.deepEqual(back.ignored, []);
});

test("unknown check names warn once, synthetic lint_ names never", () => {
  const warnings = [];
  const orig = console.warn;
  console.warn = (m) => warnings.push(m);
  try {
    LensRules.ruleText("no_such_check_xyz", {});
    LensRules.ruleText("no_such_check_xyz", {});
    void Lens.RULES["lint_valid-title"];
    void Lens.RULES["lint_prefer-web-first-assertions"];
  } finally {
    console.warn = orig;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no_such_check_xyz/);
});
