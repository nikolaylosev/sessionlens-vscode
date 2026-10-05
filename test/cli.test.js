"use strict";
/* cli.js (phase 3, step 3.8): how a .cmd/.bat CLI is started through cmd.exe, and the system prompt file. The
   command line is built by a pure function, so it is checked here on any OS; the real Windows run is the win32-only test at
   the end (it runs in CI on windows-latest). */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { root } = require("./helpers");
const cli = require(path.join(root, "cli.js"));

test("needsShell: only .cmd/.bat on Windows", () => {
  assert.equal(cli.needsShell("C:\\npm\\claude.cmd", true), true);
  assert.equal(cli.needsShell("C:\\npm\\CLAUDE.BAT", true), true);
  assert.equal(cli.needsShell("C:\\x\\claude.exe", true), false);
  assert.equal(cli.needsShell("/usr/bin/claude.cmd", false), false);
});

test('buildWinCommand: plain double quotes, never \\"; the arguments runClaude really passes are accepted', () => {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--no-session-persistence",
    "--tools",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--system-prompt-file",
    cli.SYSTEM_FILE,
    "--model",
    "sonnet[1m]",
  ];
  const cmd = cli.buildWinCommand("C:\\Users\\Никита Иванов\\AppData\\Roaming\\npm\\claude.cmd", args);
  assert.equal(
    cmd,
    '"C:\\Users\\Никита Иванов\\AppData\\Roaming\\npm\\claude.cmd" "-p" "--output-format" "json" "--no-session-persistence" "--tools" "" "--strict-mcp-config" "--disable-slash-commands" "--system-prompt-file" "system.txt" "--model" "sonnet[1m]"',
  );
  assert.ok(!cmd.includes('\\"'));
  const codex = cli.buildWinCommand("C:\\Program Files (x86)\\codex.cmd", [
    "exec",
    "-",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--model",
    "gpt-5.1-codex",
  ]);
  assert.ok(codex.startsWith('"C:\\Program Files (x86)\\codex.cmd" "exec" "-"'));
});

test("buildWinCommand: anything cmd.exe could read as more than text refuses the whole command", () => {
  for (const bad of ["%PATH%", "a&calc", "a|b", 'a"b', "a^b", "a!b", "a<b", "a>b", "a\nb", "C:\\Users\\100%\\tmp\\system.txt"]) {
    assert.equal(cli.buildWinCommand("C:\\npm\\claude.cmd", ["-p", bad]), null, bad);
  }
  assert.equal(cli.buildWinCommand("C:\\a&b\\claude.cmd", ["-p"]), null);
});

test("runClaude: the system prompt goes in as a relative file name, resolved against the temp cwd", { skip: process.platform === "win32" }, async () => {
  // a stand-in for `claude`: records its arguments and what it finds at the relative path, answers like `claude -p --output-format json`
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sl fake cli Никита ")); // a space and a non-ASCII name, as on Windows
  const bin = path.join(dir, "claude");
  const log = path.join(dir, "log.json");
  fs.writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require("fs"); const a = process.argv.slice(2); const i = a.indexOf("--system-prompt-file");
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ args: a, cwd: process.cwd(), file: i >= 0 ? fs.readFileSync(a[i + 1], "utf8") : null }));
process.stdout.write(JSON.stringify({ result: "ok", total_cost_usd: 0 }));
`,
    { mode: 0o755 },
  );
  try {
    const r = await cli.runClaude({ system: "SYSTEM PROMPT", user: "u", cliPath: bin });
    assert.equal(r.text, "ok");
    const seen = JSON.parse(fs.readFileSync(log, "utf8"));
    const i = seen.args.indexOf("--system-prompt-file");
    assert.equal(seen.args[i + 1], "system.txt");
    assert.equal(seen.file, "SYSTEM PROMPT");
    assert.ok(path.basename(seen.cwd).startsWith("sessionlens-cli-"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Phase 7 (7B.1): a real run through cmd.exe, from a folder whose path has a space and a non-ASCII user name — the case
// buildWinCommand exists for. Runs only on Windows (CI: windows-latest).
test("runClaude on Windows: a .cmd CLI in a folder with a space and a non-ASCII name", { skip: process.platform !== "win32" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sl cli Никита "));
  const js = path.join(dir, "fake.js"),
    log = path.join(dir, "log.json"),
    bin = path.join(dir, "claude.cmd");
  fs.writeFileSync(
    js,
    `const fs = require("fs"); const a = process.argv.slice(2); const i = a.indexOf("--system-prompt-file");
let input = ""; process.stdin.on("data", (d) => { input += d; }); process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ args: a, file: i >= 0 ? fs.readFileSync(a[i + 1], "utf8") : null, input }));
  process.stdout.write(JSON.stringify({ result: "ok", total_cost_usd: 0 }));
});
`,
  );
  fs.writeFileSync(bin, `@"${process.execPath}" "%~dp0fake.js" %*\r\n`);
  try {
    const r = await cli.runClaude({ system: "SYSTEM PROMPT", user: "user text", cliPath: bin });
    assert.deepEqual(r.error, undefined, JSON.stringify(r.error));
    assert.equal(r.text, "ok");
    const seen = JSON.parse(fs.readFileSync(log, "utf8"));
    assert.equal(seen.args[seen.args.indexOf("--system-prompt-file") + 1], "system.txt");
    assert.equal(seen.file, "SYSTEM PROMPT");
    assert.equal(seen.input, "user text");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- Cursor Agent CLI (0.1.121) ----------
const crypto = require("crypto");

/* A stand-in for `agent`, with a fake home: records its arguments, cwd, stdin and the permissions file it finds, leaves
   the copy Cursor keeps (CLI 2026.10.01: ~/.cursor/chats/<md5 of cwd>/<id>/ and ~/.cursor/projects/<cwd slug>/), and
   answers like `agent -p --output-format json`, or fails like it (exit 1, one line on stderr). */
function fakeCursor({ stderr = "", code = 0, traces = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sl fake cursor Никита "));
  const home = path.join(dir, "home"),
    bin = path.join(dir, "agent"),
    log = path.join(dir, "log.json");
  fs.writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require("fs"), path = require("path"), crypto = require("crypto");
let input = ""; process.stdin.on("data", (d) => { input += d; }); process.stdin.on("end", () => {
  const cwd = fs.realpathSync(process.cwd()), perm = path.join(cwd, ".cursor", "cli.json");
  fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), cwd, input, perm: fs.existsSync(perm) ? JSON.parse(fs.readFileSync(perm, "utf8")) : null }));
  if (${traces}) {
    const chat = path.join(${JSON.stringify(home)}, ".cursor", "chats", crypto.createHash("md5").update(cwd).digest("hex"), "chat-1");
    fs.mkdirSync(chat, { recursive: true }); fs.writeFileSync(path.join(chat, "meta.json"), JSON.stringify({ cwd }));
    const proj = path.join(${JSON.stringify(home)}, ".cursor", "projects", cwd.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-/, ""), "agent-transcripts", "chat-1");
    fs.mkdirSync(proj, { recursive: true }); fs.writeFileSync(path.join(proj, "chat-1.jsonl"), input);
  }
  if (${code}) { process.stderr.write(${JSON.stringify(stderr)}); process.exit(${code}); }
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "chat-1" }));
});
`,
    { mode: 0o755 },
  );
  // someone else's chat and project, which must stay
  fs.mkdirSync(path.join(home, ".cursor", "chats", "0123456789abcdef0123456789abcdef", "other"), { recursive: true });
  fs.mkdirSync(path.join(home, ".cursor", "projects", "Users-me-shop", "agent-transcripts"), { recursive: true });
  return { dir, home, bin, log };
}
const listCursor = (home) =>
  ["chats", "projects"].flatMap((d) => {
    try {
      return fs.readdirSync(path.join(home, ".cursor", d)).map((n) => `${d}/${n}`);
    } catch {
      return [];
    }
  });

test(
  "runCursor: prompt on stdin, read-only ask mode, every tool denied in the temp folder, Cursor's copy removed",
  { skip: process.platform === "win32" },
  async () => {
    const f = fakeCursor();
    try {
      const r = await cli.runCursor({ system: "SYSTEM", user: "user text", model: "gpt-5.2", cliPath: f.bin, home: f.home });
      assert.deepEqual([r.text, r.costUsd, r.traces], ["ok", null, "removed"]);
      const seen = JSON.parse(fs.readFileSync(f.log, "utf8"));
      assert.deepEqual(seen.args, ["-p", "--output-format", "json", "--mode", "ask", "--trust", "--model", "gpt-5.2"], "no prompt argument");
      assert.equal(seen.input, "SYSTEM\n\nuser text");
      assert.deepEqual(seen.perm, cli.CURSOR_PERMISSIONS);
      assert.deepEqual(seen.perm.permissions.deny, ["Shell(*)", "Write(**)", "Read(**)", "WebFetch(*)", "Mcp(*:*)"]);
      assert.ok(path.basename(seen.cwd).startsWith("sessionlens-cursor-"));
      assert.ok(!fs.existsSync(seen.cwd), "the temp folder is gone");
      assert.deepEqual(listCursor(f.home).sort(), ["chats/0123456789abcdef0123456789abcdef", "projects/Users-me-shop"], "only this run's copy is removed");
    } finally {
      fs.rmSync(f.dir, { recursive: true, force: true });
    }
  },
);

test("runCursor: a failure is a line on stderr, worded per code; the copy is removed after a failure too", { skip: process.platform === "win32" }, async () => {
  for (const [stderr, code] of [
    ["Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.", "auth"],
    ["Cannot use this model: no-such-model. Available models: auto, gpt-5.2", "model"],
    ["something else broke", "failed"],
  ]) {
    const f = fakeCursor({ stderr, code: 1 });
    try {
      const r = await cli.runCursor({ user: "u", cliPath: f.bin, home: f.home });
      assert.equal(r.error.code, code, stderr);
      assert.equal(r.traces, "removed");
    } finally {
      fs.rmSync(f.dir, { recursive: true, force: true });
    }
  }
  const f = fakeCursor({ stderr: "Error: Authentication required.", code: 1, traces: false });
  try {
    assert.equal((await cli.runCursor({ user: "u", cliPath: f.bin, home: f.home })).traces, "none", "nothing written: nothing to remove");
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("removeCursorTraces: a chats folder that also holds a chat of another folder is kept and reported", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sl-cursor-home-"));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "sessionlens-cursor-"));
  try {
    const real = fs.realpathSync(ws);
    const chats = path.join(home, ".cursor", "chats", crypto.createHash("md5").update(real).digest("hex"));
    for (const [id, cwd] of [
      ["mine", real],
      ["theirs", "/Users/me/shop"],
    ]) {
      fs.mkdirSync(path.join(chats, id), { recursive: true });
      fs.writeFileSync(path.join(chats, id, "meta.json"), JSON.stringify({ cwd }));
    }
    assert.equal(cli.removeCursorTraces(ws, home), "failed");
    assert.ok(fs.existsSync(path.join(chats, "theirs")));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("checkCursor: `agent status` exits 0 signed in or not, so its text decides", { skip: process.platform === "win32" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sl-fake-agent-"));
  const bin = path.join(dir, "agent");
  const write = (status) =>
    fs.writeFileSync(
      bin,
      `#!${process.execPath}
process.stdout.write(process.argv[2] === "--version" ? "2026.10.01-e373342\\n" : ${JSON.stringify(status)}); process.exit(0);
`,
      { mode: 0o755 },
    );
  try {
    write("\u001b[32m✓\u001b[0m Logged in as qa@example.com\n");
    let r = await cli.checkCursor({ cliPath: bin });
    assert.deepEqual([r.installed, r.version, r.loggedIn, r.account], [true, "2026.10.01", true, "qa@example.com"]);
    write("Not logged in\n");
    r = await cli.checkCursor({ cliPath: bin });
    assert.deepEqual([r.installed, r.loggedIn, r.account], [true, false, ""]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("buildWinCommand: the arguments runCursor passes are accepted", () => {
  const cmd = cli.buildWinCommand("C:\\Users\\Никита Иванов\\AppData\\Local\\cursor-agent\\agent.cmd", [
    "-p",
    "--output-format",
    "json",
    "--mode",
    "ask",
    "--trust",
    "--model",
    "gpt-5.2",
  ]);
  assert.ok(cmd && cmd.endsWith('"--mode" "ask" "--trust" "--model" "gpt-5.2"'), cmd);
});
