// @ts-check
/* Rule book: the text, severity and on/off state of every check, in one editable place.
   Defaults come from the built-in dictionary; overrides live in chrome.storage and can be exported as a
   rules.json the team keeps in the repository. Nothing here decides what a check looks for — only how it is
   worded, how loudly it speaks, and whether it speaks at all. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else /** @type {any} */ (root).LensRules = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const T = (k, v) => (typeof I18N !== "undefined" ? I18N : require("./i18n.js")).t(k, v);
  const L = () => (typeof Lens !== "undefined" ? Lens : require("./lens.js"));

  /* Groups, default severities and good examples are derived from the check registry (media/checks.js) —
     this file only decides how a check is worded, how loudly it speaks and whether it speaks at all. */
  const C = () => (typeof LensChecks !== "undefined" ? LensChecks : require("./checks.js"));
  const { CHECKS, SEVERITIES, GROUPS_ORDER } = C();
  const GROUPS = Object.fromEntries(GROUPS_ORDER.map((g) => [g, Object.keys(CHECKS).filter((c) => CHECKS[c].group === g)]));
  const DEFAULT_SEVERITY = Object.fromEntries(Object.entries(CHECKS).map(([c, v]) => [c, v.severity]));
  /* A rule an agent follows states both sides: what to do and what not to do. The "don't" comes from a confirmed
     finding — it is real code from a real session — and the "do" is the shortest correct form of the same thing. */
  const GOOD = Object.fromEntries(
    Object.entries(CHECKS)
      .filter(([, v]) => v.good !== null)
      .map(([c, v]) => [c, v.good]),
  );
  const exampleGood = (check, overrides) => {
    const own = (overrides || {})[check] || {};
    return own.good !== undefined ? own.good : GOOD[check] || "";
  };

  const ALL = Object.values(GROUPS).flat();
  const groupOf = (check) => Object.keys(GROUPS).find((g) => GROUPS[g].includes(check)) || "code";

  /* The full book as the panel shows it: default text from the dictionary, overlaid with the user's edits. */
  function book(overrides) {
    const o = overrides || {};
    return ALL.map((check) => {
      const own = o[check] || {};
      return {
        check,
        group: groupOf(check),
        rule: own.rule !== undefined ? own.rule : L().RULES[check] || "",
        severity: own.severity || DEFAULT_SEVERITY[check] || "medium",
        enabled: own.enabled !== false,
        good: own.good !== undefined ? own.good : GOOD[check] || "",
        edited: own.rule !== undefined || own.good !== undefined || !!own.severity || own.enabled === false,
      };
    });
  }

  /* Applied at analysis time: drop disabled checks, restate severities. Never changes what a check detects. */
  function apply(findings, overrides) {
    const o = overrides || {};
    return findings
      .filter((f) => (o[f.check] || {}).enabled !== false)
      .map((f) => {
        const sev = (o[f.check] || {}).severity;
        return sev && !f.demoted ? { ...f, severity: sev } : f;
      });
  }
  const ruleText = (check, overrides) => {
    const own = (overrides || {})[check] || {};
    if (own.rule !== undefined) return own.rule;
    C().warnUnknown(check, "LensRules.ruleText");
    return L().RULES[check] || "";
  };
  const disabledChecks = (overrides) =>
    Object.entries(overrides || {})
      .filter(([, v]) => v && v.enabled === false)
      .map(([k]) => k);

  function toJson(overrides) {
    return JSON.stringify(
      {
        schema: "sessionlens/rules@1",
        updated: new Date().toISOString(),
        rules: book(overrides)
          .filter((r) => r.edited)
          .map(({ check, rule, good, severity, enabled }) => ({ check, rule, good, severity, enabled })),
      },
      null,
      1,
    );
  }
  /* Replaces the overrides wholesale (no merge). Rows that cannot be applied are reported, not silently lost:
     ignored = [{ index, check, reason }], reason ∈ "no_check" | "unknown_check" | "bad_severity".
     A "bad_severity" row is still imported — only its severity field is dropped. */
  function fromJson(text) {
    const data = JSON.parse(text);
    const rows = Array.isArray(data) ? data : data.rules;
    if (!Array.isArray(rows)) throw new Error(T("rules_bad_file"));
    const overrides = {},
      ignored = [];
    rows.forEach((r, index) => {
      if (!r || !r.check) {
        ignored.push({ index, check: (r && r.check) || "", reason: "no_check" });
        return;
      }
      if (!ALL.includes(r.check)) {
        ignored.push({ index, check: r.check, reason: "unknown_check" });
        return;
      }
      const out = (overrides[r.check] = /** @type {any} */ ({}));
      if (typeof r.rule === "string") out.rule = r.rule;
      if (typeof r.good === "string") out.good = r.good;
      if (SEVERITIES.includes(r.severity)) out.severity = r.severity;
      else if (r.severity !== undefined && r.severity !== null && r.severity !== "") ignored.push({ index, check: r.check, reason: "bad_severity" });
      if (r.enabled === false) out.enabled = false;
    });
    return { overrides, ignored };
  }
  return { GROUPS, DEFAULT_SEVERITY, GOOD, ALL, book, apply, ruleText, exampleGood, disabledChecks, toJson, fromJson, groupOf };
});
