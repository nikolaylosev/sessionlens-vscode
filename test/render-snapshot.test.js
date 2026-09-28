"use strict";
/* Phase 7, step 7A.1: what every view of the real panel renders, on the VS Code code path (test/host-panel.js: the
   page wired through vscode-bridge.js to extension.js), for the perf fixture. The snapshot is the safety net for the
   phase 7 refactoring (removing the Chrome paths, splitting app.js): those steps must leave it unchanged. A step that
   changes the UI on purpose updates it in its own commit (SL_UPDATE_SNAPSHOTS=1 npm test) and lists what changed.
   Normalised: the render is compared as markup with times, dates and counters of elapsed time replaced by markers. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { bootHost, openPage } = require("./host-panel");
const { makeFixture } = require("../perf/fixtures");
const { root } = require("./helpers");

const FILE = path.join(root, "test", "__snapshots__", "render-v0103.json");
const UPDATE = process.env.SL_UPDATE_SNAPSHOTS === "1";
const FX = makeFixture({ n: 8, bytes: 20 * 1024, seed: 11 });
const state = () => JSON.parse(JSON.stringify(Object.assign({ sessions: FX.sessions }, FX.storage)));
const VIEWS = ["sessions", "calib", "rules", "prompts", "settings"];
// one session per profile the fixture has (it has no qa-robot session)
const PROFILES = ["qa-ts", "qa-python", "qa-java", "qa-api"];

function normalise(html) {
  return String(html)
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?/g, "<datetime>")
    .replace(/\b\d{1,2}[./]\d{1,2}[./]\d{2,4}(,? \d{1,2}:\d{2}(:\d{2})?( ?[AP]M)?)?/g, "<date>")
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?( ?[AP]M)?\b/g, "<time>")
    .replace(/\b\d+ ?(ms|s|sec|min|h|d|days?|hours?|minutes?|seconds?|months?|years?) ago\b/g, "<ago>")
    .replace(/\s+/g, " ")
    .replace(/> </g, "><")
    .trim();
}
const click = (p, el) => el.dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));

async function render() {
  const out = {};
  const host = bootHost({ globalState: state() });
  const sb = await openPage(host);
  await sb.ready();
  for (const v of VIEWS) {
    click(sb, sb.document.querySelector(`.tab[data-view="${v}"]`));
    await sb.idle();
    out["sidebar/" + v] = normalise(sb.document.querySelector("#view-" + v).innerHTML);
  }
  const errors = [...sb.errors];
  sb.close();
  for (const prof of PROFILES) {
    const id = Object.keys(FX.sessions).find((k) => FX.sessions[k].profile === prof);
    const tab = await openPage(host, { sessionId: id });
    await tab.ready();
    out["tab/" + prof] = normalise(tab.document.querySelector("#view-review").innerHTML);
    errors.push(...tab.errors);
    tab.close();
  }
  return { out, errors };
}

test("every view renders what the snapshot recorded (VS Code path)", async () => {
  const { out, errors } = await render();
  assert.deepEqual(errors, []);
  if (UPDATE || !fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, JSON.stringify(out, null, 1) + "\n");
    return;
  }
  const want = JSON.parse(fs.readFileSync(FILE, "utf8"));
  assert.deepEqual(Object.keys(out), Object.keys(want));
  for (const k of Object.keys(want)) assert.equal(out[k], want[k], "render of " + k + " changed");
});

test("the render is stable between runs", async () => {
  const a = (await render()).out,
    b = (await render()).out;
  assert.deepEqual(a, b);
});
