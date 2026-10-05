// @ts-check
"use strict";
/* Sessions on disk (phase 4). No require("vscode"): tested on a real file system (test/store.test.js).

   dir/<name>.json       the whole session, plus __rev
   dir/<name>.meta.json  what the Sessions tree, Calibration and Rules need without the events (Lens.sessionSummary)
                         plus rev, order, analyzedGen, size

   The files are the only store; the in-memory map is a cache of the meta files. <name> is fileNameFor(id): the id
   itself when it is a plain word, otherwise a hash, so an id never becomes a path. A write goes to a temporary file
   first and is renamed into place, the session before its meta; open() repairs what an interrupted write left. */

const nodeFs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PLAIN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const META = ".meta.json";
// 2 (0.1.112): the summary has sourceStats. 3 (0.1.116): it has started, the time of the session's first step.
// open() rebuilds a summary of an older schema from its session, once.
const META_SCHEMA = 3;
const RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const RETRY_MS = [20, 40, 80, 160, 320];
// open() leaves a younger temporary file alone: another window may be writing it right now (0.1.120)
const TMP_AGE_MS = 60 * 1000;

function fileNameFor(id) {
  const s = String(id);
  return PLAIN_ID.test(s) ? s : "h-" + crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 32);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{ dir: string, fs?: typeof import("fs"), log?: (message: string) => void, summarize?: Function }} opts
 */
function createStore({ dir, fs = nodeFs, log = (message) => {}, summarize } = /** @type {any} */ ({})) {
  if (!dir) throw new Error("store: no directory");
  const summary = summarize || require("./media/lens.js").sessionSummary;
  const P = fs.promises;
  const metas = new Map(); // id → meta
  const mtimes = new Map(); // meta file name → mtimeMs, for refreshIfChanged()
  const queues = new Map(); // id → promise chain: writes of one id never interleave
  let opened = false;

  const file = (id) => path.join(dir, fileNameFor(id) + ".json");
  const metaFile = (id) => path.join(dir, fileNameFor(id) + META);

  async function rename(from, to) {
    for (let i = 0; ; i++) {
      try {
        return await P.rename(from, to);
      } catch (e) {
        if (!RETRY_CODES.has(e && e.code) || i >= RETRY_MS.length) throw e;
        await sleep(RETRY_MS[i]);
      }
    }
  }
  // unchanged (optional) is asked right before the rename: false → nothing is written and false is returned
  async function writeAtomic(target, text, unchanged) {
    const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    const h = await P.open(tmp, "w");
    try {
      await h.writeFile(text, "utf8");
      await h.sync();
    } finally {
      await h.close();
    }
    const drop = async () => {
      try {
        await P.unlink(tmp);
      } catch {
        /* gone already */
      }
    };
    if (unchanged && !(await unchanged())) {
      await drop();
      return false;
    }
    try {
      await rename(tmp, target);
    } catch (e) {
      await drop();
      throw e;
    }
    return true;
  }
  async function readJson(p) {
    return JSON.parse(await P.readFile(p, "utf8"));
  }

  function buildMeta(session, rev, extra) {
    const m = summary(session);
    return Object.assign({ schema: META_SCHEMA }, m, { id: session.id, rev, order: extra.order, analyzedGen: extra.analyzedGen || "", size: extra.size });
  }
  function maxOrder() {
    let n = 0;
    for (const m of metas.values()) if (m.order > n) n = m.order;
    return n;
  }

  function enqueue(id, fn) {
    const prev = queues.get(id) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    queues.set(id, next);
    next
      .finally(() => {
        if (queues.get(id) === next) queues.delete(id);
      })
      .catch(() => {});
    return next;
  }

  // Loads the meta files and repairs what an interrupted write can leave behind.
  async function open() {
    await P.mkdir(dir, { recursive: true });
    metas.clear();
    mtimes.clear();
    const names = await P.readdir(dir);
    for (const n of names)
      if (n.endsWith(".tmp")) {
        try {
          const p = path.join(dir, n);
          if (Date.now() - (await P.stat(p)).mtimeMs < TMP_AGE_MS) continue;
          await P.unlink(p);
          log(`removed an unfinished write: ${n}`);
        } catch {
          /* another window */
        }
      }
    const sessionFiles = new Set(names.filter((n) => n.endsWith(".json") && !n.endsWith(META)).map((n) => n.slice(0, -5)));
    const metaFiles = new Set(names.filter((n) => n.endsWith(META)).map((n) => n.slice(0, -META.length)));
    for (const base of metaFiles) {
      if (!sessionFiles.has(base)) {
        try {
          await P.unlink(path.join(dir, base + META));
          log(`removed a summary without its session: ${base}`);
        } catch {
          /* ignore */
        }
      }
    }
    // A summary belongs to the session on disk when it was written after it (the session is renamed into place
    // first) and records its size. Checked with two stat() calls, not by reading the session; up to 16 at a time.
    const bases = [...sessionFiles];
    // The common case (summary current) is read synchronously: about 3 system calls per session instead of a round
    // trip through the thread pool for each, which keeps open() near linear and short (a few tens of ms for 200).
    const S = typeof fs.statSync === "function" && typeof fs.readFileSync === "function" ? fs : null;
    const quick = (base) => {
      if (!S || !metaFiles.has(base)) return null;
      try {
        const sst = S.statSync(path.join(dir, base + ".json")),
          mp = path.join(dir, base + META),
          mst = S.statSync(mp);
        const meta = JSON.parse(S.readFileSync(mp, "utf8"));
        if (meta.schema !== META_SCHEMA || typeof meta.rev !== "number" || typeof meta.id !== "string" || meta.size !== sst.size || sst.mtimeMs > mst.mtimeMs)
          return null;
        return { meta, mtime: mst.mtimeMs };
      } catch {
        return null;
      }
    };
    const checkOne = async (base) => {
      const q = quick(base);
      if (q) {
        metas.set(q.meta.id, q.meta);
        mtimes.set(base + META, q.mtime);
        return;
      }
      const sp = path.join(dir, base + ".json"),
        mp = path.join(dir, base + META);
      let meta = null,
        metaText = null,
        sst = null,
        mst = null;
      try {
        sst = await P.stat(sp);
      } catch {
        return;
      }
      if (metaFiles.has(base)) {
        try {
          mst = await P.stat(mp);
          metaText = await P.readFile(mp, "utf8");
          meta = JSON.parse(metaText);
        } catch {
          meta = null;
        }
        if (meta && (typeof meta.rev !== "number" || typeof meta.id !== "string" || meta.size !== sst.size || sst.mtimeMs > mst.mtimeMs)) {
          // written in the same millisecond or the size matches by chance: the rev decides
          if (!(meta.size === sst.size && typeof meta.rev === "number" && (await readRev(sp).catch(() => NaN)) === meta.rev)) meta = null;
        }
        if (meta && meta.schema !== META_SCHEMA) meta = null; // an older summary: rebuilt below from the session
      }
      if (!meta) {
        let session;
        try {
          session = await readJson(sp);
        } catch {
          await moveCorrupt(sp, base);
          return;
        }
        if (!session || typeof session !== "object" || typeof session.id !== "string") {
          await moveCorrupt(sp, base);
          return;
        }
        const rev = Number.isInteger(session.__rev) ? session.__rev : 1;
        let old = null;
        try {
          old = metaText && JSON.parse(metaText);
        } catch {
          /* unreadable: rebuilt without it */
        }
        delete session.__rev;
        meta = buildMeta(session, rev, { order: (old && old.order) || 0, analyzedGen: (old && old.analyzedGen) || "", size: sst.size });
        // Another window writes a session and then its summary. When that summary lands while this one is being
        // rebuilt, it is newer and keeps its analyzedGen: it is not overwritten (0.1.120).
        if (await writeAtomic(mp, JSON.stringify(meta), async () => (await P.readFile(mp, "utf8").catch(() => null)) === metaText))
          log(`rebuilt the summary of ${session.id}`);
        else {
          meta = await readJson(mp).catch(() => null);
          if (!meta || typeof meta.id !== "string" || typeof meta.rev !== "number") return; // refreshIfChanged() picks it up
          log(`kept the summary of ${meta.id} that another window wrote`);
        }
      }
      metas.set(meta.id, meta);
      try {
        mtimes.set(base + META, (await P.stat(mp)).mtimeMs);
      } catch {
        /* ignore */
      }
    };
    for (let i = 0; i < bases.length; i += 16) await Promise.all(bases.slice(i, i + 16).map(checkOne));
    // summaries rebuilt without an order go after the rest, oldest first
    let n = maxOrder();
    for (const m of [...metas.values()].filter((x) => !x.order).sort((a, b) => String(a.created).localeCompare(String(b.created)))) {
      m.order = ++n;
      await writeAtomic(metaFile(m.id), JSON.stringify(m));
    }
    opened = true;
    return metas.size;
  }

  // __rev is the last key of the file (see put), so it is read from the tail instead of parsing a large file
  async function readRev(p) {
    const h = await P.open(p, "r");
    try {
      const { size } = await h.stat();
      const len = Math.min(size, 64);
      const buf = Buffer.alloc(len);
      await h.read(buf, 0, len, size - len);
      const m = /"__rev":(\d+)\}\s*$/.exec(buf.toString("utf8"));
      return m ? Number(m[1]) : NaN;
    } finally {
      await h.close();
    }
  }

  async function moveCorrupt(p, base) {
    const cdir = path.join(dir, "corrupt");
    try {
      await P.mkdir(cdir, { recursive: true });
      await rename(p, path.join(cdir, `${base}.${Date.now()}.json`));
      try {
        await P.unlink(path.join(dir, base + META));
      } catch {
        /* none */
      }
      log(`moved an unreadable session file to corrupt/: ${base}.json`);
    } catch (e) {
      log(`could not move ${base}.json aside: ${e && e.message}`);
    }
  }

  function ensureOpen() {
    if (!opened) throw new Error("store is not open");
  }
  const copy = (m) => JSON.parse(JSON.stringify(m));

  function list() {
    ensureOpen();
    // not copied: the summaries are replaced whole on every write, never changed in place, and callers only read them
    return [...metas.values()].sort((a, b) => String(b.created || "").localeCompare(String(a.created || "")) || b.order - a.order);
  }
  function has(id) {
    return metas.has(id);
  }
  function meta(id) {
    const m = metas.get(id);
    return m ? copy(m) : null;
  }

  async function get(id) {
    ensureOpen();
    if (!metas.has(id)) return null;
    let s;
    try {
      s = await readJson(file(id));
    } catch {
      return null;
    }
    const rev = Number.isInteger(s.__rev) ? s.__rev : 1;
    delete s.__rev;
    return { session: s, rev, meta: copy(metas.get(id)) };
  }

  /* opts: { baseRev, analyzedGen, rev (migration only: the exact rev to write), order (migration only) }
     → { ok, rev, meta } | { conflict: true, rev } */
  function put(session, opts = {}) {
    ensureOpen();
    const id = session && session.id;
    if (typeof id !== "string" || !id) return Promise.reject(new Error("session has no id"));
    return enqueue(id, async () => {
      // the rev on disk, not the cached one: another window may have written since
      let current = metas.get(id) || null;
      try {
        current = await readJson(metaFile(id));
      } catch {
        /* new, or only cached */
      }
      const curRev = current ? current.rev : 0;
      if (opts.baseRev != null && opts.baseRev !== curRev) return { conflict: true, rev: curRev };
      const rev = Number.isInteger(opts.rev) ? opts.rev : curRev + 1;
      const body = Object.assign({}, session);
      delete body.__rev;
      const text = JSON.stringify(Object.assign(body, { __rev: rev }));
      await writeAtomic(file(id), text);
      const order = Number.isInteger(opts.order) ? opts.order : (current && current.order) || maxOrder() + 1;
      const m = buildMeta(session, rev, {
        order,
        analyzedGen: opts.analyzedGen != null ? opts.analyzedGen : (current && current.analyzedGen) || "",
        size: Buffer.byteLength(text, "utf8"),
      });
      await writeAtomic(metaFile(id), JSON.stringify(m));
      metas.set(id, m);
      try {
        mtimes.set(fileNameFor(id) + META, (await P.stat(metaFile(id))).mtimeMs);
      } catch {
        /* ignore */
      }
      return { ok: true, rev, meta: copy(m) };
    });
  }

  function del(id) {
    ensureOpen();
    return enqueue(id, async () => {
      for (const p of [metaFile(id), file(id)]) {
        try {
          await P.unlink(p);
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
      }
      metas.delete(id);
      mtimes.delete(fileNameFor(id) + META);
      return { ok: true };
    });
  }

  async function clear() {
    ensureOpen();
    for (const id of [...metas.keys()]) await del(id);
    return { ok: true };
  }

  /* Picks up what another window wrote: new, changed and removed summaries. → the ids that changed. */
  async function refreshIfChanged() {
    ensureOpen();
    let names;
    try {
      names = (await P.readdir(dir)).filter((n) => n.endsWith(META));
    } catch {
      return [];
    }
    const changed = [];
    const seen = new Set();
    for (const n of names) {
      seen.add(n);
      let mt;
      try {
        mt = (await P.stat(path.join(dir, n))).mtimeMs;
      } catch {
        continue;
      }
      if (mtimes.get(n) === mt) continue;
      try {
        const m = await readJson(path.join(dir, n));
        if (m && typeof m.id === "string") {
          metas.set(m.id, m);
          mtimes.set(n, mt);
          changed.push(m.id);
        }
      } catch {
        /* being written: next time */
      }
    }
    for (const [id] of metas) {
      const n = fileNameFor(id) + META;
      if (!seen.has(n)) {
        metas.delete(id);
        mtimes.delete(n);
        changed.push(id);
      }
    }
    return changed;
  }

  return { open, list, has, meta, get, put, delete: del, clear, refreshIfChanged, dir, fileNameFor };
}

module.exports = { createStore, fileNameFor, PLAIN_ID };
