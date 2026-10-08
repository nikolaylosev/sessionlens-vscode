"use strict";
/* The Sessions tree groups its sessions (0.1.124): by date by default (Today, Yesterday, This week since Monday,
   Earlier), or by profile, verdict or agent (sessionlens.sessionsGroupBy, the button in the tree's title). Its filter
   (the search button): a part of the name, task or profile, Only Red, With findings without a verdict. The host
   alone with the fake vscode module; the clock is fixed, the dates are local, so the test does not depend on the
   time zone. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { fakeVscode, loadExtension, fakeContext, fakeWebviewView, treeSessions } = require("./fake-vscode");
const Lens = require("../media/lens.js");
const fs = require("fs");
const path = require("path");

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
  const f = fakeVscode({
    config: { global: opts.config || {} },
    quickPickAnswer: opts.quickPickAnswer,
    configFails: opts.configFails,
    quickPickFlow: opts.quickPickFlow,
    inputBoxAnswer: opts.inputBoxAnswer,
    warningAnswer: opts.warningAnswer,
  });
  const ext = loadExtension(f.vscode);
  ext._test.setNow(() => opts.now || NOW);
  const context = fakeContext({ globalState: { sessions: Object.fromEntries(sessions.map((s) => [s.id, s])) } });
  ext.activate(context);
  const wv = fakeWebviewView();
  f.registered.views.sessionlensView.resolveWebviewView(wv.view);
  await wv.send("secret:status", {}); // waits for host.ready: the sessions are in files
  return Object.assign(f, { tree: f.registered.trees.sessionlensSessionsTree, dir: path.join(context.globalStorageUri.fsPath, "sessions"), wv });
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
      ["custom", "My groups"],
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

// ---------- the filter ----------

const verdict = (f, v) => ({ [Lens.fkey(f)]: { v } });
function filterSessions() {
  const a1 = finding(1),
    d1 = finding(2),
    e1 = finding(3);
  return [
    // red, a finding without a verdict
    session("a", { task: "Cart checkout", findings: [a1] }),
    // yellow, every finding has a verdict
    session("b", { name: "login flow", profile: "qa-python", findings: [{ check: "raw_locator", seq: 1, severity: "medium", message: "m" }] }),
    // green, nothing to review
    session("c", { name: "smoke" }),
    // red, reviewed
    session("d", { task: "CART-12", findings: [d1], verdicts: verdict(d1, "ok") }),
    // red: one verdict, but on a finding that is gone, so its own finding is still open
    session("e", { name: "search", findings: [e1], verdicts: { "gone@9@x": { v: "ok" } } }),
  ].map((s) => (s.id === "b" ? Object.assign(s, { verdicts: verdict(s.findings[0], "fp") }) : s));
}
// what the person does in the filter's QuickPick, one step per call of the command
function person(steps) {
  const seen = [];
  return {
    seen,
    flow: async (qp, p) => {
      const step = steps.shift();
      if (step.type != null) p.type(step.type);
      seen.push(qp.items.map((i) => i.label));
      if (step.pick === undefined) return p.escape();
      const item = qp.items.find((i) => i.label.includes(step.pick));
      assert.ok(item, `no item "${step.pick}" in ${qp.items.map((i) => i.label).join(" | ")}`);
      p.accept(item);
    },
  };
}
const filterKey = (h) =>
  h.calls.commands
    .filter((c) => c[0] === "setContext" && c[1] === "sessionlens.sessionsFiltered")
    .map((c) => c[2])
    .pop();

test("filter by text: a part of the name, task or profile, in any case; the row on top says it and clears it", async () => {
  const steps = [{ type: "  CART ", pick: "containing" }];
  const who = person(steps);
  const h = await host(filterSessions(), { quickPickFlow: who.flow });
  await h.registered.commands["sessionlens.filterSessions"]();
  assert.deepEqual(who.seen[0], ['$(search) Name, task or profile containing "CART"', "Only Red", "With findings without a verdict"]);
  const [row, ...rest] = await h.tree.getChildren();
  assert.deepEqual([row.label, row.description, row.contextValue], ['Filter: "CART"', "2 of 5 — Clear", "sessionlensFilter"]);
  assert.equal(row.command.command, "sessionlens.clearSessionFilter");
  assert.deepEqual(
    (await treeSessions(h.tree)).map((s) => s.id),
    ["d", "a"],
    "the task, either case; the filter row is not a session",
  );
  assert.deepEqual(
    rest.map((g) => [g.label, g.description]),
    [["Today", "2"]],
    "a group counts what the filter shows",
  );
  assert.equal(filterKey(h), true, "the Clear filter button shows");

  steps.push({ type: "python", pick: "containing" });
  await h.registered.commands["sessionlens.filterSessions"]();
  assert.deepEqual(
    (await treeSessions(h.tree)).map((s) => s.id),
    ["b"],
    "the profile; the new text replaces the old",
  );

  await h.registered.commands["sessionlens.clearSessionFilter"]();
  assert.equal(
    (await h.tree.getChildren()).some((g) => g.contextValue === "sessionlensFilter"),
    false,
  );
  assert.equal((await treeSessions(h.tree)).length, 5);
  assert.equal(filterKey(h), false);
});

test("quick filters: Only Red, With findings without a verdict (openCount, not the verdict count), and both", async () => {
  const steps = [{ pick: "Only Red" }, { pick: "With findings" }, { pick: "Only Red" }];
  const who = person(steps);
  const h = await host(filterSessions(), { quickPickFlow: who.flow });
  const ids = async () => (await treeSessions(h.tree)).map((s) => s.id).sort();
  await h.registered.commands["sessionlens.filterSessions"]();
  assert.deepEqual(await ids(), ["a", "d", "e"]);
  assert.equal((await h.tree.getChildren())[0].label, "Filter: Only Red");
  await h.registered.commands["sessionlens.filterSessions"]();
  assert.deepEqual(await ids(), ["a", "e"], "both: red and still to review");
  assert.deepEqual(who.seen[1], ["$(check) Only Red", "With findings without a verdict", "$(clear-all) Clear filter"]);
  await h.registered.commands["sessionlens.filterSessions"]();
  assert.deepEqual(await ids(), ["a", "e"], "Only Red off again: b has a verdict on its finding, c has none to review");
  assert.equal((await h.tree.getChildren())[0].label, "Filter: With findings without a verdict");
});

test("filter: nothing matches; Escape changes nothing; the text can be dropped and the rest kept", async () => {
  const steps = [
    { type: "nothing like it", pick: "containing" },
    { type: "cart" },
    { pick: "Only Red" },
    { type: "", pick: "Without" },
    { pick: "Clear filter" },
  ];
  const who = person(steps);
  const h = await host(filterSessions(), { quickPickFlow: who.flow });
  await h.registered.commands["sessionlens.filterSessions"]();
  const rows = await h.tree.getChildren();
  assert.deepEqual(
    rows.map((r) => [r.label, r.description]),
    [
      ['Filter: "nothing like it"', "0 of 5 — Clear"],
      ["No session matches the filter", undefined],
    ],
  );
  await h.registered.commands["sessionlens.filterSessions"](); // typed, then Escape
  assert.equal((await h.tree.getChildren())[0].label, 'Filter: "nothing like it"');
  await h.registered.commands["sessionlens.filterSessions"]();
  assert.equal((await h.tree.getChildren())[0].label, 'Filter: "nothing like it" · Only Red');
  await h.registered.commands["sessionlens.filterSessions"]();
  assert.ok(who.seen[3].includes('$(close) Without "nothing like it"'), who.seen[3].join(" | "));
  assert.equal((await h.tree.getChildren())[0].label, "Filter: Only Red");
  await h.registered.commands["sessionlens.filterSessions"]();
  assert.equal((await treeSessions(h.tree)).length, 5);
  assert.equal(filterKey(h), false);
});

// ---------- My groups ----------

// the session as stored: its group, read the way another window would
const stored = (h, id) => JSON.parse(fs.readFileSync(path.join(h.dir, id + ".json"), "utf8"));
const myGroups = { "sessionlens.sessionsGroupBy": "custom" };

test("My groups: the person's groups by name in any case, then No group; only a group of their own has a menu", async () => {
  const h = await host(
    [
      session("a", { group: "checkout" }),
      session("b", { group: "  Spike   GPT-5 " }),
      session("c"),
      session("d", { group: "Checkout API" }),
      session("e", { group: "checkout" }),
      session("f", { group: "bad\nname" }),
    ],
    { config: myGroups },
  );
  assert.deepEqual(await groups(h.tree), [
    ["checkout", "2", ["e", "a"]],
    ["Checkout API", "1", ["d"]],
    ["Spike GPT-5", "1", ["b"]],
    ["No group", "2", ["f", "c"]],
  ]);
  const items = await h.tree.getChildren();
  assert.deepEqual(
    items.map((g) => [g.contextValue, g.groupName]),
    [
      ["sessionlensGroupCustom", "checkout"],
      ["sessionlensGroupCustom", "Checkout API"],
      ["sessionlensGroupCustom", "Spike GPT-5"],
      ["sessionlensGroup", ""],
    ],
  );
});

test("Move to group…: a new group, then one there is, then out of it; the tree switches to My groups once", async () => {
  let answer = null;
  const offered = [];
  const h = await host([session("a"), session("b", { group: "Checkout" }), session("c", { group: "Login" })], {
    quickPickAnswer: (items, o) => (offered.push({ labels: items.map((i) => i.label), o }), answer(items)),
    inputBoxAnswer: (o) => {
      assert.equal(o.validateInput("two\nlines"), "A group name is one line.");
      assert.match(o.validateInput("x".repeat(61)), /too long \(60 characters at most\)/);
      assert.equal(o.validateInput("Spike"), null);
      return "  Spike  ";
    },
  });
  const move = (id) => h.registered.commands["sessionlens.moveToGroup"]({ id });

  answer = (items) => items.find((i) => i.make);
  await move("a");
  assert.deepEqual(offered[0].labels, ["$(folder) Checkout", "$(folder) Login", "$(new-folder) New group…"]);
  assert.equal(stored(h, "a").group, "Spike");
  assert.deepEqual(h.calls.configUpdates, [["sessionlens.sessionsGroupBy", "custom", h.vscode.ConfigurationTarget.Global]]);
  assert.deepEqual(
    (await groups(h.tree)).map((g) => g[0]),
    ["Checkout", "Login", "Spike"],
  );

  answer = (items) => items.find((i) => i.label.endsWith("Checkout"));
  await move("a");
  assert.deepEqual(offered[1].labels, ["$(folder) Checkout", "$(folder) Login", "$(new-folder) New group…", '$(close) Out of "Spike"'], "not the one it is in");
  assert.equal(stored(h, "a").group, "Checkout");
  assert.deepEqual(await groups(h.tree), [
    ["Checkout", "2", ["b", "a"]],
    ["Login", "1", ["c"]],
  ]);

  answer = (items) => items.find((i) => i.label.startsWith("$(close)"));
  await move("a");
  assert.equal("group" in stored(h, "a"), false, "out of its group: the field is gone");
  assert.equal(h.calls.configUpdates.length, 1, "already My groups: the setting is left alone");
  assert.ok(
    h.wv.posted.some((m) => m.__slRefresh && m.scope === "session" && m.sessionId === "a"),
    "the panel is told",
  );

  answer = () => undefined; // Escape
  await move("b");
  assert.equal(stored(h, "b").group, "Checkout");
});

test("Rename group… moves every session of it, also into a group there is; Delete group asks and keeps the sessions", async () => {
  let rename = "Login",
    yes = false;
  const h = await host([session("a", { group: "Checkout" }), session("b", { group: "Checkout" }), session("c", { group: "Login" })], {
    config: myGroups,
    inputBoxAnswer: () => rename,
    warningAnswer: (msg, o, button) => (yes ? button : undefined),
  });
  const [checkout] = await h.tree.getChildren();
  rename = "CHECKOUT"; // only the case: allowed
  await h.registered.commands["sessionlens.renameGroup"](checkout);
  assert.deepEqual(
    (await groups(h.tree)).map((g) => g[0]),
    ["CHECKOUT", "Login"],
  );
  rename = "login"; // a group there is, in any case: they merge under its name
  await h.registered.commands["sessionlens.renameGroup"]((await h.tree.getChildren())[0]);
  assert.deepEqual(await groups(h.tree), [["Login", "3", ["c", "b", "a"]]]);

  const [login] = await h.tree.getChildren();
  await h.registered.commands["sessionlens.deleteGroup"](login);
  assert.match(h.calls.warning[0][0], /delete the group "Login"\?/);
  assert.equal(h.calls.warning[0][1].modal, true);
  assert.equal(stored(h, "a").group, "Login", "cancelled: nothing changes");
  yes = true;
  await h.registered.commands["sessionlens.deleteGroup"](login);
  assert.deepEqual(await groups(h.tree), [["No group", "3 · make a group: + New group above", ["c", "b", "a"]]], "the last group is gone: the hint");
  assert.deepEqual(
    ["a", "b", "c"].map((id) => stored(h, id).name),
    ["a", "b", "c"],
    "the sessions are kept",
  );
});

test("drag and drop: onto a group, onto a session of a group, onto No group; nothing outside My groups", async () => {
  // d stays in no group, so No group is there to drop onto
  const sessions = [session("a"), session("b", { group: "Checkout" }), session("c", { group: "Login" }), session("d")];
  const h = await host(sessions, { config: myGroups });
  const dnd = h.registered.treeViews.sessionlensSessionsTree.dragAndDropController;
  const drag = async (ids, target) => {
    const items = (await treeSessions(h.tree)).filter((s) => ids.includes(s.id));
    const dt = new h.vscode.DataTransfer();
    dnd.handleDrag(items, dt);
    await dnd.handleDrop(target, dt);
  };
  const byLabel = async (label) => (await h.tree.getChildren()).find((g) => g.label === label);
  await drag(["a"], await byLabel("Checkout"));
  assert.equal(stored(h, "a").group, "Checkout");
  const login = (await treeSessions(h.tree)).find((s) => s.id === "c");
  await drag(["a", "b"], login);
  assert.deepEqual([stored(h, "a").group, stored(h, "b").group], ["Login", "Login"], "onto a session: its group, both at once");
  await drag(["a"], await byLabel("No group"));
  assert.equal("group" in stored(h, "a"), false);
  // a group is not dragged
  const dt = new h.vscode.DataTransfer();
  dnd.handleDrag([await byLabel("Login")], dt);
  assert.equal(dt.get(dnd.dragMimeTypes[0]), undefined);

  const byDate = await host(sessions);
  const dnd2 = byDate.registered.treeViews.sessionlensSessionsTree.dragAndDropController;
  const items = await treeSessions(byDate.tree);
  const dt2 = new byDate.vscode.DataTransfer();
  dnd2.handleDrag([items.find((s) => s.id === "a")], dt2);
  await dnd2.handleDrop(
    items.find((s) => s.id === "b"),
    dt2,
  );
  assert.equal("group" in stored(byDate, "a"), false, "by date: a drop moves nothing");
});

test("the filter's text matches a group's name too", async () => {
  const h = await host([session("a", { group: "Checkout" }), session("b")], {
    quickPickFlow: (qp, p) => {
      p.type("checkout");
      p.accept(qp.items[0]);
    },
  });
  await h.registered.commands["sessionlens.filterSessions"]();
  assert.deepEqual(
    (await treeSessions(h.tree)).map((s) => s.id),
    ["a"],
  );
});

test("+ New group in the title: a name, then the sessions with ticks; the tree switches to My groups", async () => {
  let name = "  Checkout  ",
    pick = (items) => items.filter((i) => i.id === "a" || i.id === "c");
  const offered = [];
  const h = await host([session("a"), session("b", { group: "Login" }), session("c")], {
    inputBoxAnswer: (o) => {
      assert.equal(o.validateInput("two\nlines"), "A group name is one line.");
      return name;
    },
    quickPickAnswer: (items, o) => (offered.push({ items, o }), pick(items)),
  });
  await h.registered.commands["sessionlens.newGroup"]();
  const [{ items, o }] = offered;
  assert.equal(o.canPickMany, true);
  assert.equal(o.title, 'SessionLens: sessions for "Checkout"');
  assert.deepEqual(
    items.map((i) => [i.id, i.picked, i.description.startsWith('in "Login" · ')]),
    [
      ["c", false, false],
      ["b", false, true],
      ["a", false, false],
    ],
    "every session, with the group it is in",
  );
  assert.deepEqual([stored(h, "a").group, stored(h, "b").group, stored(h, "c").group], ["Checkout", "Login", "Checkout"]);
  assert.deepEqual(h.calls.configUpdates, [["sessionlens.sessionsGroupBy", "custom", h.vscode.ConfigurationTarget.Global]]);
  assert.deepEqual(await groups(h.tree), [
    ["Checkout", "2", ["c", "a"]],
    ["Login", "1", ["b"]],
  ]);

  // the name of a group there is, in any case: that group; its sessions come ticked, a tick adds
  name = "checkout ";
  pick = (items) => items.filter((i) => i.picked || i.id === "b");
  await h.registered.commands["sessionlens.newGroup"]();
  assert.equal(offered[1].o.title, 'SessionLens: sessions for "Checkout"');
  assert.deepEqual(
    offered[1].items.filter((i) => i.picked).map((i) => i.id),
    ["c", "a"],
  );
  assert.deepEqual(await groups(h.tree), [["Checkout", "3", ["c", "b", "a"]]], "one group, not checkout and Checkout");
});

test("+ New group: Escape at the name, or no session ticked, makes nothing; with no sessions it says so", async () => {
  let name;
  const h = await host([session("a")], { inputBoxAnswer: () => name, quickPickAnswer: () => [] });
  await h.registered.commands["sessionlens.newGroup"](); // Escape
  name = "Spike";
  await h.registered.commands["sessionlens.newGroup"](); // nothing ticked
  assert.equal("group" in stored(h, "a"), false);
  assert.deepEqual(h.calls.configUpdates, []);
  const empty = await host([]);
  await empty.registered.commands["sessionlens.newGroup"]();
  assert.match(empty.calls.info[0], /no sessions yet/);
  assert.equal(empty.calls.inputBox.length, 0);
});

test("My groups with no group yet: No group says how to make one, in its line and on hover; then only on hover", async () => {
  const h = await host([session("a"), session("b")], {
    config: myGroups,
    inputBoxAnswer: () => "Checkout",
    quickPickAnswer: (items) => items.filter((i) => i.id === "a"),
  });
  let [none] = await h.tree.getChildren();
  assert.deepEqual([none.label, none.description], ["No group", "2 · make a group: + New group above"]);
  assert.match(none.tooltip, /\+ New group.*Move to group…/);
  await h.registered.commands["sessionlens.newGroup"]();
  none = (await h.tree.getChildren()).find((g) => g.label === "No group");
  assert.equal(none.description, "1", "a group is there: the count alone");
  assert.match(none.tooltip, /\+ New group/);
  const byDate = await host([session("a")]);
  assert.equal((await byDate.tree.getChildren())[0].tooltip, undefined, "not in the other groupings");
});

// ---------- several sessions selected (0.1.124) ----------

const item = async (h, id) => (await treeSessions(h.tree)).find((s) => s.id === id);

test("several selected: Move to group… moves them all; the clicked one alone when it is not in the selection", async () => {
  let offered = null;
  const h = await host([session("a", { group: "Login" }), session("b"), session("c", { group: "Login" }), session("d", { group: "Spike" })], {
    quickPickAnswer: (items, o) => ((offered = { labels: items.map((i) => i.label), o }), items.find((i) => i.label.endsWith("Spike"))),
  });
  assert.equal(h.registered.treeViews.sessionlensSessionsTree.canSelectMany, true);
  const [a, b, c] = [await item(h, "a"), await item(h, "b"), await item(h, "c")];
  await h.registered.commands["sessionlens.moveToGroup"](a, [a, b]);
  assert.equal(offered.o.title, "SessionLens: move 2 sessions to a group");
  assert.deepEqual(offered.labels, ["$(folder) Login", "$(folder) Spike", "$(new-folder) New group…", "$(close) Out of their groups"], "in different groups");
  assert.deepEqual([stored(h, "a").group, stored(h, "b").group], ["Spike", "Spike"]);

  await h.registered.commands["sessionlens.moveToGroup"](c, [a, b]); // right-clicked outside the selection
  assert.equal(offered.o.title, "SessionLens: move to group");
  assert.deepEqual([stored(h, "c").group, stored(h, "a").group], ["Spike", "Spike"]);
  const [x, y] = [await item(h, "a"), await item(h, "b")];
  await h.registered.commands["sessionlens.moveToGroup"](x, [x, y, (await h.tree.getChildren())[0]]);
  assert.ok(offered.labels.includes('$(close) Out of "Spike"'), "all in one group; a group in the selection is left out");
});

test("several selected: one Delete question names them, and deletes them all; Cancel deletes none", async () => {
  let yes = false;
  const ids = ["a", "b", "c", "d", "e", "f", "g"];
  const h = await host(
    ids.map((id) => session(id)),
    { warningAnswer: (msg, o, button) => (yes ? button : undefined) },
  );
  const all = await treeSessions(h.tree);
  const [first] = all;
  await h.registered.commands["sessionlens.deleteSession"](first, all);
  assert.equal(h.calls.warning.length, 1);
  assert.equal(h.calls.warning[0][0], "SessionLens: delete 7 sessions?");
  assert.match(h.calls.warning[0][1].detail, /^Their findings and verdicts are deleted with them\. This cannot be undone\.\n\n(\w\n){5}and 2 more$/);
  assert.equal((await treeSessions(h.tree)).length, 7, "cancelled");
  yes = true;
  const gone = all.slice(0, 3).map((s) => s.id);
  await h.registered.commands["sessionlens.deleteSession"](first, all.slice(0, 3));
  assert.deepEqual(
    (await treeSessions(h.tree)).map((s) => s.id).sort(),
    ids.filter((id) => !gone.includes(id)),
  );
  assert.equal(h.calls.warning[1][0], "SessionLens: delete 3 sessions?");
  const one = (await treeSessions(h.tree))[0];
  await h.registered.commands["sessionlens.deleteSession"](one, [one]);
  assert.match(h.calls.warning[2][0], /^SessionLens: delete the session ".+"\?$/, "one: as before");
});

test("several selected: Open in the menu opens each; a click opens the one clicked", async () => {
  const h = await host([session("a"), session("b"), session("c")]);
  const opened = [];
  h.vscode.window.createWebviewPanel = (type, title) => {
    opened.push(title);
    return {
      webview: fakeWebviewView().webview,
      onDidChangeViewState() {},
      onDidDispose() {},
      reveal() {},
    };
  };
  const [a, b] = [await item(h, "a"), await item(h, "b")];
  await h.registered.commands["sessionlens.openSessionFromTree"](a, [a, b]);
  assert.deepEqual(opened.sort(), ["a", "b"]);
  await h.registered.commands["sessionlens.openSessionFromTree"]("c"); // the item's own click command
  assert.deepEqual(opened.sort(), ["a", "b", "c"]);
});

// ---------- details (0.1.124) ----------

test("a session's tooltip: its other name, its agent and its group; Collapse All in the title", async () => {
  const h = await host([
    session("a", { task: "TASK-1", agent: "codex", group: "Checkout" }),
    session("b", { agent: "" }),
    session("c", { task: "TASK-3", agent: "" }),
  ]);
  const by = Object.fromEntries((await treeSessions(h.tree)).map((s) => [s.id, s.tooltip]));
  assert.equal(by.a, "a\nAgent: Codex\nGroup: Checkout");
  assert.equal(by.b, undefined, "nothing to add");
  assert.equal(by.c, "c", "the other name alone, as before");
  assert.equal(h.registered.treeViews.sessionlensSessionsTree.showCollapseAll, true);
});

test("Open session…: a session's group is in its line, so typing the group's name finds it", async () => {
  let offered = null;
  const h = await host([session("a", { group: "Checkout" }), session("b")], { quickPickAnswer: (items, o) => ((offered = { items, o }), undefined) });
  await h.registered.commands["sessionlens.openSession"]();
  const by = Object.fromEntries(offered.items.map((i) => [i.id, i.description]));
  assert.match(by.a, / · \$\(folder\) Checkout$/);
  assert.doesNotMatch(by.b, /folder/);
  assert.equal(offered.o.matchOnDescription, true);
});
