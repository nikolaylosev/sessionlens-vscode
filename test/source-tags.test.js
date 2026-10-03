"use strict";
/* 0.1.117: every finding carries a tag of its source (regex, eslint, gherkin, spec, model), labelled as the filter
   chips and the Calibration table label it. The spec tag used var(--teal), which was never defined, so it had no
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

test("every finding shows the tag of its source", async () => {
  const F = (check, severity, seq, source) => Object.assign({ check, severity, seq, message: `${check} #${seq}` }, source ? { source } : {});
  const findings = [
    F("pass_claim_without_run", "high", 1, "formal"),
    F("magic_number", "low", 2), // a regex finding saved before 0.1.112 has no source
    F("weak_assert", "medium", 3, "lint"),
    F("scenario_no_then", "medium", 4, "gherkin"),
    F("no_spec", "high", 5, "spec"),
    F("ai_fragility", "medium", 6, "ai"),
  ];
  const s = { id: "tags1", name: "tags", task: "", profile: "qa-ts", created: "2026-10-01T00:00:00.000Z", events: [], findings, verdicts: {}, spec: "" };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sl-tags-"));
  const st = createStore({ dir: path.join(dir, "sessions") });
  await st.open();
  await st.put(s, { analyzedGen: Lens.analysisGen({ ruleOverrides: {}, lint: false, epoch: 0 }) });
  const h = bootHost({
    storageDir: dir,
    globalState: { storageVersion: 2, settings: { profile: "qa-ts", lint: false, rulesTarget: "claude", modelPool: [], defaultModelId: null } },
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
  assert.deepEqual(tags, {
    "pass_claim_without_run #1": ["regex", "srctag formal"],
    "magic_number #2": ["regex", "srctag formal"],
    "weak_assert #3": ["eslint", "srctag lint"],
    "scenario_no_then #4": ["gherkin", "srctag gherkin"],
    "no_spec #5": ["spec", "srctag spec"],
    "ai_fragility #6": ["model", "srctag ai"],
  });
  assert.deepEqual(p.errors, []);
  p.close();
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
