// @ts-check
/* Check registry: the single source of truth for every check name the extension knows.
   A check name is the one key the whole Rules system hangs on (see RULES-ARCHITECTURE.md §1). Everything that used
   to repeat it by hand — GROUPS / DEFAULT_SEVERITY / GOOD in rules.js, RULE_KEYS in lens.js, the group list in
   app.js's Rules panel, the severity literals — is now derived from this file, and test/rules-consistency.test.js
   fails when a detector (regex F(...), a lint *_RULE_MAP, spec.js, the model's ai_* categories) emits a name that
   is missing here, or when an entry here has no detector left.

   Fields:
     group         id from GROUPS_ORDER — the section of the Rules panel
     severity      default severity, one of SEVERITIES (the user can override it in the panel)
     ruleKey       i18n key of the rule text. Keys are historical and irregular (r_peeked, r_sleep…) — never derive them.
     good          example of the right code for CLAUDE.md, or null
     sources       which tracks emit it: "regex" (lens.js checks), "lint" (a *_RULE_MAP in lint.js),
                   "gherkin" (Lens.gherkinChecks), "spec" (spec.js), "ai" (model review)
     sortPriority  optional; lower sorts first in the findings list, above severity. Default 0.

   Order matters: the Rules panel lists checks in key order within each group. Append new checks to the end of
   their group.

   Deliberately NOT in the registry: synthetic names made up by lint.js run() for an engine rule id that has no
   *_RULE_MAP entry — "lint_" + ruleId.split("/").pop(), e.g. "lint_valid-title". They exist only as a fallback.
   A name written explicitly into a *_RULE_MAP always belongs here, even if it starts with "lint_"
   (lint_valid_title is one).

   All seven ai_* review categories share the rule text r_ai on purpose: the model writes the actual rule in each
   finding's explanation, so a fixed per-category text would only restate the category name. ai_other (the model
   ignored the categories) has its own text. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else /** @type {any} */ (root).LensChecks = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const SEVERITIES = ["high", "medium", "low"];
  const GROUPS_ORDER = ["method", "process", "code", "api", "mobile", "gherkin", "robot", "spec", "ai"];

  const CHECKS = {
    // ---- method ----
    peeked_at_src_before_plan: {
      group: "method",
      severity: "high",
      ruleKey: "r_peeked",
      good: "read specs/<ID>.md, write the plan, wait for approval; ask when the spec is silent",
      sources: ["regex"],
    },
    stop_markers_missing: {
      group: "method",
      severity: "medium",
      ruleKey: "r_plan",
      good: "plan as a table → stop → after “ok” write the code",
      sources: ["regex"],
    },
    // ---- process ----
    pass_claim_without_run: {
      group: "process",
      severity: "high",
      ruleKey: "r_pass",
      good: "run the suite and paste the output, then say what it means",
      sources: ["regex"],
    },
    fix_after_fail_without_triage: {
      group: "process",
      severity: "high",
      ruleKey: "r_triage",
      good: "state three hypotheses — product bug / test bug / spec defect — and wait",
      sources: ["regex"],
    },
    tests_never_run: {
      group: "process",
      severity: "high",
      ruleKey: "r_never_run",
      good: "run the tests, or say plainly that they are a draft nobody has executed",
      sources: ["regex"],
      sortPriority: -1,
    },
    scope_creep: { group: "process", severity: "medium", ruleKey: "r_scope", good: "touch only the files listed in the approved plan", sources: ["regex"] },
    edit_churn: {
      group: "process",
      severity: "medium",
      ruleKey: "r_churn",
      good: "after the third edit of one file, stop and say what is unclear",
      sources: ["regex"],
    },
    assumption_instead_of_question: {
      group: "process",
      severity: "medium",
      ruleKey: "r_assume",
      good: "ask: “the spec does not define X — which behaviour is correct?”",
      sources: ["regex"],
    },
    user_frustration: {
      group: "process",
      severity: "medium",
      ruleKey: "r_frustration",
      good: "restate the task in your own words and wait for confirmation",
      sources: ["regex"],
    },
    product_code_edited: {
      group: "process",
      severity: "high",
      ruleKey: "r_product_edited",
      good: "report it and wait: “R3 fails — the total ignores the discount. Product bug?”",
      sources: ["regex"],
    },
    // ---- code ----
    assert_weakened: { group: "code", severity: "high", ruleKey: "r_weakened", good: "keep the assertion and triage the failure instead", sources: ["regex"] },
    weak_assert: {
      group: "code",
      severity: "high",
      ruleKey: "r_weak",
      good: "expect(r.status()).toBe(423) and expect(body.reason).toBe('too_many_attempts')",
      sources: ["regex", "lint"],
    },
    sleep_or_skip_added: {
      group: "code",
      severity: "high",
      ruleKey: "r_sleep",
      good: "await expect(locator).toBeVisible() — wait for a condition, not for a number",
      sources: ["regex", "lint"],
    },
    hardcoded_date: {
      group: "code",
      severity: "medium",
      ruleKey: "r_date",
      good: "expect(text).toMatch(/Deadline .+ \\d{4}/) or read the date from config",
      sources: ["regex"],
    },
    fragile_wait: {
      group: "code",
      severity: "medium",
      ruleKey: "r_wait",
      good: "await page.getByRole('button', { name: 'Pay' }).click(); await expect(page.getByRole('heading', { name: 'Paid' })).toBeVisible()",
      sources: ["regex", "lint"],
    },
    expected_failure: {
      group: "code",
      severity: "medium",
      ruleKey: "r_expected_failure",
      good: "file the bug, then keep the test red with a comment naming the ticket",
      sources: ["regex"],
    },
    magic_number: {
      group: "code",
      severity: "low",
      ruleKey: "r_magic",
      good: "const MAX_ATTEMPTS = 5; expect(attempts).toBe(MAX_ATTEMPTS)",
      sources: ["regex"],
    },
    assertion_roulette: { group: "code", severity: "low", ruleKey: "r_roulette", good: "expect(status, 'lockout status').toBe(423)", sources: ["regex"] },
    conditional_logic: {
      group: "code",
      severity: "low",
      ruleKey: "r_cond",
      good: "one test per path; use test.each / a loop over cases outside the test body",
      sources: ["regex", "lint"],
    },
    duplicate_assert: {
      group: "code",
      severity: "low",
      ruleKey: "r_dup",
      good: "assert once per fact; a second input deserves a second test",
      sources: ["regex"],
    },
    raw_locator: {
      group: "code",
      severity: "low",
      ruleKey: "r_raw_locator",
      good: "page.getByRole('link', { name: 'About us', exact: true })",
      sources: ["lint"],
    },
    positional_locator: {
      group: "code",
      severity: "low",
      ruleKey: "r_positional_locator",
      good: "page.getByRole('navigation').getByRole('link', { name: 'About us' })",
      sources: ["lint"],
    },
    no_assertion_after_action: {
      group: "code",
      severity: "high",
      ruleKey: "r_no_assertion_after_action",
      good: "await page.getByRole('button', { name: 'Pay' }).click(); await expect(page.getByText('Paid')).toBeVisible();",
      sources: ["lint"],
    },
    no_app_reset: {
      group: "code",
      severity: "medium",
      ruleKey: "r_no_app_reset",
      good: "beforeEach(async () => { await device.reloadReactNative(); });",
      sources: ["lint"],
    },
    unannotated_test_method: {
      group: "code",
      severity: "high",
      ruleKey: "r_unannotated_test_method",
      good: "@Test\npublic void shouldLogIn() { ... }",
      sources: ["lint"],
    },
    swallowed_exception: {
      group: "code",
      severity: "high",
      ruleKey: "r_swallowed_exception",
      good: 'catch (IOException e) { fail("unexpected: " + e.getMessage()); }',
      sources: ["lint"],
    },
    assert_args_reversed: {
      group: "code",
      severity: "medium",
      ruleKey: "r_assert_args_reversed",
      good: "assertEquals(200, actualStatus)  // expected first, actual second",
      sources: ["lint"],
    },
    lint_valid_title: {
      group: "code",
      severity: "low",
      ruleKey: "r_lint_valid_title",
      good: 'test("rejects a wrong password with an error banner", async ({ page }) => { ... })',
      sources: ["lint"],
    },
    focused_test: {
      group: "code",
      severity: "high",
      ruleKey: "r_focused",
      good: "test('total', async ({ page }) => { … }) — no .only, so the whole suite runs",
      sources: ["regex", "lint"],
    },
    debug_leftover: {
      group: "code",
      severity: "medium",
      ruleKey: "r_debug_leftover",
      good: "await expect(page.getByText('Total')).toBeVisible(); — no page.pause() or debugger left behind",
      sources: ["regex", "lint"],
    },
    cypress_async_test: {
      group: "code",
      severity: "medium",
      ruleKey: "r_cypress_async",
      good: "it('total', () => { cy.contains('Total').should('be.visible'); })",
      sources: ["lint"],
    },
    test_deleted: {
      group: "code",
      severity: "high",
      ruleKey: "r_test_deleted",
      good: "keep the failing test and triage it: product bug / test bug / spec defect",
      sources: ["regex"],
    },
    hardcoded_secret: { group: "code", severity: "high", ruleKey: "r_secret", good: "token = os.environ['API_TOKEN']", sources: ["regex"] },
    hardcoded_base_url: {
      group: "code",
      severity: "medium",
      ruleKey: "r_base_url",
      good: "BASE_URL = os.environ.get('BASE_URL', 'http://localhost:8080')",
      sources: ["regex"],
    },
    // ---- api ----
    status_only_assert: {
      group: "api",
      severity: "medium",
      ruleKey: "r_status_only",
      good: "assert r.status_code == 201 and r.json()['id'] == payload['id']",
      sources: ["regex"],
    },
    mocked_service: {
      group: "api",
      severity: "medium",
      ruleKey: "r_mocked",
      good: "call the real service (or a real test instance); mock only its downstream dependencies",
      sources: ["regex"],
    },
    no_negative_cases: {
      group: "api",
      severity: "medium",
      ruleKey: "r_no_negative",
      good: "add: no token → 401, wrong role → 403, unknown id → 404, invalid body → 422",
      sources: ["regex"],
    },
    test_data_no_cleanup: {
      group: "api",
      severity: "low",
      ruleKey: "r_no_cleanup",
      good: "yield the created resource from a fixture and DELETE it after the test",
      sources: ["regex"],
    },
    response_time_assert: {
      group: "api",
      severity: "low",
      ruleKey: "r_resp_time",
      good: "assert the behaviour; keep latency budgets in a separate performance test",
      sources: ["regex"],
    },
    // ---- mobile ----
    mobile_raw_locator: {
      group: "mobile",
      severity: "low",
      ruleKey: "r_mobile_raw_locator",
      good: "driver.findElement(AppiumBy.accessibilityId('submit-button'))",
      sources: ["regex"],
    },
    hardcoded_coordinates: {
      group: "mobile",
      severity: "medium",
      ruleKey: "r_hardcoded_coordinates",
      good: "el.tap() or driver.perform(pointerActions on the element's own bounds)",
      sources: ["regex"],
    },
    no_driver_teardown: {
      group: "mobile",
      severity: "medium",
      ruleKey: "r_no_driver_teardown",
      good: "@AfterEach void tearDown() { driver.quit(); }",
      sources: ["regex"],
    },
    // ---- gherkin ----
    outline_no_examples: {
      group: "gherkin",
      severity: "high",
      ruleKey: "r_outline_no_examples",
      good: "Scenario Outline: … \n  Examples:\n    | user | role |\n    | ann  | admin |",
      sources: ["gherkin"],
    },
    scenario_no_then: {
      group: "gherkin",
      severity: "high",
      ruleKey: "r_scenario_no_then",
      good: "Then the user sees the order confirmation page",
      sources: ["gherkin"],
    },
    bloated_background: {
      group: "gherkin",
      severity: "medium",
      ruleKey: "r_bloated_background",
      good: "Background:\n  Given the user is logged in\n  # split the rest into each scenario that actually needs it",
      sources: ["gherkin"],
    },
    duplicate_step_text: {
      group: "gherkin",
      severity: "low",
      ruleKey: "r_duplicate_step_text",
      good: "merge the two scenarios into one Scenario Outline with two rows in Examples",
      sources: ["lint", "gherkin"],
    },
    // ---- robot ----
    empty_test_case: {
      group: "robot",
      severity: "high",
      ruleKey: "r_empty_test_case",
      good: "Login With Valid Creds\n    Open Browser    ${URL}    chrome\n    Should Contain    ${title}    Welcome",
      sources: ["lint"],
    },
    // ---- spec ----
    no_spec: {
      group: "spec",
      severity: "high",
      ruleKey: "r_no_spec",
      good: "list the requirements as R1, R2 … and get them approved before writing tests",
      sources: ["spec"],
      sortPriority: -0.5,
    },
    spec_uncovered: {
      group: "spec",
      severity: "high",
      ruleKey: "r_uncovered",
      good: "every requirement gets a test whose docstring names its ID",
      sources: ["spec"],
    },
    test_without_requirement: {
      group: "spec",
      severity: "medium",
      ruleKey: "r_unlinked",
      good: "name the requirement in the test, or delete the test",
      sources: ["spec"],
    },
    out_of_scope_tested: { group: "spec", severity: "medium", ruleKey: "r_oos", good: "leave what the spec excludes to its own task", sources: ["spec"] },
    // ---- ai ----
    ai_purpose: { group: "ai", severity: "medium", ruleKey: "r_ai", good: null, sources: ["ai"] },
    ai_coverage: { group: "ai", severity: "medium", ruleKey: "r_ai", good: null, sources: ["ai"] },
    ai_fragility: { group: "ai", severity: "medium", ruleKey: "r_ai", good: null, sources: ["ai"] },
    ai_missing: { group: "ai", severity: "medium", ruleKey: "r_ai", good: null, sources: ["ai"] },
    ai_questions: { group: "ai", severity: "medium", ruleKey: "r_ai", good: null, sources: ["ai"] },
    ai_fix_justification: { group: "ai", severity: "medium", ruleKey: "r_ai", good: null, sources: ["ai"] },
    ai_spec_defect: { group: "ai", severity: "medium", ruleKey: "r_ai", good: null, sources: ["ai"] },
    ai_other: { group: "ai", severity: "medium", ruleKey: "r_ai_other", good: null, sources: ["ai"] },
  };

  const isSynthetic = (check) => /^lint_/.test(check) && !CHECKS[check];
  const warned = new Set();
  /* One console.warn per unknown name — a check that reached the UI without a registry entry. */
  function warnUnknown(check, where) {
    if (CHECKS[check] || isSynthetic(check) || warned.has(check)) return;
    warned.add(check);
    if (typeof console !== "undefined") console.warn(`[sessionlens] unknown check "${check}" in ${where} — add it to media/checks.js`);
  }

  return { CHECKS, SEVERITIES, GROUPS_ORDER, isSynthetic, warnUnknown };
});
