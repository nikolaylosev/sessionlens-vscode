// @ts-check
/* SessionLens panel — sessions in the host's store, the background pass, calibration stats. Part of the panel's
   source (src/webview); `npm run build` bundles it into media/app.js. Split out of the single app.js in phase 7 (7B.4) without changing behaviour. */
import { state } from "./common.js";
import { analyze } from "./analysis.js";
import { renderReview } from "./review.js";
import { rulesTimer } from "./rules.js";
import { rerender } from "./main.js";

// set in initStore(), in the order the single app.js ran its statements
export let IS_TAB, BATCH, BG_PAUSE_MS, BG_AFTER_CHANGE_MS, sessionStore, genNow, needEngine, metas, curS, bgRun, bgTimer;

export function initStore() {
  // ---------- sessions (phase 4) ----------
  /* The page keeps state.index (id → summary, see Lens.sessionSummary) for every session and state.loaded only for the
     sessions it shows or works on. state.revs/state.gens: the rev each loaded session was read at, and the analysisGen
     its findings were computed with. A session tab (IS_TAB) loads its own session; the sidebar only the index. */
  IS_TAB = !!window.SL_OPEN_SESSION;
  BATCH = 10;
  BG_PAUSE_MS = 50;
  BG_AFTER_CHANGE_MS = 1000;
  sessionStore = {
    async list() {
      const r = await window.__slSessionList();
      if (!r || r.error) throw new Error((r && r.error) || "no session list");
      return r.items;
    },
    async get(id) {
      const r = await window.__slSessionGet(id);
      return r && !r.error ? r : null;
    },
    put: (session, opts) => window.__slSessionPut(session, opts),
    delete: (id) => window.__slSessionDelete(id),
    clear: () => window.__slSessionClear(),
  };
  genNow = () => Lens.analysisGen({ ruleOverrides: state.ruleOverrides, lint: state.settings.lint !== false, epoch: state.analysisEpoch });
  // Phase 5: before analyze() of a session, its language's lint engine is loaded (once per page). Never rejects: an
  // engine that failed to load leaves the analysis without lint, as a missing bundle always did.
  needEngine = (profile) => (state.settings.lint === false ? Promise.resolve("off") : LensLint.ensure(Lens.profile(profile).language));
  // the index in the order sessions were added: the order 0.1.100 walked its sessions object in (calibration, rules, evidence)
  metas = () => Object.values(state.index).sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.created).localeCompare(String(b.created)));
  curS = () => state.loaded[state.current];
  /* Sessions not shown anywhere are re-analyzed by the sidebar, one at a time, newest first, when the rules or the
     ESLint switch change: the Sessions tree then shows what 0.1.100 showed at once. A tab showing a session does it
     itself (the host answers { skipped } for those). A newer change restarts the pass. */
  bgRun = 0;
  bgTimer = null;
}

export async function loadIndex() {
  const items = await sessionStore.list();
  state.index = {};
  for (const m of items) state.index[m.id] = m;
}

export function adopt(r) {
  const s = r.session;
  state.loaded[s.id] = s;
  state.revs[s.id] = r.rev;
  state.gens[s.id] = r.meta ? r.meta.analyzedGen : "";
  if (r.meta) state.index[s.id] = r.meta;
  return s;
}

export async function loadSession(id) {
  if (!id) return null;
  if (state.loaded[id]) return state.loaded[id];
  const r = await sessionStore.get(id);
  return r ? adopt(r) : null;
}

// Calls each(session) for every id, in order, loading BATCH at a time; loaded copies are used as they are, the rest
// are not kept (export, examples and verdict import read many sessions once).
export async function fetchSessions(ids, each) {
  for (let i = 0; i < ids.length; i += BATCH) {
    const part = await Promise.all(
      ids
        .slice(i, i + BATCH)
        .map((id) => (state.loaded[id] ? { session: state.loaded[id], rev: state.revs[id], meta: state.index[id] } : sessionStore.get(id))),
    );
    for (const r of part) if (r && r.session) each(r.session, r);
  }
}

/* Every change to a stored session: fn(session) changes it, then it is saved with the rev it was read at. If another
     page or window saved it in between, it is read again and fn runs again on the fresh copy (3 tries).
     opts.from: { session, rev, meta } already read (not loaded); opts.background: the sidebar's re-analysis, which gives
     way to a tab showing the session and to any conflict; opts.skipIfSame: nothing is written when fn left the findings,
     the lint note and the analysis gen as they were. → true when saved. */
export async function updateSession(id, fn, opts = {}) {
  let from = opts.from || null;
  for (let attempt = 0; attempt < 3; attempt++) {
    let s, rev;
    if (state.loaded[id]) {
      s = state.loaded[id];
      rev = state.revs[id];
    } else {
      const r = from || (await sessionStore.get(id));
      from = null;
      if (!r) return false;
      s = r.session;
      rev = r.rev;
      state.gens[id] = r.meta ? r.meta.analyzedGen : "";
    }
    const same = opts.skipIfSame ? () => JSON.stringify([s.findings, s.lintNote || "", !!s.lintPending, state.gens[id] || ""]) : null;
    const before = same && same();
    fn(s);
    if (same && same() === before) return false;
    if (opts.after) opts.after(s); // e.g. draw the result before the write returns
    const r = await sessionStore.put(s, { baseRev: rev, analyzedGen: state.gens[id] || "", background: !!opts.background });
    if (r && r.ok) {
      if (state.loaded[id] === s) state.revs[id] = r.rev;
      if (r.meta) state.index[id] = r.meta;
      return true;
    }
    if (r && r.skipped) return false;
    if (r && r.conflict) {
      if (opts.background) return false;
      if (state.loaded[id]) {
        const g = await sessionStore.get(id);
        if (!g) return false;
        adopt(g);
      }
      continue;
    }
    throw new Error((r && r.error) || "could not save the session");
  }
  throw new Error("the session kept changing elsewhere and was not saved");
}

// a new session (import): no rev to compare with
export async function putNew(s) {
  const r = await sessionStore.put(s, { analyzedGen: state.gens[s.id] || "" });
  if (!r || !r.ok) throw new Error((r && r.error) || "could not save the session");
  if (r.meta) state.index[s.id] = r.meta;
  return r;
}

// Findings computed with other rules than the current ones are computed again before they are shown.
// after(session): called once the findings are recomputed, before they are saved
export async function ensureFresh(id, after) {
  if (!state.loaded[id] || state.gens[id] === genNow()) return false;
  await needEngine(state.loaded[id].profile);
  if (!state.loaded[id] || state.gens[id] === genNow()) return false;
  let drawn = false;
  await updateSession(id, (x) => analyze(x), {
    after: after
      ? (x) => {
          if (!drawn) {
            drawn = true;
            after(x);
          }
        }
      : null,
  });
  return true;
}

// delayMs: after a rules change the open tabs go first (BG_AFTER_CHANGE_MS), so the one being looked at updates quickest
export function startBackground(delayMs = BG_PAUSE_MS) {
  if (IS_TAB) return;
  const run = ++bgRun;
  clearTimeout(bgTimer);
  bgTimer = setTimeout(async () => {
    const gen = genNow();
    const todo = metas()
      .filter((m) => m.analyzedGen !== gen && !state.loaded[m.id])
      .sort((a, b) => String(b.created).localeCompare(String(a.created)));
    let done = 0;
    for (const m of todo) {
      // a rules change still waiting for its write: flushRules() starts a new pass once it is saved
      if (run !== bgRun || genNow() !== gen || rulesTimer !== null) return;
      await needEngine(m.profile); // loads an engine only if a session of its language is waiting
      if (run !== bgRun || genNow() !== gen || rulesTimer !== null) return;
      try {
        if (await updateSession(m.id, (x) => analyze(x, "background"), { background: true })) done++;
      } catch (e) {
        /* the next pass tries again */
      }
      await new Promise((r) => setTimeout(r, BG_PAUSE_MS));
    }
    if (done && run === bgRun) rerender();
  }, delayMs);
}

// after the rules, the ESLint switch or the calibration epoch changed in this page
export function onGenChanged() {
  if (!IS_TAB && state.current && state.loaded[state.current])
    ensureFresh(state.current).then((ch) => {
      if (ch) renderReview();
    }); // a session this page shows itself
  startBackground(BG_AFTER_CHANGE_MS);
}

// ---------- calibration stats ----------
// from the summaries: the same numbers 0.1.100 counted over every session's findings and verdicts
export function calibStats() {
  const st = {};
  const add = (check, v) => {
    const x = (st[check] = st[check] || { total: 0, ok: 0, fp: 0 });
    x.total++;
    if (v) x[v.v]++;
  };
  for (const m of metas())
    for (const [check, c] of Object.entries(m.checkStats || {})) {
      const x = (st[check] = st[check] || { total: 0, ok: 0, fp: 0 });
      x.total += c.total;
      x.ok += c.ok;
      x.fp += c.fp;
    }
  for (const f of state.external) add(f.check, f.verdict ? { v: f.verdict } : null);
  return st;
}

export function profileVerdicts(profile) {
  let n = 0;
  for (const m of metas()) if (m.profile === profile) n += m.verdictsCount || 0;
  return n;
}
