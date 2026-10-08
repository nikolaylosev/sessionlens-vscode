"use strict";
/* Phase 6: VS Code integration. package.json contributions and their nls file, the host's strings, the five settings
   in VS Code Settings (overlay, write, migration, changes from outside), the palette and Sessions-tree commands, the
   page:ready / __slCommand channel, the tree's visibility, tab titles after a rename, and the Output channel. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { fakeVscode, loadExtension, fakeContext, fakeWebviewView, treeSessions } = require("./fake-vscode");
const { bootHost, openPage } = require("./host-panel");
const V = require("../validate.js");
const Lens = require("../media/lens.js");
const { makeFixture } = require("../perf/fixtures");

const root = path.join(__dirname, "..");
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(root, f), "utf8"));
const PKG = readJson("package.json");
const NLS = readJson("package.nls.json");
const APP_SRC = fs.readFileSync(path.join(root, "media", "app.js"), "utf8");
const FIVE = ["minGapMs", "maxCode", "verify", "lint", "rulesTarget"];

const FX = makeFixture({ n: 4, bytes: 10 * 1024, seed: 23 });
const fxState = () => JSON.parse(JSON.stringify(Object.assign({ sessions: FX.sessions }, FX.storage)));
async function until(fn, ms = 5000) {
  const t = Date.now();
  while (!(await fn())) {
    if (Date.now() - t > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

// The host alone, with the sidebar resolved; waits for host.ready (all migrations)
async function hostOnly(opts = {}) {
  const f = fakeVscode(opts.vscode || {});
  const ext = loadExtension(f.vscode);
  const context = fakeContext({ globalState: opts.globalState || {} });
  ext.activate(context);
  const wv = fakeWebviewView();
  f.registered.views.sessionlensView.resolveWebviewView(wv.view);
  await wv.send("secret:status", {});
  return Object.assign(f, { ext, context, wv });
}
// createWebviewPanel for the host's own "open a tab" path (the fake throws by default)
function recordPanels(vscode) {
  const panels = [];
  vscode.window.createWebviewPanel = (viewType, title) => {
    const wv = fakeWebviewView();
    let disposeCb = null;
    const panel = {
      viewType,
      title,
      webview: wv.webview,
      onDidChangeViewState() {},
      onDidDispose(cb) {
        disposeCb = cb;
      },
      reveal() {},
      dispose() {
        panel.disposed = true;
        if (disposeCb) disposeCb();
      },
    };
    panels.push(panel);
    return panel;
  };
  return panels;
}

// ---------- package.json, nls, the host's strings ----------

test("package.json: every %key% is in package.nls.json; no key is unused; no translations (0.1.110)", () => {
  const text = JSON.stringify(PKG);
  const used = new Set([...text.matchAll(/"%([^%"]+)%"/g)].map((m) => m[1]));
  assert.ok(used.size > 20);
  for (const k of used) {
    assert.ok(k in NLS, `en: ${k}`);
  }
  for (const k of Object.keys(NLS)) assert.ok(used.has(k), `unused: ${k}`);
  // English only, whatever the language of VS Code: no package.nls.<lang>.json, no l10n bundle
  assert.equal(PKG.l10n, undefined);
  assert.deepEqual(
    fs.readdirSync(root).filter((f) => /^package\.nls\..+\.json$/.test(f)),
    [],
  );
  assert.equal(fs.existsSync(path.join(root, "l10n")), false);
  // the English texts of 0.1.102 did not change, except the name (0.1.109: "SessionLens for VSCode" → this one;
  // the Marketplace refused plain "SessionLens", which another extension has)
  assert.equal(NLS.displayName, "SessionLens: AI Agent Test Review");
  assert.equal(NLS["container.title"], "SessionLens");
  assert.equal(NLS["view.panel"], "Calibration & Settings");
  assert.equal(NLS["cmd.focus"], "Open panel");
});

test("package.json: activation, views, commands and menus", async () => {
  assert.deepEqual(PKG.activationEvents, ["onWebviewPanel:sessionlensSession"]);
  const views = PKG.contributes.views.sessionlens;
  // phase 7 (7A.2): the panel first, the Sessions tree under it
  assert.deepEqual(
    views.map((v) => v.id),
    ["sessionlensView", "sessionlensSessionsTree"],
  );
  assert.equal(views[1].when, "sessionlens.activeTab == 'sessions' || !sessionlens.activeTab");
  assert.equal(PKG.contributes.viewsWelcome[0].view, "sessionlensSessionsTree");
  assert.match(NLS["welcome.sessions"], /\(command:sessionlens\.importTranscript\)/);
  // every contributed command is registered by activate(), and nothing else is
  const h = await hostOnly();
  const contributed = PKG.contributes.commands.map((c) => c.command).sort();
  assert.deepEqual(Object.keys(h.registered.commands).sort(), contributed);
  const hidden = PKG.contributes.menus.commandPalette
    .filter((m) => m.when === "false")
    .map((m) => m.command)
    .sort();
  assert.deepEqual(hidden, [
    "sessionlens.deleteGroup",
    "sessionlens.deleteSession",
    "sessionlens.moveToGroup",
    "sessionlens.openSessionFromTree",
    "sessionlens.renameGroup",
    "sessionlens.renameSession",
  ]);
  const ctx = PKG.contributes.menus["view/item/context"];
  const menu = (item) => ctx.filter((m) => m.when === `view == sessionlensSessionsTree && viewItem == ${item}`).map((m) => m.command);
  assert.deepEqual(menu("sessionlensSession"), [
    "sessionlens.openSessionFromTree",
    "sessionlens.renameSession",
    "sessionlens.moveToGroup",
    "sessionlens.deleteSession",
  ]);
  // 0.1.124: a group of the person's own ("My groups"); the other groups have no menu
  assert.deepEqual(menu("sessionlensGroupCustom"), ["sessionlens.renameGroup", "sessionlens.deleteGroup"]);
  assert.equal(ctx.length, 6);
  // in a checkout: .vscodeignore keeps package.nls.json in the package; in the unpacked .vsix it is not there, but the
  // file itself must be
  const ignoreFile = path.join(root, ".vscodeignore");
  if (fs.existsSync(ignoreFile)) assert.ok(!/nls/.test(fs.readFileSync(ignoreFile, "utf8")), ".vscodeignore keeps package.nls.json in the package");
  assert.ok(fs.existsSync(path.join(root, "package.nls.json")), "package.nls.json");
});

test("package.json: the five settings are application-scoped and their defaults are the panel's", () => {
  const props = PKG.contributes.configuration.properties;
  const defaults = Function(`return (${/SETTINGS_DEFAULTS = (\{[^}]*\});/.exec(APP_SRC)[1]})`)(); // phase 7: assigned in initSettings() of the built media/app.js
  for (const k of FIVE) {
    const p = props["sessionlens." + k];
    assert.ok(p, k);
    assert.equal(p.scope, "application", k);
    if (k in defaults) assert.equal(p.default, defaults[k], k);
  }
  assert.equal(props["sessionlens.rulesTarget"].default, "claude"); // app.js: rulesTarget || "claude"
  assert.deepEqual(props["sessionlens.rulesTarget"].enum, ["claude", "codex", "cursor", "both"]);
  assert.equal(props["sessionlens.claudeCliPath"].scope, "machine");
});

async function treeDescriptions(language, counts) {
  const sessions = {};
  counts.forEach((n, i) => {
    const id = "c" + i;
    const findings = Array.from({ length: n }, (_, j) => ({ check: "x" + j, seq: j + 1, severity: "low", message: "m" }));
    const verdicts = {};
    findings.forEach((f) => {
      verdicts[Lens.fkey(f)] = { v: "ok" };
    });
    sessions[id] = { id, name: "n" + i, task: "T" + i, profile: "qa-ts", created: new Date(2026, 8, i + 1, 12).toISOString(), events: [], findings, verdicts };
  });
  const h = await hostOnly({ vscode: { language }, globalState: { sessions } });
  const items = await treeSessions(h.registered.trees.sessionlensSessionsTree);
  return Object.fromEntries(items.map((it) => [it.id, it.description]));
}

test("host strings: English whatever the language of VS Code (0.1.110), counts in English plural forms", async () => {
  for (const language of ["en", "ru", "uk"]) {
    const d = await treeDescriptions(language, [1, 2, 5, 21]);
    assert.match(d.c0, /^qa-ts · 1 finding · 1 verdict · 2026-09-01$/, language);
    assert.match(d.c1, /^qa-ts · 2 findings · 2 verdicts · 2026-09-02$/, language);
    assert.match(d.c2, /· 5 findings · 5 verdicts ·/, language);
    assert.match(d.c3, /· 21 findings · 21 verdicts ·/, language);
  }
});

test("host strings: a dialog is in English with VS Code in Russian", async () => {
  const h = await hostOnly({ vscode: { language: "ru", warningAnswer: undefined } });
  const r = await h.wv.send("baseurl:set", { provider: "local", url: "http://127.0.0.1:9999", lang: "en" });
  assert.equal(r.cancelled, true);
  assert.match(h.calls.warning[0][0], /^SessionLens: send .* requests to http:\/\/127\.0\.0\.1:9999\?$/);
  assert.equal(h.calls.warning[0][2], "Use this address");
  assert.ok(!/[А-Яа-яЁё]/.test(JSON.stringify(h.calls.warning)), "no Cyrillic in the dialog");
});

// ---------- settings ----------

test("settings: storage:get lays the configured values over the stored ones; nothing is invented when none is set", async () => {
  const h = await hostOnly({ globalState: { settings: { profile: "qa-java", debugModel: true } } });
  let r = await h.wv.send("storage:get", { keys: ["settings"] });
  assert.deepEqual(r.settings, { profile: "qa-java", debugModel: true });
  h.setConfig("sessionlens.lint", false);
  h.setConfig("sessionlens.maxCode", 90000);
  h.setConfig("sessionlens.rulesTarget", "both");
  r = await h.wv.send("storage:get", { keys: ["settings"] });
  assert.deepEqual(r.settings, { profile: "qa-java", debugModel: true, lint: false, maxCode: 90000, rulesTarget: "both" });
  // a fresh install: no settings stored, none configured → still undefined (the panel starts from its defaults)
  const fresh = await hostOnly();
  assert.equal((await fresh.wv.send("storage:get", { keys: ["settings"] })).settings, undefined);
  // a value that cannot be used is not passed on; one outside the range is brought inside it
  h.setConfig("sessionlens.verify", "yes");
  h.setConfig("sessionlens.minGapMs", -5);
  r = await h.wv.send("storage:get", { keys: ["settings"] });
  assert.equal("verify" in r.settings, false);
  assert.equal(r.settings.minGapMs, 0);
  assert.ok(h.calls.output.some((l) => /sessionlens\.verify has a value SessionLens does not accept/.test(l)));
});

test("settings: storage:set writes only the changed ones to the user settings and keeps them out of globalState", async () => {
  const h = await hostOnly({ globalState: { settings: { profile: "qa-ts" } } });
  await h.wv.send("storage:set", {
    values: { settings: { profile: "qa-ts", minGapMs: 6500, maxCode: 40000, verify: true, lint: true, rulesTarget: "claude", debugModel: false } },
  });
  // the panel set them (even to the defaults): they are set now, in the Global target
  assert.deepEqual(h.calls.configUpdates.map((u) => u[0]).sort(), FIVE.map((k) => "sessionlens." + k).sort());
  assert.ok(h.calls.configUpdates.every((u) => u[2] === 1));
  assert.deepEqual(h.context.globalState.data.settings, { profile: "qa-ts", debugModel: false });
  h.calls.configUpdates.length = 0;
  // the same save again writes nothing; one change writes one key
  await h.wv.send("storage:set", {
    values: { settings: { profile: "qa-go", minGapMs: 6500, maxCode: 40000, verify: true, lint: false, rulesTarget: "claude" } },
  });
  assert.deepEqual(h.calls.configUpdates, [["sessionlens.lint", false, 1]]);
  assert.equal(h.context.globalState.data.settings.profile, "qa-go");
  // out of range: brought inside; not usable: dropped (the default applies), never written
  h.calls.configUpdates.length = 0;
  await h.wv.send("storage:set", { values: { settings: { maxCode: 50, minGapMs: 1500.4, verify: "no" } } });
  assert.deepEqual(h.calls.configUpdates, [
    ["sessionlens.minGapMs", 1500, 1],
    ["sessionlens.maxCode", 1000, 1],
  ]);
  assert.equal("verify" in h.context.globalState.data.settings, false);
});

test("settings: a value that could not be written stays in globalState, so nothing is lost", async () => {
  const h = await hostOnly({ vscode: { configFails: true }, globalState: { settings: { profile: "qa-ts" } } });
  await h.wv.send("storage:set", { values: { settings: { profile: "qa-ts", lint: false, maxCode: 70000 } } });
  assert.deepEqual(h.context.globalState.data.settings, { profile: "qa-ts", lint: false, maxCode: 70000 });
  assert.ok(h.calls.output.some((l) => /could not write the setting sessionlens\.lint/.test(l)));
});

test("settings: a page that has not seen an edit of settings.json yet does not write the old value back (§11.15)", async () => {
  const h = await hostOnly({ globalState: { settings: { profile: "qa-ts" } } });
  h.setConfig("sessionlens.lint", false);
  h.setConfig("sessionlens.maxCode", 90000);
  const seen = (await h.wv.send("storage:get", { keys: ["settings"] })).settings;
  // settings.json is edited; the refresh has not reached the page, which saves something else with what it saw
  h.setConfig("sessionlens.lint", true);
  h.setConfig("sessionlens.maxCode", undefined);
  h.calls.configUpdates.length = 0;
  await h.wv.send("storage:set", { values: { settings: Object.assign({}, seen, { profile: "qa-java" }) } });
  assert.deepEqual(h.calls.configUpdates, []);
  assert.equal(h.config.global["sessionlens.lint"], true);
  assert.equal("sessionlens.maxCode" in h.config.global, false);
  assert.deepEqual(h.context.globalState.data.settings, { profile: "qa-java" });
  // what the page does change is written, and its own write counts as seen: a later edit of settings.json is not
  // undone by the page's next save either
  await h.wv.send("storage:set", { values: { settings: Object.assign({}, seen, { lint: true, maxCode: 70000 }) } });
  assert.deepEqual(h.calls.configUpdates, [["sessionlens.maxCode", 70000, 1]]);
  h.setConfig("sessionlens.maxCode", 80000);
  h.calls.configUpdates.length = 0;
  await h.wv.send("storage:set", { values: { settings: Object.assign({}, seen, { lint: true, maxCode: 70000, profile: "qa-ts" }) } });
  assert.deepEqual(h.calls.configUpdates, []);
  assert.equal(h.config.global["sessionlens.maxCode"], 80000);
});

test("settings: a value that could not be written is tried again on the next save, not taken as seen", async () => {
  const h = await hostOnly({ vscode: { configFails: true }, globalState: { settings: { profile: "qa-ts" } } });
  await h.wv.send("storage:get", { keys: ["settings"] });
  for (let i = 0; i < 2; i++) {
    await h.wv.send("storage:set", { values: { settings: { profile: "qa-ts", lint: false } } });
    assert.deepEqual(h.context.globalState.data.settings, { profile: "qa-ts", lint: false }, `save ${i + 1}`);
  }
  assert.equal(h.calls.output.filter((l) => /could not write the setting sessionlens\.lint/.test(l)).length, 2);
});

test("settings: a workspace value is ignored (application scope)", async () => {
  const h = await hostOnly({
    vscode: { config: { workspace: { "sessionlens.lint": false, "sessionlens.minGapMs": 0 } } },
    globalState: { settings: { profile: "qa-ts" } },
  });
  const r = await h.wv.send("storage:get", { keys: ["settings"] });
  assert.deepEqual(r.settings, { profile: "qa-ts" });
});

test("settings: a change in VS Code Settings refreshes every page, the one that wrote it included", async () => {
  const h = await hostOnly();
  const other = fakeWebviewView();
  // a second page: a session tab would register the same way; the sidebar view is enough to see the broadcast
  h.registered.views.sessionlensView.resolveWebviewView(other.view);
  const before = [h.wv.posted.length, other.posted.length];
  h.setConfig("sessionlens.verify", false);
  const refreshes = (w, n) => w.posted.slice(n).filter((m) => m.__slRefresh && m.scope === "keys").length;
  assert.equal(refreshes(h.wv, before[0]), 1);
  assert.equal(refreshes(other, before[1]), 1);
  assert.ok(h.calls.output.some((l) => /settings changed: sessionlens\.verify/.test(l)));
  // the CLI paths are not panel settings: no refresh
  const n = other.posted.length;
  h.setConfig("sessionlens.claudeCliPath", "/usr/bin/claude");
  assert.equal(refreshes(other, n), 0);
});

test("settings migration: moves what the panel had, the person's own values win, a failure keeps the field", async () => {
  const stored = { profile: "qa-ts", lint: false, minGapMs: 6500, maxCode: 50, verify: "x", rulesTarget: "codex", debugModel: true };
  const h = await hostOnly({ vscode: { config: { global: { "sessionlens.rulesTarget": "both" } } }, globalState: { settings: stored } });
  const g = h.config.global;
  assert.equal(g["sessionlens.lint"], false);
  assert.equal(g["sessionlens.minGapMs"], 6500, "a value that was set stays set, even the default");
  assert.equal(g["sessionlens.maxCode"], 1000, "brought inside the range");
  assert.equal("sessionlens.verify" in g, false, "an unusable value is dropped");
  assert.equal(g["sessionlens.rulesTarget"], "both", "the person's own value wins");
  assert.deepEqual(h.context.globalState.data.settings, { profile: "qa-ts", debugModel: true });
  assert.ok(h.calls.output.some((l) => /migration: panel settings to VS Code settings: moved/.test(l)));
  // a second start: nothing to do, nothing logged
  const h2 = await hostOnly({ vscode: { config: { global: g } }, globalState: h.context.globalState.data });
  assert.equal(h2.calls.configUpdates.length, 0);
  assert.ok(!h2.calls.output.some((l) => /panel settings to VS Code settings/.test(l)));
  // settings cannot be written: every field stays for the next start
  const h3 = await hostOnly({ vscode: { configFails: true }, globalState: { settings: { profile: "qa-ts", lint: false } } });
  assert.deepEqual(h3.context.globalState.data.settings, { profile: "qa-ts", lint: false });
  assert.ok(h3.calls.output.some((l) => /not moved yet: sessionlens\.lint/.test(l)));
});

test("settings: switching ESLint in settings.json re-analyzes sessions that are not open in a tab", async () => {
  const host = bootHost({ globalState: fxState() });
  const sb = await openPage(host);
  await sb.ready();
  assert.equal(host.config.global["sessionlens.lint"], false, "migrated from the fixture's settings");
  const ids = Object.keys(FX.sessions);
  const dir = path.join(host.context.globalStorageUri.fsPath, "sessions");
  const metas = () => ids.map((id) => JSON.parse(fs.readFileSync(path.join(dir, id + ".meta.json"), "utf8")));
  const gen = sb.window.eval("Lens.analysisGen({ ruleOverrides: {}, lint: true, epoch: 0 })");
  assert.ok(metas().every((m) => m.analyzedGen !== gen));
  host.setConfig("sessionlens.lint", true);
  await until(() => metas().every((m) => m.analyzedGen === gen), 15000);
  assert.deepEqual(sb.errors, []);
  sb.close();
});

// ---------- tree, titles, visibility ----------

test("tree: items carry the session id; empty tree gives the welcome view; a renamed session shows its name", async () => {
  const empty = await hostOnly();
  assert.deepEqual(await treeSessions(empty.registered.trees.sessionlensSessionsTree), []);
  const s = { id: "a1", name: "file-53c3", task: "TASK-7", profile: "qa-ts", created: "2026-09-01T00:00:00Z", events: [], findings: [], verdicts: {} };
  const h = await hostOnly({ globalState: { sessions: { a1: s, b2: Object.assign({}, s, { id: "b2", name: "My name", nameSet: true }) } } });
  const items = await treeSessions(h.registered.trees.sessionlensSessionsTree);
  const by = Object.fromEntries(items.map((it) => [it.id, it]));
  assert.equal(by.a1.label, "TASK-7");
  assert.equal(by.a1.tooltip, "file-53c3");
  assert.equal(by.b2.label, "My name");
  assert.equal(by.b2.tooltip, "TASK-7");
  assert.equal(by.a1.contextValue, "sessionlensSession");
  assert.deepEqual(by.a1.command.arguments, ["a1"]);
});

test("visibility: hiding the panel shows the Sessions tree again (activeTab reset); the page re-announces its tab", async () => {
  const f = fakeVscode();
  const ext = loadExtension(f.vscode);
  ext.activate(fakeContext());
  const wv = fakeWebviewView();
  let visCb = null;
  wv.view.onDidChangeVisibility = (cb) => {
    visCb = cb;
  };
  f.registered.views.sessionlensView.resolveWebviewView(wv.view);
  await wv.send("tab:active", { tab: "rules" });
  const ctx = () => f.calls.commands.filter((c) => c[0] === "setContext").map((c) => c[2]);
  assert.deepEqual(ctx(), ["rules"]);
  wv.view.visible = false;
  visCb();
  assert.deepEqual(ctx(), ["rules", ""]);
  // no setContext at activate(): the host does not know which tab the page will show
  const g = fakeVscode();
  loadExtension(g.vscode).activate(fakeContext());
  assert.equal(g.calls.commands.filter((c) => c[0] === "setContext").length, 0);
  // app.js: on the "focus" refresh the sidebar says which tab it shows and that it is ready
  const host = bootHost({});
  const sb = await openPage(host);
  await sb.ready();
  const n = sb.sent.length;
  sb.window.SL_REFRESH({ __slRefresh: true, scope: "focus" });
  await sb.idle();
  const types = sb.sent.slice(n).map((m) => m.type);
  assert.ok(types.includes("tab:active") && types.includes("page:ready"), types.join());
  sb.close();
});

// ---------- commands ----------

test("Open session…: a QuickPick of the index; the pick opens its tab, titled with its display name", async () => {
  let offered = null;
  const s = {
    id: "q1",
    name: "file",
    task: "TASK-9",
    profile: "qa-api",
    created: new Date(2026, 8, 2, 12).toISOString(),
    events: [],
    findings: [],
    verdicts: {},
  }; // local midday: the tree shows the local day
  const h = await hostOnly({
    vscode: {
      quickPickAnswer: (items) => {
        offered = items;
        return items[0];
      },
    },
    globalState: { sessions: { q1: s } },
  });
  const panels = recordPanels(h.vscode);
  await h.registered.commands["sessionlens.openSession"]();
  assert.equal(offered.length, 1);
  assert.equal(offered[0].label, "TASK-9");
  assert.match(offered[0].description, /^qa-api · 0 findings · 2026-09-02$/);
  assert.equal(panels.length, 1);
  assert.equal(panels[0].title, "TASK-9");
  // no sessions: a message instead of an empty picker
  const e = await hostOnly();
  await e.registered.commands["sessionlens.openSession"]();
  assert.equal(e.calls.quickPick.length, 0);
  assert.match(e.calls.info[0], /no sessions yet/);
});

test("Open settings opens this extension's settings", async () => {
  const h = await hostOnly();
  await h.registered.commands["sessionlens.openSettings"]();
  assert.deepEqual(
    h.calls.commands.find((c) => c[0] === "workbench.action.openSettings"),
    ["workbench.action.openSettings", "@ext:nikolaylosev.sessionlens-vscode"],
  );
});

test("Rename (tree), no tab open: written through the store with its rev; tree, index and later tab title follow", async () => {
  const host = bootHost({ globalState: fxState(), vscode: { inputBoxAnswer: "  Checkout smoke  " } });
  const sb = await openPage(host);
  await sb.ready();
  const id = Object.keys(FX.sessions)[1];
  const items = await treeSessions(host.registered.trees.sessionlensSessionsTree);
  await host.registered.commands["sessionlens.renameSession"](items.find((it) => it.id === id));
  const meta = JSON.parse(fs.readFileSync(path.join(host.context.globalStorageUri.fsPath, "sessions", id + ".meta.json"), "utf8"));
  assert.equal(meta.name, "Checkout smoke");
  assert.equal(meta.nameSet, true);
  assert.equal(meta.rev, 2);
  const after = await treeSessions(host.registered.trees.sessionlensSessionsTree);
  assert.equal(after.find((it) => it.id === id).label, "Checkout smoke");
  assert.ok(
    sb.posted.some((m) => m.__slRefresh && m.scope === "session" && m.sessionId === id && m.meta && m.meta.name === "Checkout smoke"),
    "the sidebar got the new summary",
  );
  const tab = await openPage(host, { sessionId: id });
  await tab.ready();
  assert.equal(tab.panel.title, "Checkout smoke");
  assert.match(tab.document.querySelector("#hdr h1").textContent, /^Checkout smoke/);
  // Escape in the input box: nothing happens
  host.vscode.window.showInputBox = async () => undefined;
  await host.registered.commands["sessionlens.renameSession"](id);
  assert.equal(JSON.parse(fs.readFileSync(path.join(host.context.globalStorageUri.fsPath, "sessions", id + ".meta.json"), "utf8")).rev, 2);
  sb.close();
  tab.close();
});

test("Rename (tree), tab open: the tab renames its own session (no conflict) and its title changes", async () => {
  const host = bootHost({ globalState: fxState(), vscode: { inputBoxAnswer: "Renamed in tab" } });
  const id = Object.keys(FX.sessions)[0];
  const tab = await openPage(host, { sessionId: id });
  await tab.ready();
  const before = tab.panel.title;
  await host.registered.commands["sessionlens.renameSession"](id);
  await until(() => tab.panel.title === "Renamed in tab");
  await tab.idle();
  assert.notEqual(before, "Renamed in tab");
  const puts = tab.sent.filter((m) => m.type === "session:put");
  assert.equal(puts.length, 1);
  assert.equal(puts[0].payload.session.nameSet, true);
  assert.equal(tab.posted.filter((m) => m.__slReply && m.result && m.result.conflict).length, 0);
  // then a verdict in the same tab still saves (its rev is current)
  const undecided = [...tab.document.querySelectorAll("#findings .f")].find((d) => !d.classList.contains("done"));
  if (undecided) {
    undecided.querySelector(".v-fp").dispatchEvent(new tab.window.MouseEvent("click", { bubbles: true }));
    await tab.idle();
    const last = tab.posted.filter((m) => m.__slReply).pop();
    assert.equal(last.result.ok, true);
  }
  assert.deepEqual(tab.errors, []);
  tab.close();
});

test("Move to group (tree) while the session is open in a tab: the tab's next verdict keeps the group (0.1.124)", async () => {
  const host = bootHost({ globalState: fxState(), vscode: { quickPickAnswer: (items) => items.find((i) => i.make), inputBoxAnswer: "Checkout" } });
  const id = Object.keys(FX.sessions)[0];
  const tab = await openPage(host, { sessionId: id });
  await tab.ready();
  await host.registered.commands["sessionlens.moveToGroup"](id);
  const meta = () => JSON.parse(fs.readFileSync(path.join(host.context.globalStorageUri.fsPath, "sessions", id + ".meta.json"), "utf8"));
  assert.equal(meta().group, "Checkout");
  const before = meta().verdictsCount;
  const undecided = [...tab.document.querySelectorAll("#findings .f")].find((d) => !d.classList.contains("done"));
  assert.ok(undecided, "a finding without a verdict");
  undecided.querySelector(".v-fp").dispatchEvent(new tab.window.MouseEvent("click", { bubbles: true }));
  await until(() => meta().verdictsCount > before);
  await tab.idle();
  assert.equal(meta().group, "Checkout", "the tab read the session again after the conflict and kept the group");
  assert.deepEqual(tab.errors, []);
  tab.close();
});

test("Delete (tree): asks first; closes the session's tab; gone from store, tree and sidebar", async () => {
  const host = bootHost({ globalState: fxState(), vscode: { warningAnswer: (msg, o, yes) => yes } });
  const sb = await openPage(host);
  await sb.ready();
  const id = Object.keys(FX.sessions)[2];
  const tab = await openPage(host, { sessionId: id });
  await tab.ready();
  await host.registered.commands["sessionlens.deleteSession"](id);
  assert.equal(host.calls.warning.length, 1);
  assert.equal(host.calls.warning[0][1].modal, true);
  assert.equal(tab.panel.disposed, true);
  assert.ok(!fs.existsSync(path.join(host.context.globalStorageUri.fsPath, "sessions", id + ".json")));
  const items = await treeSessions(host.registered.trees.sessionlensSessionsTree);
  assert.ok(!items.some((it) => it.id === id));
  assert.ok(
    sb.posted.some((m) => m.__slRefresh && m.scope === "session" && m.sessionId === id && m.meta === null),
    "the sidebar was told",
  );
  // answered "Cancel": nothing is deleted
  const other = Object.keys(FX.sessions)[3];
  host.vscode.window.showWarningMessage = async () => undefined;
  await host.registered.commands["sessionlens.deleteSession"](other);
  assert.ok(fs.existsSync(path.join(host.context.globalStorageUri.fsPath, "sessions", other + ".json")));
  sb.close();
});

test("Export verdicts / Import transcript…: the host shows the sidebar, waits for page:ready and sends the command", async () => {
  const host = bootHost({ globalState: fxState() });
  const sb = await openPage(host);
  await sb.ready();
  const id = Object.keys(FX.sessions)[0];
  // a verdict to export
  const tab = await openPage(host, { sessionId: id });
  await tab.ready();
  const undecided = [...tab.document.querySelectorAll("#findings .f")].find((d) => !d.classList.contains("done"));
  undecided.querySelector(".v-ok").dispatchEvent(new tab.window.MouseEvent("click", { bubbles: true }));
  await tab.idle();
  await sb.idle();
  await host.registered.commands["sessionlens.exportVerdicts"]();
  assert.ok(host.calls.commands.some((c) => c[0] === "sessionlensView.focus"));
  assert.ok(sb.posted.some((m) => m.__slCommand && m.name === "exportVerdicts"));
  await until(() => sb.sent.some((m) => m.type === "save:file"));
  const save = sb.sent.find((m) => m.type === "save:file");
  assert.equal(save.payload.name, "verdicts.json");
  const rows = JSON.parse(save.payload.content);
  assert.ok(rows.length >= 1 && rows.every((r) => r.schema === "sessionlens/finding@1"));
  assert.equal(sb.document.querySelector(".tab.active").dataset.view, "calib");
  // import: the page switches to Sessions and asks where the transcript is from (its own dialog)
  await host.registered.commands["sessionlens.importTranscript"]();
  await until(() => sb.document.querySelector(".sl-modal-overlay"));
  assert.equal(sb.document.querySelector(".tab.active").dataset.view, "sessions");
  assert.deepEqual([...sb.errors, ...tab.errors], []);
  sb.close();
  tab.close();
});

test("a palette command for the sidebar gives up when the page does not start, with a message and a log line", async () => {
  const f = fakeVscode();
  const ext = loadExtension(f.vscode);
  ext._test.setReadyTimeout(50);
  ext.activate(fakeContext());
  const wv = fakeWebviewView();
  f.registered.views.sessionlensView.resolveWebviewView(wv.view); // resolved, but its page never says ready
  await f.registered.commands["sessionlens.importTranscript"]();
  assert.equal(wv.posted.filter((m) => m.__slCommand).length, 0);
  assert.match(f.calls.error[0][0], /did not open in time/);
  assert.ok(f.calls.output.some((l) => /command import: the panel did not start/.test(l)));
  // once it is ready the command goes through
  await wv.send("page:ready", {});
  await f.registered.commands["sessionlens.importTranscript"]();
  assert.deepEqual(
    wv.posted.filter((m) => m.__slCommand).map((m) => m.name),
    ["import"],
  );
});

test("the bridge passes only known commands; a session tab ignores import/export", async () => {
  const host = bootHost({ globalState: fxState() });
  const id = Object.keys(FX.sessions)[0];
  const tab = await openPage(host, { sessionId: id });
  await tab.ready();
  const n = tab.sent.length;
  const post = (data) => tab.window.dispatchEvent(new tab.window.MessageEvent("message", { data }));
  post({ __slCommand: true, name: "exportVerdicts" });
  post({ __slCommand: true, name: "import" });
  post({ __slCommand: true, name: "renameAll", value: "x" });
  await tab.idle();
  assert.deepEqual(
    tab.sent.slice(n).map((m) => m.type),
    [],
  );
  assert.equal(tab.document.querySelectorAll(".sl-modal-overlay").length, 0);
  tab.close();
});

// ---------- messages and the Output channel ----------

test("validate.js: page:ready and log:timing (numbers and closed lists only)", () => {
  const ctx = { profiles: [...Lens.PROFILES, ...Object.keys(Lens.ALIAS || {})] };
  assert.equal(V.validate("page:ready", {}, ctx), null);
  assert.equal(V.validate("log:timing", { event: "import", profile: "qa-c#", ms: 12, events: 40 }, ctx), null);
  for (const bad of [
    { event: "hack", profile: "qa-ts", ms: 1, events: 1 },
    { event: "import", profile: "<img src=x>", ms: 1, events: 1 },
    { event: "import", profile: "qa-nope", ms: 1, events: 1 },
    { event: "import", profile: "qa-ts", ms: -1, events: 1 },
    { event: "import", profile: "qa-ts", ms: 1.5, events: 1 },
    { event: "import", profile: "qa-ts", ms: 1, events: "all" },
  ])
    assert.notEqual(V.validate("log:timing", bad, ctx), null, JSON.stringify(bad));
  assert.deepEqual(V.TIMING_EVENTS, ["import", "reanalyze", "background"]);
});

test("Output channel: migrations, analysis times and CLI failures are logged; no transcript text, no prompt", async () => {
  const MARK = "TRANSCRIPT-SECRET-MARK-4711";
  const host = bootHost({ globalState: fxState() });
  const sb = await openPage(host);
  await sb.ready();
  const text = [
    JSON.stringify({ type: "user", message: { role: "user", content: `write a test ${MARK}` } }),
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "Write",
            input: { file_path: "tests/a.spec.ts", content: `test('${MARK}', async () => { await page.waitForTimeout(500); });` },
          },
        ],
      },
    }),
  ].join("\n");
  sb.window.eval(`window.__slPickTranscript = async () => ({ name: "mark.jsonl", text: ${JSON.stringify(text)} })`);
  await host.registered.commands["sessionlens.importTranscript"]();
  await until(() => sb.document.querySelector(".sl-modal-overlay button"));
  sb.document.querySelector(".sl-modal-overlay button").click(); // the first (primary) source
  await until(() => !sb.document.querySelector("#name-row").hidden);
  sb.document.querySelector("#name-go").click();
  await until(() => host.calls.output.some((l) => /analysis \(import\): qa-ts, \d+ events, \d+ ms/.test(l)));
  // a CLI that fails: code and time, not what it printed
  const wv = fakeWebviewView();
  host.registered.views.sessionlensView.resolveWebviewView(wv.view);
  host.config.global["sessionlens.claudeCliPath"] = path.join(root, "no-such-claude-binary");
  const r = await wv.send("claude:run", { system: `sys ${MARK}`, user: `user ${MARK}`, timeoutMs: 5000 });
  assert.ok(r.error);
  assert.ok(
    host.calls.output.some((l) => /claude CLI run failed after \d+ ms: \w+/.test(l)),
    host.calls.output.join("\n"),
  );
  const log = host.calls.output.join("\n");
  assert.ok(/migration: /.test(log));
  assert.equal(log.includes(MARK), false, "nothing from the transcript or the prompt");
  assert.deepEqual(sb.errors, []);
  sb.close();
});
