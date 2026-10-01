// @ts-check
/* SessionLens panel — analysis of a session. Part of the panel's source (src/webview); `npm run build` bundles it into
   media/app.js. Split out of the single app.js in phase 7 (7B.4) without changing behaviour. */
import { state } from "./common.js";
import { calibStats, genNow } from "./store.js";

export function initAnalysis() {}

// ---------- analysis (shared by import, spec save, re-run) ----------
/* Phase 6: every analysis reports how long it took to the host's Output channel (VS Code build only; numbers and
     names only). event: "import", "background" or "reanalyze" (everything else: spec save, segmentation, AI, a tab). */
export function analyze(s, event) {
  const t0 = Date.now();
  analyzeNow(s);
  try {
    window.__slLogTiming(event || "reanalyze", String(s.profile || ""), Math.max(0, Date.now() - t0), Array.isArray(s.events) ? s.events.length : 0);
  } catch (e) {
    /* a log line is never worth an error */
  }
}

export function analyzeNow(s) {
  const cfg = Lens.profile(s.profile);
  const calib = calibStats();
  const formal = Lens.runChecks(s.events, cfg, calib);
  const gherkin = Lens.gherkinChecks(s.events); // profile-agnostic: runs on any .feature file regardless of s.profile
  const spec = LensSpec.parse(s.spec || "");
  const sc = LensSpec.checks(spec, s.events, cfg.language);
  const ai = (s.findings || []).filter((f) => f.source === "ai");
  let base = formal;
  s.lintNote = "";
  delete s.lintPending;
  if (state.settings.lint !== false) {
    const lr = LensLint.run(s, cfg, state.settings);
    s.lintNote = lr.note;
    s.lintWhy = lr.why || [];
    s.lintLog = lr.log || [];
    if (lr.pending) s.lintPending = true; // the engine is still loading here: not a final result (see below)
    if (lr.ran) base = LensLint.merge(formal, lr.findings); // supersede only when the linter actually parsed
  }
  s.findings = Lens.sortFindings(LensRules.apply([...base, ...gherkin, ...sc.findings, ...ai], state.ruleOverrides));
  s.coverage = sc.coverage;
  s.specParsed = { n: spec.requirements.length, oos: spec.outOfScope.length, hasIds: spec.requirements.some((r) => !r.auto) };
  s.suppressed = formal.suppressed || [];
  s.calibHidden = formal.hidden || []; // what an "off" check found: counted for calibration, never shown
  s.metrics = Lens.metrics(s.events);
  s.task = s.task || Lens.taskId(s.events);
  // which rules these findings were computed with; "" (not analyzed) while the lint engine was still loading, so
  // ensureFresh() and the background pass analyze it again (phase 5)
  state.gens[s.id] = s.lintPending ? "" : genNow();
}
