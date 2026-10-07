# SessionLens for VSCode — instructions for coding agents

## Before you change anything
- Read the file you are about to edit in full. Read docs/RULES-ARCHITECTURE.md for the part you touch (docs/ARCHITECTURE.md is the overview).
- media/app.js is generated from src/webview/ — never edit it by hand. Change src/webview, run `npm run build`,
  commit both.
- Do not touch vendored files: media/vendor-eslint*.js, media/tree-sitter.js, *.wasm.
- If the task contradicts the code, stop and describe the mismatch instead of working around it.

## Checks (all must pass before a commit)
npm test · npm run lint · npm run format:check · npm run typecheck · npm run build:check · npm run check:vsix

## Rules
- User-visible behaviour changes only when the task says so. Render snapshots in test/__snapshots__ must stay
  unchanged otherwise; an intended change updates them with SL_UPDATE_SNAPSHOTS=1 in a commit of its own.
- No new runtime dependencies without a written reason.
- One topic per branch and pull request; formatting-only changes in their own commit.
- For anything a user can notice: a line in CHANGELOG.md and a patch version bump in package.json.
- Code, comments, docs and commit messages in English. Russian stays only in the recognition patterns
  (lens.js, spec.js, ai.js). The extension's UI is English only: no translation files (decided in 0.1.110).
- Local notes (the TODO, PHASE-*.md and PR-*.md plans, smoke checklists) live in `local/`, which .gitignore and
  .vscodeignore both leave out: never commit them, and never add them to the .vsix or to the allowed list in
  scripts/check-vsix.js. A new local note goes into `local/` too, so no ignore file needs a new line.
