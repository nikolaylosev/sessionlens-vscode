// @ts-check
/* SessionLens panel — a session's tab: review, specification, model segmentation. Part of the panel's source (src/webview); `npm run build` bundles it into
   media/app.js. Split out of the single app.js in phase 7 (7B.4) without changing behaviour. */
import { $, LABEL, SEV, T, VCOL, VLABEL, esc, fkey, srcLabel, state } from "./common.js";
import { curS, needEngine, profileVerdicts, updateSession } from "./store.js";
import { analyze, analyzeNow } from "./analysis.js";
import { keptOutputs, pickTranscript, piDeps, profileSummary, readFile } from "./sessions.js";
import { download } from "./calibration.js";

export function initReview() {
  $("#raw-copy").addEventListener("click", async () => {
    await navigator.clipboard.writeText($("#raw").value);
    $("#raw-copy").textContent = T("copied");
    setTimeout(() => ($("#raw-copy").textContent = T("copy")), 1200);
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

  // ---- model segmentation (optional; regex parsing is the default and the fallback) ----
  $("#seg-run").addEventListener("click", async () => {
    const sid = state.current,
      s = curS(),
      btn = $("#seg-run"),
      st = $("#seg-status");
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
        at: new Date().toISOString(),
        n: r.segments.length,
        coverage: r.coverage,
        chunks: r.chunks || null,
        spec_suggested: r.spec_suggested,
        raw: r.request + "\n\n" + T("resp") + "\n" + r.raw,
      };
      const events = s.events; // segment() rewrote them in place
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
      const err = e.message,
        raw = e.raw || null;
      await updateSession(sid, (x) => {
        x.events = before;
        x.seg = null; // regex parsing stands, untouched
        x.seg_error = err;
        x.seg_raw = raw; // but the reason and the exchange are kept
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
    $("#spec-d").open = true; // show what was lifted, so it can be corrected by hand
  });
  $("#seg-reset").addEventListener("click", async () => {
    const s = curS();
    if (!s.source_text) return;
    await needEngine(s.profile);
    await updateSession(state.current, (x) => {
      const cfg = Lens.profile(x.profile);
      // the session's own conversation of the file, not the first one (fixed in 0.1.115)
      x.events = Lens.pickConversation(x.events, Lens.importAny(x.source_text, cfg, { cursorOutputs: x.source_outputs })) || x.events;
      x.seg = null;
      x.importGen = Lens.IMPORT_GEN;
      analyze(x);
    });
    renderReview();
    $("#seg-status").textContent = T("seg_none");
  });
  $("#reimport-go").addEventListener("click", () => reimport());

  $("#ai-run").addEventListener("click", async () => {
    const sid = state.current;
    const s = curS();
    const spec = $("#spec").value;
    s.spec = spec;
    const btn = $("#ai-run"),
      st = $("#ai-status");
    btn.disabled = true;
    st.textContent = state.settings.verify ? T("ai_wait_verify") : T("ai_wait");
    try {
      const r = await LensAI.review(s, state.settings);
      await needEngine(s.profile);
      // Saved by id through updateSession: a refresh from another tab or the sidebar may have replaced the loaded copy
      // while this call was in flight, and a conflicting save is read again and this result applied to the fresh copy.
      await updateSession(sid, (cur) => {
        cur.spec = spec;
        cur.findings = cur.findings.filter((f) => f.source !== "ai");
        analyze(cur);
        cur.findings = Lens.sortFindings([...cur.findings, ...r.findings]);
        cur.dropped = r.dropped || [];
        cur.ai_at = new Date().toISOString();
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
          err: r.verifyError ? " · " + r.verifyError : "",
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
  // The review call can succeed while the (separately routed, possibly different) verification model
  // fails — e.g. rate-limited or briefly overloaded. Retry just that step, on the findings already here,
  // instead of re-running the whole (often slower and costlier) review.
  $("#ai-verify-again").addEventListener("click", async () => {
    const sid = state.current;
    const btn = $("#ai-verify-again"),
      st = $("#ai-status");
    const aiFindings = state.loaded[sid].findings.filter((f) => f.source === "ai");
    btn.disabled = true;
    st.textContent = T("ai_reverify_wait");
    try {
      const v = await LensAI.verify(state.loaded[sid], aiFindings, state.settings);
      // saved by id, same reason as in #ai-run above
      await updateSession(sid, (cur) => {
        cur.findings = Lens.sortFindings([...cur.findings.filter((f) => f.source !== "ai"), ...v.kept]);
        cur.dropped = v.dropped || [];
        cur.ai_verify_error = v.error || null;
      });
      if (state.current === sid) {
        renderReview();
        st.textContent =
          T("ai_reverify_status", { n: v.kept.length, dropped: v.dropped && v.dropped.length ? T("ai_dropped", { n: v.dropped.length }) : "" }) +
          (v.error ? " · " + v.error : "");
      }
    } catch (e) {
      if (state.current === sid) st.textContent = T("error") + e.message;
    }
    if (state.current === sid) btn.disabled = false;
  });
}

/* "Import again" (0.1.114): a session imported before 0.1.113 lacks what test_deleted and config_weakened read
   (Lens.needsReimport). Its transcript is parsed again into the same session, which keeps its id, name, specification
   and verdicts: from the text kept at import, or from the file picked again. A file that does not look like this
   session, or verdicts that would no longer match a finding, are asked about first. */
export async function reimport() {
  const sid = state.current,
    s = curS();
  if (!s) return;
  let text = s.source_text,
    cursorOutputs = s.source_outputs;
  if (!text) {
    const source = await chooseDialog(T("reimport_pick"), [
      { label: T("pick_source_claude"), value: "claude", primary: true },
      { label: T("pick_source_codex"), value: "codex" },
      { label: T("pick_source_cursor"), value: "cursor" },
      { label: T("pick_source_other"), value: "other" },
    ]);
    if (source === null) return;
    const r = await pickTranscript(source);
    if (!r) return;
    text = r.text;
    cursorOutputs = r.cursorOutputs;
  }
  const cfg = Lens.profile(s.profile);
  // a file with several conversations: the one closest to this session
  const events = Lens.pickConversation(s.events, Lens.importAny(text, cfg, { cursorOutputs }));
  if (!events) {
    await alertDialog(T("no_events"));
    return;
  }
  const match = Lens.transcriptMatch(s.events, events);
  if (match < 0.8 && !(await confirmDialog(T("reimport_other", { p: Math.round(match * 100) })))) return;
  await needEngine(s.profile);
  // the verdicts that match a finding now and would not after the new import
  const keys = (x) => new Set([...(x.findings || []), ...(x.calibHidden || [])].map(fkey).filter((k) => s.verdicts[k]));
  const gen = state.gens[sid];
  const trial = Object.assign({}, s, { events, seg: null, findings: s.findings.filter((f) => f.source === "ai") });
  analyzeNow(trial);
  state.gens[sid] = gen;
  const after = keys(trial),
    lost = [...keys(s)].filter((k) => !after.has(k)).length;
  if (lost && !(await confirmDialog(T("reimport_lost", { n: lost })))) return;
  await updateSession(sid, (x) => {
    x.events = events;
    x.seg = null;
    x.seg_error = null;
    x.seg_raw = null;
    if (!x.source_text && text.length < 400000) {
      x.source_text = text;
      x.source_outputs = keptOutputs(cursorOutputs);
    }
    x.importGen = Lens.IMPORT_GEN;
    analyze(x, "import");
  });
  if (state.current === sid) renderReview();
}

// ---------- review ----------
export function renderReview() {
  const s = curS();
  $("#review-empty").hidden = !!s;
  $("#review").hidden = !s;
  if (!s) return;
  const v = Lens.verdict(s.findings),
    m = s.metrics || Lens.metrics(s.events);
  const runs = s.events.filter((e) => e.kind === "run_tests" && e.tests),
    last = runs[runs.length - 1];
  $("#hdr").style.setProperty("--v", VCOL[v]);
  const unv = !Lens.isValidated(s.profile, profileVerdicts(s.profile));
  $("#hdr").innerHTML =
    `<h1>${esc(Lens.displayName(s))}<span class="badge">${esc(VLABEL[v])}</span></h1><div class="m">${esc(Lens.otherName(s))} · <span class="pi-hdr" title="${esc(profileSummary(Lens.profileInfo(s.profile, piDeps(s.profile))))}">${esc(s.profile)}</span> · ${esc(T("events", { n: s.events.length }))} · ${T("hdr_result")}: ${last ? esc(T("passed_failed", { p: last.tests.passed, f: last.tests.failed })) : T("no_runs")}</div>${unv ? `<span class="warn">${esc(T("unverified", { p: s.profile, n: Lens.UNVERIFIED_MIN }))}</span>` : ""}`;
  $("#metrics").innerHTML = [
    `${T("m_reads")} <b>${esc(m.reads)}</b>`,
    `${T("m_edits")} <b>${esc(m.edits)}</b>`,
    `Read:Edit <b>${esc(m.readEdit ?? "—")}</b>${m.readEdit !== null && m.readEdit < 1 ? " ⚠" : ""}`,
    `${T("m_runs")} <b>${esc(m.runs)}</b>`,
    `${T("m_to_green")} <b>${esc(m.editsToGreen ?? "—")}</b>`,
  ]
    .map((x) => `<span>${x}</span>`)
    .join("");
  $("#reimport").hidden = !Lens.needsReimport(s);
  const toolCode = s.events.some((e) => e.file && e.new_content);
  $("#seg-hint").textContent = !s.seg && !toolCode && s.events.some((e) => e.kind === "message") ? T("seg_hint_chat") : "";
  $("#seg-status").textContent = s.seg ? segStatus(s) : s.seg_error ? T("seg_fallback", { msg: s.seg_error }) : T("seg_none");
  $("#seg-status").className = s.seg_error ? "err" : "muted";
  $("#seg-extra").hidden = !s.seg;
  $("#seg-spec").hidden = !(s.seg && s.seg.spec_suggested);
  $("#seg-reset").hidden = !s.source_text;
  $("#spec").value = s.spec || "";
  $("#spec-count").textContent =
    s.specParsed && s.specParsed.n
      ? T("spec_count", { n: s.specParsed.n, oos: s.specParsed.oos ? T("spec_oos", { n: s.specParsed.oos }) : "" }) +
        (s.specParsed.hasIds ? "" : T("spec_auto"))
      : (s.spec || "").trim()
        ? T("spec_unparsed")
        : T("spec_none");
  $("#spec-d").open = !s.spec;
  renderCoverage(s);
  $("#ai-status").textContent = s.ai_at
    ? T("ai_last", { at: s.ai_at.slice(0, 16).replace("T", " ") }) +
      (s.ai_truncated ? T("ai_truncated") : "") +
      (s.ai_verify_error ? " · " + s.ai_verify_error : "")
    : "";
  $("#ai-verify-again").hidden = !s.ai_verify_error;
  $("#lint-note").textContent = s.lintNote || "";
  $("#mark-reviewed").textContent = s.reviewed ? T("reviewed_on") : T("mark_reviewed");
  $("#mark-reviewed").classList.toggle("on", !!s.reviewed);
  $("#suppressed").textContent =
    s.suppressed && s.suppressed.length
      ? T("suppressed", { list: s.suppressed.map((x) => `${x.check} (${srcLabel(x.source)}, ${Math.round(x.precision * 100)}% / ${x.n})`).join(", ") })
      : "";
  const F = state.filter;
  const srcOf = (f) => (f.source === "ai" ? "ai" : f.source === "spec" ? "spec" : f.source === "lint" ? "lint" : "formal");
  // sources toggle independently, like severities: turning one on must not hide the rest
  const visible = s.findings.filter((f) => F.src[srcOf(f)] !== false && F.sev[f.severity] && (!F.undecided || !s.verdicts[fkey(f)]));
  $("#f-count").textContent = visible.length === s.findings.length ? `(${s.findings.length})` : T("f_of", { v: visible.length, n: s.findings.length });
  const cnt = { all: s.findings.length };
  for (const k of ["formal", "lint", "spec", "ai"]) cnt[k] = s.findings.filter((f) => srcOf(f) === k).length;
  const present = ["formal", "lint", "spec", "ai"].filter((k) => cnt[k]);
  const allOn = present.every((k) => F.src[k] !== false);
  $("#filter").innerHTML =
    `<button class="chip ${allOn ? "on" : ""}" data-src="all">${T("chip_all")} ${esc(cnt.all)}</button>` +
    present
      .map(
        (k) =>
          `<button class="chip ${F.src[k] !== false ? "on" : ""}" data-src="${esc(k)}">${esc({ formal: T("chip_formal"), lint: T("chip_lint"), spec: T("chip_spec"), ai: T("chip_ai") }[k] || k)} ${esc(cnt[k])}</button>`,
      )
      .join("") +
    `<span class="sep"></span>` +
    LensChecks.SEVERITIES.map((sv) => `<button class="chip sev-${esc(sv)} ${F.sev[sv] ? "on" : ""}" data-sev="${esc(sv)}">${esc(SEV[sv])}</button>`).join("") +
    `<button class="chip ${F.undecided ? "on" : ""}" data-und="1">${T("chip_undecided")}</button>`;
  $("#filter")
    .querySelectorAll("[data-src]")
    .forEach((b) =>
      b.addEventListener("click", () => {
        const k = b.dataset.src;
        if (k === "all")
          present.forEach((x) => (F.src[x] = true)); // "all" is a reset, never a way to hide everything
        else {
          const toggled = F.src[k] === false; // false → on, otherwise off
          const anyLeft = present.some((x) => (x === k ? toggled : F.src[x] !== false));
          if (anyLeft) F.src[k] = toggled;
          else present.forEach((x) => (F.src[x] = true)); // never leave an empty list: reset instead
        }
        renderReview();
      }),
    );
  $("#filter")
    .querySelectorAll("[data-sev]")
    .forEach((b) =>
      b.addEventListener("click", () => {
        F.sev[b.dataset.sev] = !F.sev[b.dataset.sev];
        renderReview();
      }),
    );
  $("#filter")
    .querySelector("[data-und]")
    .addEventListener("click", () => {
      F.undecided = !F.undecided;
      renderReview();
    });
  // 0.1.117: a lint finding is tagged with the engine that ran in this session's profile; the filter and the
  // Calibration table say "lint", since there the sessions of all profiles meet
  const engine = { eslint: "eslint", "eslint-cypress": "eslint", "eslint-detox": "eslint", "tree-sitter": "tree-sitter", "robot-parser": "robot" }[
    Lens.profileInfo(s.profile, piDeps(s.profile)).engine.kind
  ];
  const tagLabel = (src) => (src === "lint" && engine ? engine : srcLabel(src));
  const fl = $("#findings");
  fl.innerHTML = visible.length
    ? visible
        .map((f) => {
          const k = fkey(f),
            vd = s.verdicts[k] || {};
          const ai = f.source === "ai",
            sp = f.source === "spec",
            src = f.source || "formal";
          return `<div class="f ${esc(f.severity)} ${vd.v ? "done" : ""} ${ai ? "ai" : ""} ${sp ? "spec" : ""}" data-k="${esc(k)}"><div class="sev ${esc(f.severity)}">${esc(SEV[f.severity] || f.severity)} <span class="srctag ${esc(src)}">${esc(tagLabel(src))}</span>${f.demoted ? ` <span class="demoted">${T("demoted")}</span>` : ""}</div><div class="msg">${esc(f.message)}</div>${f.evidence ? `<div class="chk">«${esc(f.evidence)}»</div>` : ""}${f.code ? `<details class="snip-d"><summary>${T("code_toggle")}</summary><pre class="snip">${esc(f.code)}</pre></details>` : ""}<div class="chk">${ai ? esc(LABEL[f.check] || f.check) : esc(f.check)}${f.seq >= 0 ? ` · <a href="#e${esc(f.seq)}">seq ${esc(f.seq)}</a>` : ""}</div>
        <div class="vb"><button class="btn tiny ghost v-ok ${vd.v === "ok" ? "on" : ""}">${T("btn_ok")}</button><button class="btn tiny ghost v-fp ${vd.v === "fp" ? "on fp" : ""}">${T("btn_fp")}</button><input class="note" placeholder="${T("ph_note")}" value="${esc(vd.note || "")}"></div></div>`;
        })
        .join("")
    : `<div class="empty">${s.findings.length ? T("empty_filter") : T("empty_findings")}</div>`;
  fl.querySelectorAll(".f").forEach((d) => {
    const k = d.dataset.k;
    d.querySelector(".v-ok").addEventListener("click", () => setVerdict(k, "ok", d.querySelector(".note").value));
    d.querySelector(".v-fp").addEventListener("click", () => setVerdict(k, "fp", d.querySelector(".note").value));
    d.querySelector(".note").addEventListener("change", (e) => {
      if (s.verdicts[k]) setVerdict(k, s.verdicts[k].v, e.target.value);
    });
  });
  fl.querySelectorAll("a[href^='#e']").forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const t = document.getElementById(a.getAttribute("href").slice(1));
      if (t) {
        t.closest("details").open = true;
        t.scrollIntoView({ block: "center" });
        t.classList.add("flag");
      }
    }),
  );
  renderRaw(s);
  const dr = s.dropped || [];
  const dups = dr.filter((f) => f.duplicate).length;
  $("#dropped-d").hidden = !dr.length;
  $("#dropped-count").textContent = dups ? T("dropped_count_dup", { n: dr.length, d: dups }) : `(${dr.length})`;
  $("#dropped").innerHTML =
    `<div class="dropped">${dr.map((f, i) => `<p data-i="${esc(i)}"><b>${esc(LABEL[f.check] || f.check)}</b>: ${esc(f.message)} — <i>${esc(f.why || T("not_proven"))}</i>${f.model_why ? `<br><span class="muted">${T("model_said")}: ${esc(f.model_why)}</span>` : ""} <button class="btn tiny ghost drop-restore">${T("dropped_restore")}</button></p>`).join("")}</div>`;
  $("#dropped")
    .querySelectorAll(".drop-restore")
    .forEach((b) =>
      b.addEventListener("click", async () => {
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
      }),
    );
  const flagged = new Set(s.findings.map((f) => f.seq));
  const ph = {};
  Lens.phases(s.events).forEach((p) => (ph[p.start] = p.name));
  const names = { plan: T("ph_plan"), code: T("ph_code"), run: T("ph_run") };
  $("#timeline").innerHTML = s.events
    .map((e) => {
      const fail = e.tests && (e.tests.failed || e.tests.errors);
      let extra = e.tests ? ` — ${T("passed_failed", { p: e.tests.passed, f: e.tests.failed })}` : "";
      if (e.assert_delta && (e.assert_delta.weakened.length || e.assert_delta.removed.length)) extra += " — ⚠ " + T("asserts").toLowerCase();
      return (
        (ph[e.seq] ? `<li class="ph">${esc(names[ph[e.seq]])}</li>` : "") +
        `<li id="e${esc(e.seq)}" class="${esc(e.kind)}${fail ? " fail" : ""}${flagged.has(e.seq) ? " flag" : ""}"><span class="seq">${esc(e.seq)}</span><span class="k">${esc(e.kind)}</span> ${esc(e.file || e.cmd || "")}${esc(extra)}${["message", "user"].includes(e.kind) ? `<span class="t">${esc(String(e.text || "").slice(0, 1000))}</span>` : ""}</li>`
      );
    })
    .join("");
  const deltas = s.events.filter((e) => e.assert_delta);
  $("#asserts").innerHTML = deltas.length
    ? `<table><tr>${T("asserts_hdr")
        .map((h) => `<th>${esc(h)}</th>`)
        .join("")}</tr>${deltas
        .map((e) => {
          const d = e.assert_delta;
          const w = d.weakened
            .map((x) => `${x.test}: ${x.reason}`)
            .concat(d.removed.map((r) => `${r.test}: ${r.before}→${r.after}`))
            .join("; ");
          return `<tr><td>${esc(e.seq)}</td><td>${esc(e.file)}</td><td>${esc(d.old)}</td><td>${esc(d.new)}</td><td>${d.identical ? `<span class="muted">${T("identical")}</span>` : esc(w) || `<span class="muted">${T("no_weak")}</span>`}</td></tr>`;
        })
        .join("")}</table>`
    : `<p class="muted">${T("no_compare", { tail: s.events.filter((e) => e.new_content).length ? T("code_once") : T("no_code") })}</p>`;
  const msgs = s.events.filter((e) => ["message", "user"].includes(e.kind));
  $("#transcript").innerHTML = msgs.length
    ? msgs
        .map((x) => `<p class="${x.kind === "user" ? "u" : ""}"><b>${x.kind === "user" ? T("user") : T("agent")}</b> (seq ${esc(x.seq)})<br>${esc(x.text)}</p>`)
        .join("")
    : `<p class="muted">${T("no_msgs")}</p>`;
}

export function renderRaw(s) {
  const d = $("#raw-d");
  if (!state.settings.debugModel) {
    d.hidden = true;
    return;
  }
  const lintDump =
    (s.lintLog && s.lintLog.length) || (s.lintWhy && s.lintWhy.length)
      ? "=== ESLint ===\n" + (s.lintLog || []).join("\n") + ((s.lintWhy || []).length ? "\n-- errors --\n" + s.lintWhy.join("\n") : "")
      : null;
  const segDump = s.seg_raw ? `=== ${T("seg_failed_hdr")}: ${s.seg_error || ""} ===\n${s.seg_raw}` : s.seg && s.seg.raw;
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

export function renderCoverage(s) {
  const c = s.coverage,
    el = $("#coverage");
  if (!c) {
    el.innerHTML = s.spec ? `<p class="muted">${T((s.events || []).some((e) => e.new_content) ? "no_readable_tests" : "no_code")}</p>` : "";
    return;
  }
  const spec = LensSpec.parse(s.spec);
  el.innerHTML = `<table class="cov"><tr><th>ID</th><th>${T("cov_requirement")}</th><th>${T("cov_tests")}</th></tr>${spec.requirements
    .map((r) => {
      const t = c.covered[r.id] || [];
      return `<tr><td>${esc(r.id)}</td><td>${esc(r.text.slice(0, 70))}</td><td class="${t.length ? "yes" : "no"}">${t.length ? esc(t.join(", ")) : T("md_none")}</td></tr>`;
    })
    .join("")}</table>${c.unlinked.length ? `<p class="muted">${T("cov_unlinked")}: ${esc(c.unlinked.map((t) => t.name).join(", "))}</p>` : ""}`;
}

export async function setVerdict(k, v, note) {
  const vd = { v, note: note || "", at: new Date().toISOString() };
  await updateSession(state.current, (s) => {
    s.verdicts[k] = vd;
  });
  renderReview();
}

export function segStatus(s) {
  const g = s.seg,
    spec = g.spec_suggested ? T("seg_spec") : "";
  return g.chunks
    ? T("seg_status_chunks", { n: g.n, c: Math.round(g.coverage * 100), ok: g.chunks.ok, total: g.chunks.ok + g.chunks.failed, spec })
    : T("seg_status", { n: g.n, c: Math.round(g.coverage * 100), spec });
}
