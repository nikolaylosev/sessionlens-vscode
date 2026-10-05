// @ts-check
"use strict";
/* The output of an agent's commands in a Cursor Agent session (0.1.121). Host side only: a webview cannot read files.

   A Cursor transcript (~/.cursor/projects/<workspace>/agent-transcripts/<id>/<id>.jsonl) keeps no command output, but
   Cursor keeps it in its own databases under the same id. Checked on the IDE and CLI 2026.10.01 (Oct 2026):

   - the CLI: ~/.cursor/chats/<md5 of the workspace path>/<id>/store.db. Table `blobs` holds the conversation as JSON
     messages (`assistant` with `tool-call` parts, `tool` with `tool-result` parts, matched by `toolCallId`); a result
     is a string "Exit code: N\n\nCommand output: …". Table `meta`, key "0", is hex JSON whose `latestRootBlobId`
     names a root blob that lists the message blob ids, as raw bytes, in order. `meta` also holds an encryption key,
     which is never read further, logged or copied.
   - the IDE: <Cursor user data>/User/globalStorage/state.vscdb, table `cursorDiskKV`: `composerData:<id>` lists the
     bubbles in order (`fullConversationHeadersOnly`), and `bubbleId:<id>:<bubble>` holds a tool call as
     `toolFormerData` with `name` (`run_terminal_command_v2`), `params` (JSON, `command`) and `result` (JSON, `output`,
     `exitCode` only when it is not 0).

   Both are opened read-only through Node's built-in node:sqlite and closed at once. Without node:sqlite (VS Code
   before Node 22.13), with no database, or with a format this code does not know, there is no output, and the
   session is imported without it, as before. Nothing here writes anywhere. */

const fs = require("fs");
const os = require("os");
const path = require("path");

const ID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_OUTPUT = 200000; // per command; a runner's summary is at the end, so the end is kept

function sqlite() {
  try {
    return require("node:sqlite");
  } catch {
    return null;
  }
}
const asText = (v) => (typeof v === "string" ? v : v instanceof Uint8Array ? Buffer.from(v).toString("utf8") : "");
const parse = (v) => {
  try {
    return JSON.parse(asText(v));
  } catch {
    return null;
  }
};
const tail = (s) => (s.length > MAX_OUTPUT ? s.slice(-MAX_OUTPUT) : s);

// <id>.jsonl in agent-transcripts/<id>/ → the id, else null
function transcriptId(file) {
  const id = path.basename(String(file || ""), ".jsonl");
  return ID_RX.test(id) ? id : null;
}

function ideDatabase(home, platform, env) {
  const user =
    platform === "darwin"
      ? path.join(home, "Library", "Application Support", "Cursor")
      : platform === "win32"
        ? path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "Cursor")
        : path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "Cursor");
  return path.join(user, "User", "globalStorage", "state.vscdb");
}

function cliDatabase(home, id) {
  const chats = path.join(home, ".cursor", "chats");
  let dirs = [];
  try {
    dirs = fs.readdirSync(chats);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const p = path.join(chats, d, id, "store.db");
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/* The CLI's store.db → [{command, output, exitCode}] for its Shell calls, in order; null when the format is not known */
function fromCli(db) {
  const meta = db.prepare("SELECT value FROM meta WHERE key = '0'").get();
  const info = meta ? parse(Buffer.from(asText(meta.value), "hex")) : null;
  const rootId = info && typeof info.latestRootBlobId === "string" ? info.latestRootBlobId : "";
  const blobs = new Map(
    db
      .prepare("SELECT id, data FROM blobs")
      .all()
      .map((r) => [String(r.id), r.data]),
  );
  const root = blobs.get(rootId);
  if (!root) return null;
  const rootBuf = Buffer.from(/** @type {Uint8Array} */ (root));
  const ordered = [];
  for (const [id, data] of blobs) {
    if (!/^[0-9a-f]+$/i.test(id) || id.length % 2) continue;
    const at = rootBuf.indexOf(Buffer.from(id, "hex"));
    if (at < 0) continue;
    const m = parse(data);
    if (m && typeof m === "object" && typeof m.role === "string") ordered.push([at, m]);
  }
  ordered.sort((a, b) => a[0] - b[0]);
  const calls = [],
    results = new Map();
  for (const [, m] of ordered) {
    for (const p of Array.isArray(m.content) ? m.content : []) {
      if (!p || typeof p !== "object") continue;
      if (m.role === "assistant" && p.type === "tool-call" && p.toolName === "Shell") {
        const args = typeof p.args === "string" ? parse(p.args) : p.args || p.input;
        if (args && typeof args.command === "string") calls.push({ id: p.toolCallId, command: args.command });
      } else if (m.role === "tool" && p.type === "tool-result") results.set(p.toolCallId, p.result);
    }
  }
  if (!calls.length) return null;
  return calls.map((c) => {
    const r = results.get(c.id);
    const text = typeof r === "string" ? r : r == null ? "" : JSON.stringify(r);
    const code = /^Exit code:\s*(-?\d+)/.exec(text);
    return { command: c.command, output: tail(text), exitCode: code ? Number(code[1]) : null };
  });
}

/* The IDE's state.vscdb → the same list for the chat with this id; null when the chat or the format is not there */
function fromIde(db, id) {
  const get = (key) => {
    const r = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?").get(key);
    return r ? parse(r.value) : null;
  };
  const composer = get("composerData:" + id);
  const headers = composer && Array.isArray(composer.fullConversationHeadersOnly) ? composer.fullConversationHeadersOnly : null;
  if (!headers) return null;
  const out = [];
  for (const h of headers) {
    if (!h || typeof h.bubbleId !== "string") continue;
    const b = get(`bubbleId:${id}:${h.bubbleId}`);
    const t = b && b.toolFormerData;
    if (!t || t.name !== "run_terminal_command_v2") continue;
    const params = typeof t.params === "string" ? parse(t.params) : t.params;
    const result = typeof t.result === "string" ? parse(t.result) : t.result;
    if (!params || typeof params.command !== "string") continue;
    const output = result && typeof result.output === "string" ? result.output : "";
    out.push({ command: params.command, output: tail(output), exitCode: result && Number.isInteger(result.exitCode) ? result.exitCode : result ? 0 : null });
  }
  return out.length ? out : null;
}

/* For a transcript file picked by the person: the commands Cursor kept for it, or why there are none.
   → { outputs: [{command, output, exitCode}], source: "cli" | "ide" } | { outputs: null, reason }
   The options are for tests: another home, platform or environment, and a stand-in for node:sqlite (null: none). */
/** @param {string} file @param {{ home?: string, platform?: string, env?: Record<string, string | undefined>, sqliteModule?: any }} [opts] */
function cursorOutputs(file, { home = os.homedir(), platform = process.platform, env = process.env, sqliteModule } = {}) {
  const id = transcriptId(file);
  if (!id) return { outputs: null, reason: "not a Cursor transcript name" };
  const S = sqliteModule === undefined ? sqlite() : sqliteModule;
  if (!S || !S.DatabaseSync) return { outputs: null, reason: "node:sqlite is not available" };
  const tries = [
    ["cli", cliDatabase(home, id)],
    ["ide", ideDatabase(home, platform, env)],
  ];
  let reason = "no Cursor database has this chat";
  for (const [source, file] of tries) {
    if (!file || !fs.existsSync(file)) continue;
    let db = null;
    try {
      db = new S.DatabaseSync(file, { readOnly: true });
      const outputs = source === "cli" ? fromCli(db) : fromIde(db, id);
      if (outputs) return { outputs, source };
    } catch (e) {
      reason = `the ${source} database could not be read: ${String((e && e.code) || (e && e.message) || e).slice(0, 80)}`;
    } finally {
      try {
        if (db) db.close();
      } catch {
        /* closed already */
      }
    }
  }
  return { outputs: null, reason };
}

module.exports = { cursorOutputs, transcriptId, ideDatabase, MAX_OUTPUT };
