# What to do next in the test suite

This note is the order of work for the test suite after v0.1.118. How the suite is built, and which file guards which
part, stays in [`TESTING.md`](TESTING.md). When a pull request gives a check its own test file, it removes that check
from the tables below, so the tables always list what is still missing.

Every check name in `media/checks.js` appears in at least one test file, and `rules-consistency.test.js` fails when a
new name does not (since v0.1.118). That gate only looks for the name. The 26 checks below are named somewhere, but no
test runs their detector on a transcript and states both what must be reported, with severity and message, and what
must not.

"Demo count" in the tables means that `demo-session.test.js` expects that many findings of the check in the demo
session. It does not compare the severity or the message, and it has no case that must not be reported. "Synthetic"
means that a test builds the finding by hand and never runs the detector.

## First: the checks the product is about

The product exists to catch an agent that claims tests pass without proof, or that weakens the tests it wrote. These
checks say that, and their detectors are the least tested.

| Check | Where it is covered now |
|---|---|
| `assert_weakened` | Demo count only |
| `weak_assert` | One must-not case (`pom.xml`) in `config-weakened.test.js`; synthetic everywhere else. No test requires a finding. |

## Second: the other method and process checks

| Check | Where it is covered now |
|---|---|
| `fix_after_fail_without_triage` | Demo count only |
| `peeked_at_src_before_plan` | Demo count only |
| `assumption_instead_of_question` | Demo count only |
| `scope_creep` | Demo count only |
| `stop_markers_missing` | Expected in one list in `reanalyze-after-update.test.js` |
| `hardcoded_coordinates` | None. The header of `mobile-checks.test.js` says that `rule-mapping.test.js` has its cases, but it does not; fix that header in the same pull request. |

## Third: the specification checks that calibration can hide

Calibration can hide or demote these two checks, so a wrong detector changes what the reviewer sees. Today no test
requires either of them; `spec-extract.test.js` runs the specification checks but compares check names only, and
expects none of these two.

| Check | Where it is covered now |
|---|---|
| `test_without_requirement` | Must-not cases in `spec-extract.test.js` (names only); synthetic in `calibrate.test.js` and `calibration-ui.test.js` |
| `out_of_scope_tested` | Only implied by `spec-extract.test.js`, which expects no specification findings in its cases; synthetic in `calibrate.test.js` |

## Then: checks with partial coverage

These checks have some real cases, but no single file says what counts and what does not.

| Check | Where it is covered now |
|---|---|
| `sleep_or_skip_added` | `supersedes.test.js` (which engine replaces the regex), `rule-mapping.test.js`, the lint snapshot, demo count |
| `fragile_wait` | `supersedes.test.js`, `rule-mapping.test.js`, the lint snapshot |
| `expected_failure` | Two cases in `rule-mapping.test.js`, one must-not case in `config-weakened.test.js` |
| `focused_test`, `debug_leftover` | `supersedes.test.js`, `rule-mapping.test.js` |
| `magic_number` | None on a transcript: every test that names it builds the finding by hand |
| `conditional_logic` | `supersedes.test.js`, the lint snapshot, `calibration-loop.test.js` |
| `duplicate_assert` | `calibration-loop.test.js` only |
| `raw_locator`, `no_assertion_after_action` | The lint snapshot, `rule-mapping.test.js`; `raw_locator` also demo count |
| `empty_test_case` | One Robot case in `finding-pipeline.test.js`, the lint snapshot |
| `cypress_async_test` | One case in `rule-mapping.test.js` |
| `lint_valid_title` | None on a real engine. `book-snapshot.test.js` leaves it out of the rule book snapshot. |
| `scenario_no_then` | One case in `finding-pipeline.test.js` |
| `no_spec`, `spec_uncovered` | `no_spec`: one case in `finding-pipeline.test.js`. `spec_uncovered`: `spec-extract.test.js` (names only), demo count. Both are facts that calibration never hides, so they come last. |

## How to write them

Use the shape of the other check files, as in [`TESTING.md`](TESTING.md) section 8: one file per check (or per small
family, such as `api-checks.test.js`), a short transcript, a list of `severity: message` strings compared with
`assert.deepEqual`, and must-not cases next to the trigger, not only far from it. For a check that an engine reports,
run the real engine, as `lint-mapped-checks.test.js` does, and compare severity and message too, because the verdict key
includes the start of the message.

When a test changes a detector, follow TESTING.md section 8.3: run the test against the code before the fix and see it
fail.

## Not now

- A coverage reporter. Line coverage does not show that a detector is wrong on a transcript.
- Type-checking the tests. `tsc` covers the host and `media/*.js` on purpose.
- More cases in the real VS Code suite. It has seven cases for what the fake `vscode` cannot show. Add one only when the
  fake is wrong.
