# Changelog

## 0.1.121

### Added
- **Cursor (subscription)** as a model provider: SessionLens runs the Cursor Agent CLI you have installed
  (`agent -p`), so a Cursor plan works without an API key. Choose it under ⚙ → **Add a model**; **Check Cursor CLI**
  shows the version and whether you are signed in. The path is the new machine setting `sessionlens.cursorCliPath`.
  The CLI has no switch that turns its tools off, so each request runs in its read-only ask mode, in an empty
  temporary folder whose `.cursor/cli.json` denies every shell command, file read, file write, web fetch and MCP tool.
  Cursor keeps a copy of every request in `~/.cursor`; SessionLens deletes the copy of each of its requests after the
  answer, including the folder Cursor names with a hash when the path is long. Tested on macOS; Windows and Linux are not tested yet.
- **Cursor Agent transcripts** can be imported: the `.jsonl` files in
  `~/.cursor/projects/<workspace>/agent-transcripts/<id>/`, written by the Cursor IDE and its CLI. **Choose file**
  has a fourth source, **Cursor Agent**, which opens the dialog in the open workspace's `agent-transcripts` folder
  (or in `~/.cursor/projects` when that workspace has none); **Import again** offers it too. The folder is found the
  way Cursor names it on macOS; Windows is not checked yet. Writes, edits (`StrReplace`), deleted files, reads,
  searches and test runs (`Shell`) become the same steps as in a Claude Code session, with Cursor's tool names, and the session starts at the
  time of the first request. Before, such a file gave an empty session. The file itself keeps no command output, so
  when you pick it with **Choose file**, SessionLens reads the output of the agent's commands from Cursor's own
  databases on your machine (`~/.cursor/chats/…/store.db` for the CLI, Cursor's `state.vscdb` for the IDE), read-only.
  Test runs then have their passed and failed counts, and the checks that need them work as for Claude Code (for
  example **Fix after a failure without triage**). Where there is no output (a file dropped or pasted, a VS Code
  without `node:sqlite`, a chat Cursor no longer has), a run's result is unknown and **Claims tests pass** is not
  raised after it. Cloud Agent runs leave no file on your machine.
- **Cursor Agent CLI logs** can be imported: the output of `agent -p --output-format stream-json`, for example from a
  CI job. The log has every tool call with its result, so written and edited files come whole (the file before and
  after each edit), and test runs have their output and exit code, without Cursor's databases. Before, such a log was
  taken for a Claude Code transcript and gave a session of messages only, with no code to review.
- A file with tool calls in a format SessionLens does not read now asks before it is imported: only its text would be
  kept, with no files, edits or test runs.
- **Rules for Cursor:** **Target file** on the Calibration tab (and the setting `sessionlens.rulesTarget`) has a new
  value, `.cursor/rules/sessionlens.mdc`, Cursor's own project rule. For it, **Copy** and the suggested stub under a
  Compress rules.md or Generate skill result start with the frontmatter Cursor needs (`alwaysApply: true`), so the
  text is the whole file and Cursor's Agent reads it in every chat of the project. `AGENTS.md` is now labelled as read
  by Cursor too, which it is.

### Changed
- The effect of a rule marked **Moved** on the Calibration tab shows its before / after chart from the start: until
  the first session after the move, the "after" row is empty. Before, only a line of text was shown then.
- The day a rule was moved can be changed next to its **Moved** mark. A session counts as "after" by when the agent
  ran it (since 0.1.116), so when the rule went into the file earlier than you pressed **Moved**, for example before
  you reviewed old sessions, every session stayed "before". While the "after" row is empty, the note says how many
  sessions imported after the mark ran before it.
- The empty Sessions list asks for a Claude Code, Codex or Cursor Agent transcript, and the note under a generated
  skill says Cursor reads the shared rules file too. The extension's description and keywords name Cursor, and the
  README tells how to install SessionLens in Cursor
  and VSCodium (from Open VSX) and to reload the window after installing a `.vsix`. The roadmap lists Cursor support as done. The README's links to the Detox,
  Java, C#, Python and Robot Framework checks lead to them again.
- Messages and hints no longer say "VS Code" where they mean the editor, since SessionLens also runs in Cursor: "the
  setting `sessionlens.claudeCliPath`" instead of "the VS Code setting", "this editor window is remote".

### Fixed
- **No assertion after action** in Robot Framework took only a keyword that starts with `Should` or `Must` for an
  assertion, so most UI tests got a high "nothing is actually verified": SeleniumLibrary's `Page Should Contain`,
  `Element Should Be Visible` or `Title Should Be`, a Browser `Get Text    id=total    ==    42`, or a call of the
  file's own keyword with an assertion inside. Now these count, and so do `Wait Until …`, `Run Keyword And Expect
  Error`, and keywords named `Verify …`, `Check …`, `Assert …`, `Validate …`, `Expect …` or `Ensure …`.
- **Requirement without a test** (`spec_uncovered`, high) no longer reports every requirement of a specification
  without IDs: written as plain sentences, its requirements cannot be named by a test. A test now names a requirement
  in a name written the language's way too: `test_r1_total` (Python), `testR1Total` (Java), `R1_Total` (C#).
- **Gherkin checks** read `.feature` files in Russian too (`# language: ru`: Функция, Сценарий, Структура сценария,
  Примеры, Дано, Когда, Тогда…): before, such a file gave no scenario and none of the four checks ran. The synonyms
  `Example:`, `Scenario Template:` and `Scenarios:` are read, the lines of a doc string are no longer taken for steps,
  and a scenario written with `*` steps is no longer reported for a missing Then, since `*` may stand for one.
- **Conditional logic** finds C#'s `foreach` and a loop written as a call (`rows.forEach(…)`, `list.ForEach(…)`), and
  no longer reports a Python module's own code after a test (`if __name__ == "__main__":` after a blank line).
- **Async Cypress test** (`cypress_async_test`, qa-cypress) finds an async hook the ESLint plugin misses: an
  untitled `before(async () => …)` / `beforeEach`, and any async `after` / `afterEach`. It runs with static analysis
  off too. An async `it()` and a titled `before("…", async …)` stay ESLint's, so no hook is reported twice.
- **Commented-out code no longer gives findings** in the checks that look for a pattern anywhere in a file: a
  commented-out sleep, skip or retry (**Sleep or skip added**), `networkidle` (**Fragile wait**), `.only`, a debugger
  call, `test.fail()`, a mocked service, a raw mobile locator, hard-coded coordinates, or a driver created without
  teardown never runs. Each of them gave a finding before, often high. Comments are read the way the file's language
  writes them (`#` in Python, `//` and `/* */` in TypeScript, Java and C#), and `#` or `//` inside a string is code.
- **A line inside a block comment** (`/* … */`) that does not start with `*` was read as code by the checks that
  read assertions line by line: a commented-out `expect(ok).toBeTruthy()` gave a high **Weak assertion** (`weak_assert`), and a date,
  a number or a repeated assertion in the comment gave **Hard-coded date**, **Magic number** or **Duplicate
  assertion**. Now it is a comment there too, as in **Conditional logic**, **Hard-coded base URL**, **Response time
  assertion**, **Assertion roulette**, **Status-only assertion**, **No negative cases** and **Assertion weakened**,
  where an assertion moved into a block comment now counts as removed (after **Import again** for a stored session).
- **Sleep or skip added** no longer reports product code: a delay or a retry in a file under the profile's source
  folders (for example `setTimeout` in `src/debounce.ts`) belongs to the product, not to a test. Page objects and other
  test-side code under `src` are still checked. In qa-python and qa-api, pytest's reruns count only with a number above
  0 (`reruns=3`, `--reruns 2`), not as the word "reruns" in a docstring or a comment.
- **Sleep or skip added** also finds a delay with a named constant: `page.waitForTimeout(DELAY)`,
  `time.sleep(WAIT_SECONDS)`, `Thread.sleep(Timeouts.SHORT)`, as the rule says "no sleep with a constant". A lowercase
  variable is still left alone, since a polling helper sleeps for its interval.
- **Fragile wait** finds the other ways to wait for network idle: `page.waitForLoadState("networkidle")`, and in
  Python, Java and C# (`wait_until="networkidle"`, `LoadState.NETWORKIDLE`, `LoadState.NetworkIdle`). In qa-python the
  check never fired before. An exact count is also found with spaces, `toEqual` or `toStrictEqual`, in Python as
  `assert rows.count() == 3`, and in Java and C# (`assertEquals(3, rows.count())`, `assertThat(…).isEqualTo(3)`,
  `Assert.AreEqual` / `Assert.Equal`, `Is.EqualTo(3)`, `.Should().Be(3)`).
- **Expected failure** finds Jest's `it.failing` / `test.failing`, and counts pytest's xfail only as the marker
  (`@pytest.mark.xfail`) or the call (`pytest.xfail(…)`). The word "xfail" in a docstring or a string gave a finding
  before.
- **Focused test** no longer takes a method named `fit` (`model.fit(data)`) for Jasmine's focused test, which gave a
  high finding, and finds Jest's `test.only.each`. **Debugging left in** finds `import pdb; pdb.set_trace()` on one
  line and `if (x) debugger;`, and in qa-python Playwright's `page.pause()`.
- **Claims tests pass** (`pass_claim_without_run`, high) looks for a test run in the 6 steps before the message, and
  counted every tool call as a step. After a run, an agent that read files, used a browser or MCP tools, or ran
  `git push` pushed the run out of the window, and its "all tests pass" got a high "no test run". Now reads, searches,
  other tools, git and other commands are not counted; writes, edits, test runs and messages are.
- **Codex sessions from Codex 0.155 and later** (the VS Code extension and the desktop app, since September 2026)
  had no file changes: Codex now records a change in another form, which SessionLens skipped. The session showed the
  messages and commands, but none of the files the agent wrote or edited, so the checks of the test code found
  nothing. Now both forms are read, and such a session shows **Import again**.
- **Codex sessions from Codex 0.159 and later** lost most of their commands, test runs included: Codex now writes
  them in a form SessionLens did not read. Such a session could get a high **Tests never run** although the agent ran
  them, and the checks that read a run's result saw none. Now every command is read, also when one step runs
  several. Such a session shows **Import again**.
- A **Codex** edit lost the line right after the changed lines: Codex ends its diffs with a line break, which was taken
  for one more line of the file. If that line was an assertion, the test seemed to have one fewer (**Assertion
  weakened**). A Codex session with edits shows **Import again** to read them again.
- A test run through an npm script was not seen as a test run: `npm run test:e2e`, `npm run test`, `pnpm run test`
  or `yarn run test` in the TypeScript, API, mobile and generic profiles, and `npm test` or `npm run cypress:run` in
  qa-cypress. The usual way to start Playwright in a project gave a high **Tests never run** or **Claims tests pass**
  after a run, and **Fix after a failure without triage** could not fire. The runners each profile knows are listed
  in **What this profile checks**.
- A shell command that only reads a file (`cat`, `sed -n`, `head`, `rg`, `ls`, `find`) was not counted as a read.
  Codex reads files that way, so a Codex session showed **reads 0** and a Read:Edit warning, and **Read product code
  before the plan** (`peeked_at_src_before_plan`) never fired for it, nor for `cat src/…` in a Claude Code or Cursor
  session. Now such a command is a read in the metrics, and reading product code with it before the plan is reported.
  A command that writes (`sed -i`, `>`, `find -delete`), one mixed with another command, and `curl` do not count.
  Saved sessions get this on their next analysis, without importing them again.
- **Choose file** and **Import again** did nothing when VS Code refused to open the file dialog or read the file, for
  example right after a new SessionLens `.vsix` was installed without reloading the window. Now a dialog says why and
  suggests reloading the window.

## 0.1.120

### Fixed
- **Magic number** (`magic_number`, low) skipped an assertion line with `#` or `//` anywhere in it, as if the line had
  a comment. So a CSS id selector (`page.locator("#total")`), a URL (`toHaveURL("https://shop.test/cart?page=7")`) or
  a private field (`this.#count`) hid every number on that line. Only a real comment counts now; a comment that
  explains the number still keeps the line from being reported. A commented-out assertion inside a `/* … */` block
  (`* expect(total).toBe(1499)`) was reported; it no longer is. Stored sessions are analyzed again after the update.
- With two VS Code windows open, starting the second one could make the first fail to save a session: the second
  deleted every unfinished temporary file in the sessions folder, including the one the first window was writing at
  that moment. Only temporary files older than a minute are deleted now. The second window could also overwrite the
  summary the first one had just written with an older copy, so the session was analyzed again for no reason; it
  now keeps the newer summary.
- A commented-out assertion still counted as an assertion in TypeScript, JavaScript, Cypress, Java and C# (Python was
  right). So **Assertion weakened** (`assert_weakened`, high) missed an agent commenting out an assertion, as in
  `// expect(items).toHaveLength(3)`, although it reported the same assertion deleted; it now reports "fewer
  assertions". A line that starts with `//`, `#`, `/*` or `*` is not an assertion any more in the other checks that
  count assertions either: `assertion_roulette` and `duplicate_assert` no longer count commented-out lines, and on
  qa-api a commented-out body check no longer hides `status_only_assert`, nor does a commented-out error status count
  as a negative case for `no_negative_cases`.

## 0.1.119

### Fixed
- **Claims tests pass** (`pass_claim_without_run`, high) was raised by words that only contain a claim phrase: "I am
  bypassing the cache" ("passing") or "Нужно проходить авторизацию" ("проходит"). A claim phrase now counts only as
  whole words. An English one may still end in -es, -ed or -ing, so "All tests passed" is still a claim. Stored
  sessions are analyzed again after the update.
- **Weak assertion** (`weak_assert`, high):
  - it was raised by a commented-out line such as `// expect(ok).toBeTruthy()`; comment lines are skipped now, as for
    `hardcoded_date` in 0.1.118;
  - in Cypress, `.should('exist')` was missed in a file that has no `expect` or `assert` in it, which is most Cypress
    tests; it is reported now;
  - in Python, a predicate such as `assert cart.is_empty()`, `assert user.is_active` or `assert path.exists()` counted
    as weak, although it checks a value; it no longer does. A bare `assert result` or `assert resp.json()` still counts.
- **Read product code before the plan** (`peeked_at_src_before_plan`, high) missed a `src` folder deeper in the path,
  as when Claude Code is started in a parent folder (`shop/src/cart.ts`). It is reported now, but not for test-side
  code or a dependency under such a folder (`shop/tests/lib/…`, `node_modules/…/lib/…`).
- **Edited a file not in the plan** (`scope_creep`) reported a planned file written with another prefix
  (`./tests/cart.spec.ts`, `shop/tests/cart.spec.ts`), and did not see a plan that names only `e2e/` or `cypress/`
  files. Both work now.
- A plan was recognised in any upper-case word that contains PLAN or ПЛАН, such as "EXPLANATION" or "PLANNED". PLAN and
  ПЛАН now count as a word; a requirement table still marks a plan. This affects the three plan checks
  (`stop_markers_missing`, `peeked_at_src_before_plan`, `scope_creep`).

### Changed
- **Literal screen coordinate** (`hardcoded_coordinates`, qa-mobile) no longer counts any call whose name starts with
  tap or click (`page.clickRow(15, 30)`), only the gesture calls themselves. It now also finds the x/y form of a
  gesture: `touchAction({ action: 'tap', x: 120, y: 340 })`, `tap(x=100, y=200)`, a `pointerMove`, `mobile:
  clickGesture`.
- **Out-of-scope item tested** (`out_of_scope_tested`) is stricter: an item's keywords skip common words ("через",
  "between") and words that a requirement uses, and they must start a word (`#overflows` is not "Refund flows"). One
  keyword in a test's name is enough; in its body all of them must appear.

## 0.1.118

### Fixed
- `hardcoded_date` reported a date in a commented-out assertion, such as `// expect(text).toHaveText("2026-03-15")`,
  although a comment never runs. Lines that are comments (`//`, `#`, `/*`, or `*` inside a block comment) are skipped
  now. Stored sessions are analyzed again after the update, so such findings disappear from them too.

## 0.1.117

### Fixed
- The **spec** tag on a finding could not be read in the dark theme, and in the light theme it had no background
  either: its colour was never defined. Findings of the regex checks and the Gherkin checks had no tag at all. Every
  finding now shows the tag of its source (regex, eslint, gherkin, spec or model), named as in the filter above the
  findings, and specification findings get their teal stripe on the left.
- Static-analysis findings were labelled "eslint" everywhere, also in Python, Java, C# and Robot Framework sessions,
  where tree-sitter or the Robot Framework parser found them. A finding's tag now names the engine of its session
  (eslint, tree-sitter or robot); the filter, the Calibration table and the reports call the source "lint".

## 0.1.116

### Added
- Every button that calls a model (**Semantic review**, **Verify again**, **Segment with model**, **Compress
  rules.md**, **Generate skill**) says on hover what it sends, and the README has the same list under "Your data".
  In short: the review sends the test code and a shortened transcript; Compress and Generate skill send the picked
  rules with one line of code each, and never the example files.

### Changed
- Secrets are masked in everything sent to a model: the review, the verification, segmentation, Compress rules.md
  and Generate skill. Until now only the example files of a generated skill were masked, and a token the agent had
  put in a test went to the provider as it was. Keys, tokens, JWTs and passwords become `[REDACTED]`; the model
  still sees that a secret is there.
- Findings that calibration hides are no longer missing from the reports. **Report .json** lists them under
  `hiddenByCalibration`, with the precision that hid them; the **PR report** names the hidden high-severity ones and
  counts the rest. The Sessions tree adds "N hidden by calibration" to a session's line, so a green session with
  hidden findings does not look clean.
- `hardcoded_secret` is no longer calibrated. Before, ten "False" verdicts could switch it off for good, and then
  a real token in a test went unreported. The Calibration table marks it **not calibrated** and says why. To stop it,
  untick it on the Rules tab. `hardcoded_base_url` is calibrated as before.

### Fixed
- After an update, sessions you had already imported kept the findings of the version that analyzed them: the checks
  added in 0.1.113 and 0.1.114 (`test_deleted`, `config_weakened` and others) did not show up in them until you changed
  something on the Rules tab. Now an update analyzes every stored session again, in the background.
- A verdict stays with its finding when a new version words the finding differently. Until now such a verdict stopped
  counting (as after 0.1.113, where the skip finding changed its text).
- **Export verdicts.json** left out the verdicts of findings that calibration hides, which are what keep a check off;
  moved to another machine, the check came back on. They are exported now, marked `"hidden": true`, and **Import
  verdicts** puts them back on those findings.
- Importing the same `verdicts.json` twice counted the rows that match no session twice in calibration. A row already
  imported is now skipped, and the import says how many were. Only the verdicts "ok" and "fp" count, as everywhere
  else.
- The effect of a rule marked **Moved** put a session before or after that day by when you imported it, not by when
  the agent ran it, so an old transcript imported later counted as "after". It also counted the demo session and the
  sessions of profiles that never report that finding. A session now counts by the time of its first step (the
  import time when the transcript has none), and only sessions of the profiles that can report the finding count.
  The first start after the update rebuilds the session summaries once.

## 0.1.115

### Added
- A model finding records which model found it and, after the verification call, which model verified it, as
  `provider/model` (for example `anthropic/claude-sonnet-5`, or `claudecli/sonnet` for the Claude Code subscription).
  **Report .json** and **verdicts.json** carry them as `model` and `verifier`. Findings the model made before this
  version have neither. A later version will use them to show the precision of each model.

### Fixed
- **Back to regex parsing** on a session made from a claude.ai export with several conversations replaced the
  session's steps with the first conversation of the file. It now parses the session's own conversation again. A
  session this already happened to has the first conversation's steps; import that conversation again to get it back.

## 0.1.114

### Added
- **Import again** in a session's tab. A session imported before 0.1.113 lacks what the new checks need, so a test
  deleted or a runner config loosened in the first edit of a file is not reported in it. Such a session now says so,
  and **Import again** parses its transcript once more into the same session: it keeps its name, specification and
  verdicts. The transcript is taken from the session itself when it was small enough to be kept at import (under
  400 KB); otherwise you pick the file again. A file that does not look like this session, and verdicts that would no
  longer match a finding, are asked about first.
- `config_weakened` in the Java and C# profiles. It reads Maven's `pom.xml` (the surefire and failsafe plugins and
  the properties), Gradle's test tasks (`build.gradle`, `build.gradle.kts`) and `.runsettings`: more retries
  (`rerunFailingTestsCount`, test-retry's `maxRetries`), a longer timeout (`forkedProcessTimeoutInSeconds`,
  `TestSessionTimeout`), tests excluded (`<excludes>`, `excludeTestsMatching`, `excludeTags`, `TestCaseFilter`).
- `config_weakened` also reports a config that lets the build pass whatever the tests do: `testFailureIgnore`,
  `skipTests` or `maven.test.skip` in Maven, `ignoreFailures = true` in Gradle.
- **Show checks for** on the Rules tab: the list shows the checks of one profile (by default the one chosen on the
  Sessions tab) with the specification and model checks, or of all profiles. Only the view changes: rules, export and
  reset still cover every check.

## 0.1.113

### Added
- `focused_test` (high): `.only`, `fit` or `fdescribe` left in a test, so only the focused tests run and the rest of the
  suite is silently skipped. Reported in the TypeScript, Cypress, Detox, API and mobile profiles.
- `debug_leftover` (medium): `page.pause()`, `cy.pause()`, `cy.debug()`, `debugger`, `breakpoint()` or
  `pdb.set_trace()` left in a test. Reported in the TypeScript, Cypress, Detox, Python, API and mobile profiles.
- `cypress_async_test` (medium): an `async` test or hook in Cypress, where the commands may not run.
- `test_deleted` (Code group): a test removed from a file, or a test file deleted (`rm`, `git rm`, or a deleted file in a Codex
  patch). High right after a failing run, medium otherwise. A test renamed with the same body, moved to another file
  or restored later is not reported. Reported in every profile with code checks.
- `product_code_edited` (Process group): the agent changed product code (a file in the profile's source folders) in a
  testing task. High right after a failing run, medium otherwise. Tests, fixtures, page objects, mocks, test utils, a
  runner's config and a file named in the approved plan are not reported.
- `snapshot_overwritten` (Process group): snapshots rewritten instead of read. This covers a test run with an update
  flag (`jest -u`, `vitest -u`, `playwright test --update-snapshots`, `pytest --snapshot-update`,
  `UPDATE_SNAPSHOTS=1`), or a snapshot or baseline file written by hand (`__snapshots__`, `*.snap`,
  `*-snapshots/`, ApprovalTests `*.approved.*`, Verify `*.verified.*`). High right after a failing run, medium
  otherwise (the first baselines of new tests).
- `config_weakened` (Process group): a test runner's config loosened compared with its previous version: more
  retries (also Cypress `runMode`, pytest `--reruns`), a longer timeout, tests excluded (`testIgnore`,
  `testPathIgnorePatterns`, `excludeSpecPattern`, `grepInvert`, `exclude`, `--ignore`, `--deselect`, `-k "not …"`).
  Reads Playwright, Jest, Vitest, Cypress, WebdriverIO, Detox and Mocha configs, and `pytest.ini`, `tox.ini`,
  `setup.cfg`, `pyproject.toml`. High right after a failing run, medium otherwise. A config seen for the first time is
  reported only for its retries.
- The four checks above look at what the agent did across the session. A session you saved earlier gets
  `test_deleted`, `product_code_edited` and `snapshot_overwritten` when it is analyzed again. A test deleted or a
  config loosened in the first edit of a file that existed before the session, and a deleted file in a Codex session,
  need the transcript to be imported again.

### Changed
- Every finding is reported under the check it is about. A skip (`@Disabled`, `t.Skip`) is now only "sleep or skip",
  and an expected failure (`xfail`, `test.fail()`) is now only "expected failure"; until now `xfail` and `@Disabled`
  each gave both findings. A Playwright test with no `expect` is "no assertion after action", as in the other
  languages, not "weak assert". `.only`, `page.pause()`, `cy.pause()`, `cy.debug()` and async Cypress tests moved to
  the new checks above.
- `hardcoded_secret` and `hardcoded_base_url` are reported in the TypeScript, Cypress, Detox and mobile profiles too,
  not only in the API profile: a token or a staging host in a UI test is just as common. Both checks moved from the
  API group to the Code group on the Rules tab.
- `hardcoded_base_url` no longer reports a runner's config file (`playwright.config.ts`, `cypress.config.ts`,
  `wdio.conf.ts`, `.detoxrc`…): that is where its own rule says the base URL belongs.
- Retries in a runner's config (`retries: 2` in `playwright.config.ts`) are reported as `config_weakened`, not as
  "sleep or skip". Retries on a single test (`test.describe.configure({ retries })`, `@flaky`, `[Retry]`) stay "sleep
  or skip". In the demo session the retries finding is now `config_weakened`, and high.
- A file deleted in a Codex session shows as a `delete` step in the session's timeline. Until now it was left out.
- Three ESLint style rules (`playwright/max-nested-describe`, `playwright/no-nested-step`, `cypress/no-and`) and
  `playwright/no-duplicate-hooks` are no longer reported.
- The rule texts of "fragile wait" and "no assertion after action" now cover everything those checks report, and the
  skip rule no longer mentions `xfail`.
- A verdict is tied to the finding's check and text. Verdicts you gave to findings that moved to another check or
  whose text changed (a skip now says "skip / retry added") no longer count after the update.

### Fixed
- With static analysis on (the default), the Java, C# and Python profiles reported no fixed sleeps and no skipped tests
  at all (`Thread.sleep`, `time.sleep`, `@Disabled`, `[Ignore]`, `@pytest.mark.skip`…), and no `if`/`for`
  inside a test or repeated assertion either: once the code was parsed, these pattern findings were dropped although
  those languages' analysis does not look for them. The same dropped `it.skip` in Cypress and Detox, and a test retry
  (`retries: 2`) in every profile with static analysis. They are reported again; a finding is now left out only where
  static analysis reports the same thing itself.
- C#: an NUnit attribute in a list, such as `[Test, Ignore("…")]`, counts as a skipped test, like `[Ignore("…")]`.
- A session with a single event says "1 event" in its header, not "1 events".

## 0.1.112

### Changed
- Calibration now covers the static analysis checks (ESLint, tree-sitter, Robot Framework), the Gherkin checks and
  two of the specification checks ("test without requirement", "out of scope tested"), not only the pattern checks.
  As before, a check with at least 10 verdicts and precision below 30% is switched off and below 50% is lowered to
  low. If you already have such verdicts, some of these findings go quiet after the update.
- Precision is counted per check and source: when ESLint and a pattern check report under the same name (for example
  `weak_assert`), a poor record of one no longer switches off the other.
- A check you tick on by hand on the Rules tab is never switched off by calibration.
- Missing specification, uncovered requirements and the model's findings are never switched off by calibration.
- The Check precision table on the Calibration tab has a row per check and source, and its status is what calibration
  really does: "not calibrated" (with the reason on hover) for the model's findings, a missing specification,
  uncovered requirements and imported findings, and "on by hand" for a check you ticked on that calibration would
  switch off. Before, it could say "disabled" for checks that kept reporting.
- On the Rules tab, "on by hand" marks such a check, and the ⓘ for a severity that calibration overrides now shows for
  every calibrated source. The line under a session's findings names the source of each disabled check.

### Fixed
- A check that calibration switched off (at least 10 verdicts, precision below 30%) stays off. Its findings used to
  come back after the next change on the Rules tab and go away again after the one after, because once they were
  hidden their verdicts no longer counted. Your verdicts were never lost; they now count while the check is off too.

## 0.1.111

### Fixed
- The panel says "1 confirmed in 1 session", "1 high finding has no verdict", "(1 requirement)" and so on: with a count
  of one, the rules on the Calibration tab, the effect of a moved rule, the specification, ESLint and model status
  lines, the PR report and a few messages used the plural.
- ⚙ Settings → Reset settings no longer says it resets the language and the Claude Code command, which it does not
  (the panel has no language setting since 0.1.110, and the CLI paths are VS Code settings). It now lists the local
  server and Qwen addresses and the Hide the "Try a demo session" button checkbox, which it does reset.

## 0.1.110

### Added
- **Try a demo session** on the Sessions tab: a made-up session of an agent writing Playwright tests for a login page,
  with its specification, to see what SessionLens finds without a session of your own. Pressed again, it opens the
  same session. Its verdicts do not count for calibration. ⚙ Settings → **Hide the "Try a demo session" button**
  removes the button once you no longer need it.

### Fixed
- Specification coverage in TypeScript/JavaScript (Playwright, Jest, Cypress, Detox): a `test.describe(…)` block is no
  longer taken for a test, which gave a false "test without requirement" in nearly every Playwright file; `test.step`
  and hooks are not tests either; and a `test.skip(…)` / `test.only(…)` right after another test is found as a test of
  its own instead of being read as part of the one above.

### Changed
- SessionLens is in English whatever the language of VS Code. With VS Code in Russian, the commands, the sidebar
  titles, the Sessions list and the dialogs used to be in Russian around the English panel; now everything is in
  English. Russian in transcripts is still understood.
- The readme says SessionLens is experimental and asks for feedback, and ends with a request for a GitHub star or a
  review in the Marketplace or Open VSX.

## 0.1.109

### Fixed
- A setting changed in `settings.json` (or VS Code Settings) is no longer switched back by a SessionLens page that
  saves something else before it has picked up the change. Only the values you change in the panel are written.

### Changed
- Gherkin findings carry their own source: in exported verdicts (`verdicts.json`) they are `"gherkin"` instead of
  `"formal"`. The panel shows them as before.
- New name: **SessionLens: AI Agent Test Review** in the stores and the Extensions view, and **SessionLens** in the
  sidebar (was "SessionLens for VSCode"). Its ID, `nikolaylosev.sessionlens-vscode`, is the same: nothing to
  reinstall, no data moves.
- The extension's description in the Marketplace and Open VSX says what it finds, and its keywords now include
  Claude, Codex, Playwright, Cypress, test automation, CLAUDE.md and AGENTS.md.

## 0.1.108

### Fixed
- Specification coverage: a requirement ID in the comment right above a test now links that test for the second and
  later tests in a file too. Before, in Java, Kotlin, C#, TypeScript/JavaScript, Go and Karate the comment was read as
  part of the test above it, so the test looked unlinked (`test_without_requirement`, and `spec_uncovered` for its
  requirement), and a short test above could take the ID.

## 0.1.107

### Fixed
- AI review through Claude Code or Codex CLI works when the path to the CLI contains non-Latin letters, for example a
  Windows user folder named in Cyrillic. Such a path used to be refused as "CLI not found".
- On Windows the save dialog no longer suggests `b.md` for a name like `a:b.md`; it suggests `sessionlens.md`, as on
  macOS and Linux.

### Changed
- The readme asks you to report a false finding as an issue with an anonymized piece of the session, and says what
  to remove first. Quick start now says the Sessions list is below the panel.
- `THIRD-PARTY-NOTICES.md` names every package inside `vendor-eslint.js`: eslint-plugin-playwright 2.12.0, Sucrase
  and its dependencies ts-interface-checker (Apache-2.0) and lines-and-columns, ajv, uri-js and natural-compare.

### For contributors
- The CI workflow and the repository config files (`.gitattributes`, Prettier, `.vscodeignore`) are back; they were
  lost when the history was squashed.
- `@vscode/test-electron` 3.1.0: 2.5.2 cannot start VS Code 1.110+ on macOS.

## 0.1.106 — Phase 7C: ready for publishing

### Changed
- New extension ID: `nikolaylosev.sessionlens-vscode` (publisher `nikolaylosev`). VS Code treats it as a different
  extension from the earlier local build (`local.sessionlens-vscode`, up to 0.1.105): its sessions, rules, calibration
  and API keys are not carried over. Export verdicts and rules there first if you need them, import them here, then
  uninstall the old build.
- **SessionLens: Open settings** finds the extension's settings by its own ID, whatever it is.

### Added
- Repository, issue tracker and homepage links, a Marketplace banner and Q&A; `CONTRIBUTING.md`; the readme's
  "Your data" section says where everything is kept and how to remove it; places for screenshots in the readme.
- The changelog is part of the package (the Marketplace shows it).

### For contributors
- CI packages the extension without `--allow-missing-repository` and checks the package's file list against an
  allow-list (`npm run check:vsix`).
- `THIRD-PARTY-NOTICES.md` names all three tree-sitter grammars and the ESLint version inside `vendor-eslint.js`.

## 0.1.105 — Phase 7B: code quality and infrastructure

Nothing changes in how SessionLens looks or what it finds.

### Changed
- The Chrome version is no longer supported: its code paths are gone from the panel (session storage in the page,
  API keys in the page's settings, direct provider requests from the page, the session list in the panel, browser
  downloads). The VS Code extension works as before.
- A request to VS Code that never gets an answer no longer leaves the panel waiting forever: after a limit that
  depends on the request, the panel shows "no reply from VS Code". File dialogs and local model servers have no limit.
- `RULES-ARCHITECTURE.md` is in English.

### For contributors
- The panel's source is ES modules in `src/webview/`; `npm run build` bundles them into `media/app.js` (esbuild).
- ESLint, Prettier (160 columns), `tsc --checkJs`, a build check and integration tests in a real VS Code, all in
  GitHub Actions on Ubuntu, Windows and macOS (Node 22).

## 0.1.104 — Phase 7A: profile details, panel order, specification coverage

### Added
- Under the **Profile** list: a one-line summary of what the selected profile checks and **What this profile checks**
  with its file types, recognised test runs, checks by group (switched off in Rules: struck through), static
  analysis and its state, file types that count for specification coverage, assertion comparison and calibration
  status. The options of the list name the language; the profile name in a session's header shows the summary as a
  tooltip.
- Specification coverage finds Kotlin tests (`@Test fun …`, also names in backticks) and Robot Framework test cases
  and tasks (`[Documentation]` and `[Tags]` count).

### Changed
- The **Calibration & Settings** panel is now above the **Sessions** list in the sidebar (VS Code keeps an order you
  set yourself).
- Files SessionLens cannot read tests from do not count for coverage; with only such files, coverage is not computed
  and the Specification section says so instead of "No code found".

### Fixed
- False `spec_uncovered` (High) for every requirement in qa-cypress, qa-detox, qa-mobile, qa-robot and qa-generic,
  and for Kotlin files: tests were read with the Python pattern and never found.

## 0.1.103 — Phase 6: VS Code integration

SessionLens behaves like a regular VS Code extension: its actions are in the Command Palette and the Sessions list's
context menu, five settings are in VS Code Settings, and VS Code's own texts follow its display language.

### Added
- Commands **SessionLens: Import transcript…**, **Open session…** (pick by name, profile or date), **Export
  verdicts** and **Open settings**. Import and export run in the sidebar, which opens if needed.
- Context menu on a session in the Sessions list: **Open**, **Rename…**, **Delete** (asks first; closes the
  session's tab).
- VS Code settings `sessionlens.minGapMs`, `sessionlens.maxCode`, `sessionlens.verify`, `sessionlens.lint` and
  `sessionlens.rulesTarget`, the same values as in the panel; a change in either place shows up in the other, and
  switching `lint` re-analyzes sessions as the panel's toggle does. User settings: synced by Settings Sync, not
  changeable by a workspace. Values set in the panel are moved there on the first start.
- Russian for the Sessions list, commands, setting descriptions, dialogs and notifications, following VS Code's
  display language. The panel stays in English.
- The **SessionLens** Output channel also shows migration messages that went to the developer console before, CLI
  failures (code and time) and how long each analysis took. No transcript text, prompts or replies.

### Changed
- The Sessions list is visible right after installing and while the panel below is collapsed; it is still hidden
  while another tab of the panel is open. It is now above the panel in a new installation (VS Code keeps an order you
  set yourself).
- An empty Sessions list shows a short text with an **Import transcript…** button instead of "No sessions yet —
  import one below".
- A session you renamed is shown under its new name in the list, the tab title, the panel header and Open session…;
  before, the task id found in the transcript stayed in front. Sessions you did not rename look as before.
- A session tab restored after a restart takes the session's current name.

### Fixed
- Collapsing the panel while it showed Calibration, Rules or Settings left the Sessions list hidden until the panel
  was opened again.

## 0.1.102 — Phase 5: lint engines loaded on demand

The sidebar and every session tab no longer load all static-analysis engines. About 4.5 MB of JavaScript and 4.9 MB
of WebAssembly used to be loaded, and the three tree-sitter grammars compiled, in every page.

### Changed
- The ESLint bundles and the tree-sitter engines are loaded the first time a session of their language is analyzed
  in a page, and only the files that language needs: `qa-ts` loads `vendor-eslint.js`; `qa-java` loads
  `tree-sitter.js` and `lint-java.js` and compiles only the Java grammar; `qa-api`, `qa-mobile`, `qa-go` and
  `qa-generic` load nothing. The Robot parser stays part of the page.
- The sidebar loads an engine only to import or to re-analyze a session of that language in the background. Browsing
  Sessions, Calibration, Rules and Settings loads none.
- A session tab loads its session's engine right after it is drawn, so the next analysis does not wait for it.
- New lint note "static analysis: engine loading…" while an engine is still loading. "bundle not loaded" now means
  the engine file could not be loaded.

### Fixed
- An analysis that ran before a tree-sitter engine had finished starting (for example an import right after VS Code
  opened) was saved as final, without the Java/C#/Python findings, and never repeated. Such an analysis is now marked
  as not done and repeated as soon as the engine is ready.
- Sessions saved that way by earlier versions are found once, a few seconds after the first start of 0.1.102, and
  analyzed again (only `qa-java`, `qa-c#` and `qa-python` sessions are read for this).

## 0.1.101 — Phase 4: sessions in files instead of globalState

Start-up and the panel's response no longer depend on how many sessions are stored. One action writes one session.

### Changed
- Sessions are files in the extension's storage folder (`sessions/<id>.json` plus a small `<id>.meta.json` summary),
  kept by the host (`store.js`). The sidebar loads only the summaries; a session tab loads only its own session;
  Calibration, Rules and the Sessions tree work from the summaries. Export verdicts, examples for a generated skill
  and verdict import read sessions 10 at a time.
- New messages `session:list`, `session:get`, `session:put`, `session:delete`, `session:clear`. `storage:get` and
  `storage:set` no longer accept `sessions`; new small key `analysisEpoch`.
- A verdict, a rename, "Mark reviewed", a spec, an AI review: one `session:put` of that session with the rev it was
  read at. If another window saved the same session in between, it is read again and the change applied to the
  fresh copy.
- Rules tab: a checkbox or severity change is written after 300 ms and re-analyzes nothing in the sidebar. Open
  session tabs re-analyze their own session when the write arrives; the other sessions are re-analyzed in the
  background, one at a time, newest first. The ESLint switch and a verdict import work the same way.
- Other pages are told exactly what changed (one session, the list, or the settings) instead of re-reading
  everything.
- New Output channel "SessionLens" (migration, repairs of the session folder, refused messages).

### Fixed
- With more than 64 MB of sessions, 0.1.100 refused every save (the phase 3 message limit applied to the whole
  `sessions` object): verdicts, renames and rule changes were silently lost. Messages now carry one session (limit
  32 MB per session).
- An open session tab now shows new findings after a rules change. In 0.1.100 its refresh looked for an active nav
  tab, which a session tab has none of, so it kept the old findings until it was reopened.

### Migration
- On first start, every session in `globalState["sessions"]` is written to a file, read back and compared, then the
  key is removed. If anything fails, the old data stays and the next start tries again. After the move, 0.1.100 or
  earlier shows no sessions: export what you need before going back.

## 0.1.100 — Phase 3: trust boundary between the panel and the host

The panel renders untrusted transcripts, imported JSON and model answers, so the host now treats every message from
it as possibly hostile.

### Security
- Qwen / local server address: in 0.1.99 `ai:call` took `baseUrl` from the panel for Qwen and the local provider, so
  a compromised panel could have the host send the saved Qwen key to any address (or make the host request any URL).
  The host now keeps these addresses itself (`globalState.hostBaseUrls`, not reachable through storage messages) and
  ignores `payload.baseUrl`. A new address is used only after the person confirms it in a modal VS Code dialog
  (`baseurl:set`); going back to the default asks nothing.
- CLI paths: `sessionlens.claudeCliPath` / `sessionlens.codexCliPath` are machine-scoped VS Code settings; a
  workspace's `.vscode/settings.json` cannot set them. `claude:run`, `claude:check`, `codex:run` and `codex:check`
  ignore any path in the message.
- Every message is checked by a table of validators (`validate.js`) before anything happens: field types, sizes,
  known providers, known storage keys (unknown key → the whole write is refused), known tabs, existing sessions.
  Unknown message types are refused.
- Saving a generated skill: `skillName` and every file path are checked against a character whitelist (no `..`,
  backslash, `:`, absolute paths, empty segments, Windows reserved names, trailing dots or spaces), before the
  folder dialog opens, and the resolved target must lie inside the skill folder. The skill's name and paths come from
  a model answer, which a transcript can steer.
- Save file: only a file name is taken from the panel; the dialog starts in the workspace folder (or home).
- Panel rendering: every value interpolated into `innerHTML` is escaped, including numbers, ids, severities and the
  parameters of translated strings. Before, a check name from an imported verdicts file reached the Calibration
  tables as markup, and several transcript fields (`profile`, `seq`, event `kind`, assertion counts) were not escaped.
- Windows, `.cmd`/`.bat` CLIs: the command line for `cmd.exe` is built without `\"` escapes and refuses any argument
  with `% ! ^ & | < > "`; the system prompt goes in as a relative file name (`system.txt`, resolved against the
  temporary working folder), so the user's temp path no longer passes through `cmd.exe`.

### Changed
- Settings → Add a model, Claude Code / Codex: the path field is replaced by **Open settings**; **Check** shows the
  path it used. Paths entered in earlier versions are moved to the user settings at activation (once, with a notice).
- Settings → Add a model, Qwen / local: a new address is confirmed in a VS Code dialog; cancelling it does not add
  the model. Addresses saved by earlier versions are moved to the host at activation, without a question.
- Reset settings also returns the local and Qwen addresses to their defaults; it does not touch the CLI paths.

### Added
- Tests: `validate`, `trust-boundary` (host under the fake `vscode`), `cli`, `xss` (the real panel in jsdom with a
  markup payload in every stored string, plus mutation checks); 103 in total. Dev dependency: `jsdom`.

## 0.1.99 — Phase 2: API keys in SecretStorage, provider calls on the host

### Changed
- API keys are stored in VS Code's SecretStorage (`secrets.js`), no longer in `globalState.settings`
  (`apiKey`, `keys`). Keys saved by earlier versions are moved at activation; the move is idempotent and, if the
  keychain is unavailable, leaves the keys where they were (they keep working) until the next start.
- HTTP requests to Anthropic, Google, OpenAI, xAI, DeepSeek, Qwen and local servers are made by the extension host
  (`providers.js`, message `ai:call`). The webview keeps prompts, routing, the request queue, 429 retries, parsing
  and verify; the host performs one call per message with the same `LensAI.PROVIDERS[p].call` functions and adds
  the key itself. The webview never receives a key: `storage:get` strips the key fields, `secret:status` returns
  booleans only.
- Webview CSP: `connect-src` is the extension's own resources only (needed by tree-sitter's `.wasm`), no longer
  `https: http:`.
- The host sends the key only to a provider's fixed endpoint; an address from the panel is accepted only for the
  local provider and Qwen (editable region).
- Requests go through `node:http`/`node:https` rather than the global `fetch`: no 300 s header limit (a slow local
  model with `stream: false` exceeded it), VS Code's proxy settings apply. Cloud requests stop after 10 minutes,
  local ones have no limit; closing a view or tab aborts its requests.

### Added
- Settings → Add a model: the key field shows **saved ✓** / **not set**, never the key; **Delete key** button.
  **Reset settings** also deletes the stored keys.
- From a remote window (SSH, WSL, Dev Container), a failed connection to a local server says that the request
  left from the remote machine.
- Tests: `secrets`, `providers`, `ai-transport`, `host-messages` (extension.js under a fake `vscode`), 63 in total.

### Unchanged
- The Chrome build path: without the VS Code bridge, keys stay in settings and calls go out from the page.
- `anthropic-dangerous-direct-browser-access` is now sent only from a browser page, i.e. only by the Chrome build.

## 0.1.98 — Rules, phase 1: check registry

### Added
- `media/checks.js` — a single registry of all check names (group, default severity, rule-text key, good example,
  sources, sort priority) plus `SEVERITIES` and `GROUPS_ORDER`. `rules.js` tables, `lens.js` `RULE_KEYS`, the Rules
  panel's group list, `sortFindings` priorities and every severity check are now derived from it.
- `npm test` (built-in `node --test`, no dependencies, Node ≥ 21):
  - `rules-consistency` — fails when a detector (regex `F(...)`, any `*_RULE_MAP`, `spec.js`, the model's
    categories) emits a name missing from the registry, when a registry entry has no detector or wrong `sources`,
    or when rule text / group labels are missing in any language;
  - `finding-pipeline` — one finding per source (regex, lint via the Robot engine, gherkin, spec, ai) through
    `LensRules.apply()` and `Lens.sortFindings()`;
  - `book-snapshot` — `LensRules.book({})` is identical to v0.1.97 apart from the two added rows.
- Rules panel: an ⓘ hint next to a manually set severity when calibration has demoted the check and the manual
  value does not apply to its findings.
- Importing `rules.json` reports how many rows were ignored and why (unknown check, no check, invalid severity).

### Fixed
- `ai_other` (a model finding outside the review categories) is now a real check: shown in the Rules panel, can be
  disabled or re-weighted, exported to `rules.json`, and has its own rule text.
- `lint_valid_title` (Playwright `valid-title`) was mapped in `lint.js` but missing from the rule book; it now
  appears in the Code group with its own rule text and example.

### Changed (internal)
- `LensRules.fromJson()` returns `{ overrides, ignored }`.
- `LensLint.RULE_MAPS`, `LensAI.AI_CATEGORIES`, `Lens.calibLevel()` and `I18N.has()` are exported.
- Unknown check names reaching `Lens.RULES` / `LensRules.ruleText()` log one `console.warn` per name (synthetic
  `lint_<ruleId>` names excepted).
