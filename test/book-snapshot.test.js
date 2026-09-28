"use strict";
/* LensRules.book({}) must stay identical to the v0.1.97 snapshot, except for rows explicitly added since. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { load } = require("./helpers");

const SNAP = path.join(__dirname, "__snapshots__", "book-en.json");
// Rows added after the snapshot was taken (Phase 1: two checks that existed but were missing from the book).
const ADDED = new Set(["lint_valid_title", "ai_other"]);

test("book({}) matches the v0.1.97 snapshot", () => {
  const { LensRules } = load();
  const book = LensRules.book({});
  if (process.env.UPDATE_SNAPSHOT) {
    fs.writeFileSync(SNAP, JSON.stringify(book, null, 1) + "\n");
    return;
  }
  const snap = JSON.parse(fs.readFileSync(SNAP, "utf8"));
  const old = book.filter((r) => !ADDED.has(r.check));
  assert.deepEqual(old, snap, "existing rows (content and relative order) must not change");
  const added = book.filter((r) => ADDED.has(r.check)).map((r) => r.check);
  assert.ok(added.length <= ADDED.size);
});
