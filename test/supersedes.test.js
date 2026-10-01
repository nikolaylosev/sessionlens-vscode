"use strict";
/* LensLint.merge() drops a regex finding only when the engine of the profile's language looks for the same thing
   (RULES-ARCHITECTURE §6.3). Until 0.1.113 any engine that parsed the file dropped every regex finding of the four
   SUPERSEDES checks: Java, C# and Python, whose engines have no rule for sleeps or skips, lost Thread.sleep, @Disabled,
   time.sleep, @pytest.mark.skip...; Cypress and Detox lost it.skip. Real engines, as analyzeNow() runs them. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { load, M } = require("./helpers");
const { loadEngines } = require("../perf/snapshot-lint");

const { Lens } = load();
const LensLint = require(M("lint.js"));

// → the sleep_or_skip_added / conditional_logic / duplicate_assert findings after the merge, as "check/source kind"
async function merged(profile, file, content) {
  await loadEngines();
  const cfg = Lens.profile(profile);
  const events = [{ seq: 1, kind: "write", file, new_content: content }];
  const lr = LensLint.run({ events }, cfg, {});
  assert.equal(lr.ran, true, `${profile}: the engine did not parse ${file}: ${lr.note}`);
  return LensLint.merge(Lens.runChecks(events, cfg), lr.findings, cfg.language)
    .filter((f) => LensLint.SUPERSEDES.has(f.check))
    .map((f) => `${f.check}/${f.source}${f.kind ? " " + f.kind : ""}`)
    .sort();
}

test("Java, C# and Python: sleeps and skips are reported although their engines do not look for them", async () => {
  assert.deepEqual(
    await merged(
      "qa-java",
      "src/test/java/CartTest.java",
      "class CartTest {\n  @Disabled\n  @Test\n  void total() throws Exception { Thread.sleep(2000); assertEquals(expected, cart.total()); }\n}\n",
    ),
    ["sleep_or_skip_added/formal skip", "sleep_or_skip_added/formal sleep"],
  );
  assert.deepEqual(
    await merged(
      "qa-c#",
      "Tests/CartTests.cs",
      'public class CartTests {\n  [Test, Ignore("x")]\n  public void Total() { Thread.Sleep(2000); Assert.AreEqual(expected, cart.Total()); }\n}\n',
    ),
    ["sleep_or_skip_added/formal skip", "sleep_or_skip_added/formal sleep"],
  );
  assert.deepEqual(
    await merged(
      "qa-python",
      "tests/test_cart.py",
      "import time, pytest\n\n@pytest.mark.skip\ndef test_total():\n    time.sleep(2)\n    assert total() == expected\n",
    ),
    ["sleep_or_skip_added/formal skip", "sleep_or_skip_added/formal sleep"],
  );
});

test("Cypress and Detox: their engines find the sleep, the regex still finds the skip", async () => {
  assert.deepEqual(
    await merged(
      "qa-cypress",
      "cypress/e2e/cart.cy.ts",
      "describe('cart', () => {\n  it.skip('total', () => {\n    cy.wait(2000);\n    cy.contains('Total').should('be.visible');\n  });\n});\n",
    ),
    ["sleep_or_skip_added/formal skip", "sleep_or_skip_added/lint"],
  );
  assert.deepEqual(
    await merged(
      "qa-detox",
      "e2e/cart.test.js",
      "describe('cart', () => {\n  it.skip('total', async () => {\n    await new Promise((r) => setTimeout(r, 2000));\n    await expect(element(by.id('total'))).toBeVisible();\n  });\n});\n",
    ),
    ["sleep_or_skip_added/formal skip", "sleep_or_skip_added/lint"],
  );
});

test("Playwright: the engine finds sleeps and skips itself, so the regex ones are dropped; a retry is kept", async () => {
  assert.deepEqual(
    await merged(
      "qa-ts",
      "e2e/cart.spec.ts",
      "import { test, expect } from '@playwright/test';\ntest.skip('total', async ({ page }) => {\n  await page.waitForTimeout(2000);\n  await expect(page.getByText('Total')).toBeVisible();\n});\n",
    ),
    ["sleep_or_skip_added/lint", "sleep_or_skip_added/lint"],
  );
  assert.deepEqual(
    await merged(
      "qa-ts",
      "e2e/cart.spec.ts",
      "import { test, expect } from '@playwright/test';\ntest.describe.configure({ retries: 2 });\ntest('total', async ({ page }) => {\n  await expect(page.getByText('Total')).toBeVisible();\n});\n",
    ),
    ["sleep_or_skip_added/formal retry"],
  );
});

test("covers(): an engine replaces only what its own rules look for", () => {
  for (const l of ["java", "python", "csharp", "api"]) assert.deepEqual([...LensLint.covers(l)], [], l);
  assert.deepEqual([...LensLint.covers("cypress")], ["sleep_or_skip_added|sleep"], "not cy.pause, not .and()");
  assert.deepEqual([...LensLint.covers("detox")], ["sleep_or_skip_added|sleep"]);
  assert.deepEqual([...LensLint.covers("robot")].sort(), ["sleep_or_skip_added|skip", "sleep_or_skip_added|sleep"]);
  assert.deepEqual([...LensLint.covers("typescript")].sort(), [
    "conditional_logic|branch",
    "fragile_wait|networkidle",
    "sleep_or_skip_added|skip",
    "sleep_or_skip_added|sleep",
  ]);
});

test("every engine rule reported under a SUPERSEDES name is decided: what it replaces, if anything", () => {
  const undecided = [];
  for (const map of Object.values(LensLint.RULE_MAPS))
    for (const [rule, [check]] of Object.entries(map))
      if (LensLint.SUPERSEDES.has(check) && !(rule in LensLint.SAME_AS_REGEX)) undecided.push(`${rule} → ${check}`);
  assert.deepEqual(undecided, [], "add it to SAME_AS_REGEX in lint.js: the kinds of regex finding it replaces, or [] for none");
  for (const [rule, kinds] of Object.entries(LensLint.SAME_AS_REGEX)) {
    const map = Object.values(LensLint.RULE_MAPS).find((m) => rule in m);
    assert.ok(map, `${rule}: in SAME_AS_REGEX but in no rule map`);
    for (const k of kinds) assert.equal(k.split("|")[0], map[rule][0], `${rule}: replaces ${k} but is reported as ${map[rule][0]}`);
  }
});
