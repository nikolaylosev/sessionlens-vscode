"use strict";
/* 0.1.116: what calibration hides is not hidden from the reports and the Sessions tree. Report .json lists the hidden
   findings with the record that hid them, the PR report names the hidden high ones, and the tree's line under a
   session counts them. The real panel and host. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { bootHost, openPage } = require("./host-panel");
const { createStore } = require("../store.js");
const { load } = require("./helpers");

const { Lens } = load();
const at = "2026-10-01T00:00:00.000Z";
const shown = { check: "pass_claim_without_run", severity: "high", seq: 2, message: "Claims tests pass, but no test run", source: "formal" };
const hiddenHigh = { check: "weak_assert", severity: "high", seq: 3, message: "e2e/a.spec.ts: weak assertion", source: "lint" };
const hiddenLow = { check: "magic_number", severity: "low", seq: 4, message: "e2e/a.spec.ts: magic number 3000" };
const session = (calibHidden, suppressed) => ({
  id: "hid1",
  name: "hidden findings",
  task: "TASK-9",
  profile: "qa-ts",
  created: at,
  events: [],
  findings: [shown],
  calibHidden,
  suppressed,
  verdicts: { [Lens.fkey(shown)]: { v: "ok", note: "", at } },
  spec: "",
});
const SUPPRESSED = [
  { check: "weak_assert", source: "lint", precision: 0.1, n: 10 },
  { check: "magic_number", source: "formal", precision: 0.2, n: 15 },
];

async function host(s) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sl-hid-"));
  const st = createStore({ dir: path.join(dir, "sessions") });
  await st.open();
  // analyzed with the current rules: the tab shows the session as stored, without analyzing it again
  await st.put(s, { analyzedGen: Lens.analysisGen({ ruleOverrides: {}, lint: false, epoch: 0 }) });
  return bootHost({
    storageDir: dir,
    globalState: { storageVersion: 2, settings: { profile: "qa-ts", lint: false, rulesTarget: "claude", modelPool: [], defaultModelId: null } },
  });
}
async function exported(s) {
  const h = await host(s);
  const p = await openPage(h, { sessionId: s.id });
  await p.ready();
  Object.defineProperty(p.window.navigator, "clipboard", { value: { writeText: async () => {} }, configurable: true });
  const file = async (sel, name) => {
    p.document.querySelector(sel).dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
    for (let t = Date.now(); Date.now() - t < 5000; await new Promise((r) => setTimeout(r, 20))) {
      const m = p.sent.find((x) => x.type === "save:file" && name.test(x.payload.name));
      if (m) return m.payload.content;
    }
    throw new Error("no " + name);
  };
  const json = JSON.parse(await file("#export-json", /\.json$/));
  const md = await file("#export-md", /\.md$/);
  assert.deepEqual(p.errors, []);
  p.close();
  return { json, md, h };
}

test("Report .json lists what calibration hides, with the record that hid it", async () => {
  const { json } = await exported(session([hiddenHigh, hiddenLow], SUPPRESSED));
  assert.deepEqual(
    json.findings.map((f) => f.check),
    ["pass_claim_without_run"],
  );
  assert.deepEqual(json.hiddenByCalibration, [
    { check: "weak_assert", severity: "high", seq: 3, message: hiddenHigh.message, source: "lint", precision: 0.1, verdicts: 10, verdict: null },
    { check: "magic_number", severity: "low", seq: 4, message: hiddenLow.message, source: "formal", precision: 0.2, verdicts: 15, verdict: null },
  ]);
});

test("the PR report names the hidden high findings and counts the rest; without any, no such section", async () => {
  const { md } = await exported(session([hiddenHigh, hiddenLow], SUPPRESSED));
  assert.match(
    md,
    /### Hidden by calibration \(low precision\)\n- 🔴 e2e\/a\.spec\.ts: weak assertion _\(seq 3\)_ — weak_assert, lint: precision 10% over 10 verdicts\n- and 1 medium or low finding\n/,
  );
  const none = await exported(session([], []));
  assert.doesNotMatch(none.md, /Hidden by calibration/);
  assert.deepEqual(none.json.hiddenByCalibration, []);
});

test("the Sessions tree counts the hidden findings next to the shown ones", async () => {
  const h = await host(session([hiddenHigh, hiddenLow], SUPPRESSED));
  const [item] = await h.registered.trees.sessionlensSessionsTree.getChildren();
  assert.equal(item.description, "qa-ts · 1 finding · 2 hidden by calibration · 1 verdict · 2026-10-01");
  const plain = await host(session([], []));
  const [p] = await plain.registered.trees.sessionlensSessionsTree.getChildren();
  assert.equal(p.description, "qa-ts · 1 finding · 1 verdict · 2026-10-01");
});
