// @ts-check
"use strict";
/* Runs the user's own, unmodified Claude Code (`claude -p`) so SessionLens can use a Claude subscription
   instead of an API key. Host side only: a webview cannot start processes.

   What this deliberately does NOT do: read, copy or forward any credential. The CLI signs itself in with
   whatever the user logged in with (`claude auth login`); this module only hands it a prompt on stdin and
   reads the answer from stdout.

   Safety of what it does run:
   - `--tools ""` removes every built-in tool, so a transcript that says "run rm -rf" (prompt injection) has
     nothing to run it with; `--strict-mcp-config` with no config removes MCP tools; `--disable-slash-commands`
     removes skills.
   - The working directory is a fresh, empty temp folder, so no project CLAUDE.md, .mcp.json or hooks are found.
   - `--no-session-persistence` keeps the reviewed transcript out of Claude Code's session history.
   - `--bare` is NOT used: bare mode never reads the subscription login. */

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const IS_WIN = process.platform === "win32";
const MODEL_RX = /^[A-Za-z0-9][A-Za-z0-9._:\-\[\]]{0,80}$/; // alias (sonnet) or full name (claude-sonnet-5)
const PATH_RX = /^[\p{L}\p{N}_\s.:\\/()\-~@+]+$/u; // letters of any script; no quotes, %, &, |, <, >, ^ : the path may reach a shell on Windows
const MAX_STDIN = 9.5 * 1024 * 1024; // Claude Code caps piped stdin at 10 MB
const DEFAULT_TIMEOUT = 300000;
const SYSTEM_FILE = "system.txt";

/* GUI-launched editors often have a shorter PATH than a terminal, so `claude` installed in ~/.local/bin is
   "not found" even though it works in a shell. Try the usual install locations before giving up. */
function candidates() {
  const home = os.homedir();
  const exe = IS_WIN ? ["claude.exe", "claude.cmd"] : ["claude"];
  const dirs = IS_WIN
    ? [path.join(home, ".local", "bin"), path.join(process.env.APPDATA || "", "npm"), path.join(process.env.LOCALAPPDATA || "", "Programs", "claude")]
    : [path.join(home, ".local", "bin"), path.join(home, ".claude", "local"), "/opt/homebrew/bin", "/usr/local/bin", path.join(home, ".npm-global", "bin")];
  return dirs.flatMap((d) => exe.map((e) => path.join(d, e)));
}
function resolveCli(cliPath) {
  const given = String(cliPath || "").trim();
  if (given) return given;
  for (const c of candidates()) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* keep looking */
    }
  }
  return "claude"; // fall back to PATH
}
// Same idea, for the Codex CLI — same install locations, since both are typically `npm install -g`'d.
function codexCandidates() {
  const home = os.homedir();
  const exe = IS_WIN ? ["codex.exe", "codex.cmd"] : ["codex"];
  const dirs = IS_WIN
    ? [path.join(home, ".local", "bin"), path.join(process.env.APPDATA || "", "npm"), path.join(process.env.LOCALAPPDATA || "", "Programs", "codex")]
    : [path.join(home, ".local", "bin"), path.join(home, ".codex", "local"), "/opt/homebrew/bin", "/usr/local/bin", path.join(home, ".npm-global", "bin")];
  return [...dirs.flatMap((d) => exe.map((e) => path.join(d, e))), ...codexExtensionCandidates()];
}
/* Most people only have the "Codex" VS Code extension (id openai.chatgpt), not the standalone CLI — the
   extension never puts `codex` on PATH at all, it just runs its own bundled copy from inside its own
   extension folder, at <extension-dir>/bin/<platform>/codex[.exe] (platform folder names look like
   "windows-x86_64", "linux-x86_64", "darwin-arm64" — read whatever is actually there rather than guessing
   one). It shares login state with the standalone CLI (both use ~/.codex), so this bundled copy works the
   same way once found. Covers desktop VS Code (~/.vscode) and the remote/WSL/SSH/Dev-Container case
   (~/.vscode-server, ~/.vscode-server-insiders), where the extension itself also runs remotely. */
function codexExtensionCandidates() {
  const home = os.homedir();
  const roots = [".vscode", ".vscode-server", ".vscode-server-insiders", ".cursor", ".cursor-server"].map((d) => path.join(home, d, "extensions"));
  const out = [];
  for (const root of roots) {
    let names;
    try {
      names = fs.readdirSync(root);
    } catch {
      continue;
    }
    // newest-looking folder name first ("openai.chatgpt-26.527.31454-..." sorts higher than "...-26.323...")
    for (const name of names
      .filter((n) => n.startsWith("openai.chatgpt-"))
      .sort()
      .reverse()) {
      const binDir = path.join(root, name, "bin");
      let plats;
      try {
        plats = fs.readdirSync(binDir);
      } catch {
        continue;
      }
      for (const p of plats) {
        out.push(path.join(binDir, p, "codex"));
        out.push(path.join(binDir, p, "codex.exe"));
      }
    }
  }
  return out;
}
function resolveCodexCli(cliPath) {
  const given = String(cliPath || "").trim();
  if (given) return given;
  for (const c of codexCandidates()) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* keep looking */
    }
  }
  return "codex";
}
/* The Cursor Agent CLI: its installer (curl https://cursor.com/install) puts `agent` and `cursor-agent` into
   ~/.local/bin. The Windows location is the installer's documented folder, not checked on a real machine. The PATH
   fallback is the specific name: another program called `agent` must never get the prompt. */
function cursorCandidates() {
  const home = os.homedir();
  const exe = IS_WIN ? ["agent.cmd", "agent.exe", "cursor-agent.cmd", "cursor-agent.exe"] : ["agent", "cursor-agent"];
  const dirs = IS_WIN ? [path.join(process.env.LOCALAPPDATA || "", "cursor-agent"), path.join(home, ".local", "bin")] : [path.join(home, ".local", "bin")];
  return dirs.flatMap((d) => exe.map((e) => path.join(d, e)));
}
function resolveCursorCli(cliPath) {
  const given = String(cliPath || "").trim();
  if (given) return given;
  for (const c of cursorCandidates()) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* keep looking */
    }
  }
  return "cursor-agent";
}

/* Windows can start .exe directly, but .cmd/.bat (npm installs) need cmd.exe: since Node 18.20.2/20.12.2
   (CVE-2024-27980) spawning them without a shell fails with EINVAL. cmd.exe has no escape for a double quote inside
   quotes, and it expands %VAR% even inside them, so instead of escaping anything, every argument and the program
   path must consist of harmless characters only; otherwise nothing is started. None of the arguments built here
   needs more: the model name passes MODEL_RX, the system prompt goes in as a relative file name (see runClaude),
   the rest are constants. */
const needsShell = (bin, win = IS_WIN) => win && /\.(?:cmd|bat)$/i.test(bin);
const WIN_SAFE_RX = /^[\p{L}\p{N}_.:\\/@+\-\[\]() ~]*$/u; // no " % ! ^ & | < > or line breaks
/* → the command line for cmd.exe, or null when some argument could be read by cmd.exe as more than text. */
function buildWinCommand(bin, args) {
  for (const a of [bin, ...args]) if (typeof a !== "string" || !WIN_SAFE_RX.test(a)) return null;
  return [bin, ...args].map((a) => `"${a}"`).join(" ");
}
function launch(bin, args, opts) {
  if (needsShell(bin)) {
    const cmd = buildWinCommand(bin, args);
    if (cmd == null) throw Object.assign(new Error("refusing to pass an argument with shell characters to cmd.exe"), { code: "EUNSAFE" });
    return spawn(cmd, Object.assign({ shell: true, windowsHide: true }, opts));
  }
  return spawn(bin, args, Object.assign({ windowsHide: true }, opts));
}
function killTree(child) {
  try {
    if (IS_WIN && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    else child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}

function classify(text) {
  const t = String(text || "");
  if (
    /not logged in|please run \/login|\/login|invalid api key|authentication[_ ]?(?:failed|error|required)|oauth token|token has expired|unauthorized|\b401\b/i.test(
      t,
    )
  )
    return "auth";
  if (/usage limit|limit reached|out of (?:extra )?usage|rate.?limit|\b429\b|quota|credit balance|resets? (?:at|in)/i.test(t)) return "limit";
  if (/overloaded|\b529\b/i.test(t)) return "overloaded";
  if (
    /issue with the selected model|may not exist or you may not have access|model[^\n]{0,60}(?:not found|not available|invalid|unknown|does not exist)|unknown model|invalid model|cannot use this model/i.test(
      t,
    )
  )
    return "model";
  return "failed";
}
const clean = (s) =>
  String(s || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);

/* One request: prompt in on stdin, answer out. Resolves {text, costUsd, ms} or {error: {code, message}}; never throws. */
/** @param {{ system?: string, user?: string, model?: string, cliPath?: string, timeoutMs?: number }} [opts] */
async function runClaude({ system, user, model, cliPath, timeoutMs } = {}) {
  const started = Date.now();
  if (model && !MODEL_RX.test(String(model))) return { error: { code: "model", message: String(model).slice(0, 60) } };
  const bin = resolveCli(cliPath);
  if (!PATH_RX.test(bin)) return { error: { code: "notfound", message: bin.slice(0, 80) } };
  const stdin = String(user || "");
  if (Buffer.byteLength(stdin, "utf8") > MAX_STDIN) return { error: { code: "toobig", message: "" } };

  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sessionlens-cli-"));
    const args = ["-p", "--output-format", "json", "--no-session-persistence", "--tools", "", "--strict-mcp-config", "--disable-slash-commands"];
    // A relative name, resolved against cwd (the temp folder): the absolute temp path contains the user name, and on
    // Windows it would have to go through cmd.exe (see launch).
    if (system) {
      fs.writeFileSync(path.join(dir, SYSTEM_FILE), String(system), "utf8");
      args.push("--system-prompt-file", SYSTEM_FILE);
    }
    if (model) args.push("--model", String(model));
    return await new Promise((resolve) => {
      let out = "",
        err = "",
        done = false,
        timedOut = false;
      const finish = (v) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(v);
        }
      };
      let child;
      try {
        child = launch(bin, args, { cwd: dir, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
      } catch (e) {
        return finish({ error: { code: e && e.code === "ENOENT" ? "notfound" : "failed", message: clean(e && e.message) } });
      }
      const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT;
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, limit);
      child.stdout.on("data", (d) => {
        out += d;
      });
      child.stderr.on("data", (d) => {
        err += d;
      });
      child.on("error", (/** @type {NodeJS.ErrnoException} */ e) =>
        finish({ error: { code: e && e.code === "ENOENT" ? "notfound" : "failed", message: e && e.code === "ENOENT" ? bin : clean(e && e.message) } }),
      );
      child.on("close", (code) => {
        if (timedOut) return finish({ error: { code: "timeout", message: String(Math.round(limit / 1000)) } });
        let j = null;
        try {
          j = JSON.parse(out.trim());
        } catch {
          /* not JSON: handled below */
        }
        if (j && typeof j === "object") {
          const text = typeof j.result === "string" ? j.result : "";
          if (j.is_error || (code !== 0 && !text)) {
            const m = text || err || out;
            return finish({ error: { code: classify(m), message: clean(m) } });
          }
          return finish({ text, costUsd: typeof j.total_cost_usd === "number" ? j.total_cost_usd : null, ms: Date.now() - started });
        }
        if (code === 0 && out.trim()) return finish({ text: out.trim(), costUsd: null, ms: Date.now() - started }); // an older CLI that printed plain text
        const m = err || out || `exit ${code}`;
        return finish({ error: { code: classify(m), message: clean(m) } });
      });
      child.stdin.on("error", () => {
        /* the process may exit before reading; close handles it */
      });
      child.stdin.end(stdin, "utf8");
    });
  } catch (e) {
    return { error: { code: "failed", message: clean(e && e.message) } };
  } finally {
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* temp dir: best effort */
      }
    }
  }
}

function capture(bin, args, timeout) {
  return new Promise((resolve) => {
    let out = "",
      err = "",
      done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(v);
      }
    };
    let child;
    try {
      child = launch(bin, args, { cwd: os.tmpdir(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return finish({ code: -1, out: "", err: String(e && e.message), missing: !!(e && e.code === "ENOENT") });
    }
    const timer = setTimeout(() => {
      killTree(child);
      finish({ code: -1, out, err: "timeout" });
    }, timeout);
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.on("error", (/** @type {NodeJS.ErrnoException} */ e) =>
      finish({ code: -1, out, err: String(e && e.message), missing: !!(e && e.code === "ENOENT") }),
    );
    child.on("close", (code) => finish({ code, out, err }));
  });
}

/* Is Claude Code installed, and is it signed in? `claude auth status` exits 0 when signed in and 1 when not. */
/** @param {{ cliPath?: string }} [opts] */
async function checkClaude({ cliPath } = {}) {
  const bin = resolveCli(cliPath);
  if (!PATH_RX.test(bin)) return { installed: false, cmd: bin.slice(0, 80) };
  const v = await capture(bin, ["--version"], 20000);
  if (v.missing || (v.code !== 0 && !v.out.trim())) return { installed: false, cmd: bin };
  const version = (v.out.match(/\d+\.\d+\.\d+/) || [""])[0];
  const a = await capture(bin, ["auth", "status"], 20000);
  let info = null;
  try {
    info = JSON.parse(a.out);
  } catch {
    /* text output: only the exit code is used */
  }
  const pick = (...keys) => {
    for (const k of keys) if (info && typeof info[k] === "string" && info[k]) return info[k];
    return "";
  };
  return {
    installed: true,
    cmd: bin,
    version,
    loggedIn: a.code === 0,
    account: pick("email", "account", "user"),
    plan: pick("subscriptionType", "plan", "subscription"),
    apiKeyEnv: !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN), // Claude Code would bill that key, not the subscription
  };
}

/* Runs the user's own, unmodified Codex CLI (`codex exec -`) so SessionLens can use a ChatGPT/Codex
   subscription instead of an API key. Same intent and same safety posture as runClaude() above:

   - The prompt goes in on stdin, via the literal "-" argument. Codex exec also reads stdin when a prompt is
     given as a plain argument on some versions, which has caused hangs when stdin is an open, non-TTY pipe
     (as it always is here); "-" is the documented, unambiguous "read the whole prompt from stdin" form.
   - Codex exec has no separate system-prompt mechanism, so system and user text are simply concatenated.
   - `--sandbox read-only` and a fresh, empty temp folder as cwd mean a prompt-injected "run rm -rf" (or any
     other command) has nothing to run it with and nothing of the user's to touch, mirroring Claude Code's
     `--tools ""`. `--skip-git-repo-check` avoids a repo-ness check the temp folder would otherwise fail.
   - `--ephemeral` keeps the reviewed transcript out of Codex's own session history, like Claude's
     `--no-session-persistence`.
   - `--json` streams the turn as JSONL; the answer is the text of the completed `agent_message` item(s). */
/** @param {{ system?: string, user?: string, model?: string, cliPath?: string, timeoutMs?: number }} [opts] */
async function runCodex({ system, user, model, cliPath, timeoutMs } = {}) {
  const started = Date.now();
  if (model && !MODEL_RX.test(String(model))) return { error: { code: "model", message: String(model).slice(0, 60) } };
  const bin = resolveCodexCli(cliPath);
  if (!PATH_RX.test(bin)) return { error: { code: "notfound", message: bin.slice(0, 80) } };
  const prompt = system ? `${system}\n\n${user || ""}` : String(user || "");
  if (Buffer.byteLength(prompt, "utf8") > MAX_STDIN) return { error: { code: "toobig", message: "" } };

  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sessionlens-codex-"));
    const args = ["exec", "-", "--json", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only"];
    if (model) args.push("--model", String(model));
    return await new Promise((resolve) => {
      let out = "",
        err = "",
        done = false,
        timedOut = false;
      const finish = (v) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(v);
        }
      };
      let child;
      try {
        child = launch(bin, args, { cwd: dir, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
      } catch (e) {
        return finish({ error: { code: e && e.code === "ENOENT" ? "notfound" : "failed", message: clean(e && e.message) } });
      }
      const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT;
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, limit);
      child.stdout.on("data", (d) => {
        out += d;
      });
      child.stderr.on("data", (d) => {
        err += d;
      });
      child.on("error", (/** @type {NodeJS.ErrnoException} */ e) =>
        finish({ error: { code: e && e.code === "ENOENT" ? "notfound" : "failed", message: e && e.code === "ENOENT" ? bin : clean(e && e.message) } }),
      );
      child.on("close", (code) => {
        if (timedOut) return finish({ error: { code: "timeout", message: String(Math.round(limit / 1000)) } });
        const parts = [];
        let failMsg = null;
        for (const line of out.split("\n")) {
          if (!line.trim()) continue;
          let ev;
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          if (ev.type === "item.completed" && ev.item && ev.item.type === "agent_message" && typeof ev.item.text === "string") parts.push(ev.item.text);
          else if (ev.type === "turn.failed") failMsg = (ev.error && (ev.error.message || ev.error.code)) || ev.message || "turn failed";
        }
        const text = parts.join("\n\n").trim();
        if (failMsg && !text) return finish({ error: { code: classify(failMsg), message: clean(failMsg) } });
        if (!text) {
          const m = err || out || `exit ${code}`;
          return finish({ error: { code: classify(m), message: clean(m) } });
        }
        return finish({ text, costUsd: null, ms: Date.now() - started });
      });
      child.stdin.on("error", () => {
        /* the process may exit before reading; close handles it */
      });
      child.stdin.end(prompt, "utf8");
    });
  } catch (e) {
    return { error: { code: "failed", message: clean(e && e.message) } };
  } finally {
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* temp dir: best effort */
      }
    }
  }
}

/* Is the Codex CLI installed, and is it signed in? `codex login status` exits 0 when signed in and prints
   which method (ChatGPT / API key); there is no documented --json form for it, so the raw line is shown
   as-is rather than guessed apart into fields. */
/** @param {{ cliPath?: string }} [opts] */
async function checkCodex({ cliPath } = {}) {
  const bin = resolveCodexCli(cliPath);
  if (!PATH_RX.test(bin)) return { installed: false, cmd: bin.slice(0, 80) };
  const v = await capture(bin, ["--version"], 20000);
  if (v.missing || (v.code !== 0 && !v.out.trim())) return { installed: false, cmd: bin };
  const version = (v.out.match(/\d+\.\d+\.\d+/) || [""])[0];
  const a = await capture(bin, ["login", "status"], 20000);
  return {
    installed: true,
    cmd: bin,
    version,
    loggedIn: a.code === 0,
    account: clean(a.out || a.err),
    plan: "",
    apiKeyEnv: !!(process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY), // Codex may then bill that key, not the subscription
  };
}

/* Runs the user's own Cursor Agent CLI (`agent -p`) so SessionLens can use a Cursor plan instead of an API key.
   Checked by hand on CLI 2026.10.01 (macOS):

   - The prompt goes in on stdin with no prompt argument; a 200 KB prompt arrived whole. System and user text are
     concatenated, as for Codex.
   - There is no "no tools" flag: `--print` "has access to all tools, including write and shell". `--mode ask` alone
     still read a file outside the workspace by its absolute path and ran `ls` there. So the fresh, empty temp folder
     also gets a .cursor/cli.json that denies Shell, Write, Read, WebFetch and MCP (a deny wins over any allow in the
     user's global config); with it, both were refused. `--trust` skips the trust prompt for that folder.
   - On failure there is no JSON: exit 1 and a line on stderr ("Authentication required…", "Cannot use this model…").
   - Cursor keeps every chat and has no flag against it, so its copy is removed after the run (removeCursorTraces). */
const CURSOR_PERMISSIONS = { permissions: { allow: [], deny: ["Shell(*)", "Write(**)", "Read(**)", "WebFetch(*)", "Mcp(*:*)"] } };

/* Where Cursor keeps a chat (CLI 2026.10.01): the full prompt under ~/.cursor/projects/<the workspace path as a
   slug>/agent-transcripts/, the chat under ~/.cursor/chats/<md5 of the workspace path>/<chat id>/. The workspace is
   this run's own temp folder with a random name, so both are found by that folder alone and removed whole; nothing
   else in ~/.cursor is touched. A chats folder is removed only when every chat in it names that folder as its cwd.
   → "removed" | "none" (nothing where it was expected: Cursor may have moved it) | "failed" */
function removeCursorTraces(dir, home = os.homedir()) {
  const base = path.join(home, ".cursor");
  const paths = new Set([dir]);
  try {
    paths.add(fs.realpathSync(dir)); // macOS: /var/folders/… is /private/var/folders/…, and Cursor uses the real path
  } catch {
    /* already gone: the given path only */
  }
  let removed = 0,
    failed = 0;
  const rm = (p) => {
    try {
      fs.rmSync(p, { recursive: true, force: true });
      removed++;
    } catch {
      failed++;
    }
  };
  for (const p of paths) {
    const chats = path.join(base, "chats", crypto.createHash("md5").update(p, "utf8").digest("hex"));
    let ids;
    try {
      ids = fs.readdirSync(chats);
    } catch {
      continue;
    }
    const ours = ids.every((id) => {
      try {
        return paths.has(JSON.parse(fs.readFileSync(path.join(chats, id, "meta.json"), "utf8")).cwd);
      } catch {
        return false;
      }
    });
    if (ours) rm(chats);
    else failed++;
  }
  const tail = path.basename(dir);
  let names = [];
  try {
    names = fs.readdirSync(path.join(base, "projects"));
  } catch {
    /* no projects folder */
  }
  for (const n of names) if (n.endsWith(tail)) rm(path.join(base, "projects", n));
  return failed ? "failed" : removed ? "removed" : "none";
}

/* One request, as runClaude: resolves {text, costUsd, ms, traces} or {error: {code, message}, traces}; never throws.
   traces is what removeCursorTraces() did. `home` is for tests. */
/** @param {{ system?: string, user?: string, model?: string, cliPath?: string, timeoutMs?: number, home?: string }} [opts] */
async function runCursor({ system, user, model, cliPath, timeoutMs, home } = {}) {
  const started = Date.now();
  if (model && !MODEL_RX.test(String(model))) return { error: { code: "model", message: String(model).slice(0, 60) } };
  const bin = resolveCursorCli(cliPath);
  if (!PATH_RX.test(bin)) return { error: { code: "notfound", message: bin.slice(0, 80) } };
  const prompt = system ? `${system}\n\n${user || ""}` : String(user || "");
  if (Buffer.byteLength(prompt, "utf8") > MAX_STDIN) return { error: { code: "toobig", message: "" } };

  let dir, result;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sessionlens-cursor-"));
    fs.mkdirSync(path.join(dir, ".cursor"));
    fs.writeFileSync(path.join(dir, ".cursor", "cli.json"), JSON.stringify(CURSOR_PERMISSIONS), "utf8");
    const args = ["-p", "--output-format", "json", "--mode", "ask", "--trust"];
    if (model) args.push("--model", String(model));
    result = await new Promise((resolve) => {
      let out = "",
        err = "",
        done = false,
        timedOut = false;
      const finish = (v) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(v);
        }
      };
      let child;
      try {
        child = launch(bin, args, { cwd: dir, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
      } catch (e) {
        return finish({ error: { code: e && e.code === "ENOENT" ? "notfound" : "failed", message: clean(e && e.message) } });
      }
      const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT;
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, limit);
      child.stdout.on("data", (d) => {
        out += d;
      });
      child.stderr.on("data", (d) => {
        err += d;
      });
      child.on("error", (/** @type {NodeJS.ErrnoException} */ e) =>
        finish({ error: { code: e && e.code === "ENOENT" ? "notfound" : "failed", message: e && e.code === "ENOENT" ? bin : clean(e && e.message) } }),
      );
      child.on("close", (code) => {
        if (timedOut) return finish({ error: { code: "timeout", message: String(Math.round(limit / 1000)) } });
        let j = null;
        try {
          j = JSON.parse(out.trim());
        } catch {
          /* not JSON: a failure, handled below */
        }
        if (j && typeof j === "object") {
          const text = typeof j.result === "string" ? j.result : "";
          if (j.is_error || (code !== 0 && !text)) {
            const m = text || err || out;
            return finish({ error: { code: classify(m), message: clean(m) } });
          }
          return finish({ text, costUsd: null, ms: Date.now() - started });
        }
        const m = err || out || `exit ${code}`;
        return finish({ error: { code: classify(m), message: clean(m) } });
      });
      child.stdin.on("error", () => {
        /* the process may exit before reading; close handles it */
      });
      child.stdin.end(prompt, "utf8");
    });
  } catch (e) {
    result = { error: { code: "failed", message: clean(e && e.message) } };
  } finally {
    if (dir) {
      const traces = removeCursorTraces(dir, home);
      result = Object.assign({}, result, { traces });
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* temp dir: best effort */
      }
    }
  }
  return result;
}

/* Is the Cursor Agent CLI installed, and is it signed in? `agent status` exits 0 either way (CLI 2026.10.01) and
   prints "Logged in as <account>" or "Not logged in", so the text decides. */
/** @param {{ cliPath?: string }} [opts] */
async function checkCursor({ cliPath } = {}) {
  const bin = resolveCursorCli(cliPath);
  if (!PATH_RX.test(bin)) return { installed: false, cmd: bin.slice(0, 80) };
  const v = await capture(bin, ["--version"], 20000);
  if (v.missing || (v.code !== 0 && !v.out.trim())) return { installed: false, cmd: bin };
  const version = (v.out.match(/\d+\.\d+\.\d+/) || [""])[0];
  const a = await capture(bin, ["status"], 20000);
  const text = String(a.out + "\n" + a.err).replace(/\x1b\[[0-9;]*m/g, ""); // eslint-disable-line no-control-regex
  const m = /\blogged in as\s+(\S+)/i.exec(text);
  return {
    installed: true,
    cmd: bin,
    version,
    loggedIn: !!m && !/not logged in/i.test(text),
    account: m ? clean(m[1]) : "",
    plan: "",
    apiKeyEnv: !!process.env.CURSOR_API_KEY, // the CLI then signs in with that key, which may be another account
  };
}

module.exports = {
  runClaude,
  checkClaude,
  runCodex,
  checkCodex,
  runCursor,
  checkCursor,
  removeCursorTraces,
  resolveCli,
  resolveCodexCli,
  resolveCursorCli,
  CURSOR_PERMISSIONS,
  classify,
  MODEL_RX,
  buildWinCommand,
  needsShell,
  SYSTEM_FILE,
  PATH_RX,
};
