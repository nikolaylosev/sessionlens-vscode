"use strict";
/* A claude.ai export holds many conversations; each one picked at import is a session of its own, and every such
   session keeps the whole file as source_text. Parsing it again ("Back to regex parsing", "Import again") must take
   the session's own conversation. Until 0.1.115 "Back to regex parsing" took the first one: a session made from the
   second conversation silently became the first. Lens.pickConversation picks by content (Lens.transcriptMatch). */
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

const conv = (name, ask, answer) => ({
  name,
  uuid: name,
  chat_messages: [
    { sender: "human", text: ask },
    { sender: "assistant", text: answer },
  ],
});
const EXPORT = JSON.stringify([
  conv("cart", "Write the cart tests", "Here are the cart tests."),
  conv("login", "Write the login tests", "Here are the login tests."),
  conv("cart", "Write the checkout tests", "Here are the checkout tests."), // the same title as the first
]);
const texts = (events) => events.map((e) => e.text);

test("pickConversation: the conversation whose steps the session has, whatever its place or title in the file", () => {
  const all = Lens.importAny(EXPORT, cfg);
  assert.equal(all.length, 3);
  for (const i of [0, 1, 2]) assert.deepEqual(texts(Lens.pickConversation(all[i].events, all)), texts(all[i].events), "conversation " + i);
  // segmentation adds code to the steps (new_content, code_versions, seg_tests) and leaves what is compared alone
  const segmented = all[1].events.map((e) => Object.assign({}, e, { new_content: "test('x', () => {});", seg_tests: ["x"] }));
  assert.deepEqual(texts(Lens.pickConversation(segmented, all)), texts(all[1].events));
});

test("pickConversation: a file of one conversation gives its steps; nothing in it gives null", () => {
  const one = Lens.importAny("Write the cart tests\n\nHere are the cart tests.", cfg);
  assert.deepEqual(Lens.pickConversation([], one), one);
  assert.equal(Lens.pickConversation([], []), null);
});

test("Back to regex parsing on a session made from the second conversation of an export keeps that conversation", async () => {
  const all = Lens.importAny(EXPORT, cfg);
  const s = {
    id: "conv2",
    name: "login",
    task: "",
    profile: "qa-ts",
    created: "2026-10-02T00:00:00.000Z",
    events: all[1].events,
    findings: [],
    verdicts: {},
    spec: "",
    source_text: EXPORT,
    // segmented by the model: that is when the button shows
    seg: { at: "2026-10-02T00:00:00.000Z", n: 1, coverage: 100, chunks: null, spec_suggested: "", raw: "" },
    importGen: Lens.IMPORT_GEN,
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sl-conv-"));
  const st = createStore({ dir: path.join(dir, "sessions") });
  await st.open();
  await st.put(s, { analyzedGen: "" });
  const host = bootHost({
    storageDir: dir,
    globalState: { storageVersion: 2, settings: { profile: "qa-ts", lint: false, rulesTarget: "claude", modelPool: [], defaultModelId: null } },
  });
  const p = await openPage(host, { sessionId: s.id });
  await p.ready();
  assert.equal(p.document.querySelector("#seg-reset").hidden, false);
  const n0 = p.sent.filter((m) => m.type === "session:put").length;
  p.document.querySelector("#seg-reset").dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
  for (let t = Date.now(); p.sent.filter((m) => m.type === "session:put").length === n0; await new Promise((r) => setTimeout(r, 20)))
    if (Date.now() - t > 5000) throw new Error("not saved");
  await p.idle();
  const back = createStore({ dir: path.join(dir, "sessions") });
  await back.open();
  const after = (await back.get(s.id)).session;
  assert.deepEqual(texts(after.events), ["Write the login tests", "Here are the login tests."]);
  assert.equal(after.seg, null);
  assert.deepEqual(p.errors, []);
  p.close();
});
