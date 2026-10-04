"use strict";
/* parseFindings maps every allowed review category to ai_<name>, and anything else to ai_other.
   finding-pipeline.test.js already pins ai_coverage and ai_other. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { load, M } = require("./helpers");

load();
const LensAI = require(M("ai.js"));

test("every review category becomes ai_<name>; an unknown one becomes ai_other", () => {
  const raw = JSON.stringify([
    { check: "purpose", severity: "high", message: "the name promises a discount, the assert checks the title", evidence: "expect(title)" },
    { check: "ai_questions", severity: "medium", message: "the spec does not say what happens on 423", evidence: "no 423 case" },
    { check: "fix_justification", severity: "medium", message: "the retry was added with no note of a flake", evidence: "retries: 2" },
    { check: "spec_defect", severity: "low", message: "R3 and the UI disagree on the total", evidence: "R3 says 90" },
    { check: "style", severity: "low", message: "rename the page object", evidence: "cartPageObjectInstance" },
  ]);
  const out = LensAI.parseFindings(raw).map((f) => f.check);
  assert.deepEqual(out, ["ai_purpose", "ai_questions", "ai_fix_justification", "ai_spec_defect", "ai_other"]);
});
