"use strict";
/* Phase 7 (7B.8): what only a real VS Code can show. Runs in the extension host; each case is a plain async function
   (no test framework in the host), a failure rejects run() and fails the process. The rest stays in the unit tests on
   test/fake-vscode.js. */
const assert = require("assert");
const vscode = require("vscode");

// the extension ID as VS Code builds it from the manifest (<publisher>.<name>)
const PKG = require("../package.json");
const ID = `${PKG.publisher}.${PKG.name}`;
const cases = [];
const it = (name, fn) => cases.push({ name, fn });
let api;

it("activates and returns the test API", async () => {
  const ext = vscode.extensions.getExtension(ID);
  assert.ok(ext, "the extension is installed");
  api = await ext.activate();
  assert.ok(api && typeof api.runMigrations === "function", "SESSIONLENS_TEST=1 gives the test API");
  await api.host.ready;
});

it("registers every contributed command", async () => {
  const pkg = vscode.extensions.getExtension(ID).packageJSON;
  const all = new Set(await vscode.commands.getCommands(true));
  for (const c of pkg.contributes.commands) assert.ok(all.has(c.command), c.command);
});

it("the panel is above the Sessions tree (7A.2)", async () => {
  const views = vscode.extensions.getExtension(ID).packageJSON.contributes.views.sessionlens.map((v) => v.id);
  assert.deepStrictEqual(views, ["sessionlensView", "sessionlensSessionsTree"]);
});

it("migrates sessions from globalState (the 0.1.100 format) into files", async () => {
  const gs = api.context.globalState;
  const s = {
    id: "itest-1",
    name: "itest",
    task: "ITEST-1",
    profile: "qa-ts",
    created: "2026-06-01T00:00:00.000Z",
    events: [],
    findings: [],
    verdicts: {},
    spec: "",
  };
  await gs.update("storageVersion", undefined);
  await gs.update("sessions", { [s.id]: s });
  await api.runMigrations();
  assert.strictEqual(gs.get("sessions"), undefined, "the old key is removed after the move");
  assert.strictEqual(gs.get("storageVersion"), 2);
  assert.ok(
    api.host.store.list().some((m) => m.id === s.id),
    "the session is in the store",
  );
});

it("moves the five panel settings into VS Code settings (the 0.1.102 format)", async () => {
  const gs = api.context.globalState;
  await gs.update("settings", Object.assign({}, gs.get("settings") || {}, { minGapMs: 4321 }));
  await api.runMigrations();
  assert.strictEqual(vscode.workspace.getConfiguration("sessionlens").get("minGapMs"), 4321);
  assert.strictEqual((gs.get("settings") || {}).minGapMs, undefined, "no longer kept in globalState");
  await vscode.workspace.getConfiguration("sessionlens").update("minGapMs", undefined, vscode.ConfigurationTarget.Global);
});

it("opens a session in its own tab", async () => {
  await vscode.commands.executeCommand("sessionlens.openSessionFromTree", "itest-1");
  await new Promise((r) => setTimeout(r, 500));
  const labels = vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label));
  assert.ok(labels.includes("ITEST-1"), labels.join(" | "));
});

it("refuses what validate.js refuses (the phase 3 boundary)", async () => {
  const unknownKey = await api.send("storage:set", { values: { notAKey: 1 } });
  assert.ok(unknownKey && unknownKey.error, JSON.stringify(unknownKey));
  const unknownType = await api.send("no:such-message", {});
  assert.ok(unknownType && unknownType.error, JSON.stringify(unknownType));
  // a field of the wrong type (no dialog is involved, so nothing waits for a person)
  const badTiming = await api.send("log:timing", { event: "import", profile: "qa-ts", ms: "free text", events: 1 });
  assert.ok(badTiming && badTiming.error, JSON.stringify(badTiming));
});

async function run() {
  const failed = [];
  for (const c of cases) {
    try {
      await c.fn();
      console.log(`ok - ${c.name}`);
    } catch (e) {
      failed.push(c.name);
      console.error(`not ok - ${c.name}\n${e && e.stack ? e.stack : e}`);
    }
  }
  if (failed.length) throw new Error(`${failed.length} of ${cases.length} integration cases failed: ${failed.join("; ")}`);
}

module.exports = { run };
