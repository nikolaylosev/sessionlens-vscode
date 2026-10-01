// @ts-check
/* SessionLens panel — the Rules tab. Part of the panel's source (src/webview); `npm run build` bundles it into
   media/app.js. Split out of the single app.js in phase 7 (7B.4) without changing behaviour. */
import { $, SEV, T, esc, save, saveKeys, srcLabel, state } from "./common.js";
import { calibStatsBySource, onGenChanged } from "./store.js";
import { readFile } from "./sessions.js";
import { download } from "./calibration.js";

// set in initRules(), in the order the single app.js ran its statements
export let rulesTimer, rulesStatus;

export function initRules() {
  /* Severities and disabled checks: the page shows the change at once, the write waits 300 ms for more clicks.
     No session is re-analyzed here: the session tabs do their own on the refresh the write sends, the rest follow
     in the background (startBackground). */
  rulesTimer = null;
  rulesStatus = null;
  window.addEventListener("pagehide", () => {
    flushRules();
  });
  $("#rules-export").addEventListener("click", () => download("rules.json", LensRules.toJson(state.ruleOverrides)));
  $("#rules-file").addEventListener("change", (ev) => {
    const f = ev.target.files[0];
    if (f)
      readFile(f, async (text) => {
        let res;
        try {
          res = LensRules.fromJson(text);
        } catch (e) {
          $("#rules-status").textContent = String(e.message || e);
          return;
        }
        state.ruleOverrides = res.overrides;
        const why = res.ignored.map((x) => T("rules_ign_" + x.reason, { check: x.check, row: x.index + 1 })).join("; ");
        await saveRules(
          T("rules_imported", { n: Object.keys(res.overrides).length }) + (res.ignored.length ? " " + T("rules_ignored", { n: res.ignored.length, why }) : ""),
        );
        renderRules();
      });
    ev.target.value = "";
  });
  $("#rules-reset").addEventListener("click", async () => {
    if (!(await confirmDialog(T("rules_reset_confirm")))) return;
    state.ruleOverrides = {};
    await saveRules();
    renderRules();
  });
}

// ---------- rules ----------
export function renderRules() {
  const book = LensRules.book(state.ruleOverrides);
  // Group order and ids come from the registry (media/checks.js); the label is always g_<id>.
  const groups = Object.fromEntries(LensChecks.GROUPS_ORDER.map((g) => [g, T("g_" + g)]));
  // Calibration demotes a check's findings to low and apply() then ignores a manual severity for them —
  // say so next to the select instead of letting the choice look broken (RULES-ARCHITECTURE.md §4.4).
  // Phase 8: per check and source, for every source calibrate() applies to.
  const calib = calibStatsBySource();
  const levels = (check) =>
    Object.entries(calib[check] || {})
      .filter(([src]) => Lens.isCalibrated(check, src))
      .map(([src, st]) => Object.assign({ src }, Lens.calibLevel(st)));
  const demotedHint = (r) => {
    const own = state.ruleOverrides[r.check] || {};
    const d = own.severity && levels(r.check).find((x) => x.level === "demoted");
    return d ? `<span class="r-demoted" title="${esc(T("rules_demoted_hint", { p: Math.round(d.p * 100) }))}">ⓘ</span>` : "";
  };
  // ticked on by hand while calibration would switch it off: calibrate() leaves it on (decision of 01.10)
  const byHand = (r) => {
    const off = (state.ruleOverrides[r.check] || {}).enabled === true && levels(r.check).find((x) => x.level === "off");
    return off
      ? `<span class="tagx r-by-hand" title="${esc(T("rules_by_hand_hint", { src: srcLabel(off.src), p: Math.round(off.p * 100) }))}">${T("rules_by_hand")}</span>`
      : "";
  };
  const openMap = state.settings.ruleGroupsOpen || {};
  $("#rules-list").innerHTML = Object.entries(groups)
    .map(([g, label]) => {
      const rows = book.filter((r) => r.group === g);
      const isOpen = openMap[g] === true;
      return (
        `<details class="sec-d" data-group="${esc(g)}" ${isOpen ? "open" : ""}><summary class="h2">${esc(label)}</summary>` +
        rows
          .map(
            (r) => `<div class="rule-row ${r.enabled ? "" : "off"}" data-check="${esc(r.check)}">
        <div class="rule-head"><b>${esc(r.check)}</b>
          <select class="r-sev">${LensChecks.SEVERITIES.map((s3) => `<option value="${esc(s3)}" ${r.severity === s3 ? "selected" : ""}>${esc(SEV[s3])}</option>`).join("")}</select>${demotedHint(r)}
          <label class="r-on"><input type="checkbox" class="r-enabled" ${r.enabled ? "checked" : ""}> ${T("rules_on")}</label>${byHand(r)}
          ${r.edited ? `<span class="tagx">${T("rules_edited")}</span>` : ""}</div>
        <textarea class="r-text" rows="1" placeholder="${T("rules_text_ph")}">${esc(r.rule)}</textarea>
        <textarea class="r-text r-good" rows="1" placeholder="${T("rules_good_ph")}">${esc(r.good)}</textarea></div>`,
          )
          .join("") +
        `</details>`
      );
    })
    .join("");
  $("#rules-list")
    .querySelectorAll(".rule-row")
    .forEach((row) => {
      const check = row.dataset.check;
      const put = (patch) => {
        state.ruleOverrides[check] = Object.assign({}, state.ruleOverrides[check], patch);
        saveRules();
      };
      row.querySelector(".r-sev").addEventListener("change", (e) => put({ severity: e.target.value }));
      row.querySelector(".r-enabled").addEventListener("change", (e) => {
        put({ enabled: e.target.checked });
        row.classList.toggle("off", !e.target.checked);
      });
      row.querySelector(".r-text").addEventListener("change", (e) => put({ rule: e.target.value }));
      row.querySelector(".r-good").addEventListener("change", (e) => put({ good: e.target.value }));
    });
  $("#rules-list")
    .querySelectorAll("details.sec-d")
    .forEach((d) => {
      d.addEventListener("toggle", async () => {
        state.settings.ruleGroupsOpen = Object.assign({}, state.settings.ruleGroupsOpen, { [d.dataset.group]: d.open });
        await save();
      });
    });
}

export function saveRules(status) {
  if (status) rulesStatus = status;
  clearTimeout(rulesTimer);
  rulesTimer = setTimeout(flushRules, 300);
}

export async function flushRules() {
  if (rulesTimer === null) return;
  clearTimeout(rulesTimer);
  rulesTimer = null;
  const status = rulesStatus;
  rulesStatus = null;
  await saveKeys(["ruleOverrides"]);
  $("#rules-status").textContent = status || T("saved");
  if (!status)
    setTimeout(() => {
      $("#rules-status").textContent = "";
    }, 1200); // an import report stays until the next change
  onGenChanged();
}
