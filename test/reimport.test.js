"use strict";
/* "Import again" (0.1.114): a session imported before 0.1.113 has no prev_content, so a test deleted in the first Edit
   of a file is not reported; a Codex session imported before 0.1.121 may lack its file changes (Codex 0.155+). The
   session tab says so and parses the transcript again into the same session: from the text kept at import, or from
   the file picked again. The real panel and host (test/host-panel.js). */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { bootHost, openPage } = require("./host-panel");
const { createStore } = require("../store.js");
const { load } = require("./helpers");

const { Lens } = load();
const cfg = Lens.profile("qa-ts");

const PW = (...tests) =>
  "import { test, expect } from '@playwright/test';\n" +
  tests.map(([name, text]) => `test('${name}', async ({ page }) => {\n  await expect(page.getByText('${text}')).toBeVisible();\n});\n`).join("");
const TOTAL = ["total", "Total"],
  DISCOUNT = ["discount", "Discount"];

// red run → the first Edit of an existing test file cuts the discount test out → "all tests pass"
function transcript(task = "Make the suite green") {
  const rec = (o) => JSON.stringify(o);
  const cut = PW(DISCOUNT).split("\n").slice(1).join("\n");
  return [
    rec({ type: "user", message: { role: "user", content: task } }),
    rec({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "r", name: "Bash", input: { command: "npx playwright test" } }] },
    }),
    rec({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "r", content: "1 passed, 1 failed" }] } }),
    rec({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "e", name: "Edit", input: { file_path: "/w/e2e/cart.spec.ts", old_string: cut, new_string: "" } }],
      },
    }),
    rec({
      type: "user",
      cwd: "/w",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "e", content: "ok" }] },
      toolUseResult: { filePath: "/w/e2e/cart.spec.ts", originalFile: PW(TOTAL, DISCOUNT), oldString: cut, newString: "" },
    }),
    rec({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "All tests pass now." }] } }),
  ].join("\n");
}
// a transcript of another session: none of its steps is in the one above
function other() {
  const rec = (o) => JSON.stringify(o);
  return [
    rec({ type: "user", message: { role: "user", content: "Write the login tests" } }),
    rec({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "w", name: "Write", input: { file_path: "/w/e2e/login.spec.ts", content: PW(["login", "Welcome"]) } }],
      },
    }),
    rec({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "w", content: "written" }] } }),
    rec({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "The login test is written." }] } }),
  ].join("\n");
}
// the events as 0.1.112 stored them: no prev_content
const oldEvents = (text) => Lens.importAny(text, cfg).map(({ prev_content, ...e }) => e);

async function until(fn, ms = 5000) {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
const click = (p, sel) => p.document.querySelector(sel).dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));

/* One stored session with a verdict on its pass_claim_without_run finding; opts: { events, sourceText } */
async function tab(opts = {}) {
  const events = opts.events || oldEvents(transcript());
  const findings = Lens.runChecks(events, cfg).map((f) => Object.assign(f, { source: "formal" }));
  const claim = findings.find((f) => f.check === "pass_claim_without_run");
  const s = {
    id: "reimp1",
    name: "old session",
    nameSet: true,
    task: "",
    profile: "qa-ts",
    created: "2026-09-01T00:00:00.000Z",
    events,
    findings,
    verdicts: { [Lens.fkey(claim)]: { v: "ok", note: "seen", at: "2026-09-01T00:00:00.000Z" } },
    spec: "R1 the discount is applied",
    source_text: opts.sourceText || "",
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sl-reimport-"));
  const st = createStore({ dir: path.join(dir, "sessions") });
  await st.open();
  await st.put(s, { analyzedGen: "" });
  const host = bootHost({
    storageDir: dir,
    globalState: { storageVersion: 2, settings: { profile: "qa-ts", lint: false, rulesTarget: "claude", modelPool: [], defaultModelId: null } },
  });
  const p = await openPage(host, { sessionId: s.id });
  await p.ready();
  return { dir, p, s, claimKey: Lens.fkey(claim) };
}
// what is on disk, read the way another window would
async function disk(dir) {
  const st = createStore({ dir: path.join(dir, "sessions") });
  await st.open();
  return { list: st.list().map((m) => m.id), session: (await st.get("reimp1")).session };
}
const puts = (p) => p.sent.filter((m) => m.type === "session:put");

test("needsReimport: an old session that touched a test file or a runner config, nothing else", () => {
  const text = transcript();
  assert.equal(Lens.needsReimport({ profile: "qa-ts", events: oldEvents(text) }), true, "imported before 0.1.113");
  assert.equal(Lens.needsReimport({ profile: "qa-ts", events: Lens.importAny(text, cfg) }), false, "has prev_content");
  assert.equal(Lens.needsReimport({ profile: "qa-ts", events: oldEvents(text), importGen: Lens.IMPORT_GEN }), false, "imported with the current import");
  const notTests = [{ seq: 0, kind: "write", file: "src/cart.ts", new_content: "export const x = 1;\n" }];
  assert.equal(Lens.needsReimport({ profile: "qa-ts", events: notTests }), false, "product code only");
  const config = [{ seq: 0, kind: "edit", file: "playwright.config.ts", new_content: "retries: 2" }];
  assert.equal(Lens.needsReimport({ profile: "qa-ts", events: config }), true, "a runner config");
});

test("needsReimport: a Codex session imported before 0.1.121 with file changes; not a Claude session of 0.1.113+", () => {
  const rec = (type, payload) => JSON.stringify({ timestamp: "", type, payload });
  const meta = rec("session_meta", { cwd: "/w" });
  const change = rec("event_msg", {
    type: "item_completed",
    item: { type: "FileChange", id: "x", status: "completed", changes: { "/w/e2e/cart.spec.ts": { type: "add", content: PW(TOTAL) } } },
  });
  const say = rec("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] });
  const codex = [meta, change, say].join("\n");
  const s = (o) => Object.assign({ profile: "qa-ts", importGen: 2 }, o);
  assert.equal(Lens.needsReimport(s({ events: Lens.importAny(codex, cfg), source_text: codex })), true, "its file changes were skipped");
  assert.equal(Lens.needsReimport(s({ events: Lens.importAny(codex, cfg), source_text: codex, importGen: Lens.IMPORT_GEN })), false);
  const exec = [
    { seq: 0, kind: "user", text: "Write tests" },
    { seq: 1, kind: "tool", tool: "exec" },
  ];
  assert.equal(Lens.needsReimport(s({ events: exec })), true, "no kept text: an exec call that ran no command");
  const chat = [meta, say].join("\n");
  assert.equal(Lens.needsReimport(s({ events: Lens.importAny(chat, cfg), source_text: chat })), false, "a Codex session without file changes");
  const newFile = [{ seq: 0, kind: "write", file: "e2e/cart.spec.ts", new_content: PW(TOTAL) }];
  assert.equal(Lens.needsReimport(s({ events: newFile })), false, "a Claude session of 0.1.113+ that wrote a new test file");
});

test("needsReimport: a session of 0.1.121 that the 0.1.122 import reads differently, and no other", () => {
  const s = (events, o) => Object.assign({ profile: "qa-ts", importGen: 3, events }, o);
  const run = (cmd) => [{ seq: 0, kind: "run_tests", cmd }];
  assert.equal(Lens.needsReimport(s(run("npx playwright test --list"))), true, "a list taken for a test run");
  assert.equal(Lens.needsReimport(s(run("npx playwright test"))), false, "a real run");
  const moved = '{"type":"event_msg","payload":{"type":"patch_apply_end","changes":{"/w/a.ts":{"type":"update","unified_diff":"","move_path":"/w/b.ts"}}}}';
  assert.equal(Lens.needsReimport(s([], { source_text: moved })), true, "a Codex patch that moved a file");
  assert.equal(Lens.needsReimport(s([], { source_text: moved.replace('"/w/b.ts"', "null") })), false, "move_path null: no move");
  const weak = (reason) => [{ seq: 1, kind: "write", file: "e2e/a.spec.ts", assert_delta: { old: 1, new: 1, weakened: [{ test: "t", reason }], removed: [] } }];
  const forty = 'await expect(page.getByRole("alert")).to';
  assert.equal(forty.length, 40);
  assert.equal(Lens.needsReimport(s(weak(`${forty} → ${forty}`))), true, "both lines cut at 40 characters");
  assert.equal(Lens.needsReimport(s(weak(`comparison → truthiness: ${forty}`))), true, "a truthiness line cut at 40");
  assert.equal(Lens.needsReimport(s(weak("expect(total).toBe(3); → expect(total).toBeDefined();"))), false, "a short pair is the same now");
  assert.equal(Lens.needsReimport(s(run("npx playwright test --list"), { importGen: Lens.IMPORT_GEN })), false, "imported with 0.1.122");
});

test("the demo session of 0.1.121 is offered Import again, and its kept text gives the new message", () => {
  const D = require(path.join(__dirname, "..", "media", "demo-session.js"));
  const dcfg = Lens.profile(D.PROFILE);
  const events = Lens.importAny(D.TRANSCRIPT, dcfg);
  const old = events.map((e) =>
    e.assert_delta
      ? Object.assign({}, e, {
          assert_delta: Object.assign({}, e.assert_delta, {
            weakened: e.assert_delta.weakened.map((w) => Object.assign({}, w, { reason: "a".repeat(40) + " → " + "a".repeat(40) })),
          }),
        })
      : e,
  );
  assert.equal(Lens.needsReimport({ profile: D.PROFILE, importGen: 3, events: old, source_text: D.TRANSCRIPT }), true);
  assert.equal(Lens.needsReimport({ profile: D.PROFILE, importGen: Lens.IMPORT_GEN, events, source_text: D.TRANSCRIPT }), false);
});

test("transcriptMatch: 1 for the same transcript, also with events added; low for another one", () => {
  const a = Lens.importAny(transcript(), cfg);
  assert.equal(Lens.transcriptMatch(a, a), 1);
  assert.equal(Lens.transcriptMatch(a.slice(1), a), 1, "the new import has one more event");
  assert.equal(Lens.transcriptMatch(a, Lens.importAny(other(), cfg)), 0);
});

test("Import again with the text kept at import: the same session gets test_deleted and keeps its verdicts", async () => {
  const text = transcript();
  const { dir, p, claimKey } = await tab({ sourceText: text });
  assert.equal(p.document.querySelector("#reimport").hidden, false, "the hint is shown");
  const n0 = puts(p).length;
  click(p, "#reimport-go");
  await until(() => puts(p).length > n0);
  await p.idle();
  const { list, session: s } = await disk(dir);
  assert.equal(s.importGen, Lens.IMPORT_GEN);
  assert.ok(
    s.findings.some((f) => f.check === "test_deleted"),
    JSON.stringify(s.findings.map((f) => f.check)),
  );
  assert.ok(
    s.findings.some((f) => Lens.fkey(f) === claimKey),
    "the verdict still matches its finding",
  );
  assert.equal(s.verdicts[claimKey].note, "seen");
  assert.equal(s.name, "old session");
  assert.equal(s.spec, "R1 the discount is applied");
  assert.deepEqual(list, ["reimp1"], "no second session");
  assert.equal(p.document.querySelector("#reimport").hidden, true, "the hint is gone");
  assert.deepEqual(p.errors, []);
  p.close();
});

test("Import again without the text: the file is picked again; a transcript of another session is asked about", async () => {
  const { dir, p } = await tab();
  const asked = [];
  let sources = null;
  p.window.chooseDialog = async (msg, opts) => (asked.push(msg), (sources = opts.map((o) => String(o.value)).join()), "claude");
  p.window.confirmDialog = async (msg) => (asked.push(msg), false);
  let file = other();
  p.window.__slPickTranscript = async (o) => (asked.push("pick " + o.source), { name: "x.jsonl", text: file });
  const n0 = puts(p).length; // what the tab wrote when it opened
  click(p, "#reimport-go");
  await until(() => asked.length === 3);
  await p.idle();
  assert.match(asked[0], /Pick the transcript of this session/);
  assert.equal(sources, "claude,codex,cursor,other");
  assert.equal(asked[1], "pick claude");
  assert.match(asked[2], /does not look like this session/);
  assert.equal(puts(p).length, n0, "cancelled: nothing written");

  file = transcript();
  asked.length = 0;
  click(p, "#reimport-go");
  await until(() => puts(p).length > n0);
  await p.idle();
  assert.equal(asked.length, 2, "the right file: no question after the pick");
  const { session: s } = await disk(dir);
  assert.ok(s.findings.some((f) => f.check === "test_deleted"));
  assert.equal(s.source_text, file, "a small transcript is kept, as at import");
  assert.deepEqual(p.errors, []);
  p.close();
});

test("Import again: a pick the host refuses is said in a dialog, nothing is written", async () => {
  const { p } = await tab();
  const alerts = [];
  p.window.chooseDialog = async () => "newer-source"; // a source an older host does not know
  p.window.alertDialog = async (m) => alerts.push(m);
  const n0 = puts(p).length;
  click(p, "#reimport-go");
  await until(() => alerts.length);
  await p.idle();
  assert.match(alerts[0], /SessionLens: unknown source/);
  assert.equal(puts(p).length, n0);
  assert.deepEqual(p.errors, []);
  p.close();
});

test("Import again that would detach verdicts asks first (the steps are numbered differently now)", async () => {
  const text = transcript();
  // one event fewer at the start, as when an older import skipped an event the new one keeps (a Codex deletion)
  const events = oldEvents(text)
    .slice(1)
    .map((e, i) => Object.assign(e, { seq: i }));
  const { dir, p, claimKey } = await tab({ events, sourceText: text });
  const asked = [];
  let answer = false;
  p.window.confirmDialog = async (msg) => (asked.push(msg), answer);
  const n0 = puts(p).length;
  click(p, "#reimport-go");
  await until(() => asked.length);
  await p.idle();
  assert.match(asked[0], /^1 verdict would no longer match a finding/);
  assert.equal(puts(p).length, n0, "cancelled: nothing written");
  answer = true;
  click(p, "#reimport-go");
  await until(() => puts(p).length > n0);
  await p.idle();
  const { session: s } = await disk(dir);
  assert.equal(s.importGen, Lens.IMPORT_GEN);
  assert.ok(s.verdicts[claimKey], "the verdict itself is kept");
  assert.equal(
    s.findings.some((f) => Lens.fkey(f) === claimKey),
    false,
  );
  p.close();
});

test("a new import and the demo record the import version: no hint", async () => {
  const s = { profile: "qa-ts", events: oldEvents(transcript()) };
  assert.equal(Lens.needsReimport(Object.assign({}, s, { importGen: Lens.IMPORT_GEN })), false);
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "webview", "sessions.js"), "utf8");
  assert.equal((src.match(/importGen: Lens\.IMPORT_GEN/g) || []).length, 2, "importText and openDemo");
});
