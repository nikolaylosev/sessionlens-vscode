"use strict";
/* scripts/release-notes.js: what the release workflow refuses and what it puts into the GitHub release. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { section, releaseNotes, FALSE_FINDING } = require("../scripts/release-notes.js");

const LOG = "# Changelog\n\n## 0.2.0\n\n### Fixed\n- one\n\n## 0.1.106 — Phase 7C: ready\n\n### Added\n- two\n\n## 0.1.1\n\n- three\n";

test("section: the body up to the next version, a title after the version allowed, no prefix matches", () => {
  assert.equal(section(LOG, "0.2.0"), "### Fixed\n- one");
  assert.equal(section(LOG, "0.1.106"), "### Added\n- two");
  assert.equal(section(LOG, "0.1.1"), "- three");
  assert.equal(section(LOG, "0.1.10"), null);
  assert.equal(section(LOG, "0.3.0"), null);
});

test("releaseNotes: refuses a bad tag, a tag that is not the version, a version without a changelog section", () => {
  assert.match(releaseNotes("0.2.0", "0.2.0", LOG).error, /not vX\.Y\.Z/);
  assert.match(releaseNotes("v0.2.1", "0.2.0", LOG).error, /does not match/);
  assert.match(releaseNotes("v0.3.0", "0.3.0", LOG).error, /no section/);
  assert.match(releaseNotes("v0.2.0", "0.2.0", "## 0.2.0\n\n## 0.1.0\n- x\n").error, /empty/);
});

test("releaseNotes: the section, then the request to report false findings", () => {
  assert.equal(releaseNotes("v0.2.0", "0.2.0", LOG).notes, "### Fixed\n- one\n\n" + FALSE_FINDING + "\n");
});

test("the repository's own version has its changelog section", () => {
  const root = path.join(__dirname, "..");
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  const r = releaseNotes("v" + version, version, fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8"));
  assert.equal(r.error, undefined, r.error);
});
