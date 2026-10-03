// @ts-check
/* Model-backed semantic review. Builds the prompt, calls the model (user's own key or subscription), parses a
   JSON array of findings in the same schema as lens.js checks. The HTTP request itself is made by the extension
   host, which holds the keys (see setTransport, providers.js); the page never calls a provider directly. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else /** @type {any} */ (root).LensAI = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const I = () => (typeof I18N !== "undefined" ? I18N : require("./i18n.js"));
  const T = (k, v) => I().t(k, v);
  const LANG_NAME = () => ({ en: "English", ru: "Russian" })[I().get()] || "English";
  /* 0.1.116: secrets are masked in everything sent to a model (Lens.redactSecrets, as in a skill's examples/). Each
     prompt is masked where it is built, so the request shown under "Debug model" and the materials the verifier
     checks quotes against are the text that was sent; callModel() masks again in case a prompt was missed. Masking
     twice changes nothing: "[REDACTED]" is a placeholder redactSecrets leaves alone. */
  const Ls = () => (typeof Lens !== "undefined" ? Lens : require("./lens.js"));
  const maskSecrets = (text) => Ls().redactSecrets(text).text;

  const SYSTEM_TPL = `You review automated tests written by an AI agent. You are given: a specification (may be absent),
the test code, and a compressed transcript of the agent's session. Regex checks have already found the formal issues
(sleep, skip, "passes" without a run, weakened assertions) — do NOT repeat them. Your job is meaning:

1. purpose — for each test: which requirement it really checks (by its assertions, not its name). If the assertions
   check something other than the name/docstring promises — a finding.
2. coverage — if there is a spec: requirements without a test, tests without a requirement. If there is no spec —
   one high finding: "no specification, impossible to tell which checks are requirements and which are the agent's guesses".
3. fragility — brittleness a regex cannot describe: exact string matches, dependence on content/marketing copy,
   external networks, DOM assumptions without verification, ordering, time.
4. missing — negative and boundary cases that follow from the code but were not written. Concrete, one each.
5. questions — questions the agent should have asked instead of assuming (quote the assumption).
6. fix_justification — for each edit after a failure (if visible in the transcript): is the reasoning convincing,
   or is the test being fitted to the server's answer.
7. spec_defect — defects of the specification itself visible from code or transcript: contradictions between
   requirements, an undefined reference point, a case the agent handled that the spec does not describe.

Write "message" and "evidence" in {LANG}. Reply ONLY with a JSON array, no prose, no markdown fences. Each item:
{"check":"ai_purpose|ai_coverage|ai_fragility|ai_missing|ai_questions|ai_fix_justification|ai_spec_defect",
 "severity":"high|medium|low","message":"one or two concrete sentences","evidence":"quote from code or transcript, up to 120 chars"}
At most 15 items. Do not invent: if something is not visible in the data — do not write it. If all is well — an empty array [].`;
  let OVERRIDES = {}; // set from the panel; empty means the built-in text
  const setPrompts = (o) => {
    OVERRIDES = o || {};
  };
  const pick = (key, built) => (OVERRIDES[key] && OVERRIDES[key].trim() ? OVERRIDES[key] : built);
  const SYSTEM = () => pick("review", SYSTEM_TPL).replace("{LANG}", LANG_NAME());

  function compact(events, maxChars) {
    const lines = events.map((e) => {
      if (e.kind === "message" || e.kind === "user") {
        const t = (e.text || "").replace(/```[\s\S]*?```/g, "[code]").replace(/\s+/g, " ");
        return `${e.seq} ${e.kind === "user" ? "USER" : "AGENT"}: ${t.slice(0, 400)}`;
      }
      let s = `${e.seq} ${e.kind} ${e.file || e.cmd || ""}`;
      if (e.tests)
        s += ` → ${e.tests.passed} passed, ${e.tests.failed} failed${e.tests.failed_names && e.tests.failed_names.length ? " (" + e.tests.failed_names.slice(0, 3).join(", ") + ")" : ""}`;
      if (e.assert_delta && (e.assert_delta.weakened.length || e.assert_delta.removed.length)) s += " ⚠ assertions changed";
      return s;
    });
    let out = lines.join("\n");
    if (out.length > maxChars) out = out.slice(0, maxChars) + "\n[transcript truncated]";
    return out;
  }

  function codeOf(events, maxChars) {
    const byFile = {};
    for (const e of events)
      if (e.new_content) {
        const k = e.file || "(code in message)";
        byFile[k] = e.new_content;
      } // last version wins
    let out = Object.entries(byFile)
      .map(([f, c]) => `### ${f}\n${c}`)
      .join("\n\n");
    let truncated = false;
    if (out.length > maxChars) {
      out = out.slice(0, maxChars) + "\n[code truncated]";
      truncated = true;
    }
    return { text: out || "(no code found in the session)", truncated };
  }

  /* A 14B model loses the seven-category instruction in a 12k-token prompt. For local providers the task is
     stated in one paragraph with one output shape, and the transcript is trimmed harder. */
  const LOCAL_FILE_SYSTEM = `You review ONE file of automated tests. Report only problems you can point at with a line
that is present in the file. For each problem give the exact line as "evidence" — copy it, do not paraphrase.

Look for exactly these:
- ai_purpose: the assertions do not check what the test name promises
- ai_fragility: brittle assertion — exact string or date, dependence on live content, an external site, a DOM guess
- ai_missing: an obvious negative or boundary case that is not tested
- ai_spec_defect: the test encodes a rule that contradicts the specification given below

Example of a good answer:
[{"check":"ai_fragility","severity":"medium","message":"The deadline date is hard-coded and will fail when the contest changes","evidence":"await expect(page.getByText(/Deadline October 14, 2026/)).toBeVisible();"}]
Example when nothing is found:
[]

Rules: reply with a JSON array and nothing else, at most 4 items, every item needs "evidence" copied from the file,
never summarise the file, never describe what the agent did, never apologise.`;

  const LOCAL_SYSTEM = `You review automated tests written by an AI agent. Report only problems you can point at in the
given code or transcript: a test whose assertions do not match its name, a requirement from the specification with no
test, a brittle assertion (exact strings, dates, external sites, DOM guesses), a missing negative or boundary case,
an assumption the agent made instead of asking, a fix that just made the test pass.
Do not repeat the formal findings listed below. Do not explain yourself. Do not apologise.
Reply with a JSON array and nothing else, at most 8 items:
[{"check":"ai_purpose","severity":"high","message":"one concrete sentence","evidence":"quote from the code"}]
Allowed check values: ai_purpose, ai_coverage, ai_fragility, ai_missing, ai_questions, ai_fix_justification, ai_spec_defect.
If you find nothing, reply exactly: []`;

  function buildPrompt(session, opts) {
    const local = !!(opts && opts.local);
    const o = Object.assign({ maxCode: local ? 12000 : 40000, maxTranscript: local ? 4000 : 12000 }, opts || {});
    const code = codeOf(session.events, o.maxCode);
    const parts = [
      `# Specification\n${session.spec && session.spec.trim() ? session.spec.trim() : "(not provided)"}`,
      `# Formal findings (already found, do not repeat)\n${
        session.findings
          .filter((f) => !f.check.startsWith("ai_"))
          .map((f) => `- ${f.check}: ${f.message}`)
          .join("\n") || "(none)"
      }`,
      `# Test code\n${code.text}`,
      `# Transcript (compressed)\n${compact(session.events, o.maxTranscript)}`,
    ];
    return { system: local ? LOCAL_SYSTEM : SYSTEM(), user: maskSecrets(parts.join("\n\n")), truncated: code.truncated };
  }

  /* Lenient extraction for JSON the model broke with raw quotes inside strings: split into {...} objects,
     then read each field up to the next known key or the closing brace. */
  const KEYS = ["check", "severity", "message", "evidence", "i", "keep", "why", "seq"];
  function lenientParse(t) {
    const objs = [];
    let depth = 0,
      start = -1;
    for (let k = 0; k < t.length; k++) {
      const c = t[k];
      if (c === "{") {
        if (depth === 0) start = k;
        depth++;
      } else if (c === "}") {
        depth--;
        if (depth === 0 && start >= 0) {
          objs.push(t.slice(start, k + 1));
          start = -1;
        }
      }
    }
    const keyRe = new RegExp(`"(${KEYS.join("|")})"\\s*:\\s*`, "g");
    const out = [];
    for (const o of objs) {
      // positions of every known key; each value runs from after the colon to just before the next key (or the closing brace)
      const pos = [];
      let m;
      keyRe.lastIndex = 0;
      while ((m = keyRe.exec(o))) pos.push({ key: m[1], valStart: m.index + m[0].length, keyStart: m.index });
      const item = {};
      pos.forEach((p, i) => {
        let raw = o.slice(p.valStart, i + 1 < pos.length ? pos[i + 1].keyStart : o.length - 1).trim();
        raw = raw.replace(/,\s*$/, "").trim();
        let v;
        if (/^"[\s\S]*"$/.test(raw)) v = raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, "\n");
        else if (raw === "true") v = true;
        else if (raw === "false") v = false;
        else if (/^-?\d+$/.test(raw)) v = +raw;
        else v = raw.replace(/^"|"$/g, "");
        item[p.key] = v;
      });
      if (item.message || item.i !== undefined) out.push(item);
    }
    return out;
  }
  const REFUSAL = /\b(?:i(?:'m| am)? ?sorry|i can(?:'t| ?not) (?:assist|help|comply|do that)|as an ai|unable to (?:help|assist|comply)|я не могу)\b/i;

  function parseArray(text, what) {
    let t = String(text || "")
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/, "");
    // a model that answers in prose or with a refusal object did not do the task — say so plainly
    if (REFUSAL.test(t.slice(0, 400))) throw Object.assign(new Error(T("err_refusal", { what, head: t.slice(0, 120).replace(/\s+/g, " ") })), { raw: text });
    const objOnly = t.startsWith("{") && t.indexOf("[") < 0;
    if (objOnly) {
      try {
        const o = JSON.parse(t);
        const inner = Object.values(o).find((v) => Array.isArray(v));
        if (inner) return inner;
      } catch {}
    }
    const start = t.indexOf("["),
      end = t.lastIndexOf("]");
    if (start < 0) throw Object.assign(new Error(T("err_no_array", { what, head: t.slice(0, 160).replace(/\s+/g, " ") })), { raw: text });
    const body = end > start ? t.slice(start, end + 1) : t.slice(start) + "]";
    let arr;
    try {
      arr = JSON.parse(body);
      if (!Array.isArray(arr) && arr && typeof arr === "object") {
        // some servers wrap the answer: {findings: [...]}, {items: [...]}, {result: [...]}
        const inner = Object.values(arr).find((v) => Array.isArray(v));
        arr = inner || null;
      }
    } catch (e) {
      arr = lenientParse(body);
      if (!arr.length) throw Object.assign(new Error(T("err_bad_json", { msg: e.message, what })), { raw: text });
      /** @type {any} */ (arr).repaired = e.message;
    }
    if (!arr) throw Object.assign(new Error(T("err_not_array")), { raw: text });
    return arr;
  }
  /* The review categories the prompt asks the model for; a finding outside them becomes ai_other. Each "ai_" + c
     and ai_other must exist in media/checks.js (test/rules-consistency.test.js). */
  const AI_CATEGORIES = ["purpose", "coverage", "fragility", "missing", "questions", "fix_justification", "spec_defect"];
  const SEVERITIES = () => (typeof LensChecks !== "undefined" ? LensChecks : require("./checks.js")).SEVERITIES;
  function parseFindings(text) {
    const arr = parseArray(text, T("what_review"));
    const norm2 = (x) =>
      String(x || "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    const out = arr
      .filter((x) => x && x.message)
      .map((x) => {
        const bare = String(x.check || "").replace(/^ai_/, "");
        return { ...x, check: AI_CATEGORIES.includes(bare) ? "ai_" + bare : "ai_other" };
      })
      .map((x) => ({
        check: x.check,
        severity: SEVERITIES().includes(x.severity) ? x.severity : "medium",
        seq: Number.isInteger(x.seq) ? x.seq : -1,
        message: String(x.message).slice(0, 400) + (x.evidence ? ` — «${String(x.evidence).slice(0, 120)}»` : ""),
        evidence: String(x.evidence || ""), // kept: the dedupe below and the verifier both need it
        source: "ai",
      }));
    // a model often reports the same line three times from three angles: keep the most severe one
    const rank = { high: 0, medium: 1, low: 2 },
      byEvidence = new Map(),
      merged = [];
    for (const f of out) {
      const key = norm2(f.evidence || "").slice(0, 80);
      if (!key) {
        merged.push(f);
        continue;
      }
      const prev = byEvidence.get(key);
      if (!prev) {
        byEvidence.set(key, f);
        merged.push(f);
        continue;
      }
      if (rank[f.severity] < rank[prev.severity]) {
        merged[merged.indexOf(prev)] = f;
        byEvidence.set(key, f);
      }
    }
    /** @type {any} */ (merged).repaired = /** @type {any} */ (arr).repaired;
    return merged;
  }

  /* Gemini wants uppercase type names; OpenAI-compatible servers want plain JSON Schema. One source, two shapes. */
  const toJsonSchema = (n) => {
    if (!n || typeof n !== "object") return n;
    const t = String(n.type || "").toLowerCase();
    const out = { ...n, type: t };
    if (t === "array" && n.items) out.items = toJsonSchema(n.items);
    if (t === "object" && n.properties) out.properties = Object.fromEntries(Object.entries(n.properties).map(([k, v]) => [k, toJsonSchema(v)]));
    return out;
  };

  const FINDING_SCHEMA = {
    type: "ARRAY",
    items: {
      type: "OBJECT",
      properties: {
        check: { type: "STRING" },
        severity: { type: "STRING" },
        message: { type: "STRING" },
        evidence: { type: "STRING" },
        i: { type: "INTEGER" },
        keep: { type: "BOOLEAN" },
        why: { type: "STRING" },
      },
      required: ["message"],
    },
  };
  const VERIFY_SCHEMA = {
    type: "ARRAY",
    items: {
      type: "OBJECT",
      properties: { i: { type: "INTEGER" }, keep: { type: "BOOLEAN" }, evidence: { type: "STRING" }, why: { type: "STRING" } },
      required: ["i", "keep"],
    },
  };

  async function callGoogle({ apiKey, model, system, user, maxTokens, schema }, fetchImpl) {
    const f = fetchImpl || fetch;
    const res = await f(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      // JSON mode + a generous output budget: thinking models spend output tokens on reasoning first
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: Object.assign(
          { maxOutputTokens: Math.max(maxTokens || 0, 16000), temperature: 0.2, responseMimeType: "application/json" },
          schema ? { responseSchema: schema } : {},
        ),
      }),
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const j = await res.json();
        msg += ": " + ((j.error && j.error.message) || JSON.stringify(j));
      } catch {}
      throw new Error(msg);
    }
    const data = await res.json();
    const cand = (data.candidates || [])[0];
    if (!cand || !cand.content)
      throw new Error(
        T("err_empty_reply") +
          (data.promptFeedback && data.promptFeedback.blockReason ? ": " + data.promptFeedback.blockReason : "") +
          (cand && cand.finishReason ? " (finishReason " + cand.finishReason + ")" : ""),
      );
    const text = (cand.content.parts || [])
      .filter((p) => !p.thought)
      .map((p) => p.text || "")
      .join("\n");
    if (!text.trim()) throw new Error(T("err_empty", { reason: cand.finishReason || "?" }));
    if (cand.finishReason === "MAX_TOKENS") throw new Error(T("err_max_tokens"));
    return text;
  }

  /* Any OpenAI-compatible server: Ollama (/v1), LM Studio, llama.cpp --server, vLLM. No key needed for a local
     one. Structured output is requested through response_format; servers that ignore it still work, because the
     lenient parser and the grounding check downstream do not trust the shape of the reply anyway. */
  async function callOpenAICompatible(opts, fetchImpl) {
    const { apiKey, model, system, user, maxTokens, schema, baseUrl, tokenParam, noTemperature, minTokens, jsonOnly } = opts;
    const jsonObject = opts.jsonObject || (!!schema && !!jsonOnly); // jsonOnly: the server has json_object but no json_schema
    const f = fetchImpl || fetch;
    const base = (baseUrl || "http://localhost:11434/v1").replace(/\/+$/, "");
    const headers = { "content-type": "application/json" };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const res = await f(`${base}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(
        Object.assign(
          {
            model,
            [tokenParam || "max_tokens"]: Math.max(maxTokens || 0, minTokens || 8000),
            stream: false,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            // a schema pins the reply to an array; servers that do not support json_schema fall back to json_object
            response_format:
              schema && !jsonOnly
                ? { type: "json_schema", json_schema: { name: "findings", strict: true, schema: toJsonSchema(schema) } }
                : jsonObject
                  ? { type: "json_object" }
                  : undefined,
          },
          noTemperature ? {} : { temperature: 0.2 },
        ),
      ),
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`,
        body = null;
      try {
        body = await res.json();
        msg += ": " + ((body.error && (body.error.message || body.error)) || JSON.stringify(body));
      } catch {}
      // older servers reject json_schema: retry once with the looser json_object mode
      if (schema && /response_format|json_schema|unsupported|invalid/i.test(msg))
        return callOpenAICompatible(Object.assign({}, opts, { schema: null, jsonObject: true }), fetchImpl);
      throw new Error(msg);
    }
    const data = await res.json();
    const choice = (data.choices || [])[0];
    const text = choice && choice.message && (choice.message.content || "");
    if (!text || !String(text).trim()) throw new Error(T("err_empty", { reason: (choice && choice.finish_reason) || "?" }));
    return String(text);
  }

  /* Claude or Codex through the user's own CLI, so a subscription works without an API key. The VS Code host
     runs `claude -p` or `codex exec -` (see cli.js); `fetchImpl` is where a test injects a fake host. Errors
     come back as {error: {code}} and are worded here, per CLI, in the interface language. */
  async function callCliProvider(kind, { model, system, user, cliPath }, hostImpl) {
    const host = hostImpl || (typeof window !== "undefined" && window[kind === "codex" ? "__slCodexRun" : "__slClaudeRun"]);
    const suf = kind === "codex" ? "_codex" : "";
    if (!host) throw new Error(T("cli_no_host" + suf));
    const r = await host({ model, system, user, cliPath, timeoutMs: 300000 });
    if (r && r.error) {
      const e = r.error,
        msg = String(e.message || "").replace(/rate.?limit/gi, "limit"); // keep the generic 429 retry loop out of a plan limit
      throw Object.assign(
        new Error(
          T("cli_err_" + e.code + suf, { msg, model: model || "", cmd: e.message || cliPath || (kind === "codex" ? "codex" : "claude"), s: e.message }),
        ),
        { cliCode: e.code },
      );
    }
    if (!r || typeof r.text !== "string" || !r.text.trim()) throw new Error(T("cli_err_failed" + suf, { msg: "empty answer" }));
    return r.text;
  }
  const callClaudeCli = (a, f) => callCliProvider("claude", a, f);
  const callCodexCli = (a, f) => callCliProvider("codex", a, f);

  const PROVIDERS = {
    anthropic: { label: "Anthropic (Claude)", defaultModel: "claude-sonnet-5", call: (a, f) => callAnthropic(a, f), keyHint: "sk-ant-…" },
    claudecli: {
      label: "Claude Code (subscription)",
      defaultModel: "sonnet",
      keyHint: "",
      noKey: true,
      noGap: true,
      cli: true,
      cliKind: "claude",
      call: (a, f) => callClaudeCli(a, f),
    },
    codexcli: {
      label: "Codex (subscription)",
      defaultModel: "",
      keyHint: "",
      noKey: true,
      noGap: true,
      cli: true,
      cliKind: "codex",
      call: (a, f) => callCodexCli(a, f),
    },
    google: { label: "Google (Gemini)", defaultModel: "gemini-3.1-flash-lite", call: (a, f) => callGoogle(a, f), keyHint: "AIza…" },
    // GPT-5-class models on the OpenAI API reject max_tokens (they want max_completion_tokens) and any temperature
    // other than the default; reasoning tokens count against the cap, so the floor is higher than for plain models.
    openai: {
      label: "OpenAI (GPT)",
      defaultModel: "gpt-5.4",
      keyHint: "sk-…",
      defaultBaseUrl: "https://api.openai.com/v1",
      call: (a, f) => callOpenAICompatible(Object.assign({ tokenParam: "max_completion_tokens", noTemperature: true, minTokens: 16000 }, a), f),
    },
    xai: {
      label: "xAI (Grok)",
      defaultModel: "grok-4.3",
      keyHint: "xai-…",
      defaultBaseUrl: "https://api.x.ai/v1",
      call: (a, f) => callOpenAICompatible(Object.assign({ noTemperature: true, minTokens: 16000 }, a), f),
    },
    // DeepSeek: thinking is on by default and ignores temperature; it has json_object but not json_schema.
    // Legacy names deepseek-chat / deepseek-reasoner were retired on 2026-07-24.
    deepseek: {
      label: "DeepSeek",
      defaultModel: "deepseek-flash",
      keyHint: "sk-…",
      defaultBaseUrl: "https://api.deepseek.com",
      call: (a, f) => callOpenAICompatible(Object.assign({ noTemperature: true, minTokens: 16000, jsonOnly: true }, a), f),
    },
    // Qwen via Alibaba Cloud Model Studio (DashScope), OpenAI-compatible mode. Keys and endpoints are per region,
    // so the address stays editable: intl (Singapore) by default, dashscope.aliyuncs.com for mainland China.
    qwen: {
      label: "Qwen (Alibaba Cloud)",
      defaultModel: "qwen3.8-max",
      keyHint: "sk-…",
      defaultBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      editableBase: true,
      call: (a, f) => callOpenAICompatible(Object.assign({ jsonOnly: true }, a), f),
    },
    local: {
      label: "Local (OpenAI-compatible, experimental)",
      defaultModel: "qwen2.5-coder:14b",
      call: (a, f) => callOpenAICompatible(a, f),
      keyHint: "not required",
      local: true,
      defaultBaseUrl: "http://localhost:11434/v1",
    },
  };
  /* Free tiers limit requests per minute, and chunked segmentation fires one request per message. Calls are
     therefore serialised with a minimum gap, and a 429 is waited out — Google says how long in its error, and
     when it does not, the gap is doubled up to a minute. A daily-quota 429 cannot be waited out, so it is
     reported as is. */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const RETRY_AFTER = /"?retry(?:Delay|-after)"?[^\d]{0,12}(\d+(?:\.\d+)?)\s*s?/i;
  const DAILY = /per day|daily limit|quota exceeded for quota metric[^\n]*per day|PerDay/i;
  let chain = Promise.resolve(),
    lastCall = 0;

  /* Which provider and model answer which kind of request. settings.routes = { segment, review, verify, compress, skill },
     each {provider, model}; a missing entry, or one without a provider, means the provider chosen at the top of
     Settings. Every public entry point below routes itself, so a caller just passes the settings it has. */
  const TASKS = ["segment", "review", "verify", "compress", "skill"];
  function settingsFor(settings, task) {
    const r = ((settings && settings.routes) || {})[task];
    if (!r || !r.provider || !PROVIDERS[r.provider]) return settings;
    const prov = r.provider,
      p = PROVIDERS[prov],
      same = prov === settings.provider;
    return Object.assign({}, settings, {
      provider: prov,
      apiKey: same ? settings.apiKey : (settings.keys || {})[prov] || "",
      model: r.model || (same ? settings.model : (settings.models || {})[prov]) || p.defaultModel,
      baseUrl: same ? settings.baseUrl : (settings.baseUrls || {})[prov] || p.defaultBaseUrl,
    });
  }
  // the label of the provider that would answer `task` but has no key, or "" when the request can go out
  function missingKey(settings, task) {
    const s = settingsFor(settings, task);
    const has = KEY_STATUS ? !!KEY_STATUS[s.provider] : !!s.apiKey;
    return !has && !keyless(s.provider) ? (PROVIDERS[s.provider] || {}).label || s.provider : "";
  }
  /* Keys live in the host's SecretStorage (see secrets.js) and never reach this page: the host reports which
     providers have one ({provider: boolean}) and performs the HTTP call itself (see providers.js). Without a key
     status (tests, and the host's own use of PROVIDERS[*].call) hasKey() reads settings.keys / settings.apiKey. */
  let KEY_STATUS = null,
    TRANSPORT = null;
  const setKeyStatus = (m) => {
    KEY_STATUS = m && typeof m === "object" && !m.error ? Object.assign({}, m) : null;
  };
  const getKeyStatus = () => (KEY_STATUS ? Object.assign({}, KEY_STATUS) : null);
  const setTransport = (fn) => {
    TRANSPORT = typeof fn === "function" ? fn : null;
  };
  // is there a key for `prov`: the host's word when there is a host, otherwise settings.keys / settings.apiKey
  function hasKey(settings, prov) {
    if (KEY_STATUS) return !!KEY_STATUS[prov];
    const st = settings || {};
    return !!((st.keys || {})[prov] || (prov === st.provider && st.apiKey));
  }
  // one request through the host; its error text is the provider's own ("HTTP 429: …"), so the retry loop below reads it as before
  async function viaTransport(name, a) {
    const r = await TRANSPORT({ provider: name, model: a.model, system: a.system, user: a.user, maxTokens: a.maxTokens, schema: a.schema, baseUrl: a.baseUrl });
    if (r && r.error) {
      const e = r.error;
      if (e.code === "no_key") throw Object.assign(new Error(T("err_no_key_for", { p: (PROVIDERS[name] || {}).label || name })), { code: e.code });
      throw Object.assign(new Error(String(e.message || e.code || "error")), e.code ? { code: e.code } : {});
    }
    if (!r || typeof r.text !== "string") throw new Error(T("err_empty", { reason: "?" }));
    return r.text;
  }
  // provider and model that will really answer (after routing), for the header of every logged request
  const used = (s) => ({
    provider: (s && s.provider) || "anthropic",
    model: (s && s.model) || (PROVIDERS[(s && s.provider) || "anthropic"] || {}).defaultModel || "",
  });
  /* "provider/model" of a request, kept on the model's findings (0.1.115): model on what the review found, verifier
     on what a verification kept or dropped. A CLI without a model of its own is "claude-cli/default". */
  const modelLabel = (s) => {
    const u = used(s);
    return `${u.provider}/${u.model || "default"}`;
  };
  // a provider that needs no API key: a local server, or the Claude Code CLI that is signed in by itself
  const keyless = (name) => {
    const p = PROVIDERS[name] || {};
    return !!(p.local || p.noKey);
  };
  function callModel(settings, args, fetchImpl) {
    const p = PROVIDERS[settings.provider || "anthropic"] || PROVIDERS.anthropic;
    const pname = PROVIDERS[settings.provider] ? settings.provider : "anthropic";
    const baseUrl = (settings.baseUrls || {})[settings.provider] || p.defaultBaseUrl;
    const gap = p.noGap ? 0 : Number.isFinite(settings.minGapMs) ? settings.minGapMs : p.local ? 0 : 6500; // 10 rpm with room; a CLI call already takes seconds
    const maxRetries = Number.isFinite(settings.maxRetries) ? settings.maxRetries : 4;
    const run = async () => {
      let wait = 0;
      for (let attempt = 0; ; attempt++) {
        const since = Date.now() - lastCall;
        if (gap && since < gap) await sleep(gap - since);
        if (wait) await sleep(wait);
        lastCall = Date.now();
        try {
          const a = Object.assign(
            {
              apiKey: settings.apiKey,
              model: settings.model || p.defaultModel,
              baseUrl,
              cliPath: (settings.cliPaths || {})[settings.provider] || (settings.provider === "claudecli" ? settings.cliPath : "") || "",
            },
            args,
            { user: maskSecrets(args.user) },
          );
          // an injected fetchImpl (tests) always wins; otherwise an HTTP provider goes through the host, never from here
          if (!p.cli && !fetchImpl) {
            if (!TRANSPORT) throw new Error("SessionLens: no host to send the request through");
            return await viaTransport(pname, a);
          }
          return await p.call(a, fetchImpl);
        } catch (e) {
          const msg = String((e && e.message) || e);
          const rateLimited = /\b429\b|rate limit|RESOURCE_EXHAUSTED/i.test(msg);
          if (!rateLimited || attempt >= maxRetries) throw e;
          if (DAILY.test(msg)) throw Object.assign(new Error(T("err_daily_quota", { msg: msg.slice(0, 160) })), { daily: true });
          const m = RETRY_AFTER.exec(msg);
          wait = m ? Math.min(60000, Math.ceil(parseFloat(m[1]) * 1000) + 500) : Math.min(60000, (wait || gap || 2000) * 2);
        }
      }
    };
    chain = chain.then(run, run); // one call at a time, whatever happened to the previous one
    return chain;
  }

  async function callAnthropic({ apiKey, model, system, user, maxTokens }, fetchImpl) {
    const f = fetchImpl || fetch;
    const res = await f("https://api.anthropic.com/v1/messages", {
      method: "POST",
      // only the host calls this (providers.js), and it is not a browser: no browser-access header
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: maxTokens || 3000, system, messages: [{ role: "user", content: user }] }),
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const j = await res.json();
        msg += ": " + ((j.error && j.error.message) || JSON.stringify(j));
      } catch {}
      throw new Error(msg);
    }
    const data = await res.json();
    return (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  }

  const VERIFY_TPL = `You are a verifier. You are given a list of review findings and the same materials (specification, code, transcript).
For EACH finding decide whether it is proven by a concrete line of code, spec or transcript. A finding is proven only if
you can quote, verbatim, the line that supports it. Findings like "possibly", "it would be good to", "usually recommended"
without a concrete line are not proven. Duplicates of the formal findings are not proven.
Write "why" in {LANG}. Reply ONLY with a JSON array: [{"i":<finding index>,"keep":true|false,"evidence":"verbatim line or empty","why":"brief"}]`;
  const VERIFY_SYSTEM = () => pick("verify", VERIFY_TPL).replace("{LANG}", LANG_NAME());

  /* Turns the "Rules for CLAUDE.md" markdown (proposed rule + bad examples + evidence, one section per check)
     into one short numbered policy with backticked bad/good examples — the shape of a hand-written style guide
     rather than a dump of session evidence. */
  const COMPRESS_TPL = `You compress a set of proposed rules for {TARGET} — each with a rule statement, one or two
confirmed bad examples pulled from real sessions, and sometimes a good example — into one short reference policy,
written in {LANG}, in exactly this shape:

# <short policy title, matching what the rules below are actually about>

<one sentence stating the governing principle>

## Rules
1. **<short label>:** <the directive as one imperative sentence, with \`code\` in backticks for anything literal>.
2. <one numbered rule per merged input rule — merge duplicates or near-duplicates into one, drop anything with no evidence>

## Examples
* ❌ \`<short bad snippet, close to the original evidence>\`
* ❌ \`<another short bad snippet, only if there is a second clearly different one>\`
* ✅ \`<short good snippet, from the rule's own good example when one was given>\`
* ✅ \`<another short good snippet, if useful>\`

Keep every numbered rule to one sentence. Keep every example to one line of code or one short phrase — never a
paragraph, never a full test. Reply ONLY with a JSON object: {"markdown":"<the whole policy above as one string,
with real newline characters>"}. No prose outside the JSON, no code fences around the JSON itself.`;
  const COMPRESS_SYSTEM = (target) =>
    pick("compress", COMPRESS_TPL)
      .replace("{LANG}", LANG_NAME())
      .replace("{TARGET}", target || "CLAUDE.md");
  const COMPRESS_SCHEMA = { type: "OBJECT", properties: { markdown: { type: "STRING" } }, required: ["markdown"] };

  /* Lenient like everything else here: a model that forgets the JSON envelope but still answers in the right
     shape is salvaged rather than rejected. */
  function parseCompress(text) {
    const t = String(text || "")
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/, "");
    try {
      const obj = JSON.parse(t);
      if (obj && typeof obj.markdown === "string" && obj.markdown.trim()) return obj.markdown.trim();
    } catch {}
    const m = /"markdown"\s*:\s*"([\s\S]*)"\s*\}\s*$/.exec(t);
    if (m) return m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').trim();
    if (!t.startsWith("{") && !t.startsWith("[")) return t; // looks like it just wrote the markdown directly
    throw new Error(T("err_not_array"));
  }

  async function compressRules(md, settings, fetchImpl, target) {
    settings = settingsFor(settings, "compress");
    const system = COMPRESS_SYSTEM(target);
    const reqText = `${T("req_compress", used(settings))}\n--- system ---\n${system}\n\n--- user ---\n${md}`;
    let text;
    try {
      text = await callModel(settings, { system, user: maskSecrets(md), maxTokens: 2500, schema: COMPRESS_SCHEMA }, fetchImpl);
    } catch (e) {
      e.raw = reqText + "\n\n" + T("resp") + "\n" + T("call_error", { msg: e.message });
      throw e;
    }
    const raw = reqText + "\n\n" + T("resp") + "\n" + text;
    let markdown;
    try {
      markdown = parseCompress(text);
    } catch (e) {
      e.raw = raw;
      throw e;
    }
    return { markdown, raw };
  }

  /* Turns the same "Rules for {TARGET}" markdown as compressRules into a full Agent Skill package in the
     house style used by e.g. an "autotest-writing" skill: SKILL.md with numbered Core rules (P-xx), a
     references/patterns.md and references/antipatterns.md pair cross-referenced by ID, and — only when the
     evidence actually supports it — a grep-based scripts/check_*.sh. It never writes an examples/ folder itself:
     the app assembles that from real files of the sessions (secrets masked) and the model only links to them. */
  const GENERATE_SKILL_TPL = `You turn a set of confirmed {TARGET} rules (each with a rule statement, one or two
real bad snippets pulled from actual sessions, and sometimes a known-good snippet) into an Agent Skill package,
written in {LANG}, in this exact shape — study it before writing anything:

- A short "skill_name" — lowercase, hyphenated, matching the domain of the rules (e.g. "playwright-test-review").
- "files", covering exactly these paths (skip a path only where its own rule below says to):
  1. "SKILL.md" — YAML frontmatter (\`name\` = skill_name, \`description\` = one pushy sentence naming the stack/
     domain and the concrete situations that should trigger this skill), then a short "## Workflow" (numbered,
     ends in "self-review against references/antipatterns.md"), then "## Core rules" — one bullet per rule, one
     sentence, each tagged \`(P-xx)\` matching its id in references/patterns.md, ordered highest-impact first,
     then "## When to read what" (patterns.md for "how do I", antipatterns.md for "reviewing/fixing"), then a
     concrete, checkable "## Done checklist".
  2. "references/patterns.md" — one \`## P-xx: <name>\` section per rule, same order as SKILL.md's Core rules:
     the good snippet as a fenced code block (use the rule's own good example verbatim when one was given),
     a **Why:** sentence stating the real consequence of skipping it, and only a real **Exception:** line if
     one is evidenced — never "Exception: none".
  3. "references/antipatterns.md" — one \`## AP-xx: <name>\` section per rule (numbered independently of the
     P-xx list): **Bad:** using the rule's own real bad snippet(s) as close to verbatim as given, **Good:**
     the fix (name the \`(P-xx)\` it matches instead of repeating the code when that's clearer), **Why:** the
     concrete failure mode.
  4. "scripts/check_<skill_name>.sh" — INCLUDE THIS FILE ONLY IF at least two of the rules' bad snippets share
     a plausible literal/regex signature (a specific banned call, literal, or import — not a judgment call).
     Shape: a bash script with one \`check "<description naming its AP-xx>" "<extended-regex>"\` line per
     mechanically-catchable antipattern, grep over \`--include\` patterns appropriate to the stack, and a final
     pass/fail summary — mirror the reference shape, adjusted to the stack at hand. If fewer than two rules
     qualify, OMIT this path entirely rather than forcing a weak script.
  Do NOT write any file under "examples/": sessionlens adds that folder itself, from real files of the sessions.
  When the input ends with an "## Example files" list, end every AP-xx section whose rule (check id) is listed there
  with a line "**Real example:** \`examples/<check>/<file>\`" naming those files exactly as listed. Never invent
  an example path and never write example code of your own.

Reply ONLY with a JSON object: {"skill_name": "...", "files": [{"path": "...", "content": "..."}, ...]}. No
prose outside the JSON, no code fences around the JSON itself. Each file's "content" is the complete file text
with real newline characters.`;
  const GENERATE_SKILL_SYSTEM = (target) =>
    pick("generate_skill", GENERATE_SKILL_TPL)
      .replace("{LANG}", LANG_NAME())
      .replace("{TARGET}", target || "CLAUDE.md");
  const GENERATE_SKILL_SCHEMA = {
    type: "OBJECT",
    properties: {
      skill_name: { type: "STRING" },
      files: { type: "ARRAY", items: { type: "OBJECT", properties: { path: { type: "STRING" }, content: { type: "STRING" } }, required: ["path", "content"] } },
    },
    required: ["skill_name", "files"],
  };

  function parseGeneratedSkill(text) {
    const t = String(text || "")
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/, "");
    const obj = JSON.parse(t); // let a genuinely malformed reply surface as a normal call error, same as elsewhere
    if (!obj || !Array.isArray(obj.files) || !obj.files.length) throw new Error(T("err_not_array"));
    const skill_name = (obj.skill_name && String(obj.skill_name).trim()) || "generated-skill";
    const files = obj.files.filter((f) => f && typeof f.path === "string" && typeof f.content === "string" && f.path.trim());
    if (!files.length) throw new Error(T("err_not_array"));
    return { skill_name, files };
  }

  async function generateSkill(md, settings, fetchImpl, target) {
    settings = settingsFor(settings, "skill");
    const system = GENERATE_SKILL_SYSTEM(target);
    const reqText = `${T("req_generate_skill", used(settings))}\n--- system ---\n${system}\n\n--- user ---\n${md}`;
    let text;
    try {
      text = await callModel(settings, { system, user: maskSecrets(md), maxTokens: 8000, schema: GENERATE_SKILL_SCHEMA }, fetchImpl);
    } catch (e) {
      e.raw = reqText + "\n\n" + T("resp") + "\n" + T("call_error", { msg: e.message });
      throw e;
    }
    const raw = reqText + "\n\n" + T("resp") + "\n" + text;
    let parsed;
    try {
      parsed = parseGeneratedSkill(text);
    } catch (e) {
      e.raw = raw;
      throw e;
    }
    return { skill_name: parsed.skill_name, files: parsed.files, raw };
  }

  const norm = (s) =>
    String(s || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

  /* Second pass: keep only findings the model can back with a line that really exists in the materials. */
  async function verify(session, findings, settings, fetchImpl) {
    if (!findings.length) return { kept: [], dropped: [], raw: "" };
    settings = settingsFor(settings, "verify");
    {
      const miss = missingKey(settings, "verify");
      if (miss) return { kept: findings, dropped: [], raw: "", error: T("verify_failed", { msg: T("err_no_key_for", { p: miss }) }) };
    }
    const p = buildPrompt(session, { maxCode: settings.maxCode, local: !!(PROVIDERS[settings.provider] || {}).local });
    const list = findings.map((f, i) => `${i}. [${f.check}] ${f.message}`).join("\n");
    // a per-file finding must be checkable against that file, even if the shared prompt was trimmed before it
    const cited = [...new Set(findings.map((f) => f.file).filter(Boolean))];
    const byFile = {};
    for (const e of session.events) if (e.new_content) byFile[e.file || "(code in message)"] = e.new_content;
    const extra = cited
      .filter((n) => byFile[n])
      .map((n) => `### ${n}\n${byFile[n].slice(0, 20000)}`)
      .join("\n\n");
    const user = maskSecrets(`# Findings\n${list}\n\n${p.user}${extra ? `\n\n# Cited files\n${extra}` : ""}`);
    const reqText = `${T("req_verify", used(settings))}\n--- system ---\n${VERIFY_SYSTEM()}\n\n--- user ---\n${user}`;
    let text;
    try {
      text = await callModel(settings, { system: VERIFY_SYSTEM(), user, maxTokens: 2500, schema: VERIFY_SCHEMA }, fetchImpl);
    } catch (e) {
      return {
        kept: findings,
        dropped: [],
        raw: reqText + "\n\n" + T("resp") + "\n" + T("call_error", { msg: e.message }),
        error: T("verify_failed", { msg: e.message }),
      };
    }
    const rawV = reqText + "\n\n" + T("resp") + "\n" + text;
    let arr = [];
    try {
      arr = parseArray(text, T("what_verify"));
    } catch {
      return { kept: findings, dropped: [], raw: rawV, error: T("verify_unparsed") };
    }
    const materials = norm(user);
    const isGrounded = (evidence) => {
      const ev = norm(evidence);
      if (ev.length < 12) return false;
      // models elide the middle of a quote: check the longest literal fragment instead of the whole string
      const parts = ev
        .split(/\.{3}|…/)
        .map((x) => x.trim())
        .filter((x) => x.length >= 12);
      const candidates = parts.length ? parts : [ev];
      return candidates.some((x) => materials.includes(x.slice(0, 80)));
    };
    const kept = [],
      dropped = [],
      verifier = modelLabel(settings);
    findings.forEach((f, i) => {
      const v = arr.find((x) => x && x.i === i);
      if (!v) {
        dropped.push({ ...f, why: T("no_verdict") });
        return;
      }
      const grounded = isGrounded(v.evidence || "");
      if (v.keep && grounded) {
        kept.push({ ...f, verified: true, evidence: v.evidence, verifier });
        return;
      }
      // a kept-but-ungrounded finding is dropped for that reason, not for the model's own rationale
      // "duplicate of a formal finding" is the verifier working as intended, not a defect worth reading
      const dup = !v.keep && /duplicate of (?:the )?formal finding|дубл/i.test(String(v.why || ""));
      dropped.push({ ...f, why: v.keep ? T("not_grounded") : v.why || T("not_proven"), model_why: v.why || "", duplicate: dup, verifier });
    });
    return { kept, dropped, raw: rawV };
  }

  /* A 14B model cannot review a whole session; given one file and one short list of things to look for, it can.
     Findings come back per file and are pooled, then verified as usual. */
  async function reviewChunked(session, settings, fetchImpl) {
    const byFile = {};
    for (const e of session.events) if (e.new_content) byFile[e.file || "(code in message)"] = e.new_content;
    const files = Object.entries(byFile).slice(0, 12);
    if (!files.length) return { findings: [], exchanges: [], files: 0 };
    const spec = session.spec && session.spec.trim() ? `# Specification\n${session.spec.trim()}\n\n` : "";
    const out = [],
      exchanges = [];
    for (const [name, code] of files) {
      const user = maskSecrets(`${spec}# File: ${name}\n${code.slice(0, settings.maxCode || 12000)}`);
      try {
        const raw = await callModel(settings, { system: pick("review_local", LOCAL_FILE_SYSTEM), user, maxTokens: 1500, schema: FINDING_SCHEMA }, fetchImpl);
        exchanges.push(`--- ${name} ---\n${raw}`);
        for (const f of parseFindings(raw)) {
          if (!f.message || f.message.length < 15) continue; // one-word noise
          out.push({ ...f, file: name });
        }
      } catch (e) {
        exchanges.push(`--- ${name}: ${e.message}`);
      }
    }
    return { findings: out, exchanges, files: files.length };
  }

  async function review(session, settings, fetchImpl) {
    const routed = settings; // verification is routed on its own, from the same settings
    settings = settingsFor(settings, "review");
    {
      const miss = missingKey(settings, "review");
      if (miss) throw new Error(T("err_no_key_for", { p: miss }));
    }
    const p = buildPrompt(session, { maxCode: settings.maxCode, local: !!(PROVIDERS[settings.provider] || {}).local });
    const reqText = `${T("req_review", used(settings))}\n--- system ---\n${p.system}\n\n--- user ---\n${p.user}`;
    if ((PROVIDERS[settings.provider] || {}).local) {
      const r = await reviewChunked(session, settings, fetchImpl);
      for (const f of r.findings) f.model = modelLabel(settings);
      const raw1 = `${T("req_review", used(settings))} (${T("review_per_file", { n: r.files })})\n--- system ---\n${pick("review_local", LOCAL_FILE_SYSTEM)}\n\n${T("resp")}\n${r.exchanges.join("\n\n")}`;
      if (settings.verify === false) return { findings: r.findings, dropped: [], raw: raw1, truncated: p.truncated };
      const v = await verify(session, r.findings, routed, fetchImpl);
      return { findings: v.kept, dropped: v.dropped, raw: raw1 + "\n\n\n" + v.raw, truncated: p.truncated, verifyError: v.error };
    }
    let text;
    try {
      text = await callModel(settings, { system: p.system, user: p.user, schema: FINDING_SCHEMA }, fetchImpl);
    } catch (e) {
      e.raw = reqText + "\n\n" + T("resp") + "\n" + T("call_error", { msg: e.message });
      throw e;
    }
    let candidates;
    try {
      candidates = parseFindings(text);
    } catch (e) {
      e.raw = reqText + "\n\n" + T("resp") + "\n" + text;
      throw e;
    }
    for (const f of candidates) f.model = modelLabel(settings);
    const raw1 = reqText + "\n\n" + T("resp") + "\n" + text;
    if (settings.verify === false)
      return { findings: candidates, dropped: [], raw: raw1, truncated: p.truncated, repaired: /** @type {any} */ (candidates).repaired };
    const v = await verify(session, candidates, routed, fetchImpl);
    return {
      findings: v.kept,
      dropped: v.dropped,
      raw: raw1 + "\n\n\n" + v.raw,
      truncated: p.truncated,
      verifyError: v.error,
      repaired: /** @type {any} */ (candidates).repaired,
    };
  }

  return {
    maskSecrets,
    keyless,
    used,
    modelLabel,
    settingsFor,
    missingKey,
    hasKey,
    setKeyStatus,
    getKeyStatus,
    setTransport,
    TASKS,
    callClaudeCli,
    callCodexCli,
    setPrompts,
    DEFAULTS: { review: SYSTEM_TPL, verify: VERIFY_TPL, review_local: LOCAL_FILE_SYSTEM, compress: COMPRESS_TPL, generate_skill: GENERATE_SKILL_TPL },
    buildPrompt,
    parseFindings,
    AI_CATEGORIES,
    parseArray,
    lenientParse,
    callAnthropic,
    callGoogle,
    callOpenAICompatible,
    callModel,
    PROVIDERS,
    review,
    verify,
    compressRules,
    generateSkill,
    SYSTEM: SYSTEM_TPL,
    VERIFY_SYSTEM: VERIFY_TPL,
  };
});
