/* Generated from src/webview by `npm run build` (scripts/build-webview.js). Do not edit: change src/webview. */
(() => {
  // src/webview/common.js
  var $;
  var esc;
  var fkey;
  var genId;
  var RULES_TARGET_FILES;
  var rulesTargetFiles;
  var rulesTargetLabel;
  var T;
  var LABEL;
  var SEV;
  var VLABEL;
  var VCOL;
  var hostTheme;
  var store;
  var state;
  var SMALL_KEYS;
  var save;
  function initCommon() {
    $ = (s) => document.querySelector(s);
    esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    fkey = (f) => Lens.fkey(f);
    genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    RULES_TARGET_FILES = { claude: ["CLAUDE.md"], codex: ["AGENTS.md"], both: ["CLAUDE.md", "AGENTS.md"] };
    rulesTargetFiles = () => RULES_TARGET_FILES[state.settings.rulesTarget] || RULES_TARGET_FILES.claude;
    rulesTargetLabel = () => rulesTargetFiles().join(" and ");
    T = (k, v) => I18N.t(k, v);
    LABEL = new Proxy({}, { get: (_, k) => T(k) });
    SEV = new Proxy({}, { get: (_, k) => T("sev_" + /** @type {string} */
    k) });
    VLABEL = new Proxy({}, { get: (_, k) => T("verdict_" + /** @type {string} */
    k) });
    VCOL = { red: "var(--red)", yellow: "var(--amber)", green: "var(--green)" };
    hostTheme = () => document.body.classList.contains("vscode-dark") || document.body.classList.contains("vscode-high-contrast") ? "dark" : "light";
    applyTheme(hostTheme());
    new MutationObserver(() => applyTheme(hostTheme())).observe(document.body, { attributes: true, attributeFilter: ["class"] });
    store = {
      async get() {
        const r = await chrome.storage.local.get([
          "settings",
          "rulesApplied",
          "rulesDismissed",
          "external",
          "ruleOverrides",
          "calibLog",
          "compressResults",
          "skillResults",
          "analysisEpoch",
          "lintRepair"
        ]);
        return {
          calibLog: r.calibLog || [],
          compressResults: r.compressResults || [],
          skillResults: r.skillResults || [],
          analysisEpoch: Number.isInteger(r.analysisEpoch) ? r.analysisEpoch : 0,
          lintRepair: Number.isInteger(r.lintRepair) ? r.lintRepair : 0,
          ruleOverrides: r.ruleOverrides || {},
          settings: Object.assign(
            {
              profile: "qa-ts",
              provider: "",
              apiKey: "",
              model: "",
              keys: {},
              models: {},
              baseUrls: {},
              minGapMs: 6500,
              maxCode: 4e4,
              verify: true,
              lint: true,
              debugModel: false,
              rulesTarget: "claude",
              prompts: {}
            },
            r.settings || {}
          ),
          rulesApplied: r.rulesApplied || {},
          rulesDismissed: r.rulesDismissed || {},
          external: r.external || []
        };
      },
      async set(o) {
        await chrome.storage.local.set(o);
      }
    };
    state = {
      calibLog: [],
      compressResults: [],
      skillResults: [],
      index: {},
      loaded: {},
      revs: {},
      gens: {},
      analysisEpoch: 0,
      lintRepair: 0,
      settings: {},
      rulesApplied: {},
      rulesDismissed: {},
      external: [],
      ruleOverrides: {},
      current: null,
      filter: { src: { formal: true, lint: true, spec: true, ai: true }, sev: { high: true, medium: true, low: true }, undecided: false }
    };
    SMALL_KEYS = ["settings", "rulesApplied", "rulesDismissed", "external", "ruleOverrides", "calibLog", "compressResults", "skillResults", "analysisEpoch"];
    save = () => saveKeys(SMALL_KEYS);
  }
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
  }
  function saveKeys(keys) {
    const o = {};
    for (const k of keys) o[k] = state[k];
    return store.set(o);
  }

  // src/webview/analysis.js
  function initAnalysis() {
  }
  function analyze(s, event) {
    const t0 = Date.now();
    analyzeNow(s);
    try {
      window.__slLogTiming(event || "reanalyze", String(s.profile || ""), Math.max(0, Date.now() - t0), Array.isArray(s.events) ? s.events.length : 0);
    } catch (e) {
    }
  }
  function analyzeNow(s) {
    const cfg = Lens.profile(s.profile);
    const calib = calibStats();
    const formal = Lens.runChecks(s.events, cfg, calib);
    const gherkin = Lens.gherkinChecks(s.events);
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
      if (lr.pending) s.lintPending = true;
      if (lr.ran) base = LensLint.merge(formal, lr.findings);
    }
    s.findings = Lens.sortFindings(LensRules.apply([...base, ...gherkin, ...sc.findings, ...ai], state.ruleOverrides));
    s.coverage = sc.coverage;
    s.specParsed = { n: spec.requirements.length, oos: spec.outOfScope.length, hasIds: spec.requirements.some((r) => !r.auto) };
    s.suppressed = formal.suppressed || [];
    s.metrics = Lens.metrics(s.events);
    s.task = s.task || Lens.taskId(s.events);
    state.gens[s.id] = s.lintPending ? "" : genNow();
  }

  // src/webview/calibration.js
  var CAL_LOG_KEEP;
  var CAL_LOG_MAX_CHARS;
  var EXAMPLE_FILES_PER_RULE;
  var EXAMPLE_MAX_CHARS;
  var skillStubPath;
  var stubText;
  function initCalibration() {
    $("#export-json").addEventListener("click", () => {
      const s = curS();
      download(`${(s.task || s.name).replace(/\W+/g, "-")}-review.json`, JSON.stringify(reportObj(s), null, 1));
    });
    $("#export-md").addEventListener("click", async () => {
      const s = curS();
      const miss = highWithoutVerdict(s);
      if (miss.length) {
        await alertDialog(T("export_block", { n: miss.length }));
        return;
      }
      const r = reportObj(s);
      const m = s.metrics || {};
      const sev = { high: "🔴", medium: "🟡", low: "⚪" };
      const md = [
        T("md_title", { t: r.task || r.session }),
        ``,
        T("md_verdict", { v: VLABEL[r.verdict], p: r.profile, r: m.reads, e: m.edits, re: m.readEdit ?? "—", runs: m.runs, g: m.editsToGreen ?? "—" }),
        r.spec && r.spec.n ? T("md_spec", {
          n: r.spec.n,
          unc: s.coverage ? T("md_unc", { list: s.coverage.uncovered.length ? s.coverage.uncovered.join(", ") : T("md_none") }) : ""
        }) : T("md_no_spec"),
        ``,
        T("md_confirmed"),
        ...r.findings.filter((f) => f.verdict && f.verdict.v === "ok").map(
          (f) => `- ${sev[f.severity]} **${SEV[f.severity]}** ${f.message}${f.seq >= 0 ? ` _(seq ${f.seq})_` : ""}${f.verdict.note ? ` — ${f.verdict.note}` : ""}`
        ),
        ``,
        T("md_false"),
        ...r.findings.filter((f) => f.verdict && f.verdict.v === "fp").map((f) => `- ~~${f.message}~~${f.verdict.note ? ` — ${f.verdict.note}` : ""}`),
        ``,
        T("md_undecided"),
        ...r.findings.filter((f) => !f.verdict).map((f) => `- ${sev[f.severity]} ${f.message}`),
        ``,
        `_sessionlens · ${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}_`
      ].join("\n");
      navigator.clipboard.writeText(md).then(() => {
        $("#export-md").textContent = T("md_copied");
        setTimeout(() => $("#export-md").textContent = T("md_btn"), 1500);
      });
      download(`${(s.task || s.name).replace(/\W+/g, "-")}-review.md`, md);
    });
    $("#rename").addEventListener("click", async () => {
      const s = curS();
      const name = await promptDialog(T("rename_prompt"), s.name);
      if (name === null) return;
      await renameCurrent(name.trim() || s.name);
    });
    $("#del-session").addEventListener("click", async () => {
      if (!await confirmDialog(T("del_confirm"))) return;
      const id = state.current;
      await sessionStore.delete(id);
      delete state.loaded[id];
      delete state.index[id];
      state.current = null;
      if (window.SL_OPEN_SESSION) {
        window.__slCloseSelf();
        return;
      }
      show("sessions");
    });
    $("#mark-reviewed").addEventListener("click", async () => {
      const val = !curS().reviewed;
      await updateSession(state.current, (s) => {
        s.reviewed = val;
      });
      renderReview();
      renderList();
    });
    $("#rules-restore").addEventListener("click", async () => {
      if (!await confirmDialog(T("rules_restore_confirm"))) return;
      state.rulesDismissed = {};
      await save();
      renderCalib();
    });
    $("#min-count").addEventListener("change", renderCalib);
    $("#rules-target").addEventListener("change", async (e) => {
      state.settings.rulesTarget = e.target.value;
      await save();
      renderCalib();
    });
    $("#rules-pick-all").addEventListener(
      "click",
      () => $("#rules").querySelectorAll(".rule-pick").forEach((c) => {
        c.checked = true;
      })
    );
    $("#rules-pick-none").addEventListener(
      "click",
      () => $("#rules").querySelectorAll(".rule-pick").forEach((c) => {
        c.checked = false;
      })
    );
    $("#copy-rules").addEventListener("click", async () => {
      const md = T("rules_title", { f: rulesTargetLabel() }) + "\n\n" + (pickedRulesMd() || T("rules_none") + "\n");
      await navigator.clipboard.writeText(md);
      $("#copy-rules").textContent = T("rules_copied");
      setTimeout(() => $("#copy-rules").textContent = T("rules_copy"), 1500);
    });
    CAL_LOG_KEEP = 6;
    CAL_LOG_MAX_CHARS = 3e5;
    $("#cal-raw-copy").addEventListener("click", async () => {
      await navigator.clipboard.writeText($("#cal-raw").value);
      $("#cal-raw-copy").textContent = T("copied");
      setTimeout(() => $("#cal-raw-copy").textContent = T("copy"), 1200);
    });
    $("#cal-raw-dl").addEventListener("click", () => download("model-dump-calibration.txt", $("#cal-raw").value));
    $("#cal-raw-clear").addEventListener("click", async () => {
      if (!await confirmDialog(T("cal_raw_clear_confirm"))) return;
      state.calibLog = [];
      await save();
      renderCalLog();
    });
    $("#compress-rules").addEventListener("click", async () => {
      const btn = $("#compress-rules"), st = $("#compress-status");
      const body = pickedRulesMd();
      if (!body.trim()) {
        st.textContent = T("compress_none");
        return;
      }
      const md = T("rules_title", { f: rulesTargetLabel() }) + "\n\n" + body;
      {
        const miss = LensAI.missingKey(state.settings, "compress");
        if (miss) {
          st.textContent = T("err_no_key_for", { p: miss });
          return;
        }
      }
      const prevList = state.compressResults || [];
      let overwriteId = null;
      if (prevList.length && prevList[0].body === body) {
        const choice = await chooseDialog(T("gen_dup_msg"), [
          { label: T("gen_dup_overwrite"), value: "overwrite", primary: true },
          { label: T("gen_dup_new"), value: "new" }
        ]);
        if (choice === null) return;
        if (choice === "overwrite") overwriteId = prevList[0].id;
      }
      btn.disabled = true;
      st.textContent = T("compress_wait");
      try {
        const r = await LensAI.compressRules(md, state.settings, void 0, rulesTargetLabel());
        if (overwriteId) {
          state.compressResults = state.compressResults.map(
            (x) => x.id === overwriteId ? { id: overwriteId, at: (/* @__PURE__ */ new Date()).toISOString(), markdown: r.markdown, body } : x
          );
          await save();
          renderCompressResults(overwriteId);
        } else {
          const id = genId();
          state.compressResults = [{ id, at: (/* @__PURE__ */ new Date()).toISOString(), markdown: r.markdown, body }, ...state.compressResults || []];
          await save();
          renderCompressResults(id);
        }
        st.textContent = "";
        await logCal("compress", r.raw);
      } catch (e) {
        st.textContent = T("error") + e.message;
        if (e.raw) await logCal("compress", e.raw, e.message);
      }
      btn.disabled = false;
    });
    EXAMPLE_FILES_PER_RULE = 2;
    EXAMPLE_MAX_CHARS = 4e4;
    skillStubPath = (skillName) => `skills/${skillName}/SKILL.md`;
    stubText = (refPath) => `Refer to \`${refPath}\` for domain-specific automation rules and code style.
`;
    $("#gen-skill").addEventListener("click", async () => {
      const btn = $("#gen-skill"), st = $("#gen-skill-status");
      const body = pickedRulesMd();
      if (!body.trim()) {
        st.textContent = T("compress_none");
        return;
      }
      {
        const miss = LensAI.missingKey(state.settings, "skill");
        if (miss) {
          st.textContent = T("err_no_key_for", { p: miss });
          return;
        }
      }
      const prevList = state.skillResults || [];
      let overwriteId = null;
      if (prevList.length && prevList[0].body === body) {
        const choice = await chooseDialog(T("gen_dup_msg"), [
          { label: T("gen_dup_overwrite"), value: "overwrite", primary: true },
          { label: T("gen_dup_new"), value: "new" }
        ]);
        if (choice === null) return;
        if (choice === "overwrite") overwriteId = prevList[0].id;
      }
      const ex = $("#gen-skill-examples").checked ? await buildExamples(pickedRuleKeys()) : { files: [], rows: [], masked: 0 };
      const exList = ex.rows.length ? "\n\n## Example files\n" + [...new Set(ex.rows.map((r) => r.k))].map(
        (k) => `- ${k}: ` + ex.rows.filter((r) => r.k === k).map((r) => r.path).join(", ")
      ).join("\n") + "\n" : "";
      const md = T("rules_title", { f: rulesTargetLabel() }) + "\n\n" + body + exList;
      btn.disabled = true;
      st.textContent = T("gen_skill_wait");
      try {
        const r = await LensAI.generateSkill(md, state.settings, void 0, rulesTargetLabel());
        r.files = r.files.filter((f) => !/^examples\//.test(f.path)).concat(ex.files);
        if (overwriteId) {
          state.skillResults = state.skillResults.map(
            (x) => x.id === overwriteId ? { id: overwriteId, at: (/* @__PURE__ */ new Date()).toISOString(), skill_name: r.skill_name, files: r.files, body } : x
          );
          await save();
          renderSkillResults(overwriteId);
        } else {
          const id = genId();
          state.skillResults = [{ id, at: (/* @__PURE__ */ new Date()).toISOString(), skill_name: r.skill_name, files: r.files, body }, ...state.skillResults || []];
          await save();
          renderSkillResults(id);
        }
        await logCal("skill", r.raw);
        st.textContent = $("#gen-skill-examples").checked ? ex.rows.length ? T("gen_examples_added", { n: ex.rows.length, r: ex.masked }) : T("gen_examples_none") : "";
      } catch (e) {
        st.textContent = T("error") + e.message;
        if (e.raw) await logCal("skill", e.raw, e.message);
      }
      btn.disabled = false;
    });
    $("#export-verdicts").addEventListener("click", () => exportVerdicts());
    $("#import-file").addEventListener("change", (ev) => {
      const f = ev.target.files[0];
      if (f) readFile(f, importVerdicts);
      ev.target.value = "";
    });
  }
  function reportObj(s) {
    return {
      schema: "sessionlens/finding@1",
      session: s.name,
      task: s.task,
      profile: s.profile,
      created: s.created,
      verdict: Lens.verdict(s.findings),
      metrics: s.metrics,
      spec: s.specParsed,
      findings: s.findings.map((f) => ({
        check: f.check,
        severity: f.severity,
        seq: f.seq,
        message: f.message,
        evidence: f.evidence || null,
        source: f.source || "formal",
        verdict: s.verdicts[fkey(f)] || null
      })),
      dropped: s.dropped || []
    };
  }
  function highWithoutVerdict(s) {
    return s.findings.filter((f) => f.severity === "high" && !s.verdicts[fkey(f)]);
  }
  async function renameCurrent(name) {
    const s = curS();
    if (!s) return;
    const next = String(name || "").trim();
    if (!next) return;
    await updateSession(state.current, (x) => {
      x.name = next;
      x.nameSet = true;
    });
    renderReview();
    renderList();
  }
  function renderCalib() {
    renderCalLog();
    renderCompressResults();
    renderSkillResults();
    $("#calib-prec-d").open = state.settings.calibPrecOpen !== false;
    $("#calib-rules-d").open = state.settings.calibRulesOpen !== false;
    $("#c-rules-title").textContent = T("c_rules", { f: rulesTargetLabel() });
    $("#rules-target").value = state.settings.rulesTarget || "claude";
    const stats = calibStats();
    const confirmed = [];
    for (const m of metas()) for (const c of m.confirmed || []) confirmed.push({ s: m, f: c, vd: { v: "ok", note: c.note } });
    $("#precision").innerHTML = `<tr>${T("prec_hdr").map((h) => `<th>${esc(h)}</th>`).join("")}</tr>` + Object.entries(stats).sort((a, b) => b[1].total - a[1].total).map(([k, st]) => {
      const { n, p, level } = Lens.calibLevel(st);
      const status = level === "need" ? T("st_need", { n: 10 - n }) : T("st_" + level);
      return `<tr><td>${esc(k)}</td><td>${esc(st.total)}</td><td>${esc(st.ok)}</td><td>${esc(st.fp)}</td><td style="color:${p == null ? "var(--muted)" : p < 0.5 ? "var(--red)" : p < 0.8 ? "var(--amber)" : "var(--green)"}">${p == null ? "—" : Math.round(p * 100) + "%"}</td><td class="muted">${esc(status)}</td></tr>`;
    }).join("");
    const min = +$("#min-count").value || 1, by = {};
    for (const c of confirmed) (by[c.f.check] = by[c.f.check] || []).push(c);
    const rules = Object.entries(by).filter(([k, l]) => l.length >= min && !state.rulesDismissed[k]).sort((a, b) => b[1].length - a[1].length);
    const snippet = (f) => f.snippet;
    const ruleMd = (k, l) => {
      const bad = [...new Set(l.map((x) => snippet(x.f)))].slice(0, 2);
      const good = LensRules.exampleGood(k, state.ruleOverrides);
      return [
        `## ${T("rule_hdr", { k, n: l.length, s: new Set(l.map((x) => x.s.id)).size })}`,
        "",
        `${T("rules_rule")} ${LensRules.ruleText(k, state.ruleOverrides)}`,
        "",
        `${T("md_bad")}`,
        ...bad.map((b) => "```\n" + b + "\n```"),
        good ? `${T("md_good")}

\`\`\`
${good}
\`\`\`` : "",
        "",
        `${T("rules_ev")}`,
        ...l.slice(0, 5).map((x) => `- ${x.s.task || x.s.name}, seq ${x.f.seq}${x.vd.note ? ` — «${x.vd.note}»` : ""}`),
        ""
      ].join("\n");
    };
    $("#rules-pick-row").hidden = !rules.length;
    const dismissedCount = Object.keys(state.rulesDismissed).length;
    $("#dismissed-row").hidden = !dismissedCount;
    if (dismissedCount) $("#dismissed-note").textContent = T("dismissed_note", { n: dismissedCount });
    $("#rules").innerHTML = rules.length ? rules.map(([k, l]) => {
      const ap = state.rulesApplied[k];
      const eff = ap ? effect(k, ap) : null;
      const evOpen = (state.settings.rulesEvOpen || {})[k] === true;
      return `<div class="rule" data-k="${esc(k)}" data-md="${esc(encodeURIComponent(ruleMd(k, l)))}">
        <div class="rule-top"><input type="checkbox" class="rule-pick" checked><b>${esc(T("rule_hdr", { k, n: l.length, s: new Set(l.map((x) => x.s.id)).size }))}</b></div>
        ${esc(LensRules.ruleText(k, state.ruleOverrides))}
        <details class="sec-d ev-d" data-check="${esc(k)}" ${evOpen ? "open" : ""}><summary class="h2">${T("ev_summary")}</summary><div class="ev">${l.slice(0, 5).map(
        (x) => `${esc(x.s.task || x.s.name)}, seq ${esc(x.f.seq)}: ${esc(String(x.f.message || "").slice(0, 90))}${x.vd.note ? ` — «${esc(x.vd.note)}»` : ""}`
      ).join("<br>")}</div></details>
        <div class="row actions rule-actions">${ap ? `<span class="applied">${esc(T("applied", { f: rulesTargetLabel(), d: String(ap).slice(0, 10) }))}</span><button class="btn tiny ghost unmark-applied">${T("unmark_applied")}</button>` : `<button class="btn tiny ghost mark-applied">${esc(T("mark_applied", { f: rulesTargetLabel() }))}</button>`}<button class="btn tiny ghost danger del-rule">${T("delete")}</button></div>
        ${ap ? `<div class="effect">${eff}</div>` : ""}</div>`;
    }).join("") : `<p class="muted">${T("no_rules")}</p>`;
    $("#rules").querySelectorAll(".ev-d").forEach((d) => {
      d.addEventListener("toggle", async () => {
        state.settings.rulesEvOpen = Object.assign({}, state.settings.rulesEvOpen, { [d.dataset.check]: d.open });
        await save();
      });
    });
    $("#rules").querySelectorAll(".mark-applied").forEach(
      (b) => b.addEventListener("click", async () => {
        state.rulesApplied[b.closest(".rule").dataset.k] = (/* @__PURE__ */ new Date()).toISOString();
        await save();
        renderCalib();
      })
    );
    $("#rules").querySelectorAll(".unmark-applied").forEach(
      (b) => b.addEventListener("click", async () => {
        if (!await confirmDialog(T("unmark_applied_confirm", { f: rulesTargetLabel() }))) return;
        delete state.rulesApplied[b.closest(".rule").dataset.k];
        await save();
        renderCalib();
      })
    );
    $("#rules").querySelectorAll(".del-rule").forEach(
      (b) => b.addEventListener("click", async () => {
        const k = b.closest(".rule").dataset.k;
        if (!await confirmDialog(T("rule_del_confirm", { f: rulesTargetLabel() }))) return;
        state.rulesDismissed[k] = true;
        await save();
        renderCalib();
      })
    );
  }
  function pickedRulesMd() {
    const parts = [];
    $("#rules").querySelectorAll(".rule").forEach((d) => {
      const cb = d.querySelector(".rule-pick");
      if (cb && cb.checked) parts.push(decodeURIComponent(d.dataset.md));
    });
    return parts.join("\n");
  }
  function effect(check, since) {
    const before = [], after = [];
    for (const m of metas()) (m.created < since ? before : after).push(((m.checkStats || {})[check] || { total: 0 }).total);
    const avgNum = (a2) => a2.length ? a2.reduce((x, y) => x + y, 0) / a2.length : null;
    const avg = (a2) => {
      const v = avgNum(a2);
      return v == null ? "—" : v.toFixed(2);
    };
    if (!after.length) return `<div class="eff-note">${T("eff_no_after", { b: avg(before), n: before.length })}</div>`;
    const bNum = avgNum(before), aNum = avgNum(after);
    const b = +avg(before), a = +avg(after);
    const d = before.length && b > 0 ? Math.round((1 - a / b) * 100) : null;
    const note = T("eff", {
      b: avg(before),
      nb: before.length,
      a: avg(after),
      na: after.length,
      d: d != null ? ` — ${d > 0 ? "−" : "+"}${Math.abs(d)}%` : "",
      few: after.length < 5 ? T("eff_few") : ""
    });
    const max = Math.max(bNum || 0, aNum, 0.01);
    const bw = bNum ? Math.max(3, Math.round(bNum / max * 100)) : 0;
    const aw = Math.max(3, Math.round(aNum / max * 100));
    const dir = bNum == null ? "flat" : aNum < bNum ? "good" : aNum > bNum ? "bad" : "flat";
    const chart = `<div class="eff-chart">
      <div class="eff-row"><span class="eff-lbl">${T("eff_before")}</span><div class="eff-track"><div class="eff-bar" style="width:${bw}%"></div></div><span class="eff-val">${avg(before)}</span></div>
      <div class="eff-row"><span class="eff-lbl">${T("eff_after")}</span><div class="eff-track"><div class="eff-bar ${dir}" style="width:${aw}%"></div></div><span class="eff-val">${avg(after)}</span></div>
    </div>`;
    return chart + `<div class="eff-note">${note}</div>`;
  }
  async function logCal(task, raw, error) {
    if (!raw) return;
    state.calibLog = [
      { at: (/* @__PURE__ */ new Date()).toISOString(), task, raw: String(raw).slice(0, CAL_LOG_MAX_CHARS), error: error || null },
      ...state.calibLog || []
    ].slice(0, CAL_LOG_KEEP);
    await save();
    renderCalLog();
  }
  function calLogText() {
    const label = { compress: T("p_compress"), skill: T("p_gen_skill") };
    return (state.calibLog || []).map((en) => `######## ${en.at.replace("T", " ").slice(0, 19)} · ${label[en.task] || en.task}${en.error ? " · " + T("raw_error") : ""} ########
${en.raw}`).join("\n\n\n");
  }
  function renderCalLog() {
    const d = $("#cal-raw-d"), log = state.calibLog || [];
    if (!state.settings.debugModel) {
      d.hidden = true;
      return;
    }
    if (!log.length) {
      d.hidden = true;
      return;
    }
    d.hidden = false;
    $("#cal-raw").value = calLogText();
    $("#cal-raw-count").textContent = T("cal_raw_count", { n: log.length }) + (log[0].error ? " " + T("raw_error") : "");
  }
  function renderCompressResults(openId) {
    const list = state.compressResults || [];
    $("#compress-d").hidden = !list.length;
    $("#compress-results").innerHTML = list.map(
      (r) => `<details class="sec-d gen-result" data-id="${esc(r.id)}" ${r.id === openId ? "open" : ""}>
      <summary class="h2">${esc(r.at.replace("T", " ").slice(0, 19))}</summary>
      <textarea class="compress-out" readonly style="height:220px;font-family:monospace;font-size:12px">${esc(r.markdown)}</textarea>
      <div class="row actions"><button class="btn tiny ghost gr-copy">${T("copy")}</button><button class="btn tiny ghost gr-dl">${T("compress_dl")}</button><button class="btn tiny ghost danger gr-del">${T("delete")}</button></div>
      <details class="gen-file"><summary>${esc(T("gen_skill_stub_title"))}</summary>
        <p class="muted">${esc(T("gen_skill_stub_note", { f: rulesTargetLabel() }))}</p>
        <textarea readonly class="stub-text" style="height:48px;font-family:monospace;font-size:12px">${esc(stubText("rules-policy.md"))}</textarea>
        <div class="row actions"><button class="btn tiny ghost stub-copy">${T("copy")}</button></div>
      </details>
    </details>`
    ).join("");
    $("#compress-results").querySelectorAll(".gen-result").forEach((d) => {
      const id = d.dataset.id, ta = d.querySelector(".compress-out");
      const copyBtn = d.querySelector(".gr-copy");
      copyBtn.addEventListener("click", async () => {
        await navigator.clipboard.writeText(ta.value);
        copyBtn.textContent = T("copied");
        setTimeout(() => copyBtn.textContent = T("copy"), 1200);
      });
      d.querySelector(".gr-dl").addEventListener("click", () => download("rules-policy.md", ta.value));
      d.querySelector(".stub-copy").addEventListener("click", async () => {
        await navigator.clipboard.writeText(d.querySelector(".stub-text").value);
        const b = d.querySelector(".stub-copy");
        b.textContent = T("copied");
        setTimeout(() => b.textContent = T("copy"), 1200);
      });
      d.querySelector(".gr-del").addEventListener("click", async () => {
        if (!await confirmDialog(T("gen_result_del_confirm"))) return;
        state.compressResults = (state.compressResults || []).filter((x) => x.id !== id);
        await save();
        renderCompressResults();
      });
    });
  }
  function pickedRuleKeys() {
    const ks = [];
    $("#rules").querySelectorAll(".rule").forEach((d) => {
      const cb = d.querySelector(".rule-pick");
      if (cb && cb.checked) ks.push(d.dataset.k);
    });
    return ks;
  }
  function confirmedFor(k, full) {
    const out = [];
    for (const m of metas()) {
      const s = full[m.id];
      if (!s) continue;
      for (const f of s.findings) {
        const vd = s.verdicts[fkey(f)];
        if (f.check === k && vd && vd.v === "ok") out.push({ s, f });
      }
    }
    return out;
  }
  async function buildExamples(keys) {
    const full = {};
    await fetchSessions(
      metas().filter((m) => (m.confirmed || []).some((c) => keys.includes(c.check))).map((m) => m.id),
      (s) => {
        full[s.id] = s;
      }
    );
    const files = [], rows = [], used = /* @__PURE__ */ new Set();
    for (const k of keys) {
      const cand = confirmedFor(k, full).map(({ s, f }) => ({ s, f, e: s.events.find((x) => x.seq === f.seq) })).filter((x) => x.e && x.e.new_content && !x.e.fragment_only);
      const bySession = /* @__PURE__ */ new Set();
      const order = [...cand.filter((x) => !bySession.has(x.s.id) && bySession.add(x.s.id)), ...cand];
      let n = 0;
      for (const { s, f, e } of order) {
        if (n >= EXAMPLE_FILES_PER_RULE) break;
        const id = `${s.id}|${e.file || "seq" + f.seq}|${k}`;
        if (used.has(id)) continue;
        used.add(id);
        const base = ((e.file || "").split("/").pop() || `from-chat-seq${f.seq}.txt`).replace(/[^\w.\-]/g, "_");
        const cut = e.new_content.length > EXAMPLE_MAX_CHARS, red = Lens.redactSecrets(e.new_content.slice(0, EXAMPLE_MAX_CHARS));
        const path = `examples/${k}/${++n}-${base}`;
        files.push({ path, content: red.text });
        rows.push({ path, k, session: s.task || s.name, seq: f.seq, message: f.message, masked: red.count, cut });
      }
    }
    if (!files.length) return { files: [], rows: [], masked: 0 };
    const cell = (x) => String(x).replace(/\|/g, "\\|").replace(/\s+/g, " ").trim().slice(0, 160);
    const notes = (r) => [r.masked ? T("ex_masked", { n: r.masked }) : "", r.cut ? T("ex_truncated", { n: EXAMPLE_MAX_CHARS }) : ""].filter(Boolean).join("; ");
    const readme = [
      T("ex_readme_title"),
      "",
      T("ex_readme_body"),
      "",
      T("ex_col"),
      "|---|---|---|---|---|",
      ...rows.map(
        (r) => `| \`${r.path.replace("examples/", "")}\` | ${r.k} | ${cell(r.session)} | ${r.seq} | ${cell(r.message)}${notes(r) ? " (" + notes(r) + ")" : ""} |`
      ),
      ""
    ].join("\n");
    return { files: [{ path: "examples/README.md", content: readme }, ...files], rows, masked: rows.reduce((a, r) => a + r.masked, 0) };
  }
  function renderSkillResults(openId) {
    const list = state.skillResults || [];
    $("#gen-skill-d").hidden = !list.length;
    $("#gen-skill-results").innerHTML = list.map(
      (r) => `<details class="sec-d gen-result" data-id="${esc(r.id)}" ${r.id === openId ? "open" : ""}>
      <summary class="h2">${esc(r.at.replace("T", " ").slice(0, 19))} — ${esc(r.skill_name)}</summary>
      <div class="gen-skill-files">${r.files.map((f, i) => `<details class="gen-file"${i === 0 ? " open" : ""}><summary>${esc(f.path)}</summary><textarea readonly style="height:160px;font-family:monospace;font-size:12px">${esc(f.content)}</textarea></details>`).join("")}</div>
      <p class="muted">${T("gen_skill_note")}</p>
      <details class="gen-file"><summary>${esc(T("gen_skill_stub_title"))}</summary>
        <p class="muted">${esc(T("gen_skill_stub_note", { f: rulesTargetLabel() }))}</p>
        <textarea readonly class="stub-text" style="height:48px;font-family:monospace;font-size:12px">${esc(stubText(skillStubPath(r.skill_name)))}</textarea>
        <div class="row actions"><button class="btn tiny ghost stub-copy">${T("copy")}</button></div>
      </details>
      <div class="row actions"><button class="btn tiny ghost gs-save">${T("gen_skill_save")}</button><span class="muted gs-save-status"></span><button class="btn tiny ghost danger gr-del">${T("delete")}</button></div>
    </details>`
    ).join("");
    $("#gen-skill-results").querySelectorAll(".gen-result").forEach((d) => {
      const id = d.dataset.id;
      d.querySelector(".stub-copy").addEventListener("click", async () => {
        await navigator.clipboard.writeText(d.querySelector(".stub-text").value);
        const b = d.querySelector(".stub-copy");
        b.textContent = T("copied");
        setTimeout(() => b.textContent = T("copy"), 1200);
      });
      d.querySelector(".gs-save").addEventListener("click", async () => {
        const r = (state.skillResults || []).find((x) => x.id === id);
        if (!r) return;
        const stEl = d.querySelector(".gs-save-status");
        {
          const savedPath = await window.__slSaveFolder(r.skill_name, r.files);
          stEl.textContent = savedPath && savedPath.error ? savedPath.error : savedPath ? T("gen_skill_saved", { p: savedPath }) : "";
        }
        setTimeout(() => {
          stEl.textContent = "";
        }, 4e3);
      });
      d.querySelector(".gr-del").addEventListener("click", async () => {
        if (!await confirmDialog(T("gen_result_del_confirm"))) return;
        state.skillResults = (state.skillResults || []).filter((x) => x.id !== id);
        await save();
        renderSkillResults();
      });
    });
  }
  async function exportVerdicts() {
    const rows = [];
    await fetchSessions(
      metas().map((m) => m.id),
      (s) => {
        for (const f of s.findings) {
          const vd = s.verdicts[fkey(f)];
          if (vd)
            rows.push({
              schema: "sessionlens/finding@1",
              session: s.name,
              task: s.task,
              profile: s.profile,
              check: f.check,
              severity: f.severity,
              seq: f.seq,
              message: f.message,
              source: f.source || "formal",
              verdict: vd.v,
              note: vd.note,
              at: vd.at
            });
        }
      }
    );
    download("verdicts.json", JSON.stringify(rows, null, 1));
  }
  async function importVerdicts(text) {
    let rows;
    try {
      rows = JSON.parse(text);
      if (rows.findings) rows = rows.findings.map((f) => ({ ...f, session: rows.session }));
    } catch {
      $("#import-status").textContent = T("imp_not_json");
      return;
    }
    if (!Array.isArray(rows)) {
      $("#import-status").textContent = T("imp_not_array");
      return;
    }
    let merged = 0, ext = 0;
    const read = {}, ops = {}, all = metas();
    for (const r of rows) {
      if (!r || !r.check || !r.message) continue;
      const m = all.find((x) => x.name === r.session || r.task && x.task === r.task);
      if (m && !read[m.id]) read[m.id] = state.loaded[m.id] ? { session: state.loaded[m.id], rev: state.revs[m.id], meta: m } : await sessionStore.get(m.id);
      const s = m && read[m.id] ? read[m.id].session : null;
      const f = s && s.findings.find((x) => x.check === r.check && x.message.slice(0, 40) === String(r.message).slice(0, 40));
      const v = r.verdict && (r.verdict.v || r.verdict);
      if (s && f && v) {
        const k = fkey(f);
        if (!s.verdicts[k]) {
          s.verdicts[k] = { v, note: r.note || r.verdict && r.verdict.note || "", at: r.at || (/* @__PURE__ */ new Date()).toISOString(), imported: true };
          (ops[s.id] = ops[s.id] || []).push([k, s.verdicts[k]]);
          merged++;
        }
      } else if (!s || !f) {
        state.external.push({
          check: r.check,
          severity: r.severity || "medium",
          message: r.message,
          session: r.session,
          source: r.source || "external",
          verdict: v || null
        });
        ext++;
      }
    }
    for (const id of Object.keys(ops))
      await updateSession(
        id,
        (s) => {
          for (const [k, vd] of ops[id]) if (!s.verdicts[k]) s.verdicts[k] = vd;
        },
        { from: state.loaded[id] ? null : read[id] }
      );
    state.analysisEpoch = (state.analysisEpoch || 0) + 1;
    await save();
    onGenChanged();
    renderCalib();
    $("#import-status").textContent = T("imp_done", { m: merged, e: ext });
  }
  function download(name, text) {
    window.__slSaveFile(name, text);
  }

  // src/webview/rules.js
  var rulesTimer;
  var rulesStatus;
  function initRules() {
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
            T("rules_imported", { n: Object.keys(res.overrides).length }) + (res.ignored.length ? " " + T("rules_ignored", { n: res.ignored.length, why }) : "")
          );
          renderRules();
        });
      ev.target.value = "";
    });
    $("#rules-reset").addEventListener("click", async () => {
      if (!await confirmDialog(T("rules_reset_confirm"))) return;
      state.ruleOverrides = {};
      await saveRules();
      renderRules();
    });
  }
  function renderRules() {
    const book = LensRules.book(state.ruleOverrides);
    const groups = Object.fromEntries(LensChecks.GROUPS_ORDER.map((g) => [g, T("g_" + g)]));
    const calib = calibStats();
    const demotedHint = (r) => {
      const own = state.ruleOverrides[r.check] || {};
      const meta = LensChecks.CHECKS[r.check];
      if (!own.severity || !meta || !meta.sources.includes("regex")) return "";
      const cl = Lens.calibLevel(calib[r.check]);
      return cl.level === "demoted" ? `<span class="r-demoted" title="${esc(T("rules_demoted_hint", { p: Math.round(cl.p * 100) }))}">ⓘ</span>` : "";
    };
    const openMap = state.settings.ruleGroupsOpen || {};
    $("#rules-list").innerHTML = Object.entries(groups).map(([g, label]) => {
      const rows = book.filter((r) => r.group === g);
      const isOpen = openMap[g] === true;
      return `<details class="sec-d" data-group="${esc(g)}" ${isOpen ? "open" : ""}><summary class="h2">${esc(label)}</summary>` + rows.map(
        (r) => `<div class="rule-row ${r.enabled ? "" : "off"}" data-check="${esc(r.check)}">
        <div class="rule-head"><b>${esc(r.check)}</b>
          <select class="r-sev">${LensChecks.SEVERITIES.map((s3) => `<option value="${esc(s3)}" ${r.severity === s3 ? "selected" : ""}>${esc(SEV[s3])}</option>`).join("")}</select>${demotedHint(r)}
          <label class="r-on"><input type="checkbox" class="r-enabled" ${r.enabled ? "checked" : ""}> ${T("rules_on")}</label>
          ${r.edited ? `<span class="tagx">${T("rules_edited")}</span>` : ""}</div>
        <textarea class="r-text" rows="1" placeholder="${T("rules_text_ph")}">${esc(r.rule)}</textarea>
        <textarea class="r-text r-good" rows="1" placeholder="${T("rules_good_ph")}">${esc(r.good)}</textarea></div>`
      ).join("") + `</details>`;
    }).join("");
    $("#rules-list").querySelectorAll(".rule-row").forEach((row) => {
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
    $("#rules-list").querySelectorAll("details.sec-d").forEach((d) => {
      d.addEventListener("toggle", async () => {
        state.settings.ruleGroupsOpen = Object.assign({}, state.settings.ruleGroupsOpen, { [d.dataset.group]: d.open });
        await save();
      });
    });
  }
  function saveRules(status) {
    if (status) rulesStatus = status;
    clearTimeout(rulesTimer);
    rulesTimer = setTimeout(flushRules, 300);
  }
  async function flushRules() {
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
      }, 1200);
    onGenChanged();
  }

  // src/webview/prompts.js
  function initPrompts() {
    $("#prompts-reset").addEventListener("click", async () => {
      state.settings.prompts = {};
      pushPrompts();
      await save();
      renderPrompts();
    });
  }
  function promptDefaults() {
    return Object.assign({}, LensSeg.DEFAULTS, LensAI.DEFAULTS);
  }
  function pushPrompts() {
    const p = state.settings.prompts || {};
    LensAI.setPrompts(p);
    LensSeg.setPrompts(p);
  }
  function renderPrompts() {
    const def = promptDefaults(), own = state.settings.prompts || {};
    const label = {
      segment: T("p_segment"),
      segment_local: T("p_segment") + " — local model",
      review: T("p_review"),
      review_local: T("p_review_local"),
      verify: T("p_verify"),
      compress: T("p_compress"),
      generate_skill: T("p_gen_skill")
    };
    const sub = {
      segment: T("p_segment_sub"),
      segment_local: T("p_segment_sub"),
      review: T("p_review_sub"),
      review_local: T("p_review_local_sub"),
      verify: T("p_verify_sub"),
      compress: T("p_compress_sub", { f: rulesTargetLabel() }),
      generate_skill: T("p_gen_skill_sub")
    };
    const openMap = state.settings.promptsOpen || {};
    $("#prompts-list").innerHTML = Object.keys(def).map(
      (k) => `<details class="sec-d" data-key="${esc(k)}" ${openMap[k] === true ? "open" : ""}>
      <summary class="h2">${esc(label[k] || k)}</summary>
      <p class="muted">${esc(sub[k] || "")}</p>
      <textarea class="p-box" data-key="${esc(k)}" rows="8">${esc(own[k] !== void 0 ? own[k] : def[k])}</textarea>
    </details>`
    ).join("");
    $("#prompts-list").querySelectorAll(".p-box").forEach(
      (t) => t.addEventListener("change", async () => {
        const k = t.dataset.key, def2 = promptDefaults();
        state.settings.prompts = state.settings.prompts || {};
        if (t.value.trim() === String(def2[k]).trim()) delete state.settings.prompts[k];
        else state.settings.prompts[k] = t.value;
        pushPrompts();
        await save();
        $("#prompts-status").textContent = T("prompts_saved");
        setTimeout(() => {
          $("#prompts-status").textContent = "";
        }, 1500);
      })
    );
    $("#prompts-list").querySelectorAll("details.sec-d").forEach((d) => {
      d.addEventListener("toggle", async () => {
        state.settings.promptsOpen = Object.assign({}, state.settings.promptsOpen, { [d.dataset.key]: d.open });
        await save();
      });
    });
  }

  // src/webview/settings.js
  var ROUTE_TASKS;
  var SETTINGS_DEFAULTS;
  function initSettings() {
    $("#s-add-provider").addEventListener("change", (e) => renderAddForm(e.target.value));
    $("#s-add-key-del").addEventListener("click", async () => {
      const prov = $("#s-add-provider").value, p = LensAI.PROVIDERS[prov], st2 = $("#s-add-status");
      if (!await confirmDialog(T("key_delete_confirm", { p: p.label }))) return;
      const r = await window.__slSecretDelete(prov);
      if (!r || r.error) {
        st2.className = "err";
        st2.textContent = T("key_save_failed", { msg: r && r.error || "?" });
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
      const prov = $("#s-add-provider").value, p = LensAI.PROVIDERS[prov], suf = p.cliKind === "codex" ? "_codex" : "";
      const check = p.cliKind === "codex" ? window.__slCodexCheck : window.__slClaudeCheck;
      const st = $("#s-add-cli-status");
      st.className = "muted";
      st.textContent = T("cli_checking");
      const r = await check({});
      if (!r || !r.installed) {
        st.className = "err";
        st.textContent = T("cli_err_notfound" + suf, { cmd: r && r.cmd || (p.cliKind === "codex" ? "codex" : "claude") });
        return;
      }
      if (!r.loggedIn) {
        st.className = "err";
        st.textContent = T("cli_check_nologin" + suf, { v: r.version });
        return;
      }
      const who = [r.account, r.plan].filter(Boolean).join(", ");
      st.className = r.apiKeyEnv ? "err" : "muted";
      st.textContent = T("cli_check_ok" + suf, { v: r.version, who: who ? " (" + who + ")" : "" }) + (r.cmd ? " · " + r.cmd : "") + (r.apiKeyEnv ? " " + T("cli_check_apikey" + suf) : "");
    });
    $("#s-add-model-btn").addEventListener("click", async () => {
      const prov = $("#s-add-provider").value, p = LensAI.PROVIDERS[prov];
      const key = $("#s-add-key").value.trim(), model = $("#s-add-model").value.trim() || p.defaultModel;
      const label = $("#s-add-label").value.trim();
      const needsKey = !p.local && !p.noKey, hasKey = key || LensAI.hasKey(state.settings, prov);
      const st2 = $("#s-add-status");
      if (needsKey && !hasKey) {
        st2.className = "err";
        st2.textContent = T("s_models_key_missing_err", { p: p.label });
        return;
      }
      state.settings.baseUrls = state.settings.baseUrls || {};
      if (key && needsKey) {
        const r = await window.__slSecretSet(prov, key);
        if (!r || r.error) {
          st2.className = "err";
          st2.textContent = T("key_save_failed", { msg: r && r.error || "?" });
          return;
        }
        LensAI.setKeyStatus(r);
      }
      if (p.local || p.editableBase) {
        const r = await window.__slBaseUrlSet(prov, $("#s-add-baseurl").value.trim());
        if (!r || r.error) {
          st2.className = "err";
          st2.textContent = T("s_baseurl_failed", { msg: r && r.error || "?" });
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
    ROUTE_TASKS = [
      ["segment", "p_segment", "p_segment_sub"],
      ["review", "p_review", "p_review_sub"],
      ["verify", "p_verify", "p_verify_sub"],
      ["compress", "p_compress", "p_compress_sub"],
      ["skill", "p_gen_skill", "p_gen_skill_sub"]
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
      renderList();
    });
    $("#s-debug-model").addEventListener("change", async () => {
      state.settings.debugModel = $("#s-debug-model").checked;
      await save();
      if (state.current && curS()) renderRaw(curS());
      renderCalLog();
    });
    $("#s-save").addEventListener("click", async () => {
      state.settings.routes = collectRoutes();
      state.settings.maxCode = +$("#s-maxcode").value || 4e4;
      state.settings.minGapMs = Math.max(0, +$("#s-gap").value || 0);
      state.settings.verify = $("#s-verify").checked;
      const lintChanged = state.settings.lint !== $("#s-lint").checked;
      state.settings.lint = $("#s-lint").checked;
      await save();
      if (lintChanged) onGenChanged();
      renderSettings();
      $("#s-status").textContent = T("saved");
      setTimeout(() => $("#s-status").textContent = "", 1500);
    });
    SETTINGS_DEFAULTS = {
      provider: "",
      apiKey: "",
      model: "",
      baseUrl: "",
      minGapMs: 6500,
      maxCode: 4e4,
      verify: true,
      lint: true,
      debugModel: false,
      hideDemo: false
    };
    $("#s-reset-settings").addEventListener("click", async () => {
      if (!await confirmDialog(T("s_reset_settings_confirm"))) return;
      const st = state.settings, lintChanged = st.lint !== SETTINGS_DEFAULTS.lint;
      Object.assign(st, SETTINGS_DEFAULTS, { keys: {}, models: {}, baseUrls: {}, cliPaths: {}, routes: {}, modelPool: [], defaultModelId: null });
      delete st.cliPath;
      delete st.theme;
      {
        delete st.apiKey;
        delete st.keys;
        const ks = LensAI.getKeyStatus() || {};
        for (const prov of Object.keys(ks))
          if (ks[prov]) {
            const r = await window.__slSecretDelete(prov);
            if (r && !r.error) LensAI.setKeyStatus(r);
          }
        for (const prov of Object.keys(LensAI.PROVIDERS))
          if (LensAI.PROVIDERS[prov].local || LensAI.PROVIDERS[prov].editableBase) await window.__slBaseUrlSet(prov, "");
      }
      applyTheme(hostTheme());
      await save();
      renderSettings();
      if (state.current) renderReview();
      renderList();
      if (lintChanged) onGenChanged();
      $("#s-reset-settings-status").textContent = T("s_reset_settings_done");
      setTimeout(() => $("#s-reset-settings-status").textContent = "", 2500);
    });
    $("#s-reset-all").addEventListener("click", async () => {
      if (!await confirmDialog(T("s_reset_all_confirm"))) return;
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
      setTimeout(() => $("#s-reset-status").textContent = "", 2e3);
      renderList();
    });
  }
  function migrateModelPool() {
    const st = state.settings;
    if (Array.isArray(st.modelPool)) return;
    st.modelPool = [];
    st.defaultModelId = null;
    const seen = /* @__PURE__ */ new Set();
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
  function modelLabel(m) {
    const p = LensAI.PROVIDERS[m.provider] || {};
    return m.label && m.label.trim() || `${p.label || m.provider} — ${m.model}`;
  }
  function findPoolEntry(prov, model) {
    return (state.settings.modelPool || []).find((m) => m.provider === prov && m.model === model);
  }
  function setDefaultModel(id) {
    const st = state.settings, m = (st.modelPool || []).find((x) => x.id === id);
    if (!m) return;
    const p = LensAI.PROVIDERS[m.provider] || {};
    st.defaultModelId = id;
    st.provider = m.provider;
    st.model = m.model;
    st.baseUrl = (st.baseUrls || {})[m.provider] || p.defaultBaseUrl || "";
  }
  function removeModel(id) {
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
  function defaultModelLabel() {
    const m = (state.settings.modelPool || []).find((x) => x.id === state.settings.defaultModelId);
    return m ? modelLabel(m) : T("s_models_none");
  }
  function renderModelPool() {
    const pool = state.settings.modelPool || [], el = $("#s-model-list");
    if (!pool.length) {
      el.innerHTML = `<div class="muted">${esc(T("s_models_empty"))}</div>`;
      return;
    }
    el.innerHTML = pool.map(
      (m) => `<div class="row" data-id="${esc(m.id)}" style="justify-content:space-between;align-items:center;border:1px solid var(--rail);border-radius:6px;padding:6px 8px;margin-top:6px">
      <div><b>${esc(modelLabel(m))}</b>${m.id === state.settings.defaultModelId ? ` <span class="muted">· ${esc(T("s_models_default"))}</span>` : ""}</div>
      <div class="row" style="gap:6px;margin:0">
        ${m.id === state.settings.defaultModelId ? "" : `<button class="btn tiny ghost m-default" data-id="${esc(m.id)}">${esc(T("s_models_set_default"))}</button>`}
        <button class="btn tiny danger m-remove" data-id="${esc(m.id)}">${esc(T("s_models_remove"))}</button>
      </div></div>`
    ).join("");
    el.querySelectorAll(".m-default").forEach(
      (b) => b.addEventListener("click", async () => {
        setDefaultModel(b.dataset.id);
        await save();
        renderModelPool();
        renderRoutes();
      })
    );
    el.querySelectorAll(".m-remove").forEach(
      (b) => b.addEventListener("click", async () => {
        if (!await confirmDialog(T("s_models_remove_confirm"))) return;
        removeModel(b.dataset.id);
        await save();
        renderModelPool();
        renderRoutes();
      })
    );
  }
  function renderAddForm(prov) {
    const p = LensAI.PROVIDERS[prov];
    const saved = LensAI.hasKey(state.settings, prov), needsKeyHere = !p.local && !p.noKey;
    $("#s-add-key-label").textContent = T("key_label", { p: p.label }) + (needsKeyHere ? " · " + T(saved ? "key_saved" : "key_not_set") : "");
    $("#s-add-key").placeholder = saved ? T("key_keep_ph") : p.keyHint;
    $("#s-add-key").value = "";
    $("#s-add-key-del").style.display = saved && needsKeyHere ? "inline-block" : "none";
    $("#s-add-model").value = "";
    $("#s-add-model").placeholder = p.defaultModel;
    $("#s-add-model-hint").textContent = T("model_default", { m: p.defaultModel }) + (prov === "local" ? T("local_model_hint") : "");
    $("#s-add-label").value = "";
    const baseRow = $("#s-add-base-row"), keyRow = $("#s-add-key").closest("label");
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
      $("#s-add-cli-settings").textContent = T("s_cli_open_settings");
      $("#s-add-cli-hint").textContent = T("s_cli_hint" + suf);
      $("#s-add-cli-check").textContent = T("cli_check_btn" + suf);
      $("#s-add-cli-status").textContent = "";
    }
  }
  function renderRoutes() {
    const st = state.settings, routes = st.routes || {}, pool = st.modelPool || [];
    const opt = (v, label, sel) => `<option value="${esc(v)}" ${sel ? "selected" : ""}>${esc(label)}</option>`;
    $("#s-routes").innerHTML = ROUTE_TASKS.map(([task, lk, sk]) => {
      const r = routes[task] || {}, match = r.provider ? findPoolEntry(r.provider, r.model) : null;
      return `<div class="route-row" data-task="${esc(task)}" style="margin-top:8px">
        <b>${esc(T(lk))}</b> <span class="muted">${esc(T(sk))}</span>
        <select class="route-model" style="width:100%">
          ${opt("", T("route_default", { m: defaultModelLabel() }), !match)}
          ${pool.map((m) => opt(m.id, modelLabel(m), !!match && match.id === m.id)).join("")}
        </select></div>`;
    }).join("");
  }
  function collectRoutes() {
    const out = {};
    $("#s-routes").querySelectorAll(".route-row").forEach((row) => {
      const v = row.querySelector(".route-model").value, task = row.dataset.task;
      if (!v) return;
      const m = (state.settings.modelPool || []).find((x) => x.id === v);
      if (m) out[task] = { provider: m.provider, model: m.model };
    });
    return out;
  }
  function renderSettings() {
    renderAddForm($("#s-add-provider").value || "anthropic");
    renderModelPool();
    renderRoutes();
    $("#s-maxcode").value = state.settings.maxCode || 4e4;
    $("#s-gap").value = Number.isFinite(state.settings.minGapMs) ? state.settings.minGapMs : 6500;
    $("#s-verify").checked = state.settings.verify !== false;
    $("#s-lint").checked = state.settings.lint !== false;
    $("#s-hide-demo").checked = state.settings.hideDemo === true;
    $("#s-debug-model").checked = state.settings.debugModel === true;
    $("#s-addmodel-d").open = state.settings.addModelOpen === true;
    $("#s-routes-d").open = state.settings.routesOpen === true;
  }

  // src/webview/sessions.js
  var pendingImport;
  var drop;
  var piDeps;
  function initSessions() {
    pendingImport = null;
    document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => show(
      /** @type {HTMLElement} */
      b.dataset.view
    )));
    drop = $("#drop");
    ["dragenter", "dragover"].forEach(
      (e) => drop.addEventListener(e, (ev) => {
        ev.preventDefault();
        drop.classList.add("over");
      })
    );
    ["dragleave", "drop"].forEach(
      (e) => drop.addEventListener(e, (ev) => {
        ev.preventDefault();
        drop.classList.remove("over");
      })
    );
    drop.addEventListener("drop", (ev) => {
      const f = ev.dataTransfer.files[0];
      if (f) readFile(f, askName);
    });
    $("#file").closest("label").addEventListener("click", async (e) => {
      e.preventDefault();
      await pickAndImport();
    });
    $("#name-go").addEventListener("click", confirmName);
    $("#name-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") confirmName();
      if (e.key === "Escape") {
        pendingImport = null;
        $("#name-row").hidden = true;
      }
    });
    $("#paste-toggle").addEventListener("click", () => {
      const h = $("#paste").hidden;
      $("#paste").hidden = !h;
      $("#paste-row").hidden = !h;
    });
    $("#paste-go").addEventListener("click", () => {
      const t = $("#paste").value;
      if (t.trim()) {
        importText(t, $("#paste-name").value || "pasted session");
        $("#paste").value = "";
        $("#paste-name").value = "";
        $("#paste").hidden = true;
        $("#paste-row").hidden = true;
      }
    });
    $("#demo-go").title = T("demo_try_title");
    $("#demo-go").addEventListener("click", () => openDemo());
    $("#profile").addEventListener("change", async (e) => {
      state.settings.profile = e.target.value;
      renderProfileInfo();
      await save();
    });
    piDeps = (p) => ({
      checks: LensChecks,
      lint: LensLint,
      spec: LensSpec,
      overrides: state.ruleOverrides,
      settings: state.settings,
      verdicts: profileVerdicts(p)
    });
  }
  function show(v) {
    if (window.SL_OPEN_SESSION) v = "review";
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle(
      "active",
      /** @type {HTMLElement} */
      b.dataset.view === v
    ));
    document.querySelectorAll(".view").forEach((x) => x.classList.toggle("active", x.id === "view-" + v));
    if (v !== "sessions") {
      pendingImport = null;
      $("#name-row").hidden = true;
      $("#name-hint").textContent = "";
    }
    if (v === "rules") renderRules();
    if (v === "prompts") renderPrompts();
    if (v === "sessions") renderList();
    if (v === "review") renderReview();
    if (v === "calib") renderCalib();
    if (v === "settings") renderSettings();
    if (!window.SL_OPEN_SESSION) window.__slSetActiveTab(v);
  }
  async function pickAndImport() {
    const source = await chooseDialog(T("pick_source_msg"), [
      { label: T("pick_source_claude"), value: "claude", primary: true },
      { label: T("pick_source_codex"), value: "codex" },
      { label: T("pick_source_other"), value: "other" }
    ]);
    if (source === null) return;
    const r = await window.__slPickTranscript({ source: source === "other" ? void 0 : source });
    if (r && typeof r.text === "string") askName(r.text, r.name.replace(/\.(jsonl|txt|md|log|json)$/i, ""));
  }
  function askName(text, fallback) {
    const guess = Lens.guessTask(text.slice(0, 2e5));
    const uuidish = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(fallback) || /^[0-9a-f]{12,}$/i.test(fallback);
    pendingImport = { text, fallback };
    $("#name-input").value = guess || (uuidish ? "" : fallback);
    $("#name-hint").textContent = T("name_from_file", { f: fallback.slice(0, 40) });
    $("#name-row").hidden = false;
    $("#name-input").focus();
    $("#name-input").select();
  }
  function confirmName() {
    if (!pendingImport) return;
    const { text, fallback } = pendingImport;
    pendingImport = null;
    $("#name-row").hidden = true;
    importText(text, $("#name-input").value.trim() || fallback);
  }
  function readFile(f, cb) {
    const r = new FileReader();
    r.onload = () => cb(r.result, f.name.replace(/\.(jsonl|txt|md|log|json)$/i, ""));
    r.readAsText(f);
  }
  async function importText(text, name) {
    const cfg = Lens.profile(state.settings.profile);
    const res = Lens.importAny(text, cfg);
    const convs = Array.isArray(res) && res.length && res[0].events ? res : [{ name, events: res }];
    if (!convs.length || !convs[0].events.length) {
      await alertDialog(T("no_events"));
      return;
    }
    if (convs.length > 1) {
      const q = await promptDialog(T("many_convs", { n: convs.length })) || "";
      const sel = convs.filter((c) => c.name.toLowerCase().includes(q.toLowerCase()));
      if (sel.length) convs.splice(0, convs.length, ...sel);
    }
    let last = null;
    await needEngine(cfg.profile);
    for (const c of convs) {
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const s = {
        id,
        name: c.name,
        task: "",
        profile: cfg.profile,
        created: (/* @__PURE__ */ new Date()).toISOString(),
        events: c.events,
        findings: [],
        verdicts: {},
        spec: "",
        dropped: [],
        source_text: text.length < 4e5 ? text : "",
        seg: null
      };
      analyze(s, "import");
      await putNew(s);
      last = id;
    }
    state.current = last;
    if (convs.length > 1) {
      show("sessions");
    } else {
      window.__slOpenSession(last);
      show("sessions");
    }
  }
  async function openDemo() {
    const D = LensDemo;
    if (!state.index[D.ID]) {
      const cfg = Lens.profile(D.PROFILE);
      await needEngine(cfg.profile);
      const s = {
        id: D.ID,
        name: D.NAME,
        nameSet: true,
        task: "",
        profile: cfg.profile,
        created: (/* @__PURE__ */ new Date()).toISOString(),
        events: Lens.importAny(D.TRANSCRIPT, cfg),
        findings: [],
        verdicts: {},
        spec: D.SPEC,
        dropped: [],
        source_text: D.TRANSCRIPT,
        seg: null
      };
      analyze(s, "import");
      await putNew(s);
    }
    state.current = D.ID;
    window.__slOpenSession(D.ID);
    show("sessions");
  }
  function profileSummary(info) {
    const runners = info.runners.map((r) => r.trim());
    const spec = info.spec && info.spec.read.length ? T("pi_s_spec") : T("pi_s_nospec");
    return [
      T("profile_desc_" + info.profile),
      runners.slice(0, 4).join(", ") + (runners.length > 4 ? ", …" : ""),
      T("pi_s_checks", { n: info.count }),
      info.engine.kind === "none" ? T("pi_s_noengine") : T("pi_eng_" + info.engine.kind) + (info.engine.state === "off" ? " (" + T("pi_off") + ")" : ""),
      spec,
      info.calibration.validated ? T("pi_validated") : T("pi_unvalidated_short")
    ].filter(Boolean).join(" · ");
  }
  function renderProfileInfo() {
    const el = $("#profile-info");
    if (!el) return;
    const p = $("#profile").value || state.settings.profile || Lens.PROFILES[0];
    const info = Lens.profileInfo(p, piDeps(p));
    const wasOpen = !!(el.querySelector("details") || {}).open;
    const li = (label, value) => `<li><span class="pi-k">${esc(label)}</span> ${value}</li>`;
    const code = (x) => `<code>${esc(x)}</code>`;
    const files = info.codeExt.length ? info.codeExt.map(code).join(" ") : esc(T("pi_any_file"));
    const eng = info.engine.kind === "none" ? esc(T("pi_eng_none")) : esc(T("pi_eng_" + info.engine.kind)) + " — " + esc(info.engine.state === "off" ? T("pi_off") : T("pi_on"));
    const sp = info.spec, spec = !sp ? "" : !sp.read.length ? esc(T("pi_spec_none")) : !sp.notRead.length && !sp.anyFile ? esc(T("pi_spec_all")) : sp.read.map(code).join(" ") + (sp.notRead.length && !sp.anyFile ? " · " + esc(T("pi_spec_not", { list: sp.notRead.join(" ") })) : "");
    const cal = info.calibration.validated ? esc(T(info.calibration.builtIn ? "pi_validated_builtin" : "pi_validated")) : esc(T("pi_unvalidated", { n: info.calibration.verdicts, min: info.calibration.min }));
    const groups = info.groups.map(
      (g) => `<div class="pi-g"><b>${esc(T("g_" + g.group))}</b> <span class="muted">(${esc(g.checks.length)})</span><div>${g.checks.map(
        (c) => `<code class="pi-c${c.off ? " off" : ""}" title="${esc(LensRules.ruleText(c.name, state.ruleOverrides))}">${esc(c.name)}</code>${c.off ? ` <span class="muted">${esc(T("pi_off_rules"))}</span>` : ""}${c.engineOnly ? ` <span class="muted">${esc(T("pi_engine_only"))}</span>` : ""}`
      ).join(" ")}</div></div>`
    ).join("");
    el.innerHTML = `<div class="pi-sum">${esc(profileSummary(info))}</div><details${wasOpen ? " open" : ""}><summary>${esc(T("pi_details"))}</summary><ul class="pi-l">${[
      li(T("pi_files"), files),
      li(T("pi_runners"), info.runners.map((r) => code(r.trim())).join(" ")),
      li(T("pi_engine"), eng),
      li(T("pi_spec"), spec),
      li(T("pi_asserts"), esc(T(info.asserts ? "pi_yes" : "pi_no"))),
      li(T("pi_calib"), cal)
    ].join("")}</ul><div class="muted">${esc(T("pi_gherkin"))}</div>${groups}</details>`;
  }
  function renderList() {
    const sel = $("#profile");
    sel.innerHTML = Lens.PROFILES.map(
      (p) => `<option value="${esc(p)}" ${p === state.settings.profile ? "selected" : ""}>${esc(p)} — ${esc(T("profile_desc_" + p))}${!Lens.isValidated(p, profileVerdicts(p)) ? T("unverified_opt") : ""}</option>`
    ).join("");
    renderProfileInfo();
    $("#demo-go").hidden = state.settings.hideDemo === true;
    $("#session-list").innerHTML = "";
  }

  // src/webview/review.js
  function initReview() {
    $("#raw-copy").addEventListener("click", async () => {
      await navigator.clipboard.writeText($("#raw").value);
      $("#raw-copy").textContent = T("copied");
      setTimeout(() => $("#raw-copy").textContent = T("copy"), 1200);
    });
    $("#raw-dl").addEventListener("click", () => {
      const s = curS();
      download(`${(s.task || s.name).replace(/\W+/g, "-")}-model-dump.txt`, s.ai_raw || "");
    });
    $("#spec-file").addEventListener("change", (ev) => {
      const f = ev.target.files[0];
      if (f)
        readFile(f, (t) => {
          $("#spec").value = t;
        });
      ev.target.value = "";
    });
    $("#spec-save").addEventListener("click", async () => {
      const spec = $("#spec").value;
      await needEngine(curS().profile);
      await updateSession(state.current, (s) => {
        s.spec = spec;
        analyze(s);
      });
      renderReview();
    });
    $("#seg-run").addEventListener("click", async () => {
      const sid = state.current, s = curS(), btn = $("#seg-run"), st = $("#seg-status");
      s.seg_error = null;
      s.seg_raw = null;
      {
        const miss = LensAI.missingKey(state.settings, "segment");
        if (miss) {
          st.textContent = T("err_no_key_for", { p: miss });
          st.className = "err";
          return;
        }
      }
      btn.disabled = true;
      st.textContent = T("seg_wait");
      const before = JSON.parse(JSON.stringify(s.events));
      try {
        const r = await LensSeg.segment(s, state.settings, LensAI.callModel, LensAI.parseArray);
        const seg = {
          at: (/* @__PURE__ */ new Date()).toISOString(),
          n: r.segments.length,
          coverage: r.coverage,
          chunks: r.chunks || null,
          spec_suggested: r.spec_suggested,
          raw: r.request + "\n\n" + T("resp") + "\n" + r.raw
        };
        const events = s.events;
        await needEngine(s.profile);
        await updateSession(sid, (x) => {
          x.events = events;
          x.seg = seg;
          x.seg_error = null;
          x.seg_raw = null;
          analyze(x);
        });
        renderReview();
        st.textContent = segStatus(curS());
      } catch (e) {
        const err = e.message, raw = e.raw || null;
        await updateSession(sid, (x) => {
          x.events = before;
          x.seg = null;
          x.seg_error = err;
          x.seg_raw = raw;
        });
        st.textContent = T("seg_fallback", { msg: e.message });
        renderReview();
        st.textContent = T("seg_fallback", { msg: e.message });
      }
      btn.disabled = false;
    });
    $("#seg-spec").addEventListener("click", async () => {
      const s = curS();
      if (!(s.seg && s.seg.spec_suggested)) return;
      await needEngine(s.profile);
      await updateSession(state.current, (x) => {
        if (x.seg && x.seg.spec_suggested) {
          x.spec = x.seg.spec_suggested;
          analyze(x);
        }
      });
      renderReview();
      $("#spec-d").open = true;
    });
    $("#seg-reset").addEventListener("click", async () => {
      const s = curS();
      if (!s.source_text) return;
      await needEngine(s.profile);
      await updateSession(state.current, (x) => {
        const cfg = Lens.profile(x.profile);
        const res = Lens.importAny(x.source_text, cfg);
        x.events = Array.isArray(res) && res.length && res[0].events ? res[0].events : res;
        x.seg = null;
        analyze(x);
      });
      renderReview();
      $("#seg-status").textContent = T("seg_none");
    });
    $("#ai-run").addEventListener("click", async () => {
      const sid = state.current;
      const s = curS();
      const spec = $("#spec").value;
      s.spec = spec;
      const btn = $("#ai-run"), st = $("#ai-status");
      btn.disabled = true;
      st.textContent = state.settings.verify ? T("ai_wait_verify") : T("ai_wait");
      try {
        const r = await LensAI.review(s, state.settings);
        await needEngine(s.profile);
        await updateSession(sid, (cur) => {
          cur.spec = spec;
          cur.findings = cur.findings.filter((f) => f.source !== "ai");
          analyze(cur);
          cur.findings = Lens.sortFindings([...cur.findings, ...r.findings]);
          cur.dropped = r.dropped || [];
          cur.ai_at = (/* @__PURE__ */ new Date()).toISOString();
          cur.ai_truncated = r.truncated;
          cur.ai_raw = r.raw;
          cur.ai_verify_error = r.verifyError || null;
        });
        if (state.current === sid) {
          renderReview();
          st.textContent = T("ai_status", {
            n: r.findings.length,
            dropped: r.dropped && r.dropped.length ? T("ai_dropped", { n: r.dropped.length }) : "",
            repaired: r.repaired ? T("ai_repaired") : "",
            err: r.verifyError ? " · " + r.verifyError : ""
          });
        }
      } catch (e) {
        if (state.current === sid) st.textContent = T("error") + e.message;
        if (e.raw) {
          const err = e.message;
          await updateSession(sid, (cur) => {
            cur.ai_raw = e.raw;
            cur.ai_error = err;
          });
          if (state.current === sid && curS()) renderRaw(curS());
        }
      }
      if (state.current === sid) btn.disabled = false;
    });
    $("#ai-verify-again").addEventListener("click", async () => {
      const sid = state.current;
      const btn = $("#ai-verify-again"), st = $("#ai-status");
      const aiFindings = state.loaded[sid].findings.filter((f) => f.source === "ai");
      btn.disabled = true;
      st.textContent = T("ai_reverify_wait");
      try {
        const v = await LensAI.verify(state.loaded[sid], aiFindings, state.settings);
        await updateSession(sid, (cur) => {
          cur.findings = Lens.sortFindings([...cur.findings.filter((f) => f.source !== "ai"), ...v.kept]);
          cur.dropped = v.dropped || [];
          cur.ai_verify_error = v.error || null;
        });
        if (state.current === sid) {
          renderReview();
          st.textContent = T("ai_reverify_status", { n: v.kept.length, dropped: v.dropped && v.dropped.length ? T("ai_dropped", { n: v.dropped.length }) : "" }) + (v.error ? " · " + v.error : "");
        }
      } catch (e) {
        if (state.current === sid) st.textContent = T("error") + e.message;
      }
      if (state.current === sid) btn.disabled = false;
    });
  }
  function renderReview() {
    const s = curS();
    $("#review-empty").hidden = !!s;
    $("#review").hidden = !s;
    if (!s) return;
    const v = Lens.verdict(s.findings), m = s.metrics || Lens.metrics(s.events);
    const runs = s.events.filter((e) => e.kind === "run_tests" && e.tests), last = runs[runs.length - 1];
    $("#hdr").style.setProperty("--v", VCOL[v]);
    const unv = !Lens.isValidated(s.profile, profileVerdicts(s.profile));
    $("#hdr").innerHTML = `<h1>${esc(Lens.displayName(s))}<span class="badge">${esc(VLABEL[v])}</span></h1><div class="m">${esc(Lens.otherName(s))} · <span class="pi-hdr" title="${esc(profileSummary(Lens.profileInfo(s.profile, piDeps(s.profile))))}">${esc(s.profile)}</span> · ${esc(s.events.length)} ${T("events")} · ${T("hdr_result")}: ${last ? esc(T("passed_failed", { p: last.tests.passed, f: last.tests.failed })) : T("no_runs")}</div>${unv ? `<span class="warn">${esc(T("unverified", { p: s.profile, n: Lens.UNVERIFIED_MIN }))}</span>` : ""}`;
    $("#metrics").innerHTML = [
      `${T("m_reads")} <b>${esc(m.reads)}</b>`,
      `${T("m_edits")} <b>${esc(m.edits)}</b>`,
      `Read:Edit <b>${esc(m.readEdit ?? "—")}</b>${m.readEdit !== null && m.readEdit < 1 ? " ⚠" : ""}`,
      `${T("m_runs")} <b>${esc(m.runs)}</b>`,
      `${T("m_to_green")} <b>${esc(m.editsToGreen ?? "—")}</b>`
    ].map((x) => `<span>${x}</span>`).join("");
    const toolCode = s.events.some((e) => e.file && e.new_content);
    $("#seg-hint").textContent = !s.seg && !toolCode && s.events.some((e) => e.kind === "message") ? T("seg_hint_chat") : "";
    $("#seg-status").textContent = s.seg ? segStatus(s) : s.seg_error ? T("seg_fallback", { msg: s.seg_error }) : T("seg_none");
    $("#seg-status").className = s.seg_error ? "err" : "muted";
    $("#seg-extra").hidden = !s.seg;
    $("#seg-spec").hidden = !(s.seg && s.seg.spec_suggested);
    $("#seg-reset").hidden = !s.source_text;
    $("#spec").value = s.spec || "";
    $("#spec-count").textContent = s.specParsed && s.specParsed.n ? T("spec_count", { n: s.specParsed.n, oos: s.specParsed.oos ? T("spec_oos", { n: s.specParsed.oos }) : "" }) + (s.specParsed.hasIds ? "" : T("spec_auto")) : (s.spec || "").trim() ? T("spec_unparsed") : T("spec_none");
    $("#spec-d").open = !s.spec;
    renderCoverage(s);
    $("#ai-status").textContent = s.ai_at ? T("ai_last", { at: s.ai_at.slice(0, 16).replace("T", " ") }) + (s.ai_truncated ? T("ai_truncated") : "") + (s.ai_verify_error ? " · " + s.ai_verify_error : "") : "";
    $("#ai-verify-again").hidden = !s.ai_verify_error;
    $("#lint-note").textContent = s.lintNote || "";
    $("#mark-reviewed").textContent = s.reviewed ? T("reviewed_on") : T("mark_reviewed");
    $("#mark-reviewed").classList.toggle("on", !!s.reviewed);
    $("#suppressed").textContent = s.suppressed && s.suppressed.length ? T("suppressed", { list: s.suppressed.map((x) => `${x.check} (${Math.round(x.precision * 100)}% / ${x.n})`).join(", ") }) : "";
    const F = state.filter;
    const srcOf = (f) => f.source === "ai" ? "ai" : f.source === "spec" ? "spec" : f.source === "lint" ? "lint" : "formal";
    const visible = s.findings.filter((f) => F.src[srcOf(f)] !== false && F.sev[f.severity] && (!F.undecided || !s.verdicts[fkey(f)]));
    $("#f-count").textContent = visible.length === s.findings.length ? `(${s.findings.length})` : T("f_of", { v: visible.length, n: s.findings.length });
    const cnt = { all: s.findings.length };
    for (const k of ["formal", "lint", "spec", "ai"]) cnt[k] = s.findings.filter((f) => srcOf(f) === k).length;
    const present = ["formal", "lint", "spec", "ai"].filter((k) => cnt[k]);
    const allOn = present.every((k) => F.src[k] !== false);
    $("#filter").innerHTML = `<button class="chip ${allOn ? "on" : ""}" data-src="all">${T("chip_all")} ${esc(cnt.all)}</button>` + present.map(
      (k) => `<button class="chip ${F.src[k] !== false ? "on" : ""}" data-src="${esc(k)}">${esc({ formal: T("chip_formal"), lint: T("chip_lint"), spec: T("chip_spec"), ai: T("chip_ai") }[k] || k)} ${esc(cnt[k])}</button>`
    ).join("") + `<span class="sep"></span>` + LensChecks.SEVERITIES.map((sv) => `<button class="chip sev-${esc(sv)} ${F.sev[sv] ? "on" : ""}" data-sev="${esc(sv)}">${esc(SEV[sv])}</button>`).join("") + `<button class="chip ${F.undecided ? "on" : ""}" data-und="1">${T("chip_undecided")}</button>`;
    $("#filter").querySelectorAll("[data-src]").forEach(
      (b) => b.addEventListener("click", () => {
        const k = b.dataset.src;
        if (k === "all")
          present.forEach((x) => F.src[x] = true);
        else {
          const toggled = F.src[k] === false;
          const anyLeft = present.some((x) => x === k ? toggled : F.src[x] !== false);
          if (anyLeft) F.src[k] = toggled;
          else present.forEach((x) => F.src[x] = true);
        }
        renderReview();
      })
    );
    $("#filter").querySelectorAll("[data-sev]").forEach(
      (b) => b.addEventListener("click", () => {
        F.sev[b.dataset.sev] = !F.sev[b.dataset.sev];
        renderReview();
      })
    );
    $("#filter").querySelector("[data-und]").addEventListener("click", () => {
      F.undecided = !F.undecided;
      renderReview();
    });
    const fl = $("#findings");
    fl.innerHTML = visible.length ? visible.map((f) => {
      const k = fkey(f), vd = s.verdicts[k] || {};
      const ai = f.source === "ai", sp = f.source === "spec", lt = f.source === "lint";
      return `<div class="f ${esc(f.severity)} ${vd.v ? "done" : ""} ${ai ? "ai" : ""} ${sp ? "spec" : ""}" data-k="${esc(k)}"><div class="sev ${esc(f.severity)}">${esc(SEV[f.severity] || f.severity)}${ai ? ` <span class="aitag">${T("tag_model")}</span>` : ""}${sp ? ` <span class="aitag" style="background:var(--teal)">${T("tag_spec")}</span>` : ""}${lt ? ` <span class="aitag" style="background:var(--green)">eslint</span>` : ""}${f.demoted ? ` <span class="demoted">${T("demoted")}</span>` : ""}</div><div class="msg">${esc(f.message)}</div>${f.evidence ? `<div class="chk">«${esc(f.evidence)}»</div>` : ""}${f.code ? `<details class="snip-d"><summary>${T("code_toggle")}</summary><pre class="snip">${esc(f.code)}</pre></details>` : ""}<div class="chk">${ai ? esc(LABEL[f.check] || f.check) : esc(f.check)}${f.seq >= 0 ? ` · <a href="#e${esc(f.seq)}">seq ${esc(f.seq)}</a>` : ""}</div>
        <div class="vb"><button class="btn tiny ghost v-ok ${vd.v === "ok" ? "on" : ""}">${T("btn_ok")}</button><button class="btn tiny ghost v-fp ${vd.v === "fp" ? "on fp" : ""}">${T("btn_fp")}</button><input class="note" placeholder="${T("ph_note")}" value="${esc(vd.note || "")}"></div></div>`;
    }).join("") : `<div class="empty">${s.findings.length ? T("empty_filter") : T("empty_findings")}</div>`;
    fl.querySelectorAll(".f").forEach((d) => {
      const k = d.dataset.k;
      d.querySelector(".v-ok").addEventListener("click", () => setVerdict(k, "ok", d.querySelector(".note").value));
      d.querySelector(".v-fp").addEventListener("click", () => setVerdict(k, "fp", d.querySelector(".note").value));
      d.querySelector(".note").addEventListener("change", (e) => {
        if (s.verdicts[k]) setVerdict(k, s.verdicts[k].v, e.target.value);
      });
    });
    fl.querySelectorAll("a[href^='#e']").forEach(
      (a) => a.addEventListener("click", (e) => {
        e.preventDefault();
        const t = document.getElementById(a.getAttribute("href").slice(1));
        if (t) {
          t.closest("details").open = true;
          t.scrollIntoView({ block: "center" });
          t.classList.add("flag");
        }
      })
    );
    renderRaw(s);
    const dr = s.dropped || [];
    const dups = dr.filter((f) => f.duplicate).length;
    $("#dropped-d").hidden = !dr.length;
    $("#dropped-count").textContent = dups ? T("dropped_count_dup", { n: dr.length, d: dups }) : `(${dr.length})`;
    $("#dropped").innerHTML = `<div class="dropped">${dr.map((f, i) => `<p data-i="${esc(i)}"><b>${esc(LABEL[f.check] || f.check)}</b>: ${esc(f.message)} — <i>${esc(f.why || T("not_proven"))}</i>${f.model_why ? `<br><span class="muted">${T("model_said")}: ${esc(f.model_why)}</span>` : ""} <button class="btn tiny ghost drop-restore">${T("dropped_restore")}</button></p>`).join("")}</div>`;
    $("#dropped").querySelectorAll(".drop-restore").forEach(
      (b) => b.addEventListener("click", async () => {
        const i = +b.closest("p").dataset.i;
        if (!curS()) return;
        await updateSession(state.current, (cur) => {
          const dropped = cur.dropped || [];
          const f = dropped[i];
          if (!f) return;
          const { why, model_why, duplicate, restored, ...clean } = f;
          cur.findings = Lens.sortFindings([...cur.findings, clean]);
          dropped.splice(i, 1);
          cur.dropped = dropped;
        });
        renderReview();
      })
    );
    const flagged = new Set(s.findings.map((f) => f.seq));
    const ph = {};
    Lens.phases(s.events).forEach((p) => ph[p.start] = p.name);
    const names = { plan: T("ph_plan"), code: T("ph_code"), run: T("ph_run") };
    $("#timeline").innerHTML = s.events.map((e) => {
      const fail = e.tests && (e.tests.failed || e.tests.errors);
      let extra = e.tests ? ` — ${T("passed_failed", { p: e.tests.passed, f: e.tests.failed })}` : "";
      if (e.assert_delta && (e.assert_delta.weakened.length || e.assert_delta.removed.length)) extra += " — ⚠ " + T("asserts").toLowerCase();
      return (ph[e.seq] ? `<li class="ph">${esc(names[ph[e.seq]])}</li>` : "") + `<li id="e${esc(e.seq)}" class="${esc(e.kind)}${fail ? " fail" : ""}${flagged.has(e.seq) ? " flag" : ""}"><span class="seq">${esc(e.seq)}</span><span class="k">${esc(e.kind)}</span> ${esc(e.file || e.cmd || "")}${esc(extra)}${["message", "user"].includes(e.kind) ? `<span class="t">${esc(String(e.text || "").slice(0, 1e3))}</span>` : ""}</li>`;
    }).join("");
    const deltas = s.events.filter((e) => e.assert_delta);
    $("#asserts").innerHTML = deltas.length ? `<table><tr>${T("asserts_hdr").map((h) => `<th>${esc(h)}</th>`).join("")}</tr>${deltas.map((e) => {
      const d = e.assert_delta;
      const w = d.weakened.map((x) => `${x.test}: ${x.reason}`).concat(d.removed.map((r) => `${r.test}: ${r.before}→${r.after}`)).join("; ");
      return `<tr><td>${esc(e.seq)}</td><td>${esc(e.file)}</td><td>${esc(d.old)}</td><td>${esc(d.new)}</td><td>${d.identical ? `<span class="muted">${T("identical")}</span>` : esc(w) || `<span class="muted">${T("no_weak")}</span>`}</td></tr>`;
    }).join("")}</table>` : `<p class="muted">${T("no_compare", { tail: s.events.filter((e) => e.new_content).length ? T("code_once") : T("no_code") })}</p>`;
    const msgs = s.events.filter((e) => ["message", "user"].includes(e.kind));
    $("#transcript").innerHTML = msgs.length ? msgs.map((x) => `<p class="${x.kind === "user" ? "u" : ""}"><b>${x.kind === "user" ? T("user") : T("agent")}</b> (seq ${esc(x.seq)})<br>${esc(x.text)}</p>`).join("") : `<p class="muted">${T("no_msgs")}</p>`;
  }
  function renderRaw(s) {
    const d = $("#raw-d");
    if (!state.settings.debugModel) {
      d.hidden = true;
      return;
    }
    const lintDump = s.lintLog && s.lintLog.length || s.lintWhy && s.lintWhy.length ? "=== ESLint ===\n" + (s.lintLog || []).join("\n") + ((s.lintWhy || []).length ? "\n-- errors --\n" + s.lintWhy.join("\n") : "") : null;
    const segDump = s.seg_raw ? `=== ${T("seg_failed_hdr")}: ${s.seg_error || ""} ===
${s.seg_raw}` : s.seg && s.seg.raw;
    const parts = [lintDump, segDump, s.ai_raw].filter(Boolean);
    if (!parts.length) {
      d.hidden = true;
      return;
    }
    const all = parts.join("\n\n\n");
    d.hidden = false;
    $("#raw-count").textContent = s.ai_error || s.seg_error ? T("raw_error") : T("raw_size", { n: all.length });
    $("#raw").value = all;
  }
  function renderCoverage(s) {
    const c = s.coverage, el = $("#coverage");
    if (!c) {
      el.innerHTML = s.spec ? `<p class="muted">${T((s.events || []).some((e) => e.new_content) ? "no_readable_tests" : "no_code")}</p>` : "";
      return;
    }
    const spec = LensSpec.parse(s.spec);
    el.innerHTML = `<table class="cov"><tr><th>ID</th><th>${T("cov_requirement")}</th><th>${T("cov_tests")}</th></tr>${spec.requirements.map((r) => {
      const t = c.covered[r.id] || [];
      return `<tr><td>${esc(r.id)}</td><td>${esc(r.text.slice(0, 70))}</td><td class="${t.length ? "yes" : "no"}">${t.length ? esc(t.join(", ")) : T("md_none")}</td></tr>`;
    }).join("")}</table>${c.unlinked.length ? `<p class="muted">${T("cov_unlinked")}: ${esc(c.unlinked.map((t) => t.name).join(", "))}</p>` : ""}`;
  }
  async function setVerdict(k, v, note) {
    const vd = { v, note: note || "", at: (/* @__PURE__ */ new Date()).toISOString() };
    await updateSession(state.current, (s) => {
      s.verdicts[k] = vd;
    });
    renderReview();
  }
  function segStatus(s) {
    const g = s.seg, spec = g.spec_suggested ? T("seg_spec") : "";
    return g.chunks ? T("seg_status_chunks", { n: g.n, c: Math.round(g.coverage * 100), ok: g.chunks.ok, total: g.chunks.ok + g.chunks.failed, spec }) : T("seg_status", { n: g.n, c: Math.round(g.coverage * 100), spec });
  }

  // src/webview/main.js
  var booted;
  var LINT_REPAIR_DELAY_MS;
  var LINT_REPAIR_VERSION;
  var TREE_SITTER_LANGS;
  var rerenderTimer;
  function initMain() {
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
        setTimeout(() => {
          const s = curS();
          if (s) needEngine(s.profile);
        }, 0);
      }
    });
    window.SL_READY = booted;
    booted.then(() => {
      window.__slPageReady();
    });
    window.SL_COMMAND = async function(name, value) {
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
    LINT_REPAIR_DELAY_MS = 2e3;
    LINT_REPAIR_VERSION = 1;
    TREE_SITTER_LANGS = /* @__PURE__ */ new Set(["java", "csharp", "python"]);
    rerenderTimer = null;
    window.SL_REFRESH = async function(msg) {
      await booted;
      const scope = msg && msg.scope || "focus";
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
        if (IS_TAB) {
          if (id === state.current) renderReview();
          return;
        }
        rerender((v) => v !== "review" || id === state.current);
        return;
      }
      if (scope === "keys" || scope === "focus") await loadKeys();
      if (scope === "focus" && !IS_TAB) {
        const active = document.querySelector(".tab.active");
        window.__slSetActiveTab(active && /** @type {HTMLElement} */
        active.dataset.view || "sessions");
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
          IS_TAB ? () => {
            drawn = true;
            renderReview();
          } : null
        );
      renderList();
      if (!drawn) rerender();
      startBackground();
    };
  }
  async function loadKeys() {
    const keepRules = rulesTimer !== null ? state.ruleOverrides : null;
    const st = await store.get();
    Object.assign(state, st);
    if (keepRules) state.ruleOverrides = keepRules;
    {
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
  async function boot() {
    await loadKeys();
    I18N.set("en");
    I18N.apply(document);
    await loadIndex();
    if (IS_TAB) {
      state.current = window.SL_OPEN_SESSION;
      if (await loadSession(state.current)) await ensureFresh(state.current);
    }
    renderList();
    if (!window.SL_OPEN_SESSION) {
      const active = document.querySelector(".tab.active");
      window.__slSetActiveTab(active && /** @type {HTMLElement} */
      active.dataset.view || "sessions");
    }
    startBackground();
    if (!IS_TAB)
      setTimeout(() => {
        repairLint().catch(() => {
        });
      }, LINT_REPAIR_DELAY_MS);
  }
  function onEngineSettled(ev) {
    const language = ev && ev.detail && ev.detail.language;
    booted.then(async () => {
      const s = curS();
      if (s && s.lintPending && Lens.profile(s.profile).language === language) {
        try {
          if (await updateSession(state.current, (x) => analyze(x), { skipIfSame: true })) renderReview();
        } catch (e) {
        }
      }
      if (!IS_TAB && metas().some((m) => m.analyzedGen === "")) startBackground();
    });
  }
  async function repairLint() {
    if (IS_TAB || state.lintRepair >= LINT_REPAIR_VERSION || state.settings.lint === false) return;
    const ids = metas().filter((m) => TREE_SITTER_LANGS.has(Lens.profile(m.profile).language)).map((m) => m.id);
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
      }
      await new Promise((r) => setTimeout(r, BG_PAUSE_MS));
    }
    state.lintRepair = LINT_REPAIR_VERSION;
    await saveKeys(["lintRepair"]);
    if (done) rerender();
  }
  function rerender(onlyIf) {
    if (rerenderTimer) return;
    rerenderTimer = setTimeout(() => {
      rerenderTimer = null;
      const active = document.querySelector(".tab.active");
      const v = window.SL_OPEN_SESSION ? "review" : active && /** @type {HTMLElement} */
      active.dataset.view;
      if (onlyIf && !onlyIf(v)) return;
      if (v === "review") renderReview();
      else if (v === "calib") renderCalib();
      else if (v === "rules") renderRules();
      else if (v === "prompts") renderPrompts();
      else if (v === "settings") renderSettings();
      else if (v === "sessions") renderList();
    }, 0);
  }

  // src/webview/store.js
  var IS_TAB;
  var BATCH;
  var BG_PAUSE_MS;
  var BG_AFTER_CHANGE_MS;
  var sessionStore;
  var genNow;
  var needEngine;
  var metas;
  var curS;
  var bgRun;
  var bgTimer;
  function initStore() {
    IS_TAB = !!window.SL_OPEN_SESSION;
    BATCH = 10;
    BG_PAUSE_MS = 50;
    BG_AFTER_CHANGE_MS = 1e3;
    sessionStore = {
      async list() {
        const r = await window.__slSessionList();
        if (!r || r.error) throw new Error(r && r.error || "no session list");
        return r.items;
      },
      async get(id) {
        const r = await window.__slSessionGet(id);
        return r && !r.error ? r : null;
      },
      put: (session, opts) => window.__slSessionPut(session, opts),
      delete: (id) => window.__slSessionDelete(id),
      clear: () => window.__slSessionClear()
    };
    genNow = () => Lens.analysisGen({ ruleOverrides: state.ruleOverrides, lint: state.settings.lint !== false, epoch: state.analysisEpoch });
    needEngine = (profile) => state.settings.lint === false ? Promise.resolve("off") : LensLint.ensure(Lens.profile(profile).language);
    metas = () => Object.values(state.index).sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.created).localeCompare(String(b.created)));
    curS = () => state.loaded[state.current];
    bgRun = 0;
    bgTimer = null;
  }
  async function loadIndex() {
    const items = await sessionStore.list();
    state.index = {};
    for (const m of items) state.index[m.id] = m;
  }
  function adopt(r) {
    const s = r.session;
    state.loaded[s.id] = s;
    state.revs[s.id] = r.rev;
    state.gens[s.id] = r.meta ? r.meta.analyzedGen : "";
    if (r.meta) state.index[s.id] = r.meta;
    return s;
  }
  async function loadSession(id) {
    if (!id) return null;
    if (state.loaded[id]) return state.loaded[id];
    const r = await sessionStore.get(id);
    return r ? adopt(r) : null;
  }
  async function fetchSessions(ids, each) {
    for (let i = 0; i < ids.length; i += BATCH) {
      const part = await Promise.all(
        ids.slice(i, i + BATCH).map((id) => state.loaded[id] ? { session: state.loaded[id], rev: state.revs[id], meta: state.index[id] } : sessionStore.get(id))
      );
      for (const r of part) if (r && r.session) each(r.session, r);
    }
  }
  async function updateSession(id, fn, opts = {}) {
    let from = opts.from || null;
    for (let attempt = 0; attempt < 3; attempt++) {
      let s, rev;
      if (state.loaded[id]) {
        s = state.loaded[id];
        rev = state.revs[id];
      } else {
        const r2 = from || await sessionStore.get(id);
        from = null;
        if (!r2) return false;
        s = r2.session;
        rev = r2.rev;
        state.gens[id] = r2.meta ? r2.meta.analyzedGen : "";
      }
      const same = opts.skipIfSame ? () => JSON.stringify([s.findings, s.lintNote || "", !!s.lintPending, state.gens[id] || ""]) : null;
      const before = same && same();
      fn(s);
      if (same && same() === before) return false;
      if (opts.after) opts.after(s);
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
      throw new Error(r && r.error || "could not save the session");
    }
    throw new Error("the session kept changing elsewhere and was not saved");
  }
  async function putNew(s) {
    const r = await sessionStore.put(s, { analyzedGen: state.gens[s.id] || "" });
    if (!r || !r.ok) throw new Error(r && r.error || "could not save the session");
    if (r.meta) state.index[s.id] = r.meta;
    return r;
  }
  async function ensureFresh(id, after) {
    if (!state.loaded[id] || state.gens[id] === genNow()) return false;
    await needEngine(state.loaded[id].profile);
    if (!state.loaded[id] || state.gens[id] === genNow()) return false;
    let drawn = false;
    await updateSession(id, (x) => analyze(x), {
      after: after ? (x) => {
        if (!drawn) {
          drawn = true;
          after(x);
        }
      } : null
    });
    return true;
  }
  function startBackground(delayMs = BG_PAUSE_MS) {
    if (IS_TAB) return;
    const run = ++bgRun;
    clearTimeout(bgTimer);
    bgTimer = setTimeout(async () => {
      const gen = genNow();
      const todo = metas().filter((m) => m.analyzedGen !== gen && !state.loaded[m.id]).sort((a, b) => String(b.created).localeCompare(String(a.created)));
      let done = 0;
      for (const m of todo) {
        if (run !== bgRun || genNow() !== gen || rulesTimer !== null) return;
        await needEngine(m.profile);
        if (run !== bgRun || genNow() !== gen || rulesTimer !== null) return;
        try {
          if (await updateSession(m.id, (x) => analyze(x, "background"), { background: true })) done++;
        } catch (e) {
        }
        await new Promise((r) => setTimeout(r, BG_PAUSE_MS));
      }
      if (done && run === bgRun) rerender();
    }, delayMs);
  }
  function onGenChanged() {
    if (!IS_TAB && state.current && state.loaded[state.current])
      ensureFresh(state.current).then((ch) => {
        if (ch) renderReview();
      });
    startBackground(BG_AFTER_CHANGE_MS);
  }
  var isDemo = (m) => typeof LensDemo !== "undefined" && m.id === LensDemo.ID;
  function calibStats() {
    const st = {};
    const add = (check, v) => {
      const x = st[check] = st[check] || { total: 0, ok: 0, fp: 0 };
      x.total++;
      if (v) x[v.v]++;
    };
    for (const m of metas())
      if (!isDemo(m))
        for (const [check, c] of Object.entries(m.checkStats || {})) {
          const x = st[check] = st[check] || { total: 0, ok: 0, fp: 0 };
          x.total += c.total;
          x.ok += c.ok;
          x.fp += c.fp;
        }
    for (const f of state.external) add(f.check, f.verdict ? { v: f.verdict } : null);
    return st;
  }
  function profileVerdicts(profile) {
    let n = 0;
    for (const m of metas()) if (m.profile === profile && !isDemo(m)) n += m.verdictsCount || 0;
    return n;
  }

  // src/webview/index.js
  initCommon();
  initStore();
  initAnalysis();
  initSessions();
  initReview();
  initCalibration();
  initRules();
  initPrompts();
  initSettings();
  initMain();
})();
