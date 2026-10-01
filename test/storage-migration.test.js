"use strict";
/* Phase 4 at the host: the migration of globalState["sessions"] into files, and the session:* messages. The real
   extension.js under the fake "vscode" module, sessions in a temporary globalStorageUri. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { bootHost } = require("./host-panel");
const { fakeWebviewView } = require("./fake-vscode");
const { makeFixture } = require("../perf/fixtures");

const FX = makeFixture({ n: 5, bytes: 20 * 1024, seed: 7 });
const oldState = () => JSON.parse(JSON.stringify(Object.assign({ sessions: FX.sessions }, FX.storage, { hostBaseUrls: { local: "http://h:1" } })));

async function started(opts) {
  const host = bootHost(opts);
  const v = fakeWebviewView();
  host.registered.views.sessionlensView.resolveWebviewView(v.view);
  await v.send("secret:status", {}); // waits for host.ready (all migrations)
  return Object.assign(host, { v, dir: path.join(host.context.globalStorageUri.fsPath, "sessions") });
}
const refused = (r) => assert.ok(r && typeof r.error === "string" && r.error.startsWith("SessionLens:"), JSON.stringify(r));

test("migration: every session moves to a file unchanged; the old key goes; the other keys stay", async () => {
  const before = oldState();
  const h = await started({ globalState: oldState() });
  const gs = h.context.globalState.data;
  assert.equal(gs.sessions, undefined);
  assert.equal(gs.storageVersion, 2);
  for (const k of ["rulesApplied", "ruleOverrides", "hostBaseUrls"]) assert.deepEqual(gs[k], before[k], k);
  // phase 6: lint and rulesTarget moved to the VS Code settings; the rest of settings is unchanged
  const { lint, rulesTarget, ...rest } = before.settings;
  assert.deepEqual(gs.settings, rest);
  assert.equal(h.config.global["sessionlens.lint"], lint);
  assert.equal(h.config.global["sessionlens.rulesTarget"], rulesTarget);
  const ids = Object.keys(before.sessions);
  const list = await h.v.send("session:list", {});
  assert.deepEqual(list.items.map((m) => m.id).sort(), [...ids].sort());
  for (const id of ids) {
    const r = await h.v.send("session:get", { id });
    assert.deepEqual(r.session, before.sessions[id], id);
    assert.equal(r.rev, 1);
    assert.equal(r.meta.order, ids.indexOf(id) + 1, "import order kept");
  }
  assert.ok(h.calls.output.some((l) => /migration: 5 session\(s\)/.test(l)));
});

test("migration: a second start does nothing", async () => {
  const h = await started({ globalState: oldState() });
  const snap = fs.readdirSync(h.dir).map((f) => [f, fs.statSync(path.join(h.dir, f)).mtimeMs]);
  const h2 = await started({ globalState: h.context.globalState.data, storageDir: h.context.globalStorageUri.fsPath });
  assert.deepEqual(
    fs.readdirSync(h2.dir).map((f) => [f, fs.statSync(path.join(h2.dir, f)).mtimeMs]),
    snap,
  );
  assert.ok(!h2.calls.output.some((l) => /migration:/.test(l)));
});

test("migration: a failure keeps the old key; the next start finishes and keeps what was edited meanwhile", async () => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "sl-mig-"));
  const ids = Object.keys(FX.sessions);
  // the third summary cannot be written: a folder is in its way
  fs.mkdirSync(path.join(storageDir, "sessions", ids[2] + ".meta.json"), { recursive: true });
  const gs = oldState();
  const h = await started({ globalState: gs, storageDir });
  assert.ok(h.context.globalState.data.sessions, "old data kept");
  assert.equal(h.context.globalState.data.storageVersion, undefined);
  assert.equal(h.calls.error.length, 1);
  assert.ok(h.calls.output.some((l) => /migration of sessions to files stopped/.test(l)));
  // meanwhile the first session is edited (rev 2)
  const first = await h.v.send("session:get", { id: ids[0] });
  const put = await h.v.send("session:put", { session: Object.assign(first.session, { name: "edited" }), baseRev: 1, analyzedGen: "" });
  assert.equal(put.rev, 2);
  // next start, obstacle gone
  fs.rmSync(path.join(storageDir, "sessions", ids[2] + ".meta.json"), { recursive: true });
  const h2 = await started({ globalState: h.context.globalState.data, storageDir });
  assert.equal(h2.context.globalState.data.sessions, undefined);
  assert.equal(h2.context.globalState.data.storageVersion, 2);
  assert.equal((await h2.v.send("session:get", { id: ids[0] })).session.name, "edited");
  assert.deepEqual((await h2.v.send("session:get", { id: ids[4] })).session, gs.sessions[ids[4]]);
  assert.ok(h2.calls.output.some((l) => /changed after an earlier, unfinished migration/.test(l)));
});

test("a session tab VS Code restores during the migration waits for it and opens", async () => {
  const host = bootHost({ globalState: oldState() });
  const id = Object.keys(FX.sessions)[1];
  const v = fakeWebviewView();
  let disposed = false;
  const panel = {
    webview: v.webview,
    onDidChangeViewState() {},
    onDidDispose() {},
    dispose() {
      disposed = true;
    },
  };
  await host.registered.serializers.sessionlensSession.deserializeWebviewPanel(panel, { sessionId: id }); // not awaiting ready first
  assert.equal(disposed, false);
  assert.ok(/data-open-session/.test(v.webview.html));
  const gone = {
    webview: fakeWebviewView().webview,
    onDidChangeViewState() {},
    onDidDispose() {},
    dispose() {
      gone.d = true;
    },
  };
  await host.registered.serializers.sessionlensSession.deserializeWebviewPanel(gone, { sessionId: "deleted-meanwhile" });
  assert.equal(gone.d, true);
});

test("session:get/put: an id is never a path; summary fields from the page are ignored", async () => {
  const h = await started({ globalState: {} });
  const outside = path.join(h.context.globalStorageUri.fsPath, "secret.json");
  fs.writeFileSync(outside, JSON.stringify({ id: "x", secret: true }));
  refused(await h.v.send("session:get", { id: "../secret" }));
  const s = {
    id: "../../evil",
    name: "n",
    created: "2026-01-01",
    events: [],
    findings: [{ check: "weak_assert", severity: "high", seq: 1, message: "m" }],
    verdicts: {},
    verdict: "green",
    findingsCount: 0,
    checkStats: { fake: { total: 99, ok: 99, fp: 0 } },
    sourceStats: { fake: { lint: { total: 99, ok: 99, fp: 0 } } },
    confirmed: [{ check: "fake" }],
  };
  const r = await h.v.send("session:put", { session: s, analyzedGen: "" });
  assert.equal(r.ok, true);
  assert.equal(r.meta.verdict, "red");
  assert.equal(r.meta.findingsCount, 1);
  assert.deepEqual(Object.keys(r.meta.checkStats), ["weak_assert"]);
  assert.deepEqual(Object.keys(r.meta.sourceStats), ["weak_assert"]);
  assert.deepEqual(r.meta.confirmed, []);
  for (const f of fs.readdirSync(h.dir)) assert.match(f, /^h-[0-9a-f]{32}(\.meta)?\.json$/);
  assert.deepEqual(fs.readdirSync(h.context.globalStorageUri.fsPath).sort(), ["secret.json", "sessions"]);
  refused(await h.v.send("session:put", { session: Object.assign({}, s, { id: "a\u0000b" }) }));
  refused(await h.v.send("session:put", { session: Object.assign({}, s, { findings: "x" }) }));
  refused(await h.v.send("session:put", { session: s, analyzedGen: "../x" }));
  refused(await h.v.send("session:put", { session: s, baseRev: -1 }));
  refused(await h.v.send("session:open", { id: "../secret" }));
});

test("session:put: a background write gives way to an open tab; others are told what changed", async () => {
  const h = await started({ globalState: oldState() });
  const id = Object.keys(FX.sessions)[0],
    other = Object.keys(FX.sessions)[1];
  const tab = fakeWebviewView();
  const panel = { webview: tab.webview, onDidChangeViewState() {}, onDidDispose() {}, dispose() {} };
  await h.registered.serializers.sessionlensSession.deserializeWebviewPanel(panel, { sessionId: id });
  const g = await h.v.send("session:get", { id });
  assert.deepEqual(await h.v.send("session:put", { session: g.session, baseRev: g.rev, analyzedGen: "", background: true }), { skipped: true });
  const g2 = await h.v.send("session:get", { id: other });
  const r = await h.v.send("session:put", { session: g2.session, baseRev: g2.rev, analyzedGen: "", background: true });
  assert.equal(r.ok, true);
  const refresh = tab.posted.filter((m) => m.__slRefresh);
  assert.deepEqual(
    refresh.map((m) => [m.scope, m.sessionId]),
    [["session", other]],
  );
  assert.equal(refresh[0].meta.rev, 2);
  assert.ok(!h.v.posted.some((m) => m.__slRefresh && m.scope === "session"), "not the sender");
  await h.v.send("session:delete", { id: other });
  assert.deepEqual(tab.posted.filter((m) => m.__slRefresh).pop(), { __slRefresh: true, scope: "session", sessionId: other, meta: null });
});
