"use strict";
/* Loads the webview modules in Node the same way the webview sees them: as globals. */
const path = require("path");
const M = (f) => path.join(__dirname, "..", "media", f);
function load() {
  const I18N = require(M("i18n.js"));
  I18N.set("en");
  const Lens = require(M("lens.js"));
  const LensRules = require(M("rules.js"));
  return { I18N, Lens, LensRules, M };
}
module.exports = { load, M, root: path.join(__dirname, "..") };
