// @ts-check
/* Browser linter layer for qa-ts, qa-cypress and qa-detox.
   vendor-eslint.js is a prebuilt bundle (see vendor/BUILD.md): ESLint's Linter + eslint-plugin-playwright,
   with TypeScript handled by stripping types first — line numbers stay identical to the original source.
   vendor-eslint-cypress.js is a second, independent bundle — ESLint's Linter + eslint-plugin-cypress —
   used for the qa-cypress profile; see ENGINES below for how a profile picks its bundle and rule map.
   vendor-eslint-detox.js is a third bundle — ESLint's Linter + our own hand-authored rules (the upstream
   eslint-plugin-detox package has zero real rules, only a globals declaration, so there is nothing to
   bundle from it — see src.js in vendor-build/detox for the rules themselves).
   If a profile's bundle is absent or throws, nothing happens: the regex checks stay as they are.
   Phase 5: the engines are not <script>s of the page any more. ensure(language) loads the files one language needs
   (ENGINE_FILES), boots a tree-sitter engine, and reports "ready", "none" (no engine for that language) or "failed".
   While an engine that is going to load is not ready yet, run() says so ({ pending: true }, note lint_loading)
   instead of reporting a result, and app.js does not count such an analysis as done (analysisGen ""). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else /** @type {any} */ (root).LensLint = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const T = (k, v) => (typeof I18N !== "undefined" ? I18N : require("./i18n.js")).t(k, v);

  // eslint rule → (our check, severity). Unmapped rules report as lint_<rule> / medium.
  const RULE_MAP = {
    "playwright/no-wait-for-timeout": ["sleep_or_skip_added", "high"],
    "playwright/no-skipped-test": ["sleep_or_skip_added", "high"],
    "playwright/no-focused-test": ["sleep_or_skip_added", "high"],
    "playwright/no-networkidle": ["fragile_wait", "medium"],
    "playwright/expect-expect": ["weak_assert", "high"],
    "playwright/no-useless-not": ["weak_assert", "low"],
    "playwright/valid-expect": ["weak_assert", "medium"],
    "playwright/no-standalone-expect": ["weak_assert", "medium"],
    "playwright/no-conditional-in-test": ["conditional_logic", "low"],
    "playwright/no-conditional-expect": ["conditional_logic", "medium"],
    "playwright/no-element-handle": ["fragile_wait", "low"],
    "playwright/no-force-option": ["fragile_wait", "low"],
    "playwright/no-eval": ["fragile_wait", "low"],
    "playwright/no-page-pause": ["fragile_wait", "medium"],
    "playwright/no-wait-for-selector": ["fragile_wait", "low"],
    "playwright/max-nested-describe": ["conditional_logic", "low"],
    "playwright/no-duplicate-hooks": ["duplicate_assert", "low"],
    "playwright/no-nested-step": ["conditional_logic", "low"],
    "playwright/no-unsafe-references": ["fragile_wait", "medium"],
    "playwright/valid-title": ["lint_valid_title", "low"],
    // brittle by our own standard: a CSS selector is a guess about markup, a positional pick depends on order
    "playwright/no-raw-locators": ["raw_locator", "low"],
    "playwright/no-nth-methods": ["positional_locator", "low"],
  };
  // Same idea, for Cypress specs: eslint-plugin-cypress rule → (our check, severity), via the
  // separate vendor-eslint-cypress.js bundle (its own copy of ESLint's Linter — small and easy to
  // keep independent of the Playwright bundle, rather than rebuilding that one to add a plugin it
  // was never built with).
  const CYPRESS_RULE_MAP = {
    "cypress/no-unnecessary-waiting": ["sleep_or_skip_added", "high"],
    "cypress/no-pause": ["sleep_or_skip_added", "high"],
    "cypress/no-force": ["fragile_wait", "medium"],
    "cypress/no-async-tests": ["weak_assert", "medium"],
    "cypress/no-async-before": ["weak_assert", "medium"],
    "cypress/assertion-before-screenshot": ["weak_assert", "low"],
    "cypress/no-assigning-return-values": ["fragile_wait", "low"],
    "cypress/unsafe-to-chain-command": ["fragile_wait", "medium"],
    "cypress/no-chained-get": ["raw_locator", "low"],
    "cypress/no-xpath": ["raw_locator", "low"],
    "cypress/require-data-selectors": ["raw_locator", "low"],
    "cypress/no-and": ["conditional_logic", "low"],
    "cypress/no-debug": ["fragile_wait", "low"],
  };
  // Same idea, for Detox specs: our own rule ids (vendor-eslint-detox.js — hand-authored, no upstream
  // plugin has real rules for Detox) → (our check, severity).
  const DETOX_RULE_MAP = {
    "detox/no-hardcoded-wait": ["sleep_or_skip_added", "high"],
    "detox/waitfor-requires-timeout": ["fragile_wait", "medium"],
    // index-based disambiguation is the same brittleness as a positional locator elsewhere
    "detox/no-index-matcher": ["positional_locator", "low"],
    "detox/expect-after-action": ["no_assertion_after_action", "high"],
    "detox/require-reload-before-each": ["no_app_reset", "medium"],
  };
  // Same idea again, for Java specs: media/lint-java.js's own rule ids (a tree-sitter-based engine, not
  // ESLint — see that file's header for why it exposes the identical {lint,RULES} shape anyway) →
  // (our check, severity). no-assertion-after-action reuses the same check name Detox's engine reports —
  // same concept (action with no assertion), same severity, different language underneath.
  const JAVA_RULE_MAP = {
    "java/unannotated-test-method": ["unannotated_test_method", "high"],
    "java/no-assertion-after-action": ["no_assertion_after_action", "high"],
    "java/swallowed-exception": ["swallowed_exception", "high"],
    "java/assert-args-reversed": ["assert_args_reversed", "medium"],
  };
  // Same rule vocabulary again for C# (media/lint-csharp.js) — the concepts (missing test attribute,
  // action with no assertion, empty catch, reversed assertEquals args) transfer directly from Java, so
  // the same four check names are reused rather than inventing csharp-flavoured ones.
  const CSHARP_RULE_MAP = {
    "csharp/unannotated-test-method": ["unannotated_test_method", "high"],
    "csharp/no-assertion-after-action": ["no_assertion_after_action", "high"],
    "csharp/swallowed-exception": ["swallowed_exception", "high"],
    "csharp/assert-args-reversed": ["assert_args_reversed", "medium"],
  };
  // Python (media/lint-python.js) only reuses three of the four — pytest's name-based test collection
  // has no missing-annotation smell to detect, so there is no python/unannotated-test-method rule at all.
  const PYTHON_RULE_MAP = {
    "python/no-assertion-after-action": ["no_assertion_after_action", "high"],
    "python/swallowed-exception": ["swallowed_exception", "high"],
    "python/assert-args-reversed": ["assert_args_reversed", "medium"],
  };
  // Robot Framework (media/lint-robot.js) — a hand-written parser, not tree-sitter or ESLint (see that
  // file's header), still mapped the same way: three of the four reuse existing check vocabulary
  // (sleep/skip, no-assertion-after-action, and Gherkin's own duplicate_step_text — the "two things share
  // the exact same steps" concept transfers verbatim); only empty_test_case is genuinely new.
  const ROBOT_RULE_MAP = {
    "robot/empty-test-case": ["empty_test_case", "high"],
    "robot/no-assertion-after-action": ["no_assertion_after_action", "high"],
    "robot/sleep-or-skip": ["sleep_or_skip_added", "high"],
    "robot/duplicate-steps": ["duplicate_step_text", "low"],
  };
  // Which vendor bundle + rule map a profile's language uses. Both bundles expose the identical
  // lint(code, {rules, filename}) -> {messages, error} shape, so run()/merge() below don't need to
  // know which one they're calling.
  const ENGINES = {
    typescript: { core: () => (typeof LensLintCore !== "undefined" ? LensLintCore : null), map: RULE_MAP },
    javascript: { core: () => (typeof LensLintCore !== "undefined" ? LensLintCore : null), map: RULE_MAP },
    cypress: { core: () => (typeof LensLintCypress !== "undefined" ? LensLintCypress : null), map: CYPRESS_RULE_MAP },
    detox: { core: () => (typeof LensLintDetox !== "undefined" ? LensLintDetox : null), map: DETOX_RULE_MAP },
    java: { core: () => (typeof LensLintJava !== "undefined" ? LensLintJava : null), map: JAVA_RULE_MAP },
    csharp: { core: () => (typeof LensLintCSharp !== "undefined" ? LensLintCSharp : null), map: CSHARP_RULE_MAP },
    python: { core: () => (typeof LensLintPython !== "undefined" ? LensLintPython : null), map: PYTHON_RULE_MAP },
    robot: { core: () => (typeof LensLintRobot !== "undefined" ? LensLintRobot : null), map: ROBOT_RULE_MAP },
  };
  // regex checks an engine can do better — dropped when it ran, so nothing is reported twice. Only where the engine of
  // the profile's language looks for the same thing itself (SAME_AS_REGEX): Java, C# and Python have no rule for sleeps
  // or skips, so their regex findings must stay (until 0.1.113 any engine that parsed the file dropped them all).
  const SUPERSEDES = new Set(["sleep_or_skip_added", "fragile_wait", "conditional_logic", "duplicate_assert"]);
  /* engine rule → the kinds of regex finding ("check|kind", Lens sets kind on these four checks) it finds just as well.
     An engine rule reported under one of these names but looking for something else (cypress/no-pause, cypress/no-and,
     detox/waitfor-requires-timeout, playwright/no-duplicate-hooks…) replaces nothing: [] — listed, so that a new rule
     has to be decided (test/supersedes.test.js). Nothing replaces a duplicated assertion or an exact element count. */
  const SAME_AS_REGEX = {
    "playwright/no-wait-for-timeout": ["sleep_or_skip_added|sleep"],
    "playwright/no-skipped-test": ["sleep_or_skip_added|skip"],
    "playwright/no-focused-test": ["sleep_or_skip_added|skip"],
    "playwright/no-networkidle": ["fragile_wait|networkidle"],
    "playwright/no-conditional-in-test": ["conditional_logic|branch"],
    "cypress/no-unnecessary-waiting": ["sleep_or_skip_added|sleep"],
    "detox/no-hardcoded-wait": ["sleep_or_skip_added|sleep"],
    "robot/sleep-or-skip": ["sleep_or_skip_added|sleep", "sleep_or_skip_added|skip"],
    // reported under these names, but looking for something else: they replace no regex finding
    "playwright/no-conditional-expect": [],
    "playwright/max-nested-describe": [],
    "playwright/no-nested-step": [],
    "playwright/no-duplicate-hooks": [],
    "playwright/no-element-handle": [],
    "playwright/no-force-option": [],
    "playwright/no-eval": [],
    "playwright/no-page-pause": [],
    "playwright/no-wait-for-selector": [],
    "playwright/no-unsafe-references": [],
    "cypress/no-pause": [],
    "cypress/no-force": [],
    "cypress/no-assigning-return-values": [],
    "cypress/unsafe-to-chain-command": [],
    "cypress/no-and": [],
    "cypress/no-debug": [],
    "detox/waitfor-requires-timeout": [],
  };
  // → Set of "check|kind" the engine of `language` finds itself: what merge() may drop
  function covers(language) {
    const engine = ENGINES[language];
    const out = new Set();
    if (engine) for (const ruleId of Object.keys(engine.map)) for (const k of SAME_AS_REGEX[ruleId] || []) out.add(k);
    return out;
  }

  // ---------- lazy loading (phase 5) ----------
  // Which files a language's engine needs, in load order. robot is not here: lint-robot.js is small, synchronous and
  // part of the page. api, mobile, any and go have no engine at all.
  const ENGINE_FILES = {
    typescript: { js: ["vendor-eslint.js"] },
    javascript: { js: ["vendor-eslint.js"] },
    cypress: { js: ["vendor-eslint-cypress.js"] },
    detox: { js: ["vendor-eslint-detox.js"] },
    java: { js: ["tree-sitter.js", "lint-java.js"], boot: "java" },
    csharp: { js: ["tree-sitter.js", "lint-csharp.js"], boot: "csharp" },
    python: { js: ["tree-sitter.js", "lint-python.js"], boot: "python" },
  };
  const G = typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : this;
  // Options for a tree-sitter engine's boot(): the WASM URIs vscode-bridge.js read from <body>. Without them (a page
  // extension.js did not build) the engine is not booted and ensure() reports it as "failed".
  const BOOT_OPTS = {
    java: () => G.SL_WASM_URIS_JAVA && { locateCore: () => G.SL_WASM_URIS_JAVA.core, javaWasmUrl: G.SL_WASM_URIS_JAVA.java },
    csharp: () => G.SL_WASM_URIS_CSHARP && { locateCore: () => G.SL_WASM_URIS_CSHARP.core, csharpWasmUrl: G.SL_WASM_URIS_CSHARP.csharp },
    python: () => G.SL_WASM_URIS_PYTHON && { locateCore: () => G.SL_WASM_URIS_PYTHON.core, pythonWasmUrl: G.SL_WASM_URIS_PYTHON.python },
  };
  // A page loads engines; Node (tests, the host) does not: there an engine is present as a global or not at all.
  const LOADER = typeof document !== "undefined" && typeof document.createElement === "function";
  const ENGINE_TIMEOUT_MS = 30000;
  const engineStates = {},
    enginePromises = {},
    scriptPromises = {};

  // "none" (no engine for the language) | "static" (Node: no loader) | "idle" | "loading" | "ready" | "failed"
  function engineState(language) {
    if (!ENGINE_FILES[language]) return "none";
    if (!LOADER) return "static";
    return engineStates[language] || "idle";
  }
  // an engine that is not ready yet but is going to be loaded in this page
  const mayLoad = (language) => {
    const st = engineState(language);
    return st === "idle" || st === "loading";
  };

  // extension.js hands the webview URIs over as data-engines (vscode-bridge.js → SL_ENGINE_URIS); without them the file
  // name is used as it is, relative to sidepanel.html
  const urlOf = (file) => (G.SL_ENGINE_URIS && G.SL_ENGINE_URIS[file]) || file;
  // One <script> per file per page (tree-sitter.js is shared by three languages). A file that failed is not retried.
  function loadScript(file) {
    if (!scriptPromises[file])
      scriptPromises[file] = new Promise((resolve, reject) => {
        const el = document.createElement("script");
        el.src = urlOf(file);
        el.async = false;
        el.onload = () => resolve();
        el.onerror = () => reject(new Error(`${file} did not load`));
        (document.head || document.documentElement).appendChild(el);
      });
    return scriptPromises[file];
  }
  function announce(language, st) {
    if (typeof G.dispatchEvent !== "function" || typeof G.CustomEvent !== "function") return;
    G.dispatchEvent(new G.CustomEvent(st === "ready" ? "sl:engine-ready" : "sl:engine-failed", { detail: { language, state: st } }));
  }
  /* Loads and boots the engine of a language, once per page. → Promise of "ready" | "none" | "failed" (Node: "static"). */
  function ensure(language) {
    if (!ENGINE_FILES[language]) return Promise.resolve("none");
    if (!LOADER) return Promise.resolve("static");
    if (enginePromises[language]) return enginePromises[language];
    engineStates[language] = "loading";
    const spec = ENGINE_FILES[language],
      engine = ENGINES[language];
    const work = (async () => {
      if (!engine.core()) for (const f of spec.js) await loadScript(f);
      const core = engine.core();
      if (!core || typeof core.lint !== "function") return "failed";
      if (spec.boot && typeof core.isReady === "function" && !core.isReady()) {
        const opts = BOOT_OPTS[spec.boot]();
        if (!opts) return "failed";
        await core.boot(opts);
        if (!core.isReady()) return "failed";
      }
      return "ready";
    })().catch((e) => {
      if (typeof console !== "undefined") console.warn(`SessionLens: the ${language} engine did not load: ${(e && e.message) || e}`);
      return "failed";
    });
    let final = null;
    // first result wins; after a timeout ("failed") only a late "ready" changes it
    const settle = (st) => {
      if (final === "ready" || (final && st !== "ready")) return;
      final = st;
      engineStates[language] = st;
      announce(language, st);
    };
    // a late success after the timeout still makes the engine usable
    work.then(settle);
    let timer = null;
    const timeout = new Promise((r) => {
      timer = setTimeout(() => r("failed"), ENGINE_TIMEOUT_MS);
    });
    enginePromises[language] = Promise.race([work, timeout]).then((st) => {
      clearTimeout(timer);
      settle(st);
      return engineStates[language];
    });
    return enginePromises[language];
  }

  const available = (language) => {
    const e = ENGINES[language || "typescript"];
    return !!(e && e.core() && typeof e.core().lint === "function");
  };

  function rulesConfig(map, extra) {
    const rules = {};
    for (const r of Object.keys(map)) rules[r] = "warn";
    for (const r of extra || []) rules[r] = "warn";
    return rules;
  }

  // one block per file — its last version; linting every intermediate edit would repeat the same findings
  function codeBlocks(session, cfg) {
    // a session writes config, docs and lockfiles too — only source files go to the linter
    const isSource = (name) => {
      const ext = (cfg.code_ext || []).find((x) => name.endsWith(x));
      return !!ext && !/\.(?:json|jsonc|md|txt|ya?ml|lock|gitignore|env)$/i.test(name);
    };
    const byName = new Map();
    for (const e of session.events) {
      if (!e.new_content) continue;
      const name = e.file || `${T("in_msg")} (seq ${e.seq})`;
      if (e.file && !isSource(name)) continue; // code shown in a message has no name: keep it
      byName.set(name, { seq: e.seq, name, code: e.new_content });
    }
    return [...byName.values()];
  }

  /* Lint every code block of the session. Returns { findings, note, ran } and, while the engine is still loading in
     this page, pending: true (note lint_loading) — the result is then not final. */
  function run(session, cfg, settings) {
    const engine = ENGINES[cfg.language];
    if (!engine) return { findings: [], note: T("lint_profile"), ran: false };
    const core = engine.core();
    const loading = () => ({ findings: [], note: T("lint_loading"), ran: false, pending: true });
    if (!core && !mayLoad(cfg.language)) return { findings: [], note: T("lint_missing"), ran: false };
    const blocks = codeBlocks(session, cfg);
    if (!core) return blocks.length ? loading() : { findings: [], note: T("lint_missing"), ran: false };
    if (!blocks.length) return { findings: [], note: T("lint_nocode"), ran: false };
    // a tree-sitter engine whose file is here but whose boot() has not finished
    if (typeof core.isReady === "function" && !core.isReady() && !(typeof core.bootError === "function" && core.bootError()) && mayLoad(cfg.language))
      return loading();
    const rules = rulesConfig(engine.map, (settings && settings.lintExtraRules) || []);
    const findings = [];
    let errors = 0,
      parsed = 0;
    const why = [];
    for (const b of blocks) {
      let r;
      try {
        r = core.lint(b.code, { rules, filename: b.name });
      } catch (e) {
        const msg = String((e && e.message) || e);
        // Manifest V3 forbids new Function; the bundle avoids it, so this means an old vendor-eslint.js is cached
        if (/Content Security|Evaluating a string as JavaScript|unsafe-eval/i.test(msg))
          return { findings: [], ran: false, errors: blocks.length, why: [msg.slice(0, 200)], note: T("lint_csp") };
        errors++;
        why.push(`${b.name}: ${msg.slice(0, 160)}`);
        continue;
      }
      if (r.error) {
        errors++;
        why.push(`${b.name}: ${String(r.error).slice(0, 160)}`);
        continue;
      }
      let fatal = false;
      const lines = b.code.split("\n");
      const context = (n) =>
        lines
          .slice(Math.max(0, n - 3), n + 2)
          .map((l, i) => `${Math.max(1, n - 2) + i}${Math.max(1, n - 2) + i === n ? " ▸" : "  "} ${l}`.slice(0, 160))
          .join("\n");
      for (const m of r.messages) {
        if (m.fatal) {
          fatal = true;
          errors++;
          why.push(`${b.name}:${m.line} ${m.message}`.slice(0, 160));
          continue;
        }
        const [check, severity] = engine.map[m.ruleId] || ["lint_" + String(m.ruleId).split("/").pop(), "medium"];
        findings.push({
          check,
          severity,
          seq: b.seq,
          source: "lint",
          rule: m.ruleId,
          line: m.line,
          code: m.line ? context(m.line) : "",
          message: `${b.name}:${m.line} — ${String(m.message).replace(/\.$/, "")} [${m.ruleId}]`,
        });
      }
      if (!fatal) parsed++;
    }
    // A style rule can fire thirty times in one file. Keep the first few per check per file and count the rest,
    // so one habit does not bury everything else.
    const CAP = 3;
    const counted = {},
      capped = [];
    for (const f of findings) {
      const key = `${f.check}|${f.seq}`;
      counted[key] = (counted[key] || 0) + 1;
      if (counted[key] <= CAP) capped.push(f);
    }
    for (const f of capped) {
      const extra = counted[`${f.check}|${f.seq}`] - CAP;
      if (extra > 0 && counted[`${f.check}|${f.seq}`] && capped.filter((x) => x.check === f.check && x.seq === f.seq).indexOf(f) === CAP - 1)
        f.message += " " + T("lint_more", { n: extra });
    }
    findings.length = 0;
    findings.push(...capped);

    // If nothing parsed, the linter is not usable here — say why and let the regex checks stand.
    const ran = parsed > 0;
    const log = [
      `profile ${cfg.profile} · ${blocks.length} block(s) · ${Object.keys(rules).length} rules`,
      ...blocks.map((b) => `  ${b.name}: ${b.code.split("\n").length} lines`),
      ...Object.entries(findings.reduce((a, f) => ((a[f.rule] = (a[f.rule] || 0) + 1), a), {}))
        .sort((a, b2) => b2[1] - a[1])
        .map(([r, n]) => `  ${r}: ${n}`),
    ];
    return {
      findings,
      ran,
      errors,
      parsed,
      why,
      log,
      note: ran
        ? T("lint_ran", { n: findings.length, b: blocks.length, e: errors ? T("lint_errors", { n: errors }) : "" })
        : T("lint_failed", { n: blocks.length, why: why[0] || "?" }),
    };
  }

  /* language: the profile's (cfg.language) — the engine whose findings these are. A regex finding is dropped only when
     that engine looks for the same check and the same kind (every regex finding of a SUPERSEDES check has one). */
  const merge = (regexFindings, lintFindings, language) => {
    const c = covers(language);
    return regexFindings.filter((f) => !SUPERSEDES.has(f.check) || !c.has(f.check + "|" + f.kind)).concat(lintFindings);
  };

  /* Every engine's rule-id → check map, keyed like ENGINES minus the javascript alias; the consistency test reads it. */
  const RULE_MAPS = {
    typescript: RULE_MAP,
    cypress: CYPRESS_RULE_MAP,
    detox: DETOX_RULE_MAP,
    java: JAVA_RULE_MAP,
    csharp: CSHARP_RULE_MAP,
    python: PYTHON_RULE_MAP,
    robot: ROBOT_RULE_MAP,
  };
  return {
    run,
    merge,
    covers,
    available,
    ensure,
    engineState,
    ENGINE_FILES,
    RULE_MAP,
    CYPRESS_RULE_MAP,
    DETOX_RULE_MAP,
    RULE_MAPS,
    SUPERSEDES,
    SAME_AS_REGEX,
  };
});
