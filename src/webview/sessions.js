// @ts-check
/* SessionLens panel — the Sessions tab: navigation, import, profile details. Part of the panel's source (src/webview); `npm run build` bundles it into
   media/app.js. Split out of the single app.js in phase 7 (7B.4) without changing behaviour. */
import { $, T, esc, save, state } from "./common.js";
import { needEngine, profileVerdicts, putNew } from "./store.js";
import { analyze } from "./analysis.js";
import { renderReview } from "./review.js";
import { renderCalib } from "./calibration.js";
import { renderRules } from "./rules.js";
import { renderPrompts } from "./prompts.js";
import { renderSettings } from "./settings.js";

// set in initSessions(), in the order the single app.js ran its statements
export let pendingImport, drop, piDeps;

export function initSessions() {
  pendingImport = null;

  // ---------- nav ----------
  document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => show(/** @type {HTMLElement} */ (b).dataset.view)));

  // ---------- import ----------
  drop = $("#drop");
  ["dragenter", "dragover"].forEach((e) =>
    drop.addEventListener(e, (ev) => {
      ev.preventDefault();
      drop.classList.add("over");
    }),
  );
  ["dragleave", "drop"].forEach((e) =>
    drop.addEventListener(e, (ev) => {
      ev.preventDefault();
      drop.classList.remove("over");
    }),
  );
  drop.addEventListener("drop", (ev) => {
    const f = ev.dataTransfer.files[0];
    if (f) readFile(f, askName);
  });
  // the file is picked in a VS Code dialog (the <input type=file> stays for the button's look only)
  $("#file")
    .closest("label")
    .addEventListener("click", async (e) => {
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

  /* Phase 7 (7A.4): what the selected profile checks, under the Profile list. All facts come from Lens.profileInfo()
     (profile, check registry, engines, specification extractors, Rules overrides, settings); only the wording is here. */
  piDeps = (p) => ({
    checks: LensChecks,
    lint: LensLint,
    spec: LensSpec,
    overrides: state.ruleOverrides,
    settings: state.settings,
    verdicts: profileVerdicts(p),
  });
}

export function show(v) {
  // A dedicated session tab (opened from "Sessions" as its own tab) only ever shows Review.
  if (window.SL_OPEN_SESSION) v = "review";
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", /** @type {HTMLElement} */ (b).dataset.view === v));
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
  // Tell the host which tab this is (only from the sidebar itself, never from a dedicated
  // session tab, which has no tabs of its own) so it can show the native Sessions tree only
  // while the Sessions tab is the one actually in view.
  if (!window.SL_OPEN_SESSION) window.__slSetActiveTab(v);
}

// VS Code build: use the extension's own file dialog instead of the browser-native one, so it can
// start already inside ~/.claude, ~/.codex or ~/.cursor — dot-folders a native "choose file" dialog hides by
// default, with no way for us to override that from a webview's plain <input type="file">. Ask
// which one first: guessing (e.g. "whichever changed more recently") traps the person in one of
// them, since going up from inside a dot-folder to the home folder hides dot-folders again,
// including the others — there'd be no way to browse across.
export async function pickAndImport() {
  const source = await chooseDialog(T("pick_source_msg"), [
    { label: T("pick_source_claude"), value: "claude", primary: true },
    { label: T("pick_source_codex"), value: "codex" },
    { label: T("pick_source_cursor"), value: "cursor" },
    { label: T("pick_source_other"), value: "other" },
  ]);
  if (source === null) return; // the dialog's own Cancel button
  const r = await pickTranscript(source);
  if (r) askName(r.text, r.name.replace(/\.(jsonl|txt|md|log|json)$/i, ""), r.cursorOutputs);
}

/* The host's file dialog for `source` (claude | codex | cursor | other). → { name, text, cursorOutputs } or null when
   the person cancelled. A host that refuses or fails says so in a dialog instead of nothing happening: a host older
   than this page (a .vsix installed without reloading the window) refuses a source it does not know. */
export async function pickTranscript(source) {
  const r = await window.__slPickTranscript({ source: source === "other" ? undefined : source });
  if (r && r.error) {
    await alertDialog(T("pick_failed", { e: r.error }));
    return null;
  }
  return r && typeof r.text === "string" ? r : null;
}

/* A file name like 53c39a7e-61e5-… says nothing three days later, so the import stops to ask for a name.
     The suggestion is the task id found in the session when there is one, otherwise the file name. */
// cursorOutputs: the command output the host found in Cursor's database for a Cursor transcript (0.1.121)
export function askName(text, fallback, cursorOutputs) {
  const guess = Lens.guessTask(text.slice(0, 200000));
  const uuidish = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(fallback) || /^[0-9a-f]{12,}$/i.test(fallback);
  pendingImport = { text, fallback, cursorOutputs };
  $("#name-input").value = guess || (uuidish ? "" : fallback);
  $("#name-hint").textContent = T("name_from_file", { f: fallback.slice(0, 40) });
  $("#name-row").hidden = false;
  $("#name-input").focus();
  $("#name-input").select();
}

export function confirmName() {
  if (!pendingImport) return;
  const { text, fallback, cursorOutputs } = pendingImport;
  pendingImport = null;
  $("#name-row").hidden = true;
  importText(text, $("#name-input").value.trim() || fallback, cursorOutputs);
}

export function readFile(f, cb) {
  const r = new FileReader();
  r.onload = () => cb(r.result, f.name.replace(/\.(jsonl|txt|md|log|json)$/i, ""));
  r.readAsText(f);
}

/* What a session keeps of a Cursor chat's command output: the end of each (a runner's summary is there), so the
   stored session does not grow by the full output of every command. */
export function keptOutputs(outputs) {
  if (!Array.isArray(outputs) || !outputs.length) return undefined;
  return outputs.map((o) => ({ command: o.command, output: String(o.output || "").slice(-20000), exitCode: o.exitCode }));
}

export async function importText(text, name, cursorOutputs) {
  const cfg = Lens.profile(state.settings.profile);
  const res = Lens.importAny(text, cfg, { cursorOutputs });
  const convs = Array.isArray(res) && res.length && res[0].events ? res : [{ name, events: res }];
  if (!convs.length || !convs[0].events.length) {
    await alertDialog(T("no_events"));
    return;
  }
  if (convs.length === 1 && Lens.unreadToolCalls(text, convs[0].events) && !(await confirmDialog(T("unread_tools")))) return;
  if (convs.length > 1) {
    const q = (await promptDialog(T("many_convs", { n: convs.length }))) || "";
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
      created: new Date().toISOString(),
      events: c.events,
      findings: [],
      verdicts: {},
      spec: "",
      dropped: [],
      source_text: text.length < 400000 ? text : "",
      // kept with the text, so Back to regex parsing and Import again parse it the same way
      source_outputs: text.length < 400000 ? keptOutputs(cursorOutputs) : undefined,
      seg: null,
      importGen: Lens.IMPORT_GEN,
    };
    analyze(s, "import");
    await putNew(s);
    last = id;
  }
  state.current = last;
  // Review only ever appears as its own editor tab now — the sidebar has no Review tab of
  // its own. With one imported session, open its tab directly (as clicking it would); with
  // several, just refresh the sessions list so the user can pick which to open.
  if (convs.length > 1) {
    show("sessions");
  } else {
    window.__slOpenSession(last);
    show("sessions");
  }
}

/* "Try a demo session": the made-up session in media/demo-session.js (LensDemo), imported and analyzed like a file the
   person picks, with its own profile and specification. It has a fixed id, so a second click opens the one already
   there instead of adding a copy; deleted, it can be tried again. Its verdicts do not count for calibration
   (calibStatsBySource, profileVerdicts in store.js): they are about a made-up session, not the person's own. */
export async function openDemo() {
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
      created: new Date().toISOString(),
      events: Lens.importAny(D.TRANSCRIPT, cfg),
      findings: [],
      verdicts: {},
      spec: D.SPEC,
      dropped: [],
      source_text: D.TRANSCRIPT,
      seg: null,
      importGen: Lens.IMPORT_GEN,
    };
    analyze(s, "import");
    await putNew(s);
  }
  state.current = D.ID;
  window.__slOpenSession(D.ID);
  show("sessions");
}

export function profileSummary(info) {
  const runners = info.runners.map((r) => r.trim());
  const spec = info.spec && info.spec.read.length ? T("pi_s_spec") : T("pi_s_nospec");
  return [
    T("profile_desc_" + info.profile),
    runners.slice(0, 4).join(", ") + (runners.length > 4 ? ", …" : ""),
    T("pi_s_checks", { n: info.count }),
    info.engine.kind === "none" ? T("pi_s_noengine") : T("pi_eng_" + info.engine.kind) + (info.engine.state === "off" ? " (" + T("pi_off") + ")" : ""),
    spec,
    info.calibration.validated ? T("pi_validated") : T("pi_unvalidated_short"),
  ]
    .filter(Boolean)
    .join(" · ");
}

export function renderProfileInfo() {
  const el = $("#profile-info");
  if (!el) return;
  const p = $("#profile").value || state.settings.profile || Lens.PROFILES[0];
  const info = Lens.profileInfo(p, piDeps(p));
  const wasOpen = !!(el.querySelector("details") || {}).open;
  const li = (label, value) => `<li><span class="pi-k">${esc(label)}</span> ${value}</li>`;
  const code = (x) => `<code>${esc(x)}</code>`;
  const files = info.codeExt.length ? info.codeExt.map(code).join(" ") : esc(T("pi_any_file"));
  const eng =
    info.engine.kind === "none"
      ? esc(T("pi_eng_none"))
      : esc(T("pi_eng_" + info.engine.kind)) + " — " + esc(info.engine.state === "off" ? T("pi_off") : T("pi_on"));
  const sp = info.spec,
    spec = !sp
      ? ""
      : !sp.read.length
        ? esc(T("pi_spec_none"))
        : !sp.notRead.length && !sp.anyFile
          ? esc(T("pi_spec_all"))
          : sp.read.map(code).join(" ") + (sp.notRead.length && !sp.anyFile ? " · " + esc(T("pi_spec_not", { list: sp.notRead.join(" ") })) : "");
  const cal = info.calibration.validated
    ? esc(T(info.calibration.builtIn ? "pi_validated_builtin" : "pi_validated"))
    : esc(T("pi_unvalidated", { n: info.calibration.verdicts, min: info.calibration.min }));
  const groups = info.groups
    .map(
      (g) =>
        `<div class="pi-g"><b>${esc(T("g_" + g.group))}</b> <span class="muted">(${esc(g.checks.length)})</span><div>${g.checks
          .map(
            (c) =>
              `<code class="pi-c${c.off ? " off" : ""}" title="${esc(LensRules.ruleText(c.name, state.ruleOverrides))}">${esc(c.name)}</code>${c.off ? ` <span class="muted">${esc(T("pi_off_rules"))}</span>` : ""}${c.engineOnly ? ` <span class="muted">${esc(T("pi_engine_only"))}</span>` : ""}`,
          )
          .join(" ")}</div></div>`,
    )
    .join("");
  el.innerHTML = `<div class="pi-sum">${esc(profileSummary(info))}</div><details${wasOpen ? " open" : ""}><summary>${esc(T("pi_details"))}</summary><ul class="pi-l">${[
    li(T("pi_files"), files),
    li(T("pi_runners"), info.runners.map((r) => code(r.trim())).join(" ")),
    li(T("pi_engine"), eng),
    li(T("pi_spec"), spec),
    li(T("pi_asserts"), esc(T(info.asserts ? "pi_yes" : "pi_no"))),
    li(T("pi_calib"), cal),
  ].join("")}</ul><div class="muted">${esc(T("pi_gherkin"))}</div>${groups}</details>`;
}

// ---------- list ----------
export function renderList() {
  const sel = $("#profile");
  sel.innerHTML = Lens.PROFILES.map(
    (p) =>
      `<option value="${esc(p)}" ${p === state.settings.profile ? "selected" : ""}>${esc(p)} — ${esc(T("profile_desc_" + p))}${!Lens.isValidated(p, profileVerdicts(p)) ? T("unverified_opt") : ""}</option>`,
  ).join("");
  renderProfileInfo();
  $("#demo-go").hidden = state.settings.hideDemo === true; // ⚙ Settings → Hide the "Try a demo session" button
  $("#session-list").innerHTML = ""; // sessions are listed and opened in the native Sessions tree (extension.js)
}
