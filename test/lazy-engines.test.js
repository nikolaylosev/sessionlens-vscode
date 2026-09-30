"use strict";
/* Phase 5: lint engines are loaded on demand (LensLint.ensure), per language, only where a session is analyzed. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { bootHost, openPage } = require("./host-panel");
const { fakeTreeSitterEngine } = require("./engine-stub");
const { lintSnapshot, CODE, transcript } = require("../perf/snapshot-lint");
const { root } = require("./helpers");

const MEDIA = path.join(root, "media");
const read = (f) => fs.readFileSync(path.join(MEDIA, f), "utf8");
const LensLint = require(path.join(MEDIA, "lint.js"));
const Lens = require(path.join(MEDIA, "lens.js"));
async function until(fn, ms = 5000) {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const click = (p, sel) => p.document.querySelector(sel).dispatchEvent(new p.window.MouseEvent("click", { bubbles: true }));
const puts = (p) => p.sent.filter((m) => m.type === "session:put");
const JAVA = fakeTreeSitterEngine("LensLintJava", "java/swallowed-exception");
const JAVA_SLOW = fakeTreeSitterEngine("LensLintJava", "java/swallowed-exception", 150);
const FAKE_ESLINT = `var LensLintCore = { RULES: {}, lint(code) { return { messages: /waitForTimeout/.test(code) ? [{ ruleId: "playwright/no-wait-for-timeout", line: 1, message: "no wait" }] : [] }; } };`;

// a sidebar page imports a transcript by pasting it, as a user would
async function importVia(page, profile) {
  const [file, content] = CODE[profile] || CODE["qa-ts"];
  page.document.querySelector("#paste").value = transcript(file, content);
  page.document.querySelector("#paste-name").value = profile + " session";
  click(page, "#paste-go");
  await until(() => puts(page).some((m) => m.payload.session.profile === Lens.profile(profile).profile));
  await page.idle();
  return puts(page)
    .filter((m) => m.payload.session.profile === Lens.profile(profile).profile)
    .pop().payload;
}
const hostWith = (profile, extra = {}) =>
  bootHost({ globalState: { settings: Object.assign({ profile, rulesTarget: "claude", modelPool: [], defaultModelId: null }, extra) } });

test("the page lists only the core scripts; extension.js hands over every engine file lint.js can ask for", () => {
  const html = read("sidepanel.html");
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  assert.deepEqual(scripts, [
    "i18n.js",
    "lint-robot.js",
    "checks.js",
    "lens.js",
    "lint.js",
    "rules.js",
    "spec.js",
    "ai.js",
    "segment.js",
    "dialogs.js",
    "demo-session.js", // 0.1.110: the "Try a demo session" transcript, a few KB of text
    "app.js",
  ]);
  const ext = fs.readFileSync(path.join(root, "extension.js"), "utf8");
  const list = (name) => Function(`return ${new RegExp(`const ${name} = (\\[[^\\]]*\\]);`).exec(ext)[1]}`)(); // an array literal, any layout
  assert.deepEqual(list("SCRIPT_FILES"), scripts.slice(1));
  const wanted = [...new Set(Object.values(LensLint.ENGINE_FILES).flatMap((e) => e.js))].sort();
  assert.deepEqual([...list("ENGINE_SCRIPTS")].sort(), wanted);
  for (const f of wanted) assert.ok(fs.existsSync(path.join(MEDIA, f)), f);
  assert.equal(/LensLint(Java|CSharp|Python)\.boot\(/.test(read("app.js")), false, "app.js boots no engine itself");
});

test("Node (no page): ensure() loads nothing and run() reports what it did before", async () => {
  assert.equal(await LensLint.ensure("java"), "static");
  assert.equal(await LensLint.ensure("api"), "none");
  assert.equal(LensLint.engineState("java"), "static");
  const events = Lens.importAny(transcript(...CODE["qa-java"]), Lens.profile("qa-java"));
  const r = LensLint.run({ events }, Lens.profile("qa-java"), {});
  assert.equal(r.ran, false);
  assert.equal(r.pending, undefined);
  assert.match(r.note, /bundle not loaded/);
});

test("with the real engines loaded, run() reports exactly what 0.1.101 reported (snapshot)", async () => {
  const want = JSON.parse(fs.readFileSync(path.join(root, "test", "__snapshots__", "lint-v0101.json"), "utf8"));
  const got = await lintSnapshot(root);
  assert.deepEqual(got, want);
  for (const [profile, r] of Object.entries(got)) assert.ok(r.ran && r.findings.length, `${profile}: the engine ran`);
});

test("sidebar import of qa-java: loads tree-sitter.js and lint-java.js, boots with the WASM URIs, saves lint findings", async () => {
  const host = hostWith("qa-java");
  const sb = await openPage(host, { engines: { "lint-java.js": JAVA } });
  await sb.ready();
  assert.deepEqual(sb.engineLoads, [], "nothing before the import");
  const put = await importVia(sb, "qa-java");
  assert.deepEqual(sb.engineLoads, ["tree-sitter.js", "lint-java.js"]);
  const booted = sb.window.eval("LensLintJava.booted");
  assert.equal(booted.length, 1);
  assert.match(booted[0].javaWasmUrl, /media[\\/]tree-sitter-java\.wasm$/);
  assert.match(booted[0].locateCore("tree-sitter.wasm"), /media[\\/]tree-sitter\.wasm$/);
  assert.ok(put.session.findings.some((f) => f.source === "lint" && f.rule === "java/swallowed-exception"));
  assert.equal(put.session.lintPending, undefined);
  assert.match(put.analyzedGen, /^[0-9a-f]{8}$/);
  assert.deepEqual(sb.errors, []);
  sb.close();
});

test("an idle sidebar loads no engine; a tab loads only its language's files; opening a session writes nothing", async () => {
  const host = hostWith("qa-java");
  const imp = await openPage(host, { engines: { "lint-java.js": JAVA, "vendor-eslint.js": FAKE_ESLINT } });
  await imp.ready();
  const ids = {};
  for (const p of ["qa-java", "qa-ts", "qa-api"]) {
    imp.document.querySelector("#profile").value = p;
    imp.document.querySelector("#profile").dispatchEvent(new imp.window.Event("change", { bubbles: true }));
    await imp.idle();
    ids[p] = (await importVia(imp, p)).session.id;
  }
  imp.close();

  const sb = await openPage(host);
  await sb.ready();
  await wait(2300); // past the one-time repair pass (it reads, finds nothing stale, loads nothing)
  await sb.idle();
  assert.deepEqual(sb.engineLoads, [], "idle sidebar");
  assert.equal(puts(sb).length, 0);

  const expect = { "qa-java": ["tree-sitter.js", "lint-java.js"], "qa-ts": ["vendor-eslint.js"], "qa-api": [] };
  for (const [p, files] of Object.entries(expect)) {
    const tab = await openPage(host, { sessionId: ids[p], engines: { "lint-java.js": JAVA, "vendor-eslint.js": FAKE_ESLINT } });
    await tab.ready();
    await wait(50);
    await tab.idle();
    assert.deepEqual(tab.engineLoads, files, p);
    assert.equal(puts(tab).length, 0, `${p}: opening writes nothing`);
    assert.deepEqual(tab.errors, []);
    tab.close();
  }
  sb.close();
});

test("an engine that fails to load: lint_missing, a current gen, no second analysis", async () => {
  const host = hostWith("qa-java");
  const sb = await openPage(host, { engineError: new Set(["lint-java.js"]) });
  await sb.ready();
  const put = await importVia(sb, "qa-java");
  assert.equal(put.session.lintNote, "static analysis: bundle not loaded");
  assert.equal(put.session.lintPending, undefined);
  assert.match(put.analyzedGen, /^[0-9a-f]{8}$/);
  const n = puts(sb).length;
  await wait(200);
  await sb.idle();
  assert.equal(puts(sb).length, n);
  sb.close();
});

test('analyzed while the engine was loading: saved as pending with gen "", analyzed again once on sl:engine-ready', async () => {
  const host = hostWith("qa-java");
  const sb = await openPage(host, { engines: { "lint-java.js": JAVA } });
  await sb.ready();
  const id = (await importVia(sb, "qa-java")).session.id;
  sb.close();

  // a spec save that (by a bug elsewhere) does not wait for the engine: the analysis runs while it is still booting
  let release;
  const hold = new Promise((r) => {
    release = r;
  });
  // phase 7: media/app.js is built by esbuild (one statement per line); the anchor must exist, or the test means nothing
  const noWait = (src) => {
    const rx =
      /(\$\("#spec-save"\)\.addEventListener\("click", async \(\) => \{\s*const spec = \$\("#spec"\)\.value;\s*)await needEngine\(curS\(\)\.profile\);/;
    assert.ok(rx.test(src), "the spec save handler is where the test expects it");
    return src.replace(rx, "$1");
  };
  const tab = await openPage(host, { sessionId: id, engines: { "lint-java.js": JAVA_SLOW }, engineHold: hold, patchApp: noWait });
  await tab.ready();
  assert.ok(tab.window.eval("typeof needEngine") === "undefined"); // closure-private, as it should be
  tab.document.querySelector("#spec").value = "R1: carts add items";
  click(tab, "#spec-save");
  await until(() => puts(tab).length === 1);
  await tab.idle();
  const pending = puts(tab)[0].payload;
  assert.equal(pending.session.lintPending, true);
  assert.equal(pending.session.lintNote, "static analysis: engine loading…");
  assert.equal(pending.analyzedGen, "");
  assert.equal(
    pending.session.findings.some((f) => f.source === "lint"),
    false,
  );
  assert.equal(tab.document.querySelector("#lint-note").textContent, "static analysis: engine loading…");

  release();
  await until(() => puts(tab).length === 2);
  await tab.idle();
  const done = puts(tab)[1].payload;
  assert.equal(done.session.lintPending, undefined);
  assert.match(done.analyzedGen, /^[0-9a-f]{8}$/);
  assert.ok(done.session.findings.some((f) => f.source === "lint"));
  assert.match(tab.document.querySelector("#lint-note").textContent, /1 findings/);

  tab.window.dispatchEvent(new tab.window.CustomEvent("sl:engine-ready", { detail: { language: "java" } }));
  await wait(100);
  await tab.idle();
  assert.equal(puts(tab).length, 2, "a second event writes nothing");
  assert.deepEqual(tab.errors, []);
  tab.close();
});

test("a session stored as pending is analyzed when its tab opens (ensureFresh waits for the engine)", async () => {
  const host = hostWith("qa-java");
  const sb = await openPage(host, { engines: { "lint-java.js": JAVA } });
  await sb.ready();
  const put = await importVia(sb, "qa-java");
  sb.close();
  // rewrite it as a pending one, the way a page without the engine would have saved it
  const s = Object.assign({}, put.session, {
    lintPending: true,
    lintNote: "static analysis: engine loading…",
    findings: put.session.findings.filter((f) => f.source !== "lint"),
  });
  const w = await openPage(host);
  await w.ready();
  const r = await w.window.__slSessionPut(s, { analyzedGen: "" });
  assert.ok(r.ok);
  w.close();
  const tab = await openPage(host, { sessionId: s.id, engines: { "lint-java.js": JAVA_SLOW } });
  await tab.ready();
  await until(() => puts(tab).length === 1);
  await tab.idle();
  assert.ok(puts(tab)[0].payload.session.findings.some((f) => f.source === "lint"));
  assert.match(puts(tab)[0].payload.analyzedGen, /^[0-9a-f]{8}$/);
  tab.close();
});

test("one-time repair: a session saved in 0.1.101 while tree-sitter was booting gets its lint findings, once", async () => {
  const host = hostWith("qa-java");
  const sb = await openPage(host, { engines: { "lint-java.js": JAVA } });
  await sb.ready();
  const put = await importVia(sb, "qa-java");
  sb.close();
  // what 0.1.101 saved: lint_failed with "still loading", no lint findings, a current gen
  const s = Object.assign({}, put.session, {
    lintNote: "ESLint could not parse any of 1 block(s) — regex checks kept. First error: CartTest.java: tree-sitter-java: still loading",
    lintWhy: ["src/test/java/CartTest.java: tree-sitter-java: still loading"],
    findings: put.session.findings.filter((f) => f.source !== "lint"),
  });
  const w = await openPage(host);
  await w.ready();
  assert.ok((await w.window.__slSessionPut(s, { analyzedGen: put.analyzedGen })).ok);
  w.close();

  const a = await openPage(host, { engines: { "lint-java.js": JAVA } });
  await a.ready();
  await until(() => puts(a).length === 1, 6000);
  await a.idle();
  assert.equal(puts(a)[0].payload.session.id, s.id);
  assert.ok(puts(a)[0].payload.session.findings.some((f) => f.source === "lint"));
  await until(() => a.sent.some((m) => m.type === "storage:set" && m.payload.values.lintRepair === 1));
  a.close();

  const b = await openPage(host, { engines: { "lint-java.js": JAVA } });
  await b.ready();
  await wait(2300);
  await b.idle();
  assert.deepEqual(
    b.sent.filter((m) => m.type === "session:get"),
    [],
    "the second start reads no session",
  );
  assert.deepEqual(b.engineLoads, []);
  b.close();
});

test("ESLint off: nothing is loaded anywhere", async () => {
  const host = hostWith("qa-java", { lint: false });
  const sb = await openPage(host, { engines: { "lint-java.js": JAVA } });
  await sb.ready();
  const put = await importVia(sb, "qa-java");
  assert.deepEqual(sb.engineLoads, []);
  assert.equal(put.session.lintNote, "");
  const tab = await openPage(host, { sessionId: put.session.id });
  await tab.ready();
  await wait(50);
  assert.deepEqual(tab.engineLoads, []);
  sb.close();
  tab.close();
});

test("the real ESLint bundle through the loader (jsdom, qa-ts): same lint findings as in Node", async () => {
  const host = hostWith("qa-ts");
  const sb = await openPage(host, { engines: { "vendor-eslint.js": read("vendor-eslint.js") } });
  await sb.ready();
  sb.window.structuredClone = structuredClone; // a webview has it; jsdom does not
  const put = await importVia(sb, "qa-ts");
  const want = JSON.parse(fs.readFileSync(path.join(root, "test", "__snapshots__", "lint-v0101.json"), "utf8"))["qa-ts"];
  const got = put.session.findings
    .filter((f) => f.source === "lint")
    .map((f) => f.rule)
    .sort();
  // lint findings that a regex check does not supersede keep their own place; compare the rules reported
  assert.deepEqual(got, want.findings.map((f) => f.rule).sort());
  assert.deepEqual(sb.errors, []);
  sb.close();
});
