"use strict";
/* Phase 4 measurements (4.0 and the acceptance criteria). One checkout, one size per process:
     node --max-old-space-size=3000 perf/run.js [--root <checkout>] [--n 200] [--kb 1024] [--runs 5] [--json]
   The same fixture (perf/fixtures.js) is migrated or loaded, then, through the real panel in jsdom wired to the real
   extension host (test/host-panel.js):
     boot       sidebar: scripts start → last reply of its start-up messages; then the Calibration render
     verdict    session tab: one click on "False": bytes sent by the page, bytes written to globalState and to files,
                and whether the write was accepted (0.1.100 refuses a storage:set over 64 MB)
     rules      Rules tab: one checkbox: the handler's time and analyze() calls inside it; time until the open tab
                shows the change; analyze() calls in the sidebar and in the tab
     analyze    time of one analyze() of one session (median of the calls seen)
     storeOpen  (phase 4 only) store.open() + list() over the migrated folder
   Medians of --runs repetitions where a measurement repeats; the rest are single values. */
const fs = require("fs");
const path = require("path");
const { bootHost, openPage } = require("../test/host-panel");
const { makeFixture } = require("./fixtures");

const args = process.argv.slice(2);
const arg = (k, d) => {
  const i = args.indexOf("--" + k);
  return i >= 0 ? args[i + 1] : d;
};
const ROOT = path.resolve(arg("root", path.join(__dirname, "..")));
const N = +arg("n", 20),
  KB = +arg("kb", 1024),
  RUNS = +arg("runs", 5),
  JSON_OUT = args.includes("--json");
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
};
const now = () => Number(process.hrtime.bigint()) / 1e6;
const PHASE4 = fs.existsSync(path.join(ROOT, "store.js"));
const timeAnalyze = (src) =>
  src
    .replace(
      "function renderReview() {",
      "function renderReview() { const __t = performance.now(); try { return __renderReview(); } finally { (window.__rt = window.__rt || []).push(performance.now() - __t); } }\n  function __renderReview() {",
    )
    .replace(
      "function analyze(s) {",
      "function analyze(s) { const __t = performance.now(); try { return __analyze(s); } finally { (window.__at = window.__at || []).push(performance.now() - __t); } }\n  function __analyze(s) {",
    );
const click = (p, sel) => p.document.querySelector(sel).dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
async function until(fn, ms = 120000) {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

(async () => {
  const t0 = Date.now();
  const fx = makeFixture({ n: N, bytes: KB * 1024, seed: 5 });
  const ids = Object.keys(fx.sessions);
  const gs = Object.assign({ sessions: fx.sessions }, fx.storage);
  const res = { root: path.basename(ROOT), phase4: PHASE4, n: N, kb: KB, fixtureMB: +(JSON.stringify(fx.sessions).length / 1048576).toFixed(1) };
  process.stderr.write(`fixture ${res.fixtureMB} MB in ${Date.now() - t0} ms\n`);
  const host = bootHost({ root: ROOT, globalState: gs });
  // bytes written to globalState from here on
  let gsBytes = 0;
  const upd = host.context.globalState.update;
  host.context.globalState.update = async (k, v) => {
    gsBytes += v === undefined ? 0 : Buffer.byteLength(JSON.stringify(v));
    return upd(k, v);
  };
  const dir = path.join(host.context.globalStorageUri.fsPath, "sessions");

  // boot (first start includes the migration for phase 4; measured separately below)
  const boots = [],
    calib = [];
  for (let r = 0; r < RUNS; r++) {
    const p = await openPage(host, { patchApp: timeAnalyze });
    await (p.window.SL_READY || Promise.resolve());
    await p.idle(20);
    boots.push(p.lastReplyAt - p.t0);
    const t = now();
    click(p, '.tab[data-view="calib"]');
    calib.push(now() - t);
    p.close();
    if (r === 0) res.firstBootMs = boots[0];
  }
  res.bootMs = median(boots.slice(1).length ? boots.slice(1) : boots);
  res.calibRenderMs = median(calib);
  if (PHASE4) {
    const { createStore } = require(path.join(ROOT, "store.js"));
    const times = [];
    for (let r = 0; r < RUNS; r++) {
      const st = createStore({ dir });
      const t = now();
      await st.open();
      st.list();
      times.push(now() - t);
    }
    res.storeOpenMs = median(times);
    res.migration = (host.calls.output.find((l) => /migration:/.test(l)) || "").replace(/^\[[^\]]+\] /, "");
  }

  // verdict
  process.stderr.write("step: verdict\n");
  const tab = await openPage(host, { sessionId: ids[0], patchApp: timeAnalyze });
  await (tab.window.SL_READY || Promise.resolve());
  await tab.idle(20);
  const findingDiv = [...tab.document.querySelectorAll("#findings .f")].find((d) => !d.classList.contains("done"));
  const n0 = tab.sent.length,
    g0 = gsBytes;
  const fileBefore = PHASE4 ? fs.statSync(path.join(dir, ids[0] + ".json")).mtimeMs : 0;
  let t = now();
  const clickAt = Date.now();
  findingDiv.querySelector(".v-fp").dispatchEvent(new tab.window.MouseEvent("click", { bubbles: true }));
  await tab.idle(20);
  res.verdict = {
    ms: tab.lastReplyAt - clickAt,
    messages: tab.sent
      .slice(n0)
      .map((m) => m.type)
      .join(","),
    pageBytes: tab.sent.slice(n0).reduce((a, m) => a + m.bytes, 0),
    globalStateBytes: gsBytes - g0,
    fileBytes:
      PHASE4 && fs.statSync(path.join(dir, ids[0] + ".json")).mtimeMs !== fileBefore
        ? fs.statSync(path.join(dir, ids[0] + ".json")).size + fs.statSync(path.join(dir, ids[0] + ".meta.json")).size
        : 0,
    refused: tab.posted.slice(-5).some((m) => m.__slReply && m.result && m.result.error)
      ? tab.posted.filter((m) => m.__slReply && m.result && m.result.error).map((m) => m.result.error)[0]
      : null,
    sessionFileBytes: PHASE4 ? fs.statSync(path.join(dir, ids[0] + ".json")).size : null,
  };

  // rules checkbox (sidebar), with the tab open
  process.stderr.write("step: rules checkbox (sidebar), with the tab open\n");
  const sb = await openPage(host, { patchApp: timeAnalyze });
  await (sb.window.SL_READY || Promise.resolve());
  await sb.idle(20);
  click(sb, '.tab[data-view="rules"]');
  const check = "sleep_or_skip_added";
  const hasCheck = () => [...tab.document.querySelectorAll("#findings .chk")].some((c) => c.textContent.includes(check));
  const sbA0 = (sb.window.__at || []).length,
    tabA0 = (tab.window.__at || []).length;
  const box = sb.document.querySelector(`.rule-row[data-check="${check}"] .r-enabled`);
  t = now();
  box.checked = false;
  box.dispatchEvent(new sb.window.Event("change", { bubbles: true }));
  const handlerMs = now() - t;
  const sbInHandler = (sb.window.__at || []).length - sbA0;
  const hadCheck = hasCheck();
  // 0.1.100 never re-draws an open session tab on a refresh (its SL_REFRESH looks for an active nav tab, which a
  // session tab has none of): recorded as null after 10 s
  let tabShowsMs = null;
  try {
    await until(() => !hasCheck(), 10000);
    tabShowsMs = now() - t;
  } catch {
    /* stays null */
  }
  await sb.idle(50);
  await tab.idle(50);
  const at = [...(sb.window.__at || []).slice(sbA0), ...(tab.window.__at || []).slice(tabA0)];
  res.rules = {
    handlerMs: +handlerMs.toFixed(1),
    analyzeInHandler: sbInHandler,
    tabShowsChangeMs: tabShowsMs == null ? null : +tabShowsMs.toFixed(0),
    tabHadCheck: hadCheck,
    analyzeSidebarSoFar: (sb.window.__at || []).length - sbA0,
    analyzeTab: (tab.window.__at || []).length - tabA0,
    storageSets: sb.sent.filter((m) => m.type === "storage:set").length,
  };
  res.analyzeMsMedian = +median(at).toFixed(1);
  res.rules.tabRenderMs = (tab.window.__rt || []).length ? +tab.window.__rt[tab.window.__rt.length - 1].toFixed(0) : null;
  res.rules.tabAnalyzeMs = (tab.window.__at || []).length > tabA0 ? +tab.window.__at[tab.window.__at.length - 1].toFixed(0) : null;
  res.errors = [...tab.errors, ...sb.errors].slice(0, 3);
  sb.close();
  tab.close();
  if (JSON_OUT) process.stdout.write(JSON.stringify(res) + "\n");
  else console.log(JSON.stringify(res, null, 1));
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
