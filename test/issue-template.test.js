"use strict";
/* The "False or missed finding" issue form lists the profiles by hand: a profile added to lens.js and not to the form
   could not be picked there, so the list must stay the same as Lens.PROFILES. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { root } = require("./helpers");

const Lens = require(path.join(root, "media", "lens.js"));
const FORM = fs.readFileSync(path.join(root, ".github", "ISSUE_TEMPLATE", "false-finding.yml"), "utf8");

test("the false finding issue form lists every profile, in the panel's order", () => {
  const block = FORM.match(/\n {4}id: profile\n[\s\S]*?\n {6}options:\n((?: {8}- .+\n)+)/);
  assert.ok(block, "the form has a profile dropdown");
  const options = block[1]
    .trim()
    .split("\n")
    .map((l) => l.replace(/^\s*- /, "").trim());
  assert.deepEqual(options, Lens.PROFILES);
});

test("the readme links to the false finding issue form", () => {
  const readme = fs.readFileSync(path.join(root, "readme.md"), "utf8");
  assert.match(readme, /issues\/new\?template=false-finding\.yml/);
});
