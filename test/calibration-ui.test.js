"use strict";
/* Phase 8, step 4: what the panel shows of calibration per check and source. A session with prepared findings and
   verdicts is put in the store already analyzed with the current rules, so the panel shows it as it is. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { bootHost, openPage } = require("./host-panel");
const { createStore } = require("../store.js");
const { load } = require("./helpers");

const { Lens } = load();

// n findings of one check and source, the first `ok` of them confirmed and the rest marked False
function block(check, source, n, ok) {
  const findings = [],
    verdicts = {};
  for (let i = 0; i < n; i++) {
    const f = { check, severity: "medium", seq: i + 1, message: `${check} ${source} ${i}`, source };
    findings.push(f);
    verdicts[Lens.fkey(f)] = { v: i < ok ? "ok" : "fp", note: "", at: "2026-06-01T00:00:00.000Z" };
  }
  return { findings, verdicts };
}

async function panel() {
  const blocks = [
    block("weak_assert", "formal", 10, 9), // ok
    block("weak_assert", "lint", 10, 1), // off: the engine only
    block("raw_locator", "lint", 10, 1), // off, but ticked on by hand
    block("magic_number", "formal", 10, 4), // demoted, with a severity set by hand
    block("ai_fragility", "ai", 10, 1), // the model: never calibrated
    block("spec_uncovered", "spec", 10, 1), // a fact: never calibrated
    block("test_without_requirement", "spec", 3, 1), // calibrated, too few verdicts
  ];
  const ruleOverrides = { raw_locator: { enabled: true }, magic_number: { severity: "high" } };
  const s = {
    id: "calibui1",
    name: "calibration ui",
    task: "UI-1",
    profile: "qa-ts",
    created: "2026-06-01T00:00:00.000Z",
    events: [],
    findings: blocks.flatMap((b) => b.findings),
    verdicts: Object.assign({}, ...blocks.map((b) => b.verdicts)),
    suppressed: [{ check: "weak_assert", source: "lint", precision: 0.1, n: 10 }],
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sl-calibui-"));
  const st = createStore({ dir: path.join(dir, "sessions") });
  await st.open();
  await st.put(s, { analyzedGen: Lens.analysisGen({ ruleOverrides, lint: false, epoch: 0 }) });
  const host = bootHost({
    storageDir: dir,
    globalState: { storageVersion: 2, settings: { profile: "qa-ts", lint: false, rulesTarget: "claude", modelPool: [], defaultModelId: null }, ruleOverrides },
  });
  return { host, s };
}

const show = async (p, view) => {
  p.document.querySelector(`.tab[data-view="${view}"]`).dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
  await p.idle();
};

test("the Calibration table: one row per check and source, with the status calibration really applies", async () => {
  const { host } = await panel();
  const sb = await openPage(host);
  await sb.ready();
  await show(sb, "calib");
  const [head, ...rows] = [...sb.document.querySelectorAll("#precision tr")].map((tr) => [...tr.children].map((td) => td.textContent));
  assert.deepEqual(head, ["check", "source", "total", "confirmed", "false", "precision", "status"]);
  const status = Object.fromEntries(rows.map((r) => [`${r[0]}/${r[1]}`, r[6]]));
  assert.deepEqual(status, {
    "weak_assert/regex": "ok",
    "weak_assert/eslint": "disabled",
    "raw_locator/eslint": "on by hand",
    "magic_number/regex": "demoted",
    "ai_fragility/model": "not calibrated",
    "spec_uncovered/spec": "not calibrated",
    "test_without_requirement/spec": "need 7 more",
  });
  const why = (check, src) =>
    [...sb.document.querySelectorAll("#precision tr")].find((tr) => tr.children[0].textContent === check && tr.children[1].textContent === src).lastElementChild
      .title;
  assert.match(why("ai_fragility", "model"), /depends on the model and the prompt/);
  assert.match(why("spec_uncovered", "spec"), /A fact, not a guess/);
  assert.match(why("raw_locator", "eslint"), /you ticked it on/);
  assert.equal(why("weak_assert", "regex"), "", "no tooltip on an ordinary row");
  assert.deepEqual(sb.errors, []);
  sb.close();
});

test("the Rules tab: 'on by hand' next to a check calibration would switch off; ⓘ next to a demoted one", async () => {
  const { host } = await panel();
  const sb = await openPage(host);
  await sb.ready();
  await show(sb, "rules");
  const row = (check) => sb.document.querySelector(`.rule-row[data-check="${check}"]`);
  const badge = row("raw_locator").querySelector(".r-by-hand");
  assert.ok(badge, "raw_locator: on by hand");
  assert.match(badge.title, /eslint: precision 10%/);
  assert.equal(row("weak_assert").querySelector(".r-by-hand"), null, "off for one source but not ticked on by hand");
  assert.ok(row("magic_number").querySelector(".r-demoted"), "magic_number: demoted with a manual severity");
  assert.equal(row("raw_locator").querySelector(".r-demoted"), null);
  assert.deepEqual(sb.errors, []);
  sb.close();
});

test("a session's line of disabled checks names the source", async () => {
  const { host, s } = await panel();
  const tab = await openPage(host, { sessionId: s.id });
  await tab.ready();
  assert.equal(tab.document.querySelector("#suppressed").textContent, "Disabled for low precision: weak_assert (eslint, 10% / 10)");
  assert.deepEqual(tab.errors, []);
  tab.close();
});
