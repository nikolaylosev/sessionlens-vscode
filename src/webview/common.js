// @ts-check
/* SessionLens panel — helpers, theme. Part of the panel's source (src/webview); `npm run build` bundles it into
   media/app.js. Split out of the single app.js in phase 7 (7B.4) without changing behaviour. */

// set in initCommon(), in the order the single app.js ran its statements
export let $,
  esc,
  fkey,
  genId,
  srcLabel,
  RULES_TARGET_FILES,
  rulesTargetFiles,
  rulesTargetLabel,
  rulesFileText,
  T,
  LABEL,
  SEV,
  VLABEL,
  VCOL,
  hostTheme,
  store,
  state,
  SMALL_KEYS,
  save;

export function initCommon() {
  $ = (s) => document.querySelector(s);
  esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  fkey = (f) => Lens.fkey(f);
  genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  // Which project file(s) the Rules-for-CLAUDE.md/AGENTS.md export, Compress rules.md and Generate skill
  // features are aimed at. CLAUDE.md is Claude Code's own convention; AGENTS.md is the open, cross-agent
  // convention Codex (and Cursor, Copilot, Gemini CLI and others) read the same way. Cursor also has project
  // rules of its own (0.1.121): a .mdc file in .cursor/rules, which both the IDE and the CLI load.
  RULES_TARGET_FILES = { claude: ["CLAUDE.md"], codex: ["AGENTS.md"], cursor: [".cursor/rules/sessionlens.mdc"], both: ["CLAUDE.md", "AGENTS.md"] };
  rulesTargetFiles = () => RULES_TARGET_FILES[state.settings.rulesTarget] || RULES_TARGET_FILES.claude;
  rulesTargetLabel = () => rulesTargetFiles().join(" and ");
  // The text of the whole target file. Cursor skips a .mdc rule without its frontmatter; alwaysApply: true puts the
  // rule into every Agent chat of the project. The other targets are plain Markdown.
  rulesFileText = (md) =>
    state.settings.rulesTarget === "cursor" ? "---\ndescription: Rules from SessionLens reviews of agent sessions\nalwaysApply: true\n---\n\n" + md : md;
  T = (k, v) => I18N.t(k, v);
  // a finding's source as the findings filter and the Calibration table name it ("regex" for formal or none)
  const SRC_KEYS = { formal: "chip_formal", lint: "chip_lint", spec: "chip_spec", ai: "chip_ai", gherkin: "src_gherkin", external: "src_external" };
  srcLabel = (src) => (SRC_KEYS[src || "formal"] ? T(SRC_KEYS[src || "formal"]) : String(src));
  LABEL = new Proxy({}, { get: (_, k) => T(k) });
  SEV = new Proxy({}, { get: (_, k) => T("sev_" + /** @type {string} */ (k)) });
  VLABEL = new Proxy({}, { get: (_, k) => T("verdict_" + /** @type {string} */ (k)) });
  VCOL = { red: "var(--red)", yellow: "var(--amber)", green: "var(--green)" };
  hostTheme = () => (document.body.classList.contains("vscode-dark") || document.body.classList.contains("vscode-high-contrast") ? "dark" : "light");
  applyTheme(hostTheme());
  new MutationObserver(() => applyTheme(hostTheme())).observe(document.body, { attributes: true, attributeFilter: ["class"] });

  // The lint engines are loaded (and the tree-sitter ones booted) by LensLint.ensure() when a session of their language
  // is analyzed in this page — see needEngine() below and lint.js (phase 5). Nothing is loaded at start.

  // API keys live in the host's SecretStorage and never reach this page (see secrets.js, providers.js).
  // state.settings has no apiKey/keys; LensAI learns which providers have a key from the host.
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
        "lintRepair",
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
            maxCode: 40000,
            verify: true,
            lint: true,
            debugModel: false,
            rulesTarget: "claude",
            prompts: {},
          },
          r.settings || {},
        ),
        rulesApplied: r.rulesApplied || {},
        rulesDismissed: r.rulesDismissed || {},
        external: r.external || [],
      };
    },
    async set(o) {
      await chrome.storage.local.set(o);
    },
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
    filter: { src: { formal: true, lint: true, spec: true, ai: true }, sev: { high: true, medium: true, low: true }, undecided: false },
  };
  SMALL_KEYS = ["settings", "rulesApplied", "rulesDismissed", "external", "ruleOverrides", "calibLog", "compressResults", "skillResults", "analysisEpoch"];
  // every small key; a session is saved on its own (updateSession), never through this
  save = () => saveKeys(SMALL_KEYS);
}

// ---------- theme ----------
// Always follows VS Code's own theme — the sidebar's native "Sessions" tree can only ever
// follow the real VS Code theme too (there's no API to recolor it), so a separate manual
// override in here would just go out of sync with it, as happened before this was removed.
export function applyTheme(t) {
  document.documentElement.dataset.theme = t;
}

export function saveKeys(keys) {
  const o = {};
  for (const k of keys) o[k] = state[k];
  return store.set(o);
}
