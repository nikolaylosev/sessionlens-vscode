"use strict";
/* Phase 7, step 7A.3: which tests the specification coverage finds, per profile language and file type.
   In 0.1.103 every language without its own pattern (cypress, detox, mobile, robot, any) and Kotlin files fell back
   to the Python pattern, found no tests and reported every requirement as spec_uncovered (High). */
const test = require("node:test");
const assert = require("node:assert/strict");
global.I18N = require("../media/i18n.js");
const S = require("../media/spec.js");
const Lens = require("../media/lens.js");

const SPEC = S.parse("R1. User can log in\nR2. User sees an error on a wrong password\n");
const findings = (language, file, code) => S.checks(SPEC, [{ seq: 1, file, new_content: code }], language).findings.map((f) => f.check);

// the same two tests, R1 and R2, in every syntax the coverage reads
const CODE = {
  typescript:
    'describe("login", () => {\n  it("R1 logs in", () => {\n    cy.get("#ok").should("exist");\n  });\n  it("R2 shows an error", () => {\n    cy.get(".err").should("be.visible");\n  });\n});\n',
  python: 'def test_r1_login():\n    """R1"""\n    assert ok\n\ndef test_r2_error():\n    """R2"""\n    assert err\n',
  // Java-like syntaxes: the ID inside the test. A comment above every test but the first ends up in the body of the
  // test before it (as in 0.1.103; not changed in phase 7), so these fixtures do not rely on it.
  java: "class LoginTest {\n  @Test\n  void logsIn() {\n    // R1\n    assertTrue(ok);\n  }\n  @Test\n  void showsError() {\n    // R2\n    assertTrue(err);\n  }\n}\n",
  kotlin:
    "class LoginTest {\n    @Test\n    fun `R1 user logs in`() {\n        assertTrue(ok)\n    }\n\n    @Test fun r2ShowsError() {\n        // R2\n        assertTrue(err)\n    }\n}\n",
  csharp:
    "public class LoginTests {\n  [Fact]\n  public void LogsIn() {\n    // R1\n    Assert.True(ok);\n  }\n  [Fact]\n  public void ShowsError() {\n    // R2\n    Assert.True(err);\n  }\n}\n",
  go: "func TestLogin(t *testing.T) {\n  // R1\n  ok(t)\n}\nfunc TestError(t *testing.T) {\n  // R2\n  err(t)\n}\n",
  karate: "Feature: login\n\n  Scenario: R1 user logs in\n    Given url base\n\n  Scenario: R2 wrong password\n    Given url base\n",
  robot:
    "*** Settings ***\nLibrary    Browser\n\n*** Test Cases ***\nR1 User Logs In\n    Open Browser    ${URL}\n\nWrong Password Shows Error\n    [Documentation]    R2: the error text is shown\n    [Tags]    smoke\n    Fill Text    id=pw    x\n\n*** Keywords ***\nOpen Login\n    No Operation\n",
};
const EXT = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "typescript",
  ".mjs": "typescript",
  ".py": "python",
  ".java": "java",
  ".kt": "kotlin",
  ".cs": "csharp",
  ".go": "go",
  ".feature": "karate",
  ".robot": "robot",
};

test("0.1.103 cases: tests that cover R1 and R2 give no coverage findings any more", () => {
  const cases = [
    ["cypress", "cypress/e2e/login.cy.ts", CODE.typescript],
    ["detox", "e2e/login.test.js", CODE.typescript],
    ["mobile", "tests/login.spec.ts", CODE.typescript],
    ["robot", "tests/login.robot", CODE.robot],
    ["any", "login.spec.ts", CODE.typescript],
    ["java", "LoginTest.kt", CODE.kotlin],
    ["api", "LoginTest.kt", CODE.kotlin],
    ["mobile", "LoginTest.kt", CODE.kotlin],
  ];
  for (const [lang, file, code] of cases) assert.deepEqual(findings(lang, file, code), [], `${lang} ${file}`);
});

test("every visible profile × every extension it declares: a covering test covers, and nothing is reported otherwise", () => {
  for (const name of Lens.PROFILES) {
    const cfg = Lens.profile(name);
    for (const ext of cfg.code_ext) {
      const file = "src/login" + ext,
        x = S.extractorFor(cfg.language, file);
      if (x === null) {
        assert.equal(S.supports(cfg.language, file), false);
        assert.deepEqual(findings(cfg.language, file, "anything\n"), [], `${name} ${ext}: no extractor, no coverage findings`);
        continue;
      }
      const syntax = typeof x === "string" ? x : EXT[ext];
      // a single-language profile reads every file with its own syntax (qa-ts on a .js file, qa-java on .java)
      const code = CODE[syntax] || CODE[EXT[ext]];
      assert.deepEqual(findings(cfg.language, file, code), [], `${name} ${ext} (${syntax})`);
      assert.equal(S.tests(code, cfg.language, file).length, 2, `${name} ${ext}: two tests found`);
    }
  }
});

test("a file nothing can read does not count: no spec_uncovered, no test_without_requirement", () => {
  assert.equal(S.supports("mobile", "App.swift"), false);
  assert.deepEqual(findings("mobile", "App.swift", "func testLogin() {}\n"), []);
  assert.equal(S.supports("robot", "keywords.resource"), false);
  assert.deepEqual(findings("robot", "keywords.resource", CODE.robot), []);
  assert.equal(S.supports("any", "notes.txt"), false);
  assert.deepEqual(findings("unknown-language", "x.ts", CODE.typescript), []);
  // a readable file with no test for R2 still reports R2
  assert.deepEqual(findings("cypress", "a.cy.ts", 'it("R1 logs in", () => {\n  x();\n});\n'), ["spec_uncovered"]);
});

test("code without a file (in a message): api reads it as TS/JS as before, mobile and any try every syntax", () => {
  assert.equal(S.extractorFor("api", undefined), "typescript");
  assert.deepEqual(findings("mobile", undefined, CODE.python), []);
  assert.deepEqual(findings("any", undefined, CODE.python), []);
  assert.deepEqual(findings("any", undefined, CODE.robot), []);
});

test("Kotlin: plain names and names in backticks; Robot: [Documentation] links, Keywords are not tests", () => {
  assert.deepEqual(
    S.tests(CODE.kotlin, "java", "A.kt").map((t) => t.name),
    ["R1 user logs in", "r2ShowsError"],
  );
  const r = S.tests(CODE.robot, "robot", "a.robot");
  assert.deepEqual(
    r.map((t) => t.name),
    ["R1 User Logs In", "Wrong Password Shows Error"],
  );
  assert.deepEqual([...S.refs(r[1].header)], ["R2"]);
  assert.deepEqual(
    S.tests("*** Tasks ***\nR1 Pay Invoice\n    Log    x\n", "robot", "t.robot").map((t) => t.name),
    ["R1 Pay Invoice"],
  );
});

test("profiles that worked in 0.1.103 read their files exactly as before", () => {
  const same = [
    ["typescript", "a.ts", CODE.typescript],
    ["python", "a.py", CODE.python],
    ["java", "A.java", CODE.java],
    ["csharp", "A.cs", CODE.csharp],
    ["api", "a.py", CODE.python],
    ["api", "a.go", CODE.go],
    ["api", "a.feature", CODE.karate],
    ["api", "a.ts", CODE.typescript],
    ["api", "A.java", CODE.java],
    ["api", "A.cs", CODE.csharp],
  ];
  for (const [lang, file, code] of same) {
    assert.equal(S.tests(code, lang, file).length, 2, `${lang} ${file}`);
    assert.deepEqual(findings(lang, file, code), [], `${lang} ${file}`);
  }
});
