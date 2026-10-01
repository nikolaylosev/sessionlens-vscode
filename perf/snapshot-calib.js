"use strict";
/* Renders Calibration (precision table and proposed rules with their evidence and "effect" blocks) of the fixture used
   by test/panel-storage.test.js, through the VS Code code path of the given checkout, and prints it as JSON.
   node perf/snapshot-calib.js <root> > test/__snapshots__/calib-v0100.json   (root: a 0.1.100 checkout)
   For the current checkout, SL_UPDATE_SNAPSHOTS=1 npm test writes the same file (test/panel-storage.test.js). */
const path = require("path");
const { bootHost, openPage } = require("../test/host-panel");
const { makeFixture } = require("./fixtures");

const FIXTURE = { n: 20, bytes: 30 * 1024, seed: 3 };

async function snapshot(root) {
  const fx = makeFixture(FIXTURE);
  const host = bootHost({ root, globalState: JSON.parse(JSON.stringify(Object.assign({ sessions: fx.sessions }, fx.storage))) });
  const p = await openPage(host);
  await p.ready();
  const w = p.window,
    d = p.document;
  d.querySelector('.tab[data-view="calib"]').dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  const m = d.querySelector("#min-count");
  m.value = "1";
  m.dispatchEvent(new w.Event("change", { bubbles: true }));
  await p.idle();
  const out = { precision: d.querySelector("#precision").innerHTML, rules: d.querySelector("#rules").innerHTML };
  d.querySelector('.tab[data-view="rules"]').dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  out.rulesList = d.querySelector("#rules-list").innerHTML;
  p.close();
  return out;
}

if (require.main === module)
  snapshot(path.resolve(process.argv[2] || path.join(__dirname, ".."))).then((o) => {
    process.stdout.write(JSON.stringify(o, null, 1) + "\n");
    process.exit(0);
  });
module.exports = { snapshot, FIXTURE };
