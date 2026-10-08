// @ts-check
/* sessionlens core — parsing, profiles, checks. No DOM, no chrome.* here; usable from node for tests. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else /** @type {any} */ (root).Lens = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const I = () => (typeof I18N !== "undefined" ? I18N : require("./i18n.js"));
  const T = (k, v) => I().t(k, v);
  const inMsg = () => T("in_msg");
  const C = () => (typeof LensChecks !== "undefined" ? LensChecks : require("./checks.js"));

  // ---------- profiles ----------
  const KW = {
    plan_markers: ["| Требование", "| Requirement", "ПЛАН", "PLAN"],
    triage_markers: ["гипотез", "баг продукта", "ошибка теста", "дефект спец", "hypothesis", "product bug", "test bug", "spec defect"],
    pass_claim_patterns: ["тесты проходят", "все проходят", "проходит", "должны пройти", "tests pass", "all pass", "passing", "should pass", "all green"],
    assumption_patterns: [
      /предполож/i,
      /предположени/i,
      /будем считать/i,
      /(?:^|[^а-яё])видимо(?![а-яё])/i,
      /скорее всего/i,
      /по-видимому/i,
      /\bi assume\b/i,
      /\bassuming\b/i,
      /\bpresumably\b/i,
      /\bprobably\b/i,
      /\bseems like\b/i,
    ],
    edit_churn_threshold: 4,
    pass_claim_lookback: 6,
  };
  const PROCESS = [
    "pass_claim_without_run",
    "fix_after_fail_without_triage",
    "scope_creep",
    "edit_churn",
    "assumption_instead_of_question",
    "user_frustration",
  ];
  const METHOD = ["peeked_at_src_before_plan", "stop_markers_missing"];
  const CODE = [
    "assert_weakened",
    "weak_assert",
    "sleep_or_skip_added",
    "tests_never_run",
    "hardcoded_date",
    "fragile_wait",
    "expected_failure",
    "magic_number",
    "assertion_roulette",
    "conditional_logic",
    "duplicate_assert",
    "test_deleted",
    "product_code_edited",
    "snapshot_overwritten",
  ];
  const API = [
    "status_only_assert",
    "mocked_service",
    "hardcoded_secret",
    "hardcoded_base_url",
    "no_negative_cases",
    "test_data_no_cleanup",
    "response_time_assert",
  ];
  /* qa-mobile is language-agnostic like qa-api: Appium is a protocol, not a language — the same client
     API concepts (locator strategy, gesture coordinates, driver lifecycle) show up whether the test is
     Java + appium-java-client, Python + Appium-Python-Client, WebdriverIO, or the .NET client. */
  const MOBILE = ["mobile_raw_locator", "hardcoded_coordinates", "no_driver_teardown"];
  // part of API (qa-api); since 0.1.113 also in the web and mobile profiles: a token or a staging host in a UI test
  const SECRETS = ["hardcoded_secret", "hardcoded_base_url"];
  /* .only / fit / fdescribe: only the focused tests run, the rest are silently skipped (not a skip: that one is
     visible in the report). debug_patterns: kind → pattern; the kind is what LensLint.merge() compares with what the
     profile's engine looks for (page.pause and cy.pause are "pause", cy.debug is "debug"). */
  /* Since 0.1.121: .only.each (Jest); fit / fdescribe only as a call with a title, not a method (model.fit(data)); a
     debugger statement or a pdb call after ";", ")" or "{" on its line too (`import pdb; pdb.set_trace()`). */
  const FOCUS_JS = [/\b(?:it|test|describe|context)(?:\.describe)?\.only(?:\.each)?\s*[(`]/, /(?<![.\w$])(?:fit|fdescribe)\s*\(\s*['"`]/];
  const DEBUGGER_JS = /(?<=^|[;{})])\s*debugger\s*(?:;|$)/m;
  const BREAKPOINT_PY = /(?<=^|;)\s*(?:breakpoint\s*\(\s*\)|(?:i?pdb)\.set_trace\s*\(\s*\))/m;
  /* A fixed delay: a call whose argument is a number or, since 0.1.121, a named constant (DELAY, Timeouts.SHORT,
     config.WAIT_MS), since the rule is "no sleep with a constant". A lowercase variable is left alone: a polling helper,
     the way the rule says to wait, sleeps for its interval. `num` is how a number has to start (setTimeout and cy.wait
     need three digits: a short tick is not a wait). */
  const NAMED = String.raw`(?:\w+\.)*[A-Z][A-Z0-9_]+\b`;
  const delayCall = (call, num = String.raw`\d`) => new RegExp(call + String.raw`\s*\(\s*(?:` + num + "|" + NAMED + ")");
  const SET_TIMEOUT = new RegExp(String.raw`setTimeout\s*\([^,]+,\s*(?:\d{3,}|` + NAMED + ")");
  /* qa-api is language-agnostic: API tests are written in whatever the team uses, so the profile carries the
     patterns of every common stack (pytest + requests/httpx, REST Assured, Jest/Vitest/Playwright + Supertest/axios,
     xUnit/NUnit + HttpClient/RestSharp, Go, Postman scripts, Karate). */
  const API_TEST_PATTERNS = [
    /(?:async\s+)?def\s+(test\w*)\s*\(/g,
    /@Test[^\n]*\n(?:\s*@\w+[^\n]*\n)*\s*(?:public\s+)?(?:static\s+)?(?:void|fun)\s+`?(\w[\w ]*?)`?\s*\(/g,
    /\b(?:it|test)(?:\.\w+)?\s*\(\s*['"`]([^'"`]+)['"`]/g,
    /\[(?:Test|Fact|Theory|TestMethod|TestCase)\b[^\]]*\](?:\s*\[[^\]]*\])*\s*(?:public\s+)?(?:async\s+)?(?:Task|void)\s+(\w+)/g,
    /func\s+(Test\w+)\s*\(/g,
    /\bpm\.test\s*\(\s*\\?['"`]([^'"`\\]+)/g,
    /^[ \t]*Scenario(?: Outline)?:\s*(.+)$/gm,
  ];
  // An assertion line that only looks at the HTTP status. A body field that happens to be called "status" is content.
  const STATUS_RX =
    /status_?code|statusCode|\.status\b|\.status\s*\(|\bstatus\s*\(|\bstatus\s+\d{3}|StatusCode|\.ok\b|\.ok\s*\(\)|raise_for_status|EnsureSuccessStatusCode|IsSuccessStatusCode|responseStatus|response\.code|to\.have\.status|to\.be\.ok|HttpStatus/i;
  const CONTENT_HINT =
    /\.json\s*\(|\.text\b|\.content\b|\.body\b(?!\s*\()|\.body\s*\(\s*["'][^"']*["']\s*,|\.headers?\b|\.data\b|\[\s*["'][^"']+["']\s*\]|jsonPath|contentType|\.get\s*\(\s*["']/;
  const isStatusLine = (l) => {
    const seg = (l.includes(".then()") ? l.slice(l.indexOf(".then()")) : l).replace(/\b(?:body|data|result|payload|json)\.status\b/g, ""); // REST Assured: only what follows then() is a check
    return STATUS_RX.test(seg) && !CONTENT_HINT.test(seg);
  };
  // Order here = order in the Profile dropdown (qa-go is kept as a hidden legacy profile so old sessions still analyse correctly)
  const PROFILES = {
    "qa-ts": {
      language: "typescript",
      code_ext: [".ts", ".tsx", ".js", ".mjs"],
      test_runner: "jest",
      // `npm run test` takes the usual scripts too: npm run test:e2e, npm run test:ui (0.1.121; before, no run)
      test_runner_patterns: ["jest", "vitest", "npm test", "npm run test", "playwright test", "pnpm test", "pnpm run test", "yarn test", "yarn run test"],
      src_dirs: ["src", "app", "lib"],
      test_dirs: ["tests", "test", "__tests__", "e2e"],
      checks: [...METHOD, ...PROCESS, ...CODE, "focused_test", "debug_leftover", ...SECRETS, "config_weakened"],
      sleep_patterns: [delayCall(String.raw`\bwaitForTimeout`), SET_TIMEOUT],
      focus_patterns: FOCUS_JS,
      debug_patterns: { pause: /\bpage\.pause\s*\(/, debugger: DEBUGGER_JS },
      skip_patterns: [/\b(?:it|test|describe)\.skip\b/, /\btest\.fixme\b/, /\bretries\s*:\s*[1-9]/],
      weak_assert_patterns: [
        /expect\s*\([^)]*\)\s*\.toBeDefined\s*\(\)/g,
        /expect\s*\([^)]*\)\s*\.toBeTruthy\s*\(\)/g,
        /expect\s*\(\s*true\s*\)\s*\.toBe\s*\(\s*true\s*\)/g,
      ],
      assert_line_patterns: [/\bexpect\s*\(/],
      test_fn_pattern: /\b(?:it|test)\s*\(\s*['"`]([^'"`]+)['"`]/g,
      weaken_pairs: [
        [
          /\.(?:toBe|toEqual|toStrictEqual|toHaveLength|toMatch|toContain|toHaveAttribute|toHaveText|toHaveURL|toHaveTitle|toHaveCount|toBeLessThan\w*|toBeGreaterThan\w*)\s*\(/,
          /toBeDefined|toBeTruthy|not\.toBeNull|not\.toBeUndefined|toBeVisible\(\)\s*;?\s*$/,
        ],
        [/toEqual\s*\(/, /toMatchObject/],
      ],
    },
    "qa-python": {
      language: "python",
      code_ext: [".py"],
      test_runner: "pytest",
      test_runner_patterns: ["pytest"],
      src_dirs: ["src", "app", "services", "lib"],
      test_dirs: ["tests", "test"],
      checks: [...METHOD, ...PROCESS, ...CODE, "debug_leftover", "config_weakened"],
      sleep_patterns: [delayCall(String.raw`\btime\.sleep`, String.raw`[\d.]`), delayCall(String.raw`\basyncio\.sleep`, String.raw`[\d.]`)],
      debug_patterns: { pause: /\bpage\.pause\s*\(/, breakpoint: BREAKPOINT_PY }, // Playwright for Python too (0.1.121)
      // pytest-rerunfailures: reruns=N in a marker, --reruns N on a command line (not the word in a docstring, 0.1.121)
      skip_patterns: [/mark\.skip/, /\breruns\s*=\s*[1-9]/, /--reruns(?:\s+|=)[1-9]/, /@flaky/, /\bretry\s*=/],
      weak_assert_patterns: [
        /assert\s+[^\n]+?\.status_code\s*(?:<|<=|!=)\s*\d+/g,
        /assert\s+True\b/g,
        /assert\s+[\w.]+(?:\(\))?(?:\[[^\]]+\])*\s*$/gm,
        /assert\s+[^\n]+?\s+is\s+not\s+None\s*$/gm,
      ],
      assert_line_patterns: [/^\s*assert\b/],
      test_fn_pattern: /(?:async\s+)?def\s+(test\w*)\s*\(/g,
      weaken_pairs: [
        [/==\s*/, /\bin\b|!=|<|>|is not None/],
        [/==\s*["'\d]/, /\bANY\b/],
      ],
    },
    "qa-java": {
      language: "java",
      code_ext: [".java", ".kt"],
      test_runner: "junit",
      test_runner_patterns: ["mvn test", "mvn verify", "gradle test", "gradlew"],
      src_dirs: ["src/main"],
      test_dirs: ["src/test"],
      checks: [...METHOD, ...PROCESS, ...CODE, "config_weakened"],
      sleep_patterns: [delayCall(String.raw`\bThread\.sleep`), /\bTimeUnit\.\w+\.sleep\s*\(/],
      skip_patterns: [/@Disabled/, /@Ignore\b/, /@Retry\b/],
      weak_assert_patterns: [/assertNotNull\s*\([^)]*\)\s*;/g, /assertTrue\s*\(\s*true\s*\)/g, /assertThat\s*\([^)]*\)\s*\.isNotNull\s*\(\)\s*;/g],
      assert_line_patterns: [/\bassert\w*\s*\(/, /\bassertThat\s*\(/],
      test_fn_pattern: /@Test[^\n]*\n\s*(?:public\s+)?void\s+(\w+)/g,
      weaken_pairs: [
        [/assertEquals/, /assertTrue\s*\([^)]*contains|assertNotNull/],
        [/isEqualTo/, /contains|isNotNull|isNotEmpty/],
      ],
    },
    "qa-c#": {
      language: "csharp",
      code_ext: [".cs"],
      test_runner: "dotnet",
      test_runner_patterns: ["dotnet test"],
      src_dirs: ["src"],
      test_dirs: ["tests", "test"],
      checks: [...METHOD, ...PROCESS, ...CODE, "config_weakened"],
      sleep_patterns: [delayCall(String.raw`\bThread\.Sleep`), delayCall(String.raw`\bTask\.Delay`)],
      skip_patterns: [
        /\[(?:[^\]\n]*,\s*)?Ignore\b/,
        /\[(?:[^\]\n]*,\s*)?Explicit\b/,
        /\[(?:[^\]\n]*,\s*)?Retry\b/,
        /\[(?:Fact|Theory)\s*\([^)]*Skip\s*=/,
        /\bAssert\.(?:Ignore|Inconclusive)\s*\(/,
      ],
      weak_assert_patterns: [
        /Assert\.(?:NotNull|IsNotNull)\s*\([^)]*\)\s*;/g,
        /Assert\.(?:True|IsTrue)\s*\(\s*true\s*\)/g,
        /Assert\.That\s*\([^;]*Is\.Not\.Null\s*\)\s*;/g,
        /\.Should\(\)\.NotBeNull\(\)\s*;/g,
      ],
      assert_line_patterns: [/\bAssert\.\w+\s*\(/, /\.Should\(\)/],
      test_fn_pattern: /\[(?:Test|Fact|Theory|TestMethod|TestCase)\b[^\]]*\](?:\s*\[[^\]]*\])*\s*(?:public\s+)?(?:async\s+)?(?:Task|void)\s+(\w+)/g,
      weaken_pairs: [
        [/Assert\.(?:AreEqual|Equal)/, /Assert\.(?:True|IsTrue|NotNull|IsNotNull|Contains)/],
        [/Is\.EqualTo|\.Should\(\)\.Be\(/, /Is\.Not\.Null|NotBeNull|Contains/],
      ],
    },
    "qa-api": {
      language: "api",
      code_ext: [".py", ".java", ".kt", ".ts", ".tsx", ".js", ".mjs", ".cs", ".go", ".feature", ".postman_collection.json", ".postman_environment.json"],
      test_runner: "auto",
      test_runner_patterns: [
        "pytest",
        "npm test",
        "npm run test",
        "jest",
        "vitest",
        "playwright test",
        "mvn test",
        "mvn verify",
        "gradle test",
        "gradlew",
        "dotnet test",
        "go test",
        "newman",
        "karate",
      ],
      src_dirs: ["src", "app", "services", "lib", "controllers", "routes", "handlers"],
      test_dirs: ["tests", "test", "__tests__", "e2e", "api-tests", "src/test"],
      checks: [...METHOD, ...PROCESS, ...CODE, "focused_test", "debug_leftover", "config_weakened", ...API],
      sleep_patterns: [
        delayCall(String.raw`\btime\.sleep`, String.raw`[\d.]`),
        delayCall(String.raw`\basyncio\.sleep`, String.raw`[\d.]`),
        delayCall(String.raw`\bThread\.sleep`),
        /\bTimeUnit\.\w+\.sleep\s*\(/,
        delayCall(String.raw`\bTask\.Delay`),
        delayCall(String.raw`\bwaitForTimeout`),
        SET_TIMEOUT,
        /\bkarate\.sleep\s*\(/,
        /\btime\.Sleep\s*\(/,
      ],
      focus_patterns: FOCUS_JS,
      debug_patterns: { pause: /\bpage\.pause\s*\(/, debugger: DEBUGGER_JS, breakpoint: BREAKPOINT_PY },
      skip_patterns: [
        /mark\.skip/,
        /\breruns\s*=\s*[1-9]/,
        /--reruns(?:\s+|=)[1-9]/,
        /@flaky/,
        /\bretry\s*=/,
        /@Disabled/,
        /@Ignore\b/,
        /@Retry\b/,
        /\b(?:it|test|describe)\.skip\b/,
        /\btest\.fixme\b/,
        /\bretries\s*:\s*[1-9]/,
        /\[(?:[^\]\n]*,\s*)?Ignore\b/,
        /\[(?:[^\]\n]*,\s*)?Explicit\b/,
        /\[(?:[^\]\n]*,\s*)?Retry\b/,
        /\[(?:Fact|Theory)\s*\([^)]*Skip\s*=/,
        /\bt\.Skip\w*\s*\(/,
        /^\s*@ignore\b/m,
        /\bpm\.test\.skip\b/,
      ],
      weak_assert_patterns: [
        /assert\s+[^\n]+?\.status_code\s*(?:<|<=|!=|>=)\s*\d+\s*$/gm,
        /assert\s+True\b/g,
        /assert\s+[\w.]+(?:\(\))?(?:\[[^\]]+\])*\s*$/gm,
        /assert\s+[^\n]+?\s+is\s+not\s+None\s*$/gm,
        /\.statusCode\s*\(\s*(?:lessThan|greaterThanOrEqualTo|greaterThan|not)\s*\(/g,
        /assertNotNull\s*\([^)]*\)\s*;/g,
        /assertTrue\s*\(\s*true\s*\)/g,
        /expect\s*\([^)]*status[^)]*\)\s*\.(?:toBeLessThan|toBeLessThanOrEqual|toBeGreaterThan|toBeGreaterThanOrEqual|not\.toBe)\s*\(/g,
        /expect\s*\([^)]*\)\s*\.toBeDefined\s*\(\)/g,
        /expect\s*\(\s*true\s*\)\s*\.toBe\s*\(\s*true\s*\)/g,
        /Assert\.(?:NotNull|IsNotNull)\s*\([^)]*\)\s*;/g,
        /\.Should\(\)\.NotBeNull\(\)\s*;/g,
        /pm\.expect\s*\(\s*pm\.response\.code\s*\)\s*\.to\.(?:be\.)?(?:below|above|at\.(?:least|most)|not\.(?:equal|eql))\s*\(/g,
        /pm\.expect\s*\(\s*true\s*\)/g,
        /assert\s+responseStatus\s*(?:<|<=|!=|>=|>)/g,
        /match\s+response\s*==\s*['"]#(?:notnull|present)['"]/g,
      ],
      assert_line_patterns: [
        /^\s*assert\b/,
        /\bexpect\s*\(/,
        /\bassert\w*\s*\(/,
        /\bAssert\.\w+\s*\(/,
        /\.Should\(\)/,
        /\braise_for_status\s*\(/,
        /EnsureSuccessStatusCode/,
        /\.statusCode\s*\(/,
        /\.body\s*\(\s*"[^"]*"\s*,/,
        /\bpm\.(?:expect|response\.to)\b/,
        /^\s*(?:\*|Given|When|Then|And|But)\s+(?:status|match|assert)\b/,
        /\b(?:assert|require)\.\w+\s*\(/,
        /\bt\.(?:Errorf|Fatalf|Error|Fatal)\s*\(/,
      ],
      test_fn_pattern: API_TEST_PATTERNS,
      weaken_pairs: [
        [/^\s*assert\b[^\n]*==\s*/, /^\s*assert\b[^\n]*(?:\bin\b|!=|<|>|is not None)/],
        [/assertEquals/, /assertTrue\s*\([^)]*contains|assertNotNull/],
        [/isEqualTo/, /contains|isNotNull|isNotEmpty/],
        [
          /\.(?:toBe|toEqual|toStrictEqual|toHaveLength|toMatch|toContain|toBeLessThan\w*|toBeGreaterThan\w*)\s*\(/,
          /toBeDefined|toBeTruthy|not\.toBeNull|not\.toBeUndefined/,
        ],
        [/toEqual\s*\(/, /toMatchObject/],
        [/Assert\.(?:AreEqual|Equal)/, /Assert\.(?:True|IsTrue|NotNull|IsNotNull|Contains)/],
        [/Is\.EqualTo|\.Should\(\)\.Be\(/, /Is\.Not\.Null|NotBeNull|Contains/],
        [/\bassert\.Equal/, /assert\.(?:NotNil|Contains|NotEmpty)/],
        [/\.to\.(?:eql|equal|have\.status)\s*\(/, /\.to\.(?:be\.)?(?:below|above|ok|exist)\b/],
      ],
    },
    /* Appium is a protocol, used from whatever language the team already writes tests in — the profile
       spans the same stacks qa-api does, minus Go/Postman/Karate (not common Appium clients) plus the
       three mobile-specific checks above. Existing per-language sleep/skip/weak-assert patterns already
       fire on Appium code written in Java/Python/TS/C#, so they are not repeated here. */
    "qa-mobile": {
      language: "mobile",
      code_ext: [".py", ".java", ".kt", ".ts", ".tsx", ".js", ".mjs", ".cs"],
      test_runner: "auto",
      test_runner_patterns: ["pytest", "npm test", "npm run test", "jest", "vitest", "mvn test", "mvn verify", "gradle test", "gradlew", "dotnet test"],
      src_dirs: ["src", "app"],
      test_dirs: ["tests", "test", "__tests__", "e2e", "src/test"],
      checks: [...METHOD, ...PROCESS, ...CODE, "focused_test", "debug_leftover", ...SECRETS, "config_weakened", ...MOBILE],
      sleep_patterns: [
        delayCall(String.raw`\btime\.sleep`, String.raw`[\d.]`),
        delayCall(String.raw`\bThread\.sleep`),
        /\bTimeUnit\.\w+\.sleep\s*\(/,
        delayCall(String.raw`\bTask\.Delay`),
        delayCall(String.raw`\bbrowser\.pause`),
      ],
      focus_patterns: FOCUS_JS,
      debug_patterns: { debug: /\bbrowser\.debug\s*\(/, debugger: DEBUGGER_JS, breakpoint: BREAKPOINT_PY },
      skip_patterns: [/mark\.skip/, /@Disabled/, /@Ignore\b/, /\b(?:it|test|describe)\.skip\b/, /\[(?:[^\]\n]*,\s*)?Ignore\b/, /\bt\.Skip\w*\s*\(/],
      weak_assert_patterns: [
        /assert\s+True\b/g,
        /assertTrue\s*\(\s*true\s*\)/g,
        /Assert\.(?:True|IsTrue)\s*\(\s*true\s*\)/g,
        /expect\s*\(\s*true\s*\)\s*\.to\.be\.true\b/g,
      ],
      assert_line_patterns: [/^\s*assert\b/, /\bexpect\s*\(/, /\bassert\w*\s*\(/, /\bAssert\.\w+\s*\(/],
      test_fn_pattern: API_TEST_PATTERNS,
      weaken_pairs: [
        [/assertEquals/, /assertTrue\s*\([^)]*contains|assertNotNull/],
        [/Assert\.(?:AreEqual|Equal)/, /Assert\.(?:True|IsTrue|NotNull|IsNotNull|Contains)/],
      ],
    },
    "qa-cypress": {
      language: "cypress",
      code_ext: [".ts", ".tsx", ".js", ".mjs"],
      test_runner: "cypress",
      test_runner_patterns: ["cypress run", "cypress open", "npx cypress", "yarn cypress", "cypress:run", "npm test", "npm run test"],
      src_dirs: ["src", "app"],
      test_dirs: ["cypress", "cypress/e2e", "cypress/integration"],
      checks: [...METHOD, ...PROCESS, ...CODE, "focused_test", "debug_leftover", ...SECRETS, "config_weakened", "cypress_async_test"],
      sleep_patterns: [delayCall(String.raw`\bcy\.wait`, String.raw`\d{3,}`)],
      focus_patterns: FOCUS_JS,
      debug_patterns: { pause: /\bcy\.pause\s*\(/, debug: /\bcy\.debug\s*\(|\)\s*\.debug\s*\(\s*\)/, debugger: DEBUGGER_JS },
      skip_patterns: [/\b(?:it|describe|context)\.skip\b/],
      weak_assert_patterns: [/\.should\s*\(\s*['"`]exist['"`]\s*\)/g, /expect\s*\(\s*true\s*\)\s*\.to\.be\.true\b/g, /assert\.isTrue\s*\(\s*true\s*\)/g],
      assert_line_patterns: [/\.should\s*\(/, /\bexpect\s*\(/, /\bcy\.wrap\s*\([^)]*\)\.should\b/],
      test_fn_pattern: /\b(?:it|test)\s*\(\s*['"`]([^'"`]+)['"`]/g,
      weaken_pairs: [[/\.should\s*\(\s*['"`](?:have\.text|contain\.text|have\.value|eq)['"`]/, /\.should\s*\(\s*['"`]exist['"`]\)/]],
    },
    /* Mirrors qa-cypress structurally: single-language (JS/TS + Jest), same generic METHOD/PROCESS/CODE
       vocabulary, with the Detox-specific concepts (hardcoded wait, missing withTimeout, index matcher,
       missing post-action assertion, missing app reset) arriving only via the ESLint-based engine in
       lint.js — there is no regex fallback for those, same as raw_locator/positional_locator elsewhere. */
    "qa-detox": {
      language: "detox",
      code_ext: [".ts", ".tsx", ".js", ".mjs"],
      test_runner: "detox",
      test_runner_patterns: ["detox test", "npx detox test", "detox build", "e2e:test"],
      src_dirs: ["src", "app"],
      test_dirs: ["e2e", "e2e/tests"],
      checks: [...METHOD, ...PROCESS, ...CODE, "focused_test", "debug_leftover", ...SECRETS, "config_weakened"],
      sleep_patterns: [SET_TIMEOUT, /new Promise\s*\(\s*resolve\s*=>\s*setTimeout/],
      focus_patterns: FOCUS_JS,
      debug_patterns: { debugger: DEBUGGER_JS },
      skip_patterns: [/\b(?:it|describe|test)\.skip\b/],
      weak_assert_patterns: [/expect\s*\(\s*true\s*\)\s*\.toBe\s*\(\s*true\s*\)/g],
      assert_line_patterns: [/\bexpect\s*\(/],
      test_fn_pattern: /\b(?:it|test)\s*\(\s*['"`]([^'"`]+)['"`]/g,
      weaken_pairs: [[/\.(?:toHaveText|toHaveValue|toHaveId)\s*\(/, /\.(?:toBeVisible|toExist)\s*\(\)/]],
    },
    /* Robot Framework's own profile — its tabular, keyword-driven syntax never appears inside another
       language's codebase the way Gherkin's .feature files can, so (unlike Gherkin) this is a normal,
       profile-specific case rather than a profile-agnostic one. All four checks arrive only via the
       hand-written parser in media/lint-robot.js (see that file for why no tree-sitter grammar is used) —
       there is no regex fallback here, same reasoning as qa-detox's ESLint-only checks above. */
    "qa-robot": {
      language: "robot",
      code_ext: [".robot", ".resource"],
      test_runner: "robot",
      test_runner_patterns: ["robot ", "robot.exe", "python -m robot", "rebot"],
      src_dirs: ["resources", "keywords"],
      test_dirs: ["tests"],
      checks: [...METHOD, ...PROCESS],
      sleep_patterns: [],
      skip_patterns: [],
      weak_assert_patterns: [],
      assert_line_patterns: [],
      test_fn_pattern: null,
      weaken_pairs: [],
    },
    "qa-generic": {
      language: "any",
      code_ext: [],
      test_runner: "auto",
      test_runner_patterns: [
        "pytest",
        "npm test",
        "npm run test",
        "jest",
        "vitest",
        "mvn test",
        "gradle test",
        "go test",
        "dotnet test",
        "cargo test",
        "make test",
      ],
      src_dirs: [],
      test_dirs: [],
      checks: [...PROCESS, "tests_never_run"],
      sleep_patterns: [],
      skip_patterns: [],
      weak_assert_patterns: [],
    },
    "qa-go": {
      language: "go",
      code_ext: [".go"],
      test_runner: "gotest",
      test_runner_patterns: ["go test"],
      src_dirs: ["internal", "pkg", "cmd"],
      test_dirs: [],
      checks: [...METHOD, ...PROCESS, ...CODE],
      sleep_patterns: [/\btime\.Sleep\s*\(/],
      skip_patterns: [/\bt\.Skip\w*\s*\(/],
      weak_assert_patterns: [/(?:assert|require)\.NotNil\s*\([^)]*\)\s*$/gm],
      assert_line_patterns: [/\b(?:assert|require)\.\w+\s*\(/, /\bt\.(?:Errorf|Fatalf|Error|Fatal)\s*\(/],
      test_fn_pattern: /func\s+(Test\w+)\s*\(/g,
      weaken_pairs: [
        [/assert\.Equal/, /assert\.(?:NotNil|Contains|NotEmpty)/],
        [/require\.Equal/, /require\.(?:NotNil|Contains|NotEmpty)/],
      ],
    },
  };
  const VISIBLE = ["qa-ts", "qa-cypress", "qa-detox", "qa-python", "qa-java", "qa-c#", "qa-api", "qa-mobile", "qa-robot", "qa-generic"];
  const ALIAS = { "dev-generic": "qa-generic" };
  function profile(name) {
    name = ALIAS[name] || name;
    return Object.assign({ profile: name }, KW, PROFILES[name] || PROFILES["qa-python"]);
  }

  // ---------- test output parsers ----------
  const runners = {
    pytest(out) {
      if (!/\d+ (passed|failed|error)/.test(out)) return null;
      const r = { passed: 0, failed: 0, errors: 0, failed_names: [] };
      for (const m of out.matchAll(/(\d+) (passed|failed|error)/g)) {
        const n = +m[1];
        if (m[2] === "passed") r.passed = n;
        else if (m[2] === "failed") r.failed = n;
        else r.errors = n;
      }
      r.failed_names = [...out.matchAll(/FAILED ([\w/.\-]+::[\w\[\]\-]+)/g)].map((m) => m[1]);
      return r;
    },
    junit(out) {
      let m = out.match(/Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+)/);
      if (m) {
        const [run, f, e] = [+m[1], +m[2], +m[3]];
        return { passed: run - f - e, failed: f, errors: e, failed_names: [...out.matchAll(/([\w.]+\(\w+\)) <<< FAILURE!/g)].map((x) => x[1]) };
      }
      m = out.match(/(\d+) tests completed, (\d+) failed/);
      if (m) return { passed: +m[1] - +m[2], failed: +m[2], errors: 0, failed_names: [] };
      if (/BUILD SUCCESS/.test(out)) return { passed: 1, failed: 0, errors: 0, failed_names: [] };
      return null;
    },
    jest(out) {
      // a --list run enumerates tests without running them: never a result
      if (/^\s*Total:\s*\d+\s+tests?\s*$/m.test(out) && !/\d+\s+(passed|failed)/.test(out)) return null;
      let m = out.match(/Tests:\s*(?:(\d+) failed,\s*)?(?:(\d+) skipped,\s*)?(?:(\d+) passed,\s*)?(\d+) total/);
      if (m) return { passed: +(m[3] || 0), failed: +(m[1] || 0), errors: 0, failed_names: [...out.matchAll(/[✕×]\s+([^\n(]+)/g)].map((x) => x[1].trim()) };
      // playwright list reporter: "  15 passed (1.2m)", "  2 failed", "  1 skipped", possibly split across lines
      const p = out.match(/(\d+)\s+passed/),
        f = out.match(/(\d+)\s+failed/),
        fl = out.match(/(\d+)\s+flaky/);
      if (p || f)
        return {
          passed: p ? +p[1] : 0,
          failed: (f ? +f[1] : 0) + (fl ? +fl[1] : 0),
          errors: 0,
          failed_names: [...out.matchAll(/^\s*(?:\d+\)|[✘✕×])\s*\[[^\]]*\]\s*›\s*([^\n]+)/gm)].map((x) => x[1].trim()).slice(0, 20),
        };
      return null;
    },
    gotest(out) {
      const fails = [...out.matchAll(/--- FAIL: (Test\w+)/g)].map((m) => m[1]),
        passes = [...out.matchAll(/--- PASS: (Test\w+)/g)];
      if (!fails.length && !passes.length) {
        if (/^ok\s/m.test(out)) return { passed: 1, failed: 0, errors: 0, failed_names: [] };
        if (/^FAIL\s/m.test(out)) return { passed: 0, failed: 1, errors: 0, failed_names: [] };
        return null;
      }
      return { passed: passes.length, failed: fails.length, errors: 0, failed_names: fails };
    },
    dotnet(out) {
      // "Passed!  - Failed:     0, Passed:     5, Skipped:     0, Total:     5"
      let m = out.match(/(?:Passed|Failed)!\s*-\s*Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+),\s*Total:\s*(\d+)/);
      if (m)
        return {
          passed: +m[2],
          failed: +m[1],
          errors: 0,
          failed_names: [...out.matchAll(/^\s*Failed\s+([\w.<>,()"' -]+?)\s+\[/gm)].map((x) => x[1].trim()).slice(0, 20),
        };
      // older SDK: "Total tests: 5" / "     Passed: 3" / "     Failed: 2"
      const t = out.match(/Total tests:\s*(\d+)/);
      if (t) {
        const p = out.match(/^\s*Passed:\s*(\d+)/m),
          f = out.match(/^\s*Failed:\s*(\d+)/m);
        return { passed: p ? +p[1] : 0, failed: f ? +f[1] : 0, errors: 0, failed_names: [...out.matchAll(/^\s*Failed\s+([\w.]+)/gm)].map((x) => x[1]) };
      }
      return null;
    },
    newman(out) {
      // Postman CLI summary table: "│  assertions │   6 │   1 │" = executed │ failed
      const m = out.match(/assertions\s*[│|]\s*(\d+)\s*[│|]\s*(\d+)/);
      if (!m) return null;
      return {
        passed: Math.max(+m[1] - +m[2], 0),
        failed: +m[2],
        errors: 0,
        failed_names: [...out.matchAll(/^\s*\d+\.\s+(?:AssertionError|Error)\s+(.+?)\s*$/gm)].map((x) => x[1]).slice(0, 20),
      };
    },
    karate(out) {
      // "scenarios:  3 | passed:  2 | failed:  1 | time: 1.23"
      const m = out.match(/scenarios:\s*(\d+)\s*\|\s*passed:\s*(\d+)\s*\|\s*failed:\s*(\d+)/);
      if (!m) return null;
      return {
        passed: +m[2],
        failed: +m[3],
        errors: 0,
        failed_names: [...out.matchAll(/^\s*(?:scenario|feature):?\s+(.+?)\s+FAILED/gim)].map((x) => x[1]).slice(0, 20),
      };
    },
    auto(out) {
      for (const k of ["pytest", "jest", "junit", "gotest", "dotnet", "newman", "karate"]) {
        const r = runners[k](out);
        if (r) return r;
      }
      return null;
    },
  };
  function parseTests(out, cfg) {
    if (!out) return null;
    if (/did not complete within its \d+s timeout and was moved to the background/i.test(out)) return null;
    return (runners[cfg.test_runner] || runners.auto)(out);
  }

  // ---------- assert comparison (regex, per profile) ----------
  function blocksByTest(src, pat) {
    if (!pat) return { "<file>": src };
    const out = {};
    const ms = (Array.isArray(pat) ? pat.flatMap((p) => [...src.matchAll(p)]) : [...src.matchAll(pat)]).sort((a, b) => a.index - b.index);
    ms.forEach((m, i) => {
      const end = i + 1 < ms.length ? ms[i + 1].index : src.length;
      out[m[1]] = src.slice(m.index, end);
    });
    return out;
  }
  /* The code of a text with its comments blanked out, line for line, for the checks that look for a pattern anywhere in
     a file: a commented-out sleep, skip, .only, debugger or mock never runs (until 0.1.121 each still gave a finding).
     The file's extension says which comments its language has: # in Python, Robot, Gherkin, YAML, shell (where // is
     floor division, not a comment); // and /* … *\/ in the C-like ones; both for code
     with no file (in a message). # counts at the start of a line or after a space. Inside a string none of them is one
     ("#total", "https://…"); a ' or " string ends with its line, so a quote in plain text or a regex literal cannot hide
     the rest of the file.
     In Python a """ or ''' string spans lines. One that is a statement of its own never runs: a docstring, or a string
     used as a block comment. Its text is blanked like a comment (until 0.1.122 "assert ok" or "time.sleep(2)" in a
     docstring gave findings). It is one when it starts a line outside brackets and the line before does not go on
     with "\\"; an f-string is not, since its {…} runs. Any other """ string (an assigned SQL query) stays code. */
  const HASH_COMMENTS = /\.(?:py|pyi|robot|resource|feature|ya?ml|sh|rb|toml|ini|cfg|r)$/i;
  function withoutComments(text, file) {
    const hash = !file || HASH_COMMENTS.test(file),
      slash = !file || !HASH_COMMENTS.test(file),
      py = !!file && /\.pyi?$/i.test(file);
    let out = "",
      q = "", // the open string's quote, or "/*" in a block comment, or "//" in a line comment
      prev = "\n",
      depth = 0; // open ( [ { in Python code: a """ inside them is an argument or a value, not a statement
    for (let i = 0; i < text.length; i++) {
      const c = text[i],
        n = text[i + 1];
      if (q.length === 3 || q.length === 4) {
        // a Python triple-quoted string: q is its quote, with a leading "-" when it is a statement of its own (blanked)
        const blank = q.length === 4,
          hide = (s) => (blank ? s.replace(/[^\n]/g, " ") : s);
        if (text.startsWith(q.slice(-3), i)) {
          out += hide(q.slice(-3));
          i += 2;
          q = "";
        } else if (c === "\\" && n !== undefined) {
          out += hide(c + n);
          i++;
        } else out += hide(c);
      } else if (q === "//") {
        if (c === "\n") q = "";
        out += c === "\n" ? c : " ";
      } else if (q === "/*") {
        if (c === "*" && n === "/") {
          q = "";
          out += "  ";
          i++;
        } else out += c === "\n" ? c : " ";
      } else if (q) {
        out += c;
        if (c === "\\" && n !== undefined && n !== "\n") out += text[++i];
        else if (c === q || (c === "\n" && q !== "`")) q = "";
      } else if (slash && c === "/" && n === "/") {
        q = "//";
        out += " ";
      } else if (slash && c === "/" && n === "*") {
        q = "/*";
        out += "  ";
        i++;
      } else if (hash && c === "#" && /\s/.test(prev)) {
        q = "//";
        out += " ";
      } else if (py && (text.startsWith('"""', i) || text.startsWith("'''", i))) {
        const line = out.slice(out.lastIndexOf("\n") + 1),
          prefix = /^\s*([rRuUbB]{0,2})$/.exec(line), // not f: an f-string's {…} runs
          own = depth === 0 && !!prefix && !/\\\s*$/.test(out.slice(0, out.length - line.length));
        if (own) out = out.slice(0, out.length - prefix[1].length) + " ".repeat(prefix[1].length);
        q = (own ? "-" : "") + text.slice(i, i + 3);
        out += own ? "   " : q;
        i += 2;
      } else {
        if (c === '"' || c === "'" || c === "`") q = c;
        else if (py && "([{".includes(c)) depth++;
        else if (py && ")]}".includes(c)) depth = Math.max(0, depth - 1);
        out += c;
      }
      prev = c;
    }
    return out;
  }
  // an event's new_content without comments, worked out once per event: several checks read it
  const NO_COMMENTS = new WeakMap();
  function codeOf(e) {
    if (!NO_COMMENTS.has(e)) NO_COMMENTS.set(e, withoutComments(e.new_content || "", e.file));
    return NO_COMMENTS.get(e);
  }
  /* The text with every line that is all comment left empty, for the checks that read a file line by line: a line
     inside a block comment is one even without a leading "*" (until 0.1.121 it was read as code). The lines stay where
     they are, and a line with code keeps its comment: magic_number takes one at the end of a line for the number's
     explanation. A Python docstring is left empty too (since 0.1.122, see withoutComments). */
  function commentLinesBlanked(text, file) {
    const code = withoutComments(text, file).split("\n");
    return text
      .split("\n")
      .map((ln, i) => (code[i].trim() || !ln.trim() ? ln : ""))
      .join("\n");
  }
  // an event's new_content with its comment lines left empty, worked out once per event
  const NO_COMMENT_LINES = new WeakMap();
  function linesOf(e) {
    if (!NO_COMMENT_LINES.has(e)) NO_COMMENT_LINES.set(e, commentLinesBlanked(e.new_content || "", e.file));
    return NO_COMMENT_LINES.get(e);
  }
  /* An assertion line of the profile that is not a comment line (//, #, /* or * inside a block). A commented-out
     assertion never runs: until 0.1.120 it still counted, so commenting one out was not "fewer assertions". */
  function isAssertLine(ln, cfg) {
    return !/^\s*(?:\/\/|#|\/\*|\*)/.test(ln) && cfg.assert_line_patterns.some((p) => p.test(ln));
  }
  /* An assertion and the weaker one that replaced it, short enough for a finding's message. A pair that does not fit
     loses the start the two lines share (back to a ".", "(" or space, shown as "…"), so the change itself shows: until
     0.1.122 each line was cut at 40 characters, and expect(page.getByRole("alert")).toHaveText("…") → ….toBeVisible()
     read as two equal halves. */
  const PAIR_MAX = 60;
  const capLine = (s) => (s.length > PAIR_MAX ? s.slice(0, PAIR_MAX - 1) + "…" : s);
  function changePair(a, b) {
    if (a.length <= PAIR_MAX && b.length <= PAIR_MAX) return `${a} → ${b}`;
    let same = 0;
    while (same < a.length && same < b.length && a[same] === b[same]) same++;
    let from = 0;
    for (let k = same - 1; k > 0; k--)
      if (".( ".includes(a[k])) {
        from = a[k] === "." ? k : k + 1;
        break;
      }
    const part = (s) => (from ? "…" : "") + capLine(s.slice(from));
    return `${part(a)} → ${part(b)}`;
  }
  // file: whose comments to read (the extension says which); none for code in a message
  function compareAsserts(oldSrc, newSrc, cfg, file) {
    if (!cfg.assert_line_patterns) return null;
    oldSrc = commentLinesBlanked(oldSrc, file);
    newSrc = commentLinesBlanked(newSrc, file);
    const isA = (ln) => isAssertLine(ln, cfg);
    const asserts = (t) =>
      t
        .split("\n")
        .map((l) => l.trim())
        .filter(isA);
    const om = blocksByTest(oldSrc, cfg.test_fn_pattern),
      nm = blocksByTest(newSrc, cfg.test_fn_pattern);
    const res = { old: 0, new: 0, weakened: [], removed: [] };
    for (const v of Object.values(om)) res.old += asserts(v).length;
    for (const v of Object.values(nm)) res.new += asserts(v).length;
    for (const [name, ob] of Object.entries(om)) {
      const nb = nm[name];
      if (nb == null) continue;
      const oa = asserts(ob),
        na = asserts(nb);
      if (na.length < oa.length) res.removed.push({ test: name, before: oa.length, after: na.length });
      for (let i = 0; i < Math.min(oa.length, na.length); i++) {
        for (const [strong, weak] of cfg.weaken_pairs || []) {
          if (strong.test(oa[i]) && !strong.test(na[i]) && weak.test(na[i])) {
            res.weakened.push({ test: name, reason: changePair(oa[i], na[i]) });
            break;
          }
          if (strong.test(oa[i]) && !strong.test(na[i]) && !/==|assertEquals|toBe|toEqual|isEqualTo|\.Equal/.test(na[i]) && cfg.language === "python") {
            res.weakened.push({ test: name, reason: `comparison → truthiness: ${capLine(na[i])}` });
            break;
          }
        }
      }
    }
    return res;
  }

  // ---------- import ----------
  /* A command that runs the profile's tests. A part of it (between &&, ||, ;, |) that only lists them runs nothing:
     Playwright's --list, Jest's --listTests, pytest's --collect-only / --co, dotnet test --list-tests, vitest list.
     Until 0.1.122 such a command was a run with no result, so "tests never run" stayed silent after it. */
  const LIST_ONLY = /(?:^|\s)(?:--list|--listTests|--list-tests|--collect-only|--co)(?=[\s=]|$)|\bvitest\s+list\b/;
  function isTestRun(cmd, cfg) {
    return cmd.split(/&&|\|\|?|;|\n/).some((part) => cfg.test_runner_patterns.some((p) => part.includes(p)) && !LIST_ONLY.test(part));
  }
  function classify(tool, input, cfg) {
    const f = input.file_path || input.path || "";
    if (["Read", "View"].includes(tool)) return ["read", f, ""];
    if (["Grep", "Glob", "LS", "Search"].includes(tool)) return ["search", input.path || input.pattern || "", ""];
    if (["Edit", "MultiEdit"].includes(tool)) return ["edit", f, ""];
    if (["Write", "Create"].includes(tool)) return ["write", f, ""];
    if (tool === "Delete") return ["delete", f, ""]; // Cursor's tool for removing a file (test_deleted)
    if (tool === "Bash") {
      const c = input.command || "";
      if (isTestRun(c, cfg)) return ["run_tests", "", c];
      if (/^\s*git /.test(c)) return ["git", "", c];
      return ["run_other", "", c];
    }
    return ["tool", f, ""];
  }
  const isCode = (f, cfg) => !!f && (!cfg.code_ext.length || cfg.code_ext.some((x) => f.endsWith(x)));
  // a test runner's config: playwright.config.ts, cypress.config.ts, wdio.conf.ts, .detoxrc.js, .mocharc.js…
  const RUNNER_CONFIG_RX = /(?:^|\/)(?:[^/]*\.(?:config|conf)\.[cm]?[jt]s|\.detoxrc[^/]*|\.mocharc[^/]*)$/i;
  /* runner configs that are not code: what pytest reads, Maven's pom.xml (surefire, failsafe), Gradle's build script
     and a .NET .runsettings. Their text is kept apart (config_content), away from the code checks */
  const TEXT_RUNNER_CONFIG_RX = /(?:^|\/)(?:pytest\.ini|tox\.ini|setup\.cfg|pyproject\.toml|pom\.xml|build\.gradle(?:\.kts)?|[^/]*\.runsettings)$/i;
  const isRunnerConfig = (f) => !!f && (RUNNER_CONFIG_RX.test(f) || TEXT_RUNNER_CONFIG_RX.test(f));
  // a test file: by its name, or in one of the profile's test folders (anywhere in the path)
  const isTestFile = (f, cfg) => isCode(f, cfg) && (TEST_FILE_RX.test(f) || (cfg.test_dirs || []).some((d) => ("/" + f).includes("/" + d + "/")));
  /* what a runner config or a test file was before this write or edit: config_weakened and test_deleted compare with
     it. Often the only earlier version there is: a first Edit of a file that existed before the session. */
  const keepBefore = (r, f, before, cfg) => {
    if (before != null && (isRunnerConfig(f) || isTestFile(f, cfg))) r.prev_content = before.slice(0, 200000);
  };

  function fromClaudeJsonl(text, cfg) {
    const files = {},
      out = [],
      pending = {};
    let seq = 0,
      cwd = "";
    const base = (f) => files[f] ?? null;
    const short = (f) => (cwd && f.startsWith(cwd + "/") ? f.slice(cwd.length + 1) : f);
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (!cwd && typeof rec.cwd === "string") cwd = rec.cwd.replace(/\/+$/, "");
      // newer Claude Code writes bookkeeping records (attachment, mode, cost-state…) that carry no conversation
      if (rec.type && !["user", "assistant"].includes(rec.type) && !rec.message) continue;
      const msg = rec.message && typeof rec.message === "object" ? rec.message : rec;
      const role = ["user", "assistant"].includes(rec.type) ? rec.type : msg.role;
      if (!["user", "assistant"].includes(role)) continue;
      const ts = rec.timestamp || "";
      const blocks = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: msg.content || "" }];
      for (const b of blocks) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "text" && (b.text || "").trim()) {
          const r = { seq: seq++, ts, kind: role === "assistant" ? "message" : "user", text: b.text };
          if (r.kind === "message") attachCodeFromText(r);
          out.push(r);
        } else if (b.type === "tool_use" && role === "assistant") {
          const inp = b.input || {};
          const [kind, f, cmd] = classify(b.name || "", inp, cfg);
          const r = { seq: seq++, ts, kind, tool: b.name, file: short(f), cmd };
          if (kind === "write") {
            const o = base(f);
            keepBefore(r, f, o, cfg);
            files[f] = inp.content || "";
            if (o != null && isCode(f, cfg)) {
              const d = compareAsserts(o, files[f], cfg, f);
              if (d) r.assert_delta = d;
            }
          } else if (kind === "edit") {
            const o = base(f);
            keepBefore(r, f, o, cfg);
            if (o == null)
              files[f] = inp.new_string || ""; // first sight of this file: only the fragment is known
            else {
              const n = inp.old_string ? o.replace(inp.old_string, inp.new_string || "") : o + "\n" + (inp.new_string || "");
              files[f] = n;
              if (isCode(f, cfg)) {
                const d = compareAsserts(o, n, cfg, f);
                if (d) r.assert_delta = d;
              }
            }
          }
          // checks and the linter need the file as it now stands, not the edited fragment: a fragment does not parse
          const whole = ["write", "edit"].includes(kind) ? files[f] : null;
          const nc = whole || inp.content || inp.new_string || "";
          if (nc) {
            r.new_content = nc.slice(0, 200000);
            r.fragment_only = kind === "edit" && base(f) === (inp.new_string || "");
          }
          out.push(r);
          pending[b.id || ""] = r;
        } else if (b.type === "tool_result" && role === "user") {
          const r = pending[b.tool_use_id || ""];
          if (!r) continue;
          delete pending[b.tool_use_id];
          // the result record carries the authoritative before/after for a write or an edit — better than replaying
          const tur = rec.toolUseResult;
          if (tur && typeof tur === "object" && !Array.isArray(tur) && ["write", "edit"].includes(r.kind)) {
            const before = typeof tur.originalFile === "string" ? tur.originalFile : null;
            // Write reports the whole new file in `content`; Edit reports only the replaced fragment in
            // `newString`, so the new file has to be reconstructed — a fragment is not parseable code.
            let after = typeof tur.content === "string" ? tur.content : null;
            if (after == null && before != null && typeof tur.oldString === "string" && typeof tur.newString === "string")
              after = tur.replaceAll ? before.split(tur.oldString).join(tur.newString) : before.replace(tur.oldString, tur.newString);
            const full = r.file ? (cwd && !r.file.startsWith("/") ? cwd + "/" + r.file : r.file) : "";
            if (after != null) {
              files[full] = after;
              keepBefore(r, r.file, before, cfg);
              if (before != null && isCode(r.file, cfg)) {
                const d = compareAsserts(before, after, cfg, r.file);
                if (d) r.assert_delta = d;
              }
              r.new_content = after.slice(0, 200000);
            }
          }
          const c = b.content;
          const t = typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (x && x.text) || "").join("\n") : JSON.stringify(c || "");
          r.text = t.slice(0, 3000);
          if (r.kind === "run_tests") {
            const tr = parseTests(t, cfg);
            if (tr) {
              r.tests = tr;
              r.exit_code = tr.failed || tr.errors ? 1 : 0;
            }
          }
          if (b.is_error) r.exit_code = r.exit_code ?? 1;
        }
      }
    }
    return out;
  }

  // ---------- Codex (rollout-*.jsonl from the Codex CLI or the Codex VS Code extension) ----------
  // Same one-line-JSON-per-event shape as Claude Code, but a different schema: every record has a
  // top-level "type" (session_meta, response_item, event_msg, turn_context, token_usage_record…) and
  // the actual content sits under "payload". Detected by isCodexJsonl() before falling back to Claude.
  function isCodexJsonl(text) {
    const nl = text.indexOf("\n");
    const first = (nl === -1 ? text : text.slice(0, nl)).trim();
    try {
      const r = JSON.parse(first);
      return !!r && ["session_meta", "response_item", "event_msg", "turn_context"].includes(r.type);
    } catch {
      return false;
    }
  }
  /* Applies a unified-diff hunk set to the file's last known content. If the file was never seen before
     in this session (edited on disk before Codex started, or first message ever about it), there is no
     "before" to patch against — the best that can be done is keep the context + added lines and drop the
     removed ones, which yields a readable but partial snapshot (flagged fragment_only, same idea as a
     first-seen Claude Code Edit whose original content is unknown). */
  function applyUnifiedDiff(before, diff) {
    const hunks = diff.split(/\n(?=@@ )/).filter((h) => h.trim());
    if (before == null) {
      const out = [];
      for (const h of hunks)
        for (const line of h.split("\n").slice(1)) {
          if (line.startsWith("\\")) continue;
          if (line[0] === "+" || line[0] === " ") out.push(line.slice(1));
        }
      return out.join("\n");
    }
    let out = before.split("\n"),
      offset = 0;
    for (const h of hunks) {
      const head = h.match(/^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/);
      if (!head) continue;
      const pos = parseInt(head[1], 10) - 1 + offset;
      const block = [],
        body = h.split("\n").slice(1);
      // a diff that ends with a line break (Codex's always does) leaves an empty last line: not a context line, which
      // starts with a space (until 0.1.121 it replaced the line after the hunk with an empty one)
      if (body.length && body[body.length - 1] === "") body.pop();
      let consumed = 0;
      for (const line of body) {
        if (line.startsWith("\\")) continue;
        if (line[0] === "-") consumed++;
        else if (line[0] === "+") block.push(line.slice(1));
        else {
          block.push(line.slice(1));
          consumed++;
        }
      }
      out.splice(pos, consumed, ...block);
      offset += block.length - consumed;
    }
    return out.join("\n");
  }
  function fromCodexJsonl(text, cfg) {
    const out = [],
      files = {},
      pending = {};
    let seq = 0,
      cwd = "";
    const short = (f) => (cwd && f.startsWith(cwd + "/") ? f.slice(cwd.length + 1) : f);
    // a set of changes already applied: a version that writes both records of one patch must not apply it twice
    const applied = new Set();
    const applyChanges = (changes, ts) => {
      const key = JSON.stringify(changes);
      if (applied.has(key)) return;
      applied.add(key);
      for (const [path, ch] of Object.entries(changes)) {
        if (!ch) continue;
        if (ch.type === "delete") {
          out.push({ seq: seq++, ts, kind: "delete", file: short(path) }); // test_deleted looks for a deleted test file
          delete files[path];
          continue;
        }
        const before = Object.prototype.hasOwnProperty.call(files, path) ? files[path] : null;
        let after = null;
        if (ch.type === "add" && typeof ch.content === "string") after = ch.content;
        else if (ch.type === "update" && typeof ch.unified_diff === "string") after = applyUnifiedDiff(before, ch.unified_diff);
        if (after == null) continue;
        /* "*** Move to:" in a patch: the update's move_path is the file's new name (until 0.1.122 it was skipped, so the
           file kept its old name and the next edit under the new one had no text to apply to). The step is an edit of the
           new name from the old text: a test moved with its file is not deleted. */
        const to = ch.type === "update" && typeof ch.move_path === "string" && ch.move_path ? ch.move_path : path;
        if (to !== path) delete files[path];
        const f = short(to),
          r = { seq: seq++, ts, kind: ch.type === "add" ? "write" : "edit", file: f, new_content: after.slice(0, 200000) };
        keepBefore(r, f, before, cfg);
        if (before == null) r.fragment_only = true;
        else if (isCode(f, cfg)) {
          const d = compareAsserts(before, after, cfg, f);
          if (d) r.assert_delta = d;
        }
        files[to] = after;
        out.push(r);
      }
    };
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const p = rec.payload;
      const ts = rec.timestamp || "";
      if (rec.type === "session_meta") {
        if (p && typeof p.cwd === "string") cwd = p.cwd.replace(/\/+$/, "");
        continue;
      }
      if (rec.type === "event_msg") {
        // The authoritative, structured record of a completed file change — full content for a new
        // file, a unified diff for an edit — regardless of which tool call produced it (a direct
        // apply_patch call, or one wrapped in a JS snippet, as the VS Code extension's harness does).
        // Codex 0.155+ writes it as an item_completed FileChange (same `changes`) instead of patch_apply_end.
        if (p && p.type === "patch_apply_end" && p.changes) applyChanges(p.changes, ts);
        else if (p && p.type === "item_completed" && p.item && p.item.type === "FileChange" && p.item.changes)
          if (p.item.status == null || p.item.status === "completed") applyChanges(p.item.changes, ts);
        continue;
      }
      if (rec.type !== "response_item" || !p) continue;
      if (p.type === "message") {
        const role = p.role;
        if (role !== "user" && role !== "assistant") continue; // "developer" = injected skill/system text, not conversation
        if (role === "user") {
          // Real typed input is tagged user.text; recommended-plugins banners and IDE/env context blocks
          // aren't — but an untagged message (no metadata at all) is kept rather than guessed away.
          const kinds = (p.internal_chat_message_metadata_passthrough || {}).content_item_kinds;
          if (Array.isArray(kinds) && kinds.length && !kinds.includes("user.text")) continue;
        }
        const t = (Array.isArray(p.content) ? p.content : [])
          .map((b) => (b && b.text) || "")
          .join("\n")
          .trim();
        if (t) {
          const r = { seq: seq++, ts, kind: role === "assistant" ? "message" : "user", text: t };
          if (r.kind === "message") attachCodeFromText(r);
          out.push(r);
        }
        continue;
      }
      if (p.type === "function_call" || p.type === "custom_tool_call") {
        const name = p.name || "";
        let cmd = null;
        if (name === "shell" && typeof p.arguments === "string") {
          try {
            const a = JSON.parse(p.arguments);
            cmd = Array.isArray(a.command) ? a.command.join(" ") : a.command || null;
          } catch {
            /* leave cmd null */
          }
        } else if (typeof p.input === "string") {
          // codex_vscode's REPL harness wraps the real shell command in a JS call: tools.exec_command({"cmd":"..."}),
          // and from Codex 0.159 tools.exec_command({cmd:"..."}) with an unquoted key (lost until 0.1.121). The value is
          // JSON-escaped text. A snippet that runs several commands gives them all, joined by "; ".
          const cmds = [...p.input.matchAll(/(?:"cmd"|(?<![\w$."'])cmd)\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => {
            try {
              return JSON.parse('"' + m[1] + '"');
            } catch {
              return m[1];
            }
          });
          if (cmds.length) cmd = cmds.join("; ");
        }
        const r =
          cmd == null
            ? { seq: seq++, ts, kind: "tool", tool: name }
            : { seq: seq++, ts, kind: isTestRun(cmd, cfg) ? "run_tests" : /^\s*git /.test(cmd) ? "git" : "run_other", cmd };
        // a command from the exec harness keeps the tool's name: transcriptMatch pairs it with a stored "tool exec" step
        if (cmd != null && p.type === "custom_tool_call") r.tool = name;
        out.push(r);
        if (p.call_id) pending[p.call_id] = r;
        continue;
      }
      if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
        const r = pending[p.call_id];
        if (!r) continue;
        delete pending[p.call_id];
        const o = p.output;
        const t = typeof o === "string" ? o : Array.isArray(o) ? o.map((x) => (x && x.text) || "").join("\n") : JSON.stringify(o || "");
        r.text = t.slice(0, 3000);
        if (r.kind === "run_tests") {
          const tr = parseTests(t, cfg);
          if (tr) {
            r.tests = tr;
            r.exit_code = tr.failed || tr.errors ? 1 : 0;
          }
        }
        continue;
      }
    }
    return out;
  }

  // ---------- Cursor Agent (agent-transcripts/<id>/<id>.jsonl, from the Cursor IDE or its CLI) ----------
  /* Checked on the IDE and CLI 2026.10.01 (Oct 2026): a line has `role` ("user" | "assistant") at the top and
     `message.content`, or is {"type":"turn_ended"}. A tool_use has `name` and `input` only: no id and no result, so a
     command's output is not in the file (the CLI and the IDE keep it in their own databases). Claude Code puts `type`
     at the top and `role` inside `message`, so the same check leaves a Claude file on the Claude path. */
  function isCursorJsonl(text) {
    const nl = text.indexOf("\n");
    const first = (nl === -1 ? text : text.slice(0, nl)).trim();
    try {
      const r = JSON.parse(first);
      if (!r || typeof r !== "object") return false;
      if (r.type === "turn_ended") return true;
      return !r.type && ["user", "assistant"].includes(r.role) && !!r.message && Array.isArray(r.message.content);
    } catch {
      return false;
    }
  }
  // Cursor's tools under the names and input keys the Claude Code import reads; other tools stay as they are (kind "tool")
  const CURSOR_TOOLS = { Shell: "Bash", StrReplace: "Edit", Write: "Write", Read: "Read", Grep: "Grep", Glob: "Glob", Delete: "Delete" };
  function cursorInput(name, input) {
    const o = Object.assign({}, input);
    if (o.path != null && o.file_path == null) o.file_path = o.path;
    if (o.contents != null && o.content == null) o.content = o.contents;
    if (name === "Glob") {
      if (!o.path && o.target_directory) o.path = o.target_directory; // a Glob over src/ is a look at product code
      if (!o.pattern && o.glob_pattern) o.pattern = o.glob_pattern;
    }
    return o;
  }
  /* The user's text comes wrapped: <timestamp>Monday, Oct 5, 2026, 1:06 AM (UTC+5)</timestamp> <user_query>…</user_query>.
     The query is the text (user_frustration reads only short texts); the timestamp, the only time in the file, is the
     event's ts as an ISO string, so the session's start is not the import time. Read by hand: Date.parse takes
     "(UTC+5)" for a comment and reads the rest in the reviewer's time zone. Without an offset there is no ts. */
  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  function cursorTime(s) {
    const m =
      /\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?\s*\(UTC(?:([+-])(\d{1,2})(?::?(\d{2}))?)?\)/i.exec(s);
    const mon = m ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
    if (mon < 0) return "";
    let h = Number(m[4]) % 12;
    if (!m[7] || m[7].toUpperCase() === "PM") h = m[7] ? h + 12 : Number(m[4]);
    const offset = m[8] ? (m[8] === "-" ? -1 : 1) * (Number(m[9]) * 60 + Number(m[10] || 0)) : 0;
    const ms = Date.UTC(Number(m[3]), mon, Number(m[2]), h, Number(m[5]), Number(m[6] || 0)) - offset * 60000;
    return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
  }
  function cursorUserText(t) {
    const when = /<timestamp>([\s\S]*?)<\/timestamp>/.exec(t);
    const query = /<user_query>([\s\S]*?)<\/user_query>/.exec(t);
    return {
      text: (query ? query[1] : t.replace(/<timestamp>[\s\S]*?<\/timestamp>/g, "")).trim(),
      ts: when ? cursorTime(when[1]) : "",
    };
  }
  /* Rewrites the lines in the Claude Code shape and lets fromClaudeJsonl rebuild the files, then puts Cursor's own tool
     names back on the events. A StrReplace without a path has no file to apply it to: it stays a plain tool call.
     outputs (optional) are the commands Cursor's own database kept for this chat, in order ({command, output,
     exitCode}, read by the host, cursor-db.js): a Shell call takes the next one with the same command and gets it as
     its tool_result, so its test results are parsed as for Claude Code. A test run without one keeps output_missing:
     its result is unknown, not red and not absent (pass_claim_without_run, 0.1.121). */
  /* Cursor names a workspace's folder in ~/.cursor/projects after its path: every character that is not a Latin letter
     or a digit becomes "-", a run of them one "-", none at either end (/Users/me/my_app → Users-me-my-app; the same rule
     as cursorProjectSlug in cli.js). The transcript's paths are absolute, and the workspace is the folder above them
     whose name gives that folder's name: the import makes the paths relative to it (0.1.122; before, a session showed
     /Users/…/tests/cart.spec.ts and the reviewer's user name with it). A dropped or pasted file has no folder. */
  const cursorProjectSlug = (p) =>
    p
      .replace(/[^a-zA-Z0-9]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");
  function cursorRoot(paths, project) {
    for (const p of paths)
      for (let d = p.replace(/\/+$/, ""); d.startsWith("/"); d = d.slice(0, d.lastIndexOf("/"))) if (cursorProjectSlug(d) === project) return d;
    return "";
  }
  // project: the name of the transcript's folder in ~/.cursor/projects, when the file was picked there
  function fromCursorJsonl(text, cfg, outputs, project) {
    const lines = [],
      names = [],
      paths = [],
      done = new Set(),
      outs = Array.isArray(outputs) ? outputs.filter((o) => o && typeof o.command === "string" && typeof o.output === "string") : [];
    let next = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (!rec || !["user", "assistant"].includes(rec.role) || !rec.message) continue;
      let ts = "";
      const content = [],
        results = [];
      for (const b of Array.isArray(rec.message.content) ? rec.message.content : []) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "text" && rec.role === "user") {
          const u = cursorUserText(b.text || "");
          if (u.ts) ts = u.ts;
          if (u.text) content.push({ type: "text", text: u.text });
        } else if (b.type === "text") content.push({ type: "text", text: b.text || "" });
        else if (b.type === "tool_use" && rec.role === "assistant") {
          const name = String(b.name || ""),
            input = cursorInput(name, b.input || {});
          const as = name === "StrReplace" && !input.file_path ? name : CURSOR_TOOLS[name] || name;
          const id = "cursor-" + names.length;
          content.push({ type: "tool_use", id, name: as, input });
          names.push(name);
          if (typeof input.file_path === "string") paths.push(input.file_path);
          if (name !== "Shell" || typeof input.command !== "string") continue;
          const k = outs.findIndex((o, i) => i >= next && o.command.trim() === input.command.trim());
          if (k < 0) continue;
          next = k + 1;
          done.add(id);
          const o = outs[k];
          results.push({ type: "tool_result", tool_use_id: id, content: o.output, is_error: Number.isInteger(o.exitCode) && o.exitCode !== 0 });
        }
      }
      if (content.length) lines.push(JSON.stringify({ type: rec.role, timestamp: ts, message: { role: rec.role, content } }));
      if (results.length) lines.push(JSON.stringify({ type: "user", timestamp: "", message: { role: "user", content: results } }));
    }
    const root = typeof project === "string" && project ? cursorRoot(paths, project) : "";
    if (root) lines.unshift(JSON.stringify({ type: "system", cwd: root })); // fromClaudeJsonl takes the first cwd
    const out = fromClaudeJsonl(lines.join("\n"), cfg);
    let i = 0;
    for (const e of out) {
      if (!e.tool) continue;
      const id = "cursor-" + i;
      e.tool = names[i++];
      if (e.kind === "run_tests" && !done.has(id)) e.output_missing = true;
    }
    return out;
  }

  // ---------- Cursor Agent CLI log (agent -p --output-format stream-json) ----------
  /* Checked on the CLI 2026.10.01 (Oct 2026). Unlike the transcript, the log has every tool call with its result: lines
     {"type":"tool_call","subtype":"started"|"completed","call_id","tool_call":{"<kind>ToolCall":{args, result}}}, next
     to {"type":"system","subtype":"init","cwd"}, "user" and "assistant" lines in the Claude Code shape, "thinking" and
     "result". An edit's result has the whole file before (none for a new file) and after; a shell call's has exitCode,
     stdout and stderr; a read's has the content. Claude Code's own stream-json has no "tool_call" lines (its calls are
     tool_use blocks), so a tool_use block, or Claude's init with its `tools` list, keeps a file on the Claude path. */
  function isCursorStreamJson(text) {
    let n = 0;
    for (const line of text.slice(0, 200000).split("\n")) {
      if (!line.trim()) continue;
      if (++n > 400) break;
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }
      if (!r || typeof r !== "object") continue;
      if (r.type === "tool_call" && r.tool_call && typeof r.tool_call === "object") return true;
      if (r.type === "system" && r.subtype === "init" && Array.isArray(r.tools)) return false;
      const c = r.message && r.message.content;
      if (Array.isArray(c) && c.some((b) => b && b.type === "tool_use")) return false;
    }
    return false;
  }
  // the kinds read as Claude Code's tools; the event keeps the Cursor name (Write for an edit that made a new file)
  const CURSOR_STREAM_TOOLS = { readToolCall: "Read", grepToolCall: "Grep", globToolCall: "Glob", lsToolCall: "LS", deleteToolCall: "Delete" };
  // a call's args and result, as the Claude Code import reads them: [claude name, input, tool_result text | null, toolUseResult, is_error, cursor name]
  function cursorStreamCall(kind, args, result) {
    const ok = result && typeof result === "object" ? result.success : null;
    const path = typeof args.path === "string" ? args.path : "";
    const text = (v) => (typeof v === "string" ? v : v == null ? null : JSON.stringify(v));
    if (kind === "editToolCall") {
      const after = ok && typeof ok.afterFullFileContent === "string" ? ok.afterFullFileContent : null;
      if (after == null) return ["EditNotApplied", { file_path: path }, text(result), null, true, "Edit"]; // refused or failed: no change
      const before = typeof ok.beforeFullFileContent === "string" ? ok.beforeFullFileContent : null;
      return before == null
        ? ["Write", { file_path: path, content: after }, ok.message || "", { content: after }, false, "Write"]
        : ["Edit", { file_path: path }, ok.message || "", { originalFile: before, content: after }, false, "Edit"];
    }
    if (kind === "shellToolCall") {
      const r = result && typeof result === "object" ? result.success || result.failure : null;
      const out = r
        ? (typeof r.interleavedOutput === "string" && r.interleavedOutput) || [r.stdout, r.stderr].filter((x) => typeof x === "string" && x).join("\n")
        : "";
      const code = r && Number.isInteger(r.exitCode) ? r.exitCode : null;
      // a background command, or one with no result line, has no output: its result is unknown
      return ["Bash", { command: String(args.command || "") }, r && (out || code != null) ? out : null, null, code != null && code !== 0, "Shell"];
    }
    if (kind === "mcpToolCall") {
      const name = String(args.toolName || args.name || "mcp");
      return ["mcp:" + name, {}, text(ok && ok.content), null, false, name];
    }
    const as = CURSOR_STREAM_TOOLS[kind];
    if (!as) return [kind.replace(/ToolCall$/, ""), {}, text(ok), null, false, kind.replace(/ToolCall$/, "")];
    const input =
      kind === "globToolCall"
        ? { path: args.targetDirectory || "", pattern: args.globPattern || "" }
        : kind === "grepToolCall"
          ? { path, pattern: args.pattern || "" }
          : { file_path: path };
    return [as, input, kind === "readToolCall" ? text(ok && ok.content) : text(ok), null, !ok && !!result, as];
  }
  function fromCursorStreamJson(text, cfg) {
    /** @type {any[]} */
    const recs = []; // the lines to keep, and {call} where a tool call started
    const calls = {},
      names = [],
      missing = new Set();
    let pendingTs = []; // a user line has no time: it takes the next one
    const stamp = (rec) => {
      const ms = Number(rec.timestamp_ms);
      const ts = Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : "";
      if (ts) {
        for (const r of pendingTs) r.timestamp = ts;
        pendingTs = [];
      }
      return ts;
    };
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (!rec || typeof rec !== "object") continue;
      const ts = stamp(rec);
      if (rec.type === "system" && typeof rec.cwd === "string") recs.push({ type: "system", cwd: rec.cwd });
      else if ((rec.type === "user" || rec.type === "assistant") && rec.message && Array.isArray(rec.message.content)) {
        const content = rec.message.content.filter((b) => b && b.type === "text" && typeof b.text === "string");
        if (!content.length) continue;
        const r = { type: rec.type, timestamp: ts, message: { role: rec.type, content } };
        if (!ts) pendingTs.push(r);
        recs.push(r);
      } else if (rec.type === "tool_call" && rec.tool_call && typeof rec.tool_call === "object") {
        const kind = Object.keys(rec.tool_call).find((k) => /ToolCall$/.test(k));
        if (!kind) continue;
        const body = rec.tool_call[kind] || {};
        const id = String(rec.call_id || rec.tool_call.toolCallId || "call-" + recs.length);
        let c = calls[id];
        if (!c) {
          c = calls[id] = { kind, args: {}, result: null, ts };
          recs.push({ call: c }); // where the call started
        }
        if (body.args && typeof body.args === "object") c.args = body.args;
        if (rec.subtype === "completed" && body.result) c.result = body.result;
      }
    }
    const lines = [];
    for (const r of recs) {
      if (!r.call) {
        lines.push(JSON.stringify(r));
        continue;
      }
      const c = r.call;
      const [as, input, result, tur, isError, name] = cursorStreamCall(c.kind, c.args, c.result);
      const id = "cursor-" + names.length;
      names.push(name);
      lines.push(JSON.stringify({ type: "assistant", timestamp: c.ts, message: { role: "assistant", content: [{ type: "tool_use", id, name: as, input }] } }));
      if (result == null) {
        missing.add(id);
        continue;
      }
      const res = {
        type: "user",
        timestamp: c.ts,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: result, is_error: isError }] },
      };
      if (tur) res.toolUseResult = tur;
      lines.push(JSON.stringify(res));
    }
    const out = fromClaudeJsonl(lines.join("\n"), cfg);
    let i = 0;
    for (const e of out) {
      if (!e.tool) continue;
      const id = "cursor-" + i;
      e.tool = names[i++];
      if (e.kind === "run_tests" && missing.has(id)) e.output_missing = true;
    }
    return out;
  }

  const CODE_LINE =
    /^\s*(?:import\s|from\s+\S+\s+import|export\s|const\s|let\s|await\s|test\s*\(|test\.describe|test\.skip|it\s*\(|expect\s*\(|def\s+test|@Test|assert\w*\s*\(|assert\s|func\s+Test|\}\);?\s*$)/;
  const isCodeLine = (l) => CODE_LINE.test(l) || /^\s{2,}\S/.test(l) || /^\s*[\]\}\)]/.test(l) || /^\s*(?:\/\/|\/\*|\*|#)/.test(l) || l.trim() === "";
  const hasTests = (c) => /def test|@Test|\b(?:it|test)\s*\(|test\.skip|func Test|expect\s*\(|assert/.test(c);
  function attachCodeFromText(r) {
    let versions = [...r.text.matchAll(/```(?:\w+)?\n([\s\S]*?)```/g)].map((m) => m[1]);
    if (!versions.length) {
      // unfenced: contiguous runs of code-looking lines; a run of ≥2 non-code non-empty lines (prose) ends a version
      const ls = r.text.split("\n");
      const runs = [];
      let cur = [],
        prose = 0;
      for (const l of ls) {
        if (isCodeLine(l)) {
          // eslint-disable-next-line no-unused-vars -- kept as in 0.1.103 (a counter nothing reads any more); phase 7 changes no behaviour here
          if (l.trim() !== "") prose = 0;
          cur.push(l);
        } else {
          const real = cur.filter((x) => CODE_LINE.test(x)).length;
          if (real >= 3) {
            runs.push(cur.join("\n"));
            cur = [];
          } else if (real === 0) cur = [];
          else cur.push(l);
        }
      }
      if (cur.filter((x) => CODE_LINE.test(x)).length >= 3) runs.push(cur.join("\n"));
      // trim each run to start at its first real code line
      versions = runs.map((r) => {
        const ls = r.split("\n");
        const i = ls.findIndex((x) => CODE_LINE.test(x));
        return ls.slice(Math.max(0, i)).join("\n").replace(/\s+$/, "");
      });
    }
    versions = versions.filter(hasTests);
    if (!versions.length) return;
    r.new_content = versions[versions.length - 1];
    if (versions.length > 1) r.code_versions = versions;
  }
  const TOOL_LINE = /^[⏺●>\-\*\s]*(Read|Write|Edit|MultiEdit|Bash|Grep|Glob|Search)\s*\((.*)\)\s*$/;
  const USER_LINE = /^(?:>|User:|Пользователь:|Human:)\s*(.*)$/i;
  const ASSIST_LINE = /^(?:Assistant:|Claude:|Агент:)\s*(.*)$/i;
  function fromText(text, cfg) {
    const out = [];
    let seq = 0,
      role = "message",
      buf = [],
      last = null;
    const flush = () => {
      const t = buf.join("\n").trim();
      if (t) out.push({ seq: seq++, ts: "", kind: role, text: t });
      buf = [];
    };
    for (const line of text.split("\n")) {
      let m = line.match(TOOL_LINE);
      if (m) {
        flush();
        const tool = m[1],
          arg = m[2].trim().replace(/^['"]|['"]$/g, "");
        const inp = tool === "Bash" ? { command: arg } : { file_path: arg };
        const [kind, f, cmd] = classify(tool, inp, cfg);
        last = /** @type {any} */ ({ seq: seq++, ts: "", kind, tool, file: f, cmd });
        out.push(last);
        continue;
      }
      m = line.match(USER_LINE);
      if (m) {
        flush();
        role = "user";
        buf.push(m[1]);
        continue;
      }
      m = line.match(ASSIST_LINE);
      if (m) {
        flush();
        role = "message";
        buf.push(m[1]);
        continue;
      }
      if (last && last.kind === "run_tests" && /\d+ (passed|failed|total)|Tests run:|--- (?:FAIL|PASS)|^ok\s|^FAIL\s/.test(line)) {
        const tr = parseTests(line, cfg);
        if (tr) {
          last.tests = tr;
          last.exit_code = tr.failed || tr.errors ? 1 : 0;
          last.text = ((last.text || "") + "\n" + line).slice(-3000);
          continue;
        }
      }
      if (last && last.kind === "run_tests" && /^FAILED/.test(line)) {
        last.tests = last.tests || { passed: 0, failed: 0, errors: 0, failed_names: [] };
        last.tests.failed_names.push(...[...line.matchAll(/FAILED ([\w/.\-]+::[\w\[\]\-]+)/g)].map((x) => x[1]));
        continue;
      }
      buf.push(line);
    }
    flush();
    for (const r of out) if (r.kind === "message") attachCodeFromText(r);
    return out;
  }
  // claude.ai / Claude desktop data export: conversations.json = [ {name, chat_messages:[{sender, text, content:[...]}]} ]
  function fromClaudeAiExport(obj, cfg) {
    const convs = Array.isArray(obj) ? obj : [obj];
    return convs
      .filter((c) => c && Array.isArray(c.chat_messages))
      .map((c) => {
        const lines = c.chat_messages.map((m) => {
          const role = m.sender === "human" ? "user" : "assistant";
          const content = Array.isArray(m.content) && m.content.length ? m.content : [{ type: "text", text: m.text || "" }];
          return JSON.stringify({ type: role, timestamp: m.created_at || "", message: { role, content } });
        });
        return { name: c.name || c.uuid || "conversation", events: stripNonSource(diffMessageVersions(fromClaudeJsonl(lines.join("\n"), cfg), cfg), cfg) };
      })
      .filter((c) => c.events.length);
  }
  /* Chat sessions carry no file contents, but the agent often shows the same test twice ("fixed it, here is the new
     version"). Treat each message's code as a version: when two messages share test names, compare them. */
  function diffMessageVersions(events, cfg) {
    if (!cfg.test_fn_pattern) return events;
    let prev = null;
    for (const e of events) {
      if (e.kind !== "message" || !e.new_content) continue;
      const versions = e.code_versions || [e.new_content];
      for (const code of versions) {
        const names = Object.keys(blocksByTest(code, cfg.test_fn_pattern));
        if (prev && names.some((n) => prev.names.includes(n))) {
          const d = compareAsserts(prev.code, code, cfg);
          if (d) {
            d.identical = prev.code.trim() === code.trim();
            d.version = prev.v + 1;
            d.changed = !d.identical && (d.weakened.length || d.removed.length || d.old !== d.new);
            e.assert_delta = d;
            e.file = e.file || T("in_msgs", { v: d.version });
          }
          prev = { code, names: [...new Set([...prev.names, ...names])], v: prev.v + 1 };
        } else if (names.length) prev = { code, names, v: 1 };
      }
    }
    return events;
  }
  const NOT_SOURCE = /\.(?:json|jsonc|md|txt|ya?ml|lock|gitignore|env|toml|ini|cfg)$/i;
  /* A session writes docs, configs and lockfiles too. They are not code: linting or scanning them for weak
     assertions only produces noise, so their content is dropped after import.
     .feature is the one exception to "profile decides what's source": Gherkin checks are profile-agnostic
     (see gherkinChecks below) and must see the file regardless of which profile is active, so it is never
     stripped even when the active profile's code_ext doesn't list it (only qa-api does today). */
  function stripNonSource(events, cfg) {
    for (const e of events) {
      if (!e.new_content || !e.file) continue;
      if (/\.feature$/i.test(e.file)) continue;
      const ext = (cfg.code_ext || []).some((x) => e.file.endsWith(x));
      if (!ext && (NOT_SOURCE.test(e.file) || (cfg.code_ext || []).length)) {
        if (TEXT_RUNNER_CONFIG_RX.test(e.file)) e.config_content = e.new_content;
        else delete e.prev_content;
        delete e.new_content;
        delete e.code_versions;
      }
    }
    return events;
  }

  /* opts.cursorOutputs: the commands Cursor's database kept for a Cursor transcript (fromCursorJsonl); opts.cursorProject:
     the name of its folder in ~/.cursor/projects, for the workspace's path */
  function importAny(text, cfg, opts) {
    const t = text.trimStart();
    if (t.startsWith("[") || (t.startsWith("{") && /"chat_messages"/.test(t.slice(0, 5000)))) {
      try {
        const c = fromClaudeAiExport(JSON.parse(text), cfg);
        if (c.length) return c.length === 1 ? c[0].events : c;
      } catch {}
    }
    if (t.startsWith("{") && isCursorStreamJson(t)) return stripNonSource(diffMessageVersions(fromCursorStreamJson(text, cfg), cfg), cfg);
    if (t.startsWith("{") && isCursorJsonl(t))
      return stripNonSource(diffMessageVersions(fromCursorJsonl(text, cfg, opts && opts.cursorOutputs, opts && opts.cursorProject), cfg), cfg);
    if (t.startsWith("{") && isCodexJsonl(t)) return stripNonSource(diffMessageVersions(fromCodexJsonl(text, cfg), cfg), cfg);
    const ev = t.startsWith("{") ? fromClaudeJsonl(text, cfg) : fromText(text, cfg);
    return stripNonSource(diffMessageVersions(ev, cfg), cfg);
  }

  /* Which agent a transcript comes from and the folder it worked in (0.1.124, summary schema 4: the Sessions tree
     groups by the agent, the project is kept for later). The agent is the format importAny reads the text as, tried in
     the same order: claude-ai, cursor (a Cursor transcript or an Agent CLI log), codex, claude-code, text. The project
     is the first cwd of a Claude Code transcript or a Cursor Agent CLI log, the cwd of Codex's session_meta, and for a
     Cursor transcript, which names no folder, the name of its folder in ~/.cursor/projects (opts.cursorProject, as
     importAny takes it). "" when there is none: a claude.ai export, pasted text, a dropped Cursor transcript.
     A claude.ai export whose conversations give no steps is still claude-ai here; importAny then reads it as text. */
  const AGENTS = ["claude-code", "codex", "cursor", "claude-ai", "text"];
  const cleanProject = (p) => (typeof p === "string" && !/[\u0000-\u001f]/.test(p) ? p.replace(/(.)[\\/]+$/, "$1").slice(0, 500) : "");
  function firstCwd(text, pick) {
    for (const line of text.split("\n")) {
      if (!line.includes('"cwd"')) continue;
      try {
        const p = cleanProject(pick(JSON.parse(line)));
        if (p) return p;
      } catch {
        /* not a record */
      }
    }
    return "";
  }
  function transcriptOrigin(text, opts) {
    const t = typeof text === "string" ? text.trimStart() : "";
    if (!t) return { agent: "", project: "" };
    if (t.startsWith("[") || (t.startsWith("{") && /"chat_messages"/.test(t.slice(0, 5000)))) {
      try {
        const o = JSON.parse(t);
        if ((Array.isArray(o) ? o : [o]).some((c) => c && Array.isArray(c.chat_messages))) return { agent: "claude-ai", project: "" };
      } catch {
        /* not an export */
      }
    }
    if (!t.startsWith("{")) return { agent: "text", project: "" };
    if (isCursorStreamJson(t)) return { agent: "cursor", project: firstCwd(t, (r) => r && r.type === "system" && r.cwd) };
    if (isCursorJsonl(t)) return { agent: "cursor", project: cleanProject(opts && opts.cursorProject) };
    if (isCodexJsonl(t)) return { agent: "codex", project: firstCwd(t, (r) => r && r.type === "session_meta" && r.payload && r.payload.cwd) };
    return { agent: "claude-code", project: firstCwd(t, (r) => r && r.cwd) };
  }

  /* A JSONL file with tool calls of which the import read none: only the conversation text was found, so there is
     nothing to review (no files, edits or test runs). The panel asks before it keeps such a session (0.1.121): before,
     a Cursor CLI log became a silent session of messages. A claude.ai export is left out: its tool blocks are the
     chat's own tools, not an agent's work on files. */
  function unreadToolCalls(text, events) {
    const t = text.trimStart();
    if (!t.startsWith("{") || /"chat_messages"/.test(t.slice(0, 5000))) return false;
    if (!Array.isArray(events) || !events.length || events.some((e) => e.kind !== "user" && e.kind !== "message")) return false;
    return /"type"\s*:\s*"(?:tool_call|tool_use|function_call|tool-call)"|"tool_calls"\s*:\s*\[/.test(t.slice(0, 2000000));
  }

  /* What the import keeps changes now and then; a stored session keeps the events it was imported with. A session
     records the IMPORT_GEN it was imported with (importGen); none means an import before 0.1.114.
     2: prev_content and Codex delete events (0.1.113), which test_deleted and config_weakened read.
     3: Codex 0.155+ file changes (item_completed FileChange), and Codex edits without the line lost after a hunk
        (0.1.121).
     4: a command that only lists the tests is not a run, a file moved by a Codex patch is an edit of its new name, and
        a weakened assertion shows the change, not 40 characters of each line (0.1.122). */
  const IMPORT_GEN = 4;
  /* A Codex session imported before 0.1.121 with file changes in its transcript: from Codex 0.155 they were skipped,
     and an edit lost the line after its hunk. Without the kept text, a bare exec step tells the same: a patch in the
     code-mode harness, or a Codex 0.159 command that was lost the same way. */
  const codexChangesBefore121 = (s) =>
    (typeof s.source_text === "string" &&
      /"type"\s*:\s*"session_meta"/.test(s.source_text.slice(0, 5000)) &&
      /"(?:FileChange|unified_diff)"/.test(s.source_text)) ||
    s.events.some((e) => e.kind === "tool" && e.tool === "exec");
  /* A session imported before 0.1.122 that a new import reads differently: a step taken for a test run that only listed
     the tests, a Codex patch that moved a file (seen in the kept text), or a weakened assertion whose message cut a line
     at 40 characters (a line of exactly 40 is asked about too; importing it again changes nothing there). */
  function changedBy122(s) {
    const cfg = profile(s.profile);
    if (s.events.some((e) => e.kind === "run_tests" && typeof e.cmd === "string" && !isTestRun(e.cmd, cfg))) return true;
    if (typeof s.source_text === "string" && /"move_path"\s*:\s*"/.test(s.source_text)) return true;
    const cut = (w) =>
      String(w.reason || "")
        .replace(/^comparison → truthiness: /, "")
        .split(" → ")
        .some((half) => half.length === 40);
    return s.events.some((e) => e.assert_delta && Array.isArray(e.assert_delta.weakened) && e.assert_delta.weakened.some(cut));
  }
  /* A session imported before 0.1.113 may hide test_deleted and config_weakened findings that a new import shows: it
     wrote or edited a test file or a runner config and has none of what the 0.1.113 import keeps for them. A session
     imported with 0.1.113 that only wrote new files looks the same; importing it again changes nothing there. */
  function needsReimport(s) {
    if (!s || !Array.isArray(s.events) || s.importGen >= IMPORT_GEN) return false;
    if ((s.importGen || 0) < 3 && codexChangesBefore121(s)) return true;
    if (changedBy122(s)) return true;
    if ((s.importGen || 0) >= 2) return false;
    const cfg = profile(s.profile);
    if (!cfg.checks.includes("test_deleted") && !cfg.checks.includes("config_weakened")) return false;
    if (s.events.some((e) => e.prev_content != null || e.kind === "delete")) return false;
    return s.events.some((e) => (e.kind === "write" || e.kind === "edit") && (isRunnerConfig(e.file) || isTestFile(e.file, cfg)));
  }
  /* How much of a stored session's timeline a new import of a transcript repeats, in order: 1 for the same transcript
     (a newer import may add events, such as Codex deletions), near 0 for another one. */
  function transcriptMatch(stored, fresh) {
    const sig = (e) => [e.kind, e.file || "", e.cmd || "", String(e.text || "").slice(0, 60)].join("|");
    // a Codex 0.159 command stored before 0.1.121 as a bare "tool exec" step is the same step as its command now
    const same = (x, y) => sig(x) === sig(y) || (x.kind === "tool" && x.tool === "exec" && y.tool === "exec");
    const a = stored || [],
      b = fresh || [];
    if (!a.length) return b.length ? 0 : 1;
    let j = 0,
      n = 0;
    for (const x of a) {
      const k = b.findIndex((y, i) => i >= j && same(x, y));
      if (k >= 0) {
        n++;
        j = k + 1;
      }
    }
    return n / a.length;
  }
  /* The steps of the conversation in `parsed` (what importAny returned) that a stored session was made from: a file
     of several conversations (a claude.ai export) is kept whole as source_text by each session made from it. Picked
     by content: titles repeat, and segmentation leaves the compared fields alone. null when the file has no steps. */
  function pickConversation(stored, parsed) {
    const convs = Array.isArray(parsed) && parsed.length && parsed[0].events ? parsed.map((c) => c.events) : [parsed || []];
    let best = null,
      score = -1;
    for (const ev of convs) {
      const m = transcriptMatch(stored, ev);
      if (ev.length && m > score) [best, score] = [ev, m];
    }
    return best;
  }

  // ---------- timeline helpers ----------
  /* A plan is marked by a requirement table ("| Requirement") or by PLAN / ПЛАН as a word: since 0.1.119 "EXPLANATION"
     and "PLANNED" are not plans. */
  const planSeq = (ev, cfg) => {
    const marks = cfg.plan_markers.map((m) => (/^\p{L}+$/u.test(m) ? new RegExp("(?<!\\p{L})" + m + "(?!\\p{L})", "u") : m));
    const e = ev.find((x) => x.kind === "message" && marks.some((m) => (typeof m === "string" ? x.text.includes(m) : m.test(x.text))));
    return e ? e.seq : null;
  };
  const approvalSeq = (ev, p) => {
    if (p == null) return null;
    const e = ev.find((x) => x.seq > p && x.kind === "user");
    return e ? e.seq : null;
  };
  /* The files the plan names: a path with a folder and an extension, one of whose folders is a test or source folder
     (the usual ones and the profile's, so e2e/ and cypress/ too since 0.1.119). */
  const plannedFiles = (ev, p, cfg) => {
    if (p == null) return new Set();
    const dirs = new Set(["tests", "test", "specs", "spec", "src", "app", ...[...cfg.test_dirs, ...cfg.src_dirs].flatMap((d) => d.split("/"))]);
    const paths = (ev[p].text.match(/[\w.-]+(?:\/[\w.-]+)+\.\w+/g) || []).map((x) => x.replace(/^\.\//, ""));
    return new Set(
      paths.filter((x) =>
        x
          .split("/")
          .slice(0, -1)
          .some((d) => dirs.has(d)),
      ),
    );
  };
  // a file the plan names, also when one of the two paths has a prefix the other lacks (./, shop/, an absolute path)
  const inPlan = (f, planned) => {
    const g = f.replace(/^\.\//, "");
    return [...planned].some((x) => g === x || g.endsWith("/" + x) || x.endsWith("/" + g));
  };
  const inDirs = (path, dirs) => {
    const p = (path || "").replace(/^\.?\//, "");
    return dirs.some((d) => p === d || p.startsWith(d + "/"));
  };
  // a dir anywhere in the path: Claude Code started in a parent folder writes "shop/src/cart.ts", or an absolute path
  const underDir = (path, dirs) => {
    const p = "/" + (path || "").replace(/^\.?\//, "") + "/";
    return dirs.some((d) => p.includes("/" + d + "/"));
  };
  // product code: a source folder at the start of the path, or deeper in it if the file is not test-side code or a dependency
  const productPath = (f, cfg) =>
    inDirs(f, cfg.src_dirs) ||
    (underDir(f, cfg.src_dirs) &&
      !underDir(f, cfg.test_dirs) &&
      !TEST_FILE_RX.test(f || "") &&
      !TEST_SIDE_RX.test(f || "") &&
      !/(?:^|\/)node_modules\//.test(f || ""));
  /* A shell command that only reads (0.1.121): cat, sed -n, head, rg, ls, find… is how Codex reads a file, and Claude
     Code and Cursor often do too. Each part, split at an unquoted &&, ||, ;, | or line break, must start with such a
     command; sed -i, find -delete / -exec and an unquoted > write. The event stays a run_other step: its kind and step
     number keep verdicts and Import again's match, and a stored session gets it on the next analysis. Returns the
     paths the command names (unquoted words with a / or a dot, or one of the profile's source folders), or null. */
  const READ_CMD = /^(?:cat|head|tail|nl|less|more|bat|sed|rg|grep|egrep|ls|find|tree|wc|stat|file|pwd|cd|echo|sort|uniq|cut)$/;
  function shellReads(e, cfg) {
    if (e.kind !== "run_other" || !e.cmd) return null;
    const parts = [[]];
    let word = "",
      quoted = false,
      q = "";
    const end = () => {
      if (word || quoted) parts[parts.length - 1].push({ word, quoted });
      word = "";
      quoted = false;
    };
    const c = e.cmd;
    for (let i = 0; i < c.length; i++) {
      const ch = c[i];
      if (q) {
        if (ch === q) q = "";
        else word += ch;
      } else if (ch === "'" || ch === '"') {
        q = ch;
        quoted = true;
      } else if (ch === ">") return null;
      else if (/[;|&\n]/.test(ch)) {
        end();
        if (parts[parts.length - 1].length) parts.push([]);
      } else if (/\s/.test(ch)) end();
      else word += ch;
    }
    end();
    const files = [];
    for (const p of parts.filter((x) => x.length)) {
      const cmd = p[0].word,
        args = p.slice(1);
      if (p[0].quoted || !READ_CMD.test(cmd)) return null;
      if (cmd === "sed" && args.some((a) => !a.quoted && /^-[a-zA-Z]*i/.test(a.word))) return null;
      if (cmd === "find" && args.some((a) => /^-(?:delete|exec|execdir|ok|fprint)/.test(a.word))) return null;
      for (const a of args)
        if (
          !a.quoted &&
          !a.word.startsWith("-") &&
          !/[*?$]/.test(a.word) &&
          (/^[^\d].*[/.]|^\.\.?\//.test(a.word) || (cfg.src_dirs || []).includes(a.word.replace(/\/$/, "")))
        )
          files.push(a.word);
    }
    return files;
  }
  /* The last test run before seq, if it was red; null if it was green or there was none. A run whose output is not in
     the transcript (output_missing: a Cursor transcript without Cursor's database) makes the result unknown, not red,
     as in pass_claim_without_run; until 0.1.123 it was skipped, and a red run before it still made a finding high. A
     run whose output could not be parsed (a crash before the tests, an unknown runner) is skipped: the run before it
     decides. */
  const redRunBefore = (ev, seq) => {
    const runs = ev.filter((e) => e.kind === "run_tests" && (e.tests || e.output_missing) && e.seq < seq);
    const l = runs[runs.length - 1];
    return l && l.tests && (l.tests.failed || l.tests.errors) ? l : null;
  };
  // a test file by its name, in any language the profiles know
  const TEST_FILE_RX = /(?:^|\/)(?:test_[^/]*\.py|[^/]*_test\.(?:py|go)|[^/]*\.(?:spec|test|cy)\.[cm]?[jt]sx?|[^/]*Tests?\.(?:java|kt|cs))$/;
  // test-side code that is not a test: fixtures, helpers, page objects, mocks, support files (and conftest.py)
  const TEST_SIDE_RX =
    /(?:^|\/)(?:__tests__|__mocks__|tests?|e2e|specs?|fixtures?|support|mocks?|testing|test-?utils|page-?objects?|pages)\/|(?:^|\/)conftest\.py$/i;
  /* Product code: a code file under the profile's src_dirs that is not test-side code (a test, a fixture, a page object,
     a runner config). product_code_edited reports an edit of it; sleep_or_skip_added leaves it alone, since a delay or a
     retry there belongs to the product, not to a test (0.1.121). */
  const productFile = (f, cfg) =>
    !!f &&
    isCode(f, cfg) &&
    underDir(f, cfg.src_dirs) &&
    !underDir(f, cfg.test_dirs) &&
    !TEST_FILE_RX.test(f) &&
    !TEST_SIDE_RX.test(f) &&
    !RUNNER_CONFIG_RX.test(f);
  function phases(ev) {
    const first = (k) => {
      const e = ev.find((x) => k.includes(x.kind));
      return e ? e.seq : null;
    };
    const cuts = [
      ["plan", 0],
      ["code", first(["edit", "write"])],
      ["run", first(["run_tests"])],
    ].filter((c) => c[1] != null);
    return cuts
      .map((c, i) => ({ name: c[0], start: c[1], end: i + 1 < cuts.length ? cuts[i + 1][1] - 1 : ev.length ? ev[ev.length - 1].seq : 0 }))
      .filter((p) => p.end >= p.start);
  }
  /* A tracker key looks like ABC-123, but so do UTF-8, WCAG-2, SHA-256 and HTTP status talk. Those are excluded,
     and a key the person typed outweighs one the agent mentioned in passing. */
  const NOT_TASK = /^(?:UTF|ISO|RFC|SHA|MD|AES|RSA|HTTP|HTTPS|HTML|CSS|ES|WCAG|ARIA|ISBN|UTC|GMT|IPV|IEEE|ANSI|EN|ID|API|A11Y|I18N|L10N|X)$/i;
  const TASK_RE = /\b([A-Z][A-Z0-9]{1,9})-(\d{1,6})\b/g;
  function guessTask(text) {
    for (const m of String(text || "").matchAll(TASK_RE)) if (!NOT_TASK.test(m[1])) return `${m[1]}-${m[2]}`;
    return "";
  }
  function taskId(ev) {
    const fromUser = ev
      .filter((e) => e.kind === "user")
      .map((e) => guessTask(e.text))
      .find(Boolean);
    if (fromUser) return fromUser;
    for (const e of ev) {
      const t = guessTask((e.text || "") + " " + (e.file || "") + " " + (e.cmd || ""));
      if (t) return t;
    }
    return "";
  }

  // ---------- checks ----------
  /** @type {Array<[string, RegExp]>} */
  const SECRET_KINDS = [
    ["sk_jwt", /\beyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{6,}/g],
    ["sk_bearer", /Bearer\s+(?![{$<%]|["'`]\s*\+)([A-Za-z0-9\-._~+/]{20,}=*)/g],
    ["sk_aws", /\bAKIA[0-9A-Z]{16}\b/g],
    ["sk_key", /\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,})\b/g],
    [
      "sk_assign",
      /\b(?:api[_-]?key|apikey|client[_-]?secret|secret[_-]?key|access[_-]?token|auth[_-]?token|bearer[_-]?token|token|secret)\b["']?\s*[:=]\s*["']([^"'\s]{8,})["']/gi,
    ],
  ];

  /* Secrets are masked before real code is written into anything that may be shared (skill examples). Broader than
     the check that reports them: comments and env-looking lines are masked too, and so are literal passwords. */
  function redactSecrets(text) {
    const PH =
      /^(?:\[REDACTED\]|<.*>|\{\{.*\}\}|\$\{.*\}|%.*%|\*{3,}|x{4,}|\.{3}|your[-_ ]|my[-_ ]|example|dummy|fake|sample|placeholder|change[-_ ]?me|todo|null|none|undefined)/i;
    let count = 0,
      out = String(text || "");
    for (const [, rx] of SECRET_KINDS) {
      rx.lastIndex = 0;
      // without a capture group the 2nd callback argument is the match offset, not a string
      out = out.replace(rx, (...a) => {
        const m = a[0],
          g = typeof a[1] === "string" ? a[1] : "";
        const v = g || m;
        if (PH.test(v)) return m;
        count++;
        return g ? m.replace(g, "[REDACTED]") : "[REDACTED]";
      });
    }
    out = out.replace(/\b(password|passwd|pwd)\b(["']?\s*[:=]\s*["'])([^"'\s]{4,})(["'])/gi, (m, k, mid, v, q) => {
      if (PH.test(v)) return m;
      count++;
      return k + mid + "[REDACTED]" + q;
    });
    return { text: out, count };
  }
  const F = (check, severity, seq, message) => ({ check, severity, seq, message });
  // steps that change no code and say nothing: pass_claim_without_run does not count them in its window
  const QUIET_STEPS = new Set(["read", "search", "tool", "git", "run_other"]);
  const checks = {
    // since 0.1.119 also a src folder deeper in the path, but not test-side code or a dependency under it
    peeked_at_src_before_plan(ev, cfg) {
      const p = planSeq(ev, cfg),
        a = approvalSeq(ev, p);
      const cut = a ?? p ?? 1e9;
      const out = [];
      for (const e of ev) {
        if (e.seq >= cut) continue;
        // since 0.1.121 also a shell command that only reads (cat src/cart.ts, sed -n '1,80p' src/cart.ts)
        const file = ["read", "search"].includes(e.kind) ? e.file : (shellReads(e, cfg) || []).find((f) => productPath(f, cfg));
        if (file && productPath(file, cfg)) out.push(F("peeked_at_src_before_plan", "high", e.seq, T("peeked", { file })));
      }
      return out;
    },
    /* A claim phrase counts as whole words (0.1.119): "bypassing" is not "passing", "проходить" is not "проходит".
       An English phrase may end in -es, -ed or -ing ("tests passed", "all passes"). Since 0.1.121 a claim after a run
       whose output the transcript does not have (output_missing, a Cursor import) is not reported: its result is unknown.
       A run whose output is there but not understood (no tests) still counts as no run, as before.
       Since 0.1.121 the window of pass_claim_lookback steps skips the steps that change no code: reads, searches, other
       tools (a browser, MCP), git and other commands. A Cursor session with an MCP browser makes dozens of them between
       a run and the message about it. */
    pass_claim_without_run(ev, cfg) {
      const out = [],
        pats = cfg.pass_claim_patterns.map(
          (p) =>
            new RegExp(
              "(?<![\\p{L}\\p{N}_])" +
                p.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
                (/^[\x20-\x7e]+$/.test(p) ? "(?:es|ed|ing)?" : "") +
                "(?![\\p{L}\\p{N}_])",
              "u",
            ),
        );
      for (const e of ev) {
        if (e.kind !== "message") continue;
        const t = e.text.toLowerCase();
        if (!pats.some((rx) => rx.test(t))) continue;
        const near = ev
          .filter((x) => x.seq < e.seq && !QUIET_STEPS.has(x.kind))
          .slice(-cfg.pass_claim_lookback)
          .filter((x) => x.kind === "run_tests");
        // the last run's result is not in the transcript (a Cursor transcript keeps no output): unknown, not red, not absent
        if (near.length && near[near.length - 1].output_missing) continue;
        const runs = near.filter((x) => x.tests);
        if (!runs.length) out.push(F("pass_claim_without_run", "high", e.seq, T("pass_no_run")));
        else {
          const l = runs[runs.length - 1].tests;
          if (l.failed || l.errors) out.push(F("pass_claim_without_run", "high", e.seq, T("pass_red", { passed: l.passed, failed: l.failed })));
        }
      }
      return out;
    },
    assert_weakened(ev) {
      const out = [];
      for (const e of ev) {
        const d = e.assert_delta;
        if (!d) continue;
        for (const w of d.weakened) out.push(F("assert_weakened", "high", e.seq, T("weakened", { file: e.file, test: w.test, reason: w.reason })));
        for (const r of d.removed)
          out.push(F("assert_weakened", "high", e.seq, T("removed", { file: e.file, test: r.test, before: r.before, after: r.after })));
      }
      return out;
    },
    /* 0.1.119: a line that is a comment is skipped; Cypress's .should( is an assertion too (a file with only those was
       never looked at); a bare Python assert on a predicate (cart.is_empty(), user.is_active, path.exists()) checks a
       value, unlike `assert resp.json()`. */
    weak_assert(ev, cfg) {
      const out = [];
      const PREDICATE = /^assert\s[\w.]*\b(?:(?:is|has|can|should|was|were|does|did)_\w+(?:\(\))?|is[a-z]+\(\)|exists\(\))\s*$/;
      for (const e of ev) {
        // every profile's patterns run on every file: until 0.1.123 a file had to contain "assert", "expect" or
        // ".should(" first, so C#'s Assert.NotNull, Go's require.NotNil, REST Assured's statusCode(lessThan(…)) and
        // Karate's #notnull were never looked for
        const code = e.new_content && linesOf(e);
        if (!code) continue;
        for (const rx of cfg.weak_assert_patterns) {
          rx.lastIndex = 0;
          for (const m of code.matchAll(rx)) {
            if (/^\s*(?:\/\/|#|\/\*|\*)/.test(code.slice(code.lastIndexOf("\n", m.index) + 1, m.index)) || PREDICATE.test(m[0].trim())) continue;
            out.push(F("weak_assert", "high", e.seq, T("weak_assert", { file: e.file || inMsg(), line: m[0].trim().slice(0, 80) })));
          }
        }
      }
      return out;
    },
    fix_after_fail_without_triage(ev, cfg) {
      const out = [],
        mk = cfg.triage_markers.map((m) => m.toLowerCase());
      for (const e of ev) {
        if (e.kind !== "run_tests" || !e.tests || !(e.tests.failed || e.tests.errors)) continue;
        // pytest: path::test ; playwright: path:line:col › title — keep the path either way
        const ff = new Set(
          e.tests.failed_names
            .map((n) =>
              String(n)
                .split("::")[0]
                .replace(/:\d+:\d+.*$/, "")
                .trim(),
            )
            .filter(Boolean),
        );
        for (const x of ev) {
          if (x.seq <= e.seq) continue;
          if (x.kind === "message" && mk.some((m) => x.text.toLowerCase().includes(m))) break;
          if (x.kind === "user") break;
          const isCodeFile = x.file && (!cfg.code_ext.length || cfg.code_ext.some((ext) => x.file.endsWith(ext)));
          if (["edit", "write"].includes(x.kind) && (!ff.size || [...ff].some((p) => x.file.endsWith(p)) || inDirs(x.file, cfg.test_dirs) || isCodeFile)) {
            out.push(F("fix_after_fail_without_triage", "high", x.seq, T("fix_no_triage", { file: x.file, seq: e.seq })));
            break;
          }
        }
      }
      return out;
    },
    scope_creep(ev, cfg) {
      const pl = plannedFiles(ev, planSeq(ev, cfg), cfg);
      if (!pl.size) return [];
      return ev
        .filter((e) => ["edit", "write"].includes(e.kind) && e.file && !inPlan(e.file, pl) && !e.file.endsWith("README.md"))
        .map((e) => F("scope_creep", "medium", e.seq, T("scope", { file: e.file })));
    },
    edit_churn(ev, cfg) {
      const c = {};
      for (const e of ev) if (["edit", "write"].includes(e.kind) && e.file) (c[e.file] = c[e.file] || []).push(e.seq);
      return Object.entries(c)
        .filter(([, s]) => s.length > cfg.edit_churn_threshold)
        .map(([f, s]) => F("edit_churn", "medium", s[cfg.edit_churn_threshold], T("churn", { file: f, n: s.length })));
    },
    sleep_or_skip_added(ev, cfg) {
      const out = [];
      for (const e of ev) {
        // retries in a runner config: config_weakened; a delay or a retry in product code is the product's own
        if (!e.new_content || isRunnerConfig(e.file) || productFile(e.file, cfg)) continue;
        // kind (every SUPERSEDES check has one): what LensLint.merge() compares with what the profile's engine looks for
        const code = codeOf(e);
        if (cfg.sleep_patterns.some((r) => r.test(code)))
          out.push(Object.assign(F("sleep_or_skip_added", "high", e.seq, T("sleep", { file: e.file || inMsg() })), { kind: "sleep" }));
        const skips = cfg.skip_patterns.filter((r) => r.test(code));
        if (skips.length)
          out.push(
            Object.assign(F("sleep_or_skip_added", "high", e.seq, T("skip", { file: e.file || inMsg() })), {
              kind: skips.some((r) => RETRY_RX.test(r.source)) ? "retry" : "skip",
            }),
          );
      }
      return out;
    },
    /* A test that disappears: from a file between two of its versions in the session, or with the whole file (rm,
       git rm, a deleted file in a Codex patch). Not a deletion: a test renamed with the same body, a test that shows up
       in another file (moved) or again in the same file later (restored). High right after a red run: that is how an
       agent turns a suite green. Versions are what the session saw (new_content), so a stored session works too. */
    test_deleted(ev, cfg) {
      if (!cfg.test_fn_pattern) return [];
      const tests = (src) => blocksByTest(src, cfg.test_fn_pattern);
      const norm = (b) =>
        b
          .split("\n")
          .slice(1)
          .map((l) => l.trim())
          .filter((l) => l && !/^[})\];,]*$/.test(l))
          .join("\n");
      const versions = ev.filter((e) => ["write", "edit"].includes(e.kind) && e.file && e.new_content && isCode(e.file, cfg));
      const seen = versions.flatMap((e) => Object.keys(tests(e.new_content)).map((name) => ({ file: e.file, seq: e.seq, name })));
      // kept: the same test elsewhere at any time (moved) or in the same file after the deletion (restored)
      const kept = (file, seq, name) => seen.some((t) => t.name === name && (t.file !== file || t.seq > seq));
      const out = [];
      const push = (key, file, seq, names) => {
        const r = redRunBefore(ev, seq);
        const vars = { file, n: names.length, names: names.join(", "), after: r ? T("after_red_run", { seq: r.seq }) : "" };
        out.push(F("test_deleted", r ? "high" : "medium", seq, T(key, vars)));
      };
      // ---- a test removed from a file ----
      const last = {};
      for (const e of versions) {
        const prev = last[e.file];
        last[e.file] = e;
        // the import's prev_content (a first Edit made whole from toolUseResult), else the session's previous version
        const before = e.prev_content ?? (prev && !prev.fragment_only && !e.fragment_only ? prev.new_content : null);
        if (before == null) continue;
        const om = tests(before),
          nm = tests(e.new_content);
        const added = Object.keys(nm)
          .filter((k) => !(k in om))
          .map((k) => norm(nm[k]));
        const gone = Object.keys(om).filter((k) => !(k in nm) && !(norm(om[k]) && added.includes(norm(om[k]))) && !kept(e.file, e.seq, k));
        if (gone.length) push("test_deleted_msg", e.file, e.seq, gone);
      }
      // ---- a test file deleted ----
      const same = (a, b) => a === b || a.endsWith("/" + b) || b.endsWith("/" + a);
      const testFile = (f) => isCode(f, cfg) && (TEST_FILE_RX.test(f) || inDirs(f, cfg.test_dirs));
      for (const e of ev) {
        let targets = [];
        if (e.kind === "delete" && e.file) targets = [e.file];
        else if (e.cmd)
          for (const part of e.cmd.split(/&&|\|\||;|\n/)) {
            const m = part.match(/^\s*(?:sudo\s+)?(?:git\s+rm|rm|unlink|del|Remove-Item)\s+(.*)$/);
            if (m)
              targets.push(
                ...m[1]
                  .split(/\s+/)
                  .filter((t) => t && !t.startsWith("-"))
                  .map((t) => t.replace(/^["']|["']$/g, "").replace(/\/+$/, "")),
              );
          }
        for (const t of targets) {
          const glob = /[*?]/.test(t)
            ? new RegExp(
                "(?:^|/)" +
                  t
                    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
                    .replace(/\*/g, "[^/]*")
                    .replace(/\?/g, "[^/]") +
                  "$",
              )
            : null;
          const known = [...new Set(versions.filter((v) => v.seq < e.seq).map((v) => v.file))].filter((f) =>
            glob ? glob.test(f) : same(f, t) || f.startsWith(t + "/") || f.includes("/" + t + "/"),
          );
          for (const f of known) {
            const lastV = versions.filter((v) => v.file === f && v.seq < e.seq).pop();
            const names = Object.keys(tests(lastV.new_content));
            if (!names.length && !testFile(f)) continue;
            const gone = names.filter((k) => !kept(f, e.seq, k));
            if (names.length && !gone.length) continue; // every test of it lives on elsewhere: moved
            push("test_file_deleted_msg", f, e.seq, gone);
          }
          if (!known.length && !glob && testFile(t)) push("test_file_deleted_msg", t, e.seq, []);
        }
      }
      return out;
    },
    /* In a testing task the product is what is under test: an agent that changes it to make a test pass hides the bug
       the test found. A file in the profile's src_dirs that is not test-side code (a test, a fixture, a page object,
       a runner config); a file the approved plan names is not reported. High right after a red run. */
    product_code_edited(ev, cfg) {
      const p = planSeq(ev, cfg);
      const planned = approvalSeq(ev, p) != null ? plannedFiles(ev, p, cfg) : new Set();
      const product = (f) => productFile(f, cfg) && !inPlan(f, planned);
      const byFile = {};
      for (const e of ev) if (["write", "edit"].includes(e.kind) && e.file && product(e.file)) (byFile[e.file] = byFile[e.file] || []).push(e);
      // one finding per file: its first edit right after a red run if there is one, else its first edit
      return Object.entries(byFile).map(([file, edits]) => {
        const hot = edits.find((e) => redRunBefore(ev, e.seq));
        const e = hot || edits[0];
        const r = hot && redRunBefore(ev, e.seq);
        return F("product_code_edited", r ? "high" : "medium", e.seq, T("product_edited", { file, after: r ? T("after_red_run", { seq: r.seq }) : "" }));
      });
    },
    /* Snapshots rewritten instead of read: jest/vitest -u, playwright --update-snapshots, pytest --snapshot-update,
       UPDATE_SNAPSHOTS=1, or a snapshot file written by hand. Writing the first baselines of new tests is normal, so
       medium; right after a red run it is how a diff the test caught becomes the new truth: high. */
    snapshot_overwritten(ev) {
      /* the runner starts the command: after environment variables, env and its options, sudo, npx, bunx, pnpm exec/dlx,
         yarn dlx/exec or python -m only. A line of a heredoc or a quoted string that mentions "jest -u" is not a run. */
      const RUNNER =
        /^\s*(?:(?:\w+=\S*|env(?:\s+-u\s+\S+|\s+-\w+)*|sudo|npx|bunx|(?:pnpm|yarn)\s+(?:exec|dlx)|python3?\s+-m)\s+)*(?:\S*\/)?(?:jest|vitest|playwright|pytest|cypress|(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?test[\w:-]*)(?=\s|$)/;
      // a flag counts only after the runner (env -u X npm test is env's -u); an environment variable may come before it
      const FLAG = /(?:^|\s)(?:-u|--updateSnapshot|--update-snapshots?(?:=\S+)?|--snapshot-update)(?=\s|$)|\bupdateSnapshots?=true\b/i;
      const ENV = /\bUPDATE_SNAPSHOTS?=(?:1|true)\b/i;
      const updates = (part) => {
        const m = part.match(RUNNER);
        return !!m && (ENV.test(m[0]) || FLAG.test(part.slice(m[0].length)));
      };
      // Jest/Vitest, jest-image-snapshot, Playwright, and the baselines of ApprovalTests (Java) and Verify (.NET)
      const SNAP_FILE = /(?:^|\/)(?:__snapshots__|__image_snapshots__)\/|\.snap$|-snapshots\/[^/]+$|\.(?:approved|verified)\.\w+$/;
      const out = [],
        files = new Set();
      const after = (seq) => {
        const r = redRunBefore(ev, seq);
        return [r ? "high" : "medium", r ? T("after_red_run", { seq: r.seq }) : ""];
      };
      for (const e of ev) {
        if (e.cmd && e.cmd.split(/&&|\|\||;|\n/).some(updates)) {
          const [sev, a] = after(e.seq);
          out.push(F("snapshot_overwritten", sev, e.seq, T("snapshot_cmd", { cmd: e.cmd.trim().slice(0, 80), after: a })));
        } else if (["write", "edit"].includes(e.kind) && e.file && SNAP_FILE.test(e.file) && !files.has(e.file)) {
          files.add(e.file);
          const [sev, a] = after(e.seq);
          out.push(F("snapshot_overwritten", sev, e.seq, T("snapshot_file", { file: e.file, after: a })));
        }
      }
      return out;
    },
    /* A runner config loosened so that red turns green: more retries, a longer timeout, tests excluded, failures
       ignored. Compared with what the file was before (prev_content from the import, or the session's previous version
       of it); a config seen for the first time is reported only for retries, as before 0.1.113. High right after a red
       run. Since 0.1.114 also Maven (surefire, failsafe), Gradle and .runsettings. */
    config_weakened(ev) {
      const num = (x) => x.split("*").reduce((a, t) => a * Number(t.replace(/_/g, "").trim()), 1);
      const TIMEOUT =
        /\b(timeout|testTimeout|hookTimeout|actionTimeout|navigationTimeout|defaultCommandTimeout|pageLoadTimeout|requestTimeout|responseTimeout|execTimeout|taskTimeout)\s*[:=]\s*([\d_]+(?:\s*\*\s*[\d_]+)*)|--timeout[=\s]+(\d+)/g;
      // Maven surefire/failsafe and .runsettings (MSTest's TestTimeout inside it): <key>seconds or ms</key>
      const XML_TIMEOUT =
        /<(forkedProcessTimeoutInSeconds|forkedProcessExitTimeoutInSeconds|parallelTestsTimeoutInSeconds|TestSessionTimeout|TestTimeout)>\s*(\d+)\s*</g;
      const RETRIES =
        /\bretries\s*[:=]\s*(?:\{[^}]*?\brunMode\s*:\s*)?(\d+)|--reruns[=\s]+(\d+)|\breruns\s*=\s*(\d+)|<rerunFailingTestsCount>\s*(\d+)|\bmaxRetries\s*(?:=|\.set\(|\(\s*)\s*(\d+)/g;
      const EXCLUDE =
        /\b(?:testIgnore|testPathIgnorePatterns|excludeSpecPattern|grepInvert|exclude)\s*[:=]|--ignore(?:-glob)?[=\s]|--deselect[=\s]|\s-k\s+["']?not\b|<(?:exclude|excludedGroups|excludes|TestCaseFilter)>\s*[^<\s]|\b(?:excludeTestsMatching|excludeTags|excludeCategories)\b|\bexclude\s*\(?\s*["']/;
      // the build passes whatever the tests do, or skips them: Maven, Gradle
      const IGNORE =
        /<(?:testFailureIgnore|skipTests|skip|maven\.test\.skip|maven\.test\.failure\.ignore)>\s*true\s*<|\bignoreFailures\s*(?:=|\.set\()\s*true\b/;
      /* the part of a build file about tests: in a pom.xml the surefire and failsafe plugins and <properties> (other
         plugins have their own <exclude> and <skip>); in a Gradle script the blocks of the test tasks (a jar or a
         dependency has its own exclude). Other configs are read whole. */
      const scope = (src, file) => {
        if (/(?:^|\/)pom\.xml$/i.test(file))
          return [
            ...src.matchAll(
              /<plugin>(?:(?!<\/plugin>)[\s\S])*?<artifactId>\s*maven-(?:surefire|failsafe)-plugin\s*<\/artifactId>[\s\S]*?<\/plugin>|<properties>[\s\S]*?<\/properties>/g,
            ),
          ]
            .map((m) => m[0])
            .join("\n");
        if (!/(?:^|\/)build\.gradle(?:\.kts)?$/i.test(file)) return src;
        const parts = [];
        for (const m of src.matchAll(/[^\n;{}]*\{/g)) {
          if (!/\btest\b|\bTest\b|\b\w*[a-z]Test\b|\btest[A-Z]\w*/.test(m[0].slice(0, -1))) continue;
          let depth = 0,
            i = m.index + m[0].length - 1;
          for (; i < src.length; i++) {
            if (src[i] === "{") depth++;
            else if (src[i] === "}" && --depth === 0) break;
          }
          parts.push(src.slice(m.index, i + 1));
        }
        return parts.join("\n");
      };
      const read = (whole, file) => {
        const src = scope(whole, file),
          timeouts = {};
        const add = (k, v) => (timeouts[k] = timeouts[k] || []).push(v);
        for (const m of src.matchAll(TIMEOUT)) add(m[1] || "timeout", num(m[2] || m[3]));
        for (const m of src.matchAll(XML_TIMEOUT)) add(m[1], +m[2]);
        const retries = [...src.matchAll(RETRIES)].map((m) => +(m[1] || m[2] || m[3] || m[4] || m[5]));
        const lines = (rx) =>
          new Set(
            src
              .split("\n")
              .filter((l) => rx.test(l) && !/^\s*(?:\/\/|#|\*|<!--)/.test(l))
              .map((l) => l.trim()),
          );
        return { timeouts, retries: retries.length ? Math.max(...retries) : 0, excludes: lines(EXCLUDE), ignores: lines(IGNORE) };
      };
      const out = [],
        last = {};
      for (const e of ev) {
        const src = e.new_content || e.config_content;
        if (!["write", "edit"].includes(e.kind) || !src || !isRunnerConfig(e.file)) continue;
        // the import's prev_content is the file as it was, even when the event itself started as a fragment (a first
        // Edit that toolUseResult made whole); without it a fragment has nothing to compare with
        const prevSrc = e.prev_content ?? (e.fragment_only ? null : last[e.file]) ?? null;
        last[e.file] = src;
        const now = read(src, e.file),
          what = [];
        if (prevSrc == null) {
          if (now.retries > 0) what.push(T("cw_set", { key: "retries", to: now.retries }));
        } else {
          const was = read(prevSrc, e.file);
          if (now.retries > was.retries) what.push(T("cw_change", { key: "retries", from: was.retries, to: now.retries }));
          for (const [key, vals] of Object.entries(now.timeouts)) {
            const old = was.timeouts[key] || [];
            vals.forEach((v, i) => {
              if (i >= old.length) what.push(T("cw_added", { key, to: v }));
              else if (v > old[i]) what.push(T("cw_change", { key, from: old[i], to: v }));
            });
          }
          for (const l of now.excludes) if (!was.excludes.has(l)) what.push(T("cw_excluded", { line: l.slice(0, 80) }));
          for (const l of now.ignores) if (!was.ignores.has(l)) what.push(T("cw_ignored", { line: l.slice(0, 80) }));
        }
        if (!what.length) continue;
        const r = redRunBefore(ev, e.seq);
        const msg = T("config_weakened_msg", { file: e.file, what: what.join("; "), after: r ? T("after_red_run", { seq: r.seq }) : "" });
        out.push(F("config_weakened", r ? "high" : "medium", e.seq, msg));
      }
      return out;
    },
    focused_test(ev, cfg) {
      const out = [];
      for (const e of ev) {
        if (!e.new_content) continue;
        const ln = codeOf(e)
          .split("\n")
          .find((l) => (cfg.focus_patterns || []).some((r) => r.test(l)));
        if (ln)
          out.push(Object.assign(F("focused_test", "high", e.seq, T("focused", { file: e.file || inMsg(), line: ln.trim().slice(0, 80) })), { kind: "only" }));
      }
      return out;
    },
    // one finding per file and kind: the profile's engine may look for one kind (page.pause) and not another (debugger)
    debug_leftover(ev, cfg) {
      const out = [];
      for (const e of ev) {
        if (!e.new_content) continue;
        for (const [kind, rx] of Object.entries(cfg.debug_patterns || {})) {
          const m = codeOf(e).match(rx);
          if (m)
            out.push(
              Object.assign(F("debug_leftover", "medium", e.seq, T("debug_leftover", { file: e.file || inMsg(), line: m[0].trim().slice(0, 80) })), { kind }),
            );
        }
      }
      return out;
    },
    assumption_instead_of_question(ev, cfg) {
      const out = [];
      for (const e of ev) {
        if (e.kind !== "message") continue;
        const prose = e.text.replace(/```[\s\S]*?```/g, "");
        const hits = cfg.assumption_patterns.filter((p) => p.test(prose));
        if (!hits.length) continue;
        const sn = (prose.split(/[.\n]/).find((s) => hits.some((h) => h.test(s))) || "").trim().slice(0, 140);
        out.push(F("assumption_instead_of_question", "medium", e.seq, T("assumption", { snippet: sn })));
      }
      return out;
    },
    tests_never_run(ev, cfg) {
      const code = ev.filter(
        (e) =>
          e.new_content &&
          /def test|@Test|\b(?:it|test)\s*\(|func Test|\[(?:Fact|Theory|Test|TestMethod|TestCase)\b|\bpm\.test\s*\(|^\s*Scenario(?: Outline)?:/m.test(
            e.new_content,
          ),
      );
      if (!code.length) return [];
      if (ev.some((e) => e.kind === "run_tests")) return [];
      return [F("tests_never_run", "high", code[code.length - 1].seq, T("never_run", { n: code.length }))];
    },
    /* a commented-out assertion never runs: a line that is a comment (//, #, /* or * inside a block) is skipped (0.1.118),
       and since 0.1.121 a line inside a block comment without a leading * too */
    hardcoded_date(ev) {
      const RX =
        /(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}|\b20\d{2}-\d{2}-\d{2}\b|\b(?:январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)\w*\s+\d{4}/i;
      const out = [];
      for (const e of ev) {
        if (!e.new_content) continue;
        for (const ln of linesOf(e).split("\n"))
          if (!/^\s*(?:\/\/|#|\/\*|\*)/.test(ln) && /expect|assert|toHaveText|getByText/.test(ln) && RX.test(ln))
            out.push(F("hardcoded_date", "medium", e.seq, T("hard_date", { file: e.file || inMsg(), line: ln.trim().slice(0, 80) })));
      }
      return out;
    },
    /* Since 0.1.121 also the other ways to wait for network idle, in every language Playwright has: waitForLoadState /
       wait_for_load_state, Python's wait_until=, Java's and C#'s LoadState / WaitUntilState constants (worded apart, so
       the verdicts on "waitUntil: 'networkidle'" keep their key); and an exact count compared with toBe, toEqual or
       toStrictEqual, spaces allowed, in Python with ==, and in Java and C# with their assertion libraries. */
    fragile_wait(ev) {
      const IDLE_OPTION = /waitUntil\s*:\s*['"]networkidle['"]/;
      const IDLE_OTHER =
        /\bwait_until\s*=\s*['"]networkidle['"]|\bwait(?:ForLoadState(?:Async)?|_for_load_state)\s*\(\s*['"]networkidle['"]|\b(?:LoadState|WaitUntilState)\.(?:NETWORKIDLE|NetworkIdle)\b/;
      const COUNT = new RegExp(
        [
          String.raw`\.count\(\)\s*\)\s*\.(?:toBe|toEqual|toStrictEqual)\(\s*\d+\s*\)`, // expect(await rows.count()).toBe(3)
          String.raw`\.count\(\)\s*==\s*\d+`, // Python: assert rows.count() == 3
          // Java and C#: assertEquals(3, rows.count()), Assert.AreEqual / Assert.Equal(3, await rows.CountAsync())
          String.raw`\b(?:assertEquals|Assert\.(?:AreEqual|Equal))\s*\(\s*\d+\s*,[^;\n]*\.(?:count|CountAsync)\(\)`,
          String.raw`\.(?:count|CountAsync)\(\)\s*\)\s*\.isEqualTo\(\s*\d+\s*\)`, // AssertJ: assertThat(rows.count()).isEqualTo(3)
          String.raw`\.CountAsync\(\)\s*,\s*Is\.EqualTo\(\s*\d+\s*\)`, // NUnit: Assert.That(await rows.CountAsync(), Is.EqualTo(3))
          String.raw`\.CountAsync\(\)\s*\)\s*\.Should\(\)\.Be\(\s*\d+\s*\)`, // FluentAssertions
        ].join("|"),
      );
      const out = [];
      for (const e of ev) {
        if (!e.new_content) continue;
        const code = codeOf(e);
        if (IDLE_OPTION.test(code))
          out.push(Object.assign(F("fragile_wait", "medium", e.seq, T("networkidle", { file: e.file || inMsg() })), { kind: "networkidle" }));
        else if (IDLE_OTHER.test(code))
          out.push(Object.assign(F("fragile_wait", "medium", e.seq, T("networkidle_wait", { file: e.file || inMsg() })), { kind: "networkidle" }));
        if (COUNT.test(code)) out.push(Object.assign(F("fragile_wait", "low", e.seq, T("exact_count", { file: e.file || inMsg() })), { kind: "count" }));
      }
      return out;
    },
    // ---- API tests: what an agent gets wrong when the thing under test is an HTTP API ----
    status_only_assert(ev, cfg) {
      const out = [];
      for (const e of ev) {
        if (!e.new_content) continue;
        for (const [name, body] of Object.entries(blocksByTest(linesOf(e), cfg.test_fn_pattern))) {
          const at = body.indexOf(".then()"),
            scope = at >= 0 ? body.slice(at) : body;
          const as = scope.split("\n").filter((l) => isAssertLine(l, cfg) || (at >= 0 && /^\s*\.(?:header|headers|contentType|time|cookie)\s*\(/.test(l)));
          if (as.length && as.every(isStatusLine))
            out.push(F("status_only_assert", "medium", e.seq, T("status_only", { file: e.file || inMsg(), test: name })));
        }
      }
      return out;
    },
    mocked_service(ev) {
      const RX = [
        /@responses\.activate\b|\bresponses\.add\s*\(|\brequests_mock\b|\bhttpx_mock\b|\brespx\.(?:mock|route)\b|\baioresponses\b|\bpatch\s*\(\s*['"](?:requests|httpx|aiohttp)\./,
        /\bWireMock\w*\b|\bMockWebServer\b|\bMockRestServiceServer\b/,
        /\bnock\s*\(|\b(?:jest|vi)\.mock\s*\(\s*['"](?:axios|node-fetch|got|superagent|undici)['"]|\bsetupServer\s*\(|\bfetchMock\b/,
        /\bMockHttpMessageHandler\b|\bMock<HttpMessageHandler>|\bMockHttp\b/,
      ];
      const out = [];
      for (const e of ev) {
        if (!e.new_content) continue;
        for (const rx of RX) {
          const m = codeOf(e).match(rx);
          if (m) {
            out.push(F("mocked_service", "medium", e.seq, T("mocked_api", { file: e.file || inMsg(), what: m[0].trim().slice(0, 40) })));
            break;
          }
        }
      }
      return out;
    },
    hardcoded_secret(ev) {
      const out = [],
        mask = (v) => `${v.slice(0, 4)}… (${v.length})`;
      const ENV = /environ|getenv|process\.env|GetEnvironmentVariable|\benv\s*\(|Configuration\[/i;
      const PLACEHOLDER =
        /^(?:<.*>|\{\{.*\}\}|\$\{.*\}|%.*%|\*{3,}|x{4,}|\.{3}|your[-_ ]|my[-_ ]|example|dummy|fake|sample|placeholder|change[-_ ]?me|test|todo|null|none|undefined|secret|token|password)/i;
      const KINDS = SECRET_KINDS;
      for (const e of ev) {
        if (!e.new_content) continue;
        const seen = new Set();
        for (const line of e.new_content.split("\n")) {
          if (/^\s*(?:#|\/\/|\*)/.test(line) || ENV.test(line)) continue;
          for (const [kind, rx] of KINDS) {
            rx.lastIndex = 0;
            for (const m of line.matchAll(rx)) {
              const v = m[1] || m[0];
              if (seen.has(v) || PLACEHOLDER.test(v)) continue;
              seen.add(v);
              out.push(F("hardcoded_secret", "high", e.seq, T("secret_found", { file: e.file || inMsg(), kind: T(kind), masked: mask(v) })));
            }
          }
        }
      }
      return out;
    },
    hardcoded_base_url(ev) {
      const SKIP =
        /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|host\.docker\.internal|(?:[\w-]+\.)*(?:example\.(?:com|org|net)|test|invalid|local|localhost)|(?:www\.)?(?:w3\.org|json-schema\.org|swagger\.io|openapis\.org|github\.com|githubusercontent\.com|npmjs\.com|mozilla\.org|wikipedia\.org|apache\.org|postman\.com|getpostman\.com|schemas\.microsoft\.com))$/i;
      const out = [],
        seen = new Set();
      // a runner's config file is where the base URL belongs (baseURL in playwright.config.ts): what the rule asks for
      for (const e of ev) {
        if (!e.new_content || RUNNER_CONFIG_RX.test(e.file || "")) continue;
        for (const line of linesOf(e).split("\n")) {
          if (/^\s*(?:#|\/\/|\*)|\$schema|xmlns|href\s*=|@see/.test(line)) continue;
          for (const m of line.matchAll(/https?:\/\/([A-Za-z0-9.-]+|\[[0-9a-f:]+\])(?::\d+)?/gi)) {
            const host = m[1];
            if (SKIP.test(host)) continue;
            const k = `${e.file || ""}|${host}`;
            if (seen.has(k)) continue;
            seen.add(k);
            out.push(F("hardcoded_base_url", "medium", e.seq, T("base_url", { file: e.file || inMsg(), host })));
          }
        }
      }
      return out;
    },
    no_negative_cases(ev, cfg) {
      const NEG_NAME =
        /invalid|unauthori[sz]ed|forbidden|not[_ -]?found|bad[_ -]?request|without|missing|expired|denied|reject|error|fail|negative|conflict|duplicate|malformed|unknown|nonexist|too[_ -]?many/i;
      const NEG_CODE =
        /\b(?:400|401|403|404|405|406|409|410|413|415|422|429|5\d\d)\b|Unauthorized|Forbidden|NotFound|BadRequest|Conflict|Unprocessable|UNAUTHORIZED|FORBIDDEN|NOT_FOUND|BAD_REQUEST|CONFLICT|UNPROCESSABLE/;
      const latest = new Map();
      for (const e of ev) if (e.new_content) latest.set(e.file || "#" + e.seq, e);
      const seen = new Set();
      let neg = 0,
        last = -1;
      for (const [file, e] of latest)
        for (const [name, body] of Object.entries(blocksByTest(linesOf(e), cfg.test_fn_pattern))) {
          const k = `${file.startsWith("#") ? "" : file}|${name}`;
          if (seen.has(k)) continue;
          seen.add(k);
          last = Math.max(last, e.seq);
          if (NEG_NAME.test(name) || body.split("\n").some((l) => isAssertLine(l, cfg) && NEG_CODE.test(l) && !/[<>]=?\s*\d{3}/.test(l))) neg++;
        }
      return seen.size >= 2 && neg === 0 ? [F("no_negative_cases", "medium", last, T("no_negative", { n: seen.size }))] : [];
    },
    test_data_no_cleanup(ev, cfg) {
      const NON_CREATING =
        /\b(?:login|logout|log-in|signin|sign-in|auth|token|oauth|search|query|graphql|verify|validate|refresh|echo|otp|reset|filter|export|calculate)\b/i;
      const CLEANUP =
        /\.delete\s*\(|\bDeleteAsync\s*\(|(?:Method|HttpMethod)\.Delete\b|\bmethod\s+delete\b|\bteardown\w*|\btearDown\b|@After(?:Each|All|Class|Method)?\b|\bafterEach\s*\(|\bafterAll\s*\(|\[(?:OneTime)?TearDown\]|\bDispose\s*\(|\byield\b|addfinalizer|\bclean_?up\b/i;
      const out = [];
      for (const e of ev) {
        if (!e.new_content) continue;
        // without comments (since 0.1.122): a commented-out .post( creates nothing, a commented-out afterEach cleans nothing
        const code = codeOf(e);
        if (!Object.keys(blocksByTest(code, cfg.test_fn_pattern)).length) continue;
        const paths = [...code.matchAll(/\.post\s*\(\s*([^,)\n]+)/g)]
          .map((m) => m[1])
          .concat([...code.matchAll(/\bPost(?:AsJson)?Async\s*\(\s*([^,)\n]+)/g)].map((m) => m[1]));
        const label = (p) => ((p.match(/["'`]([^"'`]+)["'`]/) || [])[1] || "POST").slice(0, 40);
        const unknown = /(?:Method|HttpMethod)\.Post\b|^\s*(?:\*|Given|When|And|Then)\s+method\s+post\b/im.test(code);
        if (!(paths.some((p) => !NON_CREATING.test(p)) || unknown) || CLEANUP.test(code)) continue;
        out.push(
          F("test_data_no_cleanup", "low", e.seq, T("no_cleanup", { file: e.file || inMsg(), what: label(paths.find((p) => !NON_CREATING.test(p)) || "") })),
        );
      }
      return out;
    },
    response_time_assert(ev, cfg) {
      const TIME = /\belapsed\b|response_?time|\bresponseTime\b|\.time\s*\(|\blatency\b|\bduration\b|ElapsedMilliseconds|total_seconds\s*\(/i,
        CMP = /<|\bbelow\b|\blessThan\w*|toBeLessThan\w*|\bLess(?:Than)?\b|\bmax\b/i;
      const out = [];
      for (const e of ev) {
        if (!e.new_content) continue;
        for (const [name, body] of Object.entries(blocksByTest(linesOf(e), cfg.test_fn_pattern))) {
          const ln = body.split("\n").find((l) => /assert|expect/i.test(l) && TIME.test(l) && CMP.test(l));
          if (ln) out.push(F("response_time_assert", "low", e.seq, T("resp_time", { file: e.file || inMsg(), test: name, line: ln.trim().slice(0, 60) })));
        }
      }
      return out;
    },
    // ---- Appium/mobile (qa-mobile): protocol-level, not tied to one client language ----
    mobile_raw_locator(ev) {
      const RX =
        /\b(?:By|MobileBy|AppiumBy)\s*\.\s*(?:xpath|XPath|className|ClassName)\s*\(|\bfindElementBy(?:XPath|ClassName)\b|\$\(\s*['"`](?:\/\/|\.[A-Za-z]|#[A-Za-z])/;
      const out = [];
      for (const e of ev) {
        if (!e.new_content) continue;
        const n = codeOf(e)
          .split("\n")
          .filter((l) => RX.test(l)).length;
        if (n) out.push(F("mobile_raw_locator", "low", e.seq, T("mobile_raw_locator_msg", { file: e.file || inMsg(), n })));
      }
      return out;
    },
    /* Since 0.1.119: a gesture call whose first two arguments are numbers (not clickRow(15, 30)), or x and y numbers on a
       line about a gesture: touchAction({ action: 'tap', x: 120, y: 340 }), tap(x=100, y=200), a pointerMove. */
    hardcoded_coordinates(ev) {
      const CALL =
        /\b(?:tap|swipe|longPress|long_press|press|doubleTap|double_tap|click|moveTo|move_to|move_to_location|move_by_offset|point|withCoordinates)\s*\(\s*[[(]*\s*-?\d{2,}\s*,\s*-?\d{2,}/i;
      const XY = /\bx\s*[:=]\s*-?\d{2,}\s*,\s*y\s*[:=]\s*-?\d{2,}/;
      const GESTURE = /tap|swipe|press|touch|pointer|gesture|click|scroll|drag|move/i;
      const out = [];
      for (const e of ev) {
        if (!e.new_content) continue;
        const ln = codeOf(e)
          .split("\n")
          .find((l) => CALL.test(l) || (XY.test(l) && GESTURE.test(l)));
        if (ln)
          out.push(F("hardcoded_coordinates", "medium", e.seq, T("hardcoded_coordinates_msg", { file: e.file || inMsg(), line: ln.trim().slice(0, 60) })));
      }
      return out;
    },
    no_driver_teardown(ev) {
      const CREATE = /\bnew\s+(?:AppiumDriver|AndroidDriver|IOSDriver|RemoteWebDriver)\b|\bwebdriver\.remote\s*\(|\bRemote\s*\(\s*command_executor/i;
      const TEARDOWN = /\bdriver\.quit\s*\(\)|\bdriver\.Quit\s*\(\)|\bafterEach\s*\(|\bafter\s*\(|@After(?:Each|Class)?\b|\btearDown\b|\[TearDown\]/i;
      const out = [];
      for (const e of ev) {
        if (!e.new_content || !CREATE.test(codeOf(e)) || TEARDOWN.test(codeOf(e))) continue;
        out.push(F("no_driver_teardown", "medium", e.seq, T("no_driver_teardown_msg", { file: e.file || inMsg() })));
      }
      return out;
    },
    // ---- test smells (taxonomy: TsDetect / Pynose), per test block ----
    /* A line with a comment is skipped: the comment may explain the number, or the line is commented out. Since 0.1.120
       only a real comment counts: "#" or "//" inside a string (a CSS id, a URL) or `this.#field` is not one, and a line
       inside a block comment ("* expect(…)", and since 0.1.121 a line there with no leading *) is. */
    magic_number(ev, cfg) {
      const out = [],
        OK = new Set([0, 1, 2, 100, 200, 201, 204, 301, 302, 400, 401, 403, 404, 405, 409, 422, 423, 429, 500, 502, 503]);
      const STRING = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
      const commented = (ln) => /\/\/|\/\*|(?:^|\s)#|^\s*\*/.test(ln.replace(STRING, '""'));
      for (const e of ev) {
        if (!e.new_content || !cfg.assert_line_patterns) continue;
        for (const [name, body] of Object.entries(blocksByTest(linesOf(e), cfg.test_fn_pattern))) {
          const nums = new Set();
          for (const ln of body.split("\n"))
            if (cfg.assert_line_patterns.some((p) => p.test(ln)) && !commented(ln))
              for (const m of ln.matchAll(/(?<![\w.])(-?\d+(?:\.\d+)?)(?![\w.])/g)) {
                const n = +m[1];
                if (!OK.has(n) && Math.abs(n) > 1) nums.add(m[1]);
              }
          if (nums.size) out.push(F("magic_number", "low", e.seq, T("magic", { file: e.file || inMsg(), test: name, nums: [...nums].slice(0, 4).join(", ") })));
        }
      }
      return out;
    },
    assertion_roulette(ev, cfg) {
      const out = [];
      if (!["python", "java"].includes(cfg.language)) return out;
      for (const e of ev) {
        if (!e.new_content || !cfg.assert_line_patterns) continue;
        for (const [name, body] of Object.entries(blocksByTest(linesOf(e), cfg.test_fn_pattern))) {
          const as = body.split("\n").filter((l) => isAssertLine(l, cfg));
          const withMsg = as.filter((l) => (cfg.language === "python" ? /,\s*(?:f?["'])/.test(l) : /assert\w+\s*\("[^"]*",/.test(l))).length;
          if (as.length >= 3 && withMsg === 0)
            out.push(F("assertion_roulette", "low", e.seq, T("roulette", { file: e.file || inMsg(), test: name, n: as.length })));
        }
      }
      return out;
    },
    conditional_logic(ev, cfg) {
      const out = [];
      for (const e of ev) {
        if (!e.new_content || !cfg.test_fn_pattern) continue;
        for (const [name, body] of Object.entries(blocksByTest(linesOf(e), cfg.test_fn_pattern))) {
          const inner = body.split("\n").slice(1).join("\n");
          // since 0.1.121 also C#'s foreach and a loop written as a call: rows.forEach(…), list.ForEach(…). A line with no
          // indentation is not read: in Python the block runs on past the test's end into the module's own code.
          // [ \t]+, not \s+: \s also takes the line break, so a line with no indentation after a blank one counted
          const m = inner.match(/^[ \t]+(?:if|for|foreach|while|switch|try)\b[^\n]*/m) || inner.match(/^[ \t]+[^\n]*\.(?:forEach|ForEach)\s*\([^\n]*/m);
          if (m)
            out.push(
              Object.assign(F("conditional_logic", "low", e.seq, T("conditional", { file: e.file || inMsg(), test: name, line: m[0].trim().slice(0, 50) })), {
                kind: "branch",
              }),
            );
        }
      }
      return out;
    },
    duplicate_assert(ev, cfg) {
      const out = [];
      for (const e of ev) {
        if (!e.new_content || !cfg.assert_line_patterns) continue;
        for (const [name, body] of Object.entries(blocksByTest(linesOf(e), cfg.test_fn_pattern))) {
          const seen = new Map();
          for (const l of body.split("\n")) {
            const t = l.trim();
            if (!isAssertLine(t, cfg)) continue;
            seen.set(t, (seen.get(t) || 0) + 1);
          }
          const dup = [...seen].filter(([, n]) => n > 1);
          if (dup.length) out.push(F("duplicate_assert", "low", e.seq, T("dup_assert", { file: e.file || inMsg(), test: name, line: dup[0][0].slice(0, 60) })));
        }
      }
      return out;
    },
    /* An async Cypress hook (0.1.121, qa-cypress): Cypress commands are queued, not awaited, so an async hook runs out of
       order. ESLint's cypress/no-async-before (vendored) sees only a titled before / beforeEach, before("load", async
       …), and nothing sees after / afterEach. This sees what it does not: an untitled before / beforeEach, and an after /
       afterEach with or without a title. So the two never report the same hook, and an async it() stays the engine's. */
    cypress_async_test(ev) {
      const RX = /\b(?:(?:before|beforeEach)\s*\(\s*async\b|(?:after|afterEach)\s*\(\s*(?:(['"`])[^'"`\n]*\1\s*,\s*)?async\b)/;
      const out = [];
      for (const e of ev) {
        if (!e.new_content) continue;
        const ln = codeOf(e)
          .split("\n")
          .find((l) => RX.test(l));
        if (ln) out.push(F("cypress_async_test", "medium", e.seq, T("cypress_async_hook", { file: e.file || inMsg(), line: ln.trim().slice(0, 60) })));
      }
      return out;
    },
    /* test.fail() keeps the suite green while the bug it documents is still open in production. Defensible,
       but it must be a decision someone made, not a detail buried in a spec file. A test that does not run at all
       (@Disabled, t.Skip) is a skip: sleep_or_skip_added, not this (0.1.113). Since 0.1.121: Jest's it.failing /
       test.failing, and pytest's xfail only as the marker or the call (the word in a docstring or a string is not one). */
    expected_failure(ev, cfg) {
      const RX = /\btest\.fail\s*\(|\b(?:it|test)\.failing\b|\bmark\.xfail\b|\bpytest\.xfail\s*\(/;
      const out = [];
      for (const e of ev) {
        if (!e.new_content || !RX.test(codeOf(e))) continue;
        const n = (codeOf(e).match(new RegExp(RX.source, "g")) || []).length;
        out.push(F("expected_failure", "medium", e.seq, T("expected_failure", { file: e.file || inMsg(), n })));
      }
      return out;
    },
    user_frustration(ev) {
      const RX =
        /(?:^|[\s,.!])(?:нет|не то|не так|не это|опять|снова|ещё раз|еще раз|я же (?:сказал|просил|писал|говорил)|ты не (?:понял|прочитал)|верни|откати|not what i|again|i (?:said|asked|told)|wrong|revert|undo)(?=[\s,.!?]|$)/i;
      const out = [],
        users = ev.filter((e) => e.kind === "user");
      users.forEach((u, i) => {
        const t = u.text.toLowerCase();
        if (RX.test(t) && t.length < 400) out.push(F("user_frustration", "medium", u.seq, T("frustration", { text: u.text.trim().slice(0, 100) })));
        else if (i > 0 && t.length > 15 && users[i - 1].text.toLowerCase().slice(0, 40) === t.slice(0, 40))
          out.push(F("user_frustration", "medium", u.seq, T("repeat", { text: u.text.trim().slice(0, 80) })));
      });
      return out;
    },
    stop_markers_missing(ev, cfg) {
      const p = planSeq(ev, cfg);
      const fe = ev.find((x) => ["edit", "write"].includes(x.kind));
      if (!fe) return [];
      if (p == null) return [F("stop_markers_missing", "medium", fe.seq, T("no_plan"))];
      if (approvalSeq(ev, p) == null) return [F("stop_markers_missing", "medium", fe.seq, T("no_approval"))];
      return [];
    },
  };

  /* ---------- Gherkin / .feature — profile-agnostic ----------
     Cucumber-JVM (Java), SpecFlow (C#), behave (Python) and Karate all share the same Gherkin syntax, so
     these checks are not tied to one profile or language: they run on every .feature file the session
     touches, whatever profile is active (see stripNonSource above, which never drops .feature content).
     No tree-sitter/WASM needed — the grammar is regular enough for a plain line parser. */
  const GHERKIN_BG_MAX_STEPS = 6;
  /* Gherkin's keywords in English and Russian (Cucumber's own i18n table), with their synonyms: Example for Scenario,
     Scenario Template for Scenario Outline, Scenarios for Examples (0.1.121; until then English only, without synonyms,
     so a feature in Russian gave no scenario and none of the checks ran). A step keyword becomes its English name. */
  const GH_HEAD = (words) => new RegExp("^(?:" + words.join("|") + ")\\s*:\\s*(.*)$");
  const GH_BACKGROUND = GH_HEAD(["Background", "Предыстория", "Контекст"]);
  const GH_OUTLINE = GH_HEAD(["Scenario Outline", "Scenario Template", "Структура сценария", "Шаблон сценария"]);
  const GH_SCENARIO = GH_HEAD(["Scenario", "Example", "Сценарий", "Пример"]);
  const GH_EXAMPLES = GH_HEAD(["Examples", "Scenarios", "Примеры"]);
  const GH_STEP_WORDS = {
    Given: ["Given", "Дано", "Допустим", "Пусть"],
    When: ["When", "Когда", "Если"],
    Then: ["Then", "Тогда", "Затем", "То"],
    And: ["And", "К тому же", "Также", "И"],
    But: ["But", "Иначе", "Но", "А"],
  };
  const GH_STEP_KW = new Map(Object.entries(GH_STEP_WORDS).flatMap(([en, words]) => words.map((w) => [w, en])));
  const GH_STEP = new RegExp("^(" + [...GH_STEP_KW.keys()].join("|") + "|\\*)\\s+(.+)$");
  function parseFeature(text) {
    const scenarios = [];
    let background = null,
      cur = null,
      inExamples = false,
      docString = null; // the fence of an open doc string: its lines are text, not steps
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (docString) {
        if (t.startsWith(docString)) docString = null;
        continue;
      }
      if (t.startsWith('"""') || t.startsWith("```")) {
        docString = t.slice(0, 3);
        continue;
      }
      if (!t || t.startsWith("#") || t.startsWith("@")) continue;
      let m;
      if ((m = t.match(GH_BACKGROUND))) {
        background = { steps: [], line: i + 1 };
        cur = background;
        inExamples = false;
        continue;
      }
      if ((m = t.match(GH_OUTLINE))) {
        cur = { name: m[1] || `#${scenarios.length + 1}`, outline: true, steps: [], line: i + 1, hasExamples: false, exampleRows: 0, exHeaderSeen: false };
        scenarios.push(cur);
        inExamples = false;
        continue;
      }
      if ((m = t.match(GH_SCENARIO))) {
        cur = { name: m[1] || `#${scenarios.length + 1}`, outline: false, steps: [], line: i + 1 };
        scenarios.push(cur);
        inExamples = false;
        continue;
      }
      if (GH_EXAMPLES.test(t)) {
        if (cur && cur.outline) {
          cur.hasExamples = true;
          inExamples = true;
        }
        continue;
      }
      if (inExamples && t.startsWith("|")) {
        if (cur.exHeaderSeen) cur.exampleRows++;
        else cur.exHeaderSeen = true;
        continue;
      }
      if ((m = t.match(GH_STEP))) {
        if (cur) cur.steps.push({ kw: GH_STEP_KW.get(m[1]) || "*", text: m[2] });
        inExamples = false;
        continue;
      }
    }
    return { background, scenarios };
  }
  // normalize a step's text for duplicate-detection: outline placeholders and literal strings are the
  // "data" of a step, so two steps that only differ in those are the same step for this purpose.
  const normStep = (s) =>
    s
      .replace(/<[^>]+>/g, "<VAR>")
      .replace(/["'][^"']*["']/g, '"…"')
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

  function gherkinChecks(ev) {
    const out = [];
    // one .feature file per name — its last version, same reasoning as lint.js's run(): a file edited
    // several times would otherwise repeat the same findings once per edit.
    const byName = new Map();
    for (const e of ev) {
      if (!e.new_content || !e.file || !/\.feature$/i.test(e.file)) continue;
      byName.set(e.file, { seq: e.seq, file: e.file, code: e.new_content });
    }
    for (const { seq, file, code } of byName.values()) {
      const { background, scenarios } = parseFeature(code);
      for (const sc of scenarios) {
        if (sc.outline && (!sc.hasExamples || !sc.exampleRows))
          out.push(F("outline_no_examples", "high", seq, T("outline_no_examples_msg", { file, scenario: sc.name })));
        // a "*" step may stand for Then: without a Then, a scenario that has one cannot be judged
        if (!sc.steps.some((s) => s.kw === "Then" || s.kw === "*"))
          out.push(F("scenario_no_then", "high", seq, T("scenario_no_then_msg", { file, scenario: sc.name })));
      }
      if (background && background.steps.length > GHERKIN_BG_MAX_STEPS)
        out.push(F("bloated_background", "medium", seq, T("bloated_background_msg", { file, n: background.steps.length, max: GHERKIN_BG_MAX_STEPS })));
      // Near-duplicate scenarios: two or more with the exact same set of steps (order-independent).
      // Lower confidence than the other three — a hint that one might be a copy-paste of the other, or
      // that both should be a single Scenario Outline with two Examples rows instead.
      const bySig = new Map();
      for (const sc of scenarios) {
        if (sc.steps.length < 2) continue;
        const sig = [...new Set(sc.steps.map((s) => normStep(s.text)))].sort().join(" | ");
        if (!sig) continue;
        const arr = bySig.get(sig) || [];
        arr.push(sc.name);
        bySig.set(sig, arr);
      }
      for (const names of bySig.values()) {
        if (names.length > 1)
          out.push(F("duplicate_step_text", "low", seq, T("duplicate_step_text_msg", { file, scenarios: names.slice(0, 4).join(", "), n: names.length })));
      }
    }
    // its own source: these findings used to look like regex ones (no source at all), RULES-ARCHITECTURE §11.9
    return out.map((f) => Object.assign(f, { source: "gherkin" }));
  }
  /* Calibration verdict for one check and source from its reviewer stats {ok, fp}: with ≥10 verdicts, precision < 30%
     switches it off, < 50% demotes its findings to low. The one place this threshold lives: calibrate(), the Rules
     panel's "demoted" hint and the Calibration table all read it. ok and fp are read as counts (a number, or a string
     of digits); anything else, such as a hand-edited summary, is no record at all ("need"), not a good one. */
  const asCount = (x) => (typeof x === "number" ? x : typeof x === "string" && /^\s*\d+\s*$/.test(x) ? Number(x) : NaN);
  function calibLevel(st) {
    const ok = st ? asCount(st.ok) : 0,
      fp = st ? asCount(st.fp) : 0;
    if (!(ok >= 0 && fp >= 0 && Number.isFinite(ok + fp))) return { n: 0, p: null, level: "need" };
    const n = ok + fp;
    const p = n ? ok / n : null;
    const level = n >= 10 && p < 0.3 ? "off" : n >= 10 && p < 0.5 ? "demoted" : n < 10 ? "need" : "ok";
    return { n, p, level };
  }
  // The regex checks of the profile. They are not calibrated here: calibrate() does that for every source at once.
  // a skip pattern that is about retrying a failed test rather than not running it (`retries: 2`, @flaky, [Retry])
  const RETRY_RX = /retr|rerun|flaky/i;
  function runChecks(ev, cfg) {
    const out = [];
    for (const name of cfg.checks) if (checks[name]) out.push(...checks[name](ev, cfg));
    // source "formal": what the panel's filter and the exported reports already called a finding with no source
    return sortFindings(dedupe(out).map((f) => Object.assign(f, { source: "formal" })));
  }
  /* What calibration may hide or demote (phase 8, decided 01.10): the deterministic sources (regex "formal", the lint
     engines, Gherkin) and the two heuristic spec checks. Never no_spec and spec_uncovered (facts) or the model's ai_*
     (their precision depends on the model and the prompt; the Calibration tab only shows it). Never a check the
     registry marks calibrate: false (hardcoded_secret, decided 03.10). */
  const CALIBRATED_SPEC = new Set(["test_without_requirement", "out_of_scope_tested"]);
  function calibrated(f) {
    if ((C().CHECKS[f.check] || {}).calibrate === false) return false;
    const src = f.source || "formal";
    return src === "formal" || src === "lint" || src === "gherkin" || (src === "spec" && CALIBRATED_SPEC.has(f.check));
  }
  /* findings: every source, after LensLint.merge() and before LensRules.apply().
     calib: { check: { source: { ok, fp } } } (calibStatsBySource): stats per check AND source, so an engine's poor
     record never switches off the regex check of the same name, or the other way round.
     overrides: the Rules tab's; a check ticked on there by hand (enabled: true) is never hidden.
     → { findings: shown (a demoted one is low), hidden: an "off" check's (kept with the session as calibHidden and
         counted by sessionSummary(), never shown: not running it lost their verdicts, test/calibration-loop.test.js),
         suppressed: [{ check, source, precision, n }], one per check and source that hid something here } */
  function calibrate(findings, calib, overrides) {
    const shown = [],
      hidden = [],
      off = new Map();
    for (const f of findings) {
      if (!calibrated(f)) {
        shown.push(f);
        continue;
      }
      const src = f.source || "formal";
      const cl = calibLevel(calib && calib[f.check] && calib[f.check][src]);
      if (cl.level === "off" && ((overrides || {})[f.check] || {}).enabled !== true) {
        hidden.push(f);
        off.set(f.check + "|" + src, { check: f.check, source: src, precision: cl.p, n: cl.n });
      } else if (cl.level === "demoted") shown.push({ ...f, severity: "low", demoted: true });
      else shown.push(f);
    }
    return { findings: shown, hidden, suppressed: [...off.values()] };
  }
  function dedupe(out) {
    // the same file is scanned again after every edit, so an unchanged issue would be reported once per edit
    const seen = new Set();
    return out.filter((f) => {
      const k = `${f.check}|${f.message}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  function sortFindings(out) {
    const o = { high: 0, medium: 1, low: 2 };
    const pri = (f) => (C().CHECKS[f.check] || {}).sortPriority || 0;
    return out.sort((a, b) => pri(a) - pri(b) || o[a.severity] - o[b.severity] || a.seq - b.seq);
  }
  // cfg: the session's profile (its source folders for shellReads); a shell command that only reads counts (0.1.121)
  function metrics(ev, cfg) {
    const reads = ev.filter((e) => ["read", "search"].includes(e.kind) || shellReads(e, cfg || {})).length,
      edits = ev.filter((e) => ["edit", "write"].includes(e.kind)).length;
    const runs = ev.filter((e) => e.kind === "run_tests" && e.tests);
    const green = runs.find((r) => !(r.tests.failed || r.tests.errors));
    const editsToGreen = green ? ev.filter((e) => ["edit", "write"].includes(e.kind) && e.seq < green.seq).length : null;
    return {
      reads,
      edits,
      readEdit: edits ? +(reads / edits).toFixed(1) : null,
      runs: runs.length,
      editsToGreen,
      firstGreenRun: green ? runs.indexOf(green) + 1 : null,
    };
  }
  function verdict(findings) {
    const s = new Set(findings.map((f) => f.severity));
    return s.has("high") ? "red" : s.has("medium") ? "yellow" : "green";
  }

  /* check name → i18n key of its rule text, from the registry (media/checks.js). */
  const RULE_KEYS = Object.fromEntries(Object.entries(C().CHECKS).map(([c, v]) => [c, v.ruleKey]));
  const RULES = new Proxy(
    {},
    {
      get: (_, k) => {
        if (RULE_KEYS[/** @type {string} */ (k)]) return T(RULE_KEYS[/** @type {string} */ (k)]);
        if (typeof k === "string") C().warnUnknown(k, "Lens.RULES");
        return "";
      },
    },
  );

  /* ---------- storage summaries (phase 4) ----------
     Shared by the host (store.js, the Sessions tree) and the page (calibration, rules): what the page needs about a
     session without loading its events. The host computes it from the stored session itself, never from a message. */
  // the key a verdict is stored under
  const fkey = (f) => `${f.check}@${f.seq}@${String(f.message || "").slice(0, 40)}`;
  // one line of the code a finding points at, for the rule text and the evidence list
  function snippet(f) {
    const ev = f.evidence || (f.code ? (f.code.split("\n").find((l) => l.includes("▸")) || "").replace(/^\s*\d+\s*▸\s?/, "") : "");
    return (ev || f.message).replace(/\s+/g, " ").trim().slice(0, 140);
  }
  // Which inputs of analyze() a session's findings were computed with, as 8 hex characters (FNV-1a 32 over JSON
  // with sorted keys): the rule overrides, the ESLint switch, analysisEpoch (bumped where the calibration changed
  // wholesale: verdict import), and since 0.1.116 the version of the analysis. Until then an update left every
  // stored session with the findings of the version that analyzed it: no new check showed up in it until a Rules
  // edit. The version is package.json's (test/reanalyze-after-update.test.js keeps the two equal).
  const ANALYSIS_VERSION = "0.1.124";
  function canon(v) {
    if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
    if (v && typeof v === "object")
      return (
        "{" +
        Object.keys(v)
          .sort()
          .filter((k) => v[k] !== undefined)
          .map((k) => JSON.stringify(k) + ":" + canon(v[k]))
          .join(",") +
        "}"
      );
    return JSON.stringify(v === undefined ? null : v);
  }
  function analysisGen(o) {
    const src = canon({ r: (o && o.ruleOverrides) || {}, l: !(o && o.lint === false), e: (o && o.epoch) || 0, v: ANALYSIS_VERSION });
    let h = 0x811c9dc5;
    for (let i = 0; i < src.length; i++) {
      h ^= src.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ("0000000" + h.toString(16)).slice(-8);
  }
  /* A verdict is stored under fkey: check, step and the first 40 characters of the message. When a new version words a
     finding differently (0.1.113: "skip / xfail / retry added" became "skip / retry added"), the analysis after the
     update makes a finding with a new key, and the verdict would no longer count. carryVerdicts() moves such a verdict
     to the finding of the same check and step, if there is exactly one without a verdict of its own; a finding that is
     really gone keeps nothing. Runs after every analysis, over the findings shown and hidden. → how many moved */
  function carryVerdicts(s) {
    const verdicts = s && s.verdicts;
    if (!verdicts || typeof verdicts !== "object") return 0;
    const all = [...(Array.isArray(s.findings) ? s.findings : []), ...(Array.isArray(s.calibHidden) ? s.calibHidden : [])];
    const now = new Set(all.map(fkey));
    let moved = 0;
    for (const k of Object.keys(verdicts)) {
      if (now.has(k)) continue;
      const [check, seq] = k.split("@");
      const free = all.filter((f) => f.check === check && String(f.seq) === seq && !verdicts[fkey(f)]);
      if (free.length !== 1) continue;
      const nk = fkey(free[0]);
      verdicts[nk] = verdicts[k];
      delete verdicts[k];
      now.add(nk);
      moved++;
    }
    return moved;
  }
  /* When the agent ran: the time of the session's first step that has one, as an ISO string; "" when the transcript
     has no times (a claude.ai export). created is when the session was imported, which can be much later. */
  function sessionStarted(events) {
    for (const e of Array.isArray(events) ? events : []) {
      const t = e && typeof e.ts === "string" && e.ts ? Date.parse(e.ts) : NaN;
      if (!isNaN(t)) return new Date(t).toISOString();
    }
    return "";
  }
  /* → { id, name, task, profile, created, started, reviewed, specN, verdict, findingsCount, hiddenCount, verdictsCount,
         openCount, agent, project, checkStats: { check: { total, ok, fp } }, sourceStats: { check: { source: { total, ok, fp } } },
         confirmed: [{ key, check, seq, message, snippet, note }] }
     checkStats is calibStats() of this one session, over the findings shown and the ones an "off" check hides
     (calibHidden); sourceStats is the same split by the finding's source ("formal" when it has none: a regex
     finding of a session analyzed before 0.1.112), so an engine's bad record never counts against a regex check of
     the same name (phase 8); confirmed are the findings shown with an "ok" verdict, in finding order; started is
     sessionStarted() (0.1.116), what a rule's effect compares with the day the rule was moved; hiddenCount is how
     many findings calibration hides (calibHidden, 0.1.116), so the Sessions tree can say a green session has some.
     Schema 4 (0.1.124) adds agent and project (transcriptOrigin(): stored on the session at import; a session imported
     before has neither and gets them from its kept text, or "" without one) and openCount, the findings shown that
     have no verdict yet. verdictsCount is no use for that: it also counts verdicts on findings that are gone. */
  /* A text cut to at most n characters at a word break, ending in "…" (0.1.121: a confirmed finding's message was cut
     at exactly 90 characters, mid-word, so the evidence on the Calibration tab read ".getByRole() o"). A text that
     fits stays as it is; a word longer than half of n is cut where it is. */
  function clip(text, n) {
    const t = String(text || "");
    if (t.length <= n) return t;
    const cut = t.slice(0, n - 1),
      sp = cut.lastIndexOf(" ");
    return (sp > n / 2 ? cut.slice(0, sp) : cut).replace(/[\s,;:.·/—–-]+$/, "") + "…";
  }
  function sessionSummary(s) {
    const findings = Array.isArray(s.findings) ? s.findings : [],
      verdicts = s.verdicts && typeof s.verdicts === "object" ? s.verdicts : {};
    const checkStats = {},
      sourceStats = {},
      confirmed = [];
    let open = 0;
    const count = (f, vd) => {
      const per = (sourceStats[f.check] = sourceStats[f.check] || {}),
        src = f.source || "formal";
      for (const x of [(checkStats[f.check] = checkStats[f.check] || { total: 0, ok: 0, fp: 0 }), (per[src] = per[src] || { total: 0, ok: 0, fp: 0 })]) {
        x.total++;
        if (vd && (vd.v === "ok" || vd.v === "fp")) x[vd.v]++;
      }
    };
    for (const f of findings) {
      const k = fkey(f),
        vd = verdicts[k];
      count(f, vd);
      if (!vd) open++;
      if (vd && vd.v === "ok")
        confirmed.push({ key: k, check: f.check, seq: f.seq, message: clip(f.message, 90), snippet: snippet(f), note: String(vd.note || "") });
    }
    for (const f of Array.isArray(s.calibHidden) ? s.calibHidden : []) count(f, verdicts[fkey(f)]);
    const origin = AGENTS.includes(s.agent)
      ? { agent: s.agent, project: cleanProject(s.project) }
      : transcriptOrigin(s.source_text, { cursorProject: s.source_project });
    return {
      id: s.id,
      name: s.name || "",
      task: s.task || "",
      profile: s.profile || "",
      created: s.created || "",
      started: sessionStarted(s.events),
      reviewed: !!s.reviewed,
      nameSet: !!s.nameSet,
      specN: (s.specParsed && s.specParsed.n) || 0,
      verdict: verdict(findings),
      findingsCount: findings.length,
      hiddenCount: Array.isArray(s.calibHidden) ? s.calibHidden.length : 0,
      verdictsCount: Object.keys(verdicts).length,
      openCount: open,
      agent: origin.agent,
      project: origin.project,
      checkStats,
      sourceStats,
      confirmed,
    };
  }

  /* Phase 6: what a session is called everywhere (tab title, Sessions tree, Open session…, the panel's list and header).
     A name the person gave it with Rename (nameSet) wins over the task id found in the transcript; otherwise the task
     id, as before. Works on a session and on its summary (meta). otherName(): the second line / tooltip. */
  function displayName(s) {
    if (!s) return "";
    return (s.nameSet && s.name) || s.task || s.name || s.id || "";
  }
  function otherName(s) {
    if (!s) return "";
    const d = displayName(s);
    return d === s.name ? s.task || s.name || "" : s.name || "";
  }

  /* Phase 7 (7A.4): what a profile checks, for the details under the Profile list. Nothing here is written by hand:
     every fact comes from the structures that decide the behaviour — the profile (this file), the check registry
     (checks.js), the engines and their rule maps (lint.js), the specification extractors (spec.js), the Rules
     overrides and the settings. The dependencies are passed in because lint.js and spec.js load after this file and
     the host loads this file with require(). Returns data only (no HTML, no translated text).
     deps: { checks: LensChecks, lint: LensLint, spec: LensSpec, overrides, settings, verdicts } */
  const VALIDATED_PROFILES = ["qa-ts", "qa-python", "qa-generic"];
  const UNVERIFIED_MIN = 5;
  // file types probed for a profile that declares none (qa-generic reads any file)
  const PROBE_EXT = [".ts", ".js", ".py", ".java", ".kt", ".cs", ".go", ".feature", ".robot"];
  function isValidated(name, verdicts) {
    return VALIDATED_PROFILES.includes(name) || (verdicts || 0) >= UNVERIFIED_MIN;
  }
  function profileInfo(name, deps) {
    const d = deps || {},
      cfg = profile(name),
      lang = cfg.language,
      C = d.checks,
      L = d.lint,
      S = d.spec;
    const overrides = d.overrides || {},
      settings = d.settings || {};
    const regex = new Set((cfg.checks || []).filter((k) => !C || C.CHECKS[k]));
    const map = (L && L.RULE_MAPS && L.RULE_MAPS[lang]) || {};
    const lint = new Set(
      Object.values(map)
        .map((v) => (Array.isArray(v) ? v[0] : v))
        .filter((k) => !C || C.CHECKS[k]),
    );
    const gherkin = C ? Object.keys(C.CHECKS).filter((k) => C.CHECKS[k].sources.includes("gherkin")) : [];
    const all = new Set([...regex, ...lint, ...gherkin]);
    const order = C ? Object.keys(C.CHECKS) : [...all];
    const groups = (C ? C.GROUPS_ORDER : ["checks"])
      .map((g) => ({
        group: g,
        checks: order
          .filter((k) => all.has(k) && (!C || C.CHECKS[k].group === g))
          .map((k) => ({
            name: k,
            off: (overrides[k] || {}).enabled === false,
            engineOnly: lint.has(k) && !regex.has(k) && !gherkin.includes(k),
          })),
      }))
      .filter((g) => g.checks.length);
    const files = L && L.ENGINE_FILES ? L.ENGINE_FILES[lang] : null;
    const kind = files
      ? files.boot
        ? "tree-sitter"
        : lang === "cypress"
          ? "eslint-cypress"
          : lang === "detox"
            ? "eslint-detox"
            : "eslint"
      : lint.size
        ? "robot-parser"
        : "none";
    const engine = { kind, state: kind === "none" ? "none" : settings.lint === false ? "off" : "on" };
    const exts = (cfg.code_ext && cfg.code_ext.length ? cfg.code_ext : PROBE_EXT).filter((e) => !/\.(?:postman_\w+\.)?json$/.test(e));
    const spec = S
      ? {
          read: exts.filter((e) => S.supports(lang, "file" + e)),
          notRead: exts.filter((e) => !S.supports(lang, "file" + e)),
          anyFile: !(cfg.code_ext && cfg.code_ext.length),
        }
      : null;
    return {
      profile: cfg.profile,
      language: lang,
      codeExt: cfg.code_ext || [],
      runners: cfg.test_runner_patterns || [],
      groups,
      count: all.size,
      engine,
      spec,
      asserts: !!(cfg.test_fn_pattern && (cfg.assert_line_patterns || []).length),
      gherkin: gherkin.length > 0,
      calibration: {
        validated: isValidated(cfg.profile, d.verdicts),
        builtIn: VALIDATED_PROFILES.includes(cfg.profile),
        verdicts: d.verdicts || 0,
        min: UNVERIFIED_MIN,
      },
    };
  }

  return {
    profile,
    PROFILES: VISIBLE,
    ALIAS,
    redactSecrets,
    importAny,
    transcriptOrigin,
    AGENTS,
    isCursorJsonl,
    cursorProjectSlug,
    isCursorStreamJson,
    unreadToolCalls,
    IMPORT_GEN,
    needsReimport,
    transcriptMatch,
    pickConversation,
    runChecks,
    calibrate,
    isCalibrated: (check, source) => calibrated({ check, source }),
    gherkinChecks,
    sortFindings,
    metrics,
    verdict,
    phases,
    taskId,
    guessTask,
    RULES,
    calibLevel,
    parseTests,
    compareAsserts,
    blocksByTest,
    fkey,
    carryVerdicts,
    snippet,
    analysisGen,
    ANALYSIS_VERSION,
    displayName,
    otherName,
    sessionSummary,
    profileInfo,
    isValidated,
    VALIDATED_PROFILES,
    UNVERIFIED_MIN,
  };
});
