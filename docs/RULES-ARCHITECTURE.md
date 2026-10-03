# SessionLens — architecture of the Rules system

The overview of the whole extension, with diagrams, is [`ARCHITECTURE.md`](ARCHITECTURE.md).

An internal document for code review before publishing on GitHub. It describes
**everything** related to "rules" (checks/rules): how a finding is born, how it
gets its text, severity and on/off state, how this is edited in the UI, stored,
exported, and how it turns into `CLAUDE.md`/`AGENTS.md`. It was written from the
actual state of the code at v0.1.97 (after Phase 4) and updated for v0.1.98
(Phase 1 of the Rules refactoring: the `media/checks.js` registry), not from
memory — all numbers and lists in this file were obtained by running scripts
against the real `media/*.js`, not by guessing.

Format: first the concepts and contracts, then a line-by-line walk through each
file, then an end-to-end example of one finding from birth to rendering, then a
separate section "what the reviewer should look at" — precisely because of the
inconsistencies and implicit contracts that the tests do not catch.

---

## 1. The central idea: the "check name" is the one key of the system, the source of truth is `checks.js`

Everything in Rules revolves around one string — the **check name**, for example
`"sleep_or_skip_added"` or `"unannotated_test_method"`.

Since v0.1.98 the check name has a **single registry** — `media/checks.js`:

```js
CHECKS = {
  sleep_or_skip_added: { group: "code", severity: "high", ruleKey: "r_sleep",
                         good: "await expect(locator).toBeVisible() — …", sources: ["regex", "lint"] },
  tests_never_run:     { group: "process", severity: "high", ruleKey: "r_never_run", good: "…",
                         sources: ["regex"], sortPriority: -1 },
  …                    // 61 entries (v0.1.113)
};
SEVERITIES   = ["high", "medium", "low"];
GROUPS_ORDER = ["method", "process", "code", "api", "mobile", "gherkin", "robot", "spec", "ai"];
```

**Derived** from the registry: `GROUPS`, `DEFAULT_SEVERITY` and `GOOD` in `rules.js`,
`RULE_KEYS` in `lens.js`, the list and order of groups in the Rules panel in `app.js`,
the sort priority (`sortPriority`), whether calibration may touch the check (`calibrate: false` keeps it out,
§5.2; since v0.1.116 only `hardcoded_secret`) and every check of an allowed severity
(`SEVERITIES`). The order of keys in `CHECKS` = the order of rows in the Rules panel.

The detectors themselves still write the name as a string literal — this is unavoidable:

1. `lens.js` — `F(check, …)` in the regex checks and in `Lens.gherkinChecks()`.
2. `lint.js` — every `*_RULE_MAP` (all exported at once as
   `LensLint.RULE_MAPS`): engine rule id → `[check, severity]`.
3. `spec.js` — 4 checks in `F(...)`.
4. `ai.js` — `AI_CATEGORIES` (7 categories, `"ai_" + c`) and `ai_other` for a
   model answer outside the categories.
5. `i18n.js` — the rule text by `ruleKey` and the group label `g_<group>`.

**The consistency of these places with the registry is checked by
`test/rules-consistency.test.js`** (`npm test`). It fails if a detector emits a
name that is not in `CHECKS`; if an entry in `CHECKS` is emitted by no detector
or its `sources` do not match the actual ones; if an entry has no `ruleKey` in
any language of `I18N.langs`, an unknown group or severity; if `F(...)` is called
with a computed name.

**The only exception by design** — synthetic names that `lint.js` `run()` makes
up for a rule id without an entry in a `*_RULE_MAP`:
`"lint_" + ruleId.split("/").pop()` (for example `lint_valid-title`). They are
not in the registry; they fall into fallbacks (group `code`, severity `medium`,
empty rule text) without a warning. A name written into a `*_RULE_MAP`
explicitly is always in the registry, even with the `lint_` prefix (`lint_valid_title`).
For any other unknown name `Lens.RULES` and `LensRules.ruleText()`
write `console.warn` once per name.

**UI language.** `i18n.js` currently contains only the `en` dictionary, and
`boot()` in `app.js` calls `I18N.set("en")`. The consistency test iterates over
`I18N.langs`, so if another language is added, missing keys will be caught
automatically.

**Counts.** A word after a number is written `{n} {n|session|sessions}`: `I18N.t()`
picks the first form when `vars.n` is 1 and the second otherwise, before `{n}` is
filled in (0.1.111). `test/i18n-plural.test.js` fails on a plain `{n} sessions`.
Finding messages are not changed this way: a verdict's key includes the message.

## 2. Anatomy of a finding

A finding is a flat object. The general shape (the union of all sources):

```js
{
  check: "sleep_or_skip_added",   // key #1, see §1
  severity: "high",                // "high" | "medium" | "low" — the only three values, not an enum anywhere
  seq: 12,                         // index of the transcript event the finding refers to
  message: "e2e/login.js: fixed delay (sleep) in a test",
  source: "formal",                 // "formal" (a regex check, since v0.1.112) | "lint" | "spec" | "ai" | "gherkin" (since v0.1.109)
                                   // A session saved before 0.1.112 has regex findings with no source until it is
                                   // analyzed again: read a missing source as "formal", as the panel and exports do.
  demoted: false,                  // true if calibration lowered the severity (see §5.3) — SURVIVES apply()
  rule: "detox/no-hardcoded-wait", // only for source==="lint": the engine's original rule id
  line: 7,                          // only for source==="lint": the line number
  code: "  5  ...\n  6  ▸...\n  7  ...", // only for regex checks with context (not all of them)
  model: "anthropic/claude-sonnet-5", // only for source==="ai", since v0.1.115: the review's provider/model
  verifier: "google/gemini-3.1-flash-lite", // only for source==="ai" after a verification call (kept or dropped)
}
```

None of these fields is declared as a schema/interface anywhere in the code —
it is duck typing spread over the consumers (`app.js`'s rendering of the
finding card, `sortFindings`, `LensRules.apply`).

---

## 3. Five independent sources of findings

`app.js`'s `analyze(s)` (the only place where everything comes together) collects
findings from **five** independent tracks and joins them into one array BEFORE
calling `LensRules.apply()`:

```js
function analyze(s) {
  const cfg = Lens.profile(s.profile);
  const formal  = Lens.runChecks(s.events, cfg);               // 1. regex checks, depend on the profile
  const gherkin = Lens.gherkinChecks(s.events);                 // 2. .feature files, do NOT depend on the profile
  const spec    = LensSpec.parse(s.spec || "");
  const sc      = LensSpec.checks(spec, s.events, cfg.language);// 3. specification ↔ tests
  const ai      = (s.findings || []).filter(f => f.source === "ai"); // 4. model review (computed earlier)
  let base = formal;
  if (state.settings.lint !== false) {
    const lr = LensLint.run(s, cfg, state.settings);            // 5. ESLint/tree-sitter/custom-parser engines
    if (lr.ran) base = LensLint.merge(formal, lr.findings, cfg.language); // only what that engine finds itself (§6.3)
  }
  const cal = Lens.calibrate([...base, ...gherkin, ...sc.findings, ...ai],     // calibration per check and source
                             calibStatsBySource(), state.ruleOverrides);       // (since v0.1.112, §5.2)
  s.findings = Lens.sortFindings(LensRules.apply(cal.findings, state.ruleOverrides));
  s.suppressed = cal.suppressed; s.calibHidden = cal.hidden;
}
```

The key properties of this function that matter for review:

- **`Lens.calibrate()` runs once, after the merge and before `apply()`** (since
  v0.1.112): a regex finding an engine supersedes is gone before calibration sees it,
  so an engine check that calibration switched off never brings the regex one back.
- **`LensRules.apply()` is called EXACTLY ONCE**, at the very end, on the already
  merged array. It does not and must not know where a finding came from —
  overrides are applied the same way to all five tracks.
- **`ai` findings are not recomputed** — `s.findings` already contains
  the previous result of the model call (side effect: if the model has not been
  run yet, `ai` is empty; `analyze()` never calls the model itself).
- **`gherkin` is the only track that does not depend on `cfg`** — it gets
  `s.events` directly, without the profile. Even if `s.profile === "qa-python"`,
  a `.feature` file in the session is still checked.
- **`base = formal` is replaced by `merge(formal, lint.findings, cfg.language)` ONLY
  if `lr.ran === true`** — that is, if the engine actually managed to parse
  at least one file. If the engine is still loading (WASM) or failed, the regex
  findings stay as they are and nothing is replaced. This is the
  "graceful degradation" contract examined in §7.

---

## 4. The only explicit source of severity and text: `rules.js`

The file `media/rules.js` does not decide **what** to look for (that is done by `lens.js`,
`lint.js`, `lint-*.js`, `spec.js`, `ai.js`) — it decides **what it is
called, how loud it is and whether it is on**. A quote from the file header:

> Nothing here decides what a check looks for — only how it is worded, how
> loudly it speaks, and whether it speaks at all.

### 4.1 Three dictionaries and one computed index (all derived from the registry)

```js
const { CHECKS, SEVERITIES, GROUPS_ORDER } = LensChecks;           // media/checks.js
const GROUPS = Object.fromEntries(GROUPS_ORDER.map(g => [g, Object.keys(CHECKS).filter(c => CHECKS[c].group === g)]));
const DEFAULT_SEVERITY = { <check>: CHECKS[check].severity, … };
const GOOD = { <check>: CHECKS[check].good, … };                   // non-null only
const ALL = Object.values(GROUPS).flat();                          // == Object.keys(CHECKS) — checked by a test
const groupOf = (check) => Object.keys(GROUPS).find(g => GROUPS[g].includes(check)) || "code";
```

`ALL` answers the question "which checks exist" for the Rules panel,
the export and the import of `rules.json`. A finding with a name outside `ALL` (currently
possible only for the synthetic `lint_<ruleId>`, §6.2) is shown in the
timeline, but not in the Rules panel and not in `rules.json`.

`groupOf()` is called only inside `book()` over the `ALL` list, so the
`"code"` fallback is unreachable in practice; it is kept as a safeguard.

### 4.2 `book(overrides)` — what the Rules panel sees

```js
function book(overrides) {
  const o = overrides || {};
  return ALL.map(check => {
    const own = o[check] || {};
    return {
      check, group: groupOf(check),
      rule: own.rule !== undefined ? own.rule : (L().RULES[check] || ""),
      severity: own.severity || DEFAULT_SEVERITY[check] || "medium",
      enabled: own.enabled !== false,
      good: own.good !== undefined ? own.good : (GOOD[check] || ""),
      edited: own.rule !== undefined || own.good !== undefined || !!own.severity || own.enabled === false,
    };
  });
}
```

Line by line:

- It iterates **over `ALL`, not over the overrides** — so `book()` always
  returns exactly `ALL.length` rows (currently 54), regardless of how many
  checks the user has actually configured. The Rules panel shows
  **all known checks**, even if they never produced a finding.
- `rule` is taken from `own.rule` (if the user explicitly overrode the text) OR
  from `L().RULES[check]` — which is a Proxy in `lens.js` (see §5.1) that itself
  reads `i18n.js`. **If no override is set, `book()` indirectly
  depends on the current UI language** (RU/EN) — the rule text changes
  when the language changes, unless the user has edited it by hand.
- `severity`: `own.severity` (if set and not falsy) → otherwise
  `DEFAULT_SEVERITY[check]` (from the registry, every check in `ALL` has one) →
  otherwise the safeguard literal `"medium"`, unreachable in practice.
- `enabled`: **inverted logic** — `enabled` is true if
  `own.enabled !== false`. That is, **no override means
  enabled=true**; the only way to switch a check off is to write
  `{enabled: false}` explicitly. There is no way to write "included=true" separately
  from "no override at all" — they are indistinguishable, and this is deliberate (it simplifies the
  export: unedited checks do not get into `rules.json`, see §4.3).
- `edited`: true if the user changed anything at all (the text OR the good
  example OR the severity OR switched it off). It drives the "edited" badge in
  the panel and what goes into the export.

### 4.3 `toJson()`/`fromJson()` — serialisation — only the DIFF is exported

```js
function toJson(overrides) {
  return JSON.stringify({
    schema: "sessionlens/rules@1", updated: new Date().toISOString(),
    rules: book(overrides).filter(r => r.edited)
      .map(({ check, rule, good, severity, enabled }) => ({ check, rule, good, severity, enabled })),
  }, null, 1);
}
```

**Critical for review**: the `rules.json` that a team keeps in its
repository and hands to colleagues is **not a full copy of the rules** but a
**diff from the defaults**. If tomorrow the default text of `r_sleep` in `i18n.js`
changes, everyone who did NOT edit `sleep_or_skip_added` by hand
silently gets the new rule text (after updating the extension), while those
who edited it keep what they had. This is probably intended
(defaults should evolve with the extension), but it is an implicit
contract that should be described in the README for end users
— currently it is described nowhere in text, only by the code of `toJson()`.

```js
function fromJson(text) → { overrides, ignored }
// ignored = [{ index, check, reason }], reason ∈ "no_check" | "unknown_check" | "bad_severity"
```

- A row without `check` or with a `check` that is not in `ALL` is not imported,
  but **goes into `ignored`**. The import UI (`#rules-status`) shows
  how many rows were ignored and why (since v0.1.98; before, they were lost
  silently).
- A row with an invalid severity is imported without the severity field and also
  goes into `ignored` with the reason `bad_severity`. The allowed values are
  `SEVERITIES` from the registry.
- `data` can be either an array or an object with a `.rules` field.
  `schema: "sessionlens/rules@1"` is written but not checked on import.
- The result **fully replaces** `state.ruleOverrides`, without merging.
  Importing `rules.json` is not "add", it is "replace everything".

### 4.4 `apply(findings, overrides)` — the only place where overrides actually affect findings

```js
function apply(findings, overrides) {
  const o = overrides || {};
  return findings
    .filter(f => (o[f.check] || {}).enabled !== false)
    .map(f => {
      const sev = (o[f.check] || {}).severity;
      return sev && !f.demoted ? { ...f, severity: sev } : f;
    });
}
```

Two effects, applied in this order:

1. **Filtering**: a finding is dropped entirely if its check has
   `{enabled: false}`.
2. **Severity replacement**: **only if the finding is NOT `demoted`**. This is
   the only place in the whole system where `f.demoted` is read — and it
   means: **calibration (see §5.3) takes precedence over a manual severity
   override**. If a check has been demoted to `low` by calibration (because its
   precision is < 50% by the reviewer's verdicts), and the user has
   set `severity: "high"` for it by hand in the Rules panel, the finding still
   stays `low`, because `f.demoted === true` blocks
   the override. This is a deliberate priority: "statistics beat
   manual settings". Since v0.1.98 the Rules panel shows an ⓘ icon with a hint
   (`rules_demoted_hint`) next to the severity of such a check if the severity
   was set by hand and calibration has demoted the check.

`ruleText(check, overrides)` and `exampleGood(check, overrides)` are essentially
excerpts of the same logic as inside `book()`, but for one check without
building the whole array (used when generating `CLAUDE.md`, see §8).

---

## 5. The role of `lens.js`: default names, calibration, sorting

### 5.1 `RULE_KEYS` and the `RULES` Proxy — the default rule text

```js
const RULE_KEYS = Object.fromEntries(Object.entries(CHECKS).map(([c, v]) => [c, v.ruleKey]));   // from the registry
const RULES = new Proxy({}, { get: (_, k) => {
  if (RULE_KEYS[k]) return T(RULE_KEYS[k]);
  if (typeof k === "string") LensChecks.warnUnknown(k, "Lens.RULES");   // one warn per name, not for lint_<ruleId>
  return "";
} });
```

- The Proxy is **live**: `Lens.RULES[check]` calls `T()` anew every time and
  reacts to a language change without reloading state.
- The i18n keys are historically irregular (`r_peeked`, `r_sleep`…) — that is why
  `ruleKey` is stored in the registry explicitly rather than derived from the check name.
- The seven `ai_*` categories **deliberately** share one text `r_ai`: the rule
  is worded by the model in the explanation of the finding. This is recorded in the registry explicitly
  (`ruleKey: "r_ai"`), not through a prefix fallback as before v0.1.98.
  `ai_other` (a model answer outside the categories) has its own text `r_ai_other`.
- For a name outside the registry the Proxy returns an empty string and writes
  `console.warn` (except the synthetic `lint_<ruleId>`).

### 5.2 The `checks` object, `runChecks()` and `calibrate()`

`lens.js` contains the `checks` object with **35 functions** (v0.1.113) of the form
`checkName(ev, cfg) -> Finding[]` (the full list — see the table in §9).
These are the only checks that **do not depend on an external engine** —
plain JS/regex over the event text.

```js
function calibLevel(st) {                       // one threshold for calibrate(), the Rules panel and the Calibration table
  const n = st ? st.ok + st.fp : 0; const p = n ? st.ok / n : null;
  const level = n >= 10 && p < 0.3 ? "off" : n >= 10 && p < 0.5 ? "demoted" : n < 10 ? "need" : "ok";
  return { n, p, level };
}
function runChecks(ev, cfg) {                   // finds only; calibration is calibrate()'s (since v0.1.112)
  const out = [];
  for (const name of cfg.checks)                // ← cfg.checks is part of the profile, NOT a common list
    if (checks[name]) out.push(...checks[name](ev, cfg)); // ← a name without a function is silently skipped
  return sortFindings(dedupe(out).map(f => Object.assign(f, { source: "formal" })));
}
function calibrate(findings, calib, overrides) { // calib: { check: { source: { ok, fp } } }
  // only calibrated(f): source formal, lint or gherkin, or spec for test_without_requirement / out_of_scope_tested
  // level "off" (unless overrides[check].enabled === true) → hidden; "demoted" → { ...f, severity: "low", demoted: true }
  return { findings: shown, hidden, suppressed: [{ check, source, precision, n }] };
}
```

**This is the most important piece of logic in the Rules system, besides `apply()`.**
Walk-through:

- `cfg.checks` is an array of names **set per profile** in `PROFILES` (see
  `lens.js`, for example `qa-cypress: { checks: [...METHOD, ...PROCESS,
  ...CODE] }`). The profile decides **which check names to try to
  compute with regexes at all**, but that does not mean all of them
  have a function — the test `if (checks[name])` silently skips
  names without an implementation. **This is a deliberate, documented pattern**:
  many profiles include in `cfg.checks` checks such as `raw_locator`,
  `positional_locator`, `no_assertion_after_action` that have **no**
  regex function — they are in `cfg.checks` only "for the record"
  (to be in the profile's list of checks conceptually), and the actual
  findings for them come exclusively through `LensLint.run()`
  (§6). To a reviewer this looks like dead code, but it is a deliberate
  design — see the comment in `lens.js` at `qa-detox`: *"there is no regex
  fallback for those, same as raw_locator/positional_locator elsewhere"*.
- **Calibration** (since v0.1.112 `Lens.calibrate()`, after the merge, §3). `calib` is
  `calibStatsBySource()` (`src/webview/store.js`): the summaries' `sourceStats` (§15.1), plus the imported rows
  that matched no session (`state.external`, under the source they name: a `verdicts.json` from another machine
  carries its calibration; "external" when none, never calibrated), added up per check
  AND source, so `weak_assert` from ESLint and `weak_assert` from a regex have separate records and a poor
  engine never switches off the regex check, or the other way round. With ≥10 verdicts for that check and
  source and precision (`ok / (ok+fp)`) **< 30%** its findings are **hidden**: not shown, kept with the
  session as `s.calibHidden` and counted by `sessionSummary()` with their verdicts (not running the check
  lost them from the stats and the check came back on the next analysis, `test/calibration-loop.test.js`).
  `s.suppressed` lists `{ check, source, precision, n }` for each pair that hid something in this session.
  **< 50%** (but ≥30%): findings are **forcibly lowered to `low`** and marked `demoted: true` — the flag
  that later blocks a manual severity in `apply()` (§4.4).
- **What is calibrated** (decided 01.10.2026): regex (`"formal"`; a finding with no source, from a
  session saved before 0.1.112, counts as one), the lint engines (`"lint"`), Gherkin, and the two heuristic
  spec checks `test_without_requirement` and `out_of_scope_tested`. **Never** `no_spec` and
  `spec_uncovered` (facts, not guesses) or the model's `ai_*` (their precision depends on the model and
  the prompt, not on the check; the Calibration tab only shows it). **Never** a check the registry marks
  `calibrate: false`, whatever its source: since v0.1.116 `hardcoded_secret` (decided 03.10.2026: ten "False"
  verdicts must not hide a leaked token; unticking it on the Rules tab still switches it off). `hardcoded_base_url`
  is calibrated as before. The thresholds are the same for every source. Imported findings count under their own
  source and are not calibrated.
- **A check ticked on by hand** on the Rules tab (`ruleOverrides[check].enabled === true`, which the
  checkbox writes) is never hidden by calibration. A check merely left at its default is.
- **What the UI shows** (since v0.1.112): the Calibration table has one row per check and source, with the
  status `calibrate()` really applies (`Lens.isCalibrated(check, source)`; "not calibrated" with the reason
  as a tooltip for the model, the facts of the spec, imported findings and a `calibrate: false` check; "on by hand" for an off pair the
  person ticked on). The Rules tab shows ⓘ for a demoted source and "on by hand" next to the checkbox. The
  line under a session's findings names the source of each disabled pair.
- **The demo session** (`LensDemo.ID`, since v0.1.110) is left out of `calibStatsBySource()` and `profileVerdicts()`
  (`src/webview/store.js`): its verdicts are about a made-up session. Its confirmed findings still propose rules on
  the Calibration tab, which is what the demo is for.

### 5.3 `sortFindings` — display order

```js
function sortFindings(out) {
  const o = { high: 0, medium: 1, low: 2 };
  const pri = f => (LensChecks.CHECKS[f.check] || {}).sortPriority || 0;
  return out.sort((a, b) => pri(a) - pri(b) || o[a.severity] - o[b.severity] || a.seq - b.seq);
}
```

The priority is set by the `sortPriority` field in the registry: `tests_never_run` (−1) and
`no_spec` (−0.5) always float to the very top of the findings list, regardless
of severity. Before v0.1.98 these two names were hard-coded in the comparator.

## 6. The role of `lint.js`: an engine-agnostic dispatcher

This is the most important architectural pattern of the project — **`lint.js` has never,
in its whole history (5 engines added — ESLint×3, tree-sitter×3, custom
parser×1 = 7 engines), changed its dispatching logic**. Every engine
(an ESLint bundle, a tree-sitter wrapper, a parser of its own) must export
**the same interface**:

```ts
{
  lint(code: string, opts: { rules: Record<string, "warn">, filename: string })
    -> { messages: Array<{ ruleId: string, message: string, line?: number }>, error?: string },
  RULES: { <engineKey>: string[] },   // the list of rule ids the engine can check
}
```

### 6.1 `ENGINES` — the single place to register a new engine

```js
const ENGINES = {
  typescript: { core: () => (typeof LensLintCore   !== "undefined" ? LensLintCore   : null), map: RULE_MAP },
  javascript: { core: () => (typeof LensLintCore   !== "undefined" ? LensLintCore   : null), map: RULE_MAP },
  cypress:    { core: () => (typeof LensLintCypress!== "undefined" ? LensLintCypress: null), map: CYPRESS_RULE_MAP },
  detox:      { core: () => (typeof LensLintDetox  !== "undefined" ? LensLintDetox  : null), map: DETOX_RULE_MAP },
  java:       { core: () => (typeof LensLintJava   !== "undefined" ? LensLintJava   : null), map: JAVA_RULE_MAP },
  csharp:     { core: () => (typeof LensLintCSharp !== "undefined" ? LensLintCSharp : null), map: CSHARP_RULE_MAP },
  python:     { core: () => (typeof LensLintPython !== "undefined" ? LensLintPython : null), map: PYTHON_RULE_MAP },
  robot:      { core: () => (typeof LensLintRobot  !== "undefined" ? LensLintRobot  : null), map: ROBOT_RULE_MAP },
};
```

- The key is the profile's `cfg.language` (not the profile name! `qa-ts`/`qa-generic`
  and so on may have different `language`s, but several profiles CAN
  point to the same `language` — that is the case today:
  `typescript`/`javascript` both lead to `LensLintCore`).
- `core()` is a function (not a value!), because the engine may
  **not exist yet** when `ENGINES` is registered (all three
  tree-sitter engines load their WASM asynchronously — see §7). A lazy
  `typeof X !== "undefined"` check on every call, not a cached
  reference.
- **Every rule map (`*_RULE_MAP`) is the only place where an engine's rule id
  turns into a check name** (§1, source #2). If the engine
  returned a `ruleId` that is not in its map — see `run()` below.

### 6.2 `run(session, cfg, settings)` — the heart of the dispatcher

```js
function run(session, cfg, settings) {
  const engine = ENGINES[cfg.language];
  if (!engine) return { findings: [], note: T("lint_profile"), ran: false };
  const core = engine.core();
  if (!core) return { findings: [], note: T("lint_missing"), ran: false };
  // …collect one code block per file, the latest version only…
  const rules = rulesConfig(engine.map, (settings && settings.lintExtraRules) || []);
  for (const b of blocks) {
    let r;
    try { r = core.lint(b.code, { rules, filename: b.name }); }
    catch (e) { /* CSP detection + a general catch → errors++ */ }
    if (r.error) { errors++; continue; }
    for (const m of r.messages) {
      const [check, severity] = engine.map[m.ruleId] || ["lint_" + String(m.ruleId).split("/").pop(), "medium"];
      findings.push({ check, severity, seq: b.seq, source: "lint", rule: m.ruleId, line: m.line, message: `${b.name}:${m.line} — ${m.message} [${m.ruleId}]` });
    }
  }
  // capped: at most 3 findings of one check+file, the rest folds into "+N more"
}
```

- **`engine.map[m.ruleId] || ["lint_" + ruleId.split("/").pop(), "medium"]`**
  — if the engine returned a `ruleId` that is not in its own
  `*_RULE_MAP` (for example, someone added a new rule to
  `lint-python.js` but forgot to add it to `PYTHON_RULE_MAP` in
  `lint.js`), the finding **is still created**, but with a synthetic
  check name such as `"lint_expect-after-action"` (the engine rule's name
  cut to its last segment, without the namespace prefix). Such a check name **will never be in
  `GROUPS`**; it silently falls into the group `code` with severity `medium` and
  no rule text. **This is the only place in the code that can
  "invent" new check names on the fly** — worth checking in review
  whether anyone mistakenly relies on this fallback instead of an explicit entry in a
  `*_RULE_MAP`.
- The message cap (`CAP = 3`) works **within one call of
  `run()`**, per `(check, seq)` pair, that is per file — if one file gives
  30 identical findings of one check in one analysis, the first 3 are shown
  plus "+27 more" in the text of the last one. This is not a persistent limit, just
  protection against one spammed report.

### 6.3 `merge(regexFindings, lintFindings, language)`, `SUPERSEDES` and `SAME_AS_REGEX`

```js
const SUPERSEDES = new Set(["sleep_or_skip_added", "fragile_wait", "conditional_logic", "focused_test", "debug_leftover"]);
const SAME_AS_REGEX = {                       // engine rule → the kinds of regex finding it finds just as well
  "playwright/no-wait-for-timeout": ["sleep_or_skip_added|sleep"],
  "playwright/no-skipped-test": ["sleep_or_skip_added|skip"],
  "playwright/no-focused-test": ["focused_test|only"],
  "playwright/no-page-pause": ["debug_leftover|pause"],
  "playwright/no-networkidle": ["fragile_wait|networkidle"],
  "cypress/no-pause": ["debug_leftover|pause"],
  "cypress/no-debug": ["debug_leftover|debug"],
  "robot/sleep-or-skip": ["sleep_or_skip_added|sleep", "sleep_or_skip_added|skip"],
  "playwright/no-force-option": [],           // reported under one of these names, but looks for something else
  …
};
const merge = (regexFindings, lintFindings, language) => {
  const c = covers(language);                 // "check|kind" the engine of this language finds itself
  return regexFindings.filter(f => !SUPERSEDES.has(f.check) || !c.has(f.check + "|" + f.kind)).concat(lintFindings);
};
```

- **5 check names** are emitted by both a regex and an engine and may be replaced. If the lint engine parsed the
  file (`lr.ran === true`), a regex finding of these checks is dropped **only when the engine of the profile's
  language looks for the same kind of thing**, so as not to show it twice. Every regex finding of these five carries
  a `kind`: `sleep_or_skip_added` — `sleep`, `skip`, `retry`; `fragile_wait` — `networkidle`, `count`;
  `conditional_logic` — `branch`; `focused_test` — `only`; `debug_leftover` — `pause`, `debug`, `debugger`,
  `breakpoint` (one finding per file and kind, so a `debugger;` next to a `page.pause()` stays).
- **History.** Until 0.1.113 any engine that parsed the file dropped all of them: Java, C# and Python, whose engines
  have no rule for sleeps or skips, never reported `Thread.sleep`, `@Disabled`, `time.sleep`, `@pytest.mark.skip`;
  Cypress and Detox lost `it.skip`; every engine lost a retry (#27). For a short while after that only
  `sleep_or_skip_added` compared the kind, so in qa-ts a `networkidle` and an `if` in a test were reported twice
  (#29). `test/supersedes.test.js` runs the real engines on each case.
- **`SAME_AS_REGEX` lists every engine rule reported under one of the five names**, with `[]` for the ones that look
  for something else (`playwright/no-force-option`, `cypress/no-force`, `detox/waitfor-requires-timeout`…).
  `test/supersedes.test.js` fails on a new rule until that is decided, and on a kind listed under another check.
  Nothing replaces a retry, an exact element count or a `debugger` statement.
- **`duplicate_assert` left `SUPERSEDES` in 0.1.113**: its only engine rule (`playwright/no-duplicate-hooks`) was
  about hooks, not assertions, and is no longer run (phase 10, "every finding under its own name").
- **An important asymmetry**: `raw_locator`/`positional_locator`/
  `no_assertion_after_action`/`no_app_reset`/`unannotated_test_method`/
  `swallowed_exception`/`assert_args_reversed`/`cypress_async_test`/`empty_test_case` are
  **not in `SUPERSEDES`**, because they **have no regex function anyway**
  (see §5.2) — there is nothing to duplicate. `test/rules-consistency.test.js` ties `SUPERSEDES` to the registry's
  `sources`: every check in `SUPERSEDES` must be emitted by both a regex and an engine, and every check emitted by
  both must be either in `SUPERSEDES` or in the test's `KEEP_BOTH` with the reason.
- **`weak_assert` keeps both** (`KEEP_BOTH`): the regex finds `toBeDefined()`,
  `toBeTruthy()` and `expect(true).toBe(true)`; the engines map other rules to
  the same name (a useless `.not`, a malformed `expect`, a standalone `expect`).
  Superseding it would drop the regex findings the engines do not make.
- **Engine rules no longer run** (0.1.113): `playwright/max-nested-describe`, `playwright/no-nested-step`,
  `cypress/no-and` (style) and `playwright/no-duplicate-hooks`. An engine runs only the rules of its `*_RULE_MAP`
  (`rulesConfig()`), plus the user's `lintExtraRules`, which report as `lint_<rule>`.

---

## 7. Loading the engines and the readiness contract (since v0.1.102)

Before v0.1.102 every engine was a `<script>` tag of every page, and `app.js`
called `boot()` of the three tree-sitter engines at start. Since phase 5 the engines
are loaded lazily.

**Who loads them.** `LensLint.ensure(language)` in `lint.js`. The map
`ENGINE_FILES` (next to `ENGINES`) says which files a language needs and in
which order:

| `cfg.language` | Files | `boot()` |
|---|---|---|
| `typescript`, `javascript` | `vendor-eslint.js` | no |
| `cypress` | `vendor-eslint-cypress.js` | no |
| `detox` | `vendor-eslint-detox.js` | no |
| `java` | `tree-sitter.js`, `lint-java.js` | yes, `tree-sitter.wasm` + `tree-sitter-java.wasm` |
| `csharp` | `tree-sitter.js`, `lint-csharp.js` | yes, `tree-sitter.wasm` + `tree-sitter-c_sharp.wasm` |
| `python` | `tree-sitter.js`, `lint-python.js` | yes, `tree-sitter.wasm` + `tree-sitter-python.wasm` |

`robot` is not in the map: `lint-robot.js` is small and synchronous, it is in the
core of the page. `api`, `mobile`, `any`, `go` have no engine.

- Each file is inserted as a `<script>` once per page (the shared
  `tree-sitter.js` once for three languages); the next one after the `onload`
  of the previous. The URIs come from `SL_ENGINE_URIS` (the `data-engines` attribute on
  `<body>`, JSON, written by `extension.js`, read by `vscode-bridge.js`).
- `ensure()` → `"ready"`, `"none"`, `"failed"` (in Node `"static"`: there is
  no loader there, the engine is either a global or absent). A file that failed to
  load is not requested again. A 30 s timeout → `"failed"`; a late
  success still makes the engine `"ready"`.
- At the end, a window event `sl:engine-ready` or `sl:engine-failed`
  (`detail: { language, state }`).
- Without WASM URIs a tree-sitter engine is not booted and `ensure()` reports it as `"failed"`.

**Who calls it.** `app.js`: `needEngine(profile)` waits for `ensure()` before
**every** `analyze()` — import, the background pass, `ensureFresh`, the spec,
segmentation, re-analysis, AI review. With `settings.lint === false`
nothing is loaded. A session tab calls `needEngine` for its profile
in advance after the first render. An idle sidebar loads nothing.

**The readiness contract.** `run()` returns `pending: true` and the note
`lint_loading` only if the language's engine in this page is still `idle`/`loading`
and the session has code blocks (or the engine file is already there but its `boot()` has not
finished and `bootError()` is empty). Then `analyze()` sets
`s.lintPending = true` and an **empty** `state.gens[id]`: the session is saved
as "not analysed with the current rules", and it will be picked up by
`ensureFresh()` and the background pass. On `sl:engine-ready`/`sl:engine-failed`
a tab re-analyses its session if it has `lintPending`
(`updateSession(..., { skipIfSame: true })` — no write if nothing
changed), and the sidebar restarts the background pass if the index has
sessions with `analyzedGen === ""`.

The three notes differ: `lint_loading` — the engine is loading;
`lint_missing` — the engine file failed to load (or does not exist); `lint_failed` —
the engine parsed no block.

`lint-robot.js` is the only engine without `boot()`: `core()` returns
an object with a working `.lint()` right away.

**One-off repair.** Sessions saved before v0.1.102 while tree-sitter
was still loading are stored with the current gen and without tree-sitter findings (their `lintWhy`
contains `still loading`). 2 s after start the sidebar reads the
java/csharp/python sessions once (10 at a time), re-analyses such ones and sets
`lintRepair = 1` (a separate storage key, written only by itself, not through
`save()`). With ESLint switched off it does nothing and tries again on the next
start. A session open in a tab at that moment is skipped (a background
write yields to the tab).

---

## 8. The UI layer: `app.js`

### 8.1 `renderRules()` — rendering the panel

```js
function renderRules() {
  const book = LensRules.book(state.ruleOverrides);
  const groups = Object.fromEntries(LensChecks.GROUPS_ORDER.map(g => [g, T("g_" + g)]));   // order and ids from the registry
  const calib = calibStatsBySource();
  // ⓘ next to the <select> if the severity was set by hand and one calibrated source of the check is "demoted";
  // "on by hand" next to the checkbox if it was ticked on (enabled: true) and one calibrated source is "off" (0.1.112)
  …
}
```

- **Show checks for** (since 0.1.114): `rulesProfile()` is `settings.rulesProfile`, or the Sessions tab's profile
  until one is picked here; `""` is all profiles. `profileChecks(p)` is what `Lens.profileInfo(p)` lists plus the
  `spec` and `ai` groups, which every profile has. A group with no check left is not drawn. Only a view: the overrides,
  `rules.json` and **Reset** cover every check.
- The list of groups and their order come from `GROUPS_ORDER`; the label is always
  `g_<id>` in `i18n.js`. A new group is added to the registry and to the dictionary;
  the consistency test checks that `g_<id>` exists.
- The severity `<select>` and the severity filter chips are built from `SEVERITIES`.
- Each check row has three independent controls (a severity `select`,
  an enabled `checkbox`, two `textarea`s for rule/good); each one on `change`
  immediately writes through `put()` into `state.ruleOverrides[check]` and calls
  `saveRules()`.

### 8.2 `saveRules()` and recomputing findings (since v0.1.101)

Before v0.1.101 every change of a checkbox in Rules synchronously re-ran `analyze()` for **every** session and wrote all
sessions into `globalState`. Since phase 4:

```js
function saveRules(status) {          // ruleOverrides already changed in memory, UI updated
  clearTimeout(rulesTimer);
  rulesTimer = setTimeout(flushRules, 300);   // one write per series of clicks
}
async function flushRules() {
  await saveKeys(["ruleOverrides"]);          // only this key; the host broadcasts { scope: "keys" }
  onGenChanged();                             // nothing is recomputed synchronously in the sidebar
}
```

Which findings are stale is decided by `analysisGen = Lens.analysisGen({ ruleOverrides, lint, epoch })` (8 hex characters,
FNV-1a of JSON with sorted keys). It includes the inputs of `analyze()` whose change in 0.1.100 recomputed all
sessions: rule overrides, the ESLint switch and `analysisEpoch` (incremented when verdicts are imported), and since
0.1.116 `Lens.ANALYSIS_VERSION`, the extension's version (a test keeps it equal to `package.json`). Each session's
summary stores the `analyzedGen` its findings were computed with.

- A session tab, on `{ scope: "keys" }`, compares its session's `analyzedGen` with the current `analysisGen` and, if they
  differ, recomputes only itself (`ensureFresh`), draws the result and saves it.
- The sidebar starts a background pass (`startBackground`) 1 s after a change: stale sessions one at a time, from
  newest to oldest, with a 50 ms pause. The host skips a session open in a tab (`{ skipped: true }`). A new
  change of the rules restarts the pass; while the rules write waits for its debounce, the pass does not run.
- **After an update** (since 0.1.116) every stored session is stale and the background pass analyzes it again; a
  session tab does it when it opens. Until 0.1.116 the version was not part of `analysisGen`, as in 0.1.100: a session
  kept the findings of the version that analyzed it, and the new checks of 0.1.113 and 0.1.114 did not show up in it
  until a Rules edit.
- **Verdicts across a rewording.** `analyzeNow()` ends with `Lens.carryVerdicts(s)`: a verdict whose key (`fkey`:
  check, step, the first 40 characters of the message) no longer matches a finding moves to the finding of the same
  check and step, if exactly one such finding has no verdict of its own (shown or in `calibHidden`). So a finding a new
  version words differently keeps its verdict and its weight in calibration; a finding that is gone keeps nothing.

**A known difference from 0.1.100.** Before, the loop recomputed all sessions in a row, and each next one saw calibration
(`calibStats()`, now `calibStatsBySource()`) with the already recomputed findings of the previous ones. Now calibration is taken from the summaries at the moment
each session is recomputed. The result can differ only if some check crosses a calibration threshold during the pass (30 %
or 50 %, §5.2).

### 8.3 The path Rules → `CLAUDE.md`/`AGENTS.md`

A separate neighbouring mechanism (the Calibration tab, not Rules), but it
uses `LensRules.exampleGood()`/`ruleText()` directly:

```js
const ruleMd = (k, l) => {
  const good = LensRules.exampleGood(k, state.ruleOverrides);
  return [`## ...`, `${T("rules_rule")} ${LensRules.ruleText(k, state.ruleOverrides)}`,
          ...bad.map(...), good ? `...${good}...` : "", ...].join("\n");
};
```

A rule becomes a markdown block with the rule text, an example of
bad code (taken from real findings of the session) and an example of good code
(from `GOOD`/the override). The threshold "how many confirmed findings are needed to
propose a rule" is the configurable `min` (the UI field `#min-count`), not
part of the Rules system as such.

---

### 8.4 Profile details (since v0.1.104)

`Lens.profileInfo(name, deps)` in `lens.js` is a pure function that returns data only (no HTML, no translation):
`{ profile, language, codeExt, runners, groups: [{ group, checks: [{ name, off, engineOnly }] }], count, engine:
{ kind, state }, spec: { read, notRead, anyFile }, asserts, gherkin, calibration: { validated, builtIn, verdicts,
min } }`. `deps = { checks, lint, spec, overrides, settings, verdicts }` are passed as arguments: `lint.js` and
`spec.js` load after `lens.js`, and the host loads `lens.js` with `require`.

Sources, nothing written by hand: the checks are `cfg.checks`, the values of `LensLint.RULE_MAPS[language]` and the registry checks with
the `gherkin` source; group and order come from the `checks.js` registry; `engine.kind` from `ENGINE_FILES` (`eslint`,
`eslint-cypress`, `eslint-detox`, `tree-sitter`), an engine without files but with a rule map is `robot-parser`, otherwise
`none`; `engine.state` from `settings.lint`; coverage from `LensSpec.supports()` for each extension in `code_ext`
(for `qa-generic`, a probe list); `asserts` is whether there are `test_fn_pattern` and `assert_line_patterns`;
calibration is `Lens.isValidated()` (`VALIDATED_PROFILES` or at least `UNVERIFIED_MIN` verdicts; before, this
list was hard-coded in two places of `app.js`).

`app.js`: `renderProfileInfo()` writes `#profile-info` under the Profile list (from `renderList()` and on a profile change;
Rules and ⚙ Settings reach it when the Sessions tab is shown again and on a `keys` refresh); `profileSummary()` is
the one-line summary, also the `title` of the profile name in `#hdr`. The list options: `name — profile_desc_<name>`. All output goes through
`esc()`; a check's rule text is the `title` attribute.

## 9. The full table of checks at v0.1.115 (61 of them)

The reference is `media/checks.js`; this table is a readable copy of it, generated from the registry and
`LensLint.RULE_MAPS` (the "Source" column), not written by hand.

| Check | Group | Severity (default) | Source |
|---|---|---|---|
| peeked_at_src_before_plan | method | high | regex (lens.js) |
| stop_markers_missing | method | medium | regex (lens.js) |
| pass_claim_without_run | process | high | regex (lens.js) |
| fix_after_fail_without_triage | process | high | regex (lens.js) |
| tests_never_run | process | high | regex (lens.js) — sorted first (sortPriority) |
| scope_creep | process | medium | regex (lens.js) |
| edit_churn | process | medium | regex (lens.js) |
| assumption_instead_of_question | process | medium | regex (lens.js) |
| user_frustration | process | medium | regex (lens.js) |
| product_code_edited | process | high | regex (lens.js) |
| snapshot_overwritten | process | high | regex (lens.js) |
| config_weakened | process | high | regex (lens.js) |
| assert_weakened | code | high | regex (lens.js) |
| weak_assert | code | high | regex (lens.js) + engines (ESLint Playwright, ESLint Cypress), both kept (§6.3) |
| sleep_or_skip_added | code | high | regex (lens.js) + engines (ESLint Playwright, ESLint Cypress, ESLint Detox, Robot), an engine replaces the kinds it finds itself (§6.3) |
| hardcoded_date | code | medium | regex (lens.js) |
| fragile_wait | code | medium | regex (lens.js) + engines (ESLint Playwright, ESLint Cypress, ESLint Detox), an engine replaces the kinds it finds itself (§6.3) |
| expected_failure | code | medium | regex (lens.js) |
| magic_number | code | low | regex (lens.js) |
| assertion_roulette | code | low | regex (lens.js) |
| conditional_logic | code | low | regex (lens.js) + engines (ESLint Playwright), an engine replaces the kinds it finds itself (§6.3) |
| duplicate_assert | code | low | regex (lens.js) |
| raw_locator | code | low | engines only (ESLint Playwright, ESLint Cypress) |
| positional_locator | code | low | engines only (ESLint Playwright, ESLint Detox) |
| no_assertion_after_action | code | high | engines only (ESLint Playwright, ESLint Detox, Java, C#, Python, Robot) |
| no_app_reset | code | medium | engines only (ESLint Detox) |
| unannotated_test_method | code | high | engines only (Java, C#) |
| swallowed_exception | code | high | engines only (Java, C#, Python) |
| assert_args_reversed | code | medium | engines only (Java, C#, Python) |
| lint_valid_title | code | low | engines only (ESLint Playwright) |
| focused_test | code | high | regex (lens.js) + engines (ESLint Playwright), an engine replaces the kinds it finds itself (§6.3) |
| debug_leftover | code | medium | regex (lens.js) + engines (ESLint Playwright, ESLint Cypress), an engine replaces the kinds it finds itself (§6.3) |
| cypress_async_test | code | medium | engines only (ESLint Cypress) |
| test_deleted | code | high | regex (lens.js) |
| hardcoded_secret | code | high | regex (lens.js) |
| hardcoded_base_url | code | medium | regex (lens.js) |
| status_only_assert | api | medium | regex (lens.js) |
| mocked_service | api | medium | regex (lens.js) |
| no_negative_cases | api | medium | regex (lens.js) |
| test_data_no_cleanup | api | low | regex (lens.js) |
| response_time_assert | api | low | regex (lens.js) |
| mobile_raw_locator | mobile | low | regex (lens.js) |
| hardcoded_coordinates | mobile | medium | regex (lens.js) |
| no_driver_teardown | mobile | medium | regex (lens.js) |
| outline_no_examples | gherkin | high | Lens.gherkinChecks() (profile-agnostic) |
| scenario_no_then | gherkin | high | Lens.gherkinChecks() (profile-agnostic) |
| bloated_background | gherkin | medium | Lens.gherkinChecks() (profile-agnostic) |
| duplicate_step_text | gherkin | low | Lens.gherkinChecks() on `.feature` files (profile-agnostic) + an engine (Robot) on `.robot` files |
| empty_test_case | robot | high | engines only (Robot) |
| no_spec | spec | high | spec.js (LensSpec.checks) |
| spec_uncovered | spec | high | spec.js (LensSpec.checks) |
| test_without_requirement | spec | medium | spec.js (LensSpec.checks) |
| out_of_scope_tested | spec | medium | spec.js (LensSpec.checks) |
| ai_purpose | ai | medium | ai.js (model) |
| ai_coverage | ai | medium | ai.js (model) |
| ai_fragility | ai | medium | ai.js (model) |
| ai_missing | ai | medium | ai.js (model) |
| ai_questions | ai | medium | ai.js (model) |
| ai_fix_justification | ai | medium | ai.js (model) |
| ai_spec_defect | ai | medium | ai.js (model) |
| ai_other | ai | medium | ai.js (model) — a model answer outside the categories |

"Engines only" = 10 checks **have no regex fallback at all**: if the engine could not load or parse (WASM not ready
yet, blocked by CSP, a broken file), these findings are not there in this run, and nothing says that the check
"should have" fired. The only signal is `s.lintNote`/`s.lintWhy` (text such as "could not parse N files"), not tied
to a specific check name.

**Calibration** (§5.2) covers, since v0.1.112, the regex checks, the engines and Gherkin per check and source, and
the two heuristic spec checks; not `no_spec`, `spec_uncovered` or the model's `ai_*`.

---

## 10. An end-to-end example: one finding from birth to the screen

Take `unannotated_test_method` for the `qa-java` profile.

1. The user imports a transcript with `qa-java`. `analyze(s)` calls
   `Lens.profile("qa-java")` → `cfg.language === "java"`.
2. `Lens.runChecks(s.events, cfg)` iterates over `cfg.checks`
   (`[...METHOD, ...PROCESS, ...CODE]`), sees the name `unannotated_test_method`
   in the `CODE` list, but `checks["unannotated_test_method"]` does not exist
   → `continue`, nothing is added. `formal` does not contain this finding.
3. `LensLint.run(s, cfg, settings)`: `ENGINES.java.core()` returns
   `LensLintJava` (if the WASM is ready). `rulesConfig(JAVA_RULE_MAP, ...)`
   puts `"java/unannotated-test-method": "warn"` into the engine config.
4. `LensLintJava.lint(code, {rules, filename})` parses the `.java` file with
   tree-sitter, finds a method `testHelper()` without `@Test`, calls
   `report(m, "testHelper() looks like a test...")` → inside the engine this
   becomes `{ ruleId: "java/unannotated-test-method", message: "...",
   line: 9 }`.
5. Back in `run()`: `engine.map["java/unannotated-test-method"]` →
   `["unannotated_test_method", "high"]`. The finding is assembled:
   `{ check: "unannotated_test_method", severity: "high", seq: b.seq,
   source: "lint", rule: "java/unannotated-test-method", line: 9,
   message: "T.java:9 — testHelper() looks like a test... [java/unannotated-test-method]" }`.
6. `lr.ran === true` → `base = LensLint.merge(formal, lr.findings)`.
   `unannotated_test_method` is not in `SUPERSEDES`, but there is nothing to strike out anyway
   (it was not in `formal`) — the finding is simply appended to the list.
7. `LensRules.apply([...base, ...], state.ruleOverrides)` looks at
   `state.ruleOverrides["unannotated_test_method"]`. If it is empty, the
   finding passes unchanged. If the user has switched this
   check off earlier (`{enabled: false}`), the finding is dropped here and does not
   appear anywhere further.
8. `Lens.sortFindings(...)`: `pri()` for this check → `0` (not
   `tests_never_run`/`no_spec`) → sorted by `severity` (`high` = 0,
   floats above `medium`/`low`) → by `seq`.
9. `app.js`'s timeline rendering: `srcOf(f)` → `f.source === "lint"` →
   the `"lint"` bucket in the filter (not `"formal"`). If the user unticks
   "lint" in the source filter, the finding is hidden from the list but **stays
   in `s.findings`** (the UI filter ≠ `LensRules.apply()`: two different,
   unconnected ways of hiding).
10. The Rules panel (`renderRules()`): `book()` finds `unannotated_test_method`
    in `ALL` (it is in `GROUPS.code`), renders its row with severity `high`
    (the default, if not edited) and the text from `RULE_KEYS.unannotated_test_method
    → "r_unannotated_test_method" → i18n.js`.

---

## 11. Invariants and known risks (a checklist for review)

Status at v0.1.98. Closed items are kept for the record.

1. ~~Consistency of check names between files~~ — **closed**:
   `test/rules-consistency.test.js` (§1).
2. ~~`groupOf()`'s fallback `"code"`~~ — **closed**: the fallback is
   unreachable for known names (§4.1); unknown names produce
   `console.warn` in `Lens.RULES`/`ruleText()`. The synthetic `lint_<ruleId>`
   are an exception by design.
3. ~~A hard-coded list of groups in `renderRules()`~~ — **closed**:
   `GROUPS_ORDER`.
4. ~~Hard-coded names in `sortFindings`~~ — **closed**: `sortPriority`.
5. ~~`SUPERSEDES` and "the list of checks without a regex function" are two
   independent lists~~ — **closed in v0.1.108**: `test/rules-consistency.test.js`
   checks `SUPERSEDES` against the registry's `sources` (§6.3).
6. ~~Calibration covers only the regex checks~~ — **closed in v0.1.112** (phase 8): `Lens.calibrate()` after the
   merge, per check and source, for regex, engines, Gherkin and two spec checks; not for the facts of the spec or the
   model (§5.2).
7. ~~`f.demoted` silently blocks a manual override~~ — **closed**: the ⓘ icon
   in the Rules panel (§4.4).
8. ~~`fromJson()` silently loses rows~~ — **closed**: `ignored` and
   a message in the UI (§4.3).
9. ~~Gherkin findings cannot be told apart from regex findings by `.source`~~ — **closed in v0.1.109**:
   `Lens.gherkinChecks()` sets `source: "gherkin"`. The panel still shows them as "formal"; the calibration plan
   (per-source stats) builds on this. Since v0.1.112 `runChecks()` sets `source: "formal"` on regex findings
   (and on the ones an "off" check hides), the name the filter and the exported reports already used for them, so
   every finding a detector makes now has a source.
10. ~~`ai_*` share the text `r_ai`~~ — **decided as deliberate**, recorded
    in the registry (§5.1).
11. ~~`saveRules()` synchronously re-runs `analyze()` for all sessions~~ —
    **closed in v0.1.101** (phase 4): a 300 ms debounce, recomputing only open
    tabs and a background pass over the rest (§8.2, §15).
12. ~~The literal `["high","medium","low"]` in several places~~ — **closed**:
    all four places (`app.js` ×2 — the filter chips and the `<select>`, `rules.js`
    `fromJson()`, `ai.js` `parseFindings`) use `SEVERITIES`.
13. ~~The first analysis before tree-sitter was ready was saved as final~~ —
    **closed in v0.1.102** (phase 5): `lintPending` and an empty gen (§7).
14. **Open.** `ENGINE_FILES` in `lint.js` and `ENGINE_SCRIPTS` in
    `extension.js` are two lists; `test/lazy-engines.test.js` checks that
    they match.
15. ~~A page that has not yet received the refresh after an edit of `settings.json` can write an old value back~~ —
    **closed in v0.1.109**: the host writes only the values the page changed (§16.1).
16. ~~Host strings: the `t("…")` keys and the Russian bundle, `package.json` and two `package.nls*.json` are two
    lists each~~ — **gone in v0.1.110**: the host translation was removed (§16.5); one `package.nls.json` is left,
    and `test/vscode-integration.test.js` checks its keys against `package.json`.

## 12. How to add a new check safely (a practical checklist)

1. Decide where the finding is born: regex (`lens.js` `checks` + the name in the
   profile's `cfg.checks`), an engine (a rule in `media/lint-*.js` + an entry in its
   `*_RULE_MAP`), `Lens.gherkinChecks()`, `spec.js` or a model category
   (`AI_CATEGORIES` in `ai.js` + the prompt).
2. **Reuse an existing name if the concept is the same** (for example,
   "an action without a check" → always `no_assertion_after_action`). Then step 3
   comes down to adding the source to `sources`.
3. Add an entry to `media/checks.js` — at the end of its group: `group`,
   `severity`, `ruleKey`, `good`, `sources`. A new group goes into `GROUPS_ORDER`
   plus `g_<group>` in `i18n.js`.
4. Add the rule text (`ruleKey`) to `i18n.js`; for a regex check, also the keys
   of its messages.
5. Implement the detector.
6. `npm test`. The consistency test points out everything forgotten in steps 3–4;
   `test/finding-pipeline.test.js` is a model for an end-to-end check of one check.
   If the new check is found both by a regex and by an engine, decide `SUPERSEDES` and the kinds in
   `SAME_AS_REGEX` (§6.3): `test/rules-consistency.test.js` and `test/supersedes.test.js` fail until that is done.
7. Add the profile's name list only where the check can fire (`focused_test` is in the JavaScript profiles, not in
   qa-java): "What this profile checks" lists `cfg.checks`. Add the cases that must NOT count to the check's test, and
   if it changes what a case of `test/rule-mapping.test.js` reports, update that table.

## 13. Where to look in the code (a map of files)

| File | Responsible for |
|---|---|
| `media/checks.js` | The check registry — the source of truth for the name, group, default severity, text key, example, sources and sort priority |
| `media/rules.js` | Text/severity/on-off/groups — the "rule book" as such (the tables are computed from the registry) |
| `media/lens.js` | 29 regex checks, calibration/suppression, sorting, the Gherkin parser and checks, the `RULE_KEYS`/`RULES` Proxy, profiles (`PROFILES`/`cfg.checks`), profile details (§8.4) |
| `media/lint.js` | The engine dispatcher (`ENGINES`), mapping rule id → check name (`*_RULE_MAP`), `SUPERSEDES`, message capping; lazy loading of the engines (`ENGINE_FILES`, `ensure()`, §7) |
| `media/lint-java.js`, `lint-csharp.js`, `lint-python.js` | tree-sitter engines, their own rules, async `boot()` (called by `lint.js`, §7) |
| `media/lint-robot.js` | A line-based Robot Framework parser of its own, its own rules, synchronous |
| `media/vendor-eslint*.js` | ESLint bundles (ready-made/built), their own rules |
| `media/spec.js` | 4 checks where the specification meets the tests; which tests are found (§17) |
| `media/demo-session.js` | `LensDemo` (since v0.1.110): the made-up transcript and specification behind "Try a demo session"; imported like a picked file, with a fixed id; `test/demo-session.test.js` pins its findings |
| `media/ai.js` | 7 model review checks, prompts, the model's answer schema |
| `media/i18n.js` | All `r_<check>`/`<check>_msg`/`g_<group>` texts; `I18N.has(lang, key)` for tests |
| `test/` | `rules-consistency` (registry ↔ detectors ↔ i18n), `finding-pipeline` (one finding per source), `book-snapshot`, `render-snapshot`, `spec-extract`, `profile-info` |
| `src/webview/*.js` → `media/app.js` | The panel. `analyze()` (joining the 5 tracks), `renderRules()`, `saveRules()`, export to `CLAUDE.md`/`AGENTS.md`, UI filters by `source`. `media/app.js` is generated (§19) |
| `store.js` | Sessions in files: writing through a temporary file and rename, `rev`, summaries (`*.meta.json`), reconciliation on open (see §15) |
| `validate.js` | The trust boundary: the table of validators of webview → host messages, the storage key whitelist, checking skill paths (see §14) |
| `extension.js` | The host: webview messages, VS Code settings (`CONFIG_SETTINGS`), palette and tree commands, the Sessions tree, the Output channel, host strings through `t()` (see §16) |
| `package.nls.json` | The strings of `package.json`: commands, views, setting descriptions, the tree's welcome text (English only) |

---

## 14. The webview → host trust boundary (since v0.1.100)

The webview renders untrusted data: transcripts, imported JSON files of verdicts, model answers (including
the name and paths of a generated skill). So the host (`extension.js`) treats every message from the webview
as potentially hostile. The page's CSP blocks inline handlers, but the host's protection does not rely on the CSP.

### 14.1 What the host accepts from the webview

Every message first goes through `validate(type, payload, ctx)` from `validate.js`, before any `await` and any
action. An unknown type, a wrong field type or an exceeded limit → the answer `{ error }`, nothing else. The overall message
limit is 64 MB of JSON, one session in `session:put` up to 32 MB (`MAX_SESSION`); `clipboard:write`, `save:file` and skill
files up to 10 MB; the CLI 9.5 MB of stdin. A new message = a new row in `VALIDATORS` and a test in
`test/validate.test.js`.

Since v0.1.103 there are `page:ready` (empty payload) and `log:timing` (`event` from `TIMING_EVENTS`, `profile` from
`Lens.PROFILES`/`ALIAS`, `ms` and `events` — integers within bounds). `log:timing` has no free text, so the page
cannot write transcript content into the Output channel.

`storage:set`/`storage:get` accept only keys from `STORAGE_KEYS` (exactly the list of `store.get()` in `app.js`; a test
compares them). An unknown key rejects the whole write. **The whitelist does not make the values trusted:** the content of
`settings` is still written by the webview, so the host takes nothing from it that affects starting processes, writing
files or request addresses.

**Waiting for a reply (since v0.1.105).** `call()` in `vscode-bridge.js` gives up after a limit that depends on the
message and then resolves with `{ error, code: "bridge-timeout" }` (it never rejects; a late reply is dropped):

| Messages | Limit |
|---|---|
| `open:transcript`, `save:file`, `save:folder-files`, `baseurl:set` | none (they wait for the person) |
| `ai:call` to a provider with `local: true` | none (the host has no limit either) |
| `ai:call` to a cloud provider | 10 min + 10 s (`CLOUD_TIMEOUT_MS` in `providers.js`) |
| `claude:run`, `codex:run` | `payload.timeoutMs` (or 300 000) + 10 s |
| `claude:check`, `codex:check` | 90 s |
| `storage:get`, `session:*`, `secret:*`, `session:open` | 5 min (they wait for `host.ready`, i.e. the migrations) |
| everything else | 60 s |

The payload no longer carries `lang` (unused by the host since v0.1.103).

### 14.2 What the host takes only from its own sources

| What | Source | How it changes |
|---|---|---|
| Path to the Claude Code / Codex CLI | the settings `sessionlens.claudeCliPath` / `codexCliPath`, `scope: "machine"` (a workspace cannot set it) | the user in Settings; the `settings:open` button only opens the editor |
| Address of `local` and `qwen` | `globalState.hostBaseUrls` (not in `STORAGE_KEYS`) | `baseurl:set` + a modal confirmation; going back to the default address without a question |
| Address of the other providers | `defaultBaseUrl` in `ai.js` | does not change |
| `minGapMs`, `maxCode`, `verify`, `lint`, `rulesTarget` (since v0.1.103) | the settings `sessionlens.*`, `scope: "application"` (a workspace cannot set them) | Settings or the panel; from the panel through `storage:set`, numbers are clamped to the range (§16.1) |
| API keys | SecretStorage (phase 2) | `secret:set` / `secret:delete` |
| The folder for a skill and a file | a VS Code dialog | from the webview only the file name (`safeBasename`) and the skill paths by whitelist (`checkSkillFiles`), then `isInside` |

`storage:set` removes the fields `cliPath`, `cliPaths`, `baseUrls.local`, `baseUrls.qwen` from `settings`; `storage:get`
mixes the addresses from `hostBaseUrls` into `settings.baseUrls` only for display in the form. `ai:call` ignores
`payload.baseUrl`.

### 14.3 Rendering in `app.js`

Every interpolation into `innerHTML` is either `esc(...)`, a constant from the code, or `T(key)` **without parameters**.
`T(key, params)` inserts the parameters without escaping (it also builds text for `textContent` and Markdown), so
the result of `T()` with parameters that contain data from storage is wrapped in `esc()`. Values in attributes also go
through `esc()`. Exception: `effect()` builds markup from numbers it computes itself. The check is
`test/xss.test.js` (the real panel in jsdom, a payload in every string field, mutation checks).

### 14.4 Running a CLI on Windows

`.cmd`/`.bat` are run only through `cmd.exe` (Node ≥ 18.20.2 / 20.12.2 otherwise gives `EINVAL`). `cmd.exe` cannot
escape `"` inside quotes and expands `%VAR%` even inside them, so `buildWinCommand` escapes nothing and instead
refuses to run if a path or an argument contains `% ! ^ & | < > "` or a line break.
The system prompt is passed by the relative name `system.txt` (the cwd is a temporary folder).

### 14.5 Accepted risks

- A compromised webview can write any text to the clipboard (`clipboard:write`) and replace a provider's
  key (`secret:set`). This cannot be closed without changing the UX.
- It can also set the five settings of §16.1 to any allowed values (for example, `minGapMs = 0`). The values
  are checked by type and range, but not by meaning — as before in `globalState`.
- It can also rewrite any data in the allowed storage keys (verdicts, rules, prompts) and any session
  through `session:put`/`session:delete`/`session:clear`. The files still stay inside the sessions folder: a session id
  never becomes a path (§15.1).

---

## 15. Session storage (since v0.1.101)

### 15.1 Files

Sessions are stored in `<globalStorageUri>/sessions/`, two files per session:

| File | What is inside |
|---|---|
| `<name>.json` | the whole session and `__rev` at the end |
| `<name>.meta.json` | `Lens.sessionSummary(s)` + `rev`, `order`, `analyzedGen`, `size` |

Since v0.1.103 the summary has `nameSet` (the session was renamed by hand, §16.4). Old summaries do not have it and
do not need to be rebuilt: absent means `false`.

Since v0.1.112 the summary is `schema: 2` and has `sourceStats { check: { source: { total, ok, fp } } }`: `checkStats`
split by the finding's source (`"formal"` when it has none, a regex finding of a session analyzed before 0.1.112), with
the hidden findings of an "off" check (`calibHidden`, §5.2) counted too. Per-source calibration (phase 8) reads it.
`checkStats` stays as it was, the sum over the sources. A summary of schema 1 is rebuilt from its session once, at
`open()` (§15.3); 200 sessions of 1 MB take about 1.5 s the first time.

Since v0.1.116 the summary is `schema: 3` and has `started`: the time of the session's first step that has one (`ts`
of the event, as an ISO string), or `""` when the transcript has no times (a claude.ai export). `created` is the time
of the import, which can be weeks later. The effect of a rule moved to CLAUDE.md (`effect()`,
`src/webview/calibration.js`) puts a session before or after the day it was moved by `started`, and by `created`
only when `started` is empty. It leaves out the demo session and the sessions of a profile that cannot report the
check (`profileChecks()` in `src/webview/rules.js`, the same list the Rules filter uses); a session that could report
it and did not counts as 0. The sources are counted together: the effect is about what the agent does. A summary
of schema 2 is rebuilt once at `open()`, as for schema 1.

`<name> = fileNameFor(id)`: the id itself if it matches `^[A-Za-z0-9_-]{1,64}$`, otherwise `h-` and the 32 hex characters of
`sha256(id)`. The summary: `id, name, task, profile, created, started, reviewed, specN, verdict, findingsCount, verdictsCount,
checkStats { check: { total, ok, fp } }, sourceStats { check: { source: { total, ok, fp } } }, confirmed [{ key, check, seq, message ≤90, snippet ≤140, note }]` — everything that
Calibration, Rules, `effect()`, the profile drop-down and the Sessions tree used to take from full sessions. The summary
is computed by the **host** from the session's content; only `analyzedGen` is taken from the message (its format is checked).

The source of truth is the files. There is no index in `globalState`: the host keeps a `Map id → summary` in memory, built at
`open()`.

### 15.2 Writing

`put(session, { baseRev, analyzedGen })`: `rev` is compared with the `rev` of the summary **on disk** (another window might have
written first); a mismatch → `{ conflict: true, rev }`, nothing written. Otherwise: a temporary file
(`open`, `write`, `sync`, `close`) → `rename` for the session, then the same for the summary. `rename` on `EPERM`/`EBUSY`/`EACCES`
is retried 5 times (20…320 ms). Writes of one id in one host are queued.

### 15.3 Reconciliation at `open()`

A summary is current if it was written no earlier than the session, stores its size (two `stat`s per session; `rev` from the tail
of the file only when the times match) and has the current `schema` (3 since v0.1.116). Otherwise the summary is rebuilt from the
session file, keeping its `order` and `analyzedGen`. A summary without a session is deleted,
an unreadable session file is moved to `sessions/corrupt/`, leftover `*.tmp` files are deleted. Everything is written to the Output
channel "SessionLens".

### 15.4 Messages and refresh

`session:list` → `{ items }`, `session:get` → `{ session, rev, meta }`, `session:put` → `{ ok, rev, meta } |
{ conflict, rev } | { skipped }`, `session:delete`, `session:clear`. `storage:*` no longer accept `sessions`.

The host broadcasts `{ __slRefresh: true, scope, sessionId?, meta? }` to the other pages: `session` after writing or
deleting one session (`meta: null` — deleted), `index` after `clear`, `keys` after `storage:set`, `secret:*`,
`baseurl:set`, `focus` when a page becomes visible again (before that the host calls `refreshIfChanged()` for changes from
another window). A session tab redraws only for its own session.

Since v0.1.103 `keys` is also broadcast after a change of the `sessionlens.*` settings in VS Code — to all pages, including the one that
wrote (§16.1). In the other direction the host sends `{ __slCommand: true, name, value? }` (§16.2).

### 15.5 The page

`state.index` (all summaries) and `state.loaded` (only the sessions shown), `state.revs`, `state.gens`. Every
change of a session is `updateSession(id, fn)`: `fn` changes the session, then `put` with `baseRev`; on a conflict the session
is read again and `fn` is applied to the fresh copy (3 attempts). Exporting verdicts, examples for a skill and importing
verdicts read sessions in batches of 10 (`fetchSessions`).

### 15.6 Migration

On activation, in the `host.ready` chain: if `storageVersion < 2`, every session from `globalState.sessions`
is written with `rev = 1` and the `analyzedGen` of the current rules, read back and compared with the original. A session whose
file already exists with `rev > 1` (changed after an interrupted migration) is not overwritten. Then
`storageVersion = 2`, and only after that the `sessions` key is deleted. An error → the key stays, a message with an
"Open log" button, the next start retries. Restoring a session tab and the tree wait for `host.ready`.

After the migration, versions ≤ 0.1.100 see no sessions (they are in files). There is no backup copy in `globalState`: its size
was the problem in the first place.

---

## 16. VS Code integration (since v0.1.103)

### 16.1 Settings

`CONFIG_SETTINGS` in `extension.js`: `minGapMs` (0…600000), `maxCode` (1000…2000000), `verify`, `lint`,
`rulesTarget` (`claude | codex | both`). In `package.json`, `scope: "application"`: Settings Sync carries them,
a project's `.vscode/settings.json` does not change them. Otherwise two windows with different `lint` would take turns re-analysing the shared
sessions (`lint` is part of `analysisGen`).

The panel (`app.js`) does not know about VS Code settings; it sees them inside `settings`:

- `storage:get`: the values **set** in the user settings (`inspect().globalValue`) are laid over `settings` from `globalState`.
  An unset value is not filled in: in `ai.js` a missing `minGapMs`/`maxCode` means something else
  (a local server: 0 and 12000) than the default value. An unsuitable value is skipped, a number out of range is
  clamped to the bound; both cases are written to the Output channel on a change.
- `storage:set`: each of the five fields that differs from the configured one is written to `ConfigurationTarget.Global`;
  they are removed from `globalState.settings`. A field that failed to be written stays in `globalState`.
  The page sends all five with every save, changed or not. Since v0.1.109 `wireMessages` keeps, per page, the values
  that page last saw (`knownConfig`: its last `storage:get`, then its own successful writes), and a field equal to
  that is not written: it is the page's old copy, and writing it would undo an edit of `settings.json` whose refresh
  has not reached the page yet. A page that has not read the settings yet falls back to "differs from the configured".
- `onDidChangeConfiguration` for any of the five keys → `__slRefresh { scope: "keys" }` to all pages. The path
  is the same as after saving the form: `loadKeys()`, `ensureFresh()` of the open session, the background pass.
- The migration `migrateSettingsToConfig` in `host.ready` after `migrateHostOwned`: values from `globalState.settings`
  are moved if the user has not set them; a field is removed only after a successful write. `migrateSessions`
  takes `lint` from the settings (`lintEnabled()`).

`profile` stays in `globalState`: it is the last value of the drop-down, not a setting.

### 16.2 Commands

| Command | Where it runs |
|---|---|
| `sessionlens.importTranscript`, `sessionlens.exportVerdicts` | the sidebar: with the same code as its buttons |
| `sessionlens.openSession` | the host: a QuickPick over `store.list()` |
| `sessionlens.openSettings` | the host: `"@ext:" + context.extension.id` (since v0.1.106) |
| `sessionlens.openSessionFromTree`, `renameSession`, `deleteSession` | the host; hidden in the palette, in the tree menu |

A command for the sidebar: `sessionlensView.focus`, waiting for `page:ready` (up to 10 s), then
`postMessage({ __slCommand: true, name })`. The page sends `page:ready` after loading and on a `focus` refresh;
the host resets readiness when the view is hidden or closed (without `retainContextWhenHidden` the page is unloaded).
`vscode-bridge.js` lets through only the names `import`, `exportVerdicts`, `rename`; `SL_COMMAND` in `app.js` decides
what to do: the sidebar handles import and export, a session tab only renames its own session.

**Rename from the tree.** If the session is open in a tab, the host hands `rename` to the tab: it has its own copy and its own
`baseRev`, and a write around it would cause a conflict. Otherwise the host reads the session, sets `name` and `nameSet`, writes with
`baseRev` (3 attempts), broadcasts `session`. **Delete** — a modal confirmation, closing the tab, `store.delete`,
broadcasting `meta: null`.

### 16.3 The Sessions tree

Second in the container, under the webview `sessionlensView` (since 0.1.104; in 0.1.103 it was first). If the user has
changed the order of the views, VS Code keeps their order, and there is no API to change it. `when`: `sessionlens.activeTab == 'sessions' || !sessionlens.activeTab`. The context is set
only by the page (`tab:active`); the host resets it to `""` when the panel is hidden or closed, so the tree is visible
until the page's first message and while the panel is collapsed. Items have an `id` (the menu commands receive it). An empty
tree shows `viewsWelcome` with an import button.

### 16.4 The session name

`Lens.displayName(s)`: `name` if `nameSet`, otherwise `task || name || id`. `Lens.otherName(s)` is the second line and
the tooltip. One function for the tab title (on opening, on restoring after a restart and after every
`session:put`), the tree, the QuickPick, the list and the panel header. Export file names still come from `task || name`.

### 16.5 The host language

English, whatever the language of VS Code, like the panel (`i18n.js`). From v0.1.103 to v0.1.109 the host followed
`vscode.env.language` and had a Russian translation (`l10n/bundle.l10n.ru.json`, `package.nls.ru.json`); v0.1.110
removed it, because a Russian frame around the English panel mixed two languages in one view, and the panel is not
translated (the owner's decision: rules for `CLAUDE.md` and model prompts are English anyway, and a verdict's key
contains the finding's text). `t(message, ...args)` only fills `{0}`, `{1}`…; `countLabel()` has English forms. The
strings of `package.json` are in `package.nls.json`. Russian recognition patterns in `lens.js`, `spec.js` and `ai.js`
stay: they read what a person wrote in a transcript, they do not translate anything.

### 16.6 Output channel

The "SessionLens" channel: migrations (keys, sessions, settings), the store, `validate.js` refusals, settings changes (key
names only), CLI errors (which CLI, the code, the time; text only for `notfound` and `timeout`, where it is a path or
seconds), `log:timing` (`analysis (import): qa-ts, 120 events, 34 ms`), a timeout of a command for the sidebar. There is no
transcript text, prompts, model answers or keys in it (checked by `test/vscode-integration.test.js`).

## 17. Specification coverage: which tests are found (since v0.1.104)

In `spec.js`, `extractorFor(language, file)` decides how a file is read: by the profile's language, and for `api`, `mobile`, `any`
by the file's extension. The extractors (`EXTRACT` and `robotTests`): `typescript` (also `cypress`, `detox`), `python`,
`java`, `kotlin` (`.kt`/`.kts`, also in `qa-java`), `csharp`, `go`, `karate` (`.feature`), `robot`
(the `*** Test Cases ***` and `*** Tasks ***` sections). Code without a known extension (the text of a message): `api` reads it
as TS/JS (as in 0.1.103), `mobile` and `any` try all of their syntaxes. The result `null` means "this file
cannot be read": it does not take part in coverage. If a session has no readable file at all, `coverage()` returns
`null`, `checks()` raises neither `spec_uncovered` nor `test_without_requirement`, and the panel shows `no_readable_tests`.

The `typescript` extractor takes `it(…)`/`test(…)` with a title, also with a modifier that still makes a test (`.only`,
`.skip`, `.fixme`, `.fail`, `.slow`, `.concurrent`, `.todo`), and not as the end of another word. A body stops at the
next test or a `describe`/`context` block. Up to 0.1.109 any `test.<word>(` counted, so `test.describe("…")` was a test
named after the block (a false `test_without_requirement` in nearly every Playwright file), and a `test.skip(…)` after
a test was swallowed by that test's body.
`no_spec` works as before.

Before 0.1.104 everything without a pattern of its own was silently read with the Python pattern, no tests were found, and every
requirement got a false `spec_uncovered` (High): qa-cypress, qa-detox, qa-mobile, qa-robot, qa-generic and
Kotlin files.

A test's body runs to the next test's first line, so it also takes the comment right above the next test. Up to 0.1.107
that comment stayed there: in the Java-like syntaxes, TypeScript, Go and Karate the second and later tests lost the ID
in their comment, and a short first test could take it. Since 0.1.108 `extract()` hands the comment lines at the end of
a body (`COMMENT_LINE`, the same prefixes as each pattern's leading group) to the next test when that test starts
right after them. A comment separated from the test by a blank line still belongs to no test, as for the first test.
Python needs none of this: its body is the indented lines only.

`supports(language, file)` is the same decision as `true`/`false`; `Lens.profileInfo()` uses it (§8.4).

## 18. One code path: VS Code only (since v0.1.105)

Support for the Chrome version was dropped in phase 7. The page (`app.js`, `ai.js`, `lint.js`) no longer checks
whether a bridge function exists: sessions are always kept by the host (`store.js`), API keys always live in
SecretStorage and provider requests always go through the host (`ai:call`); `ai.js` throws if there is no transport
instead of calling a provider from the page. Files are picked and saved only through VS Code dialogs. The panel no
longer renders a session list of its own; the native Sessions tree lists and opens sessions. `vscode-bridge.js` keeps
a `chrome.storage.local`-shaped adapter for the small keys (renaming it was left out to keep the diff small). The tests
run the panel only through `test/host-panel.js`; `test/dom-harness.js` and the two Chrome-only tests were removed.

## 19. The panel's source and its build (since v0.1.105)

The panel is written as ES modules in `src/webview/` and bundled by esbuild (`npm run build`,
`scripts/build-webview.js`) into `media/app.js`: one IIFE, not minified, no source map. `sidepanel.html`,
`SCRIPT_FILES` in `extension.js`, the CSP and `test/host-panel.js` therefore still see one classic script, loaded after
the other `media/*.js` files, whose globals (`Lens`, `LensLint`, `I18N`, …) the modules use as before. `media/app.js`
is committed; CI runs `npm run build:check`, which fails when it is not what the sources build to. Line endings are LF
everywhere (`.gitattributes`), so the check gives the same answer on Windows.

| Module | What it holds (the sections of the former single app.js) |
|---|---|
| `common.js` | helpers (`$`, `esc`, `T`), theme, the small-keys store, `state` |
| `store.js` | sessions in the host's store, `updateSession`, the background pass, calibration stats |
| `analysis.js` | `analyze()` / `analyzeNow()` |
| `sessions.js` | navigation, import, the Sessions tab and the profile details (§8.4) |
| `review.js` | a session's tab: review, specification, model segmentation |
| `calibration.js` | export of verdicts and the Calibration tab |
| `rules.js`, `prompts.js`, `settings.js` | the Rules, Model rules and ⚙ Settings tabs |
| `main.js` | start-up (`boot`), refresh from the host, commands |
| `index.js` | the entry: calls every module's `init<Name>()` in the original order |

**Order.** Each module keeps its top-level statements in `init<Name>()`; `index.js` calls them in the order the single
file ran them. The module-level variables are `export let`s assigned there. Functions are plain exports (hoisted), so
a module may call a function of a later one. A variable is assigned only in the module that declares it (an import
is read-only; esbuild refuses a build that breaks this). `state` is never reassigned, only its fields.

The split was mechanical (every statement moved as it was, comments with it); the render snapshots and the whole
test suite did not change, except two tests that patch or read the source text of `media/app.js`, which now follow its
built form.

## 20. Checks around the code (since v0.1.105)

| Command | What it checks | In CI |
|---|---|---|
| `npm test` | unit and DOM tests (`test/`, jsdom, fake `vscode`) | ubuntu, windows, macos |
| `npm run lint` | ESLint on our own code (`eslint.config.js`; vendored bundles and the generated `media/app.js` excluded), `max-len` 160 except strings, templates, regexes and URLs | yes |
| `npm run format:check` | Prettier, `printWidth` 160 (`.prettierrc.json`) | yes |
| `npm run typecheck` | `tsc` with `checkJs` (`tsconfig.json`, loose: `strict` off); page globals in `types/webview-globals.d.ts`; every own file starts with `// @ts-check` | yes |
| `npm run build:check` | `media/app.js` is what `src/webview` builds to (§19) | yes |
| `npm run check:vsix` | the files `vsce` would package match an allow-list (`scripts/check-vsix.js`): run-time files only, no sources, tests, configs, screenshots or source maps | yes |
| `npm run test:integration` | a real VS Code (`@vscode/test-electron`, `test-integration/`): activation, commands, view order, the migrations of phases 4 and 6 on data written in the old formats, opening a session tab, refusals of `validate.js` | yes (Linux under `xvfb-run`) |
| `node scripts/release-notes.js vX.Y.Z` | the tag is the version in `package.json` and `CHANGELOG.md` has its section; prints the release notes | the release workflow (a tag `v*`) |

The integration tests reach the extension through `activate()`'s return value, which exists only when
`SESSIONLENS_TEST=1` (`testApi()` in `extension.js`): the `globalState`, `runMigrations()` (the same chain `host.ready`
runs, extracted into one function) and `send(type, payload)`, which goes through `wireMessages()` like a webview message.

## 21. Checks of what the agent did to the suite (since v0.1.113)

Phase 10 added four regex checks that look at the agent's actions rather than at one file's text. They share three
helpers in `lens.js`: `redRunBefore(ev, seq)` (the last test run before `seq`, if it was red; it makes a finding
high and adds "right after a failing run (seq N)" to the message), `TEST_FILE_RX` (a test file by its name) and
`TEST_SIDE_RX` (fixtures, helpers, page objects, mocks, support, `conftest.py`).

| Check | Group | What it compares | Not a finding |
|---|---|---|---|
| `test_deleted` | code | the tests (`blocksByTest`) of two consecutive versions of a file the session saw; `rm`/`git rm`/`unlink`/`del`/`Remove-Item` of a test file or folder; a `delete` event | a test renamed with the same body, moved to another file, or restored later; `rm` of files that are not tests; a file first seen as an edit fragment |
| `product_code_edited` | process | a write or an edit of a file in the profile's `src_dirs` (anywhere in the path: Claude Code started in a parent folder writes `shop/src/…`) | test-side code inside `src`, a runner config, a file named in the approved plan |
| `snapshot_overwritten` | process | a test run with an update flag after the runner (`jest -u`, `--update-snapshots`, `--snapshot-update`, `UPDATE_SNAPSHOTS=1`); a snapshot or baseline file written by hand | `-u` of another command (`env -u`, `git push -u`), a runner named in a heredoc or a string |
| `config_weakened` | process | a runner config with its previous text: more retries, a longer timeout (each in source order), a new line excluding tests, a new line ignoring failures or skipping the tests (since 0.1.114: `testFailureIgnore`, `skipTests`, `ignoreFailures`) | a shorter timeout, an unrelated change; a config seen for the first time counts only for its retries; in a `pom.xml` anything outside the surefire and failsafe plugins and `<properties>`, in a Gradle script anything outside the blocks of test tasks |

What the import keeps for them:

- **`delete` events.** A deleted file in a Codex patch (`patch_apply_end`, `type: "delete"`) is an event
  `{ kind: "delete", file }`; until 0.1.113 it was dropped. Claude Code has no delete tool: there a deletion is a
  shell command, read by `test_deleted` itself.
- **`prev_content`.** For a runner config (`isRunnerConfig()`: `*.config.*`, `*.conf.*`, `.detoxrc*`, `.mocharc*`,
  `pytest.ini`, `tox.ini`, `setup.cfg`, `pyproject.toml`, and since 0.1.114 `pom.xml`, `build.gradle(.kts)`,
  `*.runsettings`) and a test file (`isTestFile()`: `TEST_FILE_RX` or one of the profile's `test_dirs` anywhere in the
  path) the import keeps the file's previous text on the write or edit event, from its own replay or from
  `toolUseResult.originalFile`. So the first edit of a file that existed before the session is compared too: a config
  in the demo, a failing test someone else wrote and the agent cut out. The event may still be `fragment_only` (the
  Edit started as a fragment); `prev_content` wins over that flag.
- **`config_content`.** `stripNonSource()` drops the text of files that are not code. For the runner configs that are
  not code (`TEXT_RUNNER_CONFIG_RX`: the four Python files, and since 0.1.114 `pom.xml`, `build.gradle(.kts)` and
  `*.runsettings`; `config_weakened` is in qa-java and qa-c# since then) it moves `new_content` to `config_content`
  instead: `config_weakened` reads it, the code checks do not (`xfail_strict = true` must not be an expected failure).
- **Stored sessions.** `test_deleted` and `product_code_edited` read what every stored session already has
  (`new_content`, the file names), so they work on a session saved before 0.1.113 — except a deletion in the first
  edit of a file, which needs `prev_content`, like `config_weakened` for a config the session only edited; a Codex
  deletion needs the `delete` event. These come with a new import.
- **Import again (since 0.1.114).** A session records the `importGen` it was imported with (`Lens.IMPORT_GEN`, 2;
  none for an import before 0.1.114). `Lens.needsReimport(s)` is true for a session without it that wrote or edited
  a test file or a runner config and has no `prev_content` and no `delete` event; the session's tab then shows
  **Import again** (`reimport()` in `src/webview/review.js`). It parses `source_text`, or a file picked again when
  the transcript was too large to keep (400 KB), into the same session (`Lens.pickConversation()` takes the session's
  own conversation of a file with several; "Back to regex parsing" uses it too since 0.1.115): id, name, spec and verdicts stay, `events`
  are replaced, the model's segmentation is dropped. `Lens.transcriptMatch()` (the share of the stored steps the new
  import repeats, in order) below 0.8 asks first; so do verdicts that would no longer match a finding, since a verdict
  is keyed by `seq` and a Codex `delete` event shifts the steps after it. A session imported with 0.1.113 that only
  wrote new files looks old too; importing it again changes nothing but `importGen`.

Retries in a runner config are `config_weakened`, not `sleep_or_skip_added` (`sleep_or_skip_added` skips runner
configs); retries on one test (`describe.configure({ retries })`, `@flaky`, `[Retry]`) stay `sleep_or_skip_added`.
`hardcoded_base_url` skips runner configs too: `baseURL` in `playwright.config.ts` is what its rule asks for.
