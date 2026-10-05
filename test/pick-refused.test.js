"use strict";
/* A transcript pick the host refuses or fails is said in a dialog (0.1.121). Before, nothing happened at all: a .vsix
   installed without reloading the window left a host that refused the new "cursor" source, and Choose file did
   nothing. The real panel and host; the source is one the host does not know. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { bootHost, openPage } = require("./host-panel");

async function until(fn, ms = 8000) {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("Choose file: a source the host refuses shows the reason and how to fix it, no dialog, no session", async () => {
  const host = bootHost({ globalState: { storageVersion: 2, settings: { profile: "qa-ts", lint: false, modelPool: [], defaultModelId: null } } });
  const p = await openPage(host);
  await p.ready();
  const alerts = [];
  p.window.chooseDialog = async () => "newer-source"; // what an older host does not know
  p.window.alertDialog = async (m) => alerts.push(m);
  p.document.querySelector("#file").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
  await until(() => alerts.length);
  assert.match(alerts[0], /SessionLens: unknown source/);
  assert.match(alerts[0], /Developer: Reload Window/);
  assert.equal(host.calls.openDialog.length, 0);
  assert.equal(p.document.querySelector("#name-row").hidden, true, "no import was started");
  assert.equal(p.sent.filter((m) => m.type === "session:put").length, 0);
  assert.deepEqual(p.errors, []);
  p.close();
});
