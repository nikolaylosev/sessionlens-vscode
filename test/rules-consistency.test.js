"use strict";
/* Every check name the detectors can emit must be in media/checks.js, and every registry entry must be complete
   and still have a detector. This is what makes "added a check and forgot rules.js / i18n.js" a red build instead
   of a silent fallback (RULES-ARCHITECTURE.md §1, §11.1). */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const { load, M } = require("./helpers");

load();
const { CHECKS, SEVERITIES, GROUPS_ORDER } = require(M("checks.js"));
const LensLint = require(M("lint.js"));
const LensAI = require(M("ai.js"));
const I18N = require(M("i18n.js"));
const src = (f) => fs.readFileSync(M(f), "utf8");

/* Per-language lookup in the raw dictionary — t() falls back to en and then to the key itself. */
function dictionaries() {
  return Object.fromEntries(I18N.langs.map((lang) => [lang, (key) => I18N.has(lang, key)]));
}

/* Detector side: every name each source can emit, with the source it came from. */
function emitted() {
  const found = new Map(); // check -> Set(source)
  const add = (c, s) => {
    if (!found.has(c)) found.set(c, new Set());
    found.get(c).add(s);
  };

  for (const map of Object.values(LensLint.RULE_MAPS)) for (const [check] of Object.values(map)) add(check, "lint");

  const lens = src("lens.js");
  const gStart = lens.indexOf("function gherkinChecks(");
  const gEnd = lens.indexOf("function runChecks(");
  assert.ok(gStart > 0 && gEnd > gStart, "lens.js: gherkinChecks()/runChecks() not found — update this test");
  for (const m of lens.matchAll(/\bF\("([a-z_]+)"/g)) add(m[1], m.index > gStart && m.index < gEnd ? "gherkin" : "regex");
  for (const m of src("spec.js").matchAll(/\bF\("([a-z_]+)"/g)) add(m[1], "spec");

  for (const c of LensAI.AI_CATEGORIES) add("ai_" + c, "ai");
  add("ai_other", "ai");
  return found;
}

test("lint.js exports every *_RULE_MAP it defines", () => {
  const defined = [...src("lint.js").matchAll(/const ([A-Z_]*RULE_MAP) = \{/g)].map((m) => m[1]);
  assert.equal(new Set(Object.values(LensLint.RULE_MAPS)).size, defined.length, `lint.js defines ${defined.join(", ")} — add the missing one to RULE_MAPS`);
});

test("every F(...) call in lens.js / spec.js names its check with a string literal", () => {
  for (const f of ["lens.js", "spec.js"]) {
    const bad = [...src(f).matchAll(/\bF\(\s*([^"\s)][^,)]*)/g)].map((m) => m[1]);
    assert.deepEqual(bad, [], `${f}: F() with a computed check name — the registry test cannot see it`);
  }
});

test("every emitted check name is in the registry", () => {
  const missing = [...emitted().keys()].filter((c) => !CHECKS[c]);
  assert.deepEqual(missing, [], "add these to media/checks.js");
});

test("every registry entry still has a detector, and its sources are accurate", () => {
  const found = emitted();
  for (const [check, v] of Object.entries(CHECKS)) {
    assert.ok(found.has(check), `${check}: in checks.js but nothing emits it`);
    assert.deepEqual([...v.sources].sort(), [...found.get(check)].sort(), `${check}: sources`);
  }
});

test("ai group and AI_CATEGORIES agree both ways", () => {
  const inGroup = Object.keys(CHECKS)
    .filter((c) => CHECKS[c].group === "ai" && c !== "ai_other")
    .sort();
  assert.deepEqual(inGroup, LensAI.AI_CATEGORIES.map((c) => "ai_" + c).sort());
});

test("every entry is well-formed", () => {
  for (const [check, v] of Object.entries(CHECKS)) {
    assert.match(check, /^[a-z][a-z_]*$/, `${check}: check names are snake_case`);
    assert.ok(GROUPS_ORDER.includes(v.group), `${check}: unknown group ${v.group}`);
    assert.ok(SEVERITIES.includes(v.severity), `${check}: bad severity ${v.severity}`);
    assert.equal(typeof v.ruleKey, "string", `${check}: ruleKey`);
    assert.ok(v.good === null || (typeof v.good === "string" && v.good), `${check}: good must be null or non-empty`);
    assert.ok(Array.isArray(v.sources) && v.sources.length, `${check}: sources`);
    if ("sortPriority" in v) assert.equal(typeof v.sortPriority, "number", `${check}: sortPriority`);
  }
});

test("rule text exists in every language, group labels too", () => {
  const dict = dictionaries();
  for (const [lang, has] of Object.entries(dict)) {
    for (const [check, v] of Object.entries(CHECKS)) assert.ok(has(v.ruleKey), `${lang}: ${check} → ${v.ruleKey} missing in i18n.js`);
    for (const g of GROUPS_ORDER) assert.ok(has("g_" + g), `${lang}: g_${g} missing in i18n.js`);
  }
});

test("every group in GROUPS_ORDER has at least one check", () => {
  for (const g of GROUPS_ORDER)
    assert.ok(
      Object.values(CHECKS).some((v) => v.group === g),
      `group ${g} is empty`,
    );
});

test("rules.js tables are derived from the registry", () => {
  const LensRules = require(M("rules.js"));
  assert.deepEqual(LensRules.ALL, Object.keys(CHECKS));
  for (const [c, v] of Object.entries(CHECKS)) {
    assert.equal(LensRules.groupOf(c), v.group);
    assert.equal(LensRules.DEFAULT_SEVERITY[c], v.severity);
  }
});
