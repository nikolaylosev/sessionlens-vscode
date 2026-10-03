"use strict";
/* 0.1.116: secrets are masked in everything sent to a model: the review (whole and per file), the verification,
   segmentation (whole and per message), Compress rules.md and Generate skill. A finding quoting a masked line is
   still grounded for the verifier, which checks quotes against the text that was sent. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { M } = require("./helpers");

const I18N = require(M("i18n.js"));
I18N.set("en");
const LensAI = require(M("ai.js"));
const LensSeg = require(M("segment.js"));

const TOKEN = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
const AWS = "AKIA" + "ABCDEFGHIJKLMNOP";
const LINE = `  const auth = { headers: { Authorization: "token ${TOKEN}" } };`;
const session = () => ({
  spec: `Log in with the key ${AWS}.`,
  findings: [],
  events: [
    { seq: 1, kind: "user", text: `Use the token ${TOKEN} for the API.` },
    { seq: 2, kind: "write", file: "e2e/api.spec.ts", new_content: `test('api', async ({ request }) => {\n${LINE}\n  expect(1).toBe(1);\n});\n` },
    { seq: 3, kind: "message", text: `Done. I put ${TOKEN} in the test.` },
  ],
});
const settings = (extra) => Object.assign({ provider: "anthropic", model: "m", minGapMs: 0, maxRetries: 0 }, extra);

// every request the page would send, and what the model answers
function capture(answer) {
  const sent = [];
  LensAI.setKeyStatus({ anthropic: true, ollama: true });
  LensAI.setTransport(async (p) => {
    sent.push(p.user);
    return { text: answer(p) };
  });
  return sent;
}
function reset() {
  LensAI.setTransport(null);
  LensAI.setKeyStatus(null);
}
const clean = (sent) => {
  assert.ok(sent.length, "something was sent");
  for (const u of sent) {
    assert.ok(!u.includes(TOKEN) && !u.includes(AWS), "no secret in:\n" + u.slice(0, 300));
    assert.ok(u.includes("[REDACTED]"));
  }
};

test("the review and the verification send no secret; a quote of a masked line stays grounded", async () => {
  const quote = `Authorization: "token [REDACTED]"`;
  const sent = capture((p) =>
    p.user.startsWith("# Findings")
      ? JSON.stringify([{ i: 0, keep: true, evidence: quote }])
      : JSON.stringify([{ check: "fragility", severity: "high", seq: 2, message: "a token in the test", evidence: quote }]),
  );
  try {
    const r = await LensAI.review(session(), settings({ verify: true }));
    clean(sent);
    assert.equal(sent.length, 2, "review and verification");
    assert.deepEqual(
      r.findings.map((f) => [f.check, f.verified]),
      [["ai_fragility", true]],
    );
  } finally {
    reset();
  }
});

test("the per-file review of a local model sends no secret", async () => {
  const sent = capture(() => "[]");
  try {
    await LensAI.review(session(), settings({ provider: "ollama", baseUrls: { ollama: "http://localhost:11434/v1" } }));
    clean(sent);
  } finally {
    reset();
  }
});

test("segmentation, whole and per message, sends no secret", async () => {
  for (const segmentChunked of [false, true]) {
    const sent = capture(() => "[]");
    try {
      await LensSeg.segment(session(), settings({ segmentChunked }), LensAI.callModel, LensAI.parseArray).catch(() => {});
      clean(sent);
    } finally {
      reset();
    }
  }
});

test("Compress rules.md and Generate skill send no secret", async () => {
  const md = `## hardcoded_secret\n\n**Not like this**\n\`\`\`\n${LINE}\n\`\`\`\n`;
  const sent = capture(() => "{}");
  try {
    await LensAI.compressRules(md, settings()).catch(() => {});
    await LensAI.generateSkill(md, settings()).catch(() => {});
    clean(sent);
    assert.equal(sent.length, 2);
  } finally {
    reset();
  }
});

test("callModel() masks a prompt that was not masked where it was built; masking twice changes nothing", async () => {
  const sent = capture(() => "ok");
  try {
    await LensAI.callModel(settings(), { system: "s", user: `key ${TOKEN}` });
    assert.deepEqual(sent, ["key [REDACTED]"]);
    assert.equal(LensAI.maskSecrets(LensAI.maskSecrets(LINE)), LensAI.maskSecrets(LINE));
  } finally {
    reset();
  }
});
