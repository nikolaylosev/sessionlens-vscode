"use strict";
/* Synthetic sessions for the phase 4 measurements and tests. Deterministic (seeded), stored in the 0.1.100 shape
   (globalState["sessions"]): a Claude Code transcript is generated and imported with Lens.importAny, and the findings
   are computed the way analyze() in app.js computes them with ESLint switched off (settings.lint = false), so a
   re-analysis in the panel gives the same findings. Verdicts: most findings of a session get one, mostly "ok", so
   that several checks have more than 10 verdicts (calibration is active) without crossing the 30 % / 50 % thresholds. */
const path = require("path");
const M = (f) => path.join(__dirname, "..", "media", f);

function rng(seed) {
  // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function load() {
  const I18N = require(M("i18n.js"));
  I18N.set("en");
  const Lens = require(M("lens.js"));
  const LensRules = require(M("rules.js"));
  const LensSpec = require(M("spec.js"));
  return { Lens, LensRules, LensSpec };
}

const PROFILES = ["qa-ts", "qa-ts", "qa-python", "qa-java", "qa-api"];
const FILES = {
  "qa-ts": (i) => [
    `e2e/feature${i}.spec.ts`,
    (t) =>
      `test('case ${t}', async ({ page }) => {\n  await page.goto('/p/${t}');\n  await page.waitForTimeout(${1000 + t});\n  expect(await page.title()).toBeTruthy();\n});\n`,
  ],
  "qa-api": (i) => [
    `api/resource${i}.spec.ts`,
    (t) =>
      `test('GET /items/${t}', async ({ request }) => {\n  const r = await request.get('/items/${t}');\n  expect(r.status()).toBe(200);\n  expect(await r.json()).toHaveProperty('id');\n});\n`,
  ],
  "qa-python": (i) => [
    `tests/test_feature${i}.py`,
    (t) => `def test_case_${t}(page):\n    page.goto("/p/${t}")\n    time.sleep(1)\n    assert page.title()\n\n`,
  ],
  "qa-java": (i) => [
    `src/test/java/Feature${i}Test.java`,
    (t) => `  @Test\n  void case${t}() throws Exception {\n    Thread.sleep(1000);\n    assertTrue(page.title() != null);\n  }\n`,
  ],
};

function transcript(profile, r, bytes) {
  const L = [];
  let n = 0;
  const push = (o) => L.push(JSON.stringify(o));
  const tool = (name, input, result) => {
    const id = "tu" + ++n;
    push({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
    push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: result }] } });
  };
  push({ type: "user", message: { role: "user", content: "Write automated tests for the checkout flow, then run them." } });
  push({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "I'll write the tests. I assume the staging data is already there. Tests pass." }] },
  });
  let size = 0,
    file = 0;
  while (size < bytes) {
    const [name, block] = FILES[profile](file++);
    const tests = 40 + Math.floor(r() * 40);
    let content = "";
    for (let t = 0; t < tests; t++) content += block(t);
    tool("Read", { file_path: name }, "(file not found)");
    tool("Write", { file_path: name, content }, "File written");
    tool(
      "Bash",
      { command: profile === "qa-python" ? "pytest -q" : profile === "qa-java" ? "mvn test" : "npx playwright test" },
      `${tests - 1} passed, 1 failed`,
    );
    push({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Probably a flaky test; retrying with a longer wait." }] } });
    size += content.length * 1.05 + 600;
  }
  push({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "All green, tests pass." }] } });
  return L.join("\n");
}

// analyze() of app.js with ESLint off, for one session
function analyzeNode(ctx, s, overrides, calib) {
  const { Lens, LensRules, LensSpec } = ctx;
  const cfg = Lens.profile(s.profile);
  const formal = Lens.runChecks(s.events, cfg);
  const gherkin = Lens.gherkinChecks(s.events);
  const spec = LensSpec.parse(s.spec || "");
  const sc = LensSpec.checks(spec, s.events, cfg.language);
  s.lintNote = "";
  const cal = Lens.calibrate([...formal, ...gherkin, ...sc.findings], calib, overrides);
  s.findings = Lens.sortFindings(LensRules.apply(cal.findings, overrides));
  s.coverage = sc.coverage;
  s.specParsed = { n: spec.requirements.length, oos: spec.outOfScope.length, hasIds: spec.requirements.some((r) => !r.auto) };
  s.suppressed = cal.suppressed;
  s.calibHidden = cal.hidden;
  s.metrics = Lens.metrics(s.events);
  s.task = s.task || Lens.taskId(s.events);
}

/* → { sessions: { id: session } (insertion order = import order), storage: the other globalState keys }
   n sessions of about `bytes` each (JSON). */
function makeFixture({ n = 20, bytes = 100 * 1024, seed = 1 } = {}) {
  const ctx = load();
  const r = rng(seed);
  const sessions = {};
  const t0 = Date.UTC(2026, 5, 1);
  for (let i = 0; i < n; i++) {
    const profile = PROFILES[i % PROFILES.length];
    const res = ctx.Lens.importAny(transcript(profile, r, bytes), ctx.Lens.profile(profile));
    const events = Array.isArray(res) && res.length && res[0].events ? res[0].events : res;
    const id = "fx" + String(i).padStart(4, "0") + Math.floor(r() * 1e6).toString(36);
    const s = {
      id,
      name: `session ${i}`,
      task: `TASK-${100 + i}`,
      profile,
      created: new Date(t0 + i * 3600e3).toISOString(),
      events,
      findings: [],
      verdicts: {},
      spec: "",
      dropped: [],
      source_text: "",
      seg: null,
    };
    analyzeNode(ctx, s, {}, {});
    s.findings.forEach((f, j) => {
      if (j % 5 === 4) return; // some stay undecided
      const v = r() < 0.8 ? "ok" : "fp";
      s.verdicts[ctx.Lens.fkey(f)] = { v, note: v === "ok" && j % 3 === 0 ? `note ${i}.${j}` : "", at: new Date(t0 + i * 3600e3 + j * 1000).toISOString() };
    });
    if (i % 7 === 3) s.reviewed = true;
    sessions[id] = s;
  }
  const storage = {
    settings: { profile: "qa-ts", lint: false, rulesTarget: "claude", modelPool: [], defaultModelId: null },
    ruleOverrides: {},
    rulesApplied: { sleep_or_skip_added: new Date(t0 + Math.floor(n / 2) * 3600e3).toISOString() },
    rulesDismissed: {},
    external: [],
    calibLog: [],
    compressResults: [],
    skillResults: [],
  };
  return { sessions, storage };
}

module.exports = { makeFixture, analyzeNode, rng };
