"use strict";
/* browser_check_not_in_test (0.1.125): the agent looked at the page through a browser MCP (Claude in Chrome, Playwright
   MCP, Chrome DevTools MCP, Puppeteer) after its last change of a test file, and changed no test after that. What must
   not count, from the owner's sessions of 8 Oct 2026: looking at the site before writing the tests, and looking while
   finding out why a test failed, then changing the test. Nor tab housekeeping, other MCP servers, or a session that
   wrote no test. Made-up content only. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");

const { Lens } = load();
const cfg = Lens.profile("qa-ts");
const CHROME = (t) => "mcp__claude-in-chrome__" + t;
const SPEC = "e2e/search.spec.ts";
const PW =
  "import { test, expect } from '@playwright/test';\ntest('closes', async ({ page }) => {\n  await expect(page.getByRole('dialog')).toBeHidden();\n});\n";

// steps: "look:<tool>" (a browser MCP call), "tool:<name>" (any other tool, as named), "write:<file>", "edit:<file>", "run:<passed>/<failed>", "say:<text>"
function events(...steps) {
  return steps.map((s, seq) => {
    const [kind, arg] = s.split(/:(.*)/s);
    if (kind === "look") return { seq, kind: "tool", tool: arg.includes("__") ? arg : CHROME(arg) };
    if (kind === "tool") return { seq, kind: "tool", tool: arg };
    if (kind === "write" || kind === "edit") return { seq, kind, file: arg, new_content: PW };
    if (kind === "run") {
      const [passed, failed] = arg.split("/").map(Number);
      return { seq, kind: "run_tests", cmd: "npx playwright test", tests: { passed, failed, errors: 0, failed_names: [] }, exit_code: failed ? 1 : 0 };
    }
    return { seq, kind: "message", text: arg };
  });
}
const found = (ev, c = cfg) => Lens.runChecks(ev, c).filter((f) => f.check === "browser_check_not_in_test");

test("looked at the page after the last test change and changed no test: one medium finding at the first look", () => {
  const f = found(events("write:" + SPEC, "run:1/0", "look:navigate", "look:computer", "look:get_page_text", "say:Looks right, the dialog closes."));
  assert.deepEqual(
    f.map((x) => [x.severity, x.seq, x.message]),
    [["medium", 2, "Checked the page in the browser 3 times after the last test change (seq 2–4); no test asserts what it saw"]],
  );
  assert.deepEqual(
    found(events("write:" + SPEC, "look:read_page")).map((x) => x.message),
    ["Checked the page in the browser after the last test change (seq 1); no test asserts what it saw"],
  );
});

test("not counted: looking before the tests, looking while triaging a failure and then changing the test", () => {
  // the owner's first session: explore the site, write the tests, run them
  assert.deepEqual(found(events("look:navigate", "look:read_page", "look:find", "write:" + SPEC, "run:2/0", "say:All pass.")), []);
  // the owner's second session: a red run, a look at the page, the test changed and run again
  assert.deepEqual(found(events("write:" + SPEC, "run:1/1", "look:javascript_tool", "look:computer", "edit:" + SPEC, "run:2/0")), []);
  // a look at the page, then the test changed: what it saw is in the test
  assert.deepEqual(found(events("write:" + SPEC, "look:computer", "edit:" + SPEC)), []);
});

test("not counted: tab housekeeping, other MCP servers, and a session that wrote no test", () => {
  assert.deepEqual(
    found(events("write:" + SPEC, "run:1/0", "look:tabs_context_mcp", "look:tabs_close_mcp", "look:resize_window", "look:mcp__playwright__browser_close")),
    [],
  );
  assert.deepEqual(found(events("write:" + SPEC, "look:mcp__github__create_issue", "look:mcp__filesystem__read_file", "tool:ToolSearch")), []);
  assert.deepEqual(found(events("look:navigate", "look:get_page_text", "say:The page works.")), [], "no test written: other checks");
  // a file that is not a test does not settle it
  assert.equal(found(events("write:" + SPEC, "look:computer", "write:README.md")).length, 1);
});

test("the browser MCP servers people use, with and without the mcp__ prefix", () => {
  for (const tool of [
    "mcp__claude-in-chrome__computer",
    "mcp__playwright__browser_snapshot",
    "mcp__playwright__browser_click",
    "mcp__chrome-devtools__take_snapshot",
    "mcp__puppeteer__puppeteer_screenshot",
    "mcp__browsermcp__browser_navigate",
    "playwright__browser_evaluate",
  ])
    assert.equal(found(events("write:" + SPEC, "look:" + tool)).length, 1, tool);
});

test("from a Claude Code transcript, in every profile", () => {
  const rec = (o) => JSON.stringify(o);
  const use = (id, name, input) => rec({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
  const done = (id) => rec({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
  const text = [
    rec({ type: "user", cwd: "/w", message: { role: "user", content: "Write the search tests" } }),
    use("w", "Write", { file_path: "/w/" + SPEC, content: PW }),
    done("w"),
    use("b", CHROME("computer"), { action: "screenshot" }),
    done("b"),
    rec({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "The dialog closes, done." }] } }),
  ].join("\n");
  const ev = Lens.importAny(text, cfg);
  assert.equal(found(ev).length, 1);
  for (const p of Lens.PROFILES) assert.ok(Lens.profile(p).checks.includes("browser_check_not_in_test"), p);
});
