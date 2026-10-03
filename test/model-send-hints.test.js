"use strict";
/* 0.1.116: every button that calls a model says, on hover, what it sends; the README lists the same buttons
   ("What a model call sends"). The real panel. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { bootHost, openPage } = require("./host-panel");
const { root, M } = require("./helpers");

const I18N = require(M("i18n.js"));
I18N.set("en");
const BUTTONS = {
  "seg-run": "send_seg",
  "ai-run": "send_review",
  "ai-verify-again": "send_review",
  "compress-rules": "send_compress",
  "gen-skill": "send_skill",
};

test("each model button says what it sends", async () => {
  const p = await openPage(bootHost({ globalState: {} }));
  await p.ready();
  for (const [id, key] of Object.entries(BUTTONS)) {
    const title = p.document.getElementById(id).title;
    assert.equal(title, I18N.t(key), id);
    assert.match(title, /^Sends to the model: /, id);
  }
  assert.match(p.document.getElementById("ai-run").title, /not masked/);
  assert.match(p.document.getElementById("gen-skill").title, /content is not sent/);
  assert.deepEqual(p.errors, []);
  p.close();
});

test("the README names every model button under What a model call sends", () => {
  const readme = fs.readFileSync(path.join(root, "readme.md"), "utf8");
  const part = readme.slice(readme.indexOf("**What a model call sends.**"), readme.indexOf("## Found a false finding?"));
  assert.ok(part.length > 100, "the section is there");
  for (const key of ["ai_run", "ai_verify_again", "seg_run", "compress_run", "gen_skill_run"]) assert.ok(part.includes(`**${I18N.t(key)}`), key);
});
