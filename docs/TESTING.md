# SessionLens for VS Code — tests

This document describes the test suite as it stands at **v0.1.113**: how to run it, how it is built, what each file
checks, how the snapshots work and how to add a test. It is written for developers and coding agents who change the
code and need to know which tests guard the part they touch.

The overview of the whole extension is [`ARCHITECTURE.md`](ARCHITECTURE.md); its section 8 shows where the tests sit
in the build and release flow. The check registry, the lint engines, calibration, storage and the trust boundary are
described in depth in [`RULES-ARCHITECTURE.md`](RULES-ARCHITECTURE.md); its §12 is the checklist for adding a check.

Contents

1. [Commands](#1-commands)
2. [Test layers](#2-test-layers)
3. [Test harnesses](#3-test-harnesses)
4. [What each test file checks](#4-what-each-test-file-checks)
5. [Snapshots](#5-snapshots)
6. [Integration tests in a real VS Code](#6-integration-tests-in-a-real-vs-code)
7. [Performance measurements](#7-performance-measurements)
8. [Writing a new test](#8-writing-a-new-test)
9. [CI](#9-ci)
10. [Known issues](#10-known-issues)

---

## 1. Commands

All of these must pass before a commit (see `CLAUDE.md`). CI runs them on Ubuntu, Windows and macOS with Node 22.

| Command | What it does | Time (local) |
|---|---|---|
| `npm test` | Unit and DOM tests: `node --test "test/**/*.test.js"` | about 12 s |
| `npm run lint` | ESLint on our own code, tests and perf scripts included | a few s |
| `npm run format:check` | Prettier on every `.js` file (`npm run format` fixes) | a few s |
| `npm run typecheck` | `tsc -p .` with `checkJs` on the host and `media/*.js` (tests are not type-checked) | a few s |
| `npm run build:check` | `media/app.js` is exactly what `src/webview/` builds to | about 1 s |
| `npm run check:vsix` | The files `vsce` would package match an allow-list | a few s |
| `npm run test:integration` | The extension in a real VS Code (section 6) | longer; downloads VS Code once |

Useful variants:

```sh
node --test test/config-weakened.test.js               # one file
node --test --test-name-pattern="Cypress" "test/**/*.test.js"   # tests whose name matches
SL_UPDATE_SNAPSHOTS=1 npm test                          # rewrite two of the snapshots (section 5)
SL_PRINT_MAPPING=1 node --test test/rule-mapping.test.js   # print what the rules review cases report now
env -u ELECTRON_RUN_AS_NODE npm run test:integration    # integration tests from VS Code's own terminal
```

At v0.1.113 `npm test` runs 239 tests in 34 files. One test is always skipped: `test/cli.test.js` has one case for
Windows only and one for every other OS.

There are no runtime dependencies. The tests use only dev dependencies: `jsdom` for the panel, `@vscode/test-electron`
for the integration run, and Node's own `node:test` and `node:assert/strict`.

---

## 2. Test layers

```mermaid
flowchart TB
  subgraph L1["1. Analysis core in Node"]
    direction LR
    C1[media/lens.js · checks.js · rules.js<br/>spec.js · lint.js · i18n.js]
    C2[real lint engines:<br/>ESLint bundles via vm,<br/>tree-sitter .wasm, Robot]
  end
  subgraph L2["2. Host under a fake vscode module"]
    H1[extension.js · store.js · validate.js<br/>secrets.js · providers.js · cli.js]
    H2[test/fake-vscode.js]
    H2 --- H1
  end
  subgraph L3["3. Real panel in jsdom, wired to the real host"]
    P1[media/sidepanel.html + scripts<br/>app.js · vscode-bridge.js]
    P2[test/host-panel.js]
    P2 --- P1
    P1 <-->|messages| H1
  end
  subgraph L4["4. Real VS Code"]
    V1[test-integration/suite.js<br/>@vscode/test-electron]
  end
  L1 --> L3
  L2 --> L3
  L3 -. what only VS Code can show .-> L4
```

1. **Analysis core.** The modules in `media/` are UMD files. Node loads them with `require()` without a build, the
   same files the panel loads. Most check tests build a small transcript, import it with `Lens.importAny` and run
   `Lens.runChecks` on it. Some tests also load the real lint engines in Node.
2. **Host.** `extension.js` runs under `node --test` with a fake `vscode` module, a fake extension context
   (`globalState`, `SecretStorage`, a temporary `globalStorageUri`) and a fake webview that records what the host
   posts back. These tests send panel messages to the host and check what it stores, writes and replies.
3. **Panel and host together.** The real `sidepanel.html` and its scripts run in jsdom. They talk through the real
   `vscode-bridge.js` to the real `extension.js` under the fake `vscode`. This is the VS Code code path end to end,
   without VS Code. Render snapshots, storage, calibration, demo and XSS tests run here.
4. **Real VS Code.** A short suite runs inside a downloaded VS Code. It covers only what the fake cannot show:
   activation, registered commands, view order, migrations through the real `globalState` and settings, a real tab,
   and refusals at the message boundary.

---

## 3. Test harnesses

All helpers live in `test/` next to the tests. They are plain modules, not test files, so `node --test` does not run
them on their own.

| File | What it gives a test |
|---|---|
| `test/helpers.js` | `load()` returns `{ I18N, Lens, LensRules, M }` with the language set to English, the way the panel sees them as globals. `M(file)` is a path in `media/`, `root` is the repository root. |
| `test/fake-vscode.js` | `fakeVscode(opts)`: just enough of the `vscode` module for `extension.js` to activate. It records every dialog, message, command, file write, clipboard write, settings update and Output line in `calls`. `opts` sets the answers to modals, quick picks, input boxes and file dialogs, the starting settings, the VS Code language and failures (`configFails`). Machine-scoped settings ignore workspace values, as in VS Code. Also `loadExtension(vscode)`, `fakeContext()`, `fakeMemento()`, `fakeSecretStorage({ failStore })` and `fakeWebviewView()` with `send(type, payload)` that waits for the host's reply. |
| `test/host-panel.js` | `bootHost(opts)` loads a fresh copy of `extension.js` with the fake `vscode` and calls `activate()`. `openPage(host, { sessionId })` opens the sidebar, or a session tab when a `sessionId` is given, loads the real panel into jsdom and wires both directions. The page object has `sent` (page to host), `posted` (host to page), `errors` (page errors and any `alert()`), `idle()` (waits until no reply is pending), `ready()` and `close()`. `opts.patchApp` rewrites `app.js` before it runs (used by the XSS mutation tests). `opts.root` loads another checkout (used by `perf/`). |
| `test/engine-stub.js` | `stubEngineLoader(window, opts)`: the panel loads lint engines on demand by appending `<script>` tags, which jsdom does not run. The stub records each requested file in `engineLoads` and fires `load` on the next tick. `opts.engines` maps a file to source code to evaluate (a stub or the real file), `opts.engineError` makes a load fail and `opts.engineHold` delays loads. `fakeTreeSitterEngine()` is a stand-in tree-sitter engine with a boot delay. |
| `perf/fixtures.js` | `makeFixture({ n, bytes, seed })`: deterministic synthetic sessions in the 0.1.100 storage format, with findings and verdicts set so that calibration is active. Used by the render, storage, profile and calibration tests and by the perf scripts. |

Panel tests should end with `assert.deepEqual(page.errors, [])` so that a script error in the page fails the test.

---

## 4. What each test file checks

### 4.1 Checks and the analysis pipeline (Node)

| File | What it guards |
|---|---|
| `rules-consistency.test.js` | Every check name a detector can emit is in `media/checks.js`; every registry entry is complete, still has a detector, has rule text and a group label; `SUPERSEDES` and the AI categories agree with the registry; the tables in `rules.js` are derived from it. This test tells you what you forgot when adding a check. |
| `supersedes.test.js` | `LensLint.merge()` drops a regex finding only when the profile's own engine looks for the same thing. Real engines for Java, C#, Python, Cypress, Detox and Playwright. Every engine rule reported under a `SUPERSEDES` name must be decided here. |
| `rule-mapping.test.js` | The cases from the phase 10 rules review (duplicates, engine rules under another check's name, gaps), run through the same chain as `analyzeNow()` with the real engines. A change in what a case reports shows up as a change of the expected table. |
| `finding-pipeline.test.js` | One finding per source (regex, Robot engine, Gherkin, spec, model) through detector → `LensRules.apply` → `Lens.sortFindings`: severity, group, rule text, sort priority, disabled checks, manual severity, `calibLevel()` thresholds, `fromJson()` reporting ignored rows, warnings for unknown check names. |
| `calibrate.test.js` | `Lens.calibrate()` per pair of check and source: what may be hidden or demoted, what is never calibrated (`no_spec`, `spec_uncovered`, model findings), too few verdicts, and a check ticked on by hand. |
| `test-deleted.test.js` | `test_deleted`: a test removed from a file or deleted with its file (`rm`, `git rm`, a folder, a Codex patch, the first `Edit` of an existing file). Renames, moves, restores and `rm` of non-test files do not count. |
| `product-code-edited.test.js` | `product_code_edited`: product code changed in a testing task, high right after a red run. Test-side code inside `src`, runner configs, other folders and files the approved plan names do not count. |
| `snapshot-overwritten.test.js` | `snapshot_overwritten`: an update flag on a test run, or a snapshot or approval file written by hand. `git push -u` and plain runs do not count. |
| `config-weakened.test.js` | `config_weakened`: retries raised, timeouts made longer, tests excluded, compared with the previous version of the config. Shorter timeouts, fewer retries and unrelated edits do not count. |
| `secrets-in-tests.test.js` | `hardcoded_secret` and `hardcoded_base_url` in the web and mobile profiles; runner configs, relative URLs, typed values, environment variables and placeholders do not count; Java, C# and Python unchanged. |
| `spec-extract.test.js` | Which tests the specification coverage finds, for every visible profile and every file extension it declares: Kotlin names in backticks, Robot documentation links, comments above a test, `describe` and hooks that are not tests, `test.skip` after a test. |
| `profile-info.test.js` | `Lens.profileInfo()` for every profile (snapshot), its agreement with the structures it comes from, and the "What this profile checks" block in the panel. |
| `book-snapshot.test.js` | `LensRules.book({})`, the rule book, against its snapshot. |
| `i18n-plural.test.js` | `{n\|one\|other}` picks the right word for a count; no dictionary string puts a plural word right after a placeholder ("1 sessions"). |
| `lazy-engines.test.js` | Lint engines load on demand, per language, only where a session is analyzed; with the real engines, `run()` reports exactly what the snapshot recorded; engine failures, pending sessions, the one-time repair of 0.1.101 sessions, ESLint switched off. |

### 4.2 The panel with the host (jsdom)

| File | What it guards |
|---|---|
| `render-snapshot.test.js` | Every sidebar view and a session tab for four profiles render the markup the snapshot recorded, and the render is the same on two runs. |
| `panel-storage.test.js` | The sidebar starts from session summaries only; a tab loads only its own session; a verdict writes exactly one session; a Rules checkbox writes once and re-analyzes in the right places; a conflicting write from another window is merged. Also the Calibration snapshot. |
| `calibration-loop.test.js` | A check switched off by calibration stays off when sessions are analyzed again (regex and an engine check). |
| `calibration-ui.test.js` | The Calibration table per check and source, "on by hand" and the ⓘ mark on the Rules tab, the source in a session's line of disabled checks. |
| `demo-session.test.js` | "Try a demo session": the demo transcript has no real data; the button imports it with its name, profile and spec; the findings the readme, screenshots and GIF show; a second click opens the same session; the demo is left out of calibration; the setting that hides the button. |
| `xss.test.js` | A markup payload in every stored string (transcript, model answer, imported file) renders as text: no new element, no `on*` attribute. Mutation tests remove one `esc()` call from `app.js` and check that the test notices. |

### 4.3 The host and the message boundary (fake `vscode`)

| File | What it guards |
|---|---|
| `validate.test.js` | `validate.js`: every message type with a good payload and at least one bad one; the storage whitelist and tab list match `app.js`; `isInside` and `safeBasename`. |
| `trust-boundary.test.js` | What a compromised webview can no longer make the host do: run a CLI from a path in the payload, write outside a picked folder, send a request to a payload's base URL, change an address without a modal, store unknown keys. |
| `host-messages.test.js` | API keys move to `SecretStorage` at activation and never reach `globalState`, a webview reply or an error text; `ai:call` adds the key on the host side; closing a view aborts its request; the CSP. |
| `secrets.test.js` | `secrets.js`: the move of keys out of settings for each provider, keychain failure, a second run, `status()` with booleans only. |
| `providers.test.js` | `providers.js`: URL, key header and body for each HTTP provider; fixed endpoints; HTTP 429; redaction of an echoed key; timeouts and aborts; `nodeFetch` redirects and connection errors; an end-to-end call against a local fake server. |
| `cli.test.js` | `cli.js`: how a `.cmd`/`.bat` CLI is started through `cmd.exe`, refusal of anything `cmd.exe` could read as more than text, the system prompt file. The real Windows run happens only on `windows-latest`. |
| `store.test.js` | `store.js` on a real temporary folder: put, get, list, delete; conflicts by revision; summaries; schema rebuild; file names that never leave the folder; repair of an interrupted write; retries on `EPERM`/`EBUSY`; no interleaved writes. |
| `storage-migration.test.js` | The move of `globalState["sessions"]` into files: unchanged sessions, a second start, a failed migration resumed later, a tab restored during the migration, the `session:*` messages. |
| `vscode-integration.test.js` | `package.json` contributions and `package.nls.json`; English host strings whatever the VS Code language; the five settings in VS Code Settings (overlay, write, migration, outside changes); the Sessions tree and its commands; palette commands; the `page:ready` channel; the Output channel never logs transcript text or prompts. |
| `bridge-timeout.test.js` | `vscode-bridge.js` gives up on a reply after a limit per message type and resolves with `bridge-timeout`; dialogs and local model servers have no limit; the limits match the host's. |
| `ai-transport.test.js` | `ai.js` in the VS Code build: model requests go through the host transport, the payload carries no key, 429 retries, `no_key`, CLI providers never use HTTP. |

### 4.4 Repository and release

| File | What it guards |
|---|---|
| `release-notes.test.js` | `scripts/release-notes.js`: a bad tag, a tag that does not match the version and a missing CHANGELOG section are refused; the release body; the current version has its CHANGELOG section. |
| `issue-template.test.js` | The "False or missed finding" issue form lists every profile in the panel's order, and the readme links to it. |

---

## 5. Snapshots

Five tests compare their output with files in `test/__snapshots__/`. A snapshot changes only when the task changes
user-visible output on purpose. The update goes in a commit of its own, and the commit message and pull request say
what changed and why (see `CLAUDE.md`). Before committing, read the diff of the snapshot and make sure only the
intended rows changed. A snapshot that changes without a reason is a regression.

| Snapshot | Test | What it records | How to update |
|---|---|---|---|
| `render-v0103.json` | `render-snapshot.test.js` | Normalized markup of every sidebar view and of a session tab per profile (dates, times and "ago" counters replaced by markers) | `SL_UPDATE_SNAPSHOTS=1 npm test` |
| `profile-info-v0104.json` | `profile-info.test.js` | `Lens.profileInfo()` for every profile | `SL_UPDATE_SNAPSHOTS=1 npm test` |
| `book-en.json` | `book-snapshot.test.js` | The rule book `LensRules.book({})`, without the rows in the test's `ADDED` set | `UPDATE_SNAPSHOT=1 node --test test/book-snapshot.test.js` |
| `calib-v0100.json` | `panel-storage.test.js` | Calibration: the precision table, the proposed rules and the Rules list, rendered from the perf fixture | `node perf/snapshot-calib.js . > test/__snapshots__/calib-v0100.json` |
| `lint-v0101.json` | `lazy-engines.test.js` | What `LensLint.run()` reports with the real engines, one small session per language | `node perf/snapshot-lint.js . > test/__snapshots__/lint-v0101.json` |

Things to know:

- **`SL_UPDATE_SNAPSHOTS=1` updates only two of the five.** The rule book uses its own variable, `UPDATE_SNAPSHOT`,
  and the last two are written by scripts in `perf/`. A change to a check usually touches the first four; the commits
  of phase 10 (for example `c66bdec`) were made with all three methods.
- The version in a file name is the version the snapshot was first taken at, not the current one. The headers of the
  two perf scripts still say "a 0.1.100 checkout" and "a 0.1.101 checkout"; today both are run with `.` (the current
  checkout) and give the committed files unchanged.
- `render-v0103.json` and `profile-info-v0104.json` are also written when the file is missing. Do not delete a
  snapshot to make a test pass.
- `rule-mapping.test.js` and `demo-session.test.js` keep their expected values in the test file instead of a snapshot.
  When a check changes on purpose, edit the expected table there. `SL_PRINT_MAPPING=1` prints the current mapping. A
  change in the demo findings also means the readme screenshots and the GIF need a look.

---

## 6. Integration tests in a real VS Code

`npm run test:integration` runs `test-integration/run.js`. It downloads VS Code into `.vscode-test/` on the first run
(stable by default, or `SL_VSCODE_VERSION`), starts it with a fresh user-data folder and `--disable-extensions`, and
loads `test-integration/suite.js` into the extension host. With `SESSIONLENS_TEST=1`, `activate()` returns a test API
(`testApi()` in `extension.js`) with the host, the context, `runMigrations()` and `send()`.

The suite has no test framework: each case is a plain async function, and a failed case fails the process. It has
seven cases:

1. The extension activates and returns the test API.
2. Every contributed command is registered.
3. The panel is above the Sessions tree.
4. Sessions in the 0.1.100 `globalState` format migrate into files.
5. The five panel settings move into VS Code settings (the 0.1.102 format).
6. A session opens in its own tab.
7. The host refuses what `validate.js` refuses.

Everything else about VS Code stays in the unit tests on `test/fake-vscode.js`. Add a case here only for behavior the
fake cannot reproduce.

On Linux the suite needs a display: CI runs it under `xvfb-run -a`. From VS Code's integrated terminal, unset
`ELECTRON_RUN_AS_NODE` first (see section 1), or the downloaded VS Code starts as plain Node.

---

## 7. Performance measurements

`perf/` is not part of `npm test`. `npm run perf` runs `perf/run.js` on 200 synthetic sessions of 1 MB each, five
times, through the real panel and host in jsdom. It measures the sidebar start, one verdict, one Rules checkbox, one
analysis and opening the store. `--root <checkout>` measures another checkout with the same harness, so two versions
can be compared on the same fixture. Use it when a change touches storage, summaries or analysis on many sessions.

The two snapshot scripts `perf/snapshot-calib.js` and `perf/snapshot-lint.js` are described in section 5.

---

## 8. Writing a new test

### 8.1 Where it goes

| You change | Add or update |
|---|---|
| A check or its detector | A `test/<check>.test.js` with a transcript builder (below): cases that must be reported, with severity and message, and cases that must not. `rules-consistency.test.js` tells you what else is missing; the full checklist is [`RULES-ARCHITECTURE.md`](RULES-ARCHITECTURE.md) §12. Then the snapshots (section 5). |
| An engine rule | `supersedes.test.js` if the rule reports under a `SUPERSEDES` name; `rule-mapping.test.js` if a review case changes; `lint-v0101.json` if the engine output changes. |
| A profile | `spec-extract.test.js` for its file types, `profile-info.test.js`, `issue-template.test.js`, snapshots. |
| A message type | `validate.test.js` (one good and at least one bad payload) and `trust-boundary.test.js` if the message can make the host write, run or send anything. |
| A provider | `providers.test.js` and `ai-transport.test.js`. |
| A setting | `vscode-integration.test.js`. |
| Storage | `store.test.js`; `storage-migration.test.js` if the stored format changes. |
| Something rendered in the panel | A panel test through `test/host-panel.js`; `xss.test.js` if the text can come from a transcript, a model or an imported file. |

### 8.2 The transcript builder

Check tests build a Claude Code transcript from short steps instead of keeping fixture files. The pattern, as in
`config-weakened.test.js`:

```js
const { load } = require("./helpers");
const { Lens } = load();

// steps: ["write", file, content] | ["edit", file, old, new] | ["bash", command, output]
function transcript(steps) {
  const L = [JSON.stringify({ type: "user", message: { role: "user", content: "Write the tests" } })];
  steps.forEach(([kind, a, b, c], i) => {
    const id = "t" + i;
    const input = kind === "write" ? { file_path: a, content: b } : kind === "edit" ? { file_path: a, old_string: b, new_string: c } : { command: a };
    const name = kind === "write" ? "Write" : kind === "edit" ? "Edit" : "Bash";
    L.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } }));
    L.push(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: kind === "bash" ? b : "ok" }] } }));
  });
  return L.join("\n");
}
const found = (profile, steps, check) => {
  const cfg = Lens.profile(profile);
  return Lens.runChecks(Lens.importAny(transcript(steps), cfg), cfg)
    .filter((f) => f.check === check)
    .map((f) => `${f.severity}: ${f.message}`);
};
```

A failing run is a `["bash", "npx playwright test", "2 passed, 1 failed"]` step. Compare whole lists of
`severity: message` strings with `assert.deepEqual`, so that an extra finding fails the test as well as a missing one.

### 8.3 House rules for tests

- **A regression test must fail without the fix.** Run it against the code before the fix and see it fail, then
  apply the fix.
- Test names describe the behavior in plain words ("a check switched off by calibration stays off…"). A comment at the
  top of the file says what is checked and what must not count.
- Use `node:test` and `node:assert/strict`. No new test dependencies without a written reason.
- Use made-up data only: no real paths, hosts, names or keys. `demo-session.test.js` checks this for the demo.
- Tests run on Windows, macOS and Linux. Build paths with `path.join`, compare URIs with `/`, and skip a case with
  `{ skip: process.platform … }` only when it is about one OS.
- Each test gets a fresh host and a fresh temporary folder (`fakeContext()` makes one). Do not share state between
  tests through module globals.
- Check what our code writes, not what VS Code's `globalState` returns afterwards (section 10).
- Never edit `media/app.js` to make a test pass; change `src/webview/` and run `npm run build`. The panel tests load
  `media/app.js`, so until you rebuild they test the old code; `npm run build:check` catches a stale file.

---

## 9. CI

`.github/workflows/ci.yml` runs on every push to `main` and every pull request, on `ubuntu-latest`, `windows-latest`
and `macos-latest` with Node 22, without fail-fast. The steps are: `npm ci`, lint, format check, typecheck,
build check, `npm test`, the integration tests (under `xvfb-run` on Linux), `check:vsix`, and packaging. The Ubuntu
job uploads the `.vsix` as the `sessionlens-vscode-vsix` artifact, which the owner installs to review a draft pull
request.

`.github/workflows/release.yml` runs the same checks again on a version tag before it publishes.

---

## 10. Known issues

- **The integration run sometimes hangs on a CI runner** when VS Code starts. Re-run the failed job.
- **VS Code's `globalState` can return an old value after a write.** Seen on CI in about 3 of 30 jobs in the settings
  migration case. The test therefore checks the values the migration wrote, and puts the host log into the failure
  message.
- **Integration tests from VS Code's terminal** fail to start unless `ELECTRON_RUN_AS_NODE` is unset.
- **Windows-only behavior** (`cmd.exe` quoting, antivirus `EPERM`/`EBUSY` on rename, paths with spaces and non-ASCII
  names) is tested for real only on the Windows CI job. On macOS and Linux those cases are either simulated or skipped.
