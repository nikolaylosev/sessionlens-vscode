"use strict";
/* Phase 7, step 7A.4: what the selected profile checks. Lens.profileInfo() is data derived from the profile, the check
   registry, the engines and the specification extractors; the panel only words it. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const I18N = (global.I18N = require("../media/i18n.js"));
const Lens = require("../media/lens.js");
const LensChecks = require("../media/checks.js");
const LensSpec = require("../media/spec.js");
const LensLint = require("../media/lint.js");
const { bootHost, openPage } = require("./host-panel");
const { makeFixture } = require("../perf/fixtures");
const { root } = require("./helpers");

const SNAP = path.join(root, "test", "__snapshots__", "profile-info-v0104.json");
const UPDATE = process.env.SL_UPDATE_SNAPSHOTS === "1";
const deps = (extra) => Object.assign({ checks: LensChecks, lint: LensLint, spec: LensSpec }, extra || {});

test("profileInfo for every visible profile matches the snapshot", () => {
  const got = Object.fromEntries(Lens.PROFILES.map((p) => [p, Lens.profileInfo(p, deps())]));
  if (UPDATE || !fs.existsSync(SNAP)) {
    fs.writeFileSync(SNAP, JSON.stringify(got, null, 1) + "\n");
    return;
  }
  assert.deepEqual(got, JSON.parse(fs.readFileSync(SNAP, "utf8")));
});

test("profileInfo agrees with the structures it is derived from", () => {
  for (const p of Lens.PROFILES) {
    const info = Lens.profileInfo(p, deps()),
      cfg = Lens.profile(p);
    const names = info.groups.flatMap((g) => g.checks.map((c) => c.name));
    assert.equal(new Set(names).size, names.length, `${p}: a check is listed once`);
    assert.equal(info.count, names.length, `${p}: count`);
    for (const g of info.groups)
      for (const c of g.checks) {
        assert.ok(LensChecks.CHECKS[c.name], `${p}: ${c.name} is in the registry`);
        assert.equal(LensChecks.CHECKS[c.name].group, g.group, `${p}: ${c.name} in its registry group`);
      }
    for (const k of cfg.checks) assert.ok(names.includes(k), `${p}: profile check ${k} is listed`);
    const files = LensLint.ENGINE_FILES[cfg.language];
    if (files) assert.ok(info.engine.kind === (files.boot ? "tree-sitter" : info.engine.kind) && info.engine.kind !== "none", `${p}: engine`);
    else assert.ok(["none", "robot-parser"].includes(info.engine.kind), `${p}: no engine files`);
    for (const e of info.spec.read) assert.equal(LensSpec.supports(cfg.language, "f" + e), true, `${p} ${e}`);
    for (const e of info.spec.notRead) assert.equal(LensSpec.supports(cfg.language, "f" + e), false, `${p} ${e}`);
    assert.ok(I18N.has("en", "profile_desc_" + p), `${p}: has a description`);
    assert.ok(I18N.has("en", "pi_eng_" + info.engine.kind), `${p}: engine label`);
    for (const g of info.groups) assert.ok(I18N.has("en", "g_" + g.group), `group label g_${g.group}`);
  }
});

test("settings, Rules overrides and verdicts show up in profileInfo", () => {
  assert.equal(Lens.profileInfo("qa-ts", deps({ settings: { lint: false } })).engine.state, "off");
  assert.equal(Lens.profileInfo("qa-ts", deps({ settings: {} })).engine.state, "on");
  assert.equal(Lens.profileInfo("qa-api", deps({ settings: { lint: false } })).engine.state, "none");
  const off = Lens.profileInfo("qa-ts", deps({ overrides: { magic_number: { enabled: false } } }));
  assert.equal(off.groups.flatMap((g) => g.checks).find((c) => c.name === "magic_number").off, true);
  assert.equal(Lens.profileInfo("qa-java", deps({ verdicts: 4 })).calibration.validated, false);
  assert.equal(Lens.profileInfo("qa-java", deps({ verdicts: 5 })).calibration.validated, true);
  assert.equal(Lens.profileInfo("qa-ts", deps()).calibration.builtIn, true);
});

// ---- the panel ----
const FX = makeFixture({ n: 8, bytes: 20 * 1024, seed: 11 });
const state = (patch) => {
  const s = JSON.parse(JSON.stringify(Object.assign({ sessions: FX.sessions }, FX.storage)));
  if (patch) patch(s);
  return s;
};
const text = (p) => p.document.querySelector("#profile-info").textContent;
async function select(p, value) {
  const sel = p.document.querySelector("#profile");
  sel.value = value;
  sel.dispatchEvent(new p.window.Event("change", { bubbles: true }));
  await p.idle();
}

test("the block under Profile follows the selected profile, the settings and the Rules", async () => {
  const host = bootHost({
    globalState: state((s) => {
      s.ruleOverrides = { magic_number: { enabled: false } };
    }),
  });
  const sb = await openPage(host);
  await sb.ready();
  assert.match(text(sb), /TypeScript \/ JavaScript/);
  assert.match(text(sb), /ESLint \(off in ⚙ Settings\)/); // the fixture has lint: false
  assert.match(text(sb), /magic_number off in Rules/);
  assert.doesNotMatch(text(sb), /\bpi_|profile_desc_/, "no raw i18n keys");
  const opts = [...sb.document.querySelectorAll("#profile option")].map((o) => o.textContent);
  assert.ok(opts.includes("qa-java — Java / Kotlin"), opts.join(" | "));
  assert.ok(opts.includes("qa-robot — Robot Framework (unvalidated)"), opts.join(" | "));
  await select(sb, "qa-robot");
  assert.match(text(sb), /built-in Robot Framework parser/);
  assert.match(text(sb), /not for \.resource/);
  await select(sb, "qa-api");
  assert.match(text(sb), /no static analysis/);
  assert.match(text(sb), /none for this profile/);
  assert.deepEqual(sb.errors, []);
  sb.close();
});

test("with ESLint on, the block says so; the session header carries the summary as a tooltip", async () => {
  const host = bootHost({
    globalState: state((s) => {
      s.settings.lint = true;
    }),
  });
  const sb = await openPage(host);
  await sb.ready();
  assert.match(text(sb), /ESLint · /);
  assert.match(sb.document.querySelector("#profile-info details").textContent, /ESLint — on/);
  sb.close();
  const id = Object.keys(FX.sessions).find((k) => FX.sessions[k].profile === "qa-java");
  const tab = await openPage(host, { sessionId: id });
  await tab.ready();
  const span = tab.document.querySelector("#hdr .pi-hdr");
  assert.equal(span.textContent, "qa-java");
  assert.match(span.getAttribute("title"), /^Java \/ Kotlin · mvn test/);
  assert.deepEqual(tab.errors, []);
  tab.close();
});

test("a rule text with markup stays text in the block (tooltip of a check)", async () => {
  const P = "\"'><img src=x onerror=alert(1)>";
  const host = bootHost({
    globalState: state((s) => {
      s.ruleOverrides = { magic_number: { rule: P } };
    }),
  });
  const sb = await openPage(host);
  await sb.ready();
  const el = sb.document.querySelector("#profile-info");
  assert.equal(el.querySelectorAll("img").length, 0);
  assert.equal(el.querySelector("code[title]") !== null, true);
  const withP = [...el.querySelectorAll("code[title]")].find((c) => c.getAttribute("title") === P);
  assert.ok(withP, "the rule text is the title, verbatim");
  assert.equal(
    [...el.querySelectorAll("*")].some((n) => [...n.attributes].some((a) => a.name.startsWith("on"))),
    false,
  );
  sb.close();
});
