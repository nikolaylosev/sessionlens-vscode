"use strict";
/* Cursor's databases as the IDE and CLI 2026.10.01 keep them, built with node:sqlite in a temporary home: for
   cursor-db.test.js and cursor-panel.test.js. S is null when this Node has no node:sqlite. */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { root } = require("./helpers");
const { ideDatabase } = require(path.join(root, "cursor-db.js"));

let S = null;
try {
  S = require("node:sqlite");
} catch {
  /* the database cases are skipped */
}

const ID = "4e9f8172-3c17-4425-918c-f62e9496e707";
const home = () => fs.mkdtempSync(path.join(os.tmpdir(), "sl-cursor-db-"));
const transcript = (h) => path.join(h, ".cursor", "projects", "Users-me-shop", "agent-transcripts", ID, ID + ".jsonl");
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

// the CLI's store.db: JSON message blobs, a root blob listing their ids as raw bytes, meta "0" as hex JSON
function cliDb(h, messages, { root: withRoot = true } = {}) {
  const dir = path.join(h, ".cursor", "chats", "0123456789abcdef0123456789abcdef", ID);
  fs.mkdirSync(dir, { recursive: true });
  const db = new S.DatabaseSync(path.join(dir, "store.db"));
  db.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);");
  const put = db.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)");
  const blobs = messages.map((m) => Buffer.from(JSON.stringify(m)));
  const ids = blobs.map((data) => sha(data));
  // stored in reverse, so only the root blob gives the order
  for (let i = blobs.length - 1; i >= 0; i--) put.run(ids[i], blobs[i]);
  const rootData = Buffer.concat([Buffer.from([0x0a]), ...ids.map((id) => Buffer.concat([Buffer.from([0x12, 0x20]), Buffer.from(id, "hex")]))]);
  const rootId = sha(rootData);
  db.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)").run(rootId, rootData);
  if (withRoot)
    db.prepare("INSERT INTO meta (key, value) VALUES ('0', ?)").run(
      Buffer.from(JSON.stringify({ agentId: ID, latestRootBlobId: rootId, blobEncryptionKey: "not-read" })).toString("hex"),
    );
  db.close();
  return path.join(dir, "store.db");
}
const shell = (id, command) => ({ role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "Shell", args: { command } }] });
const result = (id, text) => ({ role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "Shell", result: text }] });

// the IDE's state.vscdb: cursorDiskKV with the composer and its bubbles
function ideDb(h, bubbles) {
  const file = ideDatabase(h, "darwin", {});
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new S.DatabaseSync(file);
  db.exec("CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);");
  const put = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
  put.run("composerData:" + ID, JSON.stringify({ fullConversationHeadersOnly: bubbles.map((b, i) => ({ bubbleId: "b" + i, type: 2 })) }));
  bubbles.forEach((b, i) => put.run(`bubbleId:${ID}:b${i}`, JSON.stringify(b)));
  db.close();
  return file;
}
const terminal = (command, output, exitCode) => ({
  toolFormerData: {
    name: "run_terminal_command_v2",
    params: JSON.stringify({ command, cwd: "/w" }),
    result: JSON.stringify(exitCode ? { output, exitCode } : { output }),
  },
});

module.exports = { S, ID, home, transcript, cliDb, shell, result, ideDb, terminal };
