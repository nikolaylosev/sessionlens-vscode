"use strict";
/* config_weakened (phase 10, step 6): a test runner's config loosened — more retries, a longer timeout, tests
   excluded — compared with what the file was before. What must not count: a timeout made shorter, retries lowered, an
   unrelated config change, a config written for the first time (only its retries count, as before 0.1.113), and
   retries on a single test (that stays sleep_or_skip_added). After a red run, a run whose output is not in the transcript
   makes the finding medium; one whose output could not be parsed does not. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { load, M } = require("./helpers");

const { Lens } = load();

// steps: ["write", file, content] | ["edit", file, old, new] | ["bash", command, output]
function transcript(steps) {
  const L = [JSON.stringify({ type: "user", message: { role: "user", content: "Write the tests" } })];
  steps.forEach(([kind, a, b, c], i) => {
    const id = "t" + i;
    const input = kind === "write" ? { file_path: a, content: b } : kind === "edit" ? { file_path: a, old_string: b, new_string: c } : { command: a };
    const name = kind === "write" ? "Write" : kind === "edit" ? "Edit" : "Bash";
    L.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } }));
    L.push(
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: kind === "bash" ? b : "ok" }] } }),
    );
  });
  return L.join("\n");
}
const found = (profile, steps, check = "config_weakened") => {
  const cfg = Lens.profile(profile);
  return Lens.runChecks(Lens.importAny(transcript(steps), cfg), cfg)
    .filter((f) => f.check === check)
    .map((f) => `${f.severity}: ${f.message}`);
};
const PW = "export default defineConfig({\n  retries: 0,\n  timeout: 30_000,\n  expect: { timeout: 5000 },\n  use: { actionTimeout: 10 * 1000 },\n});\n";
const RED = ["bash", "npx playwright test", "2 passed, 1 failed"];

// a red run, then a re-run whose result is not known, then the change (0.1.123): output that could not be parsed is
// skipped, so the red run decides (high); output that is not in the transcript (output_missing, a Cursor import) makes
// the result unknown (medium), as in pass_claim_without_run. → [severities with unparsed output, with output_missing]
function afterUnknownRerun(profile, steps, check) {
  const cfg = Lens.profile(profile);
  const ev = Lens.importAny(transcript(steps), cfg);
  const sev = () =>
    Lens.runChecks(ev, cfg)
      .filter((f) => f.check === check)
      .map((f) => f.severity);
  const unparsed = sev();
  for (const e of ev) if (e.kind === "run_tests" && !e.tests) e.output_missing = true;
  return [unparsed, sev()];
}

test("Playwright: retries, timeouts and an exclusion, compared with the previous version", () => {
  assert.deepEqual(
    found("qa-ts", [
      ["write", "playwright.config.ts", PW],
      RED,
      ["edit", "playwright.config.ts", "  retries: 0,\n  timeout: 30_000,", "  retries: 2,\n  timeout: 120_000,\n  testIgnore: ['**/checkout*'],"],
    ]),
    [
      "high: playwright.config.ts: test config loosened — retries 0 → 2; timeout 30000 → 120000; " +
        "tests excluded “testIgnore: ['**/checkout*'],” — right after a failing run (seq 2)",
    ],
  );
  assert.deepEqual(
    found("qa-ts", [
      ["write", "playwright.config.ts", PW],
      ["edit", "playwright.config.ts", "expect: { timeout: 5000 }", "expect: { timeout: 15000 }"],
    ]),
    ["medium: playwright.config.ts: test config loosened — timeout 5000 → 15000"],
    "the expect timeout, second of two timeouts",
  );
  const loosen = ["edit", "playwright.config.ts", "retries: 0", "retries: 2"];
  assert.deepEqual(
    found("qa-ts", [["write", "playwright.config.ts", PW], ["bash", "npx playwright test", "browser launched"], loosen]),
    ["medium: playwright.config.ts: test config loosened — retries 0 → 2"],
    "a run whose output could not be parsed, no red run before it",
  );
  // a red run, then a re-run whose result is not known (0.1.123): see afterUnknownRerun
  assert.deepEqual(
    afterUnknownRerun("qa-ts", [["write", "playwright.config.ts", PW], RED, ["bash", "npx playwright test", "browser launched"], loosen], "config_weakened"),
    [["high"], ["medium"]],
  );
  assert.deepEqual(
    found("qa-ts", [
      ["write", "jest.config.js", "module.exports = { testEnvironment: 'node' };\n"],
      ["write", "jest.config.js", "module.exports = { testEnvironment: 'node', testTimeout: 60000 };\n"],
    ]),
    ["medium: jest.config.js: test config loosened — testTimeout 60000 added"],
  );
});

test("Cypress runMode retries and pytest reruns, timeout and --deselect", () => {
  assert.deepEqual(
    found("qa-cypress", [
      ["write", "cypress.config.ts", "export default defineConfig({ retries: { runMode: 0, openMode: 0 }, defaultCommandTimeout: 4000 });\n"],
      ["write", "cypress.config.ts", "export default defineConfig({ retries: { runMode: 3, openMode: 0 }, defaultCommandTimeout: 20000 });\n"],
    ]),
    ["medium: cypress.config.ts: test config loosened — retries 0 → 3; defaultCommandTimeout 4000 → 20000"],
  );
  assert.deepEqual(
    found("qa-python", [
      ["write", "pytest.ini", "[pytest]\nxfail_strict = true\naddopts = -q\ntimeout = 30\n"],
      ["bash", "pytest", "2 passed, 1 failed"],
      ["write", "pytest.ini", "[pytest]\nxfail_strict = true\naddopts = -q --reruns 2 --deselect tests/test_cart.py::test_discount\ntimeout = 300\n"],
    ]),
    [
      "high: pytest.ini: test config loosened — retries 0 → 2; timeout 30 → 300; " +
        "tests excluded “addopts = -q --reruns 2 --deselect tests/test_cart.py::test_discount” — right after a failing run (seq 2)",
    ],
  );
  assert.deepEqual(found("qa-python", [["write", "pytest.ini", "[pytest]\nxfail_strict = true\n"]], "expected_failure"), [], "pytest.ini is not code");
});

test("a first edit that the import reconstructs from toolUseResult is compared with originalFile (the demo)", () => {
  const D = require(M("demo-session.js"));
  const cfg = Lens.profile(D.PROFILE);
  assert.deepEqual(
    Lens.runChecks(Lens.importAny(D.TRANSCRIPT, cfg), cfg)
      .filter((f) => f.check === "config_weakened")
      .map((f) => `${f.severity}: ${f.message}`),
    ["high: playwright.config.ts: test config loosened — retries 0 → 2 — right after a failing run (seq 6)"],
  );
});

test("a config seen for the first time: only its retries count", () => {
  assert.deepEqual(found("qa-ts", [["write", "playwright.config.ts", PW.replace("retries: 0", "retries: 2")]]), [
    "medium: playwright.config.ts: test config loosened — retries 2",
  ]);
  assert.deepEqual(found("qa-ts", [["write", "playwright.config.ts", PW.replace("retries: 0", "retries: process.env.CI ? 2 : 0")]]), [], "the template");
  assert.deepEqual(found("qa-ts", [["write", "playwright.config.ts", PW.replace("30_000", "120_000")]]), [], "a timeout with nothing to compare");
});

test("not loosened: shorter timeouts, fewer retries, an unrelated change; retries on one test stay sleep_or_skip_added", () => {
  const none = (steps, why) => assert.deepEqual(found("qa-ts", steps), [], why);
  none(
    [
      ["write", "playwright.config.ts", PW],
      ["edit", "playwright.config.ts", "  timeout: 30_000,", "  timeout: 15_000,\n  reporter: 'html',"],
    ],
    "a shorter timeout, a reporter",
  );
  none(
    [
      ["write", "playwright.config.ts", PW.replace("retries: 0", "retries: 2")],
      ["edit", "playwright.config.ts", "retries: 2", "retries: 0"],
    ].slice(1),
    "an edit whose file the session never saw whole: a fragment",
  );
  const onTest = "import { test } from '@playwright/test';\ntest.describe.configure({ retries: 2 });\ntest('total', async () => {});\n";
  assert.deepEqual(found("qa-ts", [["write", "e2e/cart.spec.ts", onTest]]), []);
  assert.deepEqual(found("qa-ts", [["write", "e2e/cart.spec.ts", onTest]], "sleep_or_skip_added"), ["high: e2e/cart.spec.ts: skip / retry added"]);
});

/* 0.1.114: Maven (surefire, failsafe), Gradle and .runsettings. Only the parts about tests are read: other plugins of a
   pom.xml and other blocks of a Gradle script (jar, dependencies) have their own excludes and skips. */
const POM = `<project>
  <properties>
    <java.version>17</java.version>
  </properties>
  <build><plugins>
    <plugin>
      <groupId>org.jacoco</groupId>
      <artifactId>jacoco-maven-plugin</artifactId>
      <configuration><excludes><exclude>**/dto/**</exclude></excludes><skip>false</skip></configuration>
    </plugin>
    <plugin>
      <artifactId>maven-surefire-plugin</artifactId>
      <configuration>
        <forkedProcessTimeoutInSeconds>300</forkedProcessTimeoutInSeconds>
      </configuration>
    </plugin>
  </plugins></build>
</project>
`;
const GRADLE = "plugins { id 'java' }\njar {\n  exclude 'META-INF/*.SF'\n}\ntest {\n  useJUnitPlatform()\n}\n";
const RUNSETTINGS = "<RunSettings>\n  <RunConfiguration>\n    <TestSessionTimeout>60000</TestSessionTimeout>\n  </RunConfiguration>\n</RunSettings>\n";

test("Maven: surefire retries, timeout, excludes and testFailureIgnore; skipTests in the properties", () => {
  assert.deepEqual(
    found("qa-java", [
      ["write", "pom.xml", POM],
      ["bash", "mvn test", "Tests run: 3, Failures: 1, Errors: 0, Skipped: 0"],
      [
        "edit",
        "pom.xml",
        "        <forkedProcessTimeoutInSeconds>300</forkedProcessTimeoutInSeconds>",
        "        <forkedProcessTimeoutInSeconds>900</forkedProcessTimeoutInSeconds>\n        <rerunFailingTestsCount>2</rerunFailingTestsCount>\n" +
          "        <testFailureIgnore>true</testFailureIgnore>\n        <excludes>\n          <exclude>**/CheckoutIT.java</exclude>\n        </excludes>",
      ],
    ]),
    [
      "high: pom.xml: test config loosened — retries 0 → 2; forkedProcessTimeoutInSeconds 300 → 900; " +
        "tests excluded “<exclude>**/CheckoutIT.java</exclude>”; failures ignored or tests skipped “<testFailureIgnore>true</testFailureIgnore>” " +
        "— right after a failing run (seq 2)",
    ],
  );
  assert.deepEqual(
    found("qa-java", [
      ["write", "pom.xml", POM],
      ["edit", "pom.xml", "<java.version>17</java.version>", "<java.version>17</java.version>\n    <skipTests>true</skipTests>"],
    ]),
    ["medium: pom.xml: test config loosened — failures ignored or tests skipped “<skipTests>true</skipTests>”"],
  );
  assert.deepEqual(
    found("qa-java", [
      [
        "write",
        "pom.xml",
        POM.replace("<forkedProcessTimeoutInSeconds>300</forkedProcessTimeoutInSeconds>", "<rerunFailingTestsCount>2</rerunFailingTestsCount>"),
      ],
    ]),
    ["medium: pom.xml: test config loosened — retries 2"],
    "a pom.xml seen for the first time: only its retries count",
  );
  assert.deepEqual(found("qa-java", [["write", "pom.xml", POM]], "weak_assert"), [], "pom.xml is not code");
});

test("Gradle (Groovy and Kotlin): test-retry, excluded tests and tags, ignoreFailures", () => {
  assert.deepEqual(
    found("qa-java", [
      ["write", "build.gradle", GRADLE],
      ["bash", "./gradlew test", "Tests run: 3, Failures: 1, Errors: 0, Skipped: 0"],
      ["edit", "build.gradle", "  useJUnitPlatform()\n}", "  useJUnitPlatform { excludeTags 'slow' }\n  ignoreFailures = true\n  retry { maxRetries = 3 }\n}"],
    ]),
    [
      "high: build.gradle: test config loosened — retries 0 → 3; tests excluded “useJUnitPlatform { excludeTags 'slow' }”; " +
        "failures ignored or tests skipped “ignoreFailures = true” — right after a failing run (seq 2)",
    ],
  );
  assert.deepEqual(
    found("qa-java", [
      ["write", "build.gradle.kts", "tasks.withType<Test> {\n    useJUnitPlatform()\n}\n"],
      [
        "edit",
        "build.gradle.kts",
        "    useJUnitPlatform()",
        '    useJUnitPlatform()\n    filter { excludeTestsMatching("*CheckoutTest") }\n    retry { maxRetries.set(2) }',
      ],
    ]),
    ['medium: build.gradle.kts: test config loosened — retries 0 → 2; tests excluded “filter { excludeTestsMatching("*CheckoutTest") }”'],
  );
});

test(".runsettings: a longer session timeout and a test case filter", () => {
  assert.deepEqual(
    found("qa-c#", [
      ["write", "tests/test.runsettings", RUNSETTINGS],
      ["bash", "dotnet test", "Failed!  - Failed:     1, Passed:     4, Skipped:     0, Total:     5"],
      [
        "edit",
        "tests/test.runsettings",
        "    <TestSessionTimeout>60000</TestSessionTimeout>",
        "    <TestSessionTimeout>600000</TestSessionTimeout>\n    <TestCaseFilter>Category!=Flaky</TestCaseFilter>",
      ],
    ]),
    [
      "high: tests/test.runsettings: test config loosened — TestSessionTimeout 60000 → 600000; " +
        "tests excluded “<TestCaseFilter>Category!=Flaky</TestCaseFilter>” — right after a failing run (seq 2)",
    ],
  );
});

test("Maven, Gradle, .runsettings not loosened: other plugins and blocks, a shorter timeout", () => {
  const none = (profile, steps, why) => assert.deepEqual(found(profile, steps), [], why);
  none(
    "qa-java",
    [
      ["write", "pom.xml", POM],
      ["edit", "pom.xml", "<exclude>**/dto/**</exclude><skip>false</skip>", "<exclude>**/dto/**</exclude><exclude>**/config/**</exclude><skip>true</skip>"],
    ],
    "jacoco's excludes and skip",
  );
  none(
    "qa-java",
    [
      ["write", "build.gradle", GRADLE],
      ["edit", "build.gradle", "  exclude 'META-INF/*.SF'", "  exclude 'META-INF/*.SF'\n  exclude 'META-INF/*.RSA'"],
    ],
    "an exclude in the jar block",
  );
  none(
    "qa-java",
    [
      ["write", "pom.xml", POM],
      ["edit", "pom.xml", "<forkedProcessTimeoutInSeconds>300<", "<forkedProcessTimeoutInSeconds>120<"],
    ],
    "a shorter timeout",
  );
  none(
    "qa-c#",
    [
      ["write", "tests/test.runsettings", RUNSETTINGS],
      ["edit", "tests/test.runsettings", "60000", "30000"],
    ],
    "a shorter timeout",
  );
});
