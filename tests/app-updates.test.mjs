import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import {
  createAppUpdater,
  readUpdatePreferences,
  saveUpdatePreferences,
} from "../desktop/app-updates.mjs";
import {
  compareVersions,
  selectUpdate,
  createUpdateManifest,
  validateUpdateManifest,
  updateZipName,
  updateManifestName,
} from "../desktop/update-feed.mjs";
const digest = "a".repeat(64);
function release(version, extra = {}) {
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: true,
    assets: [
      {
        name: updateZipName(version),
        state: "uploaded",
        size: 500,
        digest: `sha256:${digest}`,
      },
      { name: updateManifestName, state: "uploaded" },
    ],
    ...extra,
  };
}
const manifest = (version = "0.5.0") =>
  createUpdateManifest({ version, sha256: digest, size: 500 });
function setup({
  releases = [release("0.5.0")],
  feed = manifest(),
  fetcher,
  supported = true,
} = {}) {
  const native = new EventEmitter(),
    calls = [],
    states = [];
  let blocker = "";
  native.setFeedURL = (options) => calls.push(["feed", options]);
  native.checkForUpdates = () => calls.push(["download"]);
  native.quitAndInstall = () => calls.push(["install"]);
  const updater = createAppUpdater({
    nativeUpdater: native,
    version: "0.4.0",
    supported,
    getBlocker: () => blocker,
    onChange: (s) => states.push(s),
    logger: { warn() {} },
    fetcher:
      fetcher ||
      (async (url) =>
        new Response(
          JSON.stringify(url.includes("api.github.com") ? releases : feed),
        )),
  });
  return {
    updater,
    native,
    calls,
    states,
    block: (reason) => {
      blocker = reason;
    },
  };
}
test("release selection compares numeric versions, ignores drafts and downgrades, and respects preview choice", () => {
  const releases = [
    release("0.10.0"),
    release("0.9.0", { prerelease: false }),
    release("2.0.0", { draft: true }),
    release("0.11.0-beta.1"),
  ];
  assert.equal(compareVersions("0.10.0", "0.9.0"), 1);
  assert.equal(selectUpdate(releases, "0.4.0").version, "0.10.0");
  assert.equal(selectUpdate(releases, "0.4.0", false).version, "0.9.0");
  assert.equal(selectUpdate(releases, "0.10.0"), null);
  assert.equal(selectUpdate([release("0.4.0")], "0.4.0"), null);
  assert.throws(() => compareVersions("garbage", "0.4.0"));
  const missing = selectUpdate(
    [release("0.6.0", { assets: [] }), release("0.5.0")],
    "0.4.0",
  );
  assert.equal(missing.version, "0.6.0");
  assert.equal(missing.automatic, false);
});
test("release metadata pins version, GitHub ZIP URL, digest and size", () => {
  const selected = selectUpdate([release("0.5.0")], "0.4.0");
  const expected = manifest();
  assert.deepEqual(validateUpdateManifest(expected, selected), expected);
  for (const change of [
    (m) => (m.currentRelease = "0.3.0"),
    (m) => m.releases.push(m.releases[0]),
    (m) => (m.releases[0].updateTo.url = "https://example.org/app.zip"),
    (m) => (m.releases[0].updateTo.sha256 = "b".repeat(64)),
    (m) => (m.releases[0].updateTo.size = 1),
    (m) =>
      (m.releases[0].updateTo.delta = { url: "https://example.org/patch" }),
  ]) {
    const m = manifest();
    change(m);
    assert.throws(() => validateUpdateManifest(m, selected));
  }
  assert.throws(() =>
    createUpdateManifest({ version: "0.5.0", sha256: "bad", size: 5 }),
  );
});
test("checks never download automatically; explicit download verifies feed before native updater and restart waits for ready", async () => {
  const { updater, native, calls, block } = setup();
  assert.equal((await updater.check()).status, "available");
  assert.equal(calls.length, 0);
  assert.throws(() => updater.install(), /Download/);
  await updater.download();
  assert.equal(updater.getState().status, "downloading");
  assert.deepEqual(
    calls.map((c) => c[0]),
    ["feed", "download"],
  );
  assert.equal(calls[0][1].serverType, "json");
  assert.throws(() => updater.setIncludePreviews(false), /Finish/);
  native.emit("update-downloaded", {});
  assert.equal(updater.getState().status, "ready");
  block("Recording is active");
  assert.throws(() => updater.install(), /Recording/);
  assert.equal(calls.filter((c) => c[0] === "install").length, 0);
  block("");
  updater.install();
  assert.equal(updater.getState().status, "installing");
  assert.equal(calls.filter((c) => c[0] === "install").length, 1);
  updater.dispose();
});
test("invalid feed and native signature errors never become installable; retry remains possible", async () => {
  const bad = manifest();
  bad.releases[0].updateTo.sha256 = "0".repeat(64);
  const { updater, native, calls } = setup({ feed: bad });
  await updater.check();
  await updater.download();
  assert.equal(calls.length, 0);
  assert.equal(updater.getState().status, "error");
  assert.throws(() => updater.install());
  updater.dispose();
  const good = setup();
  await good.updater.check();
  await good.updater.download();
  good.native.emit("error", new Error("Signature mismatch"));
  assert.equal(good.updater.getState().status, "error");
  assert.throws(() => good.updater.install());
  assert.equal((await good.updater.check()).status, "available");
  good.updater.dispose();
});
test("busy and unsupported apps cannot begin checks or download", async () => {
  const one = setup();
  one.block("Exporting");
  await assert.rejects(one.updater.check(), /Exporting/);
  assert.equal(one.calls.length, 0);
  one.updater.dispose();
  const two = setup({ supported: false });
  await assert.rejects(two.updater.check(), /installed/);
  two.updater.dispose();
});
test("concurrent checks coalesce and a channel change discards late responses", async () => {
  let finish,
    count = 0;
  const { updater } = setup({
    fetcher: async () => {
      count++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  const first = updater.check();
  await updater.check();
  assert.equal(count, 1);
  updater.setIncludePreviews(false);
  finish(new Response(JSON.stringify([release("0.5.0")])));
  await first;
  assert.equal(updater.getState().status, "idle");
  assert.equal(updater.getState().version, undefined);
  updater.dispose();
});
test("preview preference survives restart and missing preferences follow the current preview channel", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "frame-update-prefs-"));
  try {
    assert.equal((await readUpdatePreferences(root)).includePreviews, true);
    await saveUpdatePreferences(root, false);
    assert.equal((await readUpdatePreferences(root)).includePreviews, false);
    await assert.rejects(saveUpdatePreferences(root, "yes"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
const source = stripTypeScriptTypes(
  (
    await fs.readFile(new URL("../src/app-updates.ts", import.meta.url), "utf8")
  ).replaceAll("export ", ""),
  { mode: "transform" },
);
test("menu and button restart requests protect unsaved edits and active work, while update status stays nonmodal", async () => {
  const button = {},
    state = {
      recording: false,
      busy: false,
      dirty: false,
      saving: false,
      renaming: false,
    },
    errors = [],
    locks = [];
  let onState,
    onInstall,
    installs = 0;
  const api = {
    onAppUpdate: (fn) => {
      onState = fn;
    },
    onInstallAppUpdate: (fn) => {
      onInstall = fn;
    },
    appUpdateState: async () => ({ status: "idle" }),
    installAppUpdate: async () => {
      installs++;
    },
    checkAppUpdate: async () => {},
  };
  vm.runInNewContext(
    `${source}; connectAppUpdates(button,{activity:()=>state,lock:v=>locks.push(v),error:e=>errors.push(e.message)},api)`,
    { button, state, locks, errors, api },
  );
  onState({ status: "available", version: "0.5.0" });
  assert.equal(button.hidden, false);
  onState({ status: "downloading", version: "0.5.0" });
  assert.equal(button.disabled, true);
  onState({ status: "ready", version: "0.5.0" });
  assert.equal(button.textContent, "Restart to update");
  for (const key of Object.keys(state)) {
    state[key] = true;
    onInstall();
    button.onclick();
    state[key] = false;
  }
  assert.equal(installs, 0);
  assert.equal(errors.length, 10);
  onInstall();
  await new Promise(setImmediate);
  assert.equal(installs, 1);
  assert.deepEqual(locks, [true, false]);
  assert.equal(
    button.textContent,
    "Restart to update",
    "late initial idle snapshot does not overwrite ready",
  );
});
