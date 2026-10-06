// @ts-check
const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { runClaude, checkClaude, runCodex, checkCodex, runCursor, checkCursor, cursorProjectSlug, PATH_RX } = require("./cli.js");
const { cursorOutputs } = require("./cursor-db.js");
const Lens = require("./media/lens.js"); // shared with the webview: verdict(), same rules for the same data
const LensAI = require("./media/ai.js"); // shared too: the provider table and each provider's request shape
const I18N = require("./media/i18n.js");
const Secrets = require("./secrets.js");
const { createProviderCall, validUrl } = require("./providers.js");
const V = require("./validate.js");
const { createStore } = require("./store.js");

// The page's own scripts (after vscode-bridge.js, inserted separately below).
const SCRIPT_FILES = [
  "lint-robot.js",
  "checks.js",
  "lens.js",
  "lint.js",
  "rules.js",
  "spec.js",
  "ai.js",
  "segment.js",
  "dialogs.js",
  "demo-session.js",
  "app.js",
];
// Phase 5: the lint engines are not <script>s of the page. lint.js (LensLint.ensure) loads the ones a session's language
// needs, when it is analyzed; their webview URIs travel as one data-engines attribute (JSON), read by vscode-bridge.js.
// Must list every file of lint.js's ENGINE_FILES (a test checks it).
const ENGINE_SCRIPTS = [
  "vendor-eslint.js",
  "vendor-eslint-cypress.js",
  "vendor-eslint-detox.js",
  "tree-sitter.js",
  "lint-java.js",
  "lint-csharp.js",
  "lint-python.js",
];
// Binary WASM assets are not <script>s — they can't go through SCRIPT_FILES/asWebviewUri-in-src-attribute
// the way the files above do. lint-java.js/lint-csharp.js/lint-python.js need their webview URIs at
// runtime (to hand to web-tree-sitter's Parser.init({ locateFile }) / Language.load()), so they travel
// the same way the open-session id already does below: as a data-attribute on <body>, read into a plain
// global by vscode-bridge.js before app.js runs (an inline <script> here would be silently blocked —
// script-src has no 'unsafe-inline'). tree-sitter.wasm (the core runtime) is shared by all three grammars.
const WASM_ASSETS = ["tree-sitter.wasm", "tree-sitter-java.wasm", "tree-sitter-c_sharp.wasm", "tree-sitter-python.wasm"];

function buildHtml(webview, extensionUri, initialSessionId) {
  const mediaUri = vscode.Uri.joinPath(extensionUri, "media");
  const asUri = (name) => webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, name)).toString();

  let html = fs.readFileSync(vscode.Uri.joinPath(mediaUri, "sidepanel.html").fsPath, "utf8");

  html = html.replace('href="styles.css"', `href="${asUri("styles.css")}"`);
  // A dedicated per-session tab shows only the Review view — no Sessions/Calibration/Rules/
  // Settings nav. The session id travels as a data-attribute (not an inline <script>, which
  // the page's CSP below blocks — script-src has no 'unsafe-inline'); vscode-bridge.js reads
  // it into window.SL_OPEN_SESSION before app.js runs. The body class hides the header (see
  // styles.css); app.js also locks show(v) to "review" whenever SL_OPEN_SESSION is set, so
  // nothing (e.g. deleting the session) can flip this tab over to another view.
  // The four WASM asset URIs (see WASM_ASSETS above) travel the same way, always — not just for
  // a session tab — since every view (including the plain sidebar) may need to run qa-java checks.
  // So do the engine scripts' URIs (ENGINE_SCRIPTS): nothing is fetched until lint.js asks for a file.
  const attr = (v) => String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const engineUris = {};
  for (const f of ENGINE_SCRIPTS) engineUris[f] = asUri(f);
  const wasmAttrs =
    WASM_ASSETS.map((f) => `data-${f.replace(/\.wasm$/, "").replace(/[^a-z0-9]+/gi, "-")}-wasm="${asUri(f)}"`).join(" ") +
    ` data-engines="${attr(JSON.stringify(engineUris))}"`;
  if (initialSessionId) {
    const idAttr = String(initialSessionId).replace(/"/g, "&quot;");
    html = html.replace("<body>", `<body class="sl-session" data-open-session="${idAttr}" ${wasmAttrs}>`);
  } else {
    html = html.replace("<body>", `<body ${wasmAttrs}>`);
  }
  // The bridge must load before every other script (it defines window.chrome).
  html = html.replace('<script src="i18n.js"></script>', `<script src="${asUri("vscode-bridge.js")}"></script>\n<script src="${asUri("i18n.js")}"></script>`);
  for (const f of SCRIPT_FILES) {
    html = html.replace(`<script src="${f}"></script>`, `<script src="${asUri(f)}"></script>`);
  }

  // connect-src is only the extension's own files: web-tree-sitter fetches its .wasm by webview URI (see
  // WASM_ASSETS above), and with 'none' qa-java/qa-csharp/qa-python would lose their tree-sitter checks
  // without a word. The AI providers are no longer called from here: the host makes those requests (providers.js).
  // 'wasm-unsafe-eval' is for qa-java's tree-sitter engine (media/lint-java.js): it only allows
  // WebAssembly.compile()/instantiate(), not eval()/new Function() — a much narrower grant than
  // 'unsafe-eval', which the ESLint bundles deliberately avoid needing at all (see their
  // meta.schema = false patch in lint.js's header comment). Without it, WebAssembly is blocked
  // from loading in this webview entirely, same as any other CSP-restricted page.
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src ${webview.cspSource} 'wasm-unsafe-eval'`,
    `connect-src ${webview.cspSource}`,
  ].join("; ");
  html = html.replace("<head>", `<head>\n<meta http-equiv="Content-Security-Policy" content="${csp}">`);

  return html;
}

/* The host's own strings are English whatever the language of VS Code, like the panel (0.1.110: the Russian
   translation of the host was removed; half a Russian window around an English panel read worse than English).
   t() fills {0}, {1}… as vscode.l10n.t did, so the calls stay as they are. */
const fmt = (message, args) => String(message).replace(/\{(\d+)\}/g, (m, i) => (args[i] !== undefined ? String(args[i]) : m));
function t(message, ...args) {
  return fmt(message, args);
}
const COUNT_FORMS = {
  finding: { one: "{0} finding", other: "{0} findings" },
  verdict: { one: "{0} verdict", other: "{0} verdicts" },
  hidden: { one: "{0} hidden by calibration", other: "{0} hidden by calibration" },
};
function countLabel(n, kind) {
  const forms = COUNT_FORMS[kind];
  return fmt(n === 1 ? forms.one : forms.other, [n]);
}
// what the tree, Open session… and a tab's title show for a session: its name, or the task id (Lens.displayName)
function describeSession(s) {
  const n = s.findingsCount || 0,
    done = s.verdictsCount || 0;
  const date = String(s.created || "").slice(0, 10);
  const bits = [s.profile, countLabel(n, "finding")];
  // 0.1.116: a green session can still have findings an "off" check hides; the colour alone would say "nothing"
  if (s.hiddenCount) bits.push(countLabel(s.hiddenCount, "hidden"));
  if (done) bits.push(countLabel(done, "verdict"));
  if (date) bits.push(date);
  return bits.filter(Boolean).join(" · ");
}
const cliMovedText = () =>
  t("SessionLens: the path to the CLI you entered in the panel is now a setting (sessionlens.claudeCliPath / sessionlens.codexCliPath).");

/* Phase 3: what a webview must not decide on its own. The CLI paths are machine-scoped VS Code settings
   (package.json: a workspace's .vscode/settings.json cannot set them); the address of a local server or of Qwen
   lives in HOST_BASE_KEY, which no storage message can read or write, and changes only after the person confirms it
   in a VS Code dialog (baseurl:set). */
const CONFIG = "sessionlens";
const CLI_SETTINGS = { claude: "claudeCliPath", codex: "codexCliPath", cursor: "cursorCliPath" };
const HOST_BASE_KEY = "hostBaseUrls";
const BASEURL_PROVIDERS = Object.keys(LensAI.PROVIDERS).filter((n) => LensAI.PROVIDERS[n].local || LensAI.PROVIDERS[n].editableBase);
const HTTP_PROVIDERS = Object.keys(LensAI.PROVIDERS).filter((n) => !LensAI.PROVIDERS[n].cli);
function cliPathFor(kind) {
  try {
    return String(vscode.workspace.getConfiguration(CONFIG).get(CLI_SETTINGS[kind]) || "").trim();
  } catch {
    return "";
  }
}
const sameUrl = (a, b) =>
  String(a || "")
    .trim()
    .replace(/\/+$/, "") ===
  String(b || "")
    .trim()
    .replace(/\/+$/, "");
// "" = the provider's default address
function normBaseUrl(prov, url) {
  const u = validUrl(url);
  return !u || sameUrl(u, LensAI.PROVIDERS[prov].defaultBaseUrl) ? "" : u;
}
// settings as a webview may write them: no CLI paths, no local/Qwen address (those are the host's)
function stripHostOwned(settings) {
  if (!settings || typeof settings !== "object") return settings;
  const out = Object.assign({}, settings);
  delete out.cliPath;
  delete out.cliPaths;
  if (out.baseUrls && typeof out.baseUrls === "object") {
    out.baseUrls = Object.assign({}, out.baseUrls);
    for (const p of BASEURL_PROVIDERS) delete out.baseUrls[p];
  }
  return out;
}

/* Phase 6: five settings live in VS Code Settings (package.json contributes.configuration, scope "application":
   Settings Sync carries them, a workspace's .vscode/settings.json cannot change them). The panel keeps reading and
   writing them as part of `settings` (app.js does not know about VS Code settings): storage:get lays the configured
   values over the stored ones, storage:set writes them into the configuration and keeps them out of globalState.
   Whether a value is set at all matters (media/ai.js gives a local server other defaults when minGapMs/maxCode are
   missing), so a value stays unset until the panel or the person sets one, and one that was set stays set, even when
   it equals the default. Numbers are rounded and kept inside the range package.json declares. */
const CONFIG_SETTINGS = {
  minGapMs: { min: 0, max: 600000 },
  maxCode: { min: 1000, max: 2000000 },
  verify: { bool: true },
  lint: { bool: true },
  rulesTarget: { values: ["claude", "codex", "cursor", "both"] },
};
// → the value to use, or undefined when it cannot be one
function normConfigValue(key, v) {
  const spec = CONFIG_SETTINGS[key];
  if (spec.bool) return typeof v === "boolean" ? v : undefined;
  if (spec.values) return spec.values.includes(v) ? v : undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return Math.min(spec.max, Math.max(spec.min, Math.round(v)));
}
// the values set in the user's settings (never the workspace's: the scope already ignores those)
function configuredSettings(logBad) {
  const out = {};
  let cfg;
  try {
    cfg = vscode.workspace.getConfiguration(CONFIG);
  } catch {
    return out;
  }
  for (const k of Object.keys(CONFIG_SETTINGS)) {
    let v;
    try {
      const i = cfg.inspect(k);
      v = i ? i.globalValue : undefined;
    } catch {
      v = undefined;
    }
    if (v === undefined) continue;
    const n = normConfigValue(k, v);
    if (n === v) out[k] = v;
    else if (n !== undefined) {
      out[k] = n;
      if (logBad) host.log(`sessionlens.${k} is outside its range; ${n} is used`);
    } else if (logBad) host.log(`sessionlens.${k} has a value SessionLens does not accept; the default is used`);
  }
  return out;
}
/* storage:set: writes the configuration keys the panel changed. → the keys that could not be written (they stay in
   globalState so nothing is lost; the next save tries again). */
/* known: what the writing page last saw of these settings (its storage:get, or its own last write), updated here. The
   page sends all five with every save, so a value it did not change is the one it saw: written back, it would undo an
   edit of settings.json whose refresh has not reached the page yet. Such a value is not written. */
async function writeConfigSettings(settings, known) {
  const failed = [];
  if (!settings || typeof settings !== "object") return failed;
  const cfg = vscode.workspace.getConfiguration(CONFIG);
  for (const k of Object.keys(CONFIG_SETTINGS)) {
    if (!(k in settings)) continue;
    const v = normConfigValue(k, settings[k]);
    if (v === undefined) continue; // not a usable value: dropped, the default applies
    if (known && Object.prototype.hasOwnProperty.call(known, k) && known[k] === v) continue; // unchanged by the page
    let cur;
    try {
      const i = cfg.inspect(k);
      cur = i ? i.globalValue : undefined;
    } catch {
      cur = undefined;
    }
    if (cur !== v) {
      try {
        await cfg.update(k, v, vscode.ConfigurationTarget.Global);
      } catch (e) {
        failed.push(k);
        host.log(`could not write the setting sessionlens.${k}: ` + String((e && e.message) || e));
        continue; // kept in globalState; the next save tries again
      }
    }
    if (known) known[k] = v;
  }
  return failed;
}
function withoutConfigSettings(settings, keep = []) {
  if (!settings || typeof settings !== "object") return settings;
  const out = Object.assign({}, settings);
  for (const k of Object.keys(CONFIG_SETTINGS)) if (!keep.includes(k)) delete out[k];
  return out;
}
// ESLint on or off as the next analysis will see it (migrateSessions computes the gen with it)
function lintEnabled(stored) {
  const c = configuredSettings(false);
  return "lint" in c ? c.lint : !(stored && stored.lint === false);
}

// Every open webview (the sidebar + every session tab) — kept so a write from one can refresh
// all the others straight away, not just when a hidden one becomes visible again.
const activeWebviews = new Set();
/* What changed decides what a page re-reads (phase 4): { scope: "keys" } settings and other small keys,
   { scope: "session", sessionId, meta } one session (meta null: deleted), { scope: "index" } the whole list,
   { scope: "focus" } the page became visible again (keys and list). */
function broadcastRefresh(except, what = { scope: "keys" }) {
  for (const w of activeWebviews) {
    if (w === except) continue;
    try {
      w.postMessage(Object.assign({ __slRefresh: true }, what));
    } catch (e) {
      activeWebviews.delete(w);
    } // a stale/disposed reference — drop it, keep going for the rest
  }
}

// Where to point the "choose a transcript" dialog: one level *inside* ~/.claude or ~/.codex, not at
// the home folder. Both are dot-folders that native open dialogs hide by default (and, on desktop
// VS Code, there is no API to ask the dialog to reveal them — see microsoft/vscode#160351) — but
// only that outer folder is hidden. Once the dialog opens already inside it, every session file and
// project/date subfolder underneath is a perfectly ordinary, visible entry.
// `source` is what the person picked in the "Where is the transcript from?" prompt in app.js:
// "claude" or "codex" go straight to that folder (or the home folder if it turns out not to exist);
// "cursor" goes to this workspace's agent-transcripts folder (cursorTranscriptsDir);
// anything else ("somewhere else", or no prompt at all) goes to the home folder, same as a plain
// "Choose file" always did — the person is browsing for it themselves, not being pointed anywhere.
function guessTranscriptDefaultUri(source) {
  const home = os.homedir();
  const wanted =
    source === "codex"
      ? path.join(home, ".codex", "sessions")
      : source === "claude"
        ? path.join(home, ".claude", "projects")
        : source === "cursor"
          ? cursorTranscriptsDir(home)
          : null;
  return vscode.Uri.file(wanted && isDir(wanted) ? wanted : home);
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ~/.cursor/projects/<workspace>/agent-transcripts for the first workspace folder that has one (by its path or, for a
// symlink, its real path, which Cursor's CLI uses; the name: cursorProjectSlug in cli.js); otherwise ~/.cursor/projects
function cursorTranscriptsDir(home) {
  const projects = path.join(home, ".cursor", "projects");
  for (const f of vscode.workspace.workspaceFolders || []) {
    if (f.uri.scheme !== "file") continue;
    const paths = [f.uri.fsPath];
    try {
      paths.push(fs.realpathSync(f.uri.fsPath));
    } catch {
      /* the path as it is */
    }
    for (const p of paths) {
      const slug = cursorProjectSlug(p);
      const dir = path.join(projects, slug, "agent-transcripts");
      if (slug && isDir(dir)) return dir;
    }
  }
  return projects;
}

// API keys (phase 2): SecretStorage + host-side provider calls. Set up in activate(); `ready` is the one-time
// migration of keys out of globalState, which every storage/secret/AI message waits for, so no webview can
// read settings before the keys are gone from them. Activation itself does not wait (a keychain can be slow).
const host = { secrets: null, call: null, ready: Promise.resolve(), store: null, storeOpen: false, log: (m) => console.warn("SessionLens: " + m) };

// Moves keys out of globalState.settings into SecretStorage. Idempotent; on a keychain failure the keys stay
// where they are (and still work, see Secrets.resolveKey) until the next start.
/* Moves what the panel used to own into the host (phase 3): the CLI paths into the machine-scoped settings, the
   local/Qwen addresses into HOST_BASE_KEY. Existing data, so no confirmation. Idempotent; a setting that could not be
   written leaves the old field where it is, for the next start. */
async function migrateHostOwned(context) {
  const st = context.globalState.get("settings");
  if (!st || typeof st !== "object") return;
  const next = Object.assign({}, st);
  let changed = false;

  const cliPaths = st.cliPaths && typeof st.cliPaths === "object" ? st.cliPaths : {};
  const wanted = { claude: cliPaths.claudecli || st.cliPath || "", codex: cliPaths.codexcli || "" };
  let moved = false,
    failed = false;
  for (const kind of Object.keys(CLI_SETTINGS)) {
    const v = String(wanted[kind] || "").trim();
    if (!v) continue;
    if (!PATH_RX.test(v)) {
      host.log(`not moving the ${kind} CLI path to the settings: it has characters the CLI launcher refuses`);
      continue;
    }
    try {
      const cfg = vscode.workspace.getConfiguration(CONFIG);
      const i = cfg.inspect(CLI_SETTINGS[kind]);
      if (i && i.globalValue !== undefined) continue; // the person already set it: theirs wins
      await cfg.update(CLI_SETTINGS[kind], v, vscode.ConfigurationTarget.Global);
      moved = true;
    } catch (e) {
      failed = true;
      host.log(`could not move the ${kind} CLI path to the settings: ` + String((e && e.message) || e));
    }
  }
  if (!failed && ("cliPath" in st || "cliPaths" in st)) {
    delete next.cliPath;
    delete next.cliPaths;
    changed = true;
  }

  const hb = Object.assign({}, context.globalState.get(HOST_BASE_KEY) || {});
  let hbChanged = false;
  const urls = st.baseUrls && typeof st.baseUrls === "object" ? st.baseUrls : {};
  for (const prov of BASEURL_PROVIDERS) {
    const u = urls[prov] || (st.provider === prov ? st.baseUrl : "");
    if (hb[prov] === undefined && u) {
      hb[prov] = normBaseUrl(prov, u);
      hbChanged = true;
    }
    if (prov in urls) {
      next.baseUrls = Object.assign({}, next.baseUrls);
      delete next.baseUrls[prov];
      changed = true;
    }
  }
  if (hbChanged) await context.globalState.update(HOST_BASE_KEY, hb);
  if (changed) await context.globalState.update("settings", next);
  if (moved) vscode.window.showInformationMessage(cliMovedText());
}

/* Phase 6: the five CONFIG_SETTINGS move from globalState.settings into the user's VS Code settings. Existing data,
   so no confirmation. A value the person already set in Settings wins. A field is removed from globalState only after
   its value is in the configuration (or the configuration already had one); on a failure it stays for the next start.
   A value that cannot be used (wrong type) is dropped: the panel ignored it before too. Idempotent. */
async function migrateSettingsToConfig(context) {
  const st = context.globalState.get("settings");
  if (!st || typeof st !== "object") return;
  const present = Object.keys(CONFIG_SETTINGS).filter((k) => k in st);
  if (!present.length) return;
  const cfg = vscode.workspace.getConfiguration(CONFIG);
  const next = Object.assign({}, st);
  const moved = [],
    theirs = [],
    dropped = [],
    failed = [];
  for (const k of present) {
    const v = normConfigValue(k, st[k]);
    let cur;
    try {
      const i = cfg.inspect(k);
      cur = i ? i.globalValue : undefined;
    } catch {
      cur = undefined;
    }
    if (cur !== undefined) {
      delete next[k];
      theirs.push(k);
      continue;
    }
    if (v === undefined) {
      delete next[k];
      dropped.push(k);
      continue;
    }
    try {
      await cfg.update(k, v, vscode.ConfigurationTarget.Global);
      delete next[k];
      moved.push(k);
    } catch (e) {
      failed.push(k);
      host.log(`migration: could not move ${k} to the setting sessionlens.${k}: ` + String((e && e.message) || e));
    }
  }
  await context.globalState.update("settings", next);
  const list = (a) => a.map((k) => "sessionlens." + k).join(", ");
  host.log(
    "migration: panel settings to VS Code settings:" +
      (moved.length ? ` moved ${list(moved)};` : "") +
      (theirs.length ? ` already set in Settings, kept: ${list(theirs)};` : "") +
      (dropped.length ? ` unusable value dropped: ${list(dropped)};` : "") +
      (failed.length ? ` not moved yet: ${list(failed)} (next start tries again)` : ""),
  );
}

/* Phase 4: sessions move from globalState["sessions"] into files (store.js). Idempotent. storageVersion is set only
   after every session was written and read back; until then the old key stays and the next start tries again,
   skipping a session whose file was changed since (rev > 1). The key is removed last. */
async function migrateSessions(context, store) {
  const log = host.log;
  const version = context.globalState.get("storageVersion") || 0;
  const old = context.globalState.get("sessions");
  if (version < 2) {
    const ids = old && typeof old === "object" && !Array.isArray(old) ? Object.keys(old) : [];
    if (ids.length) {
      const t0 = Date.now();
      const st = context.globalState.get("settings") || {};
      const gen = Lens.analysisGen({
        ruleOverrides: context.globalState.get("ruleOverrides") || {},
        lint: lintEnabled(st),
        epoch: context.globalState.get("analysisEpoch") || 0,
      });
      let moved = 0,
        skipped = 0,
        bytes = 0,
        order = 0;
      const work = async (progress) => {
        for (const id of ids) {
          order++;
          const s = old[id];
          if (!s || typeof s !== "object" || typeof s.id !== "string") {
            log(`migration: skipped an entry that is not a session: ${String(id).slice(0, 60)}`);
            skipped++;
            continue;
          }
          if (s.id !== id) log(`migration: session stored under "${String(id).slice(0, 60)}" has id "${String(s.id).slice(0, 60)}"; the id inside is kept`);
          const cur = store.meta(s.id);
          if (cur && cur.rev > 1) {
            log(`migration: ${s.id} was changed after an earlier, unfinished migration; kept as it is`);
            skipped++;
            continue;
          }
          await store.put(s, { rev: 1, order, analyzedGen: gen });
          const back = await store.get(s.id);
          if (!back || JSON.stringify(back.session) !== JSON.stringify(s)) throw new Error(`session ${s.id} reads back different from what was written`);
          bytes += back.meta.size;
          moved++;
          if (progress) progress.report({ message: `${moved}/${ids.length}` });
        }
      };
      if (ids.length > 20 && vscode.window.withProgress)
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation ? vscode.ProgressLocation.Window : 10, title: t("SessionLens: moving sessions to files") },
          work,
        );
      else await work(null);
      log(
        `migration: ${moved} session(s), ${Math.round(bytes / 1024)} KB, moved from globalState to ${store.dir} in ${Date.now() - t0} ms` +
          (skipped ? `; ${skipped} skipped` : ""),
      );
    }
    await context.globalState.update("storageVersion", 2);
  }
  if (context.globalState.get("sessions") !== undefined) await context.globalState.update("sessions", undefined);
}

async function migrateSecrets(context) {
  const settings = context.globalState.get("settings");
  const r = await Secrets.extractSecrets(settings, host.secrets, LensAI.PROVIDERS, (m) => host.log(String(m).replace(/^SessionLens: /, "")));
  if (r.error) {
    host.log("could not move API keys to SecretStorage yet: " + String((r.error && r.error.message) || r.error));
    return;
  }
  if (r.changed) await context.globalState.update("settings", r.settings);
}

/* Phase 6: a failed CLI run or check in the Output channel: which CLI, the error code and how long it took. The
   message is added only where it cannot hold model output or the prompt (a path, a timeout in seconds). */
const CLI_LOG_MESSAGE = new Set(["notfound", "timeout"]);
async function logCli(kind, what, fn) {
  const t0 = Date.now();
  const r = await fn();
  const ms = Date.now() - t0;
  try {
    if (r && r.error) {
      const code = String(r.error.code || "failed").slice(0, 40);
      const extra = CLI_LOG_MESSAGE.has(code) && r.error.message ? ` (${String(r.error.message).slice(0, 200)})` : "";
      host.log(`${kind} CLI ${what} failed after ${ms} ms: ${code}${extra}`);
    } else if (what === "check" && r && r.installed === false) {
      host.log(`${kind} CLI not found: ${String(r.cmd || "").slice(0, 200)} (${ms} ms)`);
    }
    // Cursor keeps a copy of every request; cli.js removes it after the run and says whether it could (0.1.121)
    if (r && r.traces === "failed") host.log(`${kind} CLI: could not remove Cursor's copy of the request from ~/.cursor`);
    else if (r && r.traces === "none" && !r.error) host.log(`${kind} CLI: found no copy of the request in ~/.cursor to remove`);
  } catch {
    /* logging never breaks a reply */
  }
  return r;
}

// Shared by the sidebar view and every per-session editor-tab panel: all of them read/write
// the same context.globalState, so a verdict set in one place is visible to the others.
// Returns { dispose } — the caller runs it when the view/tab goes away, to abort its in-flight AI requests.
function wireMessages(
  context,
  webview,
  { onOpenSession, onClose, onReady } = /** @type {{ onOpenSession?: Function, onClose?: Function, onReady?: Function }} */ ({}),
) {
  const inflight = new Set(); // AbortControllers of this webview's pending ai:call requests
  let knownConfig = null; // the five VS Code settings as this page last saw them (writeConfigSettings); null: not read yet
  const keyStatus = () => Secrets.keyStatus(host.secrets, context.globalState.get("settings"), LensAI.PROVIDERS);
  const vctx = {
    httpProviders: HTTP_PROVIDERS,
    keyProviders: Secrets.keyProviders(LensAI.PROVIDERS),
    baseUrlProviders: BASEURL_PROVIDERS,
    // before the store is open the handler checks again after host.ready
    sessionExists: (id) => !host.storeOpen || host.store.has(id),
    profiles: [...Lens.PROFILES, ...Object.keys(Lens.ALIAS || {})],
  };
  webview.onDidReceiveMessage(async (msg) => {
    if (!msg || !msg.__sl) return;
    // the tab may have been closed while a request was running; its reply has nowhere to go
    const reply = (result) => {
      try {
        webview.postMessage({ __slReply: true, id: msg.id, result });
      } catch (e) {
        /* disposed */
      }
    };
    // every message is checked before anything happens, as if an attacker had written it (see validate.js)
    const bad = V.validate(msg.type, msg.payload, vctx);
    if (bad) {
      host.log(`refused ${String(msg.type).slice(0, 40)}: ${bad}`);
      reply({ error: "SessionLens: " + bad });
      return;
    }
    try {
      if (msg.type === "storage:get") {
        await host.ready;
        const out = {};
        for (const k of msg.payload.keys) out[k] = context.globalState.get(k);
        if (out.settings) {
          out.settings = Secrets.stripSecrets(out.settings); // keys never reach a webview
          // the local/Qwen addresses are the host's; the panel gets them to show in its form
          const hb = context.globalState.get(HOST_BASE_KEY) || {};
          const shown = {};
          for (const p of BASEURL_PROVIDERS) if (hb[p]) shown[p] = hb[p];
          if (Object.keys(shown).length) out.settings.baseUrls = Object.assign({}, out.settings.baseUrls, shown);
        }
        if (msg.payload.keys.includes("settings")) {
          // the five VS Code settings (phase 6) over whatever the panel stored before
          const conf = configuredSettings(false);
          knownConfig = Object.assign({}, conf);
          if (Object.keys(conf).length) out.settings = Object.assign({}, out.settings || {}, conf);
        }
        reply(out);
      } else if (msg.type === "storage:set") {
        await host.ready;
        const values = Object.assign({}, msg.payload.values);
        if (values.settings) values.settings = stripHostOwned(values.settings); // CLI paths and addresses: never from a webview
        // the five VS Code settings (phase 6) go to the configuration; only what could not be written stays here
        if (values.settings) values.settings = withoutConfigSettings(values.settings, await writeConfigSettings(values.settings, knownConfig));
        // A settings object that still carries a key (old data from before phase 2) has it moved to SecretStorage
        // before it is written. If that fails, it is written as is: losing the key would be worse.
        if (Secrets.hasSecretFields(values.settings)) {
          const r = await Secrets.extractSecrets(values.settings, host.secrets, LensAI.PROVIDERS, (m) => host.log(String(m).replace(/^SessionLens: /, "")));
          if (r.error) host.log("could not move an API key to SecretStorage: " + String((r.error && r.error.message) || r.error));
          else values.settings = r.settings;
        }
        for (const [k, v] of Object.entries(values)) {
          await context.globalState.update(k, v);
        }
        reply(true);
        broadcastRefresh(webview, { scope: "keys" }); // settings, rules and the other small keys; sessions have their own messages
      } else if (msg.type === "session:list") {
        await host.ready;
        reply({ items: host.store.list() });
      } else if (msg.type === "session:get") {
        await host.ready;
        const r = await host.store.get(msg.payload.id);
        reply(r || { error: "SessionLens: no such session" });
      } else if (msg.type === "session:put") {
        await host.ready;
        const p = msg.payload,
          id = p.session.id;
        // the sidebar's background re-analysis leaves a session that is open in a tab to that tab
        if (p.background && sessionPanels.has(id)) {
          reply({ skipped: true });
          return;
        }
        const r = await host.store.put(p.session, { baseRev: p.baseRev, analyzedGen: p.analyzedGen });
        reply(r.ok ? { ok: true, rev: r.rev, meta: r.meta } : r);
        if (r.ok) {
          broadcastRefresh(webview, { scope: "session", sessionId: id, meta: r.meta });
          if (sessionsTreeProvider) sessionsTreeProvider.refresh();
          const panel = sessionPanels.get(id);
          if (panel) {
            try {
              panel.title = Lens.displayName(r.meta) || "SessionLens";
            } catch {
              /* disposed */
            }
          }
        }
      } else if (msg.type === "session:delete") {
        await host.ready;
        await host.store.delete(msg.payload.id);
        reply({ ok: true });
        broadcastRefresh(webview, { scope: "session", sessionId: msg.payload.id, meta: null });
        if (sessionsTreeProvider) sessionsTreeProvider.refresh();
      } else if (msg.type === "session:clear") {
        await host.ready;
        await host.store.clear();
        reply({ ok: true });
        broadcastRefresh(webview, { scope: "index" });
        if (sessionsTreeProvider) sessionsTreeProvider.refresh();
      } else if (msg.type === "secret:status") {
        await host.ready;
        reply(await keyStatus());
      } else if (msg.type === "secret:set" || msg.type === "secret:delete") {
        await host.ready;
        const prov = msg.payload && msg.payload.provider;
        if (msg.type === "secret:set") await host.secrets.set(prov, msg.payload.key);
        else {
          await host.secrets.delete(prov);
          // a key the migration could not move yet would otherwise still count as saved
          const st = context.globalState.get("settings");
          if (st && Secrets.collectKeys(st, LensAI.PROVIDERS)[prov]) {
            const keys = Object.assign({}, st.keys || {});
            delete keys[prov];
            const next = Object.assign({}, st, { keys });
            if ((LensAI.PROVIDERS[st.provider] ? st.provider : "anthropic") === prov) delete next.apiKey;
            await context.globalState.update("settings", next);
          }
        }
        reply(await keyStatus());
        broadcastRefresh(webview, { scope: "keys" }); // the other views/tabs re-read the status (this one updates from the reply)
      } else if (msg.type === "baseurl:set") {
        await host.ready;
        const prov = msg.payload.provider,
          p = LensAI.PROVIDERS[prov];
        const url = normBaseUrl(prov, msg.payload.url);
        if (msg.payload.url.trim() && !url && !sameUrl(msg.payload.url, p.defaultBaseUrl)) {
          reply({ error: "SessionLens: not a valid http(s) address" });
          return;
        }
        const hb = Object.assign({}, context.globalState.get(HOST_BASE_KEY) || {});
        if (!sameUrl(hb[prov] || "", url)) {
          // back to the built-in default needs no question; any other address does
          if (url) {
            const withKey = !p.local && !p.noKey && !!(await keyStatus())[prov];
            const yes = t("Use this address");
            const pick = await vscode.window.showWarningMessage(
              t("SessionLens: send {0} requests to {1}?", p.label || prov, url),
              { modal: true, detail: withKey ? t("Your saved {0} API key will be sent to this address with every request.", p.label || prov) : undefined },
              yes,
            );
            if (pick !== yes) {
              reply({ ok: false, cancelled: true });
              return;
            }
          }
          hb[prov] = url;
          await context.globalState.update(HOST_BASE_KEY, hb);
          broadcastRefresh(webview, { scope: "keys" });
        }
        reply({ ok: true, url: url || p.defaultBaseUrl || "" });
      } else if (msg.type === "ai:call") {
        await host.ready;
        const ctl = new AbortController();
        inflight.add(ctl);
        try {
          reply(await host.call(Object.assign({}, msg.payload), ctl.signal));
        } finally {
          inflight.delete(ctl);
        }
      } else if (msg.type === "clipboard:write") {
        await vscode.env.clipboard.writeText(msg.payload.text);
        reply(true);
      } else if (msg.type === "save:file") {
        // only a file name is taken from the panel; the dialog starts in the workspace (or the home folder)
        const folders = vscode.workspace.workspaceFolders;
        const dir = (folders && folders.length && folders[0].uri) || vscode.Uri.file(os.homedir());
        const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(dir, V.safeBasename(msg.payload.name)) });
        if (uri) {
          await vscode.workspace.fs.writeFile(uri, Buffer.from(msg.payload.content, "utf8"));
          vscode.window.showInformationMessage(t("SessionLens: saved to {0}", uri.fsPath));
        }
        reply(!!uri);
      } else if (msg.type === "save:folder-files") {
        const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: t("Save here") });
        if (!picked || !picked.length) {
          reply(false);
          return;
        }
        // Nested under skills/, not dropped straight into the picked folder: this is the shared path a
        // generated CLAUDE.md/AGENTS.md stub points at (see skillStubPath in app.js) — pick your project
        // root here and the two stay in sync without you having to edit either by hand.
        // skillName and every path were checked by validate.js (whitelisted characters, no .., backslash, colon, reserved names);
        // the resolved target is checked once more before anything is written
        const root = vscode.Uri.joinPath(picked[0], "skills", msg.payload.skillName || "generated-skill");
        const targets = msg.payload.files.map((f) => ({ f, uri: vscode.Uri.joinPath(root, ...f.path.split("/")) }));
        if (!V.isInside(picked[0].fsPath, root.fsPath) || targets.some((t) => !V.isInside(root.fsPath, t.uri.fsPath))) {
          reply({ error: "SessionLens: a file would land outside the skill folder" });
          return;
        }
        for (const { f, uri: fileUri } of targets) {
          const dirUri = vscode.Uri.joinPath(fileUri, "..");
          await vscode.workspace.fs.createDirectory(dirUri);
          await vscode.workspace.fs.writeFile(fileUri, Buffer.from(f.content, "utf8"));
        }
        vscode.window.showInformationMessage(t("SessionLens: skill saved to {0}", root.fsPath));
        reply(root.fsPath);
      } else if (msg.type === "open:transcript") {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          defaultUri: guessTranscriptDefaultUri(msg.payload && msg.payload.source),
        });
        if (!picked || !picked.length) {
          reply(null);
          return;
        }
        const uri = picked[0];
        const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
        // a Cursor transcript keeps no command output; Cursor's own database may (cursor-db.js, 0.1.121)
        if (uri.scheme === "file" && Lens.isCursorJsonl(text.trimStart())) {
          const r = cursorOutputs(uri.fsPath);
          host.log(r.outputs ? `cursor: the output of ${r.outputs.length} commands from the ${r.source} database` : `cursor: no command output (${r.reason})`);
          // ~/.cursor/projects/<workspace>/agent-transcripts/…: the folder's name gives the workspace's path (0.1.122)
          const parts = uri.fsPath.split(/[\\/]/),
            at = parts.lastIndexOf("agent-transcripts");
          reply({ name: path.basename(uri.fsPath), text, cursorOutputs: r.outputs || undefined, cursorProject: at > 0 ? parts[at - 1] : undefined });
        } else reply({ name: path.basename(uri.fsPath), text });
      } else if (msg.type === "claude:run") {
        // the user's own Claude Code CLI, see cli.js; the path is the machine setting, never the payload's
        reply(await logCli("claude", "run", () => runClaude(Object.assign({}, msg.payload, { cliPath: cliPathFor("claude") }))));
      } else if (msg.type === "claude:check") {
        reply(await logCli("claude", "check", () => checkClaude({ cliPath: cliPathFor("claude") })));
      } else if (msg.type === "codex:run") {
        reply(await logCli("codex", "run", () => runCodex(Object.assign({}, msg.payload, { cliPath: cliPathFor("codex") })))); // the user's own Codex CLI
      } else if (msg.type === "codex:check") {
        reply(await logCli("codex", "check", () => checkCodex({ cliPath: cliPathFor("codex") })));
      } else if (msg.type === "cursor:run") {
        reply(await logCli("cursor", "run", () => runCursor(Object.assign({}, msg.payload, { cliPath: cliPathFor("cursor") })))); // the user's own Cursor Agent CLI
      } else if (msg.type === "cursor:check") {
        reply(await logCli("cursor", "check", () => checkCursor({ cliPath: cliPathFor("cursor") })));
      } else if (msg.type === "settings:open") {
        await vscode.commands.executeCommand("workbench.action.openSettings", "sessionlens.");
        reply(true);
      } else if (msg.type === "session:open") {
        await host.ready;
        if (!host.store.has(msg.payload.id)) {
          reply({ error: "SessionLens: no such session" });
          return;
        }
        if (onOpenSession) onOpenSession(msg.payload && msg.payload.id);
        reply(true);
      } else if (msg.type === "panel:close") {
        reply(true);
        if (onClose) onClose(); // the session this tab was showing no longer exists — close the tab itself
      } else if (msg.type === "page:ready") {
        reply(true);
        if (onReady) onReady();
      } else if (msg.type === "log:timing") {
        reply(true);
        const p = msg.payload;
        host.log(`analysis (${p.event}): ${p.profile}, ${p.events} events, ${p.ms} ms`);
      } else if (msg.type === "tab:active") {
        reply(true);
        setActiveTab((msg.payload && msg.payload.tab) || "");
      } else {
        reply({ error: "SessionLens: unknown message" }); // not reachable: validate.js refuses unknown types
      }
    } catch (e) {
      reply({ error: String((e && e.message) || e) });
    }
  });
  return {
    dispose() {
      for (const c of inflight) c.abort("disposed");
      inflight.clear();
    },
  };
}

// id -> the editor-tab WebviewPanel currently open for that session (at most one per session).
const sessionPanels = new Map();

function sessionTitle(context, id) {
  const m = host.storeOpen ? host.store.meta(id) : null;
  return Lens.displayName(m) || "SessionLens";
}

// The page became visible again: pick up what another window wrote, then let it re-read.
async function refreshOnFocus(webview) {
  try {
    await host.ready;
    const changed = host.storeOpen ? await host.store.refreshIfChanged() : [];
    if (changed.length && sessionsTreeProvider) sessionsTreeProvider.refresh();
  } catch (e) {
    host.log("could not re-read the session folder: " + String((e && e.message) || e));
  }
  try {
    webview.postMessage({ __slRefresh: true, scope: "focus" });
  } catch {
    /* disposed */
  }
}

function openSessionPanel(context, id) {
  if (!id) return;
  const existing = sessionPanels.get(id);
  if (existing) {
    try {
      existing.reveal(vscode.ViewColumn.Active);
      return;
    } catch (e) {
      // The tab was already closed but its onDidDispose cleanup hadn't landed yet — drop the
      // stale reference and open a fresh one below. Reading a property (even .webview) off an
      // already-disposed panel throws the same "Webview is disposed" error, so don't touch it.
      sessionPanels.delete(id);
    }
  }
  const panel = vscode.window.createWebviewPanel("sessionlensSession", sessionTitle(context, id), vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
  });
  setupSessionPanel(context, panel, id);
}

// Shared by a freshly opened session tab and one VS Code is reviving after a restart
// (see SessionPanelSerializer below) — everything past "the panel shell already exists".
function setupSessionPanel(context, panel, id) {
  panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")] };
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.png");
  // phase 6: a tab VS Code restores after a restart keeps the title it had then; the session may have been renamed since
  try {
    panel.title = sessionTitle(context, id);
  } catch {
    /* disposed */
  }
  panel.webview.html = buildHtml(panel.webview, context.extensionUri, id);
  const wired = wireMessages(context, panel.webview, {
    onOpenSession: (otherId) => openSessionPanel(context, otherId),
    onClose: () => panel.dispose(),
  });
  activeWebviews.add(panel.webview);
  // Refresh from storage whenever the tab regains focus, so edits made in another
  // tab (or the sidebar) while this one was hidden aren't shown stale.
  panel.onDidChangeViewState((e) => {
    if (e.webviewPanel.visible) refreshOnFocus(panel.webview);
  });
  sessionPanels.set(id, panel);
  panel.onDidDispose(() => {
    wired.dispose();
    activeWebviews.delete(panel.webview);
    if (sessionPanels.get(id) === panel) sessionPanels.delete(id);
  });
}

// Lets VS Code reopen a session's editor tab on its own after the window (or VS Code itself)
// is closed and reopened. The id to restore comes from `state`, which is whatever the webview's
// own script last passed to vscode.setState() (see vscode-bridge.js) — VS Code persists that
// for us per tab. Registered in activate() together with the "onWebviewPanel:sessionlensSession"
// activation event in package.json, which is what makes VS Code launch the extension for this.
class SessionPanelSerializer {
  constructor(context) {
    this.context = context;
  }
  async deserializeWebviewPanel(panel, state) {
    const id = state && state.sessionId;
    await host.ready; // the store may still be migrating
    if (!id || !host.storeOpen || !host.store.has(id)) {
      panel.dispose();
      return;
    } // deleted while VS Code was closed
    setupSessionPanel(this.context, panel, id);
  }
}

class SessionLensViewProvider {
  constructor(context) {
    this.context = context;
    this.view = null;
    this.resetReady();
  }
  /* Phase 6: whether the sidebar page has started (it says so with page:ready). A palette command for the sidebar
     waits for it; a hidden sidebar has no page (retainContextWhenHidden is off), so hiding resets it. */
  resetReady() {
    this.isReady = false;
    this.ready = new Promise((r) => {
      this._resolveReady = r;
    });
  }
  markReady() {
    this.isReady = true;
    this._resolveReady();
  }
  whenReady(ms) {
    if (this.isReady) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      this.ready.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  resolveWebviewView(webviewView) {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    webviewView.webview.html = buildHtml(webviewView.webview, this.context.extensionUri);
    this.view = webviewView;
    this.resetReady();
    const wired = wireMessages(this.context, webviewView.webview, {
      onOpenSession: (id) => openSessionPanel(this.context, id),
      onReady: () => this.markReady(),
    });
    activeWebviews.add(webviewView.webview);
    webviewView.onDidDispose(() => {
      wired.dispose();
      activeWebviews.delete(webviewView.webview);
      if (this.view === webviewView) {
        this.view = null;
        this.resetReady();
      }
      setActiveTab("");
    });
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) refreshOnFocus(webviewView.webview);
      else {
        // phase 6: with the panel collapsed the Sessions tree is shown (its when-clause: no tab or "sessions"); the
        // page says which tab it shows again when it is visible (app.js, on boot and on the "focus" refresh)
        setActiveTab("");
        this.resetReady();
      }
    });
  }
}

function setActiveTab(tab) {
  try {
    Promise.resolve(vscode.commands.executeCommand("setContext", "sessionlens.activeTab", tab)).catch(() => {});
  } catch {
    /* ignore */
  }
}

// Native tree list of sessions, shown above the webview in the same sidebar container. A plain
// webview list needs an initial click just to hand its iframe mouse/keyboard focus — harmless the
// very first time, but every session tab it opens takes that focus away again, so the very next
// click back in the sidebar repeats the same "focus, then click" pattern. A TreeView is native
// VS Code UI, not embedded content, so its items open on the first real click every time.
let sessionsTreeProvider = null;
class SessionsTreeProvider {
  constructor(context) {
    this.context = context;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }
  refresh() {
    this._onDidChangeTreeData.fire();
  }
  getTreeItem(item) {
    return item;
  }
  // The summaries only (store.js meta files), never the sessions themselves.
  async getChildren() {
    await host.ready;
    const list = host.storeOpen ? host.store.list() : [];
    return list.map((s) => this.toItem(s)); // empty: package.json's viewsWelcome (text + Import button) shows instead
  }
  toItem(s) {
    const label = Lens.displayName(s) || s.id;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = s.id; // the context menu's commands get the item; the id is how they find the session
    item.description = describeSession(s);
    const other = Lens.otherName(s);
    if (other && other !== label) item.tooltip = other;
    const colorId = s.verdict === "red" ? "charts.red" : s.verdict === "yellow" ? "charts.yellow" : "charts.green";
    item.iconPath = new vscode.ThemeIcon(s.reviewed ? "check" : "circle-filled", new vscode.ThemeColor(colorId));
    item.command = { command: "sessionlens.openSessionFromTree", title: t("Open session"), arguments: [s.id] };
    item.contextValue = "sessionlensSession";
    return item;
  }
}

/* Phase 6: palette and tree-menu commands. Import and Export verdicts run the sidebar's own code (the page parses and
   analyzes transcripts and builds the export), so the host shows the sidebar, waits for its page:ready and sends it
   { __slCommand }. Open, Rename and Delete are the host's. */
let readyTimeoutMs = 10000; // tests shorten it (module.exports._test)
let viewProvider = null;
const sessionIdOf = (arg) => (typeof arg === "string" ? arg : arg && typeof arg.id === "string" ? arg.id : null);

async function runInSidebar(name) {
  try {
    await vscode.commands.executeCommand("sessionlensView.focus");
  } catch (e) {
    host.log("could not show the panel: " + String((e && e.message) || e));
  }
  const ok = viewProvider ? await viewProvider.whenReady(readyTimeoutMs) : false;
  if (!ok || !viewProvider.view) {
    host.log(`command ${name}: the panel did not start within ${readyTimeoutMs / 1000} s`);
    vscode.window.showErrorMessage(t("SessionLens: the panel did not open in time. Try again."));
    return false;
  }
  try {
    await viewProvider.view.webview.postMessage({ __slCommand: true, name });
    return true;
  } catch (e) {
    host.log(`command ${name}: ` + String((e && e.message) || e));
    return false;
  }
}

async function openSessionPick(context) {
  await host.ready;
  const list = host.storeOpen ? host.store.list() : [];
  if (!list.length) {
    vscode.window.showInformationMessage(t("SessionLens: no sessions yet. Import a transcript first."));
    return;
  }
  /** @type {Array<import("vscode").QuickPickItem & { id: string }>} */
  const items = list.map((m) => ({ label: Lens.displayName(m) || m.id, description: describeSession(m), detail: Lens.otherName(m) || undefined, id: m.id }));
  const pick = await vscode.window.showQuickPick(items, { placeHolder: t("Open a session"), matchOnDescription: true, matchOnDetail: true });
  if (pick) openSessionPanel(context, pick.id);
}

async function renameSession(context, arg) {
  const id = sessionIdOf(arg);
  if (!id) return;
  await host.ready;
  if (!host.storeOpen || !host.store.has(id)) return;
  const m = host.store.meta(id);
  const value = await vscode.window.showInputBox({
    title: t("SessionLens: rename session"),
    prompt: t("New name"),
    value: m.name || Lens.displayName(m),
    validateInput: (v) => (String(v).length > 200 ? t("The name is too long (200 characters at most).") : null),
  });
  if (value === undefined) return;
  const next = value.trim();
  if (!next) return;
  // Open in a tab: the tab renames it, so its own copy and rev stay current (a write from here would conflict with it).
  const panel = sessionPanels.get(id);
  if (panel) {
    try {
      await panel.webview.postMessage({ __slCommand: true, name: "rename", value: next });
      return;
    } catch {
      sessionPanels.delete(id);
    }
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await host.store.get(id);
    if (!r) return;
    r.session.name = next;
    r.session.nameSet = true;
    const w = await host.store.put(r.session, { baseRev: r.rev });
    if (w.ok) {
      broadcastRefresh(null, { scope: "session", sessionId: id, meta: w.meta });
      if (sessionsTreeProvider) sessionsTreeProvider.refresh();
      return;
    }
  }
  host.log(`rename of ${String(id).slice(0, 60)}: the session kept changing, not renamed`);
  vscode.window.showErrorMessage(t("SessionLens: could not rename the session. Try again."));
}

async function deleteSession(context, arg) {
  const id = sessionIdOf(arg);
  if (!id) return;
  await host.ready;
  if (!host.storeOpen || !host.store.has(id)) return;
  const label = Lens.displayName(host.store.meta(id)) || id;
  const yes = t("Delete");
  const pick = await vscode.window.showWarningMessage(
    t('SessionLens: delete the session "{0}"?', label),
    { modal: true, detail: t("Its findings and verdicts are deleted with it. This cannot be undone.") },
    yes,
  );
  if (pick !== yes) return;
  const panel = sessionPanels.get(id);
  if (panel) {
    sessionPanels.delete(id);
    try {
      panel.dispose();
    } catch {
      /* already closed */
    }
  }
  await host.store.delete(id);
  broadcastRefresh(null, { scope: "session", sessionId: id, meta: null });
  if (sessionsTreeProvider) sessionsTreeProvider.refresh();
}

/* The migrations, in order, then the session store (phase 7: one function, so the integration tests can run it
   again on data they wrote in the old formats). Each step logs its own failure and the next one still runs. */
function runMigrations(context) {
  return migrateSecrets(context)
    .catch((e) => host.log("API key migration failed: " + String((e && e.message) || e)))
    .then(() => migrateHostOwned(context))
    .catch((e) => host.log("settings migration failed: " + String((e && e.message) || e)))
    .then(() => migrateSettingsToConfig(context))
    .catch((e) => host.log("migration to VS Code settings failed: " + String((e && e.message) || e)))
    .then(async () => {
      await host.store.open();
      host.storeOpen = true;
      try {
        await migrateSessions(context, host.store);
      } catch (e) {
        const why = String((e && e.message) || e);
        host.log("migration of sessions to files stopped: " + why + ". The old data is kept; the next start tries again.");
        const openLog = t("Open log");
        Promise.resolve(
          vscode.window.showErrorMessage && vscode.window.showErrorMessage(t("SessionLens: could not move sessions to files: {0}", why), openLog),
        ).then((pick) => {
          if (pick === openLog && host.output) host.output.show();
        });
      }
      if (sessionsTreeProvider) sessionsTreeProvider.refresh(); // pages ask for the list only after this (session:list waits for host.ready)
    })
    .catch((e) => host.log("could not open the session folder: " + String((e && e.stack) || e)));
}

function activate(context) {
  const out = vscode.window.createOutputChannel ? vscode.window.createOutputChannel("SessionLens") : null;
  if (out) {
    context.subscriptions.push(out);
    host.log = (m) => out.appendLine(`[${new Date().toISOString()}] ${m}`);
    host.output = out;
  }
  host.storeOpen = false;
  host.store = createStore({ dir: path.join(context.globalStorageUri.fsPath, "sessions"), log: (m) => host.log("store: " + m) });
  host.secrets = Secrets.createSecrets(context.secrets, LensAI.PROVIDERS);
  host.call = createProviderCall({
    LensAI,
    i18n: I18N,
    getKey: (prov) => Secrets.resolveKey(host.secrets, prov, context.globalState.get("settings"), LensAI.PROVIDERS),
    getBaseUrl: async (prov) => (context.globalState.get(HOST_BASE_KEY) || {})[prov] || "",
    remoteName: vscode.env.remoteName || "",
  });
  host.ready = runMigrations(context);
  const provider = new SessionLensViewProvider(context);
  viewProvider = provider;
  context.subscriptions.push(vscode.window.registerWebviewViewProvider("sessionlensView", provider));
  context.subscriptions.push(vscode.commands.registerCommand("sessionlens.focus", () => vscode.commands.executeCommand("sessionlensView.focus")));
  sessionsTreeProvider = new SessionsTreeProvider(context);
  context.subscriptions.push(vscode.window.registerTreeDataProvider("sessionlensSessionsTree", sessionsTreeProvider));
  context.subscriptions.push(
    vscode.commands.registerCommand("sessionlens.openSessionFromTree", (arg) => openSessionPanel(context, sessionIdOf(arg))),
    vscode.commands.registerCommand("sessionlens.importTranscript", () => runInSidebar("import")),
    vscode.commands.registerCommand("sessionlens.exportVerdicts", () => runInSidebar("exportVerdicts")),
    vscode.commands.registerCommand("sessionlens.openSession", () => openSessionPick(context)),
    vscode.commands.registerCommand("sessionlens.openSettings", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", "@ext:" + context.extension.id),
    ),
    vscode.commands.registerCommand("sessionlens.renameSession", (arg) => renameSession(context, arg)),
    vscode.commands.registerCommand("sessionlens.deleteSession", (arg) => deleteSession(context, arg)),
  );
  // phase 6: a change in Settings (by hand, from another window, Settings Sync) reaches every page like a panel save
  if (vscode.workspace.onDidChangeConfiguration) {
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        const which = Object.keys(CONFIG_SETTINGS).filter((k) => e.affectsConfiguration(CONFIG + "." + k));
        if (!which.length) return; // the CLI paths are read when a CLI starts
        host.log("settings changed: " + which.map((k) => "sessionlens." + k).join(", "));
        configuredSettings(true);
        broadcastRefresh(null, { scope: "keys" });
      }),
    );
  }
  context.subscriptions.push(vscode.window.registerWebviewPanelSerializer("sessionlensSession", new SessionPanelSerializer(context)));
  if (process.env.SESSIONLENS_TEST === "1") return testApi(context); // phase 7 (7B.8): only for test-integration/
}

/* What the integration tests (a real VS Code, test-integration/) need and cannot reach from outside: the globalState,
   running the migrations again, and sending a message the way a webview does (the webview itself is out of reach). */
function testApi(context) {
  return {
    context,
    host,
    runMigrations: () => runMigrations(context),
    async send(type, payload) {
      /** @type {(msg: object) => Promise<void>} */
      let handler = async () => {};
      const replies = [];
      wireMessages(context, {
        onDidReceiveMessage: (cb) => {
          handler = cb;
          return { dispose() {} };
        },
        postMessage: (m) => {
          replies.push(m);
          return Promise.resolve(true);
        },
        asWebviewUri: (u) => u,
      });
      await handler({ __sl: true, id: 1, type, payload });
      const r = replies.find((m) => m && m.__slReply && m.id === 1);
      return r ? r.result : undefined;
    },
  };
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
  _test: {
    setReadyTimeout(ms) {
      readyTimeoutMs = ms;
    },
  },
};
