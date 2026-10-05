"use strict";
/* The rules file the Calibration tab writes for (sessionlens.rulesTarget, 0.1.121: Cursor). The real panel and host:
   with the target set in the VS Code settings, Copy rules and the suggested stub under a Compress rules.md result are
   the text of that file. Cursor's .mdc rule gets the frontmatter Cursor needs to load it in every chat; CLAUDE.md
   stays plain Markdown. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { bootHost, openPage } = require("./host-panel");

const MDC_HEAD = "---\ndescription: Rules from SessionLens reviews of agent sessions\nalwaysApply: true\n---\n\n";

async function calib(target) {
  const host = bootHost({
    globalState: {
      storageVersion: 2,
      settings: { profile: "qa-ts", lint: false, modelPool: [], defaultModelId: null },
      compressResults: [{ id: "c1", at: "2026-10-05T10:00:00.000Z", markdown: "1. Run the tests.", body: "x" }],
    },
    vscode: { config: { global: { "sessionlens.rulesTarget": target } } },
  });
  const p = await openPage(host);
  await p.ready();
  const copied = [];
  Object.defineProperty(p.window.navigator, "clipboard", { value: { writeText: async (t) => copied.push(t) }, configurable: true });
  p.document.querySelector('.tab[data-view="calib"]').dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
  await p.idle();
  p.document.querySelector("#copy-rules").click();
  await p.idle();
  return { p, copied };
}

test("Cursor: the select shows it, Copy rules and the stub are a .mdc file Cursor loads in every chat", async () => {
  const { p, copied } = await calib("cursor");
  assert.equal(p.document.querySelector("#rules-target").value, "cursor");
  assert.equal(p.document.querySelector("#c-rules-title").textContent, "Rules for .cursor/rules/sessionlens.mdc");
  assert.equal(copied.length, 1);
  assert.ok(copied[0].startsWith(MDC_HEAD + "# Proposed rules for .cursor/rules/sessionlens.mdc\n\n"), copied[0]);
  const res = p.document.querySelector("#compress-results .gen-result");
  assert.equal(res.querySelector(".compress-out").value, "1. Run the tests.", "the policy itself stays rules-policy.md");
  assert.equal(res.querySelector(".stub-text").value, MDC_HEAD + "Refer to `rules-policy.md` for domain-specific automation rules and code style.\n");
  assert.match(res.querySelector(".gen-file summary").textContent, /sessionlens\.mdc/);
  assert.deepEqual(p.errors, []);
  p.close();
});

test("Claude Code: plain Markdown, as before", async () => {
  const { p, copied } = await calib("claude");
  assert.ok(copied[0].startsWith("# Proposed rules for CLAUDE.md\n\n"), copied[0]);
  const res = p.document.querySelector("#compress-results .gen-result");
  assert.equal(res.querySelector(".stub-text").value, "Refer to `rules-policy.md` for domain-specific automation rules and code style.\n");
  assert.equal(res.querySelector(".gen-file summary").textContent, "Suggested CLAUDE.md / AGENTS.md text");
  assert.deepEqual(p.errors, []);
  p.close();
});
