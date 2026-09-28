// @ts-check
/* SessionLens panel — the Model rules tab. Part of the panel's source (src/webview); `npm run build` bundles it into
   media/app.js. Split out of the single app.js in phase 7 (7B.4) without changing behaviour. */
import { $, T, esc, rulesTargetLabel, save, state } from "./common.js";

export function initPrompts() {
  $("#prompts-reset").addEventListener("click", async () => {
    state.settings.prompts = {};
    pushPrompts();
    await save();
    renderPrompts();
  });
}

// ---------- model prompts ----------
export function promptDefaults() {
  return Object.assign({}, LensSeg.DEFAULTS, LensAI.DEFAULTS);
}

export function pushPrompts() {
  const p = state.settings.prompts || {};
  LensAI.setPrompts(p);
  LensSeg.setPrompts(p);
}

export function renderPrompts() {
  const def = promptDefaults(),
    own = state.settings.prompts || {};
  const label = {
    segment: T("p_segment"),
    segment_local: T("p_segment") + " — local model",
    review: T("p_review"),
    review_local: T("p_review_local"),
    verify: T("p_verify"),
    compress: T("p_compress"),
    generate_skill: T("p_gen_skill"),
  };
  const sub = {
    segment: T("p_segment_sub"),
    segment_local: T("p_segment_sub"),
    review: T("p_review_sub"),
    review_local: T("p_review_local_sub"),
    verify: T("p_verify_sub"),
    compress: T("p_compress_sub", { f: rulesTargetLabel() }),
    generate_skill: T("p_gen_skill_sub"),
  };
  const openMap = state.settings.promptsOpen || {};
  $("#prompts-list").innerHTML = Object.keys(def)
    .map(
      (k) => `<details class="sec-d" data-key="${esc(k)}" ${openMap[k] === true ? "open" : ""}>
      <summary class="h2">${esc(label[k] || k)}</summary>
      <p class="muted">${esc(sub[k] || "")}</p>
      <textarea class="p-box" data-key="${esc(k)}" rows="8">${esc(own[k] !== undefined ? own[k] : def[k])}</textarea>
    </details>`,
    )
    .join("");
  $("#prompts-list")
    .querySelectorAll(".p-box")
    .forEach((t) =>
      t.addEventListener("change", async () => {
        const k = t.dataset.key,
          def2 = promptDefaults();
        state.settings.prompts = state.settings.prompts || {};
        if (t.value.trim() === String(def2[k]).trim()) delete state.settings.prompts[k];
        else state.settings.prompts[k] = t.value;
        pushPrompts();
        await save();
        $("#prompts-status").textContent = T("prompts_saved");
        setTimeout(() => {
          $("#prompts-status").textContent = "";
        }, 1500);
      }),
    );
  $("#prompts-list")
    .querySelectorAll("details.sec-d")
    .forEach((d) => {
      d.addEventListener("toggle", async () => {
        state.settings.promptsOpen = Object.assign({}, state.settings.promptsOpen, { [d.dataset.key]: d.open });
        await save();
      });
    });
}
