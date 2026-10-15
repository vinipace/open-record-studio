import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";

test("all tracks share one live output and cuts change only mixer gains", async () => {
  const source = stripTypeScriptTypes(
    (
      await fs.readFile(
        new URL("../src/media-audio.ts", import.meta.url),
        "utf8",
      )
    ).replace(/export /g, ""),
    { mode: "transform" },
  );
  const contexts = [],
    nodes = [];
  class Node {
    connections = [];
    disconnected = false;
    gain = { value: 1 };
    connect(node) {
      this.connections.push(node);
    }
    disconnect() {
      this.disconnected = true;
    }
  }
  class Context {
    state = "suspended";
    destination = {};
    resumes = 0;
    constructor() {
      contexts.push(this);
    }
    createMediaElementSource(el) {
      const node = new Node();
      node.element = el;
      nodes.push(node);
      return node;
    }
    createGain() {
      const node = new Node();
      nodes.push(node);
      return node;
    }
    resume() {
      this.resumes++;
      return Promise.resolve().then(() => {
        this.state = "running";
      });
    }
  }
  const c = vm.createContext({ AudioContext: Context });
  vm.runInContext(source + "\nglobalThis.MediaAudio=MediaAudio", c);
  const old = { volume: 0.5, muted: false },
    next = { volume: 0, muted: true };
  const a = new c.MediaAudio(old),
    b = new c.MediaAudio(next);
  assert.equal(contexts.length, 1);
  assert.equal(nodes[1].gain.value, 0);
  assert.equal(nodes[3].gain.value, 0);
  a.set(0.7);
  b.set(0);
  for (let i = 0; i < 20; i++) c.resumeMediaAudio();
  assert.equal(contexts[0].resumes, 1, "resume once while startup is pending");
  await new Promise((resolve) => setImmediate(resolve));
  a.set(0);
  b.set(0.7);
  c.resumeMediaAudio();
  assert.equal(contexts[0].resumes, 1, "cut never reopens the audio output");
  assert.equal(nodes[1].gain.value, 0);
  assert.equal(nodes[3].gain.value, 0.7);
  assert.deepEqual(old, { volume: 1, muted: false });
  assert.deepEqual(next, { volume: 1, muted: false });
  assert.equal(nodes[0].connections[0], nodes[1]);
  assert.equal(nodes[1].connections[0], contexts[0].destination);
  a.dispose();
  b.dispose();
  assert(
    nodes.every((n) => n.disconnected),
    "removing media disconnects its audio graph",
  );
});
