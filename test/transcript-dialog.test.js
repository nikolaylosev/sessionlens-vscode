"use strict";
/* Where the "choose a transcript" dialog opens (open:transcript) for each answer to "Where is the transcript from?":
   the real extension.js under the fake "vscode" module, with a temporary home. Cursor (0.1.121) opens this workspace's
   ~/.cursor/projects/<slug>/agent-transcripts, the slug named the way Cursor's CLI names it. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { fakeVscode, loadExtension, fakeContext, fakeWebviewView } = require("./fake-vscode");

// the folder the dialog was opened at, for `source`, with these workspace folders, in the home `h`
async function dialogFolder(h, source, folders) {
  const env = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = h; // os.homedir() reads these
  process.env.USERPROFILE = h;
  try {
    const { vscode, registered, calls } = fakeVscode({
      workspaceFolders: folders && folders.map((p) => ({ uri: { scheme: "file", fsPath: p } })),
    });
    loadExtension(vscode).activate(fakeContext({ globalState: { settings: {}, sessions: {} } }));
    const wv = fakeWebviewView();
    registered.views.sessionlensView.resolveWebviewView(wv.view);
    assert.equal(await wv.send("open:transcript", source ? { source } : {}), null); // the dialog was cancelled
    assert.equal(calls.openDialog.length, 1);
    return calls.openDialog[0].defaultUri.fsPath;
  } finally {
    for (const k of Object.keys(env))
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
  }
}
const home = () => fs.mkdtempSync(path.join(os.tmpdir(), "sl-dialog-"));
const mk = (...p) => {
  fs.mkdirSync(path.join(...p), { recursive: true });
  return path.join(...p);
};

test("Cursor Agent: the workspace's agent-transcripts, its name as Cursor's CLI makes it", async () => {
  const h = home();
  const want = mk(h, ".cursor", "projects", "Users-me-my-app-v2", "agent-transcripts");
  mk(h, ".cursor", "projects", "Users-me-other", "agent-transcripts");
  assert.equal(await dialogFolder(h, "cursor", ["/Users/me/my_app.v2/"]), want); // "_", "." and the last "/" too
});

test("Cursor Agent: the first workspace folder that has one", async () => {
  const h = home();
  const want = mk(h, ".cursor", "projects", "Users-me-api", "agent-transcripts");
  assert.equal(await dialogFolder(h, "cursor", ["/Users/me/web", "/Users/me/api"]), want);
});

test("Cursor Agent: a workspace opened through a symlink is found by its real path", { skip: process.platform === "win32" && "symlinks" }, async () => {
  const h = home();
  const real = mk(h, "real", "shop");
  const link = path.join(h, "link");
  fs.symlinkSync(path.join(h, "real"), link);
  const slug = fs
    .realpathSync(real)
    .replace(/[^a-zA-Z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  const want = mk(h, ".cursor", "projects", slug, "agent-transcripts");
  assert.equal(await dialogFolder(h, "cursor", [path.join(link, "shop")]), want);
});

test("Cursor Agent: no folder for this workspace → ~/.cursor/projects; no Cursor at all → the home folder", async () => {
  const h = home();
  assert.equal(await dialogFolder(h, "cursor", ["/Users/me/shop"]), h);
  const projects = mk(h, ".cursor", "projects");
  assert.equal(await dialogFolder(h, "cursor", ["/Users/me/shop"]), projects);
  assert.equal(await dialogFolder(h, "cursor", undefined), projects); // no workspace open
});

test("Claude Code, Codex and somewhere else open where they did before", async () => {
  const h = home();
  assert.equal(await dialogFolder(h, "claude"), h);
  assert.equal(await dialogFolder(h, "codex"), h);
  const claude = mk(h, ".claude", "projects");
  const codex = mk(h, ".codex", "sessions");
  mk(h, ".cursor", "projects");
  assert.equal(await dialogFolder(h, "claude"), claude);
  assert.equal(await dialogFolder(h, "codex"), codex);
  assert.equal(await dialogFolder(h, undefined), h);
});
