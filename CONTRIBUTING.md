# Contributing to SessionLens

## Requirements

- Node.js 22 (CI uses 22 on Ubuntu, Windows and macOS).
- VS Code 1.85 or later to run the extension.

## Build and check

```
npm ci
npm run build            # src/webview → media/app.js (esbuild)
npm test                 # unit and DOM tests (node --test, jsdom, a fake vscode module)
npm run lint             # ESLint on our own code
npm run format:check     # Prettier, 160 columns (npm run format to fix)
npm run typecheck        # tsc with checkJs
npm run build:check      # media/app.js is what src/webview builds to
npm run test:integration # a real VS Code via @vscode/test-electron (downloads VS Code once into .vscode-test/)
npx @vscode/vsce package # the .vsix
```

CI runs all of these on every push and pull request (`.github/workflows/ci.yml`).

## Where things are

The overview of the whole extension, with diagrams, is [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); the rules
system in depth is [`docs/RULES-ARCHITECTURE.md`](docs/RULES-ARCHITECTURE.md).

- `extension.js`, `cli.js`, `providers.js`, `store.js`, `secrets.js`, `validate.js` — the extension host.
- `src/webview/` — the panel's source (ES modules). **`media/app.js` is generated from it: never edit it by hand.**
  Change `src/webview`, run `npm run build` and commit both.
- `media/*.js` — the analysis (`lens.js`, `checks.js`, `rules.js`, `lint*.js`, `spec.js`, `ai.js`, …) shared by the
  panel and the host; `media/vendor-eslint*.js`, `tree-sitter.js` and `*.wasm` are vendored bundles (see
  `THIRD-PARTY-NOTICES.md`) and are not linted or reformatted.
- `docs/RULES-ARCHITECTURE.md` — how checks, rules, storage, the trust boundary and the VS Code integration work.

## Adding a check

The full checklist is in `docs/RULES-ARCHITECTURE.md` §12. In short:

1. Reuse an existing check name if the concept is the same.
2. Add the entry to `media/checks.js` (group, severity, `ruleKey`, `good`, `sources`).
3. Add the rule text to `media/i18n.js`.
4. Write the detector (a regex check in `lens.js`, a rule in an engine plus its `*_RULE_MAP` in `lint.js`, …).
5. `npm test`: `test/rules-consistency.test.js` tells you what is missing.

## Snapshots

Some tests compare against files in `test/__snapshots__/` (the rule book, calibration, lint results, the rendered
panel, the profile details). A change that alters them on purpose updates them in a commit of its own, and the pull
request says what changed and why. A snapshot that changes without a reason is a regression.

`SL_UPDATE_SNAPSHOTS=1 npm test` rewrites only the rendered panel and the profile details. The rule book, calibration
and lint snapshots have their own commands, listed in [`docs/TESTING.md`](docs/TESTING.md) §5, which also describes
the test harnesses and what each test file checks.

## Pull requests

- One topic per pull request; keep formatting-only changes in their own commit.
- Describe what changed, what was tested and what was not (for example, manual checks in a real VS Code).
- Add a line to `CHANGELOG.md` for anything a user can notice.

## Releases

A release is a tag. On `main`, with `package.json` at the new version and a `## <version>` section in `CHANGELOG.md`:

```
git tag v0.1.109
git push origin v0.1.109
```

`.github/workflows/release.yml` then checks that the tag is on `main` and matches the version, runs every check,
packages the `.vsix`, and in separate jobs creates the GitHub release (the changelog section plus the request to report
false findings, from `scripts/release-notes.js`), publishes to the Visual Studio Marketplace and publishes to Open VSX.
A failed job can be re-run on its own; publishing a version that is already there is skipped.

The two stores need repository secrets: `VSCE_PAT` (an Azure DevOps token with the Marketplace › Manage scope) and
`OVSX_PAT` (an Open VSX access token).
