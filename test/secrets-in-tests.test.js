"use strict";
/* hardcoded_secret and hardcoded_base_url (phase 10, step 3): since 0.1.113 also in qa-ts, qa-cypress, qa-detox and
   qa-mobile, not only qa-api. What must not count: a runner's config file for the base URL, a relative goto(), a
   value typed into a field, an environment variable, a placeholder. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");

const { Lens } = load();

const found = (profile, file, content) =>
  Lens.runChecks([{ seq: 1, kind: "write", file, new_content: content }], Lens.profile(profile))
    .filter((f) => f.check === "hardcoded_secret" || f.check === "hardcoded_base_url")
    .map((f) => `${f.check}: ${f.message}`)
    .sort();

const UI = {
  "qa-ts": "e2e/orders.spec.ts",
  "qa-cypress": "cypress/e2e/orders.cy.ts",
  "qa-detox": "e2e/orders.test.js",
  "qa-mobile": "tests/orders.spec.ts",
  "qa-api": "tests/orders.spec.ts",
};

test("a token and a staging host in a UI test are reported in the web and mobile profiles", () => {
  for (const [profile, file] of Object.entries(UI))
    assert.deepEqual(
      found(profile, file, "const token = 'sk_live_51HxQ2bE8aZ0kLmN';\nconst url = 'https://staging.shop-acme.io/orders';\n"),
      [
        `hardcoded_base_url: ${file}: hard-coded host staging.shop-acme.io — take the base URL from configuration`,
        `hardcoded_secret: ${file}: credential in the code — secret assigned in code: “sk_l… (24)”`,
      ],
      profile,
    );
});

test("not reported: the base URL in a runner's config, a relative goto, a typed value, an env variable, a placeholder", () => {
  const none = (file, content, why) => assert.deepEqual(found("qa-ts", file, content), [], why);
  none("playwright.config.ts", "export default defineConfig({ use: { baseURL: 'https://staging.shop-acme.io' } });\n", "playwright config");
  none("cypress.config.ts", "export default defineConfig({ e2e: { baseUrl: 'https://staging.shop-acme.io' } });\n", "cypress config");
  none("wdio.conf.ts", "export const config = { baseUrl: 'https://staging.shop-acme.io' };\n", "webdriverio config");
  none("e2e/login.spec.ts", "await page.goto('/login');\nawait page.getByLabel('Password').fill('s3cret-Passw0rd');\n", "relative goto, typed value");
  none("e2e/login.spec.ts", "const token = process.env.API_TOKEN;\nconst password = 'your-password';\n", "env variable, placeholder");
  assert.equal(found("qa-ts", "playwright.config.ts", "const token = 'sk_live_51HxQ2bE8aZ0kLmN';\n").length, 1, "a key in a config is still a key");
});

test("Java, C# and Python profiles are not changed", () => {
  for (const p of ["qa-java", "qa-c#", "qa-python"]) {
    const cks = Lens.profile(p).checks;
    assert.ok(!cks.includes("hardcoded_secret") && !cks.includes("hardcoded_base_url"), p);
  }
});
