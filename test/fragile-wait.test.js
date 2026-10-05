"use strict";
/* fragile_wait (regex side; ESLint's playwright, cypress and detox rules replace it where they run, see supersedes.test.js):
   `waitUntil: 'networkidle'` in written code, medium, kind networkidle, and an exact element count read with
   `.count()` and compared with `.toBe(n)`, low, kind count. What must not count: another waitUntil value, and a count
   compared with toBeGreaterThan.

   Detector gaps found while writing this file (5 Oct 2026), not pinned here, for the owner to decide:
   - commented-out code counts: `// await page.goto("/", { waitUntil: "networkidle" })` gives a medium finding (the
     same mistake duplicate_assert and weak_assert had before 0.1.120);
   - `page.waitForLoadState("networkidle")`, the other way to wait for network idle, is not reported;
   - qa-python has the check but no pattern for Python: `page.goto("/", wait_until="networkidle")` is not reported, and
     no lint rule maps to fragile_wait for Python;
   - the count pattern is narrow: `.toBe( 3 )` with spaces and `.toEqual(3)` are not reported.
   Open question, not a bug: `await expect(rows).toHaveCount(3)` is not reported. It is an exact count too, but it
   waits for the page, which is what Playwright advises. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");

const { Lens } = load();

const F = "e2e/cart.spec.ts";
const found = (code, kind = "write", profile = "qa-ts") =>
  Lens.runChecks([{ seq: 1, kind, file: kind === "message" ? undefined : F, text: "", new_content: code }], Lens.profile(profile))
    .filter((f) => f.check === "fragile_wait")
    .map((f) => `${f.severity} ${f.kind}: ${f.message}`);
const IDLE = `medium networkidle: ${F}: waitUntil: 'networkidle' on a live site — a flakiness source (Playwright advises against it)`;
const COUNT = `low count: ${F}: exact element count in an assertion — brittle when content changes`;

test("waitUntil: 'networkidle' is reported, medium, with either quote and without a space", () => {
  assert.deepEqual(found('await page.goto("/", { waitUntil: "networkidle" });'), [IDLE]);
  assert.deepEqual(found("await page.goto('/', { waitUntil: 'networkidle' });"), [IDLE]);
  assert.deepEqual(found('await page.goto("/",{waitUntil:"networkidle"});'), [IDLE]);
});

test("an exact count read with count() and compared with toBe is reported, low", () => {
  assert.deepEqual(found('expect(await page.getByRole("row").count()).toBe(3);'), [COUNT]);
});

test("both in one file: two findings", () => {
  assert.deepEqual(found('await page.goto("/", { waitUntil: "networkidle" });\nexpect(await rows.count()).toBe(3);'), [IDLE, COUNT]);
});

test("code shown in a message is checked too, named as such", () => {
  assert.deepEqual(found('await page.goto("/", { waitUntil: "networkidle" });', "message"), [
    "medium networkidle: code in message: waitUntil: 'networkidle' on a live site — a flakiness source (Playwright advises against it)",
  ]);
});

test("not reported: another waitUntil value, a count compared with toBeGreaterThan", () => {
  assert.deepEqual(found('await page.goto("/", { waitUntil: "domcontentloaded" });'), []);
  assert.deepEqual(found("expect(await rows.count()).toBeGreaterThan(0);"), []);
});

test("the profiles that run it", () => {
  const profiles = ["qa-ts", "qa-cypress", "qa-detox", "qa-python", "qa-java", "qa-c#", "qa-api", "qa-mobile", "qa-robot", "qa-generic"];
  assert.deepEqual(
    profiles.filter((p) => Lens.profile(p).checks.includes("fragile_wait")),
    ["qa-ts", "qa-cypress", "qa-detox", "qa-python", "qa-java", "qa-c#", "qa-api", "qa-mobile"],
  );
});
