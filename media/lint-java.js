// @ts-check
/* Browser tree-sitter layer for qa-java. Exposes the SAME { lint(code, {rules, filename}) -> {messages, error},
   RULES } shape as the ESLint-based engines (vendor-eslint*.js), so lint.js's ENGINES/run()/merge() dispatch
   needs no changes at all to support a completely different parsing technology underneath — see the ENGINES
   entry in lint.js.

   Unlike the ESLint bundles, this file is NOT run through esbuild: tree-sitter.js (copied as-is from
   web-tree-sitter@0.20.8 — pinned to that version because it's the one whose WASM ABI matches the prebuilt
   grammar; see vendor-build/java/README in this project's build notes) is already a self-contained
   universal (Node + browser) build, exactly like vendor-eslint.js is a prebuilt bundle rather than something
   we compile ourselves.

   Two WASM binaries are involved and BOTH require 'wasm-unsafe-eval' in the webview's CSP (added in
   extension.js for this phase — see the Phase 2 handoff notes): tree-sitter.wasm (the ~180KB core runtime)
   and tree-sitter-java.wasm (the ~420KB Java grammar). Neither needs 'unsafe-eval' — 'wasm-unsafe-eval' is
   a narrower directive that only allows WebAssembly compilation, not eval()/new Function() (unlike the ajv
   problem the ESLint bundles had to route around).

   Because loading the grammar is asynchronous (Parser.init() / Language.load() both return promises) while
   lint.js's run() calls core.lint() synchronously in a loop, this file exposes itself on `window.LensLintJava`
   IMMEDIATELY (so `available()` sees it), but `.lint()` reports a (harmless, self-describing) `error` until
   `boot()` has finished — same "if a profile's bundle is absent or throws, nothing happens" fallback the
   ESLint engines already rely on. Since 0.1.102 this file is loaded, and boot() called, by lint.js's ensure()
   (see RULES-ARCHITECTURE.md §7); app.js waits for it before analyzing, and an analysis that still ran before
   boot() finished is marked pending (lintPending, analysisGen "") and done again, so it is never kept. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else /** @type {any} */ (root).LensLintJava = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  let language = null,
    bootError = null,
    booting = null,
    cachedTS = null;

  /* opts: { locateCore(name) -> url, javaWasmUrl } — both only meaningful in the webview; in Node (tests),
     omit them and web-tree-sitter's own defaults (relative file paths) are used. */
  function boot(opts) {
    opts = opts || {};
    if (booting) return booting;
    const TS = typeof TreeSitter !== "undefined" ? TreeSitter : typeof require === "function" ? require("web-tree-sitter") : null;
    if (!TS) {
      bootError = "tree-sitter core (TreeSitter/web-tree-sitter) not loaded";
      return Promise.resolve();
    }
    cachedTS = TS;
    booting = TS.init(opts.locateCore ? { locateFile: opts.locateCore } : undefined)
      .then(() => TS.Language.load(opts.javaWasmUrl || "tree-sitter-java.wasm"))
      .then((lang) => {
        language = lang;
      })
      .catch((e) => {
        bootError = String((e && e.message) || e);
      });
    return booting;
  }

  const isReady = () => !!language;

  // ---------- rule vocabulary ----------
  // JUnit4/5 + TestNG all use the bare annotation name "Test" regardless of package, so no import
  // resolution is needed — matching the annotation's own simple name is enough and stays framework-agnostic.
  const TEST_LIFECYCLE_ANNOTATIONS = new Set([
    "Test",
    "ParameterizedTest",
    "RepeatedTest",
    "TestFactory",
    "TestTemplate",
    "BeforeEach",
    "AfterEach",
    "BeforeAll",
    "AfterAll",
    "Before",
    "After",
    "BeforeClass",
    "AfterClass",
  ]);
  const LITERAL_TYPES = new Set([
    "decimal_integer_literal",
    "hex_integer_literal",
    "octal_integer_literal",
    "binary_integer_literal",
    "decimal_floating_point_literal",
    "hex_floating_point_literal",
    "true",
    "false",
    "character_literal",
    "string_literal",
    "null_literal",
  ]);
  const annotationsOf = (methodDecl) => {
    // "modifiers" is NOT a named field of method_declaration in this grammar (only type/name/parameters/body
    // are) — it's an ordinary child, so it has to be found by type, not childForFieldName, which silently
    // returns null for it and would make every annotation check see an empty list.
    const mods = methodDecl.namedChildren.find((c) => c.type === "modifiers");
    if (!mods) return [];
    return mods.namedChildren.filter((c) => c.type === "marker_annotation" || c.type === "annotation");
  };
  const annotationNames = (methodDecl) =>
    annotationsOf(methodDecl)
      .map((a) => {
        const n = a.childForFieldName("name");
        return n ? n.text : null;
      })
      .filter(Boolean);

  const RULE_IMPLS = {
    // A method that reads like a test (name starts with "test", in a class named ...Test/Tests/IT) but
    // carries none of JUnit's/TestNG's lifecycle annotations never actually runs — the suite stays green
    // while this method is silently skipped by the runner.
    "unannotated-test-method"(root, report) {
      for (const cls of root.descendantsOfType("class_declaration")) {
        const clsName = cls.childForFieldName("name");
        if (!clsName || !/(Test|Tests|IT)$/.test(clsName.text)) continue;
        const body = cls.childForFieldName("body");
        if (!body) continue;
        for (const m of body.namedChildren) {
          if (m.type !== "method_declaration") continue;
          const nameNode = m.childForFieldName("name");
          if (!nameNode || !/^test/i.test(nameNode.text)) continue;
          const names = annotationNames(m);
          if (!names.some((n) => TEST_LIFECYCLE_ANNOTATIONS.has(n)))
            report(m, `${nameNode.text}() looks like a test (class ${clsName.text}) but has no @Test/lifecycle annotation — the runner will never execute it`);
        }
      }
    },
    // A @Test method that calls out to other code but never asserts anything only proves the call didn't
    // throw — it verifies nothing about what actually happened. Same concept as Detox's expect-after-action.
    "no-assertion-after-action"(root, report) {
      for (const cls of root.descendantsOfType("class_declaration")) {
        const body = cls.childForFieldName("body");
        if (!body) continue;
        for (const m of body.namedChildren) {
          if (m.type !== "method_declaration") continue;
          if (
            !annotationNames(m).some(
              (n) =>
                TEST_LIFECYCLE_ANNOTATIONS.has(n) &&
                n !== "BeforeEach" &&
                n !== "AfterEach" &&
                n !== "BeforeAll" &&
                n !== "AfterAll" &&
                n !== "Before" &&
                n !== "After" &&
                n !== "BeforeClass" &&
                n !== "AfterClass",
            )
          )
            continue;
          const mBody = m.childForFieldName("body");
          if (!mBody) continue;
          const invocations = mBody.descendantsOfType("method_invocation");
          if (!invocations.length) continue;
          const hasAssertion = invocations.some((inv) => {
            const n = inv.childForFieldName("name");
            return n && /^assert/i.test(n.text);
          });
          if (!hasAssertion) {
            const nameNode = m.childForFieldName("name");
            report(m, `${nameNode ? nameNode.text : "test"}() calls other code but has no assert*(...) anywhere in its body — nothing is actually verified`);
          }
        }
      }
    },
    // An empty (or comment-only) catch block silently swallows whatever the try block threw. The test
    // passes either way. Comments are ordinary named nodes in this grammar (line_comment/block_comment),
    // not hidden "extra" nodes, so a comment-only body has to be filtered out explicitly rather than
    // relying on namedChildCount === 0.
    "swallowed-exception"(root, report) {
      for (const c of root.descendantsOfType("catch_clause")) {
        const b = c.childForFieldName("body");
        if (!b) continue;
        const real = b.namedChildren.filter((n) => n.type !== "line_comment" && n.type !== "block_comment");
        if (real.length === 0) report(c, "empty catch block — an exception here is silently swallowed and the test passes regardless");
      }
    },
    // assertEquals(actual, 5) instead of assertEquals(5, actual): only the unambiguous 2-argument form is
    // checked (JUnit4's 3-arg form puts the message first, JUnit5's puts it last, so a 3-arg heuristic
    // would be a coin flip) — a literal in the first ("expected") slot and a variable/call in the second
    // ("actual") slot is the normal, correct order; the reverse is the common copy-paste mistake.
    "assert-args-reversed"(root, report) {
      for (const inv of root.descendantsOfType("method_invocation")) {
        const nameNode = inv.childForFieldName("name");
        if (!nameNode || nameNode.text !== "assertEquals") continue;
        const args = inv.childForFieldName("arguments");
        if (!args || args.namedChildCount !== 2) continue;
        const [a0, a1] = args.namedChildren;
        if (!LITERAL_TYPES.has(a0.type) && LITERAL_TYPES.has(a1.type))
          report(
            inv,
            `assertEquals(${a0.text}, ${a1.text}) — the literal usually goes first (expected), the value under test second (actual); this reads reversed`,
          );
      }
    },
  };

  function walk(node, visit) {
    visit(node);
    for (let i = 0; i < node.namedChildCount; i++) walk(node.namedChild(i), visit);
  }
  // Every rule above already searches with descendantsOfType, which is enough for the four rules here;
  // `walk` is kept only in case a future Java rule needs to track ancestry (e.g. "inside this specific
  // method") rather than a flat descendant search.
  void walk;

  function lint(code, { rules, filename = "block" } = /** @type {{ rules?: object, filename?: string }} */ ({})) {
    if (!isReady()) return { messages: [], error: bootError || "tree-sitter-java: still loading" };
    const TS = cachedTS || (typeof TreeSitter !== "undefined" ? TreeSitter : null) || (typeof require === "function" ? require("web-tree-sitter") : null);
    let tree;
    try {
      const parser = new TS();
      parser.setLanguage(language);
      tree = parser.parse(code);
    } catch (e) {
      return { messages: [], error: String((e && e.message) || e) };
    }
    const messages = [];
    for (const ruleId of Object.keys(rules || {})) {
      const name = ruleId.replace(/^java\//, "");
      const impl = RULE_IMPLS[name];
      if (!impl) continue;
      try {
        impl(tree.rootNode, (node, message) => messages.push({ ruleId, message, line: node.startPosition.row + 1 }));
      } catch (e) {
        return { messages, error: `${ruleId}: ${String((e && e.message) || e)}` };
      }
    }
    return { messages };
  }

  const RULES = { java: Object.keys(RULE_IMPLS).map((n) => "java/" + n) };
  return { lint, RULES, boot, isReady, bootError: () => bootError };
});
