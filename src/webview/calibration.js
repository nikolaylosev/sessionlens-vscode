// @ts-check
/* SessionLens panel — export of verdicts and the Calibration tab. Part of the panel's source (src/webview); `npm run build` bundles it into
   media/app.js. Split out of the single app.js in phase 7 (7B.4) without changing behaviour. */
import { $, SEV, T, VLABEL, esc, fkey, genId, rulesFileText, rulesTargetLabel, save, srcLabel, state } from "./common.js";
import { calibStatsBySource, curS, fetchSessions, isDemo, metas, onGenChanged, sessionStore, updateSession } from "./store.js";
import { readFile, renderList, show } from "./sessions.js";
import { renderReview } from "./review.js";
import { profileChecks } from "./rules.js";

// set in initCalibration(), in the order the single app.js ran its statements
export let CAL_LOG_KEEP, CAL_LOG_MAX_CHARS, EXAMPLE_FILES_PER_RULE, EXAMPLE_MAX_CHARS, skillStubPath, stubText;

export function initCalibration() {
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
      r.spec && r.spec.n
        ? T("md_spec", {
            n: r.spec.n,
            unc: s.coverage ? T("md_unc", { list: s.coverage.uncovered.length ? s.coverage.uncovered.join(", ") : T("md_none") }) : "",
          })
        : T("md_no_spec"),
      ``,
      T("md_confirmed"),
      ...r.findings
        .filter((f) => f.verdict && f.verdict.v === "ok")
        .map(
          (f) =>
            `- ${sev[f.severity]} **${SEV[f.severity]}** ${f.message}${f.seq >= 0 ? ` _(seq ${f.seq})_` : ""}${f.verdict.note ? ` — ${f.verdict.note}` : ""}`,
        ),
      ``,
      T("md_false"),
      ...r.findings.filter((f) => f.verdict && f.verdict.v === "fp").map((f) => `- ~~${f.message}~~${f.verdict.note ? ` — ${f.verdict.note}` : ""}`),
      ``,
      T("md_undecided"),
      ...r.findings.filter((f) => !f.verdict).map((f) => `- ${sev[f.severity]} ${f.message}`),
      ``,
      ...hiddenMd(r.hiddenByCalibration, sev),
      `_sessionlens · ${new Date().toISOString().slice(0, 10)}_`,
    ].join("\n");
    navigator.clipboard.writeText(md).then(() => {
      $("#export-md").textContent = T("md_copied");
      setTimeout(() => ($("#export-md").textContent = T("md_btn")), 1500);
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
    if (!(await confirmDialog(T("del_confirm")))) return;
    const id = state.current;
    await sessionStore.delete(id);
    delete state.loaded[id];
    delete state.index[id];
    state.current = null;
    // A dedicated session tab has nothing left to show once its session is gone — close it
    // instead of leaving an empty "pick a session" tab behind.
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
    if (!(await confirmDialog(T("rules_restore_confirm")))) return;
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
  $("#rules-pick-all").addEventListener("click", () =>
    $("#rules")
      .querySelectorAll(".rule-pick")
      .forEach((c) => {
        c.checked = true;
      }),
  );
  $("#rules-pick-none").addEventListener("click", () =>
    $("#rules")
      .querySelectorAll(".rule-pick")
      .forEach((c) => {
        c.checked = false;
      }),
  );
  $("#copy-rules").addEventListener("click", async () => {
    const md = T("rules_title", { f: rulesTargetLabel() }) + "\n\n" + (pickedRulesMd() || T("rules_none") + "\n");
    await navigator.clipboard.writeText(rulesFileText(md));
    $("#copy-rules").textContent = T("rules_copied");
    setTimeout(() => ($("#copy-rules").textContent = T("rules_copy")), 1500);
  });
  /* Every request made from this tab is kept as it was sent and answered, like the model log inside a session:
     the last few, newest first, failures included. Segmentation and the review log their exchange in the session. */
  CAL_LOG_KEEP = 6;
  CAL_LOG_MAX_CHARS = 300000;
  $("#cal-raw-copy").addEventListener("click", async () => {
    await navigator.clipboard.writeText($("#cal-raw").value);
    $("#cal-raw-copy").textContent = T("copied");
    setTimeout(() => ($("#cal-raw-copy").textContent = T("copy")), 1200);
  });
  $("#cal-raw-dl").addEventListener("click", () => download("model-dump-calibration.txt", $("#cal-raw").value));
  $("#cal-raw-clear").addEventListener("click", async () => {
    if (!(await confirmDialog(T("cal_raw_clear_confirm")))) return;
    state.calibLog = [];
    await save();
    renderCalLog();
  });
  $("#compress-rules").addEventListener("click", async () => {
    const btn = $("#compress-rules"),
      st = $("#compress-status");
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
        { label: T("gen_dup_new"), value: "new" },
      ]);
      if (choice === null) return;
      if (choice === "overwrite") overwriteId = prevList[0].id;
    }
    btn.disabled = true;
    st.textContent = T("compress_wait");
    try {
      const r = await LensAI.compressRules(md, state.settings, undefined, rulesTargetLabel());
      if (overwriteId) {
        state.compressResults = state.compressResults.map((x) =>
          x.id === overwriteId ? { id: overwriteId, at: new Date().toISOString(), markdown: r.markdown, body } : x,
        );
        await save();
        renderCompressResults(overwriteId);
      } else {
        const id = genId();
        state.compressResults = [{ id, at: new Date().toISOString(), markdown: r.markdown, body }, ...(state.compressResults || [])];
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

  /* examples/ for a generated skill: the real files the agent wrote in the sessions where a rule's finding was
     confirmed, exactly as written except for masked secrets. Nothing here is written by a model, so nothing is
     invented. Rules about process (no test run, no triage) have no file and therefore no example. */
  EXAMPLE_FILES_PER_RULE = 2;
  EXAMPLE_MAX_CHARS = 40000;

  // The thin CLAUDE.md/AGENTS.md pointer both agents can share, instead of duplicating the skill's
  // content into each: a plain line of prose, so it needs no vendor-specific discovery folder — the
  // entry-point file just tells the agent to go read it, the same way for either agent. For Cursor's
  // .mdc target it is the whole file, frontmatter included.
  skillStubPath = (skillName) => `skills/${skillName}/SKILL.md`;
  stubText = (refPath) => rulesFileText(`Refer to \`${refPath}\` for domain-specific automation rules and code style.\n`);
  $("#gen-skill").addEventListener("click", async () => {
    const btn = $("#gen-skill"),
      st = $("#gen-skill-status");
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
        { label: T("gen_dup_new"), value: "new" },
      ]);
      if (choice === null) return;
      if (choice === "overwrite") overwriteId = prevList[0].id;
    }
    const ex = $("#gen-skill-examples").checked ? await buildExamples(pickedRuleKeys()) : { files: [], rows: [], masked: 0 };
    // the model only learns which example files exist, so it can link to them; their content is never sent
    const exList = ex.rows.length
      ? "\n\n## Example files\n" +
        [...new Set(ex.rows.map((r) => r.k))]
          .map(
            (k) =>
              `- ${k}: ` +
              ex.rows
                .filter((r) => r.k === k)
                .map((r) => r.path)
                .join(", "),
          )
          .join("\n") +
        "\n"
      : "";
    const md = T("rules_title", { f: rulesTargetLabel() }) + "\n\n" + body + exList;
    btn.disabled = true;
    st.textContent = T("gen_skill_wait");
    try {
      const r = await LensAI.generateSkill(md, state.settings, undefined, rulesTargetLabel());
      r.files = r.files.filter((f) => !/^examples\//.test(f.path)).concat(ex.files); // examples come from real sessions only
      if (overwriteId) {
        state.skillResults = state.skillResults.map((x) =>
          x.id === overwriteId ? { id: overwriteId, at: new Date().toISOString(), skill_name: r.skill_name, files: r.files, body } : x,
        );
        await save();
        renderSkillResults(overwriteId);
      } else {
        const id = genId();
        state.skillResults = [{ id, at: new Date().toISOString(), skill_name: r.skill_name, files: r.files, body }, ...(state.skillResults || [])];
        await save();
        renderSkillResults(id);
      }
      await logCal("skill", r.raw);
      st.textContent = $("#gen-skill-examples").checked
        ? ex.rows.length
          ? T("gen_examples_added", { n: ex.rows.length, r: ex.masked })
          : T("gen_examples_none")
        : "";
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

// ---------- export ----------
// which model found a model finding, and which one verified it (0.1.115); nothing for the other sources
const modelOf = (f) => Object.assign({}, f.model ? { model: f.model } : {}, f.verifier ? { verifier: f.verifier } : {});

/* 0.1.116: what calibration hides is in the reports too, so a green report does not read as "nothing found".
   Each hidden finding carries the record that hid it (s.suppressed: precision and verdicts of its check and source). */
function hiddenRows(s) {
  const why = new Map((s.suppressed || []).map((x) => [x.check + "|" + x.source, x]));
  return (s.calibHidden || []).map((f) => {
    const src = f.source || "formal",
      w = why.get(f.check + "|" + src);
    return {
      check: f.check,
      severity: f.severity,
      seq: f.seq,
      message: f.message,
      source: src,
      precision: w ? w.precision : null,
      verdicts: w ? w.n : null,
      verdict: s.verdicts[fkey(f)] || null,
    };
  });
}
// the PR report names the hidden high findings one by one and counts the rest; nothing when calibration hid nothing
function hiddenMd(rows, sev) {
  if (!rows.length) return [];
  const high = rows.filter((f) => f.severity === "high"),
    rest = rows.length - high.length;
  return [
    T("md_hidden"),
    ...high.map(
      (f) =>
        `- ${sev.high} ${f.message}${f.seq >= 0 ? ` _(seq ${f.seq})_` : ""} — ${f.check}, ${srcLabel(f.source)}${f.precision != null ? `: ${T("md_hidden_why", { p: Math.round(f.precision * 100), n: f.verdicts })}` : ""}`,
    ),
    ...(rest ? [T("md_hidden_rest", { n: rest })] : []),
    ``,
  ];
}

export function reportObj(s) {
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
      ...modelOf(f),
      verdict: s.verdicts[fkey(f)] || null,
    })),
    hiddenByCalibration: hiddenRows(s),
    dropped: s.dropped || [],
  };
}

export function highWithoutVerdict(s) {
  return s.findings.filter((f) => f.severity === "high" && !s.verdicts[fkey(f)]);
}

// nameSet (phase 6): a name given here is what the session is called from now on (Lens.displayName), also in the
// tab title and the Sessions tree; the host renames through here too when this session is open in a tab
export async function renameCurrent(name) {
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

// ---------- calibration ----------
export function renderCalib() {
  renderCalLog();
  renderCompressResults();
  renderSkillResults();
  $("#calib-prec-d").open = state.settings.calibPrecOpen !== false;
  $("#calib-rules-d").open = state.settings.calibRulesOpen !== false;
  $("#c-rules-title").textContent = T("c_rules", { f: rulesTargetLabel() });
  $("#rules-target").value = state.settings.rulesTarget || "claude";
  const stats = calibStatsBySource();
  const confirmed = [];
  // the confirmed findings as the summaries keep them (message cut to 90 characters, snippet precomputed): all this list shows
  for (const m of metas()) for (const c of m.confirmed || []) confirmed.push({ s: m, f: c, vd: { v: "ok", note: c.note } });
  $("#precision").innerHTML =
    `<tr>${T("prec_hdr")
      .map((h) => `<th>${esc(h)}</th>`)
      .join("")}</tr>` +
    // phase 8: one row per check AND source, with the status calibrate() really applies to it
    Object.entries(stats)
      .flatMap(([k, per]) => Object.entries(per).map(([src, st]) => [k, src, st]))
      .sort((a, b) => b[2].total - a[2].total)
      .map(([k, src, st]) => {
        const { n, p, level } = Lens.calibLevel(st);
        let status = level === "need" ? T("st_need", { n: 10 - n }) : T("st_" + level),
          why = "";
        if (!Lens.isCalibrated(k, src)) {
          status = T("st_not_calibrated");
          // a source calibrate() otherwise applies to: the registry keeps this check out (calibrate: false)
          why = T(src === "ai" ? "st_why_ai" : src === "spec" ? "st_why_fact" : src === "external" ? "st_why_external" : "st_why_kept");
        } else if (level === "off" && (state.ruleOverrides[k] || {}).enabled === true) {
          status = T("st_by_hand");
          why = T("st_by_hand_hint", { p: Math.round(p * 100) });
        }
        return `<tr><td>${esc(k)}</td><td>${esc(srcLabel(src))}</td><td>${esc(st.total)}</td><td>${esc(st.ok)}</td><td>${esc(st.fp)}</td><td style="color:${p == null ? "var(--muted)" : p < 0.5 ? "var(--red)" : p < 0.8 ? "var(--amber)" : "var(--green)"}">${p == null ? "—" : Math.round(p * 100) + "%"}</td><td class="muted"${why ? ` title="${esc(why)}"` : ""}>${esc(status)}</td></tr>`;
      })
      .join("");
  const min = +$("#min-count").value || 1,
    by = {};
  for (const c of confirmed) (by[c.f.check] = by[c.f.check] || []).push(c);
  const rules = Object.entries(by)
    .filter(([k, l]) => l.length >= min && !state.rulesDismissed[k])
    .sort((a, b) => b[1].length - a[1].length);
  const snippet = (f) => f.snippet; // Lens.snippet(), computed when the session was saved
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
      good ? `${T("md_good")}\n\n\`\`\`\n${good}\n\`\`\`` : "",
      "",
      `${T("rules_ev")}`,
      ...l.slice(0, 5).map((x) => `- ${x.s.task || x.s.name}, seq ${x.f.seq}${x.vd.note ? ` — «${x.vd.note}»` : ""}`),
      "",
    ].join("\n");
  };
  $("#rules-pick-row").hidden = !rules.length;
  const dismissedCount = Object.keys(state.rulesDismissed).length;
  $("#dismissed-row").hidden = !dismissedCount;
  if (dismissedCount) $("#dismissed-note").textContent = T("dismissed_note", { n: dismissedCount });
  $("#rules").innerHTML = rules.length
    ? rules
        .map(([k, l]) => {
          const ap = state.rulesApplied[k];
          const eff = ap ? effect(k, ap) : null;
          const evOpen = (state.settings.rulesEvOpen || {})[k] === true;
          return `<div class="rule" data-k="${esc(k)}" data-md="${esc(encodeURIComponent(ruleMd(k, l)))}">
        <div class="rule-top"><input type="checkbox" class="rule-pick" checked><b>${esc(T("rule_hdr", { k, n: l.length, s: new Set(l.map((x) => x.s.id)).size }))}</b></div>
        ${esc(LensRules.ruleText(k, state.ruleOverrides))}
        <details class="sec-d ev-d" data-check="${esc(k)}" ${evOpen ? "open" : ""}><summary class="h2">${T("ev_summary")}</summary><div class="ev">${l
          .slice(0, 5)
          .map(
            (x) =>
              `${esc(x.s.task || x.s.name)}, seq ${esc(x.f.seq)}: ${esc(String(x.f.message || "").slice(0, 90))}${x.vd.note ? ` — «${esc(x.vd.note)}»` : ""}`,
          )
          .join("<br>")}</div></details>
        <div class="row actions rule-actions">${ap ? `<span class="applied">${esc(T("applied", { f: rulesTargetLabel(), d: String(ap).slice(0, 10) }))}</span><button class="btn tiny ghost unmark-applied">${T("unmark_applied")}</button>` : `<button class="btn tiny ghost mark-applied">${esc(T("mark_applied", { f: rulesTargetLabel() }))}</button>`}<button class="btn tiny ghost danger del-rule">${T("delete")}</button></div>
        ${ap ? `<div class="effect">${eff}</div>` : ""}</div>`;
        })
        .join("")
    : `<p class="muted">${T("no_rules")}</p>`;
  $("#rules")
    .querySelectorAll(".ev-d")
    .forEach((d) => {
      d.addEventListener("toggle", async () => {
        state.settings.rulesEvOpen = Object.assign({}, state.settings.rulesEvOpen, { [d.dataset.check]: d.open });
        await save();
      });
    });
  $("#rules")
    .querySelectorAll(".mark-applied")
    .forEach((b) =>
      b.addEventListener("click", async () => {
        state.rulesApplied[b.closest(".rule").dataset.k] = new Date().toISOString();
        await save();
        renderCalib();
      }),
    );
  $("#rules")
    .querySelectorAll(".unmark-applied")
    .forEach((b) =>
      b.addEventListener("click", async () => {
        if (!(await confirmDialog(T("unmark_applied_confirm", { f: rulesTargetLabel() })))) return;
        delete state.rulesApplied[b.closest(".rule").dataset.k];
        await save();
        renderCalib();
      }),
    );
  $("#rules")
    .querySelectorAll(".del-rule")
    .forEach((b) =>
      b.addEventListener("click", async () => {
        const k = b.closest(".rule").dataset.k;
        if (!(await confirmDialog(T("rule_del_confirm", { f: rulesTargetLabel() })))) return;
        state.rulesDismissed[k] = true;
        await save();
        renderCalib();
      }),
    );
}

/* Only the rule blocks whose checkbox is still ticked go into "Copy rules.md" / "Compress rules.md". */
export function pickedRulesMd() {
  const parts = [];
  $("#rules")
    .querySelectorAll(".rule")
    .forEach((d) => {
      const cb = d.querySelector(".rule-pick");
      if (cb && cb.checked) parts.push(decodeURIComponent(d.dataset.md));
    });
  return parts.join("\n");
}

/* How often the agent made the finding per session before and after the rule was moved to the target file (since).
   0.1.116: a session counts when the agent ran it (Lens.sessionSummary's started; created, the time of the import,
   when the transcript has no times); only sessions of the profiles that can report the check, a session without the
   finding as 0; the demo session never. Every source together: the effect is about what the agent does, and a
   finding an engine started to report is not the rule's failure. */
export function effect(check, since) {
  const before = [],
    after = [],
    at = Date.parse(since),
    can = new Map(); // profile → can it report the check
  for (const m of metas()) {
    if (isDemo(m)) continue;
    if (!can.has(m.profile)) can.set(m.profile, profileChecks(m.profile).has(check));
    if (!can.get(m.profile)) continue;
    // a session without a readable time goes before, as it did when created was compared as text
    (Date.parse(m.started || m.created) >= at ? after : before).push(((m.checkStats || {})[check] || { total: 0 }).total);
  }
  const avgNum = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const avg = (a) => {
    const v = avgNum(a);
    return v == null ? "—" : v.toFixed(2);
  };
  if (!after.length) return `<div class="eff-note">${T("eff_no_after", { b: avg(before), n: before.length })}</div>`;
  const bNum = avgNum(before),
    aNum = avgNum(after);
  const b = +avg(before),
    a = +avg(after);
  const d = before.length && b > 0 ? Math.round((1 - a / b) * 100) : null;
  const note = T("eff", {
    b: avg(before),
    nb: before.length,
    a: avg(after),
    na: after.length,
    d: d != null ? ` — ${d > 0 ? "−" : "+"}${Math.abs(d)}%` : "",
    few: after.length < 5 ? T("eff_few") : "",
  });
  const max = Math.max(bNum || 0, aNum, 0.01);
  const bw = bNum ? Math.max(3, Math.round((bNum / max) * 100)) : 0;
  const aw = Math.max(3, Math.round((aNum / max) * 100));
  const dir = bNum == null ? "flat" : aNum < bNum ? "good" : aNum > bNum ? "bad" : "flat";
  const chart = `<div class="eff-chart">
      <div class="eff-row"><span class="eff-lbl">${T("eff_before")}</span><div class="eff-track"><div class="eff-bar" style="width:${bw}%"></div></div><span class="eff-val">${avg(before)}</span></div>
      <div class="eff-row"><span class="eff-lbl">${T("eff_after")}</span><div class="eff-track"><div class="eff-bar ${dir}" style="width:${aw}%"></div></div><span class="eff-val">${avg(after)}</span></div>
    </div>`;
  return chart + `<div class="eff-note">${note}</div>`;
}

export async function logCal(task, raw, error) {
  if (!raw) return;
  state.calibLog = [
    { at: new Date().toISOString(), task, raw: String(raw).slice(0, CAL_LOG_MAX_CHARS), error: error || null },
    ...(state.calibLog || []),
  ].slice(0, CAL_LOG_KEEP);
  await save();
  renderCalLog();
}

export function calLogText() {
  const label = { compress: T("p_compress"), skill: T("p_gen_skill") };
  return (state.calibLog || [])
    .map((en) => `######## ${en.at.replace("T", " ").slice(0, 19)} · ${label[en.task] || en.task}${en.error ? " · " + T("raw_error") : ""} ########\n${en.raw}`)
    .join("\n\n\n");
}

export function renderCalLog() {
  const d = $("#cal-raw-d"),
    log = state.calibLog || [];
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

// Cursor's .mdc target is a file of its own: the stub is saved as it is, not added to an entry-point file
const cursorTarget = () => state.settings.rulesTarget === "cursor";
const stubTitle = () => (cursorTarget() ? T("gen_skill_stub_title_cursor") : T("gen_skill_stub_title"));
const stubNote = () => (cursorTarget() ? T("gen_skill_stub_note_cursor") : T("gen_skill_stub_note", { f: rulesTargetLabel() }));
const stubHeight = () => (cursorTarget() ? "110px" : "48px");

export function renderCompressResults(openId) {
  const list = state.compressResults || [];
  $("#compress-d").hidden = !list.length;
  $("#compress-results").innerHTML = list
    .map(
      (r) => `<details class="sec-d gen-result" data-id="${esc(r.id)}" ${r.id === openId ? "open" : ""}>
      <summary class="h2">${esc(r.at.replace("T", " ").slice(0, 19))}</summary>
      <textarea class="compress-out" readonly style="height:220px;font-family:monospace;font-size:12px">${esc(r.markdown)}</textarea>
      <div class="row actions"><button class="btn tiny ghost gr-copy">${T("copy")}</button><button class="btn tiny ghost gr-dl">${T("compress_dl")}</button><button class="btn tiny ghost danger gr-del">${T("delete")}</button></div>
      <details class="gen-file"><summary>${esc(stubTitle())}</summary>
        <p class="muted">${esc(stubNote())}</p>
        <textarea readonly class="stub-text" style="height:${stubHeight()};font-family:monospace;font-size:12px">${esc(stubText("rules-policy.md"))}</textarea>
        <div class="row actions"><button class="btn tiny ghost stub-copy">${T("copy")}</button></div>
      </details>
    </details>`,
    )
    .join("");
  $("#compress-results")
    .querySelectorAll(".gen-result")
    .forEach((d) => {
      const id = d.dataset.id,
        ta = d.querySelector(".compress-out");
      const copyBtn = d.querySelector(".gr-copy");
      copyBtn.addEventListener("click", async () => {
        await navigator.clipboard.writeText(ta.value);
        copyBtn.textContent = T("copied");
        setTimeout(() => (copyBtn.textContent = T("copy")), 1200);
      });
      d.querySelector(".gr-dl").addEventListener("click", () => download("rules-policy.md", ta.value));
      d.querySelector(".stub-copy").addEventListener("click", async () => {
        await navigator.clipboard.writeText(d.querySelector(".stub-text").value);
        const b = d.querySelector(".stub-copy");
        b.textContent = T("copied");
        setTimeout(() => (b.textContent = T("copy")), 1200);
      });
      d.querySelector(".gr-del").addEventListener("click", async () => {
        if (!(await confirmDialog(T("gen_result_del_confirm")))) return;
        state.compressResults = (state.compressResults || []).filter((x) => x.id !== id);
        await save();
        renderCompressResults();
      });
    });
}

export function pickedRuleKeys() {
  const ks = [];
  $("#rules")
    .querySelectorAll(".rule")
    .forEach((d) => {
      const cb = d.querySelector(".rule-pick");
      if (cb && cb.checked) ks.push(d.dataset.k);
    });
  return ks;
}

export function confirmedFor(k, full) {
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

export async function buildExamples(keys) {
  // only the sessions with a confirmed finding of a picked rule are read, BATCH at a time
  const full = {};
  await fetchSessions(
    metas()
      .filter((m) => (m.confirmed || []).some((c) => keys.includes(c.check)))
      .map((m) => m.id),
    (s) => {
      full[s.id] = s;
    },
  );
  const files = [],
    rows = [],
    used = new Set();
  for (const k of keys) {
    const cand = confirmedFor(k, full)
      .map(({ s, f }) => ({ s, f, e: s.events.find((x) => x.seq === f.seq) }))
      .filter((x) => x.e && x.e.new_content && !x.e.fragment_only);
    const bySession = new Set();
    const order = [...cand.filter((x) => !bySession.has(x.s.id) && bySession.add(x.s.id)), ...cand]; // one per session first
    let n = 0;
    for (const { s, f, e } of order) {
      if (n >= EXAMPLE_FILES_PER_RULE) break;
      const id = `${s.id}|${e.file || "seq" + f.seq}|${k}`;
      if (used.has(id)) continue;
      used.add(id);
      const base = ((e.file || "").split("/").pop() || `from-chat-seq${f.seq}.txt`).replace(/[^\w.\-]/g, "_");
      const cut = e.new_content.length > EXAMPLE_MAX_CHARS,
        red = Lens.redactSecrets(e.new_content.slice(0, EXAMPLE_MAX_CHARS));
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
      (r) => `| \`${r.path.replace("examples/", "")}\` | ${r.k} | ${cell(r.session)} | ${r.seq} | ${cell(r.message)}${notes(r) ? " (" + notes(r) + ")" : ""} |`,
    ),
    "",
  ].join("\n");
  return { files: [{ path: "examples/README.md", content: readme }, ...files], rows, masked: rows.reduce((a, r) => a + r.masked, 0) };
}

export function renderSkillResults(openId) {
  const list = state.skillResults || [];
  $("#gen-skill-d").hidden = !list.length;
  $("#gen-skill-results").innerHTML = list
    .map(
      (r) => `<details class="sec-d gen-result" data-id="${esc(r.id)}" ${r.id === openId ? "open" : ""}>
      <summary class="h2">${esc(r.at.replace("T", " ").slice(0, 19))} — ${esc(r.skill_name)}</summary>
      <div class="gen-skill-files">${r.files.map((f, i) => `<details class="gen-file"${i === 0 ? " open" : ""}><summary>${esc(f.path)}</summary><textarea readonly style="height:160px;font-family:monospace;font-size:12px">${esc(f.content)}</textarea></details>`).join("")}</div>
      <p class="muted">${T("gen_skill_note")}</p>
      <details class="gen-file"><summary>${esc(stubTitle())}</summary>
        <p class="muted">${esc(stubNote())}</p>
        <textarea readonly class="stub-text" style="height:${stubHeight()};font-family:monospace;font-size:12px">${esc(stubText(skillStubPath(r.skill_name)))}</textarea>
        <div class="row actions"><button class="btn tiny ghost stub-copy">${T("copy")}</button></div>
      </details>
      <div class="row actions"><button class="btn tiny ghost gs-save">${T("gen_skill_save")}</button><span class="muted gs-save-status"></span><button class="btn tiny ghost danger gr-del">${T("delete")}</button></div>
    </details>`,
    )
    .join("");
  $("#gen-skill-results")
    .querySelectorAll(".gen-result")
    .forEach((d) => {
      const id = d.dataset.id;
      d.querySelector(".stub-copy").addEventListener("click", async () => {
        await navigator.clipboard.writeText(d.querySelector(".stub-text").value);
        const b = d.querySelector(".stub-copy");
        b.textContent = T("copied");
        setTimeout(() => (b.textContent = T("copy")), 1200);
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
        }, 4000);
      });
      d.querySelector(".gr-del").addEventListener("click", async () => {
        if (!(await confirmDialog(T("gen_result_del_confirm")))) return;
        state.skillResults = (state.skillResults || []).filter((x) => x.id !== id);
        await save();
        renderSkillResults();
      });
    });
}

export async function exportVerdicts() {
  const rows = [];
  await fetchSessions(
    metas().map((m) => m.id),
    (s) => {
      // with the findings an "off" check hides (calibHidden): their verdicts are what keep the check off (0.1.116)
      const hidden = new Set(s.calibHidden || []);
      for (const f of [...s.findings, ...(s.calibHidden || [])]) {
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
            ...modelOf(f),
            verdict: vd.v,
            note: vd.note,
            at: vd.at,
            ...(hidden.has(f) ? { hidden: true } : {}),
          });
      }
    },
  );
  download("verdicts.json", JSON.stringify(rows, null, 1));
}

export async function importVerdicts(text) {
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
  let merged = 0,
    ext = 0,
    dup = 0;
  // an imported row already kept: the same file imported twice must not count its verdicts twice (0.1.116)
  const extKey = (x) => [x.check, x.source || "external", x.session || "", String(x.message).slice(0, 40)].join("|");
  const known = new Set(state.external.map(extKey));
  // sessions are found by name or task in the summaries and read once; the verdicts are then saved per session
  const read = {},
    ops = {},
    all = metas();
  for (const r of rows) {
    if (!r || !r.check || !r.message) continue;
    const m = all.find((x) => x.name === r.session || (r.task && x.task === r.task));
    if (m && !read[m.id]) read[m.id] = state.loaded[m.id] ? { session: state.loaded[m.id], rev: state.revs[m.id], meta: m } : await sessionStore.get(m.id);
    const s = m && read[m.id] ? read[m.id].session : null;
    // a finding shown or hidden by an "off" check: both carry the session's verdicts
    const same = (x) => x.check === r.check && String(x.message).slice(0, 40) === String(r.message).slice(0, 40);
    const f = s && (s.findings.find(same) || (s.calibHidden || []).find(same));
    const raw = r.verdict && (r.verdict.v || r.verdict);
    const v = raw === "ok" || raw === "fp" ? raw : null; // what the panel gives; anything else counts as no verdict
    if (s && f && v) {
      const k = fkey(f);
      if (!s.verdicts[k]) {
        s.verdicts[k] = { v, note: r.note || (r.verdict && r.verdict.note) || "", at: r.at || new Date().toISOString(), imported: true };
        (ops[s.id] = ops[s.id] || []).push([k, s.verdicts[k]]);
        merged++;
      }
    } else if (!s || !f) {
      const row = {
        check: r.check,
        severity: r.severity || "medium",
        message: r.message,
        session: r.session,
        source: r.source || "external",
        verdict: v,
      };
      if (known.has(extKey(row))) {
        dup++;
        continue;
      }
      known.add(extKey(row));
      state.external.push(row);
      ext++;
    }
  }
  for (const id of Object.keys(ops))
    await updateSession(
      id,
      (s) => {
        for (const [k, vd] of ops[id]) if (!s.verdicts[k]) s.verdicts[k] = vd;
      },
      { from: state.loaded[id] ? null : read[id] },
    );
  // the calibration changed for every session: 0.1.100 re-analyzed them all here; now they are marked stale
  state.analysisEpoch = (state.analysisEpoch || 0) + 1;
  await save();
  onGenChanged();
  renderCalib();
  $("#import-status").textContent = T("imp_done", { m: merged, e: ext }) + (dup ? T("imp_dup", { n: dup }) : "");
}

export function download(name, text) {
  window.__slSaveFile(name, text);
}
