// @ts-check
/* Browser "linter" for qa-robot. Robot Framework's `.robot`/`.resource` files are a tabular,
   keyword-driven plain-text format — not a general-purpose language grammar, and no tree-sitter grammar
   for it turned out to be usable here (tree-sitter-robot exists on npm and ships a prebuilt .wasm, but
   it's ABI 15 — incompatible with the ABI-13/14 web-tree-sitter@0.20.8 this project already pins for
   Java/C#/Python; using it would mean bundling a second, independent tree-sitter core runtime just for a
   small, single-maintainer, ~2-month-old package, for a format simple enough that a plain parser suffices
   — the same trade-off Gherkin's own hand-written parser already made in Phase 1, and Ruff-WASM's size/
   packaging mismatch made in Phase 3: investigated, and rejected for concrete reasons, not skipped).

   Still wrapped in the same { lint(code,{rules,filename}) -> {messages,error}, RULES } shape every other
   lint.js engine uses (see lint-java.js's header for why this shape is worth keeping even when nothing
   WASM-based is involved) — it costs nothing here (parsing is synchronous, no boot()/async-readiness
   dance needed at all, unlike every tree-sitter engine) and it's what buys this profile lint.js's existing
   per-file batching, message-repetition capping, and dedup for free. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else /** @type {any} */ (root).LensLintRobot = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const SECTION_RX = /^\*+\s*(Settings?|Variables?|Test\s*Cases?|Tasks?|Keywords?|Comments?)\s*\*+\s*$/i;
  const CELL_SPLIT = /(?: {2,}|\t)/;
  // A "*** Test Cases ***"/"*** Tasks ***" or "*** Keywords ***" body line is a step (not a new
  // name) once it starts with whitespace — RF's own indentation convention, same idea as Python's.
  const isIndented = (raw) => /^[ \t]/.test(raw);

  function splitCells(trimmedLine) {
    return trimmedLine
      .split(CELL_SPLIT)
      .map((c) => c.trim())
      .filter((c, i, arr) => c !== "" || i < arr.length - 1);
  }

  // Parses the *** Test Cases ***/*** Tasks *** and *** Keywords *** sections into a flat list of
  // { name, kind: "test"|"keyword", steps: [{keyword, args, line}], settingCells: {tags,setup,...}, line }.
  function parseRobotFile(text) {
    const lines = text.split("\n");
    const items = [];
    let section = null,
      cur = null;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i].replace(/\r$/, "");
      const trimmed = raw.trim();
      if (!trimmed) continue; // blank lines are pure separators in RF — never end a test/keyword body
      const secMatch = trimmed.match(SECTION_RX);
      if (secMatch) {
        const kind = secMatch[1].toLowerCase().replace(/\s+/g, "");
        section = /^(testcases?|tasks?)$/.test(kind) ? "tests" : /^keywords?$/.test(kind) ? "keywords" : "other";
        cur = null;
        continue;
      }
      if (section !== "tests" && section !== "keywords") continue;
      if (trimmed.startsWith("#")) continue; // a whole-line comment, not a step
      if (!isIndented(raw)) {
        // A new test case / keyword name — RF also allows the name and its first step on the same line
        // ("My Test    Log    hi"), separated the same way cells always are.
        const cells = splitCells(trimmed);
        cur = { name: cells[0], kind: section === "tests" ? "test" : "keyword", steps: [], tags: [], line: i + 1 };
        items.push(cur);
        if (cells.length > 1) cur.steps.push({ keyword: cells[1], args: cells.slice(2), line: i + 1 });
        continue;
      }
      if (!cur) continue; // an indented line before any name has appeared — malformed input, ignore
      const cells = splitCells(trimmed);
      if (!cells.length || !cells[0]) continue;
      if (cells[0].startsWith("[")) {
        // [Documentation]/[Tags]/[Setup]/[Teardown]/[Template]/[Timeout] — metadata, not a step.
        if (/^\[Tags\]$/i.test(cells[0])) cur.tags.push(...cells.slice(1));
        continue;
      }
      cur.steps.push({ keyword: cells[0], args: cells.slice(1), line: i + 1 });
    }
    return items;
  }

  const normStep = (s) =>
    s.keyword.toLowerCase().trim() +
    "|" +
    s.args
      .map((a) =>
        a
          .replace(/\$\{[^}]*\}/g, "<VAR>")
          .toLowerCase()
          .trim(),
      )
      .join(",");
  const SLEEP_RX = /^sleep$/i;
  const SKIP_RX = /^skip(?:\s+if)?$/i;
  /* An assertion step (0.1.121; until then only a keyword that starts with Should or Must counted, so most UI tests got a
     high "nothing is verified"). Robot has no fixed naming, so each of these counts:
     - Should or Must as a word anywhere: BuiltIn's Should Be Equal, SeleniumLibrary's Page Should Contain, Element
       Should Be Visible, Title Should Be;
     - Wait Until …, which fails when its condition never holds; Run Keyword And Expect Error;
     - a keyword named like a check: Verify …, Check …, Assert …, Validate …, Expect …, Ensure …;
     - an assertion operator of the Browser library in the arguments: Get Text    id=total    ==    42;
     - a user keyword of the same file whose own steps hold an assertion.
     A library prefix (SeleniumLibrary.Page Should Contain) and an assignment (${text}=    Get Text …) are looked past. */
  const ASSERTION_RX = /\b(?:should|must)\b|^(?:wait until|run keyword and expect error)\b|^(?:verify|check|assert|validate|expect|ensure)\b/i;
  const BROWSER_ASSERT_OP =
    /^(?:==|!=|<|>|<=|>=|\*=|\^=|\$=|equal|equals|inequal|contains|not contains|starts|ends|matches|validate|then|evaluate|should be|should not be|should start with|should end with)$/i;
  const VAR_ASSIGN = /^[$@&]\{[^}]+\}\s*=?$/;
  // Robot matches keyword names case-insensitively, ignoring spaces and underscores
  const kwKey = (name) => name.toLowerCase().replace(/[\s_]+/g, "");
  function assertionCheck(items) {
    const own = new Map(items.filter((it) => it.kind === "keyword").map((it) => [kwKey(it.name), it]));
    const isAssertion = (step, seen) => {
      let kw = step.keyword,
        args = step.args;
      while (VAR_ASSIGN.test(kw) && args.length) [kw, args] = [args[0], args.slice(1)];
      kw = kw.replace(/^[A-Za-z_]\w*\./, "");
      if (ASSERTION_RX.test(kw) || args.some((a) => BROWSER_ASSERT_OP.test(a))) return true;
      const k = own.get(kwKey(kw));
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return k.steps.some((s) => isAssertion(s, seen));
    };
    return (step) => isAssertion(step, new Set());
  }

  const RULE_IMPLS = {
    // A test case with zero steps at all — a stub nobody filled in yet.
    "empty-test-case"(items, report) {
      for (const it of items) if (it.kind === "test" && it.steps.length === 0) report(it.line, `${it.name}: no steps at all — an empty test case`);
    },
    // Reuses the same check name as everywhere else: actions with nothing verified. What counts as an assertion:
    // assertionCheck() above (naming conventions of BuiltIn, SeleniumLibrary and Browser, not a keyword list).
    "no-assertion-after-action"(items, report) {
      const isAssertion = assertionCheck(items);
      for (const it of items) {
        if (it.kind !== "test" || !it.steps.length) continue;
        if (!it.steps.some(isAssertion)) report(it.line, `${it.name}: has steps but none of them is a Should */Must * keyword — nothing is actually verified`);
      }
    },
    // Same concept as every other profile: a hardcoded Sleep, or a Skip/Skip If used instead of fixing
    // (or triaging) whatever made the test flaky.
    "sleep-or-skip"(items, report) {
      for (const it of items)
        for (const s of it.steps) {
          if (SLEEP_RX.test(s.keyword)) report(s.line, `${it.name}: Sleep    ${s.args.join("    ")} — a fixed delay instead of a real wait condition`);
          else if (SKIP_RX.test(s.keyword)) report(s.line, `${it.name}: ${s.keyword} — skip added instead of fixing (or triaging) the failure`);
        }
    },
    // Two or more test cases with the exact same step sequence — same lower-confidence "hint" design as
    // Gherkin's duplicate_step_text: an exact match only, not a single shared step (a common "Open
    // Browser"/"Go To" setup step repeating across many tests is normal and not a smell by itself).
    "duplicate-steps"(items, report) {
      const bySig = new Map();
      for (const it of items) {
        if (it.kind !== "test" || it.steps.length < 2) continue;
        const sig = it.steps.map(normStep).join(" | ");
        const arr = bySig.get(sig) || [];
        arr.push(it);
        bySig.set(sig, arr);
      }
      for (const arr of bySig.values()) {
        if (arr.length > 1)
          report(
            arr[0].line,
            `${arr.length} test cases share the exact same steps — ${arr
              .map((x) => x.name)
              .slice(0, 4)
              .join(", ")}`,
          );
      }
    },
  };

  function lint(code, { rules, filename = "block" } = /** @type {{ rules?: object, filename?: string }} */ ({})) {
    let items;
    try {
      items = parseRobotFile(code);
    } catch (e) {
      return { messages: [], error: String((e && e.message) || e) };
    }
    const messages = [];
    for (const ruleId of Object.keys(rules || {})) {
      const name = ruleId.replace(/^robot\//, "");
      const impl = RULE_IMPLS[name];
      if (!impl) continue;
      try {
        impl(items, (line, message) => messages.push({ ruleId, message, line }));
      } catch (e) {
        return { messages, error: `${ruleId}: ${String((e && e.message) || e)}` };
      }
    }
    return { messages };
  }

  const RULES = { robot: Object.keys(RULE_IMPLS).map((n) => "robot/" + n) };
  return { lint, RULES, parseRobotFile };
});
