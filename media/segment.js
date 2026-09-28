// @ts-check
/* Model-based session segmentation.
   The regex importer stays as the default and as the fallback; this module asks the model to label the
   boundaries of an already-imported session: which message parts are prose, spec, plan, or code, and which
   code blocks are versions of the same tests. The model returns only line ranges and labels — never text —
   so the result can be validated mechanically and rejected if it does not line up. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else /** @type {any} */ (root).LensSeg = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const T = (k, v) => (typeof I18N !== "undefined" ? I18N : require("./i18n.js")).t(k, v);
  const isLocal = (settings) => {
    const P = typeof LensAI !== "undefined" ? LensAI.PROVIDERS : typeof require === "function" ? require("./ai.js").PROVIDERS : {};
    return !!(P[settings.provider] || {}).local;
  };

  const SYSTEM = `You segment a transcript of an AI-agent session that writes automated tests.
You are given the session as numbered lines, grouped by event. Label the line ranges. Kinds:
- "prose": the agent's or user's explanation, commentary, plans in words
- "spec": requirements, acceptance criteria, Given/When/Then, a ticket description — text that states what MUST be true
- "plan": an enumerated plan of tests the agent is going to write (a list or table of test names)
- "code": test code or helper code
- "output": tool or test-runner output pasted into the message
For every "code" range also give: "tests" — the names of the tests defined in it, and "version_of" — the index
(1-based, within your own array) of an earlier code range that defines the SAME tests, or null if it is the first
version of them. A later, edited copy of the same tests is a version of the earlier one, even if the code is identical.

Reply ONLY with a JSON array, no prose, no markdown fences:
[{"from":<first line>,"to":<last line>,"kind":"prose|spec|plan|code|output","tests":["name"],"version_of":null}]
Rules: ranges must not overlap, must be in ascending order, must use line numbers that exist, and should cover every
non-empty line. Split a message into several ranges when it mixes kinds. Do not invent test names — copy them from the code.`;

  /* A 14B model cannot hold a thousand numbered lines at once. For a local provider — and for any very long
     session — the transcript is cut into one chunk per message: numbering restarts at 1, the model labels a few
     dozen lines, and the ranges are shifted back into session coordinates here. A chunk that fails is simply left
     to the regex parser instead of failing the whole segmentation. */
  const LOCAL_SYSTEM = `Label the parts of one message from a coding session. Line numbers are given at the start of each line.
Kinds: "prose" (explanation), "spec" (requirements, acceptance criteria, what MUST be true), "plan" (a list of tests
to be written), "code" (test or helper code), "output" (tool or test-runner output).
For a "code" range also list the test names defined in it.
Reply with a JSON array and nothing else:
[{"from":1,"to":5,"kind":"prose"},{"from":6,"to":20,"kind":"code","tests":["test name"]}]
Ranges must not overlap and must use line numbers that exist. If the whole message is one kind, reply with one range.`;

  const SCHEMA = {
    type: "ARRAY",
    items: {
      type: "OBJECT",
      properties: {
        from: { type: "INTEGER" },
        to: { type: "INTEGER" },
        kind: { type: "STRING" },
        tests: { type: "ARRAY", items: { type: "STRING" } },
        version_of: { type: "INTEGER", nullable: true },
      },
      required: ["from", "to", "kind"],
    },
  };
  const KINDS = ["prose", "spec", "plan", "code", "output"];

  /* Numbered view of the session: only message/user events carry free text worth segmenting. */
  function numbered(events) {
    const lines = [];
    const map = [];
    for (const e of events) {
      if (!["message", "user"].includes(e.kind)) continue;
      lines.push(`--- event seq ${e.seq} (${e.kind === "user" ? "USER" : "AGENT"}) ---`);
      map.push({ seq: e.seq, line: -1 });
      e.text.split("\n").forEach((l, i) => {
        lines.push(l);
        map.push({ seq: e.seq, line: i });
      });
    }
    return { text: lines.map((l, i) => `${i + 1}\t${l}`).join("\n"), map, total: lines.length };
  }

  function validate(arr, total) {
    if (!Array.isArray(arr) || !arr.length) throw new Error(T("seg_err_empty"));
    // a weak model often overshoots the last line; clamp instead of discarding the whole range
    const segs = arr
      .filter((s) => s && Number.isInteger(s.from) && Number.isInteger(s.to) && s.to >= s.from && s.from >= 1 && s.from <= total)
      .map((s) => ({
        from: s.from,
        to: Math.min(s.to, total),
        kind: KINDS.includes(s.kind) ? s.kind : "prose",
        tests: Array.isArray(s.tests) ? s.tests.filter((x) => typeof x === "string") : [],
        version_of: Number.isInteger(s.version_of) ? s.version_of : null,
      }))
      .sort((a, b) => a.from - b.from);
    if (!segs.length) throw new Error(T("seg_err_ranges"));
    for (let i = 1; i < segs.length; i++) if (segs[i].from <= segs[i - 1].to) segs[i].from = segs[i - 1].to + 1;
    const kept = segs.filter((s) => s.to >= s.from);
    const covered = kept.reduce((n, s) => n + (s.to - s.from + 1), 0);
    return { segments: kept, coverage: total ? covered / total : 0 };
  }

  /* Rewrite the events using the model's labels: code ranges become new_content (with code_versions chains),
     spec ranges are collected into session.spec_suggested, everything else stays as the message text. */
  function apply(events, segments, map) {
    const byEvent = {};
    const specParts = [];
    const planSeqs = [];
    const chain = {}; // segment index → list of code strings that are versions of each other
    const text = {}; // seq → array of its lines
    for (const e of events) if (["message", "user"].includes(e.kind)) text[e.seq] = e.text.split("\n");
    const slice = (s) => {
      const out = {};
      for (let i = s.from - 1; i < s.to; i++) {
        const m = map[i];
        if (!m || m.line < 0) continue;
        (out[m.seq] = out[m.seq] || []).push(text[m.seq][m.line]);
      }
      return out;
    };
    segments.forEach((s, idx) => {
      const parts = slice(s);
      for (const [seq, ls] of Object.entries(parts)) {
        const body = ls.join("\n");
        if (s.kind === "code") {
          const b = (byEvent[seq] = byEvent[seq] || { versions: [], tests: [] });
          b.versions.push(body);
          b.tests.push(...(s.tests || []));
          chain[idx] = body;
        } else if (s.kind === "spec") specParts.push(body);
        else if (s.kind === "plan") planSeqs.push(+seq);
      }
    });
    for (const e of events) {
      const b = byEvent[e.seq];
      if (!b || !b.versions.length) continue;
      e.new_content = b.versions[b.versions.length - 1];
      if (b.versions.length > 1) e.code_versions = b.versions;
      e.seg_tests = [...new Set(b.tests)];
    }
    return { spec_suggested: specParts.join("\n\n").trim(), plan_seqs: planSeqs };
  }

  /* One request per message; ranges come back local and are shifted to session coordinates. */
  async function segmentChunked(session, settings, callModel, parseArray, fetchImpl, n) {
    const msgs = session.events.filter((e) => ["message", "user"].includes(e.kind) && (e.text || "").trim());
    const all = [];
    const exchanges = [];
    let offset = 0,
      ok = 0,
      failed = 0;
    for (const e of msgs) {
      const lines = e.text.split("\n");
      // global numbering: offset+1 is this message's "--- event seq N ---" header, its text starts one line later
      const start = offset + 2;
      offset += 1 + lines.length;
      if (!lines.some((l) => l.trim())) {
        continue;
      }
      const user =
        `# Message (seq ${e.seq}, ${e.kind === "user" ? "USER" : "AGENT"})\n` +
        lines
          .map((l, i) => `${i + 1}\t${l}`)
          .join("\n")
          .slice(0, settings.maxCode || 12000);
      let raw = null;
      try {
        raw = await callModel(settings, { system: sys("segment_local", LOCAL_SYSTEM), user, maxTokens: 2000, schema: SCHEMA }, fetchImpl);
        const arr = parseArray(raw, T("what_segmentation"));
        const v = validate(arr, lines.length);
        for (const sg of v.segments) all.push({ ...sg, from: sg.from + start - 1, to: sg.to + start - 1 });
        ok++;
      } catch (err) {
        failed++; // this message stays as the regex parser saw it
        exchanges.push(`--- seq ${e.seq}: ${err.message}`);
        continue;
      }
      exchanges.push(`--- seq ${e.seq} ---\n${raw}`);
    }
    if (!ok) {
      const e = /** @type {Error & { raw?: string }} */ (new Error(T("seg_all_chunks_failed", { n: failed })));
      e.raw = exchanges.join("\n\n");
      throw e;
    }
    return { segments: all.sort((a, b) => a.from - b.from), chunks: { ok, failed }, raw: exchanges.join("\n\n") };
  }

  let OVERRIDES = {};
  const setPrompts = (o) => {
    OVERRIDES = o || {};
  };
  const sys = (key, built) => (OVERRIDES[key] && OVERRIDES[key].trim() ? OVERRIDES[key] : built);

  // the provider and model chosen for segmentation in Settings (see LensAI.settingsFor)
  const routeSeg = (settings) => {
    const A = typeof LensAI !== "undefined" ? LensAI : typeof require === "function" ? require("./ai.js") : null;
    return A && A.settingsFor ? A.settingsFor(settings, "segment") : settings;
  };
  const usedSeg = (settings) => {
    const A = typeof LensAI !== "undefined" ? LensAI : typeof require === "function" ? require("./ai.js") : null;
    return A && A.used ? A.used(settings) : {};
  };
  async function segment(session, settings, callModel, parseArray, fetchImpl) {
    settings = routeSeg(settings);
    const n = numbered(session.events);
    if (!n.total) throw new Error(T("seg_nothing"));
    const user = `# Session (numbered lines)\n${n.text.slice(0, settings.maxCode || 40000)}`;
    const request = `${T("req_segment", usedSeg(settings))}\n--- system ---\n${sys("segment", SYSTEM)}\n\n--- user ---\n${user}`;
    // every failure carries the full request and whatever came back, so the panel can show it
    const fail = (e, raw) =>
      Object.assign(e instanceof Error ? e : new Error(String(e)), {
        raw: request + "\n\n" + T("resp") + "\n" + (raw != null ? raw : T("call_error", { msg: String((e && e.message) || e) })),
      });
    // small local models, and very long sessions, are handled message by message
    const chunked = settings.segmentChunked === true || (settings.segmentChunked !== false && (isLocal(settings) || n.total > 800));
    if (chunked) {
      let r;
      try {
        r = await segmentChunked(session, settings, callModel, parseArray, fetchImpl, n);
      } catch (e) {
        throw fail(e, e.raw || null);
      }
      const covered = r.segments.reduce((acc, s2) => acc + (s2.to - s2.from + 1), 0);
      const applied = apply(session.events, r.segments, n.map);
      return {
        segments: r.segments,
        coverage: n.total ? covered / n.total : 0,
        chunks: r.chunks,
        raw: r.raw,
        request: `${T("req_segment", usedSeg(settings))} (${T("seg_chunked", { ok: r.chunks.ok, failed: r.chunks.failed })})\n--- system ---\n${sys("segment_local", LOCAL_SYSTEM)}`,
        ...applied,
      };
    }
    let raw;
    try {
      raw = await callModel(settings, { system: sys("segment", SYSTEM), user, maxTokens: 6000, schema: SCHEMA }, fetchImpl);
    } catch (e) {
      throw fail(e, null);
    }
    let v;
    try {
      v = validate(parseArray(raw, T("what_segmentation")), n.total);
    } catch (e) {
      throw fail(e, raw);
    }
    const applied = apply(session.events, v.segments, n.map);
    return { segments: v.segments, coverage: v.coverage, raw, request, ...applied };
  }

  return { setPrompts, DEFAULTS: { segment: SYSTEM, segment_local: LOCAL_SYSTEM }, segment, segmentChunked, numbered, validate, apply, SYSTEM, LOCAL_SYSTEM };
});
