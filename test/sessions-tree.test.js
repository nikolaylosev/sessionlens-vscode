"use strict";
/* The Sessions tree groups its sessions (0.1.124): by date by default (Today, Yesterday, This week since Monday,
   Earlier), or by profile, verdict or agent (sessionlens.sessionsGroupBy, the button in the tree's title). The host
   alone with the fake vscode module; the clock is fixed, the dates are local, so the test does not depend on the
   time zone. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { fakeVscode, loadExtension, fakeContext, fakeWebviewView, treeSessions } = require("./fake-vscode");

// Wednesday, 7 October 2026, 15:00 local time
const NOW = new Date(2026, 9, 7, 15, 0, 0).getTime();
const at = (d, h = 12) => new Date(2026, 9, d, h, 0, 0).toISOString();

const finding = (seq) => ({ check: "weak_assert", seq, severity: "high", message: "weak " + seq });
function session(id, extra = {}) {
  const { started, ...rest } = extra;
  return Object.assign(
    {
      id,
      name: id,
      task: "",
      profile: "qa-ts",
      created: at(7, 9),
      events: started ? [{ seq: 1, ts: started, kind: "user", text: "hi" }] : [],
      findings: [],
      verdicts: {},
      agent: "claude-code",
    },
    rest,
  );
}
async function host(sessions, opts = {}) {
  const f = fakeVscode({ config: { global: opts.config || {} }, quickPickAnswer: opts.quickPickAnswer, configFails: opts.configFails });
  const ext = loadExtension(f.vscode);
  ext._test.setNow(() => opts.now || NOW);
  ext.activate(fakeContext({ globalState: { sessions: Object.fromEntries(sessions.map((s) => [s.id, s])) } }));
  const wv = fakeWebviewView();
  f.registered.views.sessionlensView.resolveWebviewView(wv.view);
  await wv.send("secret:status", {}); // waits for host.ready: the sessions are in files
  return Object.assign(f, { tree: f.registered.trees.sessionlensSessionsTree });
}
// [group label, count, [session ids]] in the order shown
async function groups(tree) {
  const out = [];
  for (const g of await tree.getChildren()) out.push([g.label, g.description, (await tree.getChildren(g)).map((s) => s.id)]);
  return out;
}

test("by date (the default): Today, Yesterday, This week, Earlier by when the agent ran it; empty groups are not shown", async () => {
  const h = await host([
    session("today", { started: at(7, 8) }),
    session("yesterday", { started: at(6, 23) }),
    session("monday", { started: at(5, 0) }),
    session("sunday", { started: at(4, 22) }),
    // imported today, ran last week: Earlier, by when it ran
    session("ran-before", { started: at(1), created: at(7, 10) }),
    // a claude.ai export has no times: the import's date
    session("no-times", { created: at(6, 10) }),
    session("no-date", { created: "" }),
    session("later-today", { started: at(7, 14) }),
  ]);
  assert.deepEqual(await groups(h.tree), [
    ["Today", "2", ["later-today", "today"]],
    ["Yesterday", "2", ["yesterday", "no-times"]],
    ["This week", "1", ["monday"]],
    ["Earlier", "3", ["sunday", "ran-before", "no-date"]],
  ]);
  const [g] = await h.tree.getChildren();
  assert.equal(g.collapsibleState, h.vscode.TreeItemCollapsibleState.Expanded);
  assert.equal(g.contextValue, "sessionlensGroup", "no session menu on a group");
  assert.equal(g.id, "group\ndate\ntoday");
  const [s] = await h.tree.getChildren(g);
  assert.deepEqual([s.contextValue, s.command.arguments], ["sessionlensSession", ["later-today"]], "a session item as before");

  // on a Monday, Sunday is Yesterday and Saturday is Earlier: the week starts on Monday
  const mon = await host([session("sun", { started: at(4, 9) }), session("sat", { started: at(3, 9) }), session("mon", { started: at(5, 1) })], {
    now: new Date(2026, 9, 5, 10).getTime(),
  });
  assert.deepEqual(await groups(mon.tree), [
    ["Today", "1", ["mon"]],
    ["Yesterday", "1", ["sun"]],
    ["Earlier", "1", ["sat"]],
  ]);
});

// by profile, verdict or agent a group keeps the tree's order: the last import first
test("by profile, verdict or agent; an agent the summary does not know is Unknown agent", async () => {
  const sessions = [
    session("a", { profile: "qa-python", findings: [finding(1)], agent: "codex" }),
    session("b", { profile: "qa-ts", agent: "cursor" }),
    session("c", { profile: "qa-api", findings: [{ check: "raw_locator", seq: 2, severity: "medium", message: "m" }], agent: "" }),
    session("d", { profile: "qa-ts", agent: "claude-code" }),
  ];
  const by = async (v) => groups((await host(sessions, { config: { "sessionlens.sessionsGroupBy": v } })).tree);
  assert.deepEqual(await by("profile"), [
    ["qa-ts", "2", ["d", "b"]],
    ["qa-python", "1", ["a"]],
    ["qa-api", "1", ["c"]],
  ]);
  assert.deepEqual(await by("verdict"), [
    ["Red", "1", ["a"]],
    ["Yellow", "1", ["c"]],
    ["Green", "2", ["d", "b"]],
  ]);
  assert.deepEqual(await by("agent"), [
    ["Claude Code", "1", ["d"]],
    ["Codex", "1", ["a"]],
    ["Cursor", "1", ["b"]],
    ["Unknown agent", "1", ["c"]],
  ]);
  const h = await host(sessions, { config: { "sessionlens.sessionsGroupBy": "agent" } });
  const unknown = (await h.tree.getChildren()).find((g) => g.label === "Unknown agent");
  assert.match(unknown.tooltip, /Import again/);
  assert.deepEqual(await by("nonsense"), await by("date"), "a value the setting does not have: by date");
});

test("the title button: a QuickPick with the current choice ticked; a pick is written to the user's settings and regroups", async () => {
  let offered = null,
    answer = (items) => items.find((i) => i.value === "verdict");
  const h = await host([session("a", { findings: [finding(1)] }), session("b")], {
    quickPickAnswer: (items) => ((offered = items), answer(items)),
  });
  let fired = 0;
  h.tree.onDidChangeTreeData(() => fired++);
  await h.registered.commands["sessionlens.groupSessions"]();
  assert.deepEqual(
    offered.map((i) => [i.value, i.label]),
    [
      ["date", "$(check) Date"],
      ["profile", "Profile"],
      ["verdict", "Verdict"],
      ["agent", "Agent"],
    ],
  );
  assert.deepEqual(h.calls.configUpdates, [["sessionlens.sessionsGroupBy", "verdict", h.vscode.ConfigurationTarget.Global]]);
  assert.ok(fired > 0, "the tree is redrawn");
  assert.deepEqual(await groups(h.tree), [
    ["Red", "1", ["a"]],
    ["Green", "1", ["b"]],
  ]);
  // Escape, or the choice already in place: nothing is written
  answer = () => undefined;
  await h.registered.commands["sessionlens.groupSessions"]();
  answer = (items) => items.find((i) => i.value === "verdict");
  await h.registered.commands["sessionlens.groupSessions"]();
  assert.equal(h.calls.configUpdates.length, 1);
  assert.equal(offered.find((i) => i.value === "verdict").label, "$(check) Verdict");
});

test("a change of the setting from outside (settings.json, another window) redraws the tree", async () => {
  const h = await host([session("a")]);
  let fired = 0;
  h.tree.onDidChangeTreeData(() => fired++);
  h.setConfig("sessionlens.sessionsGroupBy", "profile");
  assert.equal(fired, 1);
  assert.deepEqual(await groups(h.tree), [["qa-ts", "1", ["a"]]]);
  h.setConfig("sessionlens.verify", false);
  assert.equal(fired, 1, "another setting does not");
});

test("no sessions: no groups, so the welcome view with its Import button shows", async () => {
  const h = await host([]);
  assert.deepEqual(await h.tree.getChildren(), []);
  assert.deepEqual(await treeSessions(h.tree), []);
});

test("the line under a session shows the day the tree groups it by: when the agent ran it, else the import's", async () => {
  const h = await host([session("ran", { started: at(1, 9), created: at(7, 10) }), session("no-times", { created: at(6, 10) })]);
  const by = Object.fromEntries((await treeSessions(h.tree)).map((s) => [s.id, s.description]));
  assert.equal(by.ran, "qa-ts · 0 findings · 2026-10-01", "imported on the 7th, ran on the 1st: Earlier, and the 1st");
  assert.equal(by["no-times"], "qa-ts · 0 findings · 2026-10-06");
});

// the owner's first try of 0.1.124: a .vsix installed into an open window, where VS Code refused to write the setting
test("the title button regroups even when the setting cannot be written, and says so; a later change of the setting wins", async () => {
  const h = await host([session("a", { findings: [finding(1)] }), session("b")], {
    configFails: true,
    quickPickAnswer: (items) => items.find((i) => i.value === "verdict"),
  });
  await h.registered.commands["sessionlens.groupSessions"]();
  assert.deepEqual(
    (await groups(h.tree)).map((g) => g[0]),
    ["Red", "Green"],
  );
  assert.equal(h.calls.warning.length, 1);
  assert.match(h.calls.warning[0][0], /grouped by verdict in this window, but the choice could not be saved\. Reload the window/);
  assert.ok(h.calls.output.some((l) => /could not write the setting sessionlens\.sessionsGroupBy/.test(l)));
  h.setConfig("sessionlens.sessionsGroupBy", "profile");
  assert.deepEqual(
    (await groups(h.tree)).map((g) => g[0]),
    ["qa-ts"],
  );
});
