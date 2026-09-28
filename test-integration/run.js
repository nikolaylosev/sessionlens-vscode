"use strict";
/* Phase 7 (7B.8): runs test-integration/suite.js inside a real VS Code (downloaded by @vscode/test-electron into
   .vscode-test/), with a fresh user-data folder and no other extensions. SESSIONLENS_TEST=1 makes activate() return
   the test API (extension.js testApi()). On Linux CI runs it under xvfb-run. */
const path = require("path");
const os = require("os");
const fs = require("fs");
const { runTests } = require("@vscode/test-electron");

async function main() {
  const root = path.join(__dirname, "..");
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "sl-vscode-user-"));
  try {
    await runTests({
      version: process.env.SL_VSCODE_VERSION || "stable",
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, "suite.js"),
      launchArgs: ["--disable-extensions", "--user-data-dir", userData, "--skip-welcome", "--skip-release-notes"],
      extensionTestsEnv: { SESSIONLENS_TEST: "1" },
    });
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
