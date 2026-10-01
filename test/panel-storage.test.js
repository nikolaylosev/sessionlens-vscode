"use strict";
/* Phase 4 in the real panel: media/app.js in jsdom, wired through vscode-bridge.js to the real extension.js
   (test/host-panel.js). The Chrome code path and its test were removed in phase 7 (7B.3). */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { bootHost, openPage } = require("./host-panel");
async function showView(p, view) {
  p.document.querySelector(`.tab[data-view="${view}"]`).dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
  await p.idle();
}
const { createStore } = require("../store.js");
const { makeFixture } = require("../perf/fixtures");
const { snapshot } = require("../perf/snapshot-calib");
const { root } = require("./helpers");

// counts analyze() calls in a page: window.__analyze
// (the anchor must exist: a silent no-op patch would make the counts below meaningless)
const countAnalyze = (src) => {
  const a = "function analyze(s, event) {";
  assert.ok(src.includes(a), "analyze() is where the test expects it");
  return src.replace(a, a + " window.__analyze = (window.__analyze || 0) + 1;");
};
const FX = makeFixture({ n: 8, bytes: 20 * 1024, seed: 11 });
const state = () => JSON.parse(JSON.stringify(Object.assign({ sessions: FX.sessions }, FX.storage)));
async function until(fn, ms = 5000) {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("app.js has no state.sessions left", () => {
  assert.equal(/state\.sessions/.test(fs.readFileSync(path.join(root, "media", "app.js"), "utf8")), false);
});

// rules and rulesList as 0.1.100 rendered them; precision as of 0.1.112 (a row per check and source, phase 8)
test("Calibration, proposed rules and their effect are the same as in 0.1.100 (snapshot)", async () => {
  const want = JSON.parse(fs.readFileSync(path.join(root, "test", "__snapshots__", "calib-v0100.json"), "utf8"));
  const got = await snapshot(root);
  assert.equal(got.precision, want.precision);
  assert.equal(got.rules, want.rules);
  assert.equal(got.rulesList, want.rulesList);
});

test("the sidebar starts from the summaries only; a tab loads its own session and nothing else", async () => {
  const host = bootHost({ globalState: state() });
  const sb = await openPage(host);
  await sb.ready();
  assert.deepEqual(
    sb.sent.filter((m) => m.type.startsWith("session:")).map((m) => m.type),
    ["session:list"],
  );
  const id = Object.keys(FX.sessions)[3];
  const tab = await openPage(host, { sessionId: id });
  await tab.ready();
  assert.deepEqual(
    tab.sent.filter((m) => m.type.startsWith("session:")).map((m) => [m.type, m.payload.id]),
    [
      ["session:list", undefined],
      ["session:get", id],
    ],
  );
  assert.equal(
    tab.document.querySelectorAll("#findings .f").length,
    Math.min(FX.sessions[id].findings.length, tab.document.querySelectorAll("#findings .f").length),
  );
  assert.ok(tab.document.querySelectorAll("#findings .f").length > 0);
  assert.deepEqual([...sb.errors, ...tab.errors], []);
  sb.close();
  tab.close();
});

test("a verdict saves exactly one session and nothing else", async () => {
  const host = bootHost({ globalState: state() });
  const id = Object.keys(FX.sessions)[0];
  const tab = await openPage(host, { sessionId: id });
  await tab.ready();
  const n = tab.sent.length;
  const undecided = [...tab.document.querySelectorAll("#findings .f")].find((d) => !d.classList.contains("done"));
  undecided.querySelector(".v-fp").dispatchEvent(new tab.window.MouseEvent("click", { bubbles: true }));
  await tab.idle();
  const after = tab.sent.slice(n);
  assert.deepEqual(
    after.map((m) => m.type),
    ["session:put"],
  );
  assert.equal(after[0].payload.baseRev, 1);
  const r = await openPage(host, { sessionId: id });
  await r.ready();
  const k = undecided.dataset.k;
  assert.ok(r.document.querySelector(`#findings .f[data-k="${k.replace(/"/g, '\\"')}"] .v-fp.on`), "saved");
  tab.close();
  r.close();
});

test("a Rules checkbox: no analysis in the sidebar; one write after 300 ms; the open tab re-analyzes itself once; the rest follow in the background", async () => {
  const host = bootHost({ globalState: state() });
  const ids = Object.keys(FX.sessions);
  const sb = await openPage(host, { patchApp: countAnalyze });
  await sb.ready();
  const tab = await openPage(host, { sessionId: ids[0], patchApp: countAnalyze });
  await tab.ready();
  const tabBefore = tab.window.__analyze || 0,
    sbBefore = sb.window.__analyze || 0;
  assert.ok(
    tab.document.querySelector("#findings .f .chk") &&
      [...tab.document.querySelectorAll("#findings .chk")].some((c) => /sleep_or_skip_added/.test(c.textContent)),
  );
  await showView(sb, "rules");
  const box = sb.document.querySelector('.rule-row[data-check="sleep_or_skip_added"] .r-enabled');
  const n = sb.sent.length;
  const t0 = Date.now();
  box.checked = false;
  box.dispatchEvent(new sb.window.Event("change", { bubbles: true }));
  const handlerMs = Date.now() - t0;
  assert.equal((sb.window.__analyze || 0) - sbBefore, 0, "no analysis in the handler");
  assert.ok(handlerMs < 50, `handler ${handlerMs} ms`);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(sb.sent.slice(n).filter((m) => m.type === "storage:set").length, 0, "still waiting (debounce)");
  await new Promise((r) => setTimeout(r, 250));
  await sb.idle();
  const sets = sb.sent.slice(n).filter((m) => m.type === "storage:set");
  assert.equal(sets.length, 1);
  assert.deepEqual(Object.keys(sets[0].payload.values), ["ruleOverrides"]);
  await until(() => (tab.window.__analyze || 0) > tabBefore);
  await tab.idle();
  assert.equal(tab.window.__analyze - tabBefore, 1, "the tab re-analyzed its own session once");
  assert.ok(![...tab.document.querySelectorAll("#findings .chk")].some((c) => /sleep_or_skip_added/.test(c.textContent)), "the tab shows the new findings");
  // the background pass: every other session, never the one open in the tab
  const probe = await openPage(host);
  await probe.ready();
  const gen = probe.window.eval("Lens.analysisGen({ ruleOverrides: { sleep_or_skip_added: { enabled: false } }, lint: false, epoch: 0 })");
  const dir = path.join(host.context.globalStorageUri.fsPath, "sessions");
  const metas = () => ids.map((id) => JSON.parse(fs.readFileSync(path.join(dir, id + ".meta.json"), "utf8")));
  await until(() => metas().every((m) => m.analyzedGen === gen), 10000);
  const bgPuts = sb.sent.filter((m) => m.type === "session:put");
  assert.ok(bgPuts.every((m) => m.payload.background === true));
  const tree = await host.registered.trees.sessionlensSessionsTree.getChildren();
  assert.equal(tree.length, ids.length);
  for (const m of metas()) assert.ok(!m.checkStats.sleep_or_skip_added, `${m.id} still has the disabled check`);
  assert.deepEqual([...sb.errors, ...tab.errors], []);
  sb.close();
  tab.close();
  probe.close();
});

test("a verdict set while another window saved the same session: both survive (conflict, read again, applied again)", async () => {
  const host = bootHost({ globalState: state() });
  const id = Object.keys(FX.sessions)[2];
  const tab = await openPage(host, { sessionId: id });
  await tab.ready();
  // another window writes rev 2 behind this tab's back (no refresh reaches it)
  const other = createStore({ dir: path.join(host.context.globalStorageUri.fsPath, "sessions") });
  await other.open();
  const g = await other.get(id);
  const theirs = g.session.findings.find((f) => !g.session.verdicts[`${f.check}@${f.seq}@${f.message.slice(0, 40)}`]);
  const theirKey = `${theirs.check}@${theirs.seq}@${theirs.message.slice(0, 40)}`;
  g.session.verdicts[theirKey] = { v: "ok", note: "other window", at: "2026-01-01" };
  assert.equal((await other.put(g.session, { baseRev: 1 })).rev, 2);
  // this tab sets a verdict on a different finding
  const mine = [...tab.document.querySelectorAll("#findings .f")].find((d) => !d.classList.contains("done") && d.dataset.k !== theirKey);
  mine.querySelector(".v-ok").dispatchEvent(new tab.window.MouseEvent("click", { bubbles: true }));
  await tab.idle();
  const puts = tab.sent.filter((m) => m.type === "session:put");
  assert.deepEqual(
    puts.map((m) => m.payload.baseRev),
    [1, 2],
    "conflict at rev 1, saved at rev 2",
  );
  const final = await other.get(id);
  assert.equal(final.rev, 3);
  assert.equal(final.session.verdicts[theirKey].note, "other window");
  assert.equal(final.session.verdicts[mine.dataset.k].v, "ok");
  tab.close();
});
