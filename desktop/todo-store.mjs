import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

function validateInput(input, patch = false) {
  const allowed = patch
    ? ["title", "instructions", "status"]
    : ["title", "instructions", "attachments"];
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((k) => !allowed.includes(k))
  )
    throw fail("Invalid recording todo fields");
  const values = { ...input };
  if (!patch || values.title !== undefined) {
    if (
      typeof values.title !== "string" ||
      !values.title.trim() ||
      values.title.trim().length > 160
    )
      throw fail("Use a title of 1–160 characters");
    values.title = values.title.trim();
  }
  if (!patch) {
    values.instructions ??= "";
    values.attachments ??= [];
  }
  if (
    values.instructions !== undefined &&
    (typeof values.instructions !== "string" ||
      values.instructions.length > 20000)
  )
    throw fail("Instructions must be text of at most 20000 characters");
  if (
    values.attachments !== undefined &&
    (!Array.isArray(values.attachments) ||
      values.attachments.length > 20 ||
      values.attachments.some(
        (p) => typeof p !== "string" || !path.isAbsolute(p),
      ))
  )
    throw fail("Use up to 20 absolute local attachment paths");
  if (
    values.status !== undefined &&
    !["ready", "cancelled"].includes(values.status)
  )
    throw fail("Status must be ready or cancelled");
  return values;
}
const extensions = new Map([
  ...[".png", ".jpg", ".jpeg", ".webp"].map((ext) => [ext, "image"]),
  ...[".mp4", ".mov", ".m4v", ".webm", ".mkv"].map((ext) => [ext, "video"]),
  ...[".mp3", ".wav", ".m4a", ".ogg", ".flac"].map((ext) => [ext, "audio"]),
]);
export function todoDirectory() {
  if (process.env.OPEN_RECORD_STUDIO_TODO_DIR)
    return path.resolve(process.env.OPEN_RECORD_STUDIO_TODO_DIR);
  const profile =
    process.env.FRAME_DATA_DIR ||
    path.join(
      process.platform === "darwin"
        ? path.join(os.homedir(), "Library/Application Support")
        : process.platform === "win32"
          ? process.env.APPDATA || os.homedir()
          : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
      "Frame Studio",
    );
  return path.join(profile, "recording-todos");
}
const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
};
const fail = (message, code = "INVALID_TODO") =>
  Object.assign(new Error(message), { code });
function commentMedia(todo, type, id) {
  if (type === "attachment") {
    const media = todo.attachments.find((a) => a.id === id);
    if (media)
      return { id, type, name: media.name, kind: media.kind, path: media.path };
  } else if (type === "take") {
    const index = todo.takes.findIndex((t) => t.id === id);
    const take = todo.takes[index];
    if (take)
      return {
        id,
        type,
        name: `Take ${index + 1}`,
        kind: "video",
        path: take.camera_path,
        duration: take.duration,
      };
  }
  throw fail("Comment media does not belong to this todo");
}
const publicComment = (todo, comment) => ({
  ...comment,
  media: commentMedia(todo, comment.media_type, comment.media_id),
});
const publicTodo = (todo) => ({
  ...todo,
  comments: (todo.comments || []).map((comment) =>
    publicComment(todo, comment),
  ),
  ...(todo.status === "recording" && !alive(todo.recording?.pid)
    ? { status: "interrupted" }
    : {}),
});

export class TodoStore {
  constructor(directory = todoDirectory()) {
    this.directory = directory;
  }
  async read() {
    try {
      const data = JSON.parse(
        await fs.readFile(path.join(this.directory, "inbox.json"), "utf8"),
      );
      if (
        data.version !== 1 ||
        !Array.isArray(data.todos) ||
        !Array.isArray(data.events)
      )
        throw fail("Unsupported recording inbox format");
      return data;
    } catch (error) {
      if (error.code === "ENOENT")
        return { version: 1, sequence: 0, todos: [], events: [] };
      throw error;
    }
  }
  async transaction(change) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lock = path.join(this.directory, ".write-lock");
    const deadline = Date.now() + 4000;
    for (;;) {
      try {
        await fs.mkdir(lock);
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const owner = await fs
          .readFile(path.join(lock, "owner"), "utf8")
          .then(Number)
          .catch(() => null);
        const stat = await fs.stat(lock).catch(() => null);
        if (
          (owner && !alive(owner)) ||
          (!owner && stat && Date.now() - stat.mtimeMs > 30000)
        ) {
          // Serialize recovery separately from writing. Two clients that both
          // observed the old lock must not remove a newly acquired writer's lock.
          const recovery = path.join(this.directory, ".lock-recovery");
          const claimed = await fs.mkdir(recovery).then(
            () => true,
            (error) => {
              if (error.code === "EEXIST") return false;
              throw error;
            },
          );
          if (claimed) {
            try {
              const currentOwner = await fs
                .readFile(path.join(lock, "owner"), "utf8")
                .then(Number)
                .catch(() => null);
              const currentStat = await fs.stat(lock).catch(() => null);
              if (
                (currentOwner && !alive(currentOwner)) ||
                (!currentOwner &&
                  currentStat &&
                  Date.now() - currentStat.mtimeMs > 30000)
              )
                await fs.rm(lock, { recursive: true, force: true });
            } finally {
              await fs.rmdir(recovery);
            }
          }
        }
        if (Date.now() > deadline)
          throw fail("Recording inbox is busy. Retry shortly.", "TODO_BUSY");
        await delay(25);
      }
    }
    const temp = path.join(this.directory, `inbox.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(path.join(lock, "owner"), String(process.pid));
      const data = await this.read();
      const result = await change(data);
      const file = await fs.open(temp, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(data, null, 2) + "\n");
        await file.sync();
      } finally {
        await file.close();
      }
      await fs.rename(temp, path.join(this.directory, "inbox.json"));
      return result;
    } finally {
      await fs.rm(temp, { force: true });
      await fs.rm(lock, { recursive: true, force: true });
    }
  }
  event(data, todo, type, details = {}) {
    todo.revision++;
    todo.updated_at = new Date().toISOString();
    const event = {
      sequence: ++data.sequence,
      type,
      todo_id: todo.id,
      revision: todo.revision,
      at: todo.updated_at,
      ...structuredClone(details),
    };
    if (type === "todo.done") event.result = structuredClone(todo.result);
    data.events.push(event);
  }
  find(data, id, revision) {
    const todo = data.todos.find((t) => t.id === id);
    if (!todo) throw fail("Recording todo not found", "TODO_NOT_FOUND");
    if (revision !== undefined && todo.revision !== revision)
      throw fail(
        "Todo changed. Read it again before retrying.",
        "TODO_CONFLICT",
      );
    return todo;
  }
  requireRevision(revision) {
    if (!Number.isSafeInteger(revision) || revision < 1)
      throw fail("Supply the latest todo revision", "TODO_CONFLICT");
  }
  async list(status) {
    const data = await this.read();
    return {
      todos: data.todos
        .map(publicTodo)
        .filter((t) => !status || t.status === status)
        .reverse(),
      cursor: data.sequence,
      directory: this.directory,
    };
  }
  async get(id) {
    return publicTodo(this.find(await this.read(), id));
  }
  async create(input) {
    const values = validateInput(input);
    const id = randomUUID();
    const directory = path.join(this.directory, id, "attachments");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const attachments = [];
    try {
      for (const source of values.attachments) {
        const ext = path.extname(source).toLowerCase(),
          kind = extensions.get(ext);
        if (!kind || !(await fs.stat(source)).isFile())
          throw fail("Attach a local video, image, or audio file");
        const attachmentId = randomUUID(),
          file = path.join(directory, attachmentId + ext);
        await fs.copyFile(source, file, fs.constants.COPYFILE_EXCL);
        attachments.push({
          id: attachmentId,
          name: path.basename(source),
          kind,
          path: file,
        });
      }
      return await this.transaction((data) => {
        const todo = {
          id,
          title: values.title,
          instructions: values.instructions,
          attachments,
          status: "ready",
          revision: 0,
          created_at: new Date().toISOString(),
          takes: [],
          comments: [],
        };
        data.todos.push(todo);
        this.event(data, todo, "todo.created");
        return publicTodo(todo);
      });
    } catch (error) {
      await fs.rm(path.dirname(directory), { recursive: true, force: true });
      throw error;
    }
  }
  async update(id, revision, changes) {
    this.requireRevision(revision);
    const patch = validateInput(changes, true);
    if (!Object.keys(patch).length) throw fail("Supply at least one change");
    return this.transaction((data) => {
      const todo = this.find(data, id, revision);
      if (todo.status === "recording" && alive(todo.recording?.pid))
        throw fail("Finish recording before changing this todo", "TODO_BUSY");
      Object.assign(todo, patch);
      if (patch.status) {
        delete todo.result;
        delete todo.completed_at;
      }
      this.event(data, todo, "todo.updated");
      return publicTodo(todo);
    });
  }
  async begin(id, revision) {
    this.requireRevision(revision);
    return this.transaction(async (data) => {
      const todo = this.find(data, id, revision);
      if (!["ready", "review", "interrupted"].includes(publicTodo(todo).status))
        throw fail("This todo is not ready to record", "TODO_BUSY");
      const session = randomUUID();
      if (todo.status === "recording")
        todo.recovery = {
          ...todo.recording,
          message:
            "The previous recording process stopped. Captured files are kept for recovery.",
        };
      const directory = path.join(
        this.directory,
        id,
        "takes",
        session + ".framestudio",
      );
      await fs.mkdir(directory, { recursive: true });
      todo.recording = { id: session, pid: process.pid, directory };
      todo.status = "recording";
      this.event(data, todo, "todo.recording");
      return { ...todo.recording, title: todo.title };
    });
  }
  async finish(id, session, take) {
    return this.transaction((data) => {
      const todo = this.find(data, id);
      if (todo.status !== "recording" || todo.recording?.id !== session)
        throw fail("Recording session changed", "TODO_CONFLICT");
      todo.takes.push({
        ...take,
        id: session,
        created_at: new Date().toISOString(),
      });
      todo.status = "review";
      delete todo.recording;
      this.event(data, todo, "todo.recorded");
      return publicTodo(todo);
    });
  }
  async interrupt(id, session, message) {
    return this.transaction((data) => {
      const todo = this.find(data, id);
      if (todo.recording?.id !== session) return publicTodo(todo);
      todo.recovery = { ...todo.recording, message };
      delete todo.recording;
      todo.status = todo.takes.length ? "review" : "ready";
      this.event(data, todo, "todo.interrupted");
      return publicTodo(todo);
    });
  }
  async complete(id, revision, takeId, notes = "") {
    this.requireRevision(revision);
    if (typeof notes !== "string" || notes.length > 20000)
      throw fail("Completion notes are too long");
    return this.transaction(async (data) => {
      const todo = this.find(data, id, revision);
      if (todo.status !== "review")
        throw fail("Record and review a take before marking done");
      const take = todo.takes.find((t) => t.id === takeId);
      if (!take) throw fail("Choose a saved take");
      await fs.access(take.camera_path);
      await fs.access(path.join(take.project_path, "project.json"));
      todo.result = { ...take, notes };
      todo.status = "done";
      todo.completed_at = new Date().toISOString();
      this.event(data, todo, "todo.done");
      return publicTodo(todo);
    });
  }
  async events(after = 0, limit = 100) {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 500
    )
      throw fail("Invalid event cursor or limit");
    const data = await this.read(),
      events = data.events.filter((e) => e.sequence > after).slice(0, limit);
    return {
      events,
      cursor: events.at(-1)?.sequence ?? after,
      has_more: (events.at(-1)?.sequence ?? after) < data.sequence,
    };
  }
  async comments(id, status) {
    if (status !== undefined && !["open", "resolved"].includes(status))
      throw fail("Comment status must be open or resolved");
    const data = await this.read(),
      todo = this.find(data, id);
    return {
      comments: (todo.comments || [])
        .filter((c) => !status || c.status === status)
        .map((c) => publicComment(todo, c)),
      cursor: data.sequence,
    };
  }
  async addComment(id, input, author = "agent") {
    const allowed = ["media_type", "media_id", "timestamp_seconds", "text"];
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => !allowed.includes(key)) ||
      !["attachment", "take"].includes(input.media_type) ||
      typeof input.media_id !== "string" ||
      !Number.isFinite(input.timestamp_seconds) ||
      input.timestamp_seconds < 0 ||
      typeof input.text !== "string" ||
      !input.text.trim() ||
      input.text.trim().length > 5000 ||
      !["user", "agent"].includes(author)
    )
      throw fail(
        "Supply media, a nonnegative timestamp and a comment of 1–5000 characters",
      );
    // Probe outside the write lock. Media IDs and copied sources are immutable.
    const media = commentMedia(
      await this.get(id),
      input.media_type,
      input.media_id,
    );
    const duration =
      media.kind === "image"
        ? 0
        : (media.duration ??
          (await (await import("./media.mjs")).probe(media.path)).duration);
    if (
      !Number.isFinite(duration) ||
      input.timestamp_seconds > duration + 0.001
    )
      throw fail("Comment timestamp is outside this media's duration");
    return this.transaction((data) => {
      const todo = this.find(data, id),
        at = new Date().toISOString();
      const comment = {
        ...input,
        text: input.text.trim(),
        id: randomUUID(),
        author,
        status: "open",
        revision: 1,
        created_at: at,
        updated_at: at,
      };
      (todo.comments ||= []).push(comment);
      const result = publicComment(todo, comment);
      this.event(data, todo, "todo.comment_added", { comment: result });
      return { comment: result, cursor: data.sequence };
    });
  }
  async updateComment(id, commentId, revision, status, resolution = "") {
    this.requireRevision(revision);
    if (
      !["open", "resolved"].includes(status) ||
      typeof resolution !== "string" ||
      resolution.length > 5000
    )
      throw fail(
        "Use comment status open or resolved and a resolution of at most 5000 characters",
      );
    return this.transaction((data) => {
      const todo = this.find(data, id),
        comment = todo.comments?.find((c) => c.id === commentId);
      if (!comment) throw fail("Comment not found", "COMMENT_NOT_FOUND");
      if (comment.revision !== revision)
        throw fail(
          "Comment changed. Read it again before retrying.",
          "TODO_CONFLICT",
        );
      comment.status = status;
      comment.resolution = status === "resolved" ? resolution.trim() : "";
      comment.updated_at = new Date().toISOString();
      comment.revision++;
      const result = publicComment(todo, comment);
      this.event(
        data,
        todo,
        status === "resolved"
          ? "todo.comment_resolved"
          : "todo.comment_reopened",
        { comment: result },
      );
      return { comment: result, cursor: data.sequence };
    });
  }
  async waitComments(id, after = 0, { timeout = 30000, signal } = {}) {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isFinite(timeout) ||
      timeout < 0
    )
      throw fail("Invalid comment cursor or wait timeout");
    const deadline = timeout ? Date.now() + timeout : Infinity;
    for (;;) {
      signal?.throwIfAborted();
      const data = await this.read();
      this.find(data, id);
      const matches = data.events.filter(
        (e) =>
          e.sequence > after &&
          e.todo_id === id &&
          ["todo.comment_added", "todo.comment_reopened"].includes(e.type),
      );
      const events = matches.slice(0, 100);
      const result = {
        status: events.length ? "comments" : "waiting",
        events,
        cursor:
          matches.length > 100
            ? events.at(-1).sequence
            : Math.max(after, data.sequence),
        has_more: matches.length > 100,
      };
      if (events.length || Date.now() >= deadline) return result;
      await delay(Math.min(300, deadline - Date.now()), undefined, { signal });
    }
  }
  async wait(id, { timeout = 30000, signal } = {}) {
    if (!Number.isFinite(timeout) || timeout < 0)
      throw fail("Invalid wait timeout");
    const deadline = timeout ? Date.now() + timeout : Infinity;
    for (;;) {
      signal?.throwIfAborted();
      const todo = await this.get(id);
      if (["done", "cancelled"].includes(todo.status))
        return { status: todo.status, todo };
      if (Date.now() >= deadline) return { status: "waiting", todo };
      await delay(Math.min(300, deadline - Date.now()), undefined, { signal });
    }
  }
}
