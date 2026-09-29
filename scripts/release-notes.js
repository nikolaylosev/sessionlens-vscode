"use strict";
/* The release workflow (.github/workflows/release.yml): `node scripts/release-notes.js v0.1.109` checks that the tag
   is the version in package.json and that CHANGELOG.md has a section for it, then prints the release notes: that
   section's body and the request to report false findings. Exits 1 with the reason otherwise. */
const fs = require("fs");
const path = require("path");

const FALSE_FINDING =
  "**Found a false finding?** Please [open an issue](https://github.com/nikolaylosev/sessionlens-vscode/issues/new) with a short, " +
  "anonymized piece of the session: remove paths, user names, hosts, tokens and company names first. See " +
  "[Found a false finding?](https://github.com/nikolaylosev/sessionlens-vscode#found-a-false-finding).";

// the body of "## <version>" (a title after the version is allowed: "## 0.1.106 — Phase 7C"), or null
function section(changelog, version) {
  const lines = String(changelog).split("\n");
  const head = new RegExp("^## " + version.replace(/\./g, "\\.") + "(?:\\s|$)");
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  const body = lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
  return body || null;
}

// → { notes } or { error }
function releaseNotes(tag, version, changelog) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) return { error: `tag "${tag}" is not vX.Y.Z` };
  if (tag.slice(1) !== version) return { error: `tag ${tag} does not match version ${version} in package.json` };
  const body = section(changelog, version);
  if (!body) return { error: `CHANGELOG.md has no section "## ${version}" (or it is empty)` };
  return { notes: body + "\n\n" + FALSE_FINDING + "\n" };
}

if (require.main === module) {
  const root = path.join(__dirname, "..");
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  const r = releaseNotes(process.argv[2] || "", version, fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8"));
  if (r.error) {
    console.error("release-notes: " + r.error);
    process.exit(1);
  }
  process.stdout.write(r.notes);
}

module.exports = { section, releaseNotes, FALSE_FINDING };
