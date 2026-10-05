# SessionLens roadmap

This is how we see SessionLens developing, as of version 0.1.119 (October 2026). There are no dates, and the order
can change with feedback. To suggest something, please
[open an issue](https://github.com/nikolaylosev/sessionlens-vscode/issues).

## Today

SessionLens reviews the transcript of a Claude Code or Codex session and shows what the agent actually did, e.g. tests
that never ran, assertions weakened after a failure, or deleted tests. You give a verdict on each finding, calibration
quiets the checks that are often wrong on your sessions, and confirmed findings become rules for `CLAUDE.md` or
`AGENTS.md`. Everything runs locally, and the extension is still experimental.

SessionLens looks at the agent's session, while pull request review tools look at the final diff. We plan new checks
around process mistakes that only the session shows.

## Now

- Test 0.1.116 to 0.1.119 by hand in real VS Code and ship fixes as patch releases.
- Tune checks based on [false finding reports](https://github.com/nikolaylosev/sessionlens-vscode/issues/new?template=false-finding.yml).

## Next: command line tool and CI

- `sessionlens analyze <transcript>` in the terminal, with JSON, Markdown and SARIF output and an exit code for CI,
  published on npm as `sessionlens-cli`. The VS Code panel and the tool share the same analysis code.
- A ready example for GitHub Actions, a standalone HTML report, and an optional chat notification.

## Later

- Precision per model on the Calibration tab, and calibration thresholds per source, once there are enough verdicts.
- New profiles for iOS (Swift, XCTest) and Flutter (Dart).
- A JetBrains plugin built on the same analysis code.

## Under consideration

- A verdict key that survives rewording of a finding.
- Calibration shared by a team, with the reviewer and date of each verdict.

## Not planned

- Translating the interface. It stays in English, because verdicts are tied to the text of a finding.
- Reviewing diffs or pull requests in general.
