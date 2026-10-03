"use strict";
/* 0.1.117: every finding carries a tag of its source (regex, lint, gherkin, spec, model), labelled as the filter
   chips and the Calibration table label it; a lint finding names the engine of its session's profile (eslint,
   tree-sitter, robot), since all of them report under the source "lint". The spec tag used var(--teal), which was never defined, so it had no
   background and could not be read in the dark theme; regex and Gherkin findings had no tag. The real panel. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { bootHost, openPage } = require("./host-panel");
const { createStore } = require("../store.js");
const { load, root } = require("./helpers");

const { Lens } = load();

const F = (check, severity, seq, source) => Object.assign({ check, severity, seq, message: `${check} #${seq}` }, source ? { source } : {});
// opens a session of the profile with these findings in its own tab → { message: [tag text, tag class] }, the chips
async function tagsOf(profile, findings) {
  const s = {
    id: "tags-" + profile.replace(/\W/g, ""),
    name: "tags",
    task: "",
    profile,
    created: "2026-10-01T00:00:00.000Z",
    events: [],
    findings,
    verdicts: {},
    spec: "",
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sl-tags-"));
  const st = createStore({ dir: path.join(dir, "sessions") });
  await st.open();
  await st.put(s, { analyzedGen: Lens.analysisGen({ ruleOverrides: {}, lint: false, epoch: 0 }) });
  const h = bootHost({
    storageDir: dir,
    globalState: { storageVersion: 2, settings: { profile, lint: false, rulesTarget: "claude", modelPool: [], defaultModelId: null } },
  });
  const p = await openPage(h, { sessionId: s.id });
  await p.ready();
  const tags = Object.fromEntries(
    [...p.document.querySelectorAll("#findings .f")].map((d) => {
      const t = d.querySelectorAll(".sev .srctag");
      assert.equal(t.length, 1, d.dataset.k);
      return [d.querySelector(".msg").textContent, [t[0].textContent, t[0].className]];
    }),
  );
  const chips = [...p.document.querySelectorAll("#filter .chip[data-src]")].map((c) => c.textContent.replace(/\s+\d+$/, ""));
  assert.deepEqual(p.errors, []);
  p.close();
  return { tags, chips };
}

test("every finding shows the tag of its source", async () => {
  const { tags } = await tagsOf("qa-ts", [
    F("pass_claim_without_run", "high", 1, "formal"),
    F("magic_number", "low", 2), // a regex finding saved before 0.1.112 has no source
    F("weak_assert", "medium", 3, "lint"),
    F("scenario_no_then", "medium", 4, "gherkin"),
    F("no_spec", "high", 5, "spec"),
    F("ai_fragility", "medium", 6, "ai"),
  ]);
  assert.deepEqual(tags, {
    "pass_claim_without_run #1": ["regex", "srctag formal"],
    "magic_number #2": ["regex", "srctag formal"],
    "weak_assert #3": ["eslint", "srctag lint"],
    "scenario_no_then #4": ["gherkin", "srctag gherkin"],
    "no_spec #5": ["spec", "srctag spec"],
    "ai_fragility #6": ["model", "srctag ai"],
  });
});

test("a lint finding names the engine of its session's profile; the filter says lint", async () => {
  const engines = { "qa-ts": "eslint", "qa-cypress": "eslint", "qa-python": "tree-sitter", "qa-java": "tree-sitter", "qa-robot": "robot" };
  for (const [profile, engine] of Object.entries(engines)) {
    const { tags, chips } = await tagsOf(profile, [F("weak_assert", "medium", 1, "lint"), F("pass_claim_without_run", "high", 2, "formal")]);
    assert.deepEqual(tags["weak_assert #1"], [engine, "srctag lint"], profile);
    assert.ok(chips.includes("lint") && !chips.includes("eslint"), `${profile}: ${chips}`);
  }
});

test("every colour the stylesheet uses is defined, for the light and the dark theme", () => {
  const css = fs.readFileSync(path.join(root, "media", "styles.css"), "utf8");
  const block = (sel) => {
    const m = css.match(new RegExp(sel.replace(/[[\]"()]/g, "\\$&") + "\\{([^}]*)\\}"));
    assert.ok(m, sel);
    return new Set([...m[1].matchAll(/(--[\w-]+)\s*:/g)].map((x) => x[1]));
  };
  const light = block(":root"),
    dark = block(':root[data-theme="dark"]');
  const used = new Set([...css.matchAll(/var\((--[\w-]+)\s*[,)]/g)].map((x) => x[1]));
  // VS Code's own variables and --v, which the page sets on the element itself, come from outside this file
  const own = [...used].filter((v) => !v.startsWith("--vscode-") && v !== "--v");
  for (const v of own) {
    assert.ok(light.has(v), `${v} is not defined in :root`);
    assert.ok(dark.has(v), `${v} is not defined for the dark theme`);
  }
});
