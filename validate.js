// @ts-check
"use strict";
/* What the host accepts from a webview (phase 3). No require("vscode"): tested directly (test/validate.test.js).

   A webview renders untrusted transcripts, imported JSON and model output, so every message is checked as if an
   attacker had written it. validate(type, payload, ctx) → null when the message may be handled, otherwise an error
   string; the host then replies { error } and does nothing else. Fields a validator does not mention are ignored by
   the handler, never trusted. Paths to programs (cliPath) and provider addresses (baseUrl) are never read from a
   payload at all: the host takes them from its own configuration (see extension.js). */

const path = require("path");

// Exactly the keys app.js store.get() reads (test/validate.test.js compares the two lists). Sessions are not among
// them since phase 4: they live in files and travel through the session:* messages.
const STORAGE_KEYS = [
  "settings",
  "rulesApplied",
  "rulesDismissed",
  "external",
  "ruleOverrides",
  "calibLog",
  "compressResults",
  "skillResults",
  "analysisEpoch",
  "lintRepair",
];
const NUMBER_KEYS = new Set(["analysisEpoch", "lintRepair"]);
const ARRAY_KEYS = new Set(["external", "calibLog", "compressResults", "skillResults"]);
// show(v) in app.js: the tabs of sidepanel.html plus "review"
const TABS = ["sessions", "review", "calib", "rules", "prompts", "settings"];
// log:timing (phase 6): where app.js ran analyze()
const TIMING_EVENTS = ["import", "reanalyze", "background"];
const PROFILE_RX = /^[a-z][a-z0-9#-]{0,30}$/;

const MB = 1024 * 1024;
// A whole message, as JSON. Since phase 4 the largest one is session:put with one session. Kept at 64 MB as an
// outer bound; MAX_SESSION below is the real limit for a session.
const MAX_PAYLOAD = 64 * MB;
// One session as JSON. Not measured on real data: the import keeps source_text only under 400 000 characters, and
// events carry whole files the agent wrote, so a long session is a few MB (the synthetic 1 MB sessions of perf/ are
// on the large side). 32 MB is several times that and still small enough to read and write in one go.
const MAX_SESSION = 32 * MB;
const GEN_RX = /^([0-9a-f]{8})?$/;
const MAX_CLIPBOARD = 10 * MB;
const MAX_FILE = 10 * MB;
const MAX_SKILL_TOTAL = 10 * MB;
const MAX_SKILL_FILES = 200;
const MAX_STDIN = 9.5 * MB; // same as cli.js
const MAX_CLI_TIMEOUT = 600000;

const CLI_MODEL_RX = /^[A-Za-z0-9][A-Za-z0-9._:\-\[\]]{0,80}$/; // cli.js MODEL_RX
// HTTP providers also take names like "qwen/qwen3-coder" or "hf.co/user/model:Q4" (Ollama); ".." is refused
// because some providers put the model into the URL path.
const HTTP_MODEL_RX = /^[A-Za-z0-9][\w.:\-\/\[\]@+]{0,199}$/;
const SKILL_NAME_RX = /^[\w.-]{1,80}$/;
const SEGMENT_RX = /^[\w.\- ]{1,100}$/;
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const CONTROL_RX = /[\u0000-\u001f\u007f]/;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v, max) => typeof v === "string" && v.length <= max;
const bytes = (s) => Buffer.byteLength(String(s), "utf8");

function payloadSize(payload) {
  try {
    return bytes(JSON.stringify(payload === undefined ? null : payload));
  } catch {
    return Infinity;
  }
}

// one path segment of a file the skill writes, or of the skill folder name
function badSegment(seg) {
  if (!SEGMENT_RX.test(seg)) return "bad characters";
  if (seg === "." || seg === "..") return "relative segment";
  if (/[. ]$/.test(seg)) return "ends with a dot or space";
  if (WIN_RESERVED.test(seg.replace(/\..*$/, "").trim())) return "reserved name";
  return "";
}

/* save:folder-files: every path is checked before any dialog opens; one bad path refuses the whole message.
   → null or an error string. */
function checkSkillFiles(skillName, files) {
  if (skillName != null && skillName !== "") {
    if (
      typeof skillName !== "string" ||
      !SKILL_NAME_RX.test(skillName) ||
      skillName === "." ||
      skillName === ".." ||
      /\.$/.test(skillName) ||
      WIN_RESERVED.test(skillName.replace(/\..*$/, ""))
    )
      return "skillName is not allowed";
  }
  if (!Array.isArray(files) || !files.length) return "files must be a non-empty array";
  if (files.length > MAX_SKILL_FILES) return `more than ${MAX_SKILL_FILES} files`;
  let total = 0;
  for (const f of files) {
    if (!isObj(f) || typeof f.path !== "string" || typeof f.content !== "string") return "each file needs a path and a content string";
    const p = f.path;
    if (!p || p.length > 260) return "path is empty or too long";
    if (/[\\:\u0000]/.test(p)) return `path "${p.slice(0, 80)}" contains \\, : or NUL`;
    if (p.startsWith("/")) return `path "${p.slice(0, 80)}" is absolute`;
    for (const seg of p.split("/")) {
      if (seg === "") return `path "${p.slice(0, 80)}" has an empty segment`;
      const why = badSegment(seg);
      if (why) return `path "${p.slice(0, 80)}": ${why}`;
    }
    total += bytes(f.content);
    if (total > MAX_SKILL_TOTAL) return "files are larger than 10 MB in total";
  }
  return null;
}

/* The final check after joinPath: the resolved file lies inside the resolved root. Case-insensitive on Windows and
   macOS. Not enough on its own (a backslash inside a segment survives joinPath unresolved), hence checkSkillFiles. */
function isInside(root, file, platform = process.platform) {
  const P = platform === "win32" ? path.win32 : path.posix;
  let r = P.resolve(root),
    f = P.resolve(file);
  if (platform === "win32" || platform === "darwin") {
    r = r.toLowerCase();
    f = f.toLowerCase();
  }
  const sep = platform === "win32" ? "\\" : "/";
  return f.startsWith(r.endsWith(sep) ? r : r + sep);
}

// save:file: only a basename survives; anything unusable becomes "sessionlens.md"
function safeBasename(name) {
  // posix: on Windows path.basename("a:b.md") would take "a:" for a drive and return "b.md"
  const b = path.posix.basename(String(name == null ? "" : name).replace(/\\/g, "/"));
  if (!b || b === "." || b === ".." || b.includes(":") || CONTROL_RX.test(b) || b.length > 200) return "sessionlens.md";
  return b;
}

function checkStorageSet(values) {
  if (!isObj(values)) return "values must be an object";
  const keys = Object.keys(values);
  if (!keys.length) return "no values";
  for (const k of keys) {
    if (!STORAGE_KEYS.includes(k)) return `unknown storage key "${String(k).slice(0, 40)}"`;
    const v = values[k];
    if (NUMBER_KEYS.has(k)) {
      if (!Number.isInteger(v) || v < 0) return `"${k}" must be a whole number`;
      continue;
    }
    if (ARRAY_KEYS.has(k) ? !Array.isArray(v) : !isObj(v)) return `"${k}" must be ${ARRAY_KEYS.has(k) ? "an array" : "an object"}`;
  }
  return null;
}

function checkModel(m, rx) {
  if (m == null || m === "") return null;
  if (typeof m !== "string" || !rx.test(m) || m.includes("..")) return "model name is not allowed";
  return null;
}

function checkCliRun(p) {
  const e = checkModel(p.model, CLI_MODEL_RX);
  if (e) return e;
  for (const k of ["system", "user"]) if (p[k] != null && (typeof p[k] !== "string" || bytes(p[k]) > MAX_STDIN)) return `${k} must be a string up to 9.5 MB`;
  if (p.timeoutMs != null && !(Number.isInteger(p.timeoutMs) && p.timeoutMs >= 1 && p.timeoutMs <= MAX_CLI_TIMEOUT)) return "timeoutMs is out of range";
  return null;
}

const none = () => null;

// A session id: any short single-line string. It never becomes a path by itself (store.js fileNameFor).
const checkId = (id) => (typeof id === "string" && id.length >= 1 && id.length <= 200 && !CONTROL_RX.test(id) ? null : "bad session id");

function checkSessionPut(p) {
  const s = p.session;
  if (!isObj(s)) return "session must be an object";
  const e = checkId(s.id);
  if (e) return e;
  if (!Array.isArray(s.events) || !Array.isArray(s.findings)) return "session needs events and findings arrays";
  if (!isObj(s.verdicts)) return "session.verdicts must be an object";
  if (typeof s.created !== "string" || s.created.length > 64) return "session.created must be a string";
  if (s.findings.some((f) => !isObj(f) || typeof f.check !== "string")) return "every finding needs a check";
  if (p.baseRev != null && !(Number.isInteger(p.baseRev) && p.baseRev >= 0)) return "baseRev must be a whole number";
  if (p.analyzedGen != null && !(typeof p.analyzedGen === "string" && GEN_RX.test(p.analyzedGen))) return "analyzedGen is not allowed";
  if (p.background != null && typeof p.background !== "boolean") return "background must be true or false";
  if (payloadSize(s) > MAX_SESSION) return "session is larger than 32 MB";
  return null;
}

/* ctx: { httpProviders: string[], keyProviders: string[], baseUrlProviders: string[], sessionExists(id) → bool,
        profiles: string[] (log:timing; without it a profile only has to look like one) } */
const VALIDATORS = {
  "storage:get": (p) => (Array.isArray(p.keys) && p.keys.length && p.keys.every((k) => STORAGE_KEYS.includes(k)) ? null : "unknown or missing storage key"),
  "storage:set": (p) => checkStorageSet(p.values),
  "secret:status": none,
  "secret:set": (p, ctx) => {
    if (!ctx.keyProviders.includes(p.provider)) return "unknown provider";
    if (typeof p.key !== "string" || !p.key.trim() || p.key.length > 1000 || CONTROL_RX.test(p.key))
      return "the key must be a non-empty single line up to 1000 characters";
    return null;
  },
  "secret:delete": (p, ctx) => (ctx.keyProviders.includes(p.provider) ? null : "unknown provider"),
  "ai:call": (p, ctx) => {
    if (!ctx.httpProviders.includes(p.provider)) return "unknown provider";
    const e = checkModel(p.model, HTTP_MODEL_RX);
    if (e) return e;
    for (const k of ["system", "user"]) if (p[k] != null && typeof p[k] !== "string") return `${k} must be a string`;
    if (p.maxTokens != null && !(Number.isInteger(p.maxTokens) && p.maxTokens > 0 && p.maxTokens <= 1e6)) return "maxTokens is out of range";
    if (p.schema != null && !isObj(p.schema)) return "schema must be an object";
    return null; // p.baseUrl is ignored by the host
  },
  "baseurl:set": (p, ctx) => {
    if (!ctx.baseUrlProviders.includes(p.provider)) return "unknown provider";
    if (typeof p.url !== "string" || p.url.length > 2000) return "url must be a string up to 2000 characters";
    if (p.url && !/^https?:\/\/[^\s]+$/i.test(p.url.trim())) return "url must start with http:// or https://";
    return null;
  },
  "clipboard:write": (p) => (typeof p.text === "string" && bytes(p.text) <= MAX_CLIPBOARD ? null : "text must be a string up to 10 MB"),
  "save:file": (p) => {
    if (p.name != null && !isStr(p.name, 1000)) return "name must be a string";
    return typeof p.content === "string" && bytes(p.content) <= MAX_FILE ? null : "content must be a string up to 10 MB";
  },
  "save:folder-files": (p) => checkSkillFiles(p.skillName, p.files),
  "open:transcript": (p) =>
    p.source == null || p.source === "claude" || p.source === "codex" || p.source === "cursor" || p.source === "" ? null : "unknown source",
  "claude:run": checkCliRun,
  "codex:run": checkCliRun,
  "cursor:run": checkCliRun,
  "claude:check": none,
  "codex:check": none,
  "cursor:check": none,
  "settings:open": none,
  "session:open": (p, ctx) => (!checkId(p.id) && ctx.sessionExists(p.id) ? null : "no such session"),
  "session:list": none,
  "session:get": (p) => checkId(p.id),
  "session:put": checkSessionPut,
  "session:delete": (p) => checkId(p.id),
  "session:clear": none,
  "panel:close": none,
  "tab:active": (p) => (TABS.includes(p.tab) ? null : "unknown tab"),
  // phase 6: the page finished starting (the host waits for it before sending a palette command to the sidebar)
  "page:ready": none,
  // phase 6: one line for the Output channel. Numbers and names from closed lists only, so a page cannot put
  // transcript text (or anything else) into the log.
  "log:timing": (p, ctx) => {
    if (!TIMING_EVENTS.includes(p.event)) return "unknown timing event";
    const profiles = ctx.profiles || null;
    if (typeof p.profile !== "string" || (profiles ? !profiles.includes(p.profile) : !PROFILE_RX.test(p.profile))) return "unknown profile";
    if (!(Number.isInteger(p.ms) && p.ms >= 0 && p.ms <= 3600000)) return "ms is out of range";
    if (!(Number.isInteger(p.events) && p.events >= 0 && p.events <= 10000000)) return "events is out of range";
    return null;
  },
};

function validate(type, payload, ctx) {
  if (!Object.prototype.hasOwnProperty.call(VALIDATORS, type)) return `unknown message type "${String(type).slice(0, 40)}"`;
  if (payload != null && !isObj(payload)) return "payload must be an object";
  const p = payload || {};
  if (p.lang != null && !isStr(p.lang, 8)) return "lang must be a short string";
  if (payloadSize(p) > MAX_PAYLOAD) return "message is too large";
  return VALIDATORS[type](p, ctx || {});
}

module.exports = { validate, VALIDATORS, STORAGE_KEYS, TABS, TIMING_EVENTS, checkSkillFiles, isInside, safeBasename, MAX_PAYLOAD, MAX_SESSION };
