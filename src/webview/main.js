// @ts-check
/* SessionLens panel — start-up and refresh. Part of the panel's source (src/webview); `npm run build` bundles it into
   media/app.js. Split out of the single app.js in phase 7 (7B.4) without changing behaviour. */
import { $, save, saveKeys, state, store } from "./common.js";
import {
  BG_PAUSE_MS,
  IS_TAB,
  adopt,
  curS,
  ensureFresh,
  fetchSessions,
  genNow,
  loadIndex,
  loadSession,
  metas,
  needEngine,
  sessionStore,
  startBackground,
  updateSession,
} from "./store.js";
import { analyze } from "./analysis.js";
import { pickAndImport, renderList, show } from "./sessions.js";
import { renderReview } from "./review.js";
import { exportVerdicts, renameCurrent, renderCalib } from "./calibration.js";
import { renderRules, rulesTimer } from "./rules.js";
import { pushPrompts, renderPrompts } from "./prompts.js";
import { findPoolEntry, migrateModelPool, renderSettings } from "./settings.js";

// set in initMain(), in the order the single app.js ran its statements
export let booted, LINT_REPAIR_DELAY_MS, LINT_REPAIR_VERSION, TREE_SITTER_LANGS, rerenderTimer;

export function initMain() {
  // ---------- init ----------
  // Remembers whether the user left "Check precision" / "Rules for CLAUDE.md" open or collapsed,
  // across reloads — renderCalib() applies the stored value each time it renders.
  $("#calib-prec-d").addEventListener("toggle", async () => {
    state.settings.calibPrecOpen = $("#calib-prec-d").open;
    await save();
  });
  $("#calib-rules-d").addEventListener("toggle", async () => {
    state.settings.calibRulesOpen = $("#calib-rules-d").open;
    await save();
  });
  booted = boot().then(() => {
    if (window.SL_OPEN_SESSION) {
      renderReview();
      show("review");
      // the engine this session's next analysis will need, loaded while the user reads (phase 5)
      setTimeout(() => {
        const s = curS();
        if (s) needEngine(s.profile);
      }, 0);
    }
  });
  window.SL_READY = booted;
  // phase 6: the host sends palette commands to the sidebar only after this
  booted.then(() => {
    window.__slPageReady();
  });

  /* Phase 6: a command from VS Code (palette, Sessions tree menu), delivered by vscode-bridge.js. The sidebar imports
     and exports with the same code as its buttons; a session tab only renames its own session. */
  window.SL_COMMAND = async function (name, value) {
    await booted;
    if (IS_TAB) {
      if (name === "rename" && typeof value === "string") await renameCurrent(value);
      return;
    }
    if (name === "import") {
      show("sessions");
      await pickAndImport();
    } else if (name === "exportVerdicts") {
      show("calib");
      await exportVerdicts();
    }
  };
  window.addEventListener("sl:engine-ready", onEngineSettled);
  window.addEventListener("sl:engine-failed", onEngineSettled);

  /* Once: sessions saved before phase 5 while a tree-sitter engine was still booting carry no tree-sitter findings and
     a current analysisGen, so nothing would ever analyze them again. Their lintWhy says "still loading". Only sessions
     of those three languages are read (BATCH at a time), only those are analyzed again. With ESLint switched off
     nothing is done and the next start looks again. */
  LINT_REPAIR_DELAY_MS = 2000;
  LINT_REPAIR_VERSION = 1;
  TREE_SITTER_LANGS = new Set(["java", "csharp", "python"]);

  // Re-renders whatever view is active. From a background pass or a burst of saves elsewhere it runs at most every 200 ms.
  rerenderTimer = null;

  /* Called by the host (via vscode-bridge.js) with what changed elsewhere: { scope: "session", sessionId, meta } one
     session (meta null: deleted), "index" the whole list, "keys" settings and rules, "focus" this page became visible
     again (keys and list). Only that is re-read; a session tab re-analyzes its own session if the rules changed. */
  window.SL_REFRESH = async function (msg) {
    await booted;
    const scope = (msg && msg.scope) || "focus";
    if (scope === "session") {
      const id = msg.sessionId;
      if (msg.meta) state.index[id] = msg.meta;
      else delete state.index[id];
      if (state.loaded[id]) {
        if (!msg.meta) delete state.loaded[id];
        else if (msg.meta.rev !== state.revs[id]) {
          const r = await sessionStore.get(id);
          if (r) adopt(r);
          else delete state.loaded[id];
        }
      }
      // a tab re-draws only for its own session; the sidebar's lists use the index
      if (IS_TAB) {
        if (id === state.current) renderReview();
        return;
      }
      rerender((v) => v !== "review" || id === state.current);
      return;
    }
    if (scope === "keys" || scope === "focus") await loadKeys();
    if (scope === "focus" && !IS_TAB) {
      // the host resets the Sessions tree's visibility and its "page ready" when the sidebar is hidden (phase 6)
      const active = document.querySelector(".tab.active");
      window.__slSetActiveTab((active && /** @type {HTMLElement} */ (active).dataset.view) || "sessions");
      window.__slPageReady();
    }
    if (scope === "index" || scope === "focus") {
      await loadIndex();
      for (const id of Object.keys(state.loaded)) {
        const m = state.index[id];
        if (!m) delete state.loaded[id];
        else if (m.rev !== state.revs[id]) {
          const r = await sessionStore.get(id);
          if (r) adopt(r);
          else delete state.loaded[id];
        }
      }
    }
    let drawn = false;
    if (state.current && state.loaded[state.current] && state.gens[state.current] !== genNow())
      await ensureFresh(
        state.current,
        IS_TAB
          ? () => {
              drawn = true;
              renderReview();
            }
          : null,
      );
    renderList();
    if (!drawn) rerender();
    startBackground();
  };
}

// settings and the other small keys (not the sessions); also what a refresh re-reads
export async function loadKeys() {
  const keepRules = rulesTimer !== null ? state.ruleOverrides : null; // a rules change still waiting for its write wins
  const st = await store.get();
  Object.assign(state, st);
  if (keepRules) state.ruleOverrides = keepRules;
  {
    // before migrateModelPool(): it decides by "has a key" which old providers go into the pool
    delete state.settings.apiKey;
    delete state.settings.keys;
    const ks = await window.__slSecretStatus();
    LensAI.setKeyStatus(ks && !ks.error ? ks : {});
    LensAI.setTransport(window.__slAiCall);
  }
  {
    const pr = Lens.ALIAS[state.settings.profile] || state.settings.profile;
    state.settings.profile = Lens.PROFILES.includes(pr) ? pr : "qa-ts";
  }
  migrateModelPool();
  for (const [task, r] of Object.entries(state.settings.routes || {}))
    if (r && r.provider && !findPoolEntry(r.provider, r.model)) delete state.settings.routes[task];
  pushPrompts();
}

export async function boot() {
  await loadKeys();
  I18N.set("en");
  I18N.apply(document);
  await loadIndex();
  // A per-session editor tab (opened via window.__slOpenSession) sets SL_OPEN_SESSION before app.js runs: it loads
  // its own session (and nothing else) and brings its findings up to the current rules first.
  if (IS_TAB) {
    state.current = window.SL_OPEN_SESSION;
    if (await loadSession(state.current)) await ensureFresh(state.current);
  }
  renderList();
  // Report the tab that's active on first load (the static HTML markup marks "sessions"
  // active by default) so the host's native-Sessions-tree visibility starts in sync.
  if (!window.SL_OPEN_SESSION) {
    const active = document.querySelector(".tab.active");
    window.__slSetActiveTab((active && /** @type {HTMLElement} */ (active).dataset.view) || "sessions");
  }
  startBackground();
  if (!IS_TAB)
    setTimeout(() => {
      repairLint().catch(() => {});
    }, LINT_REPAIR_DELAY_MS);
}

/* An engine finished loading here (or gave up): a session analyzed while it was loading (lintPending) is analyzed
     again. In a tab that is its own session; in the sidebar the background pass picks up every
     session saved with analyzedGen "". Nothing is written when the result did not change. */
export function onEngineSettled(ev) {
  const language = ev && ev.detail && ev.detail.language;
  booted.then(async () => {
    const s = curS();
    if (s && s.lintPending && Lens.profile(s.profile).language === language) {
      try {
        if (await updateSession(state.current, (x) => analyze(x), { skipIfSame: true })) renderReview();
      } catch (e) {
        /* the next analysis tries again */
      }
    }
    if (!IS_TAB && metas().some((m) => m.analyzedGen === "")) startBackground();
  });
}

export async function repairLint() {
  if (IS_TAB || state.lintRepair >= LINT_REPAIR_VERSION || state.settings.lint === false) return;
  const ids = metas()
    .filter((m) => TREE_SITTER_LANGS.has(Lens.profile(m.profile).language))
    .map((m) => m.id);
  const stale = [];
  await fetchSessions(ids, (x) => {
    if ((x.lintWhy || []).some((w) => /still loading/.test(String(w)))) stale.push({ id: x.id, profile: x.profile });
  });
  let done = 0;
  for (const t of stale) {
    await needEngine(t.profile);
    try {
      if (await updateSession(t.id, (x) => analyze(x, "background"), { background: true })) done++;
    } catch (e) {
      /* left as it is */
    }
    await new Promise((r) => setTimeout(r, BG_PAUSE_MS));
  }
  state.lintRepair = LINT_REPAIR_VERSION;
  await saveKeys(["lintRepair"]);
  if (done) rerender();
}

export function rerender(onlyIf) {
  if (rerenderTimer) return;
  rerenderTimer = setTimeout(() => {
    rerenderTimer = null;
    const active = document.querySelector(".tab.active");
    const v = window.SL_OPEN_SESSION ? "review" : active && /** @type {HTMLElement} */ (active).dataset.view;
    if (onlyIf && !onlyIf(v)) return;
    if (v === "review") renderReview();
    else if (v === "calib") renderCalib();
    else if (v === "rules") renderRules();
    else if (v === "prompts") renderPrompts();
    else if (v === "settings") renderSettings();
    else if (v === "sessions") renderList();
  }, 0);
}
