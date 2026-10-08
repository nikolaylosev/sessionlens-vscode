# SessionLens for VS Code — tests

This document describes the test suite as it stands at **v0.1.122**: how to run it, how it is built, what each file
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
| `npm test` | Unit and DOM tests: `node --test "test/**/*.test.js"` | about 14 s |
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
SL_UPDATE_SNAPSHOTS=1 npm test                          # rewrite the snapshots (section 5)
SL_PRINT_MAPPING=1 node --test test/rule-mapping.test.js   # print what the rules review cases report now
env -u ELECTRON_RUN_AS_NODE npm run test:integration    # integration tests from VS Code's own terminal
```

At v0.1.122 `npm test` runs 550 tests in 78 files. Off Windows, `cli.test.js` skips its `.cmd` case. On Windows that
case runs, and the file skips five POSIX cases instead: the `runClaude` prompt, both `runCursor` cases,
`cursorSocketDir` and `checkCursor`. `transcript-dialog.test.js` skips its symlink case on Windows too.

There are no runtime dependencies. The tests use only dev dependencies: `jsdom` for the panel, `@vscode/test-electron`
for the integration run, and Node's own `node:test` and `node:assert/strict`. Detector tests give the checks in
`media/checks.js` must-report and must-not cases on a transcript, run the real engine for an engine-only check, and pass
the model categories through `LensAI.parseFindings`.

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
    H1[extension.js · store.js · validate.js<br/>secrets.js · providers.js · cli.js · cursor-db.js]
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
| `test/fake-vscode.js` | `fakeVscode(opts)`: just enough of the `vscode` module for `extension.js` to activate. It records every dialog, message, command, file write, clipboard write, settings update and Output line in `calls`. `opts` sets the answers to modals, quick picks, input boxes and file dialogs, the starting settings, the VS Code language and failures (`configFails`). Machine-scoped settings ignore workspace values, as in VS Code. Also `loadExtension(vscode)`, `fakeContext()`, `fakeMemento()`, `fakeSecretStorage({ failStore })`, `fakeWebviewView()` with `send(type, payload)` that waits for the host's reply, `createQuickPick()` driven by `opts.quickPickFlow(qp, person)`, `createTreeView()` (its options in `registered.treeViews`), `DataTransfer` (0.1.124), and `treeSessions(tree)`, the session items of the Sessions tree in the order shown, through its groups (0.1.124). |
| `test/host-panel.js` | `bootHost(opts)` loads a fresh copy of `extension.js` with the fake `vscode` and calls `activate()`. `openPage(host, { sessionId })` opens the sidebar, or a session tab when a `sessionId` is given, loads the real panel into jsdom and wires both directions. The page object has `sent` (page to host), `posted` (host to page), `errors` (page errors and any `alert()`), `idle()` (waits until no reply is pending), `ready()` and `close()`. `opts.patchApp` rewrites `app.js` before it runs (used by the XSS mutation tests). `opts.root` loads another checkout (used by `perf/`). |
| `test/engine-stub.js` | `stubEngineLoader(window, opts)`: the panel loads lint engines on demand by appending `<script>` tags, which jsdom does not run. The stub records each requested file in `engineLoads` and fires `load` on the next tick. `opts.engines` maps a file to source code to evaluate (a stub or the real file), `opts.engineError` makes a load fail and `opts.engineHold` delays loads. `fakeTreeSitterEngine()` is a stand-in tree-sitter engine with a boot delay. |
| `test/cursor-fixtures.js` | Cursor's CLI `store.db` and the IDE's `state.vscdb`, built with `node:sqlite` in a temporary home, for `cursor-db.test.js` and `cursor-panel.test.js`. When this Node has no `node:sqlite`, `S` is null and those database cases are skipped. |
| `perf/fixtures.js` | `makeFixture({ n, bytes, seed })`: deterministic synthetic sessions in the 0.1.100 storage format, with findings and verdicts set so that calibration is active. Used by the render, storage, profile and calibration tests and by the perf scripts. |

Panel tests should end with `assert.deepEqual(page.errors, [])` so that a script error in the page fails the test.

---

## 4. What each test file checks

### 4.1 Checks and the analysis pipeline (Node)

| File | What it guards |
|---|---|
| `rules-consistency.test.js` | Every check name a detector can emit is in `media/checks.js`; every registry entry is complete, still has a detector, is named in at least one other test file, has rule text and a group label; `SUPERSEDES` and the AI categories agree with the registry; the tables in `rules.js` are derived from it. This test tells you what you forgot when adding a check. |
| `supersedes.test.js` | `LensLint.merge()` drops a regex finding only when the profile's own engine looks for the same thing. Real engines for Java, C#, Python, Cypress, Detox and Playwright. Every engine rule reported under a `SUPERSEDES` name must be decided here. |
| `rule-mapping.test.js` | The cases from the phase 10 rules review (duplicates, engine rules under another check's name, gaps), run through the same chain as `analyzeNow()` with the real engines. A change in what a case reports shows up as a change of the expected table. |
| `finding-pipeline.test.js` | One finding per source (regex, Robot engine, Gherkin, spec, model) through detector → `LensRules.apply` → `Lens.sortFindings`: severity, group, rule text, sort priority, disabled checks, manual severity, `calibLevel()` thresholds, `fromJson()` reporting ignored rows, warnings for unknown check names. |
| `calibrate.test.js` | `Lens.calibrate()` per pair of check and source: what may be hidden or demoted, what is never calibrated (`no_spec`, `spec_uncovered`, model findings), too few verdicts, and a check ticked on by hand. The edges: precision of exactly 30% demotes and does not hide, exactly 50% changes nothing; a demoted finding stays low after `LensRules.apply()`; `calibLevel()` treats `ok`/`fp` that are not numbers as no record; `hardcoded_secret` is never hidden or demoted (0.1.116). |
| `test-deleted.test.js` | `test_deleted`: a test removed from a file or deleted with its file (`rm`, `git rm`, a folder, a Codex patch, the first `Edit` of an existing file). Renames, moves, restores and `rm` of non-test files do not count. After a red run, a run whose output is not in the transcript (`output_missing`) makes the finding medium; one whose output could not be parsed is skipped, and the red run keeps it high (0.1.123). |
| `product-code-edited.test.js` | `product_code_edited`: product code changed in a testing task, high right after a red run. Test-side code inside `src`, runner configs, other folders and files the approved plan names do not count. After a red run, a run whose output is not in the transcript (`output_missing`) makes the finding medium; one whose output could not be parsed is skipped, and the red run keeps it high (0.1.123). |
| `snapshot-overwritten.test.js` | `snapshot_overwritten`: an update flag on a test run, or a snapshot or approval file written by hand. `git push -u` and plain runs do not count. After a red run, a run whose output is not in the transcript (`output_missing`) makes the finding medium; one whose output could not be parsed is skipped, and the red run keeps it high (0.1.123). |
| `config-weakened.test.js` | `config_weakened`: retries raised, timeouts made longer, tests excluded, failures ignored, compared with the previous version of the config: JS/TS configs, pytest, Maven, Gradle, `.runsettings`. Shorter timeouts, fewer retries, unrelated edits and the excludes of other Maven plugins or Gradle blocks do not count. After a red run, a run whose output is not in the transcript (`output_missing`) makes the finding medium; one whose output could not be parsed is skipped, and the red run keeps it high (0.1.123). |
| `secrets-in-tests.test.js` | `hardcoded_secret` and `hardcoded_base_url` in the web and mobile profiles; runner configs, relative URLs, typed values, environment variables and placeholders do not count; Java, C# and Python unchanged. |
| `tests-never-run.test.js` | `tests_never_run`: tests written in a file or shown in a message, and no run of the profile's runner, at the last step that wrote tests; a command that is not the runner is not a run. A red run, a run with output nothing could parse, code without a test and a session that wrote nothing do not count. A test script run through npm, pnpm or yarn (`npm run test:e2e`, `npm run cypress:run`) is a run, `npm run build` is not (0.1.121). A command that only lists the tests (`--list`, `--listTests`, `vitest list`, `--collect-only`, `--co`, `--list-tests`) is not a run; a list followed by a run, a pipe after a run, `--reporter=list` and `--cov` are (0.1.122). |
| `pass-claim-without-run.test.js` | `pass_claim_without_run`: the agent says tests pass with no run with a result in the 6 steps before (the boundary on both sides; reads, searches, other tools, git and other commands are not steps, 0.1.121), or while the last run was red, in English and Russian, also as "passed" or "passing". A green last run, the user's message, a message without a claim and a claim phrase inside another word ("bypassing", "проходить", 0.1.119) do not count. A run whose output the transcript does not have (`output_missing`, a Cursor import) is not reported (0.1.121). |
| `cursor-db.test.js` | `cursor-db.js` (0.1.121) on databases built in a temporary home (`cursor-fixtures.js`): the CLI's `store.db` in the root blob's order with exit codes, the IDE's `state.vscdb` in the composer's order, the database left as it was, the IDE's folder per platform; no output with a reason for another file name, no `node:sqlite`, an unknown format, a chat not there. |
| `cursor-panel.test.js` | A Cursor transcript picked in the real panel and host with the CLI's database in a temporary home: the runs get their results, `fix_after_fail_without_triage` appears, the session keeps the output, Back to regex parsing keeps it; the Output channel names the database, never the transcript. It picks **Cursor Agent** in the source prompt. The session keeps the transcript's folder name (`source_project`) and its paths are relative to the workspace, also after Back to regex parsing (0.1.122). |
| `shell-reads.test.js` | A shell command that only reads (`cat`, `sed -n`, `rg`, `ls`, `find`; 0.1.121) is a read in `Lens.metrics()` and for `peeked_at_src_before_plan`, also in the Codex `exec` harness; not a read: `sed -i`, `>`, `find -delete` / `-exec`, a command mixed with another one, `curl`, a quoted search pattern as a path. |
| `codex-import.test.js` | The Codex import: file changes as `patch_apply_end` (up to 0.154) and as an `item_completed` `FileChange` (0.155+, read since 0.1.121) give the same write and edit steps with the whole file, and `assert_weakened` sees the edit; a change written as both records counts once; a `FileChange` that did not complete changes nothing; a deleted file; a command in the `exec` harness is a test run with its result; a diff that ends with a line break keeps the line after each hunk (0.1.121); a 0.159 command with an unquoted `cmd` key, several commands in one snippet, and **Import again** pairing a stored bare `exec` step with its command; a command that only lists the tests is `run_other` (0.1.122); a file moved by a patch (`move_path`) is an edit of its new name, the next edit there has the whole file, and a test moved with its file is not `test_deleted` (0.1.122). |
| `cursor-import.test.js` | The Cursor Agent import (0.1.121), made-up JSONL: detection (Claude Code and Codex files stay on their paths), the user's text and `<timestamp>`, each tool as the event the checks read with Cursor's own name kept, Write and StrReplace rebuilt into the whole file, a deleted test, test runs without output (`tests_never_run` sees them, a claim after them is not reported); with the database's output, red then green runs and `fix_after_fail_without_triage`, and a Shell call matched to the next output with the same command. With the transcript's folder name the paths under the workspace are relative, others stay absolute, and without it (dropped, pasted) all do; the folder-name rule is the same as `cli.js`'s (0.1.122). |
| `session-origin.test.js` | Summary schema 4 (0.1.124): `Lens.transcriptOrigin` gives the agent and the project for each format `importAny` reads (Claude Code, Codex, a Cursor transcript with and without its folder name, the Cursor Agent CLI log, a claude.ai export, text) and agrees with the path `importAny` takes; a project with control characters is dropped. `Lens.sessionSummary` takes the agent stored at import, or the kept text for a session imported before, and ignores an agent not on the list; `openCount` leaves out verdicts on findings that are gone. |
| `cursor-stream-json.test.js` | The Cursor Agent CLI log (`stream-json`, 0.1.121), made-up lines: detection (Claude Code's stream-json, Claude Code and Cursor transcripts stay on their paths), each tool as an event with Cursor's name, whole files from an edit's before/after, an edit not applied, test runs parsed and red by exit code, a run with no result, times, `fix_after_fail_without_triage`; `unreadToolCalls`, and the panel asking before it imports a file whose tool calls it cannot read. |
| `assert-weakened.test.js` | `assert_weakened`: an assertion made weaker or a test with fewer assertions between two versions (two writes, a write and an edit, two messages) in TypeScript, Python and Java, at the later version; an assertion commented out counts as removed in TypeScript, Java, C# and Cypress (0.1.120), also inside a block comment on a line without a leading `*` (0.1.121). A first version, a stronger or equally strong assertion, weak before and after, an added assertion, a renamed test a change in another test, and an assertion commented out in both versions do not count. A long pair drops the start both lines share and shows the change, each side cut at 60 characters; a long truthiness line too (0.1.122). |
| `weak-assert.test.js` | `weak_assert`, the regex side: toBeDefined, toBeTruthy, `expect(true).toBe(true)`, Python `assert True`, a bare `assert x`, `is not None`, Java `assertNotNull`, `assertTrue(true)`, C# `Assert.NotNull` / `Assert.True(true)` / `Should().NotBeNull()`, Go `assert.NotNil` / `require.NotNil`; Cypress `.should('exist')` also in a file without `expect`; a file with none of the words assert, expect or `.should(` is scanned too: Go's `require.NotNil`, REST Assured's `statusCode(lessThan(…))`, Karate's `#notnull` (0.1.123); one finding per line, once across versions. Assertions on a value, commented-out lines and Python predicates (`is_*`, `has_*`, `exists()`) do not count (0.1.119). |
| `process-checks.test.js` | `fix_after_fail_without_triage`, `peeked_at_src_before_plan`, `assumption_instead_of_question`, `scope_creep`, `stop_markers_missing`, each with must-not cases next to the trigger: triage first, the user speaking, after the approval, a planned file, an approved plan. Since 0.1.119: a `src` folder deeper in the path (not test-side code or `node_modules`), a planned file under another prefix, a plan of `e2e/` files, PLAN only as a word. |
| `spec-checks.test.js` | `test_without_requirement` and `out_of_scope_tested` from `LensSpec.checks`, in English and Russian. An ID in the title or a comment above, a specification without IDs and no out-of-scope section do not count; nor, since 0.1.119, a keyword inside another word, one keyword in a body, a word a requirement uses, a common word. |
| `edit-churn.test.js` | `edit_churn`: a fifth write of one file; four writes, or five writes split across two files, do not count. |
| `user-frustration.test.js` | `user_frustration`: a short correction phrase, in English and Russian, or the same request twice (the same first 40 characters; a difference at the 40th is not a repeat). A long paste, two different requests and the phrase inside another word do not count. |
| `hardcoded-date.test.js` | `hardcoded_date`: a calendar date on an assertion line; a date outside an assertion and a commented-out assertion do not count (0.1.118). |
| `magic-number.test.js` | `magic_number`: a number on an assertion line, one finding per test listing up to four numbers, in TypeScript, Python, Java, C# and Cypress. 0, 1, 2, 100, HTTP status codes, numbers between -1 and 1, a number outside an assertion or inside a name, a comment on the line and a commented-out assertion do not count. |
| `duplicate-assert.test.js` | `duplicate_assert`: the same assertion line twice in one test; the same assertion in two tests, another value and commented-out lines (0.1.120) do not count. |
| `commented-out-code.test.js` | Commented-out code gives no finding in the nine checks that look for a pattern anywhere in a file (`sleep_or_skip_added`, `fragile_wait`, `focused_test`, `debug_leftover`, `expected_failure`, `mocked_service`, `mobile_raw_locator`, `hardcoded_coordinates`, `no_driver_teardown`), each with its live twin; `#` and `//` in a string, code after a block comment, Python's `//` and a TypeScript `#field` stay code. A line inside a block comment with no leading `*` is not code for the checks that read a file line by line (`weak_assert`, `hardcoded_date`, `magic_number`, `conditional_logic`, `hardcoded_base_url`, `response_time_assert`, `duplicate_assert`, `assertion_roulette`, `status_only_assert`, `no_negative_cases`; 0.1.121); a line with code keeps its comment for `magic_number`. Code in a Python docstring of a function, class or module, or in a `"""`/`'''` string used as a block comment, gives no `weak_assert`, `sleep_or_skip_added`, `hardcoded_date`, `magic_number` or `debug_leftover`; a `"""` string inside brackets, after `\` or with an `f` prefix stays code (0.1.122). |
| `sleep-or-skip-added.test.js` | `sleep_or_skip_added`, the regex side: a fixed delay with a number or a named constant (TypeScript, Python, Java, Cypress; not a lowercase variable), a skipped test, a retry, code in a message; not a delay under 100 ms, a wait on a route alias, retries in a runner config or `retries: 0`, product code (test-side code under `src` is still checked), the word "reruns" (only `reruns=N` and `--reruns N`), and one finding per file. Commented-out code, product code and the word "reruns" were found on 5 Oct 2026 and fixed in 0.1.121; commented-out code is in `commented-out-code.test.js`. |
| `fragile-wait.test.js` | `fragile_wait`, the regex side: `waitUntil: 'networkidle'` (medium), the other ways to wait for network idle in TypeScript, Python, Java and C# (worded apart), and an exact count (`.count()` with `toBe`, `toEqual`, `toStrictEqual`, Python's `==`, Java's and C#'s assertion libraries; low), in a file or a message; not another load state or `toBeGreaterThan`; the profiles that run it. |
| `expected-failure.test.js` | `expected_failure`: Playwright's `test.fail` (as a test, inside one, with a condition), Jest's `it.failing` / `test.failing`, and pytest's `xfail` (marker, strict, call; not the word), medium, one finding per file with the count; not a skip, an expected exception or `test.failures()`; commented out; the profiles that run it. |
| `focused-test-debug-leftover.test.js` | `focused_test` (`.only` and `.only.each` on a test, describe, context, `test.describe`; `fit`, `fdescribe` with a title; high, one per file naming the first line; not a method named `only` or `fit`) and `debug_leftover` (`page.pause`, `cy.pause`, `.debug()`, `browser.debug`, `debugger;`, `breakpoint()`, `pdb`/`ipdb.set_trace()`, also after `;`, `)` or `{`, Python's `page.pause()`; medium, one per kind; not a name containing debugger); commented out; the profiles that run them. |
| `conditional-logic.test.js` | `conditional_logic`: `if`, `for`, `foreach`, `while`, `switch`, `try` and `.forEach(…)` on a line inside a test (TypeScript, Python, Java, C#, Cypress), low, one per test naming the first line; not a ternary, a comprehension, `with`, a hook or a helper, a comment or a string, a Python module's code after a test; the profiles that run it. |
| `spec-facts.test.js` | `no_spec` and `spec_uncovered`, high, at the last step that wrote code: an ID in the title, a comment above, with a ticket prefix, in a Python docstring, in a snake_case or camelCase name, across files; the last version of a file counts; R10 does not cover R1; a specification without IDs gets no `spec_uncovered`; `refs` in each way. |
| `assertion-roulette.test.js` | `assertion_roulette`: Python and Java, three asserts with no messages; two asserts, messages, TypeScript and commented-out asserts (0.1.120) do not count. |
| `api-checks.test.js` | `status_only_assert`, `mocked_service`, `no_negative_cases`, `test_data_no_cleanup`, `response_time_assert` on qa-api, with a must-not case for each; a mocked local module and a logged response time do not count. A commented-out assertion neither hides a status-only test nor counts as a negative case (0.1.120). `test_data_no_cleanup` reads code, not comments: a commented-out POST is not one, and a commented-out `afterEach`, the word "cleanup" in a comment, a Python `#` comment or docstring is no cleanup (0.1.122). |
| `mobile-checks.test.js` | `mobile_raw_locator`, `no_driver_teardown` and `hardcoded_coordinates` on qa-mobile; the x/y form of a gesture in each client (0.1.119); accessibility id, `quit()` / `afterEach`, a tap on an element, single-digit arguments, `clickRow(15, 30)` and x/y outside a gesture do not count. |
| `gherkin-checks.test.js` | `outline_no_examples`, `bloated_background`, `duplicate_step_text`, `scenario_no_then` (no Then: high, one per scenario; Then with And after it and inside a Rule counts; a Then in the Background, a comment or a doc string does not; `*` steps are not judged); Russian keywords; the synonyms Example, Scenario Template, Scenarios. |
| `lint-mapped-checks.test.js` | Engine-only checks with the real engines: `positional_locator`, `no_app_reset`, `unannotated_test_method`, `swallowed_exception`, `assert_args_reversed`, `lint_valid_title`, `raw_locator`, `no_assertion_after_action` (Playwright, Detox, Java, C#, Robot; Robot's assertions of BuiltIn, SeleniumLibrary, Browser and the file's own keywords), `cypress_async_test` (the engine's async `it` and titled hook, the regex's other hooks, never both), `empty_test_case`, and the Playwright and Cypress rules mapped to `weak_assert`, with severity and message. |
| `ai-categories.test.js` | `parseFindings` maps every review category to `ai_<name>` and an unknown name to `ai_other`. |
| `spec-extract.test.js` | Which tests the specification coverage finds, for every visible profile and every file extension it declares: Kotlin names in backticks, Robot documentation links, comments above a test, `describe` and hooks that are not tests, `test.skip` after a test. |
| `profile-info.test.js` | `Lens.profileInfo()` for every profile (snapshot), its agreement with the structures it comes from, and the "What this profile checks" block in the panel. |
| `book-snapshot.test.js` | `LensRules.book({})`, the rule book, against its snapshot. |
| `i18n-plural.test.js` | `{n\|one\|other}` picks the right word for a count; no dictionary string puts a plural word right after a placeholder ("1 sessions"). No string in the dictionary writes a plural as "(s)" (0.1.122). |
| `lazy-engines.test.js` | Lint engines load on demand, per language, only where a session is analyzed; with the real engines, `run()` reports exactly what the snapshot recorded; engine failures, pending sessions, the one-time repair of 0.1.101 sessions, ESLint switched off. |

### 4.2 The panel with the host (jsdom)

| File | What it guards |
|---|---|
| `render-snapshot.test.js` | Every sidebar view and a session tab for four profiles render the markup the snapshot recorded, and the render is the same on two runs. |
| `panel-storage.test.js` | The sidebar starts from session summaries only; a tab loads only its own session; a verdict writes exactly one session; a Rules checkbox writes once and re-analyzes in the right places; a conflicting write from another window is merged. Also the Calibration snapshot. |
| `calibration-loop.test.js` | A check switched off by calibration stays off when sessions are analyzed again (regex and an engine check). |
| `calibration-ui.test.js` | The Calibration table per check and source, "on by hand" and the ⓘ mark on the Rules tab, the source in a session's line of disabled checks, `hardcoded_secret` as "not calibrated" with its reason. |
| `demo-session.test.js` | "Try a demo session": the demo transcript has no real data; the button imports it with its name, profile and spec; the findings the readme, screenshots and GIF show; a second click opens the same session; the demo is left out of calibration; the setting that hides the button. The demo's weakened assertion reads `….toHaveText("Invalid email or password"); → ….toBeVisible();`, as the README's GIF shows (0.1.122). |
| `pick-refused.test.js` | **Choose file** when the host refuses the pick (a source an older host does not know): a dialog gives the reason and suggests reloading the window; no file dialog, no import. **Import again** has the same case in `reimport.test.js`. |
| `rules-target.test.js` | The Calibration tab with `sessionlens.rulesTarget` set in the VS Code settings: for Cursor, the select, the title, **Copy** and the suggested stub are a `.mdc` file with `alwaysApply: true`; for Claude Code, plain Markdown as before. |
| `reimport.test.js` | **Import again**: which sessions show it (`Lens.needsReimport`; a Codex session with file changes imported before 0.1.121, not a Claude session of 0.1.113+), `Lens.transcriptMatch`; the same session gets the new findings and keeps its name, spec and verdicts; the file is picked again when no text was kept (the four sources are offered); another session's transcript and verdicts that would detach are asked about first. A session of 0.1.121 is offered it where the 0.1.122 import differs: a list-only command taken for a run, a Codex `move_path`, a weakened assertion cut at 40 characters (the demo too); a short pair, a real run and `move_path: null` are not (0.1.122). |
| `pick-conversation.test.js` | `Lens.pickConversation`: a session made from one conversation of a claude.ai export is parsed again from that conversation, whatever its place or title, also after segmentation; **Back to regex parsing** keeps it (until 0.1.115 it took the first one). |
| `rules-filter.test.js` | **Show checks for** on the Rules tab: the Sessions tab's profile by default, its checks plus the spec and model ones, no empty groups; a picked profile and All profiles are saved; an override of a hidden check stays. |
| `xss.test.js` | A markup payload in every stored string (transcript, model answer, imported file) renders as text: no new element, no `on*` attribute. Mutation tests remove one `esc()` call from `app.js` and check that the test notices. |

### 4.3 The host and the message boundary (fake `vscode`)

| File | What it guards |
|---|---|
| `validate.test.js` | `validate.js`: every message type with a good payload and at least one bad one; the storage whitelist and tab list match `app.js`; `isInside` and `safeBasename`. |
| `trust-boundary.test.js` | What a compromised webview can no longer make the host do: run a CLI from a path in the payload, write outside a picked folder, send a request to a payload's base URL, change an address without a modal, store unknown keys. |
| `transcript-dialog.test.js` | Where **Choose file** opens its dialog for each source: `~/.claude/projects`, `~/.codex/sessions`, and for Cursor Agent this workspace's `~/.cursor/projects/<slug>/agent-transcripts` (Cursor's slug rule, the first workspace folder that has one, a symlink by its real path), else `~/.cursor/projects`, else the home folder. |
| `host-messages.test.js` | API keys move to `SecretStorage` at activation and never reach `globalState`, a webview reply or an error text; `ai:call` adds the key on the host side; closing a view aborts its request; the CSP. |
| `secrets.test.js` | `secrets.js`: the move of keys out of settings for each provider, keychain failure, a second run, `status()` with booleans only. |
| `providers.test.js` | `providers.js`: URL, key header and body for each HTTP provider; fixed endpoints; HTTP 429; redaction of an echoed key; timeouts and aborts; `nodeFetch` redirects and connection errors; an end-to-end call against a local fake server. |
| `cli.test.js` | `cli.js`: how a `.cmd`/`.bat` CLI is started through `cmd.exe`, refusal of anything `cmd.exe` could read as more than text, the system prompt file. The real Windows run happens only on `windows-latest`. The Cursor CLI (0.1.121), with a fake `agent` and a fake home: the prompt on stdin, `--mode ask`, the deny list in the temp folder, Cursor's copy of the request removed and other chats kept, failures worded by code, `agent status` read by its text. |
| `store.test.js` | `store.js` on a real temporary folder: put, get, list, delete; conflicts by revision; summaries; schema rebuild (schema 3 → 4 gets the agent, project and `openCount`, 0.1.124); file names that never leave the folder; repair of an interrupted write; retries on `EPERM`/`EBUSY`; no interleaved writes. A second window's `open()` while the first one writes (0.1.120): a temporary file being written is left alone, an older one is removed; a summary the other window writes during a rebuild is kept. |
| `storage-migration.test.js` | The move of `globalState["sessions"]` into files: unchanged sessions, a second start, a failed migration resumed later, a tab restored during the migration, the `session:*` messages. |
| `reanalyze-after-update.test.js` | An update analyzes the stored sessions again: `Lens.ANALYSIS_VERSION` equals `package.json`'s version and is in the generation; a session analyzed by 0.1.115 gets the new findings; `Lens.carryVerdicts` moves a verdict to a reworded finding of the same check and step, and only then. Two findings of that check on one step keep the old key. |
| `sessions-tree.test.js` | The Sessions tree's groups (0.1.124), on the host with a fixed clock and local dates: by date (Today, Yesterday, This week from Monday, Earlier; `started` before `created`; the newest first; empty groups left out; a Monday), by profile, verdict and agent (Unknown agent with its tooltip; a value the setting does not have is by date), the title button's QuickPick and what it writes, a change of the setting from outside, an empty tree. The filter: text in any case over the name, task and profile, the row on top and its count, groups counting what it shows, Only Red, With findings without a verdict (by `openCount`, not the verdict count) and both, nothing matching, Escape, dropping the text, Clear filter and the context key. My groups: the order and No group, the menus of the groups, Move to group… (a new group, one there is, out of it, the switch to My groups, the name's checks), Rename group… and Delete group, drag and drop (onto a group, a session, No group; nothing outside My groups), the filter by a group's name. |
| `report-hidden.test.js` | What calibration hides is in Report .json (`hiddenByCalibration`, with precision and verdicts), in the PR report (high ones by name, the rest counted) and in the Sessions tree's line ("N hidden by calibration"); nothing extra when it hides nothing. |
| `source-tags.test.js` | Every finding shows one tag of its source (regex, lint, gherkin, spec, model), as the filter names it; a lint finding names the engine of its session's profile (eslint, tree-sitter, robot) and the filter says "lint"; every `var(--…)` in `styles.css` is defined for the light and the dark theme (`--teal` never was, until 0.1.117). |
| `rule-effect.test.js` | The effect of a rule moved to CLAUDE.md: the summary's `started` is the time of the first step with one; a session counts by when it ran, not when it was imported; the demo session and a profile that cannot report the check stay out. |
| `verdicts-roundtrip.test.js` | verdicts.json: the export includes the verdicts of hidden findings (`hidden: true`), the import puts them back on those findings, the same file imported twice keeps its rows once, an unknown verdict counts as none. |
| `vscode-integration.test.js` | `package.json` contributions and `package.nls.json`; English host strings whatever the VS Code language; the five settings in VS Code Settings (overlay, write, migration, outside changes); the Sessions tree and its commands; palette commands; the `page:ready` channel; the Output channel never logs transcript text or prompts. |
| `bridge-timeout.test.js` | `vscode-bridge.js` gives up on a reply after a limit per message type and resolves with `bridge-timeout`; dialogs and local model servers have no limit; the limits match the host's. |
| `ai-transport.test.js` | `ai.js` in the VS Code build: model requests go through the host transport, the payload carries no key, 429 retries, `no_key`, CLI providers never use HTTP. |
| `mask-for-model.test.js` | No secret reaches a model: the review (whole and per file), the verification, segmentation (whole and per message), Compress rules.md and Generate skill; `callModel()` masks a prompt that slipped through; a quote of a masked line stays grounded for the verifier. |
| `model-send-hints.test.js` | Every button that calls a model says on hover what it sends (`data-i18n-title`), and the README names each of them under "What a model call sends". |
| `model-in-findings.test.js` | A model finding records `model` from the review's route and `verifier` from the verification's (also on Verify again); `LensAI.modelLabel`; Report .json and verdicts.json carry both for model findings only. |

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

All five are updated with one command:

```sh
SL_UPDATE_SNAPSHOTS=1 npm test
git diff test/__snapshots__/      # only the intended rows may change
```

With the variable set, each snapshot test writes its file instead of comparing it, and passes. Run `npm test` once
more without the variable afterwards.

| Snapshot | Test | What it records |
|---|---|---|
| `render-v0103.json` | `render-snapshot.test.js` | Normalized markup of every sidebar view and of a session tab per profile (dates, times and "ago" counters replaced by markers) |
| `profile-info-v0104.json` | `profile-info.test.js` | `Lens.profileInfo()` for every profile |
| `book-en.json` | `book-snapshot.test.js` | The rule book `LensRules.book({})`, without the rows in the test's `ADDED` set |
| `calib-v0100.json` | `panel-storage.test.js` | Calibration: the precision table, the proposed rules and the Rules list, rendered from the perf fixture by `perf/snapshot-calib.js` |
| `lint-v0101.json` | `lazy-engines.test.js` | What `LensLint.run()` reports with the real engines, one small session per language, from `perf/snapshot-lint.js` |

Things to know:

- A change to a check usually touches the first four. The lint snapshot changes only when an engine or its rule map
  does. The lint test writes its file only if every engine ran, so a broken engine cannot be recorded as the new truth.
- Earlier the rule book used its own variable (`UPDATE_SNAPSHOT`) and the last two files were written by the
  perf scripts by hand. The scripts still print the same JSON (`node perf/snapshot-calib.js <checkout>`), which is
  useful to compare an older checkout with the current one.
- The version in a file name is the version the snapshot was first taken at, not the current one.
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
- **A detector test has must-not cases next to the trigger,** not only far from it (`jest.mock('./utils')` next to a
  mocked HTTP client). For a check an engine reports, run the real engine and compare severity and message too: the
  verdict key includes the start of the message. Behaviour that looks wrong is not pinned; the file's header names it
  and it gets its own fix.
- No coverage reporter: line coverage does not show that a detector is wrong on a transcript. Detector tests do.
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
