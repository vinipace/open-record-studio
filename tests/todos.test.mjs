import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TodoStore } from "../desktop/todo-store.mjs";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { call } from "./mcp-client.mjs";
const exec = promisify(execFile);

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "record-todos-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return {
    store: new TodoStore(directory),
    directory,
    cli: async (...args) => {
      const result = await exec(
        process.execPath,
        [path.resolve("mcp/cli.mjs"), "todos", ...args],
        { env: { ...process.env, OPEN_RECORD_STUDIO_TODO_DIR: directory } },
      );
      return JSON.parse(result.stdout);
    },
  };
}
test("CLI and independent stores share durable todos, copy references and reject stale updates", async (t) => {
  const { store, directory, cli } = await fixture(t);
  const source = path.join(directory, "A reference with spaces.png");
  await fs.copyFile("desktop/assets/demo-screen.png", source);
  const todo = await cli(
    "create",
    "--title",
    "Record the intro",
    "--instructions",
    "Line one\nLine two",
    "--attach",
    source,
  );
  await fs.unlink(source);
  assert.equal((await store.get(todo.id)).instructions, "Line one\nLine two");
  assert((await fs.stat(todo.attachments[0].path)).size > 0);
  const updated = await new TodoStore(directory).update(
    todo.id,
    todo.revision,
    { title: "New intro" },
  );
  assert.equal(updated.instructions, "Line one\nLine two");
  await assert.rejects(
    store.update(todo.id, undefined, { title: "No revision" }),
    { code: "TODO_CONFLICT" },
  );
  await assert.rejects(
    store.update(todo.id, todo.revision, { title: "Stale" }),
    { code: "TODO_CONFLICT" },
  );
  assert.equal((await cli("get", todo.id)).title, updated.title);
  await assert.rejects(cli("update", todo.id, "--title", "No revision"));
  await assert.rejects(
    cli("create", "--title", "Invalid", "--attach", "relative.mp4"),
  );
  await assert.rejects(cli("create", "--title", "Invalid", "--unknown", "x"));
});
test("concurrent CLI writers preserve all todos and ordered events", async (t) => {
  const { store, cli } = await fixture(t);
  const todos = await Promise.all(
    Array.from({ length: 8 }, (_, i) => cli("create", "--title", `Take ${i}`)),
  );
  assert.equal(new Set(todos.map((x) => x.id)).size, 8);
  assert.equal((await store.list()).todos.length, 8);
  const first = await store.events(0, 3),
    rest = await store.events(first.cursor);
  assert(first.has_more);
  assert.deepEqual(
    [...first.events, ...rest.events].map((e) => e.sequence),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  assert.equal(rest.has_more, false);
});

test("concurrent recovery of a crashed writer never removes a new writer's lock", async (t) => {
  const { directory } = await fixture(t);
  for (let round = 0; round < 6; round++) {
    const root = path.join(directory, String(round));
    await fs.mkdir(path.join(root, ".write-lock"), { recursive: true });
    await fs.writeFile(path.join(root, ".write-lock", "owner"), "99999999");
    const stores = Array.from({ length: 8 }, () => new TodoStore(root));
    await Promise.all(
      stores.map((store, i) => store.create({ title: `Recovered ${i}` })),
    );
    assert.equal((await stores[0].list()).todos.length, 8);
    assert.equal((await stores[0].events()).events.length, 8);
  }
});
test("recordings cannot be mutated or completed early; completion wakes waiters and persists selected paths", async (t) => {
  const { store, directory, cli } = await fixture(t);
  const todo = await store.create({ title: "Camera only" });
  await assert.rejects(
    store.complete(todo.id, todo.revision, "missing"),
    /Record and review/,
  );
  const rec = await store.begin(todo.id, todo.revision);
  const recording = await store.get(todo.id);
  await assert.rejects(
    store.update(todo.id, recording.revision, { status: "cancelled" }),
    { code: "TODO_BUSY" },
  );
  await assert.rejects(store.begin(todo.id, recording.revision), {
    code: "TODO_BUSY",
  });
  const camera = path.join(rec.directory, "camera.mkv");
  await fs.writeFile(camera, "test media placeholder");
  await fs.writeFile(path.join(rec.directory, "project.json"), "{}");
  const review = await store.finish(todo.id, rec.id, {
    camera_path: camera,
    project_path: rec.directory,
    duration: 9,
  });
  assert.equal((await store.wait(todo.id, { timeout: 5 })).status, "waiting");
  const wait = cli("wait", todo.id, "--timeout", "10");
  const done = await store.complete(
    todo.id,
    review.revision,
    rec.id,
    "Use this take",
  );
  assert.equal((await wait).todo.result.camera_path, camera);
  assert.equal((await new TodoStore(directory).get(todo.id)).status, "done");
  const events = await store.events();
  assert.equal(events.events.at(-1).type, "todo.done");
  assert.equal(events.events.at(-1).result.notes, "Use this take");
  await store.update(todo.id, done.revision, { status: "ready" });
  assert.equal((await store.events()).events.at(-2).result.camera_path, camera);
  await assert.rejects(store.finish(todo.id, rec.id, {}), {
    code: "TODO_CONFLICT",
  });
});
test("interrupted recordings preserve recovery files and allow another take; cancelled waits terminate", async (t) => {
  const { store, cli } = await fixture(t);
  const todo = await store.create({ title: "Recover me" }),
    rec = await store.begin(todo.id, todo.revision);
  await fs.writeFile(
    path.join(rec.directory, "camera.webm"),
    "partial capture",
  );
  const recovered = await store.interrupt(todo.id, rec.id, "Disk error");
  assert.equal(recovered.recovery.directory, rec.directory);
  assert.equal(
    await fs.readFile(path.join(rec.directory, "camera.webm"), "utf8"),
    "partial capture",
  );
  const next = await store.begin(todo.id, recovered.revision);
  assert.notEqual(next.directory, rec.directory);
  const ready = await store.interrupt(todo.id, next.id, "Stopped");
  await store.update(todo.id, ready.revision, { status: "cancelled" });
  await assert.rejects(
    cli("wait", todo.id),
    (e) => e.code === 3 && JSON.parse(e.stdout).status === "cancelled",
  );
});
test("MCP creates and updates todos without Electron; cancellation and timeout are observable", async (t) => {
  const { store, directory } = await fixture(t);
  const client = new Client({ name: "todo-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("mcp/server.mjs")],
    env: { ...process.env, OPEN_RECORD_STUDIO_TODO_DIR: directory },
    stderr: "pipe",
  });
  await client.connect(transport);
  t.after(() => client.close());
  const tools = (await client.listTools()).tools;
  for (const name of [
    "create_todo",
    "get_todo",
    "list_todos",
    "update_todo",
    "complete_todo",
    "todo_events",
    "wait_for_todo",
  ])
    assert(tools.some((x) => x.name === name));
  const todo = await call(client, "create_todo", { title: "From Claude" });
  assert.equal((await store.get(todo.id)).title, "From Claude");
  assert.equal(
    (
      await call(client, "wait_for_todo", {
        todo_id: todo.id,
        timeout_seconds: 0.1,
      })
    ).status,
    "waiting",
  );
  const waiting = call(client, "wait_for_todo", {
    todo_id: todo.id,
    timeout_seconds: 5,
  });
  await store.update(todo.id, todo.revision, { status: "cancelled" });
  assert.equal((await waiting).status, "cancelled");
  const bad = await client.callTool({
    name: "update_todo",
    arguments: {
      todo_id: todo.id,
      expected_revision: todo.revision,
      changes: { title: "Stale" },
    },
  });
  assert.equal(bad.isError, true);
  assert.equal(bad.structuredContent.error.code, "TODO_CONFLICT");
  assert.equal((await call(client, "todo_events", {})).events.length, 2);
});

test("timestamped comments preserve source identity, concurrent feedback and resolution history", async (t) => {
  const { store, directory } = await fixture(t);
  const todo = await store.create({
    title: "Annotated image",
    attachments: [path.resolve("desktop/assets/demo-screen.png")],
  });
  const input = {
    media_type: "attachment",
    media_id: todo.attachments[0].id,
    timestamp_seconds: 0,
    text: "Change the title",
  };
  // Old inbox files have no comments field.
  await store.transaction((data) => {
    delete data.todos[0].comments;
  });
  assert.deepEqual((await store.get(todo.id)).comments, []);
  await assert.rejects(
    store.addComment(todo.id, { ...input, timestamp_seconds: 1 }),
    /outside/,
  );
  await assert.rejects(
    store.addComment(todo.id, { ...input, timestamp_seconds: -1 }),
    /nonnegative/,
  );
  await assert.rejects(
    store.addComment(todo.id, { ...input, timestamp_seconds: Infinity }),
    /nonnegative/,
  );
  await assert.rejects(
    store.addComment(todo.id, { ...input, media_id: "foreign-media" }),
    /does not belong/,
  );
  await assert.rejects(
    store.addComment(todo.id, { ...input, text: "  " }),
    /comment/,
  );
  await assert.rejects(
    store.addComment(todo.id, { ...input, path: "/tmp/other" }),
    /Supply/,
  );
  const added = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      new TodoStore(directory).addComment(
        todo.id,
        { ...input, text: `Feedback ${i}` },
        "user",
      ),
    ),
  );
  assert.equal((await store.comments(todo.id)).comments.length, 8);
  const comment = added[0].comment;
  assert.equal(comment.media.path, todo.attachments[0].path);
  const resolved = await store.updateComment(
    todo.id,
    comment.id,
    1,
    "resolved",
    "Adjusted the title",
  );
  assert.equal(resolved.comment.resolution, "Adjusted the title");
  await assert.rejects(store.updateComment(todo.id, comment.id, 1, "open"), {
    code: "TODO_CONFLICT",
  });
  const reopened = await store.updateComment(todo.id, comment.id, 2, "open");
  assert.equal(reopened.comment.resolution, "");
  const events = (await store.events()).events;
  assert.equal(
    events.find(
      (e) => e.type === "todo.comment_added" && e.comment.id === comment.id,
    ).comment.status,
    "open",
  );
  assert.equal(
    events.find((e) => e.type === "todo.comment_resolved").comment.resolution,
    "Adjusted the title",
  );
  const rec = await store.begin(todo.id, (await store.get(todo.id)).revision);
  await store.finish(todo.id, rec.id, {
    camera_path: path.join(rec.directory, "camera.mkv"),
    duration: 9,
  });
  const takeInput = {
    ...input,
    media_type: "take",
    media_id: rec.id,
    timestamp_seconds: 8.75,
  };
  const takeComment = await store.addComment(todo.id, takeInput);
  assert.equal(takeComment.comment.media.name, "Take 1");
  assert.equal(takeComment.comment.timestamp_seconds, 8.75);
  await assert.rejects(
    store.addComment(todo.id, { ...takeInput, timestamp_seconds: 9.1 }),
    /outside/,
  );
  assert.equal(
    (await new TodoStore(directory).comments(todo.id)).comments.length,
    9,
  );
});

test("comment waits filter by todo, replay durably, paginate and abort without losing events", async (t) => {
  const { store } = await fixture(t);
  const a = await store.create({
    title: "A",
    attachments: [path.resolve("desktop/assets/demo-screen.png")],
  });
  const b = await store.create({
    title: "B",
    attachments: [path.resolve("desktop/assets/demo-screen.png")],
  });
  const input = (todo) => ({
    media_type: "attachment",
    media_id: todo.attachments[0].id,
    timestamp_seconds: 0,
    text: "Feedback",
  });
  const cursor = (await store.comments(a.id)).cursor;
  await store.addComment(b.id, input(b));
  assert.equal(
    (await store.waitComments(a.id, cursor, { timeout: 5 })).status,
    "waiting",
  );
  const controller = new AbortController();
  const waiting = store.waitComments(a.id, cursor, {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  for (let i = 0; i < 102; i++)
    await store.addComment(a.id, { ...input(a), text: `Comment ${i}` });
  const first = await store.waitComments(a.id, cursor),
    rest = await store.waitComments(a.id, first.cursor);
  assert.equal(first.events.length, 100);
  assert.equal(first.has_more, true);
  assert.equal(rest.events.length, 2);
  assert.equal(rest.has_more, false);
  assert.equal(
    new Set([...first.events, ...rest.events].map((e) => e.comment.id)).size,
    102,
  );
  const comment = first.events[0].comment;
  await store.updateComment(a.id, comment.id, 1, "resolved");
  const reopening = store.waitComments(a.id, rest.cursor);
  await store.updateComment(a.id, comment.id, 2, "open");
  assert.equal((await reopening).events[0].type, "todo.comment_reopened");
  await assert.rejects(store.waitComments(a.id, -1), /Invalid/);
});

test("real MCP and CLI comment waiters receive feedback with the app absent", async (t) => {
  const { store, directory, cli } = await fixture(t);
  const client = new Client({ name: "comments-test", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve("mcp/server.mjs")],
      env: { ...process.env, OPEN_RECORD_STUDIO_TODO_DIR: directory },
      stderr: "pipe",
    }),
  );
  t.after(() => client.close());
  const todo = await call(client, "create_todo", {
    title: "Feedback",
    attachments: [path.resolve("desktop/assets/demo-screen.png")],
  });
  const { cursor } = await call(client, "list_todo_comments", {
    todo_id: todo.id,
  });
  const mcpWait = call(client, "wait_for_todo_comments", {
    todo_id: todo.id,
    after: cursor,
    timeout_seconds: 5,
  });
  const cliWait = cli(
    "wait-comments",
    todo.id,
    "--after",
    String(cursor),
    "--timeout",
    "5",
  );
  const posted = await store.addComment(
    todo.id,
    {
      media_type: "attachment",
      media_id: todo.attachments[0].id,
      timestamp_seconds: 0,
      text: "Move this caption",
    },
    "user",
  );
  const [mcpResult, cliResult] = await Promise.all([mcpWait, cliWait]);
  assert.equal(mcpResult.events[0].comment.id, posted.comment.id);
  assert.equal(
    cliResult.events[0].comment.media.path,
    todo.attachments[0].path,
  );
  assert.equal(cliResult.events[0].comment.author, "user");
  await call(client, "update_todo_comment", {
    todo_id: todo.id,
    comment_id: posted.comment.id,
    expected_revision: 1,
    status: "resolved",
    resolution: "Moved to the lower third",
  });
  assert.equal(
    (await cli("comments", todo.id, "--status", "resolved")).comments[0]
      .resolution,
    "Moved to the lower third",
  );
  const agent = await call(client, "add_todo_comment", {
    todo_id: todo.id,
    media_type: "attachment",
    media_id: todo.attachments[0].id,
    timestamp_seconds: 0,
    text: "Please review the new caption",
  });
  assert.equal(agent.comment.author, "agent");
  await cli(
    "resolve-comment",
    todo.id,
    "--comment",
    agent.comment.id,
    "--revision",
    "1",
  );
  await assert.rejects(
    cli(
      "wait-comments",
      todo.id,
      "--after",
      String((await store.comments(todo.id)).cursor),
      "--timeout",
      "0.01",
    ),
    (error) => error.code === 2,
  );
  const bad = await client.callTool({
    name: "add_todo_comment",
    arguments: {
      todo_id: todo.id,
      media_type: "attachment",
      media_id: todo.attachments[0].id,
      timestamp_seconds: -1,
      text: "Invalid",
    },
  });
  assert.equal(bad.isError, true);
});
