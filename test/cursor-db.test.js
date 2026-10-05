"use strict";
/* cursor-db.js (0.1.121): the output of a Cursor Agent session's commands, from Cursor's own databases, built here in a
   temporary home with node:sqlite in the shape checked on the IDE and CLI 2026.10.01. What is checked: the CLI's
   store.db (messages in the order of the root blob, results matched by toolCallId, the exit code) and the IDE's
   state.vscdb (bubbles in the composer's order, exitCode absent when 0); a database opened read-only and left as it
   was; and no output, with a reason, for another file name, no node:sqlite, an unknown format or a chat not there. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { root } = require("./helpers");
const { cursorOutputs, transcriptId, ideDatabase } = require(path.join(root, "cursor-db.js"));
const { S, home, transcript, cliDb, shell, result, ideDb, terminal } = require("./cursor-fixtures");

const skip = !S && "node:sqlite is not available";

test("the CLI's store.db: Shell calls in the root blob's order, each with its result and exit code", { skip }, () => {
  const h = home();
  try {
    const file = cliDb(h, [
      { role: "user", content: [{ type: "text", text: "Write tests" }] },
      shell("c1", "npx playwright test"),
      result("c1", "Exit code: 1\n\nCommand output:\n```\n  1 failed\n  12 passed (55.0s)\n```"),
      {
        role: "assistant",
        content: [
          { type: "text", text: "Fixing it." },
          { type: "tool-call", toolCallId: "r1", toolName: "Read", args: { path: "a.ts" } },
        ],
      },
      shell("c2", "npx playwright test"),
      result("c2", "Exit code: 0\n\nCommand output:\n```\n  13 passed (54.1s)\n```"),
    ]);
    const before = fs.readFileSync(file);
    const r = cursorOutputs(transcript(h), { home: h, platform: "darwin", env: {} });
    assert.equal(r.source, "cli");
    assert.deepEqual(
      r.outputs.map((o) => [o.command, o.exitCode, /\d+ passed/.exec(o.output)[0]]),
      [
        ["npx playwright test", 1, "12 passed"],
        ["npx playwright test", 0, "13 passed"],
      ],
    );
    assert.deepEqual(fs.readFileSync(file), before, "opened read-only, left as it was");
  } finally {
    fs.rmSync(h, { recursive: true, force: true });
  }
});

test("the IDE's state.vscdb: terminal calls in the composer's order; no exitCode means 0", { skip }, () => {
  const h = home();
  try {
    ideDb(h, [
      { type: 1, text: "Write tests" },
      terminal("npx playwright test", "  1 failed\n  12 passed", 1),
      { toolFormerData: { name: "read_file_v2", params: JSON.stringify({ path: "a.ts" }), result: "{}" } },
      terminal("npx playwright test", "  13 passed"),
    ]);
    const r = cursorOutputs(transcript(h), { home: h, platform: "darwin", env: {} });
    assert.equal(r.source, "ide");
    assert.deepEqual(
      r.outputs.map((o) => [o.command, o.exitCode, o.output.trim()]),
      [
        ["npx playwright test", 1, "1 failed\n  12 passed"],
        ["npx playwright test", 0, "13 passed"],
      ],
    );
  } finally {
    fs.rmSync(h, { recursive: true, force: true });
  }
});

test("where the IDE keeps its database, per platform", () => {
  const h = path.join(path.sep, "h");
  assert.equal(ideDatabase(h, "darwin", {}), path.join(h, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb"));
  assert.equal(ideDatabase(h, "linux", {}), path.join(h, ".config", "Cursor", "User", "globalStorage", "state.vscdb"));
  assert.equal(ideDatabase(h, "win32", { APPDATA: path.join(h, "AD") }), path.join(h, "AD", "Cursor", "User", "globalStorage", "state.vscdb"));
});

test("no output, with a reason: another file name, no node:sqlite, an unknown format, a chat not there", { skip }, () => {
  const h = home();
  try {
    assert.equal(transcriptId(path.join(h, "notes.jsonl")), null);
    assert.deepEqual(cursorOutputs(path.join(h, "notes.jsonl"), { home: h }), { outputs: null, reason: "not a Cursor transcript name" });
    assert.deepEqual(cursorOutputs(transcript(h), { home: h, sqliteModule: null }), { outputs: null, reason: "node:sqlite is not available" });
    assert.deepEqual(cursorOutputs(transcript(h), { home: h, platform: "darwin", env: {} }), { outputs: null, reason: "no Cursor database has this chat" });
    cliDb(h, [shell("c1", "npx playwright test"), result("c1", "Exit code: 0")], { root: false });
    assert.equal(cursorOutputs(transcript(h), { home: h, platform: "darwin", env: {} }).outputs, null, "no meta: a format this code does not know");
  } finally {
    fs.rmSync(h, { recursive: true, force: true });
  }
});
