"use strict";
/* 0.1.115: a model finding records which model found it ("provider/model", from the review's route) and, after a
   verification, which model verified it. Report .json and verdicts.json carry both, so precision per model can be
   counted from the verdicts collected from now on. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { M } = require("./helpers");
const { bootHost, openPage } = require("./host-panel");
const { createStore } = require("../store.js");

const I18N = require(M("i18n.js"));
I18N.set("en");
const LensAI = require(M("ai.js"));
const Lens = require(M("lens.js"));

const session = {
  spec: "",
  findings: [],
  events: [{ seq: 1, kind: "write", file: "e2e/login.spec.ts", new_content: "test('login', async ({ page }) => {\n  await page.waitForTimeout(3000);\n});\n" }],
};
const REVIEW = JSON.stringify([
  { check: "fragility", severity: "high", seq: 1, message: "a fixed wait instead of waiting for the page", evidence: "await page.waitForTimeout(3000)" },
  { check: "missing", severity: "medium", seq: 1, message: "no case for a wrong password at all", evidence: "a wrong password is never tried" },
]);
const VERIFY = JSON.stringify([
  { i: 0, keep: true, evidence: "await page.waitForTimeout(3000)" },
  { i: 1, keep: false, why: "not in the materials" },
]);
// review on Anthropic, verification on Google: two routes of "Model per request"
const settings = (extra) =>
  Object.assign(
    {
      provider: "anthropic",
      model: "claude-x",
      minGapMs: 0,
      maxRetries: 0,
      routes: { review: { provider: "anthropic", model: "claude-x" }, verify: { provider: "google", model: "gemini-y" } },
    },
    extra,
  );
function fake() {
  LensAI.setKeyStatus({ anthropic: true, google: true });
  LensAI.setTransport(async (p) => ({ text: p.user.startsWith("# Findings") ? VERIFY : REVIEW }));
}
function reset() {
  LensAI.setTransport(null);
  LensAI.setKeyStatus(null);
}

test("review: every finding names the model of the review's route; verification adds its own", async () => {
  fake();
  const r = await LensAI.review(session, settings());
  assert.deepEqual(
    r.findings.map((f) => [f.check, f.model, f.verifier]),
    [["ai_fragility", "anthropic/claude-x", "google/gemini-y"]],
  );
  assert.deepEqual(
    r.dropped.map((f) => [f.check, f.model, f.verifier]),
    [["ai_missing", "anthropic/claude-x", "google/gemini-y"]],
  );
  const plain = await LensAI.review(session, settings({ verify: false }));
  assert.deepEqual(
    plain.findings.map((f) => [f.model, f.verifier]),
    [
      ["anthropic/claude-x", undefined],
      ["anthropic/claude-x", undefined],
    ],
    "no verification: no verifier",
  );
  reset();
});

test("verify again on its own (the Verify again button) records the verifier", async () => {
  fake();
  const found = [{ check: "ai_fragility", severity: "high", seq: 1, message: "a fixed wait", evidence: "x", source: "ai", model: "anthropic/claude-x" }];
  const v = await LensAI.verify(session, found, settings());
  assert.deepEqual(
    v.kept.map((f) => [f.model, f.verifier]),
    [["anthropic/claude-x", "google/gemini-y"]],
  );
  reset();
});

test("modelLabel: provider/model, the provider's default model when none is set", () => {
  assert.equal(LensAI.modelLabel({ provider: "google", model: "gemini-y" }), "google/gemini-y");
  assert.equal(LensAI.modelLabel({ provider: "claudecli", model: "" }), "claudecli/sonnet");
  assert.equal(LensAI.modelLabel({}), "anthropic/claude-sonnet-5");
});

test("Report .json and verdicts.json carry model and verifier for model findings only", async () => {
  const ai = {
    check: "ai_fragility",
    severity: "high",
    seq: 1,
    message: "a fixed wait",
    evidence: "e",
    source: "ai",
    model: "anthropic/claude-x",
    verifier: "google/gemini-y",
  };
  // a regex finding as the analysis makes it, so its verdict still matches after the tab analyzes the session again
  const formal = Object.assign(
    Lens.runChecks(session.events, Lens.profile("qa-ts")).find((f) => f.check === "sleep_or_skip_added"),
    { source: "formal" },
  );
  const at = "2026-10-02T00:00:00.000Z";
  const s = {
    id: "modelf1",
    name: "model findings",
    task: "",
    profile: "qa-ts",
    created: at,
    events: session.events,
    findings: [ai, formal],
    verdicts: { [Lens.fkey(ai)]: { v: "ok", note: "", at }, [Lens.fkey(formal)]: { v: "ok", note: "", at } },
    spec: "",
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sl-modelf-"));
  const st = createStore({ dir: path.join(dir, "sessions") });
  await st.open();
  await st.put(s, { analyzedGen: "" });
  const host = bootHost({
    storageDir: dir,
    globalState: { storageVersion: 2, settings: { profile: "qa-ts", lint: false, rulesTarget: "claude", modelPool: [], defaultModelId: null } },
  });
  const click = (p, sel) => p.document.querySelector(sel).dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
  const saved = async (p, name) => {
    for (let t = Date.now(); Date.now() - t < 5000; await new Promise((r) => setTimeout(r, 20))) {
      const m = p.sent.find((x) => x.type === "save:file" && name.test(x.payload.name));
      if (m) return JSON.parse(m.payload.content);
    }
    throw new Error("no " + name);
  };
  // the tab analyzes the session again when it opens, so the report has more findings: the two stored ones count
  const pick = (rows) =>
    rows
      .filter((f) => [ai.check, formal.check].includes(f.check))
      .map((f) => [f.check, f.model, f.verifier])
      .sort();
  const want = [
    ["ai_fragility", "anthropic/claude-x", "google/gemini-y"],
    ["sleep_or_skip_added", undefined, undefined],
  ];

  const tab = await openPage(host, { sessionId: s.id });
  await tab.ready();
  click(tab, "#export-json");
  assert.deepEqual(pick((await saved(tab, /-review\.json$/)).findings), want);
  tab.close();

  const sb = await openPage(host);
  await sb.ready();
  click(sb, "#export-verdicts");
  assert.deepEqual(pick(await saved(sb, /^verdicts\.json$/)), want);
  assert.deepEqual([...tab.errors, ...sb.errors], []);
  sb.close();
});
