"use strict";
/* Phase 5: lint.js loads the engine scripts itself (LensLint.ensure → <script src> appended to <head>). jsdom with
   runScripts "outside-only" would neither run nor fire load for them, so both harnesses route them through here:
   the element is never inserted (the page's markup stays what it was), `loads` records every file asked for, and
   load fires on the next tick. opts.engines: { file → source } evaluated in the page before load fires (a stub
   engine, or a real file); without an entry the file "loads" but defines nothing, so the engine ends up "failed" —
   what 0.1.101 did in these harnesses with the engine files left out (lint_missing). opts.engineError: Set of files
   whose load fails (error instead of load). opts.engineHold: a Promise the loads wait for. */
function stubEngineLoader(w, opts = {}) {
  const loads = [];
  const orig = w.Node.prototype.appendChild;
  w.Node.prototype.appendChild = function (child) {
    if (child && child.tagName === "SCRIPT" && child.src) {
      const file = String(child.getAttribute("src")).split("/").pop();
      loads.push(file);
      Promise.resolve(opts.engineHold).then(() =>
        w.setTimeout(() => {
          if (opts.engineError && opts.engineError.has(file)) {
            if (child.onerror) child.onerror(new w.Event("error"));
            return;
          }
          const src = opts.engines && opts.engines[file];
          if (src) w.eval(src + "\n//# sourceURL=" + file);
          if (child.onload) child.onload(new w.Event("load"));
        }, 0),
      );
      return child;
    }
    return orig.call(this, child);
  };
  return loads;
}

/* A tree-sitter engine stand-in: the same { lint, RULES, boot, isReady, bootError } shape as lint-java.js. boot()
   resolves after bootMs; lint() reports one java/swallowed-exception per block containing "catch". */
function fakeTreeSitterEngine(global, rule, bootMs = 0) {
  return `var ${global} = (function () {
    let ready = false; const booted = [];
    return {
      RULES: {}, booted,
      boot(o) { booted.push(o); return new Promise(r => setTimeout(() => { ready = true; r(); }, ${bootMs})); },
      isReady: () => ready, bootError: () => null,
      lint(code) {
        if (!ready) return { messages: [], error: "fake: still loading" };
        return { messages: /catch/.test(code) ? [{ ruleId: "${rule}", line: 1, message: "empty catch" }] : [] };
      },
    };
  })();`;
}

module.exports = { stubEngineLoader, fakeTreeSitterEngine };
