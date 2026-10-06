"use strict";
/* 0.1.116: the effect of a rule moved to CLAUDE.md (effect() in src/webview/calibration.js). A session counts by when
   the agent ran it (the summary's started, the time of its first step), not by when it was imported; the demo
   session and the sessions of a profile that cannot report the check do not count. The real panel and host. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { bootHost, openPage } = require("./host-panel");
const { createStore } = require("../store.js");
const { load, M } = require("./helpers");

const { Lens } = load();
const LensDemo = require(M("demo-session.js"));
const MOVED = "2026-09-15T12:00:00.000Z";
const SLEEP = "test('a', async ({ page }) => {\n  await page.waitForTimeout(3000);\n  expect(await page.title()).toBe('Shop');\n});\n";
const CLEAN = "test('a', async ({ page }) => {\n  expect(await page.title()).toBe('Shop');\n});\n";

// sleeps: how many test files with a fixed wait; ts: the time of the steps ("" when the transcript has none)
function session(id, { profile = "qa-ts", created, ts = "", sleeps = 0, confirm = false }) {
  const events = [{ seq: 1, ts, kind: "user", text: "Write the tests." }];
  for (let i = 0; i < Math.max(sleeps, 1); i++)
    events.push({ seq: events.length + 1, ts, kind: "write", file: `e2e/f${i}.spec.ts`, new_content: i < sleeps ? SLEEP : CLEAN });
  const findings = Lens.runChecks(events, Lens.profile(profile));
  const sleep = findings.filter((f) => f.check === "sleep_or_skip_added");
  assert.equal(sleep.length, sleeps, `${id}: the fixture makes the findings it means to`);
  const verdicts = confirm ? Object.fromEntries(sleep.map((f) => [Lens.fkey(f), { v: "ok", note: "", at: created }])) : {};
  return { id, name: id, task: "", profile, created, events, findings, verdicts, spec: "" };
}
// the effect block of the moved rule: its note and the rows of its chart ([label, bar width or null, value])
async function effectView(sessions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sl-eff-"));
  const st = createStore({ dir: path.join(dir, "sessions") });
  await st.open();
  for (const s of sessions) await st.put(s, { analyzedGen: Lens.analysisGen({ ruleOverrides: {}, lint: false, epoch: 0 }) });
  const h = bootHost({
    storageDir: dir,
    globalState: {
      storageVersion: 2,
      settings: { profile: "qa-ts", lint: false, rulesTarget: "claude", modelPool: [], defaultModelId: null },
      rulesApplied: { sleep_or_skip_added: MOVED },
    },
  });
  const p = await openPage(h);
  await p.ready();
  p.document.querySelector('.tab[data-view="calib"]').dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
  const min = p.document.querySelector("#min-count");
  min.value = "1";
  min.dispatchEvent(new p.window.Event("change", { bubbles: true }));
  await p.idle();
  const eff = p.document.querySelector('.rule[data-k="sleep_or_skip_added"] .effect');
  const note = eff && eff.querySelector(".eff-note");
  const rows = eff
    ? [...eff.querySelectorAll(".eff-row")].map((r) => {
        const bar = r.querySelector(".eff-bar");
        return [r.querySelector(".eff-lbl").textContent, bar ? bar.style.width : null, r.querySelector(".eff-val").textContent];
      })
    : [];
  assert.deepEqual(p.errors, []);
  p.close();
  return { note: note && note.textContent, rows };
}
const effectText = async (sessions) => (await effectView(sessions)).note;

test("the summary records when the agent ran the session: its first step with a time", () => {
  const s = session("s", { created: "2026-09-20T00:00:00.000Z", ts: "2026-09-01T08:30:00Z", sleeps: 1 });
  s.events.unshift({ seq: 0, ts: "", kind: "user", text: "no time on this one" });
  assert.equal(Lens.sessionSummary(s).started, "2026-09-01T08:30:00.000Z");
  assert.equal(Lens.sessionSummary(session("n", { created: "2026-09-20T00:00:00.000Z" })).started, "", "a transcript without times");
});

test("effect: a session counts by when it ran; the demo and a profile without the check stay out", async () => {
  const text = await effectText([
    // ran before the rule was moved, imported after it: before
    session("old-run", { created: "2026-09-20T00:00:00.000Z", ts: "2026-09-01T08:00:00.000Z", sleeps: 2, confirm: true }),
    // no times in the transcript: the import time decides, before
    session("no-times", { created: "2026-09-02T00:00:00.000Z", sleeps: 0 }),
    // ran after: after, without the finding
    session("new-run", { created: "2026-09-21T00:00:00.000Z", ts: "2026-09-20T08:00:00.000Z", sleeps: 0 }),
    // qa-generic has no sleep check: its sessions say nothing about the rule
    session("generic", { profile: "qa-generic", created: "2026-09-22T00:00:00.000Z", ts: "2026-09-22T08:00:00.000Z" }),
    // the demo is made up, whatever it contains
    Object.assign(session(LensDemo.ID, { created: "2026-09-23T00:00:00.000Z", ts: "2026-09-23T08:00:00.000Z", sleeps: 3 }), { name: LensDemo.NAME }),
  ]);
  assert.equal(text, "effect: before 1.00 per session (2 sessions) → after 0.00 (1) — −100% · little data");
});

test("no session after the move yet: the chart is there, its after row empty (0.1.121; only the note before)", async () => {
  const v = await effectView([
    // imported after the move, but ran before it: before
    session("old-run", { created: "2026-09-20T00:00:00.000Z", ts: "2026-09-01T08:00:00.000Z", sleeps: 2, confirm: true }),
    session("older", { created: "2026-09-20T00:00:00.000Z", ts: "2026-09-02T08:00:00.000Z", sleeps: 0 }),
  ]);
  assert.equal(v.note, "effect: before 1.00 per session (2); no sessions after yet");
  assert.deepEqual(v.rows, [
    ["before", "100%", "1.00"],
    ["after", null, "—"],
  ]);
});
