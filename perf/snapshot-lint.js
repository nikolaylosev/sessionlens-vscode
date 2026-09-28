"use strict";
/* Phase 5: LensLint.run() of a checkout's media/lint.js, with the REAL engines (the three ESLint bundles through vm,
   the three tree-sitter engines booted in Node from the .wasm files of this checkout), over one small session per
   language. Prints { profile: { ran, note, findings } } as JSON.
   node perf/snapshot-lint.js <root> > test/__snapshots__/lint-v0101.json   (root: a 0.1.101 checkout)
   The test compares the current lint.js with that file: once an engine is loaded, lazy loading must not change what
   run() reports. */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const MEDIA = path.join(__dirname, "..", "media"); // the engines: vendor files, identical in both checkouts

const CODE = {
  "qa-ts": [
    "e2e/cart.spec.ts",
    `import { test, expect } from '@playwright/test';
test('cart', async ({ page }) => {
  await page.goto('/cart');
  await page.waitForTimeout(2000);
  if (await page.locator('.promo').isVisible()) { await page.click('.promo'); }
  await page.locator('div > span').nth(2).click();
  expect(await page.title()).toBeTruthy();
});
test.skip('later', async () => {});
`,
  ],
  "qa-cypress": [
    "cypress/e2e/login.cy.ts",
    `describe('login', () => {
  it('logs in', () => {
    cy.visit('/login');
    cy.wait(3000);
    cy.get('.btn').click({ force: true });
    cy.get('#form').get('input').type('x');
  });
});
`,
  ],
  "qa-detox": [
    "e2e/app.test.js",
    `describe('app', () => {
  it('opens', async () => {
    await element(by.id('go')).tap();
    await new Promise(r => setTimeout(r, 2000));
    await element(by.text('x')).atIndex(1).tap();
  });
});
`,
  ],
  "qa-java": [
    "src/test/java/CartTest.java",
    `class CartTest {
  @Test
  void add() {
    try { cart.add(1); } catch (Exception e) {}
    assertEquals(cart.size(), 1);
  }
  void remove() { cart.remove(1); }
}
`,
  ],
  "qa-c#": [
    "tests/CartTests.cs",
    `public class CartTests {
  [Test]
  public void Add() {
    try { cart.Add(1); } catch (Exception) { }
    Assert.AreEqual(cart.Count, 1);
  }
  public void Remove() { cart.Remove(1); }
}
`,
  ],
  "qa-python": [
    "tests/test_cart.py",
    `def test_add(cart):
    try:
        cart.add(1)
    except Exception:
        pass
    assert 1 == cart.size()

def test_click(page):
    page.click("#buy")
`,
  ],
  "qa-robot": [
    "tests/cart.robot",
    `*** Test Cases ***
Empty Case

Add Item
    Click Button    buy
    Sleep    2s
`,
  ],
};

function transcript(file, content) {
  const L = [];
  L.push(JSON.stringify({ type: "user", message: { role: "user", content: "Write tests" } }));
  L.push(
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: file, content } }] },
    }),
  );
  L.push(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }));
  return L.join("\n");
}

let engines = null;
async function loadEngines() {
  if (engines) return engines;
  // the Cypress bundle reads __dirname while it initializes (a leftover of a Node module it carries); a webview has a
  // harmless one via the bundle's own shim, Node's vm context has none
  if (typeof global.__dirname === "undefined") global.__dirname = MEDIA;
  for (const f of ["vendor-eslint.js", "vendor-eslint-cypress.js", "vendor-eslint-detox.js"])
    vm.runInThisContext(fs.readFileSync(path.join(MEDIA, f), "utf8"), { filename: f });
  global.TreeSitter = require(path.join(MEDIA, "tree-sitter.js"));
  global.LensLintJava = require(path.join(MEDIA, "lint-java.js"));
  global.LensLintCSharp = require(path.join(MEDIA, "lint-csharp.js"));
  global.LensLintPython = require(path.join(MEDIA, "lint-python.js"));
  global.LensLintRobot = require(path.join(MEDIA, "lint-robot.js"));
  const core = () => path.join(MEDIA, "tree-sitter.wasm");
  await global.LensLintJava.boot({ locateCore: core, javaWasmUrl: path.join(MEDIA, "tree-sitter-java.wasm") });
  await global.LensLintCSharp.boot({ locateCore: core, csharpWasmUrl: path.join(MEDIA, "tree-sitter-c_sharp.wasm") });
  await global.LensLintPython.boot({ locateCore: core, pythonWasmUrl: path.join(MEDIA, "tree-sitter-python.wasm") });
  for (const g of ["LensLintJava", "LensLintCSharp", "LensLintPython"])
    if (!global[g].isReady()) throw new Error(`${g} did not boot: ${global[g].bootError()}`);
  engines = true;
  return engines;
}

function fresh(root, file) {
  const p = path.join(root, "media", file);
  delete require.cache[require.resolve(p)];
  return require(p);
}

async function lintSnapshot(root) {
  await loadEngines();
  const I18N = fresh(root, "i18n.js");
  I18N.set("en");
  const Lens = fresh(root, "lens.js");
  const LensLint = fresh(root, "lint.js");
  const out = {};
  for (const [profile, [file, content]] of Object.entries(CODE)) {
    const cfg = Lens.profile(profile);
    const res = Lens.importAny(transcript(file, content), cfg);
    const events = Array.isArray(res) && res.length && res[0].events ? res[0].events : res;
    const r = LensLint.run({ events }, cfg, {});
    out[profile] = {
      ran: r.ran,
      note: r.note,
      findings: r.findings.map((f) => ({ check: f.check, severity: f.severity, rule: f.rule, line: f.line, message: f.message })),
    };
  }
  return out;
}

if (require.main === module)
  lintSnapshot(path.resolve(process.argv[2] || path.join(__dirname, ".."))).then((o) => {
    process.stdout.write(JSON.stringify(o, null, 1) + "\n");
    process.exit(0);
  });
module.exports = { lintSnapshot, CODE, transcript };
