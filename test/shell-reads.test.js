"use strict";
/* A shell command that only reads (0.1.121): cat, sed -n, head, rg, ls, find… is how Codex reads a file, and Claude
   Code and Cursor often do too. It counts as a read in the session's metrics (Codex sessions showed "reads 0" and a
   Read:Edit warning), and peeked_at_src_before_plan sees product code read that way. The step stays run_other. What
   must not count: a command that writes (sed -i, >, find -delete), one mixed with another command, a web page
   (curl), a quoted word (a search pattern) as a path. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./helpers");

const { Lens } = load();
const cfg = Lens.profile("qa-ts");

// steps: ["user", text] | ["say", text] | ["write", file, content] | ["bash", command]
function transcript(steps) {
  const L = [];
  steps.forEach(([kind, a, b], i) => {
    const id = "t" + i;
    if (kind === "say") return L.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: a }] } }));
    if (kind === "user") return L.push(JSON.stringify({ type: "user", message: { role: "user", content: a } }));
    const [name, input] = kind === "write" ? ["Write", { file_path: a, content: b }] : ["Bash", { command: a }];
    L.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } }));
    L.push(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } }));
  });
  return L.join("\n");
}
const events = (steps) => Lens.importAny(transcript(steps), cfg);
const reads = (cmd) => Lens.metrics(events([["bash", cmd]]), cfg).reads;
const peeked = (steps) =>
  Lens.runChecks(events(steps), cfg)
    .filter((f) => f.check === "peeked_at_src_before_plan")
    .map((f) => f.message);
const TASK = ["user", "Write tests for the cart"];
const WRITE = ["write", "e2e/cart.spec.ts", "test('total', async () => {\n  expect(cart.total()).toBe(3);\n});\n"];
const PEEKED = (file) => `Read ${file} before the plan was approved — product code is off-limits during generation`;

test("a command that only reads counts as a read in the metrics", () => {
  for (const cmd of [
    "sed -n '1,80p' src/cart.ts",
    "cat README.md | head -20",
    "rg -n 'total|sum' src",
    "pwd && rg --files -g '!*node_modules*' | sed -n '1,160p'",
    "ls -la; find . -maxdepth 2 -type d",
    "cd shop && grep -rn total src/",
  ])
    assert.equal(reads(cmd), 1, cmd);
  const m = Lens.metrics(events([["bash", "cat src/cart.ts"], ["bash", "sed -n '1,40p' src/tax.ts"], WRITE]), cfg);
  assert.deepEqual([m.reads, m.edits, m.readEdit], [2, 1, 2]);
});

test("not a read: a command that writes, one mixed with another command, a web page", () => {
  for (const cmd of [
    "sed -i 's/3/4/' src/cart.ts",
    "sed -i.bak -n '1p' src/cart.ts",
    "cat src/cart.ts > /tmp/cart.ts",
    "find . -name '*.tmp' -delete",
    "find . -name '*.ts' -exec rm {} +",
    "npm install && cat package.json",
    "curl -sS https://shop.io | rg total",
    "python3 -c 'print(1)'",
  ])
    assert.equal(reads(cmd), 0, cmd);
});

test("peeked_at_src_before_plan: product code read through the shell before a plan (0.1.121)", () => {
  assert.deepEqual(peeked([TASK, ["bash", "sed -n '1,80p' src/cart.ts"], WRITE]), [PEEKED("src/cart.ts")]);
  assert.deepEqual(peeked([TASK, ["bash", "cat README.md && cat src/cart.ts | head -40"], WRITE]), [PEEKED("src/cart.ts")], "the product file of several");
  assert.deepEqual(peeked([TASK, ["bash", "rg -n total src"], WRITE]), [PEEKED("src")], "a source folder");
  assert.deepEqual(peeked([TASK, ["bash", "cat e2e/cart.spec.ts"], WRITE]), [], "test code");
  assert.deepEqual(peeked([TASK, ["bash", "rg -n 'src/cart' e2e"], WRITE]), [], "a quoted search pattern is not a path");
  assert.deepEqual(peeked([TASK, ["bash", "sed -i 's/3/4/' src/cart.ts"], WRITE]), [], "an edit, not a read");
  assert.deepEqual(peeked([TASK, ["say", "PLAN\n| R1 | e2e/cart.spec.ts |"], ["user", "ok"], ["bash", "cat src/cart.ts"], WRITE]), [], "after the approval");
});

test("Codex: a command in the exec harness that only reads is a read too", () => {
  const rec = (type, payload) => JSON.stringify({ timestamp: "", type, payload });
  const text = [
    rec("session_meta", { cwd: "/w" }),
    rec("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Write tests for the cart" }] }),
    rec("response_item", {
      type: "custom_tool_call",
      name: "exec",
      call_id: "c1",
      input: `const r = await tools.exec_command(${JSON.stringify({ cmd: "sed -n '1,120p' src/cart.ts", workdir: "/w" })});\ntext(r);\n`,
    }),
    rec("response_item", { type: "custom_tool_call_output", call_id: "c1", output: "export const total = 3;" }),
  ].join("\n");
  const ev = Lens.importAny(text, cfg);
  assert.equal(Lens.metrics(ev, cfg).reads, 1);
  assert.deepEqual(
    Lens.runChecks(ev, cfg)
      .filter((f) => f.check === "peeked_at_src_before_plan")
      .map((f) => f.message),
    [PEEKED("src/cart.ts")],
  );
});
