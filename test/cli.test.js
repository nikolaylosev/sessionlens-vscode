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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sl-fake-cli-"));
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
