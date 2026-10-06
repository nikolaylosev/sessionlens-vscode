"use strict";
/* {n|one|other} in i18n.js picks the word for a count, so the panel says "1 confirmed in 1 session", not "1 sessions"
   (0.1.111). */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const { M } = require("./helpers");

const I18N = require(M("i18n.js"));

test("{n|one|other} picks the word for the count", () => {
  assert.equal(I18N.t("rule_hdr", { k: "pass_claim_without_run", n: 1, s: 1 }), "pass_claim_without_run — 1 confirmed in 1 session");
  assert.equal(I18N.t("rule_hdr", { k: "pass_claim_without_run", n: 3, s: 2 }), "pass_claim_without_run — 3 confirmed in 2 sessions");
  assert.match(I18N.t("export_block", { n: 1 }), /^1 high finding has no verdict\./);
  assert.match(I18N.t("export_block", { n: 0 }), /^0 high findings have no verdict\./);
  assert.equal(I18N.t("spec_count", { n: "1", oos: "" }), "(1 requirement)");
  assert.equal(I18N.t("events", { n: 1 }), "1 event"); // a session's header, 0.1.113
  assert.equal(I18N.t("events", { n: 10 }), "10 events");
});

// the number before the word is never 1: a threshold (5 verdicts), or not a number at all ({f} is a file name)
const ALLOWED = ["unverified", "pi_unvalidated", "p_compress_sub"];

test("no string in the dictionary puts a plural word right after a {placeholder}", () => {
  // "{n} findings" or "{s} sessions" reads wrong for 1: use "{n} {n|finding|findings}".
  const words = /\{\w+\} (findings|sessions|requirements|rules|requests|blocks|files|verdicts|events)\b/;
  const bad = fs
    .readFileSync(M("i18n.js"), "utf8")
    .split("\n")
    .filter((line) => words.test(line))
    .filter((line) => !ALLOWED.some((key) => line.trim().startsWith(key + ":")));
  assert.deepEqual(bad, []);
});

test('no string in the dictionary writes a plural as "(s)": "1 message(s)" (0.1.122)', () => {
  const bad = fs
    .readFileSync(M("i18n.js"), "utf8")
    .split("\n")
    .filter((line) => /"[^"]*\w\(s\)[^"]*"/.test(line));
  assert.deepEqual(bad, []);
  assert.equal(I18N.t("never_run", { n: 1 }), "Tests written in 1 message, never executed — a hypothesis about tests, not tests");
  assert.equal(I18N.t("lint_ran", { n: 3, b: 1, e: I18N.t("lint_errors", { n: 2 }) }), "ESLint: 3 findings in 1 block · 2 blocks failed to parse");
  assert.equal(I18N.t("dismissed_note", { n: 1 }), "1 rule hidden via Delete — it stays hidden until restored, even for new sessions.");
  assert.match(I18N.t("expected_failure", { file: "a.spec.ts", n: 2 }), /^a\.spec\.ts: 2 tests marked .* the bug they document is open$/);
});
