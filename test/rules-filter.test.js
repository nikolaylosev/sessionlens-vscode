"use strict";
/* The Rules tab shows the checks of one profile (0.1.114): what Lens.profileInfo() says the profile can report, plus
   the specification and model checks, which every profile has. Until a profile is picked there, the one of the
   Sessions tab; "All profiles" shows the whole book. Only a view: an override of a check that is not shown stays. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { bootHost, openPage } = require("./host-panel");
const { load } = require("./helpers");

const { Lens, LensRules } = load();
const deps = { checks: require("../media/checks.js"), lint: require("../media/lint.js"), spec: require("../media/spec.js") };
const ANY_PROFILE = ["no_spec", "spec_uncovered", "test_without_requirement", "out_of_scope_tested"];

async function rulesTab(settings = {}, ruleOverrides = {}) {
  const host = bootHost({
    globalState: {
      storageVersion: 2,
      settings: Object.assign({ profile: "qa-ts", rulesTarget: "claude", modelPool: [], defaultModelId: null }, settings),
      ruleOverrides,
    },
  });
  const p = await openPage(host);
  await p.ready();
  p.document.querySelector('.tab[data-view="rules"]').dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
  await p.idle();
  return { host, p };
}
const rows = (p) => [...p.document.querySelectorAll("#rules-list .rule-row")].map((r) => r.dataset.check);
const groups = (p) => [...p.document.querySelectorAll("#rules-list details.sec-d")].map((d) => d.dataset.group);
async function pick(p, value) {
  const sel = p.document.querySelector("#rules-profile");
  sel.value = value;
  sel.dispatchEvent(new p.window.Event("change", { bubbles: true }));
  await p.idle();
}
const own = (profile) =>
  Lens.profileInfo(profile, deps)
    .groups.flatMap((g) => g.checks.map((c) => c.name))
    .sort();

test("by default the Rules tab shows the checks of the Sessions tab's profile, and the spec and model checks", async () => {
  const { p } = await rulesTab({ profile: "qa-java" });
  assert.equal(p.document.querySelector("#rules-profile").value, "qa-java");
  const shown = rows(p);
  for (const c of own("qa-java")) assert.ok(shown.includes(c), c);
  for (const c of ANY_PROFILE) assert.ok(shown.includes(c), c);
  assert.ok(shown.includes("ai_coverage"));
  assert.equal(shown.includes("focused_test"), false, "a TypeScript check");
  assert.equal(shown.includes("hardcoded_coordinates"), false, "a mobile check");
  assert.deepEqual(groups(p), ["method", "process", "code", "gherkin", "spec", "ai"], "no empty api, mobile or robot group");
  assert.match(
    p.document.querySelector("#rules-shown").textContent,
    new RegExp(`^${shown.length} of ${LensRules.book({}).length} checks: what qa-java can report`),
  );
  assert.deepEqual(p.errors, []);
  p.close();
});

test("a profile picked on the Rules tab is saved; All profiles shows the whole book", async () => {
  const { host, p } = await rulesTab();
  await pick(p, "qa-robot");
  assert.ok(rows(p).includes("empty_test_case"));
  assert.ok(groups(p).includes("robot"));
  let saved = p.sent.filter((m) => m.type === "storage:set" && m.payload.values.settings).pop();
  assert.equal(saved.payload.values.settings.rulesProfile, "qa-robot");
  assert.equal(saved.payload.values.settings.profile, "qa-ts", "the Sessions tab's profile is not changed");

  await pick(p, "");
  assert.equal(rows(p).length, LensRules.book({}).length);
  assert.equal(p.document.querySelector("#rules-shown").textContent, "");
  saved = p.sent.filter((m) => m.type === "storage:set" && m.payload.values.settings).pop();
  assert.equal(saved.payload.values.settings.rulesProfile, "");
  p.close();

  const again = await openPage(host);
  await again.ready();
  again.document.querySelector('.tab[data-view="rules"]').dispatchEvent(new again.window.MouseEvent("click", { bubbles: true }));
  await again.idle();
  assert.equal(again.document.querySelector("#rules-profile").value, "", "All profiles is remembered");
  again.close();
});

test("only a view: an override of a check the filter hides stays, and a shown check still saves", async () => {
  const { p } = await rulesTab({}, { hardcoded_coordinates: { enabled: false } });
  assert.equal(rows(p).includes("hardcoded_coordinates"), false);
  const box = p.document.querySelector('.rule-row[data-check="weak_assert"] .r-enabled');
  box.checked = false;
  box.dispatchEvent(new p.window.Event("change", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 350)); // saveRules waits 300 ms for more clicks
  await p.idle();
  const saved = p.sent.filter((m) => m.type === "storage:set" && m.payload.values.ruleOverrides).pop();
  assert.deepEqual(saved.payload.values.ruleOverrides, { hardcoded_coordinates: { enabled: false }, weak_assert: { enabled: false } });
  p.close();
});
