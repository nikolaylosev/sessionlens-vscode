// @ts-check
/* Browser tree-sitter layer for qa-c#. Same recipe and same {lint,RULES} interface as media/lint-java.js —
   see that file's header for the full rationale (engine-agnostic dispatch, async readiness, why
   'wasm-unsafe-eval' is needed and is safe). This file only differs in which grammar it loads and in the
   C#-specific node/field names and rule bodies below (found the same way Java's were: by dumping a real
   parse tree first, not by assuming the Java grammar's shape carries over — it mostly doesn't, field names
   and even which things are "named" children differ between the two grammars).

   Shares the same tree-sitter core (tree-sitter.js / tree-sitter.wasm) that Java's engine already loads —
   only the grammar WASM differs, so this file expects `TreeSitter`/`web-tree-sitter` to already be
   available exactly as lint-java.js does, and pins the same web-tree-sitter@0.20.8 for the same ABI
   reason (see the Phase 2/3 handoff notes — re-verify this pairing if tree-sitter-wasms or web-tree-sitter
   ever move independently of each other). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else /** @type {any} */ (root).LensLintCSharp = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  let language = null,
    bootError = null,
    booting = null,
    cachedTS = null;

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
      .then(() => TS.Language.load(opts.csharpWasmUrl || "tree-sitter-c_sharp.wasm"))
      .then((lang) => {
        language = lang;
      })
      .catch((e) => {
        bootError = String((e && e.message) || e);
      });
    return booting;
  }

  const isReady = () => !!language;

  // NUnit/xUnit/MSTest all use bare attribute names regardless of namespace, so — as with Java's
  // annotations — matching the simple name is enough and stays framework-agnostic.
  const REAL_TEST_ATTRS = new Set(["Test", "TestCase", "TestCaseSource", "Theory", "Fact", "TestMethod", "DataTestMethod"]);
  const LIFECYCLE_ATTRS = new Set(["SetUp", "TearDown", "OneTimeSetUp", "OneTimeTearDown", "TestInitialize", "TestCleanup", "ClassInitialize", "ClassCleanup"]);
  const ALL_RECOGNIZED_ATTRS = new Set([...REAL_TEST_ATTRS, ...LIFECYCLE_ATTRS]);
  const LITERAL_TYPES = new Set([
    "integer_literal",
    "real_literal",
    "boolean_literal",
    "true",
    "false",
    "character_literal",
    "string_literal",
    "verbatim_string_literal",
    "null_literal",
  ]);

  // "attribute_list" is not a named field of method_declaration (only type/name/parameters/body are —
  // same situation as Java's "modifiers"), so it has to be found by type among the ordinary children.
  const attributesOf = (methodDecl) => {
    const out = [];
    for (const c of methodDecl.namedChildren) if (c.type === "attribute_list") out.push(...c.namedChildren.filter((a) => a.type === "attribute"));
    return out;
  };
  const attributeNames = (methodDecl) =>
    attributesOf(methodDecl)
      .map((a) => {
        const n = a.childForFieldName("name");
        return n ? n.text : null;
      })
      .filter(Boolean);

  // An invocation counts as an assertion however it's spelled: Assert.AreEqual(...)/Assert.That(...),
  // CollectionAssert./StringAssert. (NUnit/MSTest), xUnit's bare Assert.Equal(...), or FluentAssertions'
  // `.Should()` entry point (the rest of that chain is what actually asserts, but `.Should()` is the
  // unambiguous, easy-to-detect signal that this line is making an assertion at all).
  const isAssertionCall = (inv) => {
    const fn = inv.childForFieldName("function");
    if (!fn) return false;
    if (fn.type === "identifier") return /^assert/i.test(fn.text);
    if (fn.type === "member_access_expression") {
      const name = fn.childForFieldName("name"),
        obj = fn.childForFieldName("expression");
      if (name && name.text === "Should") return true;
      if (obj && /Assert/i.test(obj.text)) return true;
      if (name && /^assert/i.test(name.text)) return true;
    }
    return false;
  };

  const RULE_IMPLS = {
    // Same concept as Java's: a method named like a test, in a class named like a test fixture, but with
    // none of NUnit's/xUnit's/MSTest's attributes on it — the runner never calls it.
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
          if (!attributeNames(m).some((n) => ALL_RECOGNIZED_ATTRS.has(n)))
            report(
              m,
              `${nameNode.text}() looks like a test (class ${clsName.text}) but has no [Test]/[Fact]/lifecycle attribute — the runner will never execute it`,
            );
        }
      }
    },
    // Reuses Detox's/Java's check name: a real test method that calls other code but asserts nothing.
    "no-assertion-after-action"(root, report) {
      for (const cls of root.descendantsOfType("class_declaration")) {
        const body = cls.childForFieldName("body");
        if (!body) continue;
        for (const m of body.namedChildren) {
          if (m.type !== "method_declaration") continue;
          if (!attributeNames(m).some((n) => REAL_TEST_ATTRS.has(n))) continue;
          const mBody = m.childForFieldName("body");
          if (!mBody) continue;
          const invocations = mBody.descendantsOfType("invocation_expression");
          if (!invocations.length) continue;
          if (!invocations.some(isAssertionCall)) {
            const nameNode = m.childForFieldName("name");
            report(
              m,
              `${nameNode ? nameNode.text : "test"}() calls other code but has no assertion (Assert.*/​.Should()) anywhere in its body — nothing is actually verified`,
            );
          }
        }
      }
    },
    // An empty (or comment-only) catch block silently swallows whatever the try block threw.
    "swallowed-exception"(root, report) {
      for (const c of root.descendantsOfType("catch_clause")) {
        const b = c.childForFieldName("body");
        if (!b) continue;
        const real = b.namedChildren.filter((n) => n.type !== "comment");
        if (real.length === 0) report(c, "empty catch block — an exception here is silently swallowed and the test passes regardless");
      }
    },
    // Assert.AreEqual(actual, 5) / Assert.Equal(actual, 5) instead of (5, actual) — same "the literal is
    // the expected value" heuristic as Java's, restricted the same way to the unambiguous 2-argument form
    // and to the two method names that follow the expected-first convention across NUnit/MSTest/xUnit.
    "assert-args-reversed"(root, report) {
      for (const inv of root.descendantsOfType("invocation_expression")) {
        const fn = inv.childForFieldName("function");
        if (!fn || fn.type !== "member_access_expression") continue;
        const nameNode = fn.childForFieldName("name");
        if (!nameNode || (nameNode.text !== "AreEqual" && nameNode.text !== "Equal")) continue;
        const args = inv.childForFieldName("arguments");
        if (!args || args.namedChildCount !== 2) continue;
        const a0 = args.namedChild(0).namedChild(0),
          a1 = args.namedChild(1).namedChild(0);
        if (!a0 || !a1) continue;
        if (!LITERAL_TYPES.has(a0.type) && LITERAL_TYPES.has(a1.type))
          report(
            inv,
            `${fn.text}(${a0.text}, ${a1.text}) — the literal usually goes first (expected), the value under test second (actual); this reads reversed`,
          );
      }
    },
  };

  function lint(code, { rules, filename = "block" } = /** @type {{ rules?: object, filename?: string }} */ ({})) {
    if (!isReady()) return { messages: [], error: bootError || "tree-sitter-c#: still loading" };
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
      const name = ruleId.replace(/^csharp\//, "");
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

  const RULES = { csharp: Object.keys(RULE_IMPLS).map((n) => "csharp/" + n) };
  return { lint, RULES, boot, isReady, bootError: () => bootError };
});
