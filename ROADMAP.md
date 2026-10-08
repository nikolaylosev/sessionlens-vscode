# SessionLens roadmap

This is how we see SessionLens developing, as of version 0.1.124 (October 2026). There are no dates, and the order
can change with feedback. To suggest something, please
[open an issue](https://github.com/nikolaylosev/sessionlens-vscode/issues).

## Today

SessionLens reviews the transcript of a Claude Code, Codex or Cursor Agent session and shows what the agent actually
did, e.g. tests that never ran, assertions weakened after a failure, or deleted tests. You give a verdict on each
finding, calibration quiets the checks that are often wrong on your sessions, and confirmed findings become rules for
`CLAUDE.md`, `AGENTS.md` or Cursor's `.cursor/rules/sessionlens.mdc`. It runs in VS Code, Cursor and VSCodium.
Everything runs locally, and the extension is still experimental.

Cursor support came in 0.1.121: Cursor Agent transcripts from the editor and the CLI (with the output of the agent's
commands, read from Cursor's own databases on your machine), the CLI's `stream-json` log, a rules file for Cursor, and
your Cursor subscription as a model for the semantic review. 0.1.122 shows a Cursor Agent session's files relative to
its workspace, and gives fewer false findings: code inside a Python docstring, a command that only lists the tests,
and comments in the test data check no longer count. It also reads a file moved by a Codex patch, and a weakened
assertion's finding shows what changed. 0.1.123 finds weak assertions in C#, Go, REST Assured and Karate files it
skipped before.

0.1.124 makes the Sessions list easier to work with once there are many sessions. It groups them by date by default,
or by profile, verdict, agent, or groups you make yourself (a button, a menu item, or drag and drop). It filters them
by name, task, profile or group, and has quick filters for red sessions and for sessions with findings you have not
judged yet. Paths in your home folder start with `~`, so a review or a PR report no longer shows your user name, and
a finding that quotes a long line cuts it at a word.

SessionLens looks at the agent's session, while pull request review tools look at the final diff. We plan new checks
around process mistakes that only the session shows.

## Now

- Test 0.1.124 by hand in real VS Code and Cursor and ship fixes as patch releases.
- Tune checks based on [false finding reports](https://github.com/nikolaylosev/sessionlens-vscode/issues/new?template=false-finding.yml).

## Next: command line tool and CI

- `sessionlens analyze <transcript>` in the terminal, with JSON, Markdown and SARIF output and an exit code for CI,
  published on npm as `sessionlens-cli`. The VS Code panel and the tool share the same analysis code.
- A ready example for GitHub Actions, a standalone HTML report, and an optional chat notification.

## After that: starter rules and a Cursor plugin

- Starter rules for each profile on the Calibration tab: rules for `CLAUDE.md`, `AGENTS.md` or Cursor before you have
  confirmed findings of your own, built from the same rule book the checks use, so a rule and its check never drift
  apart.
- A Cursor plugin: the rules and a skill for Cursor's Agent, and a hook that runs the command line tool when the agent
  finishes and gives its findings back to the agent.

## Later

- Cursor on Windows and Linux (tested on macOS only so far), and Cloud Agent runs once they leave a file on your
  machine.
- Precision per model on the Calibration tab, and calibration thresholds per source, once there are enough verdicts.
- New profiles for iOS (Swift, XCTest) and Flutter (Dart).
- A JetBrains plugin built on the same analysis code.

## Under consideration

- A verdict key that survives rewording of a finding.
- Calibration shared by a team, with the reviewer and date of each verdict.

## Not planned

- Translating the interface. It stays in English, because verdicts are tied to the text of a finding.
- Reviewing diffs or pull requests in general.
