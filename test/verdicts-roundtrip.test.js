"use strict";
/* 0.1.116: verdicts.json round trip. The export leaves out no verdict an "off" check keeps hidden (calibHidden), the
   import finds those findings too, and importing the same file twice does not count its rows twice. Only "ok" and
   "fp" count for calibration, as in Lens.sessionSummary. The real panel and host. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { bootHost, openPage } = require("./host-panel");
const { createStore } = require("../store.js");
const { load } = require("./helpers");

const { Lens } = load();
const cfg = Lens.profile("qa-ts");
const at = "2026-10-01T00:00:00.000Z";
const EVENTS = [{ seq: 1, kind: "write", file: "e2e/a.spec.ts", new_content: "test('a', async ({ page }) => {\n  await page.waitForTimeout(3000);\n});\n" }];

// a session whose sleep finding an "off" check hides, with a verdict on it and on a shown finding
function session(withVerdicts = true) {
  const all = Lens.runChecks(EVENTS, cfg);
  const sleep = all.find((f) => f.check === "sleep_or_skip_added");
  const shown = all.filter((f) => f !== sleep);
  const verdicts = withVerdicts ? { [Lens.fkey(sleep)]: { v: "fp", note: "", at }, [Lens.fkey(shown[0])]: { v: "ok", note: "", at } } : {};
  return { id: "rt1", name: "round trip", task: "", profile: "qa-ts", created: at, events: EVENTS, findings: shown, calibHidden: [sleep], verdicts, spec: "" };
}
async function host(sessions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sl-rt-"));
  const st = createStore({ dir: path.join(dir, "sessions") });
  await st.open();
  for (const s of sessions) await st.put(s, { analyzedGen: Lens.analysisGen({ ruleOverrides: {}, lint: false, epoch: 0 }) });
  const h = bootHost({
    storageDir: dir,
    globalState: { storageVersion: 2, settings: { profile: "qa-ts", lint: false, rulesTarget: "claude", modelPool: [], defaultModelId: null } },
  });
  const p = await openPage(h);
  await p.ready();
  return { dir, p };
}
async function until(fn, ms = 5000) {
  for (let t = Date.now(); !fn(); await new Promise((r) => setTimeout(r, 20))) if (Date.now() - t > ms) throw new Error("timed out");
}
async function importFile(p, rows) {
  const input = p.document.querySelector("#import-file");
  const file = new p.window.File([JSON.stringify(rows)], "verdicts.json", { type: "application/json" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  const before = p.document.querySelector("#import-status").textContent;
  input.dispatchEvent(new p.window.Event("change", { bubbles: true }));
  await until(() => p.document.querySelector("#import-status").textContent !== before);
  await p.idle();
  return p.document.querySelector("#import-status").textContent;
}
const external = (p) => {
  const m = p.sent.filter((x) => x.type === "storage:set" && x.payload.values.external).pop();
  return m ? m.payload.values.external : [];
};

test("Export verdicts.json writes the verdicts of hidden findings too, marked hidden", async () => {
  const { p } = await host([session()]);
  p.document.querySelector("#export-verdicts").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
  await until(() => p.sent.some((m) => m.type === "save:file"));
  const rows = JSON.parse(p.sent.find((m) => m.type === "save:file").payload.content);
  assert.deepEqual(
    rows.map((r) => [r.check, r.verdict, r.hidden]).sort(),
    [
      ["sleep_or_skip_added", "fp", true],
      [session().findings[0].check, "ok", undefined],
    ].sort(),
  );
  assert.deepEqual(p.errors, []);
  p.close();
});

test("importing the same verdicts.json twice keeps its rows once", async () => {
  const rows = [
    { session: "elsewhere", check: "weak_assert", source: "formal", message: "e2e/b.spec.ts: weak assert", verdict: "fp" },
    { session: "elsewhere", check: "magic_number", source: "formal", message: "e2e/b.spec.ts: magic number 3000", verdict: "ok" },
    { session: "elsewhere", check: "fragile_wait", source: "lint", message: "e2e/b.spec.ts: networkidle", verdict: "skip" },
  ];
  const { p } = await host([]);
  assert.match(await importFile(p, rows), /external findings added: 3$/);
  assert.equal(external(p).length, 3);
  assert.match(await importFile(p, rows), /external findings added: 0 · 3 rows already imported, skipped$/);
  assert.equal(external(p).length, 3, "no second copy");
  assert.equal(external(p).find((r) => r.check === "fragile_wait").verdict, null, "an unknown verdict is no verdict");
  p.close();
});

test("an imported verdict lands on a finding an off check hides, in the session itself", async () => {
  const exported = [
    { session: "round trip", check: "sleep_or_skip_added", source: "formal", message: session().calibHidden[0].message, verdict: "fp", hidden: true },
  ];
  const { dir, p } = await host([session(false)]);
  assert.match(await importFile(p, exported), /verdicts merged: 1, external findings added: 0$/);
  assert.equal(external(p).length, 0);
  const st = createStore({ dir: path.join(dir, "sessions") });
  await st.open();
  const s = (await st.get("rt1")).session;
  assert.deepEqual(
    Object.values(s.verdicts).map((v) => v.v),
    ["fp"],
  );
  p.close();
});
