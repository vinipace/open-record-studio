import path from "node:path";
import { TodoStore } from "./todo-store.mjs";
import {
  binary,
  defaults,
  probe,
  run,
  saveProject,
  readProject,
} from "./media.mjs";
import { serveMedia } from "./serve-media.mjs";

export function installTodoRecording({
  handle,
  ensureIdle,
  getRecording,
  setRecording,
  recordingUI,
  publicProject,
}) {
  const store = new TodoStore();
  const present = (todo) => ({
    ...todo,
    attachments: todo.attachments.map((a) => ({
      ...a,
      url: `studio://todos/${todo.id}/attachments/${a.id}`,
    })),
    archived_attachments: (todo.archived_attachments || []).map((a) => ({
      ...a,
      url: `studio://todos/${todo.id}/attachments/${a.id}`,
    })),
    takes: todo.takes.map((t) => ({
      ...t,
      url: `studio://todos/${todo.id}/takes/${t.id}`,
    })),
    removed_takes: (todo.removed_takes || []).map((t) => ({
      ...t,
      url: `studio://todos/${todo.id}/takes/${t.id}`,
    })),
  });
  handle("listTodos", async () => {
    const result = await store.list();
    return { ...result, todos: result.todos.map(present) };
  });
  handle("completeTodo", async (id, revision, takeId, notes) => {
    ensureIdle();
    return present(await store.complete(id, revision, takeId, notes));
  });
  handle("updateTodo", async (id, revision, changes) => {
    ensureIdle();
    return present(await store.update(id, revision, changes));
  });
  handle("removeTodoTake", async (id, revision, takeId) => {
    ensureIdle();
    return present(await store.removeTake(id, revision, takeId));
  });
  handle("addTodoComment", (id, input) => store.addComment(id, input, "user"));
  handle("updateTodoComment", (id, commentId, revision, status) =>
    store.updateComment(id, commentId, revision, status),
  );
  handle("openTodoTake", async (id, takeId) => {
    ensureIdle();
    const todo = await store.get(id),
      take = todo.takes.find((t) => t.id === takeId);
    if (!take) throw new Error("Saved take not found");
    return publicProject(await readProject(take.project_path));
  });
  handle("beginTodo", async (todoId, revision) => {
    ensureIdle();
    // Reserve before any await so two renderer requests cannot both start.
    setRecording({ kind: "todo-starting" });
    try {
      await binary("ffmpeg");
      const session = await store.begin(todoId, revision);
      setRecording({
        ...session,
        kind: "todo",
        todoId,
        queues: {},
        errors: [],
      });
      recordingUI(true);
      return { id: session.id };
    } catch (error) {
      setRecording(null);
      throw error;
    }
  });
  handle("finishTodo", async (id) => {
    const rec = getRecording();
    if (!rec || rec.kind !== "todo" || rec.id !== id || rec.finishing)
      throw new Error("Recording session not found");
    rec.finishing = true;
    try {
      await Promise.all(Object.values(rec.queues));
      if (rec.errors.length) throw new Error(rec.errors.join("; "));
      const camera = path.join(rec.directory, "camera.mkv");
      const microphone = path.join(rec.directory, "microphone.flac");
      const ffmpeg = await binary("ffmpeg");
      await run(ffmpeg, [
        "-v",
        "error",
        "-nostdin",
        "-n",
        "-i",
        path.join(rec.directory, `camera.${rec.extensions?.camera || "webm"}`),
        "-map",
        "0",
        "-c",
        "copy",
        camera,
      ]);
      const meta = await probe(camera);
      if (!meta.video || !meta.audio || meta.duration < 0.05)
        throw new Error(
          "The take needs both webcam video and microphone audio. Captured files are kept for recovery.",
        );
      await run(ffmpeg, [
        "-v",
        "error",
        "-nostdin",
        "-n",
        "-i",
        camera,
        "-vn",
        "-c:a",
        "flac",
        microphone,
      ]);
      const project = {
        version: 1,
        kind: "frame-studio",
        name: rec.title,
        createdAt: new Date().toISOString(),
        duration: meta.duration,
        directory: rec.directory,
        tracks: {
          screen: {
            ...meta,
            file: "camera.mkv",
            offset: 0,
            name: "Webcam + voice",
          },
        },
        edits: {
          segments: [{ start: 0, end: meta.duration }],
          style: {
            ...defaults,
            aspectRatio: "source",
            padding: 0,
            showCamera: false,
          },
        },
      };
      await saveProject(project);
      const todo = await store.finish(rec.todoId, id, {
        project_path: rec.directory,
        camera_path: camera,
        microphone_path: microphone,
        duration: meta.duration,
      });
      // Preserve the original stream as well as the indexed, lossless remux.
      return present(todo);
    } catch (error) {
      await store.interrupt(rec.todoId, id, error.message);
      throw error;
    } finally {
      setRecording(null);
      recordingUI(false);
    }
  });
  return {
    interrupt: (rec) =>
      store.interrupt(
        rec.todoId,
        rec.id,
        rec.errors.join("; ") ||
          "Recording interrupted. Captured files are kept for recovery.",
      ),
    async serve(request) {
      try {
        const url = new URL(request.url),
          [id, kind, mediaId] = url.pathname.slice(1).split("/");
        const todo = await store.get(id);
        const file =
          kind === "attachments"
            ? [...todo.attachments, ...(todo.archived_attachments || [])].find(
                (a) => a.id === mediaId,
              )?.path
            : kind === "takes"
              ? [...todo.takes, ...(todo.removed_takes || [])].find(
                  (t) => t.id === mediaId,
                )?.camera_path
              : null;
        return file
          ? serveMedia(file, request)
          : new Response("Not found", { status: 404 });
      } catch {
        return new Response("Media is unavailable", { status: 404 });
      }
    },
  };
}
