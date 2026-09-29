"use strict";
/* Phase 7 (7C): the .vsix may contain only what the extension needs at run time. `vsce ls` lists the files that would
   be packaged; every one of them must match ALLOWED, and nothing from DENIED may slip in through a broad pattern. */
const { execFileSync } = require("child_process");

const ALLOWED = [
  /^(LICENSE|LICENSE\.txt|THIRD-PARTY-NOTICES\.md|readme\.md|CHANGELOG\.md|package\.json|package\.nls(\.[a-z-]+)?\.json)$/,
  /^(extension|cli|providers|store|secrets|validate)\.js$/,
  /^media\/[^/]+\.(js|css|html|png|svg|wasm)$/,
];
const DENIED = [
  /^src\//,
  /^test/,
  /^types\//,
  /^scripts\//,
  /^\.github\//,
  /^media\/screenshots\//,
  /\.map$/,
  /^node_modules\//,
  /(^|\/)tsconfig\.json$/,
  /eslint\.config/,
  /\.prettier/,
];

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const out = execFileSync(npx, ["--yes", "@vscode/vsce@3", "ls"], { encoding: "utf8", shell: process.platform === "win32" });
const files = out
  .split(/\r?\n/)
  .map((l) => l.trim().replace(/\\/g, "/"))
  .filter(Boolean);
const bad = files.filter((f) => DENIED.some((rx) => rx.test(f)) || !ALLOWED.some((rx) => rx.test(f)));
if (bad.length) {
  console.error("Files that must not be in the .vsix:\n  " + bad.join("\n  "));
  process.exit(1);
}
console.log(`.vsix contents OK (${files.length} files)`);
