"use strict";
/* Phase 3, step 3.7: every string a transcript, a model answer or an imported file can put into storage is rendered
   by the real panel (media/sidepanel.html + scripts, jsdom), with a markup payload in every one of them. Compared
   with the same fixture made of harmless strings, no new element may appear and no attribute may start with "on".
   The CSP of the VS Code webview would block an inline handler anyway; the point is that no markup gets in at all
   (fake buttons, <style>). The mutation test at the end shows the check notices a single missing esc(). */
const test = require("node:test");
const assert = require("node:assert/strict");
const { bootHost, openPage } = require("./host-panel");
// phase 7 (7B.3): the VS Code code path only (the Chrome build is gone)
async function showView(p, view) {
  p.document.querySelector(`.tab[data-view="${view}"]`).dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
  await p.idle();
}

const PAYLOADS = ["<img src=x onerror=alert(1)>", "\"'><svg onload=alert(1)>", '</td></tr></table><button data-act="x">', "<style>*{display:none}</style>"];
const WATCH = ["img", "svg", "style", "script", "iframe", "object", "embed", "button", "table", "a", "input", "select", "textarea", "details"];

// One session, one imported finding, one rule override, one compress and one skill result: every string field `P`.
function fixture(P) {
  const id = "s-" + P; // ids come from storage too
  const events = [
    { seq: 1, kind: "user", text: P },
    { seq: 2, kind: "message", text: P },
    { seq: 3, kind: "write", file: "tests/" + P + ".spec.ts", new_content: "test('" + P + "', () => { expect(1).toBe(1); });" },
    { seq: 4, kind: "bash", cmd: P },
    { seq: 5, kind: "run_tests", cmd: "npx playwright test " + P, tests: { passed: P, failed: P } },
    {
      seq: 6,
      kind: "edit",
      file: P,
      new_content: P,
      assert_delta: { old: P, new: P, identical: false, weakened: [{ test: P, reason: P }], removed: [{ test: P, before: P, after: P }] },
    },
    { seq: P, kind: P, file: P, text: P },
  ];
  const f1 = { check: P, severity: P, seq: P, message: P, evidence: P, code: P, source: "ai", why: P, model_why: P };
  const f2 = { check: P, severity: "high", seq: 3, message: P + " 2", evidence: P, source: "formal" };
  const f3 = { check: "fixed_sleep", severity: "medium", seq: 3, message: P + " 3", source: "formal" };
  const fkey = (f) => `${f.check}@${f.seq}@${f.message.slice(0, 40)}`;
  const verdicts = { [fkey(f1)]: { v: "ok", note: P, at: P }, [fkey(f2)]: { v: "ok", note: P, at: P }, [fkey(f3)]: { v: "fp", note: P, at: P } };
  const session = {
    id,
    name: P,
    task: P,
    profile: P,
    created: P,
    events,
    findings: [f1, f2, f3],
    verdicts,
    spec: "REQ-1: " + P,
    coverage: { covered: { "REQ-1": [P] }, unlinked: [{ name: P }] },
    specParsed: { n: P },
    dropped: [{ check: P, message: P, why: P, model_why: P, seq: P }],
    suppressed: [],
    metrics: { reads: P, edits: P, readEdit: P, runs: P, editsToGreen: P },
  };
  return {
    storage: {
      settings: {
        profile: "qa-ts",
        rulesTarget: "claude",
        modelPool: [{ id: P, provider: "openai", model: P, label: P }],
        defaultModelId: P,
        routes: { review: { provider: "openai", model: P } },
      },
      sessions: { [id]: session },
      external: [{ check: P, severity: P, message: P, session: P, source: P, verdict: "ok" }],
      rulesApplied: { [P]: "2026-01-01T00:00:00.000Z" + P },
      rulesDismissed: {},
      ruleOverrides: { [P]: { rule: P, good: P, severity: P }, fixed_sleep: { rule: P, good: P } },
      calibLog: [{ at: P, kind: P, text: P }],
      compressResults: [{ id: P, at: P, text: P, md: P }],
      skillResults: [{ id: P, at: P, skill_name: P, files: [{ path: P, content: P }] }],
    },
    id,
  };
}

async function renderAll(P, patchApp) {
  const { storage, id } = fixture(P);
  const counts = {},
    onAttrs = [],
    texts = [],
    errors = [];
  const take = (p) => {
    for (const t of WATCH) counts[t] = (counts[t] || 0) + p.document.querySelectorAll(t).length;
    for (const el of p.document.querySelectorAll("*")) for (const a of el.attributes) if (/^on/i.test(a.name)) onAttrs.push(`${el.tagName}[${a.name}]`);
    texts.push(p.document.body.textContent);
  };
  // the sidebar: every view in turn (the calibration min-count lowered to 1 so every confirmed check becomes a rule)
  const host = bootHost({ globalState: JSON.parse(JSON.stringify(storage)) });
  let p = await openPage(host, { patchApp });
  await p.ready();
  for (const v of ["sessions", "calib", "rules", "prompts", "settings"]) {
    await showView(p, v);
    if (v === "calib") {
      const m = p.document.querySelector("#min-count");
      if (m) {
        m.value = "1";
        m.dispatchEvent(new p.window.Event("change", { bubbles: true }));
        m.dispatchEvent(new p.window.Event("input", { bubbles: true }));
        await p.idle();
      }
    }
    take(p);
  }
  errors.push(...p.errors);
  // a session tab: the whole review
  p.close();
  p = await openPage(host, { sessionId: id, patchApp });
  await p.ready();
  take(p);
  errors.push(...p.errors);
  p.close();
  return { counts, onAttrs, text: texts.join("\n"), errors };
}

let baseline;
test.before(async () => {
  baseline = await renderAll("SAFE-TEXT");
});

test("the harmless fixture renders every section without page errors", () => {
  assert.deepEqual(baseline.errors, []);
  for (const s of ["SAFE-TEXT"]) assert.ok(baseline.text.includes(s));
  assert.ok(baseline.counts.table > 0 && baseline.counts.button > 0, JSON.stringify(baseline.counts));
});

for (const P of PAYLOADS) {
  test(`markup in every stored string stays text: ${P}`, async () => {
    const r = await renderAll(P);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.onAttrs, [], "no on* attribute anywhere");
    assert.deepEqual(r.counts, baseline.counts, "no element beyond what the harmless fixture has");
    assert.ok(r.text.includes(P.slice(0, 5)), "the payload is shown as text");
  });
}

test("mutation: dropping one esc() (#precision check name) is caught", async () => {
  const patch = (src) => {
    const from = "return `<tr><td>${esc(k)}</td>";
    assert.ok(src.includes(from), "the #precision row is where the test expects it");
    return src.replace(from, "return `<tr><td>${k}</td>");
  };
  const r = await renderAll(PAYLOADS[0], patch);
  assert.notDeepEqual(r.counts, baseline.counts);
});

test("mutation: dropping one esc() (#hdr profile) is caught", async () => {
  const patch = (src) => {
    // phase 7 (7A.4): the profile in the header sits in a <span> with the profile summary as its title
    const from = '">${esc(s.profile)}</span> · ${esc(T("events"';
    assert.ok(src.includes(from));
    return src.replace(from, '">${s.profile}</span> · ${esc(T("events"');
  };
  const r = await renderAll(PAYLOADS[1], patch);
  assert.ok(r.onAttrs.length > 0 || JSON.stringify(r.counts) !== JSON.stringify(baseline.counts));
});

test("mutation: dropping one esc() (#rules check name) is caught", async () => {
  const patch = (src) => {
    const from = '`<div class="rule" data-k="${esc(k)}"';
    assert.ok(src.includes(from));
    return src.replace(from, '`<div class="rule" data-k="${k}"');
  };
  const r = await renderAll(PAYLOADS[1], patch);
  assert.ok(r.onAttrs.length > 0 || JSON.stringify(r.counts) !== JSON.stringify(baseline.counts));
});
