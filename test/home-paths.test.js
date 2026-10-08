"use strict";
/* 0.1.124: a path in the person's home folder starts with ~ (Lens.homeless, applied to every step's file and command
   by importAny). A file outside the agent's folder kept the user name: the owner's session that ran from
   ~/.claude/skills/my-skill and wrote ~/birdhospital-tests/… showed /Users/<name>/… in its findings and its PR report.
   What must hold: the checks that match a command's path with a file's still match, a session imported before still
   matches its new import, its verdicts move to the new texts, and Import again is offered only where it changes
   something. Made-up content only. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");

const { Lens } = load();
const cfg = Lens.profile("qa-ts");

test("homeless: macOS, Linux and Windows homes at the start of a path; nothing else", () => {
  const h = Lens.homeless;
  assert.equal(h("/Users/me/shop/a.ts"), "~/shop/a.ts");
  assert.equal(h("/home/me/shop/a.ts"), "~/shop/a.ts");
  assert.equal(h("C:\\Users\\me\\shop\\a.ts"), "~\\shop\\a.ts");
  assert.equal(h("C:/Users/me/shop/a.ts"), "~/shop/a.ts");
  assert.equal(h("cd /Users/me/shop && cat '/home/me/x.txt' \"/Users/me/y\""), "cd ~/shop && cat '~/x.txt' \"~/y\"");
  assert.equal(h("/Users/Shared/data/a.ts"), "/Users/Shared/data/a.ts", "not a home");
  assert.equal(h("/srv/Users/me/a.ts"), "/srv/Users/me/a.ts", "not at the start of a path");
  assert.equal(h("/Users/me"), "/Users/me", "the home folder alone stays");
  assert.equal(h("tests/a.spec.ts"), "tests/a.spec.ts");
  assert.equal(h(undefined), undefined);
});

const J = (...recs) => recs.map((r) => JSON.stringify(r)).join("\n");
const PW =
  "import { test, expect } from '@playwright/test';\ntest('total', async ({ page }) => {\n  await expect(page.getByText('Total')).toBeVisible();\n});\n";
// Claude Code started in one folder, working in another under the home folder (the owner's case)
const claude = (home = "/Users/me") =>
  J(
    { type: "user", cwd: home + "/.claude/skills/my-skill", message: { role: "user", content: "Write the cart test" } },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "w", name: "Write", input: { file_path: home + "/shop/tests/cart.spec.ts", content: PW } }],
      },
    },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "w", content: "ok" }] } },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "i", name: "Write", input: { file_path: home + "/.claude/skills/my-skill/notes.md", content: "x" } }],
      },
    },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "i", content: "ok" }] } },
    {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "r", name: "Bash", input: { command: `rm ${home}/shop/tests/cart.spec.ts` } }] },
    },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "r", content: "" }] } },
  );
const steps = (ev) => ev.filter((e) => e.file || e.cmd).map((e) => `${e.kind} ${e.file || e.cmd}`);

test("every format: a file outside the agent's folder and a command start with ~; one inside stays relative", () => {
  assert.deepEqual(steps(Lens.importAny(claude(), cfg)), ["write ~/shop/tests/cart.spec.ts", "write notes.md", "run_other rm ~/shop/tests/cart.spec.ts"]);
  const codex = J(
    { timestamp: "2026-10-08T10:00:00Z", type: "session_meta", payload: { cwd: "/home/me/other" } },
    {
      timestamp: "2026-10-08T10:00:01Z",
      type: "event_msg",
      payload: { type: "patch_apply_end", changes: { "/home/me/shop/tests/cart.spec.ts": { type: "add", content: PW } } },
    },
  );
  assert.deepEqual(steps(Lens.importAny(codex, cfg)), ["write ~/shop/tests/cart.spec.ts"]);
  const cursor = J(
    { role: "user", message: { content: [{ type: "text", text: "<user_query>Read it</user_query>" }] } },
    { role: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { path: "/Users/me/shop/src/cart.ts" } }] } },
  );
  assert.deepEqual(steps(Lens.importAny(cursor, cfg)), ["read ~/shop/src/cart.ts"], "a Cursor transcript dropped onto the panel: no folder");
});

test("a test file deleted with rm and its full path is still a deleted test; the finding names it from ~", () => {
  const found = (text) =>
    Lens.runChecks(Lens.importAny(text, cfg), cfg)
      .filter((f) => f.check === "test_deleted")
      .map((f) => f.message);
  const [msg] = found(claude());
  assert.match(msg, /~\/shop\/tests\/cart\.spec\.ts/);
  assert.doesNotMatch(msg, /\/Users\/me/);
  // a session imported before: the file and the command spelled out, as 0.1.123 stored them
  const old = Lens.importAny(claude(), cfg).map((e) =>
    Object.assign({}, e, { file: e.file && e.file.replace("~", "/Users/me"), cmd: e.cmd && e.cmd.replace("~", "/Users/me") }),
  );
  assert.equal(Lens.runChecks(old, cfg).filter((f) => f.check === "test_deleted").length, 1);
  const mixed = old.map((e) => (e.kind === "run_other" ? Object.assign({}, e, { cmd: "rm ~/shop/tests/cart.spec.ts" }) : e));
  assert.equal(Lens.runChecks(mixed, cfg).filter((f) => f.check === "test_deleted").length, 1, "~ in one, the full path in the other");
  // matched, not only seen as some test file: its tests live on in another file, so it was moved, not deleted
  const moved = [
    ...mixed.filter((e) => e.kind !== "run_other"),
    { seq: 90, kind: "write", file: "/Users/me/shop/tests/cart-new.spec.ts", new_content: PW },
    { seq: 91, kind: "run_other", cmd: "rm ~/shop/tests/cart.spec.ts" },
  ];
  assert.deepEqual(
    Lens.runChecks(moved, cfg).filter((f) => f.check === "test_deleted"),
    [],
  );
});

test("a session imported before: its new import matches it, Import again is offered, and its verdicts move to the new texts", () => {
  const fresh = Lens.importAny(claude(), cfg);
  const old = fresh.map((e) => Object.assign({}, e, { file: e.file && e.file.replace(/^~/, "/Users/me"), cmd: e.cmd && e.cmd.replace("~", "/Users/me") }));
  assert.equal(Lens.transcriptMatch(old, fresh), 1, "the same session, not another one");
  const s = { profile: "qa-ts", events: old, importGen: 4 };
  assert.equal(Lens.needsReimport(s), true);
  assert.equal(Lens.needsReimport(Object.assign({}, s, { importGen: Lens.IMPORT_GEN })), false, "imported with this version");
  assert.equal(Lens.needsReimport(Object.assign({}, s, { events: fresh })), false, "nothing to change");
  // a Codex session of 0.1.122 with a moved file: already read the new way, no button (the 0.1.122 check is for older ones)
  assert.equal(Lens.needsReimport({ profile: "qa-ts", events: fresh, importGen: 4, source_text: '{"move_path": "a.ts"}' }), false);

  const before = Lens.runChecks(old, cfg).find((f) => f.check === "test_deleted");
  const session = { events: fresh, findings: Lens.runChecks(fresh, cfg), verdicts: { [Lens.fkey(before)]: { v: "ok", note: "seen" } } };
  assert.equal(Lens.carryVerdicts(session), 1);
  const after = session.findings.find((f) => f.check === "test_deleted");
  assert.notEqual(Lens.fkey(after), Lens.fkey(before), "the text changed");
  assert.equal(session.verdicts[Lens.fkey(after)].note, "seen");
});
