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

test("a check switched off by calibration stays off when the sessions are analyzed again", async () => {
  const s = session();
  assert.ok(Object.keys(s.verdicts).length >= 10, `need at least 10 verdicts on ${CHECK}, got ${Object.keys(s.verdicts).length}`);
  const host = bootHost({
    globalState: {
      sessions: { [s.id]: s },
      settings: { profile: "qa-ts", lint: false, rulesTarget: "claude", modelPool: [], defaultModelId: null },
      ruleOverrides: {},
    },
  });
  const dir = path.join(host.context.globalStorageUri.fsPath, "sessions");
  const meta = () => JSON.parse(fs.readFileSync(path.join(dir, s.id + ".meta.json"), "utf8"));
  const stored = () => JSON.parse(fs.readFileSync(path.join(dir, s.id + ".json"), "utf8"));
  const sb = await openPage(host);
  await sb.ready();
  const click = (sel) => sb.document.querySelector(sel).dispatchEvent(new sb.window.MouseEvent("click", { bubbles: true }));
  click('.tab[data-view="rules"]');
  await sb.idle();

  // each Rules edit re-analyzes every session in the background; the check under test is never the one edited
  const overrides = {};
  const edits = ["magic_number", "conditional_logic", "duplicate_assert"];
  const seen = [];
  for (const other of edits) {
    const box = sb.document.querySelector(`.rule-row[data-check="${other}"] .r-enabled`);
    box.checked = false;
    box.dispatchEvent(new sb.window.Event("change", { bubbles: true }));
    overrides[other] = { enabled: false };
    const gen = Lens.analysisGen({ ruleOverrides: overrides, lint: false, epoch: 0 });
    await until(() => meta().analyzedGen === gen);
    const now = stored();
    seen.push({
      after: other,
      findings: now.findings.filter((f) => f.check === CHECK).length,
      suppressed: (now.suppressed || []).some((x) => x.check === CHECK),
    });
  }
  // the verdicts themselves are never lost: they stay in the session whether or not the findings are there
  assert.equal(Object.keys(stored().verdicts).length, Object.keys(s.verdicts).length);
  assert.deepEqual(
    seen,
    edits.map((after) => ({ after, findings: 0, suppressed: true })),
    "off after every analysis, not off and on in turn",
  );
  assert.deepEqual(sb.errors, []);
  sb.close();
});

test("an off check: runChecks hides its findings instead of not running it; sessionSummary counts them", () => {
  const s = session();
  const calib = { [CHECK]: { ok: 0, fp: 12 } };
  const res = Lens.runChecks(s.events, Lens.profile("qa-ts"), calib);
  assert.equal(res.filter((f) => f.check === CHECK).length, 0, "not shown");
  assert.equal(res.hidden.filter((f) => f.check === CHECK).length, 12, "kept aside");
  assert.deepEqual(
    res.suppressed.map((x) => x.check),
    [CHECK],
  );
  const st = Lens.sessionSummary(Object.assign({}, s, { findings: [...res], calibHidden: res.hidden })).checkStats[CHECK];
  assert.deepEqual(st, { total: 12, ok: 0, fp: 12 }, "the verdicts still count");
});
