"use strict";
/* Builds media/app.js from src/webview (phase 7, 7B.4): one IIFE, not minified, no source map, so sidepanel.html,
   extension.js's SCRIPT_FILES, the CSP and the test harness keep seeing one classic script. `--check` fails when the
   committed media/app.js is not what the sources build to (CI). */
const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");

const root = path.join(__dirname, "..");
const out = path.join(root, "media", "app.js");
const BANNER = "/* Generated from src/webview by `npm run build` (scripts/build-webview.js). Do not edit: change src/webview. */";

async function build() {
  const r = await esbuild.build({
    entryPoints: [path.join(root, "src", "webview", "index.js")],
    bundle: true,
    format: "iife",
    minify: false,
    sourcemap: false,
    write: false,
    target: "es2022",
    charset: "utf8",
    legalComments: "none",
    logLevel: "warning",
    banner: { js: BANNER },
  });
  return r.outputFiles[0].text;
}

build()
  .then((code) => {
    if (process.argv.includes("--check")) {
      const now = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
      if (now !== code) {
        console.error("media/app.js is not what src/webview builds to: run `npm run build` and commit it.");
        process.exit(1);
      }
      console.log("media/app.js is up to date");
      return;
    }
    fs.writeFileSync(out, code);
    console.log(`media/app.js: ${code.length} bytes`);
  })
  .catch((e) => {
    console.error((e && e.message) || e);
    process.exit(1);
  });
