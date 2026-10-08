"use strict";
/* Phase 4: store.js on a real file system (a temporary folder per test). */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createStore, fileNameFor } = require("../store.js");
const { load } = require("./helpers");
const { Lens } = load();

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "sl-store-"));
// a file written `seconds` ago
const age = (p, seconds) => {
  const t = Date.now() / 1000 - seconds;
  fs.utimesSync(p, t, t);
};
const sess = (id, extra = {}) =>
  Object.assign(
    {
      id,
      name: "n " + id,
      task: "T-" + id,
      profile: "qa-ts",
      created: "2026-06-01T00:00:00.000Z",
      events: [{ seq: 1, kind: "user", text: "hi" }],
      findings: [{ check: "weak_assert", severity: "high", seq: 1, message: "weak" }],
      verdicts: {},
    },
    extra,
  );
async function open(dir, opts = {}) {
  const logs = [];
  const st = createStore(Object.assign({ dir, log: (m) => logs.push(m) }, opts));
  await st.open();
  return { st, logs };
}

test("put, get, list, delete, clear", async () => {
  const dir = tmp();
  const { st } = await open(dir);
  let r = await st.put(sess("a", { created: "2026-06-01T00:00:00.000Z" }), { analyzedGen: "0000abcd" });
  assert.deepEqual([r.ok, r.rev], [true, 1]);
  assert.equal(r.meta.verdict, "red");
  assert.equal(r.meta.findingsCount, 1);
  assert.equal(r.meta.analyzedGen, "0000abcd");
  assert.equal(r.meta.order, 1);
  await st.put(sess("b", { created: "2026-06-02T00:00:00.000Z" }));
  assert.deepEqual(
    st.list().map((m) => m.id),
    ["b", "a"],
    "newest first",
  );
  const g = await st.get("a");
  assert.equal(g.rev, 1);
  assert.ok(!("__rev" in g.session));
  assert.equal(g.session.task, "T-a");
  r = await st.put(Object.assign(g.session, { reviewed: true }), { baseRev: 1 });
  assert.equal(r.rev, 2);
  assert.equal(r.meta.reviewed, true);
  assert.equal(r.meta.analyzedGen, "0000abcd", "kept when not given");
  await st.delete("a");
  assert.equal(await st.get("a"), null);
  assert.equal(st.has("a"), false);
  assert.ok(!fs.existsSync(path.join(dir, "a.json")) && !fs.existsSync(path.join(dir, "a.meta.json")));
  await st.clear();
  assert.deepEqual(st.list(), []);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("a stale baseRev is a conflict and writes nothing; the rev is read from disk (another window)", async () => {
  const dir = tmp();
  const { st } = await open(dir);
  await st.put(sess("a"));
  const other = (await open(dir)).st; // a second window on the same folder
  await other.put(sess("a", { name: "from the other window" }), { baseRev: 1 });
  const r = await st.put(sess("a", { name: "mine" }), { baseRev: 1 });
  assert.deepEqual(r, { conflict: true, rev: 2 });
  assert.equal((await st.get("a")).session.name, "from the other window");
  assert.equal((await st.put(sess("a", { name: "mine" }), { baseRev: 2 })).rev, 3);
});

test("the summary is computed from the session, like Lens.sessionSummary", async () => {
  const { st } = await open(tmp());
  const f1 = { check: "weak_assert", severity: "medium", seq: 1, message: "m1", evidence: "expect(x)" };
  const f2 = { check: "weak_assert", severity: "low", seq: 2, message: "m2" };
  const s = sess("a", { findings: [f1, f2], verdicts: { [Lens.fkey(f1)]: { v: "ok", note: "yes" }, [Lens.fkey(f2)]: { v: "fp" } } });
  const m = (await st.put(s)).meta;
  assert.equal(m.verdict, "yellow");
  assert.deepEqual(m.checkStats, { weak_assert: { total: 2, ok: 1, fp: 1 } });
  assert.deepEqual(m.confirmed, [{ key: Lens.fkey(f1), check: "weak_assert", seq: 1, message: "m1", snippet: "expect(x)", note: "yes" }]);
});

test("the summary splits the stats by source; a regex finding of an older session (no source) counts as formal", async () => {
  const { st } = await open(tmp());
  const old = { check: "weak_assert", severity: "high", seq: 1, message: "regex, saved before 0.1.112" };
  const formal = { check: "weak_assert", severity: "high", seq: 2, message: "regex", source: "formal" };
  const lint = { check: "weak_assert", severity: "high", seq: 3, message: "engine", source: "lint" };
  const hidden = { check: "weak_assert", severity: "high", seq: 4, message: "engine, check off", source: "lint" };
  const s = sess("a", {
    findings: [old, formal, lint],
    calibHidden: [hidden],
    verdicts: { [Lens.fkey(old)]: { v: "ok" }, [Lens.fkey(formal)]: { v: "ok" }, [Lens.fkey(lint)]: { v: "fp" }, [Lens.fkey(hidden)]: { v: "fp" } },
  });
  const m = (await st.put(s)).meta;
  assert.equal(m.schema, 4);
  assert.deepEqual(m.checkStats, { weak_assert: { total: 4, ok: 2, fp: 2 } }, "unchanged: every source together");
  assert.deepEqual(m.sourceStats, {
    weak_assert: { formal: { total: 2, ok: 2, fp: 0 }, lint: { total: 2, ok: 0, fp: 2 } },
  });
});

test("open(): a summary of schema 1 is rebuilt from its session once, keeping its order and analyzedGen", async () => {
  const dir = tmp();
  const { st } = await open(dir);
  await st.put(sess("a"), { analyzedGen: "0000abcd" });
  await st.put(sess("b"));
  // a as 0.1.111 wrote it: schema 1, no sourceStats; written after the session, so it looks current
  const mp = path.join(dir, "a.meta.json");
  const old = JSON.parse(fs.readFileSync(mp, "utf8"));
  const order = old.order;
  old.schema = 1;
  delete old.sourceStats;
  fs.writeFileSync(mp, JSON.stringify(old));
  const r = await open(dir);
  const m = r.st.meta("a");
  assert.equal(m.schema, 4);
  assert.deepEqual(m.sourceStats, { weak_assert: { formal: { total: 1, ok: 0, fp: 0 } } });
  assert.deepEqual([m.order, m.analyzedGen, m.rev], [order, "0000abcd", 1]);
  assert.deepEqual(
    r.logs.filter((l) => /rebuilt the summary/.test(l)),
    ["rebuilt the summary of a"],
    "only the old one",
  );
  assert.deepEqual(
    (await open(dir)).logs.filter((l) => /rebuilt/.test(l)),
    [],
    "once",
  );
});

test("open(): a summary of schema 2 is rebuilt once and gets started, the time of the session's first step", async () => {
  const dir = tmp();
  const { st } = await open(dir);
  const events = [
    { seq: 1, ts: "", kind: "user", text: "hi" },
    { seq: 2, ts: "2026-05-30T10:00:00.000Z", kind: "message", text: "ok" },
  ];
  await st.put(sess("a", { events }), { analyzedGen: "0000abcd" });
  // a as 0.1.112-0.1.115 wrote it: schema 2, no started
  const mp = path.join(dir, "a.meta.json");
  const old = JSON.parse(fs.readFileSync(mp, "utf8"));
  old.schema = 2;
  delete old.started;
  fs.writeFileSync(mp, JSON.stringify(old));
  const r = await open(dir);
  const m = r.st.meta("a");
  assert.deepEqual([m.schema, m.started, m.created], [4, "2026-05-30T10:00:00.000Z", "2026-06-01T00:00:00.000Z"]);
  assert.deepEqual([m.order, m.analyzedGen, m.rev], [old.order, "0000abcd", 1]);
  assert.deepEqual(
    r.logs.filter((l) => /rebuilt/.test(l)),
    ["rebuilt the summary of a"],
  );
  assert.deepEqual(
    (await open(dir)).logs.filter((l) => /rebuilt/.test(l)),
    [],
    "once",
  );
});

test("open(): a summary of schema 3 is rebuilt once and gets the agent, the project and openCount (0.1.124)", async () => {
  const dir = tmp();
  const { st } = await open(dir);
  const text = JSON.stringify({ type: "user", cwd: "/w/shop", message: { role: "user", content: "hi" } });
  const f2 = { check: "raw_locator", severity: "low", seq: 1, message: "raw" };
  // imported before 0.1.124: no agent or project on the session, only the kept text
  const s = sess("a", { source_text: text });
  s.findings.push(f2);
  s.verdicts = { [Lens.fkey(f2)]: { v: "ok" } };
  await st.put(s, { analyzedGen: "0000abcd" });
  // a as 0.1.116-0.1.123 wrote it: schema 3, none of the three
  const mp = path.join(dir, "a.meta.json");
  const old = JSON.parse(fs.readFileSync(mp, "utf8"));
  old.schema = 3;
  for (const k of ["agent", "project", "openCount"]) delete old[k];
  fs.writeFileSync(mp, JSON.stringify(old));
  const r = await open(dir);
  const m = r.st.meta("a");
  assert.deepEqual([m.schema, m.agent, m.project, m.openCount], [4, "claude-code", "/w/shop", 1]);
  assert.deepEqual([m.order, m.analyzedGen, m.rev], [old.order, "0000abcd", 1]);
  assert.deepEqual(
    r.logs.filter((l) => /rebuilt/.test(l)),
    ["rebuilt the summary of a"],
  );
  assert.deepEqual(
    (await open(dir)).logs.filter((l) => /rebuilt/.test(l)),
    [],
    "once",
  );
});

test("fileNameFor: an id never leaves the folder", async () => {
  const dir = tmp();
  const { st } = await open(dir);
  const ids = ["../x", "a/b", "a\\b", "CON", "x.", "..", "Никита", "é", "x".repeat(200), "C:\\evil", "/etc/passwd"];
  for (const id of ids) {
    const n = fileNameFor(id);
    assert.match(n, /^(h-[0-9a-f]{32}|[A-Za-z0-9_-]{1,64})$/, id);
    await st.put(sess(id));
    assert.equal((await st.get(id)).session.id, id);
  }
  assert.equal(fileNameFor("CON"), "CON"); // plain word: kept; on Windows it is still CON.json, which is allowed
  for (const f of fs.readdirSync(dir)) assert.ok(!f.includes("/") && !f.includes(".."), f);
  assert.equal(fs.readdirSync(path.dirname(dir)).filter((f) => f === "x" || f === "etc").length, 0);
  assert.equal(st.list().length, ids.length);
});

test("open(): an interrupted write is repaired", async () => {
  const dir = tmp();
  let { st } = await open(dir);
  await st.put(sess("a"));
  await st.put(sess("b"));
  await st.put(sess("c"));
  // b: the session was written with rev 2, its summary not (crash between the two renames)
  const bFile = path.join(dir, "b.json");
  fs.writeFileSync(bFile, JSON.stringify(Object.assign(sess("b", { name: "newer" }), { __rev: 2 })));
  // c: the summary is gone
  fs.unlinkSync(path.join(dir, "c.meta.json"));
  // d: a summary without its session; e: unreadable session; and a left-over temporary file
  fs.writeFileSync(path.join(dir, "d.meta.json"), JSON.stringify({ id: "d", rev: 1 }));
  fs.writeFileSync(path.join(dir, "e.json"), "{ not json");
  fs.writeFileSync(path.join(dir, "a.json.123.abcd.tmp"), "partial");
  age(path.join(dir, "a.json.123.abcd.tmp"), 120); // by the next start; a younger one may be another window's write
  const r = await open(dir);
  st = r.st;
  assert.deepEqual(
    st
      .list()
      .map((m) => m.id)
      .sort(),
    ["a", "b", "c"],
  );
  assert.equal(st.meta("b").rev, 2);
  assert.equal(st.meta("b").name, "newer");
  assert.equal(st.meta("c").rev, 1);
  assert.ok(!fs.existsSync(path.join(dir, "d.meta.json")));
  assert.ok(!fs.existsSync(path.join(dir, "e.json")));
  assert.equal(fs.readdirSync(path.join(dir, "corrupt")).length, 1);
  assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith(".tmp")));
  assert.ok(r.logs.some((l) => /rebuilt the summary of b/.test(l)) && r.logs.some((l) => /corrupt/.test(l)));
});

test("open() in a second window leaves a write in progress alone; a temporary file older than a minute is removed (0.1.120)", async () => {
  const dir = tmp();
  let release, reached;
  const paused = new Promise((r) => (release = r));
  const atSync = new Promise((r) => (reached = r));
  let first = true;
  const P = Object.assign({}, fs.promises, {
    open: async (...args) => {
      const h = await fs.promises.open(...args);
      if (first && String(args[0]).endsWith(".tmp")) {
        first = false;
        const sync = h.sync.bind(h);
        h.sync = async () => {
          reached();
          await paused;
          return sync();
        };
      }
      return h;
    },
  });
  const writer = createStore({ dir, fs: { promises: P } });
  await writer.open();
  const crashed = path.join(dir, "x.json.1.dead.tmp");
  fs.writeFileSync(crashed, "left by a crash");
  age(crashed, 120);
  const put = writer.put(sess("a"));
  await atSync; // the writer's temporary file is on disk, not renamed yet
  const { logs } = await open(dir); // a second window starts
  release();
  assert.equal((await put).rev, 1, "the write of the first window succeeds");
  assert.ok(!fs.existsSync(crashed));
  assert.deepEqual(
    fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")),
    [],
  );
  assert.deepEqual(
    logs.filter((l) => /unfinished/.test(l)),
    ["removed an unfinished write: x.json.1.dead.tmp"],
  );
});

test("open(): a summary another window writes while it is rebuilt here is kept, not overwritten (0.1.120)", async () => {
  const dir = tmp();
  const { st } = await open(dir);
  await st.put(sess("a"), { analyzedGen: "gen-1" });
  // the other window has written the session (rev 2), its summary comes next
  const sp = path.join(dir, "a.json"),
    mp = path.join(dir, "a.meta.json");
  const text = JSON.stringify(Object.assign(sess("a", { name: "newer" }), { __rev: 2 }));
  fs.writeFileSync(sp, text);
  age(mp, 60);
  const theirs = Object.assign(JSON.parse(fs.readFileSync(mp, "utf8")), { rev: 2, name: "newer", analyzedGen: "gen-2", size: Buffer.byteLength(text) });
  let landed = false;
  const summarize = (s) => {
    if (!landed) {
      landed = true; // the other window's summary lands while this one is being rebuilt
      fs.writeFileSync(mp, JSON.stringify(theirs));
    }
    return Lens.sessionSummary(s);
  };
  const r = await open(dir, { summarize });
  assert.ok(landed);
  assert.deepEqual(JSON.parse(fs.readFileSync(mp, "utf8")), theirs, "the file is the other window's");
  assert.deepEqual([r.st.meta("a").rev, r.st.meta("a").analyzedGen], [2, "gen-2"]);
  assert.deepEqual(
    r.logs.filter((l) => /summary of a/.test(l)),
    ["kept the summary of a that another window wrote"],
  );
  assert.deepEqual(
    fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")),
    [],
  );
});

test("rename is retried on EPERM/EBUSY (Windows antivirus), other errors are not", async () => {
  const dir = tmp();
  let fails = 2;
  const P = Object.assign({}, fs.promises, {
    rename: async (a, b) => {
      if (fails-- > 0) {
        const e = new Error("busy");
        e.code = "EPERM";
        throw e;
      }
      return fs.promises.rename(a, b);
    },
  });
  const { st } = await open(dir, { fs: { promises: P } });
  assert.equal((await st.put(sess("a"))).rev, 1);
  const P2 = Object.assign({}, fs.promises, {
    rename: async () => {
      const e = new Error("no space");
      e.code = "ENOSPC";
      throw e;
    },
  });
  const st2 = createStore({ dir, fs: { promises: P2 } });
  await st2.open();
  await assert.rejects(st2.put(sess("b")), /no space/);
  assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith(".tmp")), "the temporary file is removed");
});

test("writes of one id do not interleave; refreshIfChanged() sees another window", async () => {
  const dir = tmp();
  const { st } = await open(dir);
  await Promise.all([1, 2, 3, 4, 5].map((i) => st.put(sess("a", { name: "v" + i }))));
  assert.equal(st.meta("a").rev, 5);
  const other = (await open(dir)).st;
  await new Promise((r) => setTimeout(r, 20));
  await other.put(sess("n", { created: "2027-01-01T00:00:00.000Z" }));
  await other.delete("a");
  const changed = await st.refreshIfChanged();
  assert.deepEqual(changed.sort(), ["a", "n"]);
  assert.deepEqual(
    st.list().map((m) => m.id),
    ["n"],
  );
});
