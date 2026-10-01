"use strict";
/* Phase 8, step 0: a check that calibration switched off must stay off when the sessions are analyzed again.
   checkStats (Lens.sessionSummary) counts only the findings a session has now; once a check is off its findings are
   gone, so the next calibStats() no longer sees their verdicts, the check drops back to "need" and comes back on the
   analysis after that (PHASE-8 §2.3). The real panel and host, as the Rules tab drives them. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { bootHost, openPage } = require("./host-panel");
const { load, M } = require("./helpers");
const { analyzeNode } = require("../perf/fixtures");

const ctx = Object.assign(load(), { LensSpec: require(M("spec.js")) });
const { Lens } = ctx;
const CHECK = "sleep_or_skip_added";

async function until(fn, ms = 10000) {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

// one qa-ts session with twelve fixed waits, each in a file of its own, every one marked False
function session() {
  const events = [];
  for (let i = 0; i < 12; i++)
    events.push({
      seq: i + 1,
      file: `e2e/t${i}.spec.ts`,
      new_content: `test('t${i}', async ({ page }) => {\n  await page.waitForTimeout(${1000 + i});\n});\n`,
    });
  const s = {
    id: "calibloop1",
    name: "calibration loop",
    task: "LOOP-1",
    profile: "qa-ts",
    created: "2026-06-01T00:00:00.000Z",
    events,
    findings: [],
    verdicts: {},
    spec: "",
    dropped: [],
    source_text: "",
    seg: null,
  };
  analyzeNode(ctx, s, {}, {});
  for (const f of s.findings) if (f.check === CHECK) s.verdicts[Lens.fkey(f)] = { v: "fp", note: "", at: "2026-06-01T00:00:00.000Z" };
  return s;
}

/* Three Rules edits, each of a check other than the one under test; each re-analyzes every session in the background.
   → what the stored session had of `check` after each: { after, findings, suppressed: [sources] } */
async function threeRulesEdits(s, check, { lint }) {
  const host = bootHost({
    globalState: {
      sessions: { [s.id]: s },
      settings: { profile: s.profile, lint, rulesTarget: "claude", modelPool: [], defaultModelId: null },
      ruleOverrides: {},
    },
  });
  const dir = path.join(host.context.globalStorageUri.fsPath, "sessions");
  const meta = () => JSON.parse(fs.readFileSync(path.join(dir, s.id + ".meta.json"), "utf8"));
  const stored = () => JSON.parse(fs.readFileSync(path.join(dir, s.id + ".json"), "utf8"));
  const sb = await openPage(host);
  await sb.ready();
  sb.document.querySelector('.tab[data-view="rules"]').dispatchEvent(new sb.window.MouseEvent("click", { bubbles: true }));
  await sb.idle();
  const overrides = {};
  const seen = [];
  for (const other of ["magic_number", "conditional_logic", "duplicate_assert"]) {
    const box = sb.document.querySelector(`.rule-row[data-check="${other}"] .r-enabled`);
    box.checked = false;
    box.dispatchEvent(new sb.window.Event("change", { bubbles: true }));
    overrides[other] = { enabled: false };
    const gen = Lens.analysisGen({ ruleOverrides: overrides, lint, epoch: 0 });
    await until(() => meta().analyzedGen === gen);
    const now = stored();
    seen.push({
      after: other,
      findings: now.findings.filter((f) => f.check === check).length,
      suppressed: (now.suppressed || []).filter((x) => x.check === check).map((x) => x.source),
    });
  }
  // the verdicts themselves are never lost: they stay in the session whether or not the findings are there
  assert.equal(Object.keys(stored().verdicts).length, Object.keys(s.verdicts).length);
  assert.deepEqual(sb.errors, []);
  sb.close();
  return seen;
}
const offEveryTime = (source) => ["magic_number", "conditional_logic", "duplicate_assert"].map((after) => ({ after, findings: 0, suppressed: [source] }));

test("a check switched off by calibration stays off when the sessions are analyzed again", async () => {
  const s = session();
  assert.ok(Object.keys(s.verdicts).length >= 10, `need at least 10 verdicts on ${CHECK}, got ${Object.keys(s.verdicts).length}`);
  assert.deepEqual(await threeRulesEdits(s, CHECK, { lint: false }), offEveryTime("formal"), "off after every analysis, not off and on in turn");
});

// phase 8: an engine's check is calibrated too, through the per-source stats of the summaries
test("an engine's check (Robot) switched off by calibration stays off too", async () => {
  global.LensLintRobot = require(M("lint-robot.js"));
  const LensLint = require(M("lint.js"));
  // the engine reports at most three of a kind per file: four files of three empty test cases
  const events = [0, 1, 2, 3].map((i) => ({
    seq: i + 1,
    file: `tests/t${i}.robot`,
    new_content: "*** Test Cases ***\nCase A\n\nCase B\n\nCase C\n\nLast\n    Should Be Equal    1    1\n",
  }));
  const s = { id: "calibloop2", name: "robot", task: "LOOP-2", profile: "qa-robot", created: "2026-06-01T00:00:00.000Z", events, verdicts: {} };
  s.findings = LensLint.run(s, Lens.profile("qa-robot"), {}).findings;
  for (const f of s.findings) if (f.check === "empty_test_case") s.verdicts[Lens.fkey(f)] = { v: "fp", note: "", at: "2026-06-01T00:00:00.000Z" };
  assert.equal(Object.keys(s.verdicts).length, 12);
  assert.deepEqual(await threeRulesEdits(s, "empty_test_case", { lint: true }), offEveryTime("lint"));
});

test("an off check: calibrate hides its findings instead of dropping them; sessionSummary counts them", () => {
  const s = session();
  const calib = { [CHECK]: { formal: { ok: 0, fp: 12 } } };
  const res = Lens.calibrate(Lens.runChecks(s.events, Lens.profile("qa-ts")), calib);
  assert.equal(res.findings.filter((f) => f.check === CHECK).length, 0, "not shown");
  assert.equal(res.hidden.filter((f) => f.check === CHECK).length, 12, "kept aside");
  assert.deepEqual(
    res.suppressed.map((x) => x.check),
    [CHECK],
  );
  const st = Lens.sessionSummary(Object.assign({}, s, { findings: res.findings, calibHidden: res.hidden })).checkStats[CHECK];
  assert.deepEqual(st, { total: 12, ok: 0, fp: 12 }, "the verdicts still count");
});
