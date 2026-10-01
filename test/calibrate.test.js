"use strict";
/* Phase 8, step 3: Lens.calibrate() after the merge, per check and source. What it may hide or demote (decided 01.10):
   regex ("formal"), the lint engines, Gherkin, and the two heuristic spec checks; never no_spec, spec_uncovered or
   the model's ai_*. A check ticked on by hand on the Rules tab is never hidden. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { load, M } = require("./helpers");

const { Lens } = load();
const LensLint = require(M("lint.js"));

let seq = 0;
const F = (check, source, severity = "high") => ({ check, severity, seq: ++seq, message: `${check} from ${source} #${seq}`, source });
const OFF = { ok: 1, fp: 9 },
  DEMOTED = { ok: 4, fp: 6 },
  GOOD = { ok: 9, fp: 1 };
const shown = (r) => r.findings.map((f) => `${f.check}/${f.source}`);
const hidden = (r) => r.hidden.map((f) => `${f.check}/${f.source}`);

test("a mixed check: a poor engine record hides the engine's findings, not the regex ones of the same name", () => {
  const r = Lens.calibrate([F("weak_assert", "formal"), F("weak_assert", "lint")], { weak_assert: { formal: GOOD, lint: OFF } });
  assert.deepEqual(shown(r), ["weak_assert/formal"]);
  assert.deepEqual(hidden(r), ["weak_assert/lint"]);
  assert.deepEqual(r.suppressed, [{ check: "weak_assert", source: "lint", precision: 0.1, n: 10 }]);
  // and the other way round
  const back = Lens.calibrate([F("weak_assert", "formal"), F("weak_assert", "lint")], { weak_assert: { formal: OFF, lint: GOOD } });
  assert.deepEqual(shown(back), ["weak_assert/lint"]);
});

test("engines, Gherkin and the two heuristic spec checks are calibrated now", () => {
  const list = [
    F("raw_locator", "lint", "low"),
    F("scenario_no_then", "gherkin"),
    F("test_without_requirement", "spec", "medium"),
    F("out_of_scope_tested", "spec", "medium"),
  ];
  const calib = {
    raw_locator: { lint: OFF },
    scenario_no_then: { gherkin: OFF },
    test_without_requirement: { spec: OFF },
    out_of_scope_tested: { spec: DEMOTED },
  };
  const r = Lens.calibrate(list, calib);
  assert.deepEqual(hidden(r), ["raw_locator/lint", "scenario_no_then/gherkin", "test_without_requirement/spec"]);
  assert.deepEqual(
    r.findings.map((f) => [f.check, f.severity, f.demoted]),
    [["out_of_scope_tested", "low", true]],
  );
});

test("never calibrated: no_spec, spec_uncovered and the model's categories, whatever their record", () => {
  const list = [F("no_spec", "spec"), F("spec_uncovered", "spec"), F("ai_fragility", "ai", "medium")];
  const r = Lens.calibrate(list, { no_spec: { spec: OFF }, spec_uncovered: { spec: OFF }, ai_fragility: { ai: OFF } });
  assert.deepEqual(shown(r), ["no_spec/spec", "spec_uncovered/spec", "ai_fragility/ai"]);
  assert.deepEqual([r.hidden, r.suppressed], [[], []]);
  assert.ok(r.findings.every((f) => !f.demoted));
});

test("a finding with no source (a session saved before 0.1.112) is calibrated as regex", () => {
  const old = { check: "magic_number", severity: "low", seq: 1, message: "old" };
  assert.deepEqual(Lens.calibrate([old], { magic_number: { formal: OFF } }).hidden, [old]);
});

test("too few verdicts, or none for this source: nothing changes", () => {
  const r = Lens.calibrate([F("weak_assert", "lint")], { weak_assert: { formal: OFF, lint: { ok: 0, fp: 9 } } });
  assert.deepEqual(shown(r), ["weak_assert/lint"]);
});

test("a check ticked on by hand on the Rules tab is never hidden; one merely left at the default is", () => {
  const calib = { raw_locator: { lint: OFF } };
  assert.deepEqual(shown(Lens.calibrate([F("raw_locator", "lint")], calib, { raw_locator: { enabled: true } })), ["raw_locator/lint"]);
  assert.deepEqual(shown(Lens.calibrate([F("raw_locator", "lint")], calib, { raw_locator: { severity: "medium" } })), []);
});

test("a regex finding an engine supersedes does not come back when the engine's check is off", () => {
  // LensLint.merge() drops the regex sleep_or_skip_added once the engine parsed the file; calibrate() runs after it
  const base = LensLint.merge([Object.assign(F("sleep_or_skip_added", "formal"), { kind: "sleep" })], [F("sleep_or_skip_added", "lint")], "typescript");
  const r = Lens.calibrate(base, { sleep_or_skip_added: { lint: OFF, formal: GOOD } });
  assert.deepEqual([shown(r), hidden(r)], [[], ["sleep_or_skip_added/lint"]]);
});
