// @ts-check
/* Browser tree-sitter layer for qa-python. Same recipe as media/lint-java.js and media/lint-csharp.js —
   see lint-java.js's header for the shared rationale. Shares the same tree-sitter core, pinned
   web-tree-sitter@0.20.8 for the same ABI reason.

   Deliberately NOT a 1:1 port of the Java/C# rule set — two of the four don't transfer to Python's own
   testing model, found by dumping real parse trees rather than assumed:

   - No `unannotated-test-method` equivalent: pytest collects any `test_*`-named function automatically —
     no [Test]/@Test-equivalent annotation exists to be missing. The Java/C# smell ("looks like a test,
     runner never calls it") has no Python analogue; forcing the check on would only misfire.
   - `assert-args-reversed` only applies to unittest-style `self.assertEqual(a, b)` calls, not to a plain
     `assert actual == 5` statement — `==` is symmetric, so a bare assert has no "argument order" to get
     backwards in the first place.

   What DOES transfer, with adaptation: `no-assertion-after-action` now also recognises Python's own
   `assert` statement (not just an assert*-named call) and a `with pytest.raises(...)`/`with
   pytest.warns(...)` block as evidence something was actually checked. `swallowed-exception` maps to
   Python's `except: pass` (Python can't have a truly empty block — `pass`, or a bare `...`, is its
   equivalent of an empty body). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else /** @type {any} */ (root).LensLintPython = factory();
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
      .then(() => TS.Language.load(opts.pythonWasmUrl || "tree-sitter-python.wasm"))
      .then((lang) => {
        language = lang;
      })
      .catch((e) => {
        bootError = String((e && e.message) || e);
      });
    return booting;
  }

  const isReady = () => !!language;

  const LITERAL_TYPES = new Set(["integer", "float", "true", "false", "none", "string", "ellipsis"]);

  // The function actually being defined, whether or not it's wrapped in a decorated_definition —
  // `definition` is a genuine named field there, unlike the attribute_list/modifiers situations in the
  // other two languages' grammars.
  const innerFunctionOf = (node) => (node.type === "decorated_definition" ? node.childForFieldName("definition") : node);
  const decoratorsOf = (node) =>
    node.type === "decorated_definition" ? node.namedChildren.filter((c) => c.type === "decorator").map((d) => d.namedChild(0)) : [];
  const isFixture = (node) => decoratorsOf(node).some((d) => /fixture/i.test(d.text));

  const callName = (call) => {
    const fn = call.childForFieldName("function");
    if (!fn) return null;
    if (fn.type === "identifier") return fn.text;
    if (fn.type === "attribute") {
      const a = fn.childForFieldName("attribute");
      return a ? a.text : null;
    }
    return null;
  };

  // assert <expr>; self.assertX(...)/assertX(...) (unittest); with pytest.raises(...)/pytest.warns(...):
  const hasAssertion = (body) => {
    if (body.descendantsOfType("assert_statement").length) return true;
    for (const call of body.descendantsOfType("call")) {
      const n = callName(call);
      if (n && /^assert/i.test(n)) return true;
    }
    for (const ws of body.descendantsOfType("with_statement")) {
      for (const item of ws.descendantsOfType("with_item")) {
        const v = item.childForFieldName("value");
        if (v && v.type === "call") {
          const n = callName(v);
          if (n && /^(raises|warns)$/i.test(n)) return true;
        }
      }
    }
    return false;
  };

  const RULE_IMPLS = {
    // Reuses the same check name Detox's and Java's engines report: a test function/method that calls
    // other code but never actually checks anything.
    "no-assertion-after-action"(root, report) {
      for (const node of root.descendantsOfType(["function_definition", "decorated_definition"])) {
        // descendantsOfType with a decorated_definition ALSO returns the function_definition it wraps
        // (it's a descendant too) — skip a bare function_definition that is itself wrapped one level up,
        // so each test is only checked once, via its outermost (decorated) node.
        if (node.type === "function_definition" && node.parent && node.parent.type === "decorated_definition") continue;
        const fn = innerFunctionOf(node);
        const nameNode = fn.childForFieldName("name");
        if (!nameNode || !/^test/i.test(nameNode.text)) continue;
        if (isFixture(node)) continue;
        const body = fn.childForFieldName("body");
        if (!body) continue;
        const calls = body.descendantsOfType("call");
        if (!calls.length) continue;
        if (!hasAssertion(body))
          report(
            fn,
            `${nameNode.text}() calls other code but has no assert/assert*(...)/pytest.raises(...) anywhere in its body — nothing is actually verified`,
          );
      }
    },
    // except Exception: pass (or a bare `...`) — Python can't write a truly empty block, so this is its
    // equivalent of Java's/C#'s empty catch: the exception is silently swallowed either way.
    "swallowed-exception"(root, report) {
      for (const ec of root.descendantsOfType("except_clause")) {
        // "body" is not a named field of except_clause in this grammar either — find the block by type.
        const block = ec.namedChildren.find((c) => c.type === "block");
        if (!block) continue;
        const real = block.namedChildren.filter((n) => n.type !== "comment");
        const isNoop =
          real.length > 0 &&
          real.every((n) => n.type === "pass_statement" || (n.type === "expression_statement" && n.namedChild(0) && n.namedChild(0).type === "ellipsis"));
        if (isNoop) report(ec, "except block only does pass/... — an exception here is silently swallowed and the test passes regardless");
      }
    },
    // unittest-style self.assertEqual(actual, 5) / assertEqual(actual, 5) — not plain `assert a == b`,
    // which has no argument order to get backwards (`==` is symmetric).
    "assert-args-reversed"(root, report) {
      for (const call of root.descendantsOfType("call")) {
        if (callName(call) !== "assertEqual") continue;
        const args = call.childForFieldName("arguments");
        if (!args || args.namedChildCount !== 2) continue;
        const [a0, a1] = args.namedChildren;
        if (!LITERAL_TYPES.has(a0.type) && LITERAL_TYPES.has(a1.type))
          report(
            call,
            `assertEqual(${a0.text}, ${a1.text}) — the literal usually goes first (expected), the value under test second (actual); this reads reversed`,
          );
      }
    },
  };

  function lint(code, { rules, filename = "block" } = /** @type {{ rules?: object, filename?: string }} */ ({})) {
    if (!isReady()) return { messages: [], error: bootError || "tree-sitter-python: still loading" };
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
      const name = ruleId.replace(/^python\//, "");
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

  const RULES = { python: Object.keys(RULE_IMPLS).map((n) => "python/" + n) };
  return { lint, RULES, boot, isReady, bootError: () => bootError };
});
