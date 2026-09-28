"use strict";
/* Lint for SessionLens's own code (phase 7, 7B.2). Vendored bundles, the tree-sitter runtime and the generated
   webview bundle are not ours to lint. */
const js = require("@eslint/js");
const globals = require("globals");

const PAGE_GLOBALS = {
  Lens: "readonly",
  LensChecks: "readonly",
  LensLint: "readonly",
  LensRules: "readonly",
  LensSpec: "readonly",
  LensAI: "readonly",
  LensSeg: "readonly",
  LensLintRobot: "readonly",
  LensLintCore: "readonly",
  LensLintCypress: "readonly",
  LensLintDetox: "readonly",
  LensLintJava: "readonly",
  LensLintCSharp: "readonly",
  LensLintPython: "readonly",
  TreeSitter: "readonly",
  I18N: "readonly",
  alertDialog: "readonly",
  confirmDialog: "readonly",
  promptDialog: "readonly",
  chooseDialog: "readonly",
  acquireVsCodeApi: "readonly",
  chrome: "readonly",
};

module.exports = [
  { ignores: ["node_modules/**", "media/vendor-eslint*.js", "media/tree-sitter.js", "media/app.js", "media/app.js.map", "*.vsix", ".vscode-test/**"] },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: { ecmaVersion: 2022, sourceType: "script", globals: { ...globals.node } },
    rules: {
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none", ignoreRestSiblings: true }],
      "no-redeclare": ["error", { builtinGlobals: false }],
      "no-irregular-whitespace": ["error", { skipStrings: true, skipTemplates: true, skipRegExps: true }],
      "no-undef": "error",
      "no-empty": ["error", { allowEmptyCatch: true }],
      // deliberate in this code base: control characters are what validate.js and the transcript parsers look for,
      // and escapes like \[ or \/ inside character classes are kept for readability of long patterns
      "no-control-regex": "off",
      // Prettier does not break strings, template literals or regexes; those may run longer
      "max-len": ["error", { code: 160, ignoreStrings: true, ignoreTemplateLiterals: true, ignoreRegExpLiterals: true, ignoreUrls: true }],
      "no-useless-escape": "off",
    },
  },
  {
    files: ["media/**/*.js"],
    languageOptions: { globals: { ...globals.browser, ...PAGE_GLOBALS } },
  },
  {
    // the panel's source: ES modules bundled into media/app.js (generated, not linted) by scripts/build-webview.js
    files: ["src/webview/**/*.js"],
    languageOptions: { sourceType: "module", globals: { ...globals.browser, ...PAGE_GLOBALS } },
  },
  {
    files: ["test/**/*.js", "perf/**/*.js"],
    languageOptions: { globals: { ...globals.node } },
  },
];
