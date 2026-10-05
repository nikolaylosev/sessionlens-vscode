"use strict";
/* A Cursor Agent transcript picked in the panel (0.1.121), end to end through the real panel and host
   (test/host-panel.js), with the CLI's database in a temporary home: the host finds the command output for the picked
   file, the import parses the runs with it, the session keeps the output with its text, and Back to regex parsing
   parses it the same way. The Output channel names the database, never the transcript. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { bootHost, openPage } = require("./host-panel");
const { createStore } = require("../store.js");
const { S, home, transcript, cliDb, shell, result } = require("./cursor-fixtures");

const SPEC = "/w/e2e/cart.spec.ts";
const TWO =
  "import { test, expect } from '@playwright/test';\n\ntest('total', async ({ page }) => {\n  await expect(page.getByTestId('total')).toHaveText(TOTAL);\n});\n";
const MARK = "cursor-panel-mark";
const line = (role, content) => JSON.stringify({ role, message: { content } });
const call = (name, input) => line("assistant", [{ type: "tool_use", name, input }]);
const JSONL = [
  line("user", [
    { type: "text", text: `<timestamp>Monday, Oct 5, 2026, 1:06 AM (UTC+5)</timestamp>\n<user_query>\nWrite the cart tests ${MARK}\n</user_query>` },
  ]),
  call("Write", { path: SPEC, contents: TWO }),
  call("Shell", { command: "npx playwright test" }),
  call("StrReplace", { path: SPEC, old_string: "toHaveText(TOTAL)", new_string: "toContainText(TOTAL)" }),
  call("Shell", { command: "npx playwright test" }),
  line("assistant", [{ type: "text", text: "All tests pass." }]),
  JSON.stringify({ type: "turn_ended", status: "success" }),
].join("\n");

async function until(fn, ms = 8000) {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
const click = (p, sel) => p.document.querySelector(sel).dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
const checks = (s) => s.findings.map((f) => f.check).sort();

test(
  "picked in the panel: the runs get their results from the CLI's database, kept with the session",
  { skip: !S && "node:sqlite is not available" },
  async () => {
    const h = home();
    const env = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = h; // os.homedir() reads these: the database is looked for in this home
    process.env.USERPROFILE = h;
    try {
      const file = transcript(h);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSONL);
      cliDb(h, [
        shell("c1", "npx playwright test"),
        result("c1", "Exit code: 1\n\nCommand output:\n```\n  1 failed\n  1 passed (2.0s)\n```"),
        shell("c2", "npx playwright test"),
        result("c2", "Exit code: 0\n\nCommand output:\n```\n  2 passed (2.0s)\n```"),
      ]);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sl-cursor-panel-"));
      const host = bootHost({
        storageDir: dir,
        globalState: { storageVersion: 2, settings: { profile: "qa-ts", lint: false, rulesTarget: "claude", modelPool: [], defaultModelId: null } },
        vscode: { openDialogAnswer: [{ scheme: "file", fsPath: file, toString: () => "file://" + file }] },
      });
      const sb = await openPage(host);
      await sb.ready();
      click(sb, "#file");
      await until(() => sb.document.querySelectorAll(".sl-modal-overlay button").length >= 3);
      sb.document.querySelectorAll(".sl-modal-overlay button")[2].click(); // somewhere else
      await until(() => !sb.document.querySelector("#name-row").hidden);
      sb.document.querySelector("#name-go").click();
      const store = async () => {
        const st = createStore({ dir: path.join(dir, "sessions") });
        await st.open();
        const id = st.list()[0] && st.list()[0].id;
        return id ? (await st.get(id)).session : null;
      };
      let s = null;
      await until(() => host.calls.output.some((l) => /analysis \(import\)/.test(l)));
      await sb.idle();
      s = await store();
      assert.ok(s, "imported");
      const runs = s.events.filter((e) => e.kind === "run_tests");
      assert.deepEqual(
        runs.map((r) => [r.tool, r.tests && r.tests.failed, r.output_missing]),
        [
          ["Shell", 1, undefined],
          ["Shell", 0, undefined],
        ],
      );
      assert.ok(checks(s).includes("fix_after_fail_without_triage"), checks(s).join(", "));
      assert.equal(s.source_outputs.length, 2, "kept with the text");
      const log = host.calls.output.join("\n");
      assert.match(log, /cursor: the output of 2 commands from the cli database/);
      assert.equal(log.includes(MARK), false, "nothing from the transcript in the Output channel");
      assert.deepEqual(sb.errors, []);
      sb.close();

      // Back to regex parsing parses the kept text with the kept output
      const tab = await openPage(host, { sessionId: s.id });
      await tab.ready();
      const n0 = tab.sent.filter((m) => m.type === "session:put").length;
      click(tab, "#seg-reset");
      await until(() => tab.sent.filter((m) => m.type === "session:put").length > n0);
      await tab.idle();
      s = await store();
      assert.ok(checks(s).includes("fix_after_fail_without_triage"), "still there after Back to regex parsing");
      assert.deepEqual(tab.errors, []);
      tab.close();
    } finally {
      for (const [k, v] of Object.entries(env))
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      fs.rmSync(h, { recursive: true, force: true });
    }
  },
);
