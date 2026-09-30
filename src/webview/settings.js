// @ts-check
/* SessionLens panel — the ⚙ Settings tab. Part of the panel's source (src/webview); `npm run build` bundles it into
   media/app.js. Split out of the single app.js in phase 7 (7B.4) without changing behaviour. */
import { $, T, applyTheme, esc, hostTheme, save, state } from "./common.js";
import { curS, onGenChanged, sessionStore } from "./store.js";
import { renderList } from "./sessions.js";
import { renderRaw, renderReview } from "./review.js";
import { renderCalLog } from "./calibration.js";

// set in initSettings(), in the order the single app.js ran its statements
export let ROUTE_TASKS, SETTINGS_DEFAULTS;

export function initSettings() {
  $("#s-add-provider").addEventListener("change", (e) => renderAddForm(e.target.value));
  $("#s-add-key-del").addEventListener("click", async () => {
    const prov = $("#s-add-provider").value,
      p = LensAI.PROVIDERS[prov],
      st2 = $("#s-add-status");
    if (!(await confirmDialog(T("key_delete_confirm", { p: p.label })))) return;
    const r = await window.__slSecretDelete(prov);
    if (!r || r.error) {
      st2.className = "err";
      st2.textContent = T("key_save_failed", { msg: (r && r.error) || "?" });
      return;
    }
    LensAI.setKeyStatus(r);
    renderAddForm(prov);
    st2.className = "muted";
    st2.textContent = T("key_deleted");
    setTimeout(() => {
      st2.textContent = "";
    }, 1500);
  });
  $("#s-add-cli-settings").addEventListener("click", () => {
    window.__slOpenSettings();
  });
  $("#s-add-cli-check").addEventListener("click", async () => {
    const prov = $("#s-add-provider").value,
      p = LensAI.PROVIDERS[prov],
      suf = p.cliKind === "codex" ? "_codex" : "";
    const check = p.cliKind === "codex" ? window.__slCodexCheck : window.__slClaudeCheck;
    const st = $("#s-add-cli-status");
    st.className = "muted";
    st.textContent = T("cli_checking");
    const r = await check({});
    if (!r || !r.installed) {
      st.className = "err";
      st.textContent = T("cli_err_notfound" + suf, { cmd: (r && r.cmd) || (p.cliKind === "codex" ? "codex" : "claude") });
      return;
    }
    if (!r.loggedIn) {
      st.className = "err";
      st.textContent = T("cli_check_nologin" + suf, { v: r.version });
      return;
    }
    const who = [r.account, r.plan].filter(Boolean).join(", ");
    st.className = r.apiKeyEnv ? "err" : "muted";
    st.textContent =
      T("cli_check_ok" + suf, { v: r.version, who: who ? " (" + who + ")" : "" }) +
      (r.cmd ? " · " + r.cmd : "") +
      (r.apiKeyEnv ? " " + T("cli_check_apikey" + suf) : "");
  });
  $("#s-add-model-btn").addEventListener("click", async () => {
    const prov = $("#s-add-provider").value,
      p = LensAI.PROVIDERS[prov];
    const key = $("#s-add-key").value.trim(),
      model = $("#s-add-model").value.trim() || p.defaultModel;
    const label = $("#s-add-label").value.trim();
    const needsKey = !p.local && !p.noKey,
      hasKey = key || LensAI.hasKey(state.settings, prov);
    const st2 = $("#s-add-status");
    if (needsKey && !hasKey) {
      st2.className = "err";
      st2.textContent = T("s_models_key_missing_err", { p: p.label });
      return;
    }
    state.settings.baseUrls = state.settings.baseUrls || {};
    // straight into the host's SecretStorage; the model is added only once the key is really stored
    if (key && needsKey) {
      const r = await window.__slSecretSet(prov, key);
      if (!r || r.error) {
        st2.className = "err";
        st2.textContent = T("key_save_failed", { msg: (r && r.error) || "?" });
        return;
      }
      LensAI.setKeyStatus(r);
    }
    if (p.local || p.editableBase) {
      // the host keeps this address and asks the person to confirm a new one in a VS Code dialog
      const r = await window.__slBaseUrlSet(prov, $("#s-add-baseurl").value.trim());
      if (!r || r.error) {
        st2.className = "err";
        st2.textContent = T("s_baseurl_failed", { msg: (r && r.error) || "?" });
        return;
      }
      if (!r.ok) {
        st2.className = "err";
        st2.textContent = T("s_baseurl_cancelled");
        return;
      }
      state.settings.baseUrls[prov] = r.url;
    }
    const id = "m_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    state.settings.modelPool = state.settings.modelPool || [];
    state.settings.modelPool.push({ id, provider: prov, model, label });
    if (!state.settings.defaultModelId) setDefaultModel(id);
    await save();
    st2.className = "muted";
    st2.textContent = T("saved");
    setTimeout(() => {
      st2.textContent = "";
    }, 1500);
    renderAddForm(prov);
    renderModelPool();
    renderRoutes();
  });

  // ---------- settings: model per request ----------
  ROUTE_TASKS = [
    ["segment", "p_segment", "p_segment_sub"],
    ["review", "p_review", "p_review_sub"],
    ["verify", "p_verify", "p_verify_sub"],
    ["compress", "p_compress", "p_compress_sub"],
    ["skill", "p_gen_skill", "p_gen_skill_sub"],
  ];
  $("#s-addmodel-d").addEventListener("toggle", async () => {
    state.settings.addModelOpen = $("#s-addmodel-d").open;
    await save();
  });
  $("#s-routes-d").addEventListener("toggle", async () => {
    state.settings.routesOpen = $("#s-routes-d").open;
    await save();
  });
  $("#s-hide-demo").addEventListener("change", async () => {
    state.settings.hideDemo = $("#s-hide-demo").checked;
    await save();
    renderList(); // the button is on the Sessions tab
  });
  $("#s-debug-model").addEventListener("change", async () => {
    state.settings.debugModel = $("#s-debug-model").checked;
    await save();
    if (state.current && curS()) renderRaw(curS());
    renderCalLog();
  });
  $("#s-save").addEventListener("click", async () => {
    state.settings.routes = collectRoutes();
    state.settings.maxCode = +$("#s-maxcode").value || 40000;
    state.settings.minGapMs = Math.max(0, +$("#s-gap").value || 0);
    state.settings.verify = $("#s-verify").checked;
    const lintChanged = state.settings.lint !== $("#s-lint").checked;
    state.settings.lint = $("#s-lint").checked;
    await save();
    if (lintChanged) onGenChanged(); // ESLint findings depend on the toggle
    renderSettings();
    $("#s-status").textContent = T("saved");
    setTimeout(() => ($("#s-status").textContent = ""), 1500);
  });
  /* Every setting on this page back to what a fresh install has. Sessions, verdicts, rules, prompts and the profile
     (which live on other pages) are left alone. Saved keys and configured models go too, hence the confirmation. */
  SETTINGS_DEFAULTS = {
    provider: "",
    apiKey: "",
    model: "",
    baseUrl: "",
    minGapMs: 6500,
    maxCode: 40000,
    verify: true,
    lint: true,
    debugModel: false,
    hideDemo: false,
  };
  $("#s-reset-settings").addEventListener("click", async () => {
    if (!(await confirmDialog(T("s_reset_settings_confirm")))) return;
    const st = state.settings,
      lintChanged = st.lint !== SETTINGS_DEFAULTS.lint;
    Object.assign(st, SETTINGS_DEFAULTS, { keys: {}, models: {}, baseUrls: {}, cliPaths: {}, routes: {}, modelPool: [], defaultModelId: null });
    delete st.cliPath;
    delete st.theme; // the theme follows VS Code again
    {
      // the keys themselves are in the host's SecretStorage
      delete st.apiKey;
      delete st.keys;
      const ks = LensAI.getKeyStatus() || {};
      for (const prov of Object.keys(ks))
        if (ks[prov]) {
          const r = await window.__slSecretDelete(prov);
          if (r && !r.error) LensAI.setKeyStatus(r);
        }
      // back to the default addresses (the host keeps them; returning to a default asks nothing)
      for (const prov of Object.keys(LensAI.PROVIDERS))
        if (LensAI.PROVIDERS[prov].local || LensAI.PROVIDERS[prov].editableBase) await window.__slBaseUrlSet(prov, "");
    }
    applyTheme(hostTheme());
    await save();
    renderSettings();
    if (state.current) renderReview();
    renderList();
    if (lintChanged) onGenChanged(); // ESLint findings depend on the toggle
    $("#s-reset-settings-status").textContent = T("s_reset_settings_done");
    setTimeout(() => ($("#s-reset-settings-status").textContent = ""), 2500);
  });
  $("#s-reset-all").addEventListener("click", async () => {
    if (!(await confirmDialog(T("s_reset_all_confirm")))) return;
    await sessionStore.clear();
    state.index = {};
    state.loaded = {};
    state.revs = {};
    state.gens = {};
    state.rulesApplied = {};
    state.rulesDismissed = {};
    state.external = [];
    state.calibLog = [];
    state.compressResults = [];
    state.skillResults = [];
    state.current = null;
    await save();
    $("#s-reset-status").textContent = T("s_reset_all_done");
    setTimeout(() => ($("#s-reset-status").textContent = ""), 2000);
    renderList();
  });
}

// ---------- settings: models ----------
// A model is added once (provider + model name, with its key/base URL/CLI path saved per provider),
// then every request (segment/review/verify/compress/skill) just picks one from that list — the
// routing no longer depends on which provider happens to be selected anywhere else on this page.
// Existing installs had a single active provider/model plus free-text per-task routes; lift whatever
// was actually configured (a real key, or a keyless/local provider) into the new pool, once.
export function migrateModelPool() {
  const st = state.settings;
  if (Array.isArray(st.modelPool)) return;
  st.modelPool = [];
  st.defaultModelId = null;
  const seen = new Set();
  const tryAdd = (prov, model) => {
    const p = LensAI.PROVIDERS[prov];
    if (!prov || !p) return null;
    const hasCred = p.local || p.noKey || LensAI.hasKey(st, prov);
    if (!hasCred) return null;
    model = model || (st.models || {})[prov] || p.defaultModel;
    const dupKey = prov + "|" + model;
    if (seen.has(dupKey)) return null;
    seen.add(dupKey);
    const id = "m_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    st.modelPool.push({ id, provider: prov, model });
    return id;
  };
  if (st.provider) {
    const id = tryAdd(st.provider, st.model);
    if (id) st.defaultModelId = id;
  }
  for (const r of Object.values(st.routes || {})) if (r && r.provider) tryAdd(r.provider, r.model);
  if (!st.defaultModelId && st.modelPool[0]) st.defaultModelId = st.modelPool[0].id;
}

export function modelLabel(m) {
  const p = LensAI.PROVIDERS[m.provider] || {};
  return (m.label && m.label.trim()) || `${p.label || m.provider} — ${m.model}`;
}

export function findPoolEntry(prov, model) {
  return (state.settings.modelPool || []).find((m) => m.provider === prov && m.model === model);
}

export function setDefaultModel(id) {
  const st = state.settings,
    m = (st.modelPool || []).find((x) => x.id === id);
  if (!m) return;
  const p = LensAI.PROVIDERS[m.provider] || {};
  st.defaultModelId = id;
  st.provider = m.provider;
  st.model = m.model;
  st.baseUrl = (st.baseUrls || {})[m.provider] || p.defaultBaseUrl || "";
}

export function removeModel(id) {
  const st = state.settings;
  st.modelPool = (st.modelPool || []).filter((m) => m.id !== id);
  if (st.defaultModelId === id) {
    const next = st.modelPool[0];
    if (next) setDefaultModel(next.id);
    else {
      st.defaultModelId = null;
      st.provider = "";
      st.model = "";
      st.baseUrl = "";
    }
  }
}

export function defaultModelLabel() {
  const m = (state.settings.modelPool || []).find((x) => x.id === state.settings.defaultModelId);
  return m ? modelLabel(m) : T("s_models_none");
}

export function renderModelPool() {
  const pool = state.settings.modelPool || [],
    el = $("#s-model-list");
  if (!pool.length) {
    el.innerHTML = `<div class="muted">${esc(T("s_models_empty"))}</div>`;
    return;
  }
  el.innerHTML = pool
    .map(
      (
        m,
      ) => `<div class="row" data-id="${esc(m.id)}" style="justify-content:space-between;align-items:center;border:1px solid var(--rail);border-radius:6px;padding:6px 8px;margin-top:6px">
      <div><b>${esc(modelLabel(m))}</b>${m.id === state.settings.defaultModelId ? ` <span class="muted">· ${esc(T("s_models_default"))}</span>` : ""}</div>
      <div class="row" style="gap:6px;margin:0">
        ${m.id === state.settings.defaultModelId ? "" : `<button class="btn tiny ghost m-default" data-id="${esc(m.id)}">${esc(T("s_models_set_default"))}</button>`}
        <button class="btn tiny danger m-remove" data-id="${esc(m.id)}">${esc(T("s_models_remove"))}</button>
      </div></div>`,
    )
    .join("");
  el.querySelectorAll(".m-default").forEach((b) =>
    b.addEventListener("click", async () => {
      setDefaultModel(b.dataset.id);
      await save();
      renderModelPool();
      renderRoutes();
    }),
  );
  el.querySelectorAll(".m-remove").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!(await confirmDialog(T("s_models_remove_confirm")))) return;
      removeModel(b.dataset.id);
      await save();
      renderModelPool();
      renderRoutes();
    }),
  );
}

// populates the "add a model" form for the chosen provider; nothing here is saved until Add is pressed
export function renderAddForm(prov) {
  const p = LensAI.PROVIDERS[prov];
  // the key itself is never shown: only whether the host has one (VS Code build)
  const saved = LensAI.hasKey(state.settings, prov),
    needsKeyHere = !p.local && !p.noKey;
  $("#s-add-key-label").textContent = T("key_label", { p: p.label }) + (needsKeyHere ? " · " + T(saved ? "key_saved" : "key_not_set") : "");
  $("#s-add-key").placeholder = saved ? T("key_keep_ph") : p.keyHint;
  $("#s-add-key").value = "";
  $("#s-add-key-del").style.display = saved && needsKeyHere ? "inline-block" : "none";
  $("#s-add-model").value = "";
  $("#s-add-model").placeholder = p.defaultModel;
  $("#s-add-model-hint").textContent = T("model_default", { m: p.defaultModel }) + (prov === "local" ? T("local_model_hint") : "");
  $("#s-add-label").value = "";
  const baseRow = $("#s-add-base-row"),
    keyRow = $("#s-add-key").closest("label");
  baseRow.style.display = p.local || p.editableBase ? "block" : "none";
  $("#s-add-baseurl-hint").textContent = T(p.editableBase ? "s_baseurl_hint_qwen" : "s_baseurl_hint");
  $("#s-add-baseurl").placeholder = p.defaultBaseUrl || "";
  $("#s-add-baseurl").value = "";
  keyRow.style.display = p.local || p.noKey ? "none" : "block";
  $("#s-add-cli-row").style.display = p.cli ? "block" : "none";
  if (p.cli) {
    const suf = p.cliKind === "codex" ? "_codex" : "";
    $("#s-add-model-hint").textContent = T("model_hint_cli" + suf);
    $("#s-add-cli-note").textContent = T("cli_note" + suf);
    $("#s-add-cli-path-label").textContent = T("s_cli_path" + suf);
    // the path is a machine-scoped VS Code setting (see package.json), not something this page can set
    $("#s-add-cli-settings").textContent = T("s_cli_open_settings");
    $("#s-add-cli-hint").textContent = T("s_cli_hint" + suf);
    $("#s-add-cli-check").textContent = T("cli_check_btn" + suf);
    $("#s-add-cli-status").textContent = "";
  }
}

export function renderRoutes() {
  const st = state.settings,
    routes = st.routes || {},
    pool = st.modelPool || [];
  const opt = (v, label, sel) => `<option value="${esc(v)}" ${sel ? "selected" : ""}>${esc(label)}</option>`;
  $("#s-routes").innerHTML = ROUTE_TASKS.map(([task, lk, sk]) => {
    const r = routes[task] || {},
      match = r.provider ? findPoolEntry(r.provider, r.model) : null;
    return `<div class="route-row" data-task="${esc(task)}" style="margin-top:8px">
        <b>${esc(T(lk))}</b> <span class="muted">${esc(T(sk))}</span>
        <select class="route-model" style="width:100%">
          ${opt("", T("route_default", { m: defaultModelLabel() }), !match)}
          ${pool.map((m) => opt(m.id, modelLabel(m), !!match && match.id === m.id)).join("")}
        </select></div>`;
  }).join("");
}

export function collectRoutes() {
  const out = {};
  $("#s-routes")
    .querySelectorAll(".route-row")
    .forEach((row) => {
      const v = row.querySelector(".route-model").value,
        task = row.dataset.task;
      if (!v) return; // "" = default, nothing to store
      const m = (state.settings.modelPool || []).find((x) => x.id === v);
      if (m) out[task] = { provider: m.provider, model: m.model };
    });
  return out;
}

// ---------- settings: everything else on this page ----------
export function renderSettings() {
  renderAddForm($("#s-add-provider").value || "anthropic");
  renderModelPool();
  renderRoutes();
  $("#s-maxcode").value = state.settings.maxCode || 40000;
  $("#s-gap").value = Number.isFinite(state.settings.minGapMs) ? state.settings.minGapMs : 6500;
  $("#s-verify").checked = state.settings.verify !== false;
  $("#s-lint").checked = state.settings.lint !== false;
  $("#s-hide-demo").checked = state.settings.hideDemo === true;
  $("#s-debug-model").checked = state.settings.debugModel === true;
  $("#s-addmodel-d").open = state.settings.addModelOpen === true;
  $("#s-routes-d").open = state.settings.routesOpen === true;
}
