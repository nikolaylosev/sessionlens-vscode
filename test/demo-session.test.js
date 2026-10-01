"use strict";
/* "Try a demo session" (0.1.110): the button in the real panel (jsdom, the real vscode-bridge.js and host, the real
   ESLint bundle) imports media/demo-session.js like a file the person picked. The findings pinned here are the ones
   the readme, its screenshots and the GIF show: if a check changes what it reports, this test says so, and the
   pictures need a look too. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { bootHost, openPage } = require("./host-panel");
const { root } = require("./helpers");

const MEDIA = path.join(root, "media");
const Lens = require(path.join(MEDIA, "lens.js"));
const D = require(path.join(MEDIA, "demo-session.js"));

async function until(fn, ms = 10000) {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
const click = (p, sel) => p.document.querySelector(sel).dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
const demoPuts = (p) => p.sent.filter((m) => m.type === "session:put" && m.payload.session.id === D.ID);

// check → how many findings; sleep_or_skip_added twice: the fixed wait in the test file (ESLint, which replaces the
// regex finding for it) and the retries in playwright.config.ts (regex: no engine looks for retries; until 0.1.113 the
// merge dropped it, RULES-ARCHITECTURE §6.3)
const EXPECTED = {
  peeked_at_src_before_plan: 1,
  fix_after_fail_without_triage: 1,
  assert_weakened: 1,
  sleep_or_skip_added: 2,
  pass_claim_without_run: 1,
  spec_uncovered: 1,
  raw_locator: 2,
  scope_creep: 1,
  assumption_instead_of_question: 1,
};

async function demoPage(profile = "qa-java") {
  // a profile other than the demo's: the demo brings its own
  const host = bootHost({ globalState: { settings: { profile, rulesTarget: "claude", modelPool: [], defaultModelId: null } } });
  const sb = await openPage(host, { engines: { "vendor-eslint.js": fs.readFileSync(path.join(MEDIA, "vendor-eslint.js"), "utf8") } });
  await sb.ready();
  sb.window.structuredClone = structuredClone; // a webview has it; jsdom does not
  return sb;
}

test("the demo transcript is made up: no real paths, hosts or names", () => {
  assert.doesNotMatch(D.TRANSCRIPT, /\/Users\/|birdhospital|nlosev/i);
  // e-mail addresses only at the reserved example.com (the "@" of @playwright/test is not one)
  assert.deepEqual([...new Set(D.TRANSCRIPT.match(/[\w.+-]+@[\w-]+\.[\w.]+/g))], ["user@example.com"]);
  for (const line of D.TRANSCRIPT.trim().split("\n")) assert.doesNotThrow(() => JSON.parse(line));
  assert.equal(D.PROFILE, "qa-ts");
  assert.match(D.SPEC, /^R1\. .+\nR2\. .+\nR3\. .+$/);
});

test("Try a demo session: imports it with its own name, profile and specification; the findings the readme shows", async () => {
  const sb = await demoPage();
  assert.equal(sb.document.querySelector("#demo-go").textContent, "Try a demo session");
  click(sb, "#demo-go");
  await until(() => demoPuts(sb).length);
  await sb.idle();
  const s = demoPuts(sb)[0].payload.session;
  assert.equal(s.name, D.NAME);
  assert.equal(s.nameSet, true);
  assert.equal(s.profile, "qa-ts");
  assert.equal(s.spec, D.SPEC);
  const got = {};
  for (const f of s.findings) got[f.check] = (got[f.check] || 0) + 1;
  assert.deepEqual(got, EXPECTED);
  assert.equal(Lens.verdict(s.findings), "red");
  const claim = s.findings.find((f) => f.check === "pass_claim_without_run");
  assert.match(claim.message, /1 passed \/ 1 failed/);
  assert.ok(
    sb.sent.some((m) => m.type === "session:open" && m.payload.id === D.ID),
    "the demo opens in its own tab",
  );
  assert.deepEqual(sb.errors, []);
  sb.close();
});

test("Try a demo session twice: the second click opens the one already there, no copy", async () => {
  const sb = await demoPage();
  click(sb, "#demo-go");
  await until(() => demoPuts(sb).length);
  await sb.idle();
  const opens = () => sb.sent.filter((m) => m.type === "session:open" && m.payload.id === D.ID).length;
  const before = opens();
  click(sb, "#demo-go");
  await until(() => opens() > before);
  await sb.idle();
  assert.equal(demoPuts(sb).length, 1);
  sb.close();
});

test("the demo does not count for calibration: its checks are not in the precision table", async () => {
  const sb = await demoPage();
  click(sb, "#demo-go");
  await until(() => demoPuts(sb).length);
  await sb.idle();
  click(sb, '.tab[data-view="calib"]');
  await sb.idle();
  const rows = [...sb.document.querySelectorAll("#precision tr")].slice(1).map((tr) => tr.firstElementChild.textContent);
  assert.deepEqual(rows, []);
  sb.close();
});

test("⚙ Settings → Hide the Try a demo session button: hides it at once, is saved, and brings it back when unticked", async () => {
  const sb = await demoPage();
  const btn = () => sb.document.querySelector("#demo-go");
  assert.equal(btn().hidden, false, "shown by default");
  click(sb, '.tab[data-view="settings"]');
  await sb.idle();
  const box = sb.document.querySelector("#s-hide-demo");
  assert.equal(box.checked, false);
  const toggle = async () => {
    box.checked = !box.checked;
    box.dispatchEvent(new sb.window.Event("change", { bubbles: true }));
    await sb.idle();
  };
  await toggle();
  assert.equal(btn().hidden, true);
  const saved = sb.sent.filter((m) => m.type === "storage:set" && m.payload.values.settings).pop();
  assert.equal(saved.payload.values.settings.hideDemo, true);
  await toggle();
  assert.equal(btn().hidden, false);
  sb.close();
});
