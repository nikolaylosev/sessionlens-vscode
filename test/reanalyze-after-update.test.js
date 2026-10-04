"use strict";
/* 0.1.116: an update analyzes the stored sessions again. Until then the analysis generation hashed only the Rules
   overrides, the ESLint switch and the epoch, so a session analyzed by an older version kept that version's findings:
   the checks of 0.1.113 and 0.1.114 never showed up in it until a Rules edit. Now the version of the analysis is part
   of the generation, and carryVerdicts() keeps a verdict on a finding the new version words differently. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { bootHost, openPage } = require("./host-panel");
const { createStore } = require("../store.js");
const { load } = require("./helpers");
const PKG = require("../package.json");

const { Lens } = load();
const cfg = Lens.profile("qa-ts");

// the generation as 0.1.115 computed it, for the same inputs (no version in it)
function genOf115({ ruleOverrides = {}, lint = true, epoch = 0 } = {}) {
  const src = JSON.stringify({ e: epoch, l: lint, r: ruleOverrides });
  let h = 0x811c9dc5;
  for (let i = 0; i < src.length; i++) {
    h ^= src.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ("0000000" + h.toString(16)).slice(-8);
}
const EVENTS = [{ seq: 1, kind: "write", file: "e2e/a.spec.ts", new_content: "test('a', async ({ page }) => {\n  await page.waitForTimeout(3000);\n});\n" }];
const at = "2026-09-01T00:00:00.000Z";

test("the analysis version is package.json's, so a release always analyzes the stored sessions again", () => {
  assert.equal(Lens.ANALYSIS_VERSION, PKG.version);
  assert.notEqual(Lens.analysisGen({ lint: false }), genOf115({ lint: false }), "the version is in the generation");
  assert.equal(genOf115({ lint: false }), genOf115({ lint: false }));
});

test("carryVerdicts: a verdict follows its finding to the new wording, the same check and step only", () => {
  const f = (check, seq, message) => ({ check, seq, message, severity: "high", source: "formal" });
  const s = {
    findings: [f("sleep_or_skip_added", 1, "e2e/a.spec.ts: skip / retry added"), f("weak_assert", 2, "e2e/a.spec.ts: weak")],
    calibHidden: [f("magic_number", 3, "e2e/a.spec.ts: magic 3000 now")],
    verdicts: {
      [Lens.fkey(f("sleep_or_skip_added", 1, "e2e/a.spec.ts: skip / xfail / retry added"))]: { v: "fp", note: "x", at },
      [Lens.fkey(f("magic_number", 3, "e2e/a.spec.ts: magic 3000"))]: { v: "fp", note: "", at }, // a hidden finding
      [Lens.fkey(f("debug_leftover", 4, "e2e/a.spec.ts: page.pause()"))]: { v: "ok", note: "", at }, // gone for good
    },
  };
  assert.equal(Lens.carryVerdicts(s), 2);
  assert.deepEqual(s.verdicts[Lens.fkey(s.findings[0])], { v: "fp", note: "x", at });
  assert.ok(s.verdicts[Lens.fkey(s.calibHidden[0])]);
  assert.equal(Object.keys(s.verdicts).length, 3, "the finding that is gone keeps its verdict where it was");

  const two = {
    findings: [f("weak_assert", 2, "a.spec.ts: one"), f("weak_assert", 2, "a.spec.ts: two")],
    verdicts: { [Lens.fkey(f("weak_assert", 2, "a.spec.ts: old"))]: { v: "ok", note: "", at } },
  };
  assert.equal(Lens.carryVerdicts(two), 0, "two candidates: which one is unknown, nothing moves");
  const taken = {
    findings: [f("weak_assert", 2, "a.spec.ts: new")],
    verdicts: {
      [Lens.fkey(f("weak_assert", 2, "a.spec.ts: old"))]: { v: "fp", note: "", at },
      [Lens.fkey(f("weak_assert", 2, "a.spec.ts: new"))]: { v: "ok", note: "", at },
    },
  };
  assert.equal(Lens.carryVerdicts(taken), 0, "a finding with a verdict of its own keeps it");
  assert.equal(taken.verdicts[Lens.fkey(taken.findings[0])].v, "ok");
});

test("a session analyzed by 0.1.115 is analyzed again: the new checks show up and an old verdict moves with its finding", async () => {
  const now = Lens.runChecks(EVENTS, cfg).find((f) => f.check === "sleep_or_skip_added");
  const old = Object.assign({}, now, { message: now.message.replace(/^(.{20})/, "$1 (older wording)") });
  const s = {
    id: "old115",
    name: "analyzed by 0.1.115",
    task: "",
    profile: "qa-ts",
    created: at,
    events: EVENTS,
    findings: [old],
    verdicts: { [Lens.fkey(old)]: { v: "fp", note: "seen", at } },
    spec: "",
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sl-reanalyze-"));
  const st = createStore({ dir: path.join(dir, "sessions") });
  await st.open();
  await st.put(s, { analyzedGen: genOf115({ lint: false }) });
  const host = bootHost({
    storageDir: dir,
    globalState: { storageVersion: 2, settings: { profile: "qa-ts", lint: false, rulesTarget: "claude", modelPool: [], defaultModelId: null } },
  });
  const sb = await openPage(host);
  await sb.ready();
  /* the sidebar's background pass. Watched with refreshIfChanged(), which only reads: open() in the loop acted as a
     second window starting up, removed the host's unfinished write (*.tmp) or rebuilt the summary between the
     session and its summary, and the pass, which does not retry, left the old generation on disk (CI, PR #65). */
  const gen = () => st.refreshIfChanged().then(() => st.meta(s.id).analyzedGen);
  for (let t = Date.now(); (await gen()) !== Lens.analysisGen({ lint: false }); await new Promise((r) => setTimeout(r, 50)))
    if (Date.now() - t > 8000) throw new Error("not analyzed again");
  const r = await st.get(s.id);
  const checks = r.session.findings.map((f) => f.check).sort();
  assert.deepEqual(checks, ["no_spec", "sleep_or_skip_added", "stop_markers_missing", "tests_never_run"]);
  assert.deepEqual(r.session.verdicts, { [Lens.fkey(now)]: { v: "fp", note: "seen", at } }, "the verdict moved to the new wording");
  assert.equal(r.meta.sourceStats.sleep_or_skip_added.formal.fp, 1, "and still counts for calibration");
  assert.deepEqual(sb.errors, []);
  sb.close();
});
