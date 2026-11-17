#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { TodoStore } from "../desktop/todo-store.mjs";
import { todoInput, todoPatch, todoCommentInput } from "./todo-schema.mjs";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url)),
);
import {
  exportFormats,
  normalizeExportOptions,
} from "../desktop/export-settings.mjs";
import {
  seconds,
  editOperations,
  batchOperations,
  availableStyleFields,
} from "./edits.mjs";
import {
  readProject,
  saveProject,
  validateEdits,
  outputDuration,
  exportProject,
} from "../desktop/media.mjs";
import { previewProject } from "../desktop/preview.mjs";
import { canFollowCursor } from "../desktop/motion.mjs";
import {
  interactionKinds,
  interactionSummary,
  queryInteractions,
} from "../desktop/interactions.mjs";
import {
  aspectRatios,
  canvasTemplates,
  compositionSize,
} from "../desktop/composition.mjs";

const absolutePath = z
  .string()
  .min(1)
  .refine(path.isAbsolute, "Use an absolute path");
const projectFields = {
  project_path: absolutePath.describe(
    "Absolute .framestudio project directory containing project.json",
  ),
};
const revision = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .describe(
    "Revision returned by get_project or the last edit; stale revisions are rejected",
  );
const editFields = { ...projectFields, expected_revision: revision };
const json = (data) => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
  structuredContent: data,
});
const summary = (p) => {
  let retained = 0;
  return {
    project_path: p.directory,
    revision: p.revision,
    name: p.name,
    source_duration: p.duration,
    output_duration: outputDuration(p.edits),
    cuts: p.edits.segments.map((s, index) => ({ index, ...s })),
    timeline: p.edits.segments.map((segment, cut_index) => {
      const output_start = retained / p.edits.style.speed;
      retained += segment.end - segment.start;
      return {
        cut_index,
        source_start: segment.start,
        source_end: segment.end,
        output_start,
        output_end: retained / p.edits.style.speed,
      };
    }),
    zooms: p.edits.zooms || [],
    style: p.edits.style,
    composition: compositionSize(p.edits.style, 1080, p.tracks.screen),
    tracks: p.tracks,
    assets: p.assets,
    layers: p.edits.layers || [],
    removed_audio: p.edits.removedAudio || [],
    editable_cursor: Boolean(p.cursor?.clean),
    interactions: interactionSummary(p),
    capabilities: {
      editable_style_fields: availableStyleFields(p),
      preview_modes: p.tracks.camera
        ? ["combined", "screen", "camera"]
        : ["combined", "screen"],
      render_modes: p.tracks.camera
        ? ["combined", "separate", "both"]
        : ["combined"],
      export_formats: exportFormats,
      export_audio_routing: {
        screen: ["system"],
        camera: ["microphone", "webcam_take_microphones"],
        combined: ["system", "microphone", "webcam_take_microphones"],
      },
      aspect_ratios: aspectRatios,
      canvas_templates: canvasTemplates,
      zoom_modes: canFollowCursor(p.cursor) ? ["follow", "fixed"] : ["fixed"],
      default_zoom_mode: canFollowCursor(p.cursor) ? "follow" : "fixed",
      composition_resolution:
        "Portrait and square: short edge; landscape: height. Separate tracks: height.",
      limits: { clips: 100, zooms: 80, batch_operations: 100 },
    },
  };
};
function checkRevision(p, expected) {
  if (expected && p.revision !== expected)
    throw new Error(
      "Project changed on disk. Call get_project and retry with its revision.",
    );
}
async function snapshot(args) {
  const p = await readProject(args.project_path);
  checkRevision(p, args.expected_revision);
  return p;
}
async function mutate(args, operations, { dryRun = false, signal } = {}) {
  const p = await snapshot(args);
  const base_revision = p.revision;
  const operation_results = operations.map((args, index) => {
    try {
      const result = editOperations[args.operation].apply(p, args);
      p.edits = validateEdits(p.edits, p.duration, p.assets);
      return { index, operation: args.operation, ...result };
    } catch (error) {
      error.code ||= "INVALID_EDIT";
      error.operation_index = index;
      throw error;
    }
  });
  signal?.throwIfAborted();
  if (!dryRun) await saveProject(p);
  return {
    saved: !dryRun,
    base_revision,
    project: summary(p),
    operation_results,
  };
}
function failure(error) {
  const message = error.message || String(error);
  const code =
    error.code ||
    (message.includes("Project changed on disk")
      ? "REVISION_CONFLICT"
      : message.includes("Project is being saved")
        ? "PROJECT_BUSY"
        : "TOOL_ERROR");
  const recovery =
    code === "REVISION_CONFLICT"
      ? "Call get_project, review the current edits, and retry with its revision."
      : code === "PROJECT_BUSY"
        ? "Wait briefly, then call get_project before retrying."
        : code === "UNSUPPORTED_CONTROL"
          ? "Use capabilities.editable_style_fields from get_project."
          : undefined;
  return {
    ...json({
      error: {
        code,
        message,
        retryable: code === "PROJECT_BUSY",
        ...(recovery ? { recovery } : {}),
        ...(error.operation_index === undefined
          ? {}
          : { operation_index: error.operation_index }),
      },
    }),
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

export function createFrameServer() {
  const server = new McpServer(
    { name: "open-record-studio", version },
    {
      instructions:
        "Edit saved local Open Record Studio projects. Start with get_project for capabilities and source/output timeline positions. get_interactions queries recorded click, typing, selection, scroll and drag timing and positions, mapped through saved cuts and speed; it contains no typed or selected text. update_style changes cursor, webcam, framing, audio and speed. apply_edits performs up to 100 edits atomically; dry_run validates without saving. Each operation is validated in order against previous operations. Dry runs return a proposed project with the unchanged base revision; generated zoom IDs are provisional. Cuts are retained source-time clips (not discarded ranges), indexed from zero. Split then remove a clip to discard a middle interval. Mutations require the latest revision and return the new revision. Preview time is on the edited output timeline. Zoom boundaries are source seconds. Render starts an asynchronous job; poll render_status until succeeded. Unsaved desktop changes are not included. The desktop shows Reload when a saved project changes.",
    },
  );
  const jobs = new Map();
  const todos = new TodoStore();
  const todoWaiters = new Set();
  const activePreviews = new Set();
  let stopping = false;
  const jobView = ({ controller, done, ...job }) => ({ ...job });
  const jobAt = (id) => {
    const job = jobs.get(id);
    if (!job)
      throw new Error("Unknown job ID (jobs belong to this MCP process)");
    return job;
  };
  const register = (name, description, fields, readOnly, handler) => {
    server.registerTool(
      name,
      {
        description,
        inputSchema: z.strictObject(fields),
        annotations: {
          readOnlyHint: readOnly,
          destructiveHint: [
            "edit_cut",
            "remove_cut",
            "edit_zoom",
            "remove_zoom",
            "cancel_render",
            "update_style",
            "apply_edits",
          ].includes(name),
          openWorldHint: false,
        },
      },
      async (args, ctx) => {
        try {
          if (stopping) throw new Error("MCP server is shutting down");
          return await handler(args, ctx);
        } catch (error) {
          return failure(error);
        }
      },
    );
  };
  register(
    "get_project",
    "Read saved tracks, retained cuts, source/output timeline positions, zooms, style, capabilities, export settings and revision. Does not expose cursor sample arrays.",
    projectFields,
    true,
    async (args) => json(summary(await snapshot(args))),
  );

  const todoId = { todo_id: z.string().uuid() };
  const todoRevision = {
    ...todoId,
    expected_revision: z.number().int().positive(),
  };
  register(
    "create_todo",
    "Queue a webcam + voice recording with instructions and copied local reference media. Works with the app closed. After creation, wait_for_todo or the CLI todos wait command returns the user's approved take and file paths. Reference duration never limits recording.",
    todoInput,
    false,
    async (args) => json(await todos.create(args)),
  );
  register(
    "list_todos",
    "List persistent recording todos, including selected output files for completed handoffs.",
    {
      status: z
        .enum([
          "ready",
          "recording",
          "interrupted",
          "review",
          "done",
          "cancelled",
        ])
        .optional(),
    },
    true,
    async ({ status }) => json(await todos.list(status)),
  );
  register(
    "get_todo",
    "Read a recording brief, attachments, saved takes, timestamped comments, revision and completed output paths.",
    todoId,
    true,
    async ({ todo_id }) => json(await todos.get(todo_id)),
  );
  register(
    "update_todo",
    "Edit a recording brief, cancel or reopen a todo using its latest revision. Active recordings cannot be changed. Original media and takes are preserved.",
    { ...todoRevision, changes: z.strictObject(todoPatch) },
    false,
    async ({ todo_id, expected_revision, changes }) =>
      json(await todos.update(todo_id, expected_revision, changes)),
  );
  register(
    "complete_todo",
    "Mark a reviewed recording done using an existing take ID. Only do this when the user explicitly approves that take. Emits a durable todo.done event and releases waiting clients.",
    {
      ...todoRevision,
      take_id: z.string().uuid(),
      notes: z.string().max(20000).default(""),
    },
    false,
    async ({ todo_id, expected_revision, take_id, notes }) =>
      json(await todos.complete(todo_id, expected_revision, take_id, notes)),
  );
  register(
    "todo_events",
    "Read durable recording events after a cursor, including todo.done and todo.comment_added/resolved/reopened with media paths and timestamps. Persist the returned cursor and paginate while has_more. Events survive app/server restarts.",
    {
      after: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(500).default(100),
    },
    true,
    async ({ after, limit }) => json(await todos.events(after, limit)),
  );
  register(
    "wait_for_todo",
    "Wait up to 30 seconds for the user to mark a recording done or cancelled. Returns status waiting on timeout; call again or use CLI todos wait ID as a background Bash task in Claude Code for automatic continuation. MCP alone cannot wake a disconnected or idle client.",
    { ...todoId, timeout_seconds: z.number().min(0.1).max(30).default(25) },
    true,
    async ({ todo_id, timeout_seconds }, ctx) => {
      const controller = new AbortController();
      todoWaiters.add(controller);
      try {
        return json(
          await todos.wait(todo_id, {
            timeout: timeout_seconds * 1000,
            signal: AbortSignal.any([controller.signal, ctx.mcpReq.signal]),
          }),
        );
      } finally {
        todoWaiters.delete(controller);
      }
    },
  );

  register(
    "list_todo_comments",
    "Read timestamped video feedback, including media file paths, author, status and resolution notes. The returned cursor can be passed to wait_for_todo_comments to wait only for new feedback. Timestamps are seconds in the specific original attachment or take, not an edited timeline.",
    { ...todoId, status: z.enum(["open", "resolved"]).optional() },
    true,
    async ({ todo_id, status }) => json(await todos.comments(todo_id, status)),
  );
  register(
    "add_todo_comment",
    "Add an agent-authored timestamped comment to an attachment or saved take. Use media IDs from get_todo. Emits a durable comment event; app need not be open.",
    { ...todoId, ...todoCommentInput },
    false,
    async ({ todo_id, ...input }) =>
      json(await todos.addComment(todo_id, input)),
  );
  register(
    "update_todo_comment",
    "Resolve feedback after addressing it, with an optional explanation, or reopen it. expected_revision is the comment's revision from list_todo_comments, not the todo's revision. Preserves original comment text and timestamp.",
    {
      ...todoId,
      comment_id: z.string().uuid(),
      expected_revision: z.number().int().positive(),
      status: z.enum(["open", "resolved"]),
      resolution: z.string().max(5000).default(""),
    },
    false,
    async ({ todo_id, comment_id, expected_revision, status, resolution }) =>
      json(
        await todos.updateComment(
          todo_id,
          comment_id,
          expected_revision,
          status,
          resolution,
        ),
      ),
  );
  register(
    "wait_for_todo_comments",
    "Wait up to 30 seconds for new or reopened comments after a cursor. Returns durable events with text, timestamps and local media paths. On status waiting, call again with the returned cursor. For automatic continuation, run CLI todos wait-comments ID --after CURSOR as a background Bash task in an active Claude Code session; restart the wait after handling each batch. This does not wake a closed/disconnected conversation.",
    {
      ...todoId,
      after: z.number().int().nonnegative().default(0),
      timeout_seconds: z.number().min(0.1).max(30).default(25),
    },
    true,
    async ({ todo_id, after, timeout_seconds }, ctx) => {
      const controller = new AbortController();
      todoWaiters.add(controller);
      try {
        return json(
          await todos.waitComments(todo_id, after, {
            timeout: timeout_seconds * 1000,
            signal: AbortSignal.any([controller.signal, ctx.mcpReq.signal]),
          }),
        );
      } finally {
        todoWaiters.delete(controller);
      }
    },
  );
  register(
    "get_interactions",
    "Query recorded clicks, typing bursts, text selections, scrolls and drags. Event t/end are source seconds; output_times/output_ranges map through current cuts and speed. Includes normalized screen positions, capture capabilities and permission coverage, never typed or selected text. Legacy cursor projects can provide derived click timestamps. Use timebase to filter source or edited-output time; pagination is bounded.",
    {
      ...projectFields,
      expected_revision: revision.optional(),
      types: z.array(z.enum(interactionKinds)).min(1).max(5).optional(),
      timebase: z.enum(["source", "output"]).default("source"),
      start: z.number().finite().min(0).optional(),
      end: z.number().finite().min(0).optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(1000).default(200),
    },
    true,
    async (args) => {
      const project = await snapshot(args),
        end =
          args.end ??
          (args.timebase === "output"
            ? outputDuration(project.edits)
            : project.duration);
      if (end < (args.start ?? 0)) throw new Error("End must follow start");
      return json({
        revision: project.revision,
        source_duration: project.duration,
        output_duration: outputDuration(project.edits),
        ...queryInteractions(project, { ...args, end }),
      });
    },
  );
  for (const [name, definition] of Object.entries(editOperations))
    register(
      name,
      definition.description,
      { ...editFields, ...definition.fields },
      false,
      async (args, ctx) =>
        json(
          (
            await mutate(args, [{ ...args, operation: name }], {
              signal: ctx.mcpReq.signal,
            })
          ).project,
        ),
    );
  register(
    "apply_edits",
    "Apply 1–100 cut, zoom or style operations in order, saving once. Every step must be valid; any failure leaves the file unchanged. Indices refer to the timeline after preceding operations. dry_run validates without saving and returns a proposed project with its unchanged base revision; generated zoom IDs are provisional. Saved results include the new project revision and generated IDs in operation_results.",
    {
      ...editFields,
      operations: batchOperations,
      dry_run: z.boolean().default(false),
    },
    false,
    async (args, ctx) =>
      json(
        await mutate(args, args.operations, {
          dryRun: args.dry_run,
          signal: ctx.mcpReq.signal,
        }),
      ),
  );

  register(
    "get_preview",
    "Return an inline PNG of the composed video at an edited-output timestamp. Uses the export graph, including cuts, speed, eased zoom and cursor. Time must be less than output_duration. Decodes from the beginning for frame accuracy; later timestamps take longer. Request cancellation cleans temporary files.",
    {
      ...projectFields,
      expected_revision: revision.optional(),
      time: seconds.describe("Edited output seconds (not source time)"),
      mode: z.enum(["combined", "screen", "camera"]).default("combined"),
      height: z.union([z.literal(360), z.literal(720)]).default(360),
      fps: z.union([z.literal(30), z.literal(60)]).default(60),
    },
    true,
    async (args, ctx) => {
      if (activePreviews.size)
        throw new Error(
          "A preview is already running. Wait or cancel that request first.",
        );
      const controller = new AbortController();
      let resolveDone;
      const job = {
        controller,
        done: new Promise((resolve) => {
          resolveDone = resolve;
        }),
      };
      activePreviews.add(job);
      try {
        const p = await snapshot(args);
        const { image, ...info } = await previewProject(p, args, {
          signal: AbortSignal.any([controller.signal, ctx.mcpReq.signal]),
        });
        const result = json({
          ...info,
          mode: args.mode,
          project_path: p.directory,
          revision: p.revision,
        });
        result.content.push({
          type: "image",
          mimeType: "image/png",
          data: image.toString("base64"),
        });
        return result;
      } finally {
        activePreviews.delete(job);
        resolveDone();
      }
    },
  );
  register(
    "render",
    "Start a background MP4 or looping GIF render of the saved revision. GIF has no audio. Returns a job ID immediately; poll render_status for progress/files or use cancel_render. Creates a unique output directory. Separate/both require a webcam track. Job state lasts for this MCP connection; disconnect cancels unfinished renders.",
    {
      ...editFields,
      output_directory: absolutePath,
      mode: z.enum(["combined", "separate", "both"]).default("combined"),
      format: z.enum(["mp4", "gif"]).default("mp4"),
      height: z
        .union([
          z.literal(360),
          z.literal(480),
          z.literal(720),
          z.literal(1080),
          z.literal(2160),
        ])
        .optional()
        .describe(
          "MP4: 720/1080/2160 (default 1080). GIF: 360/480/720/1080 (default 480).",
        ),
      fps: z
        .union([
          z.literal(10),
          z.literal(15),
          z.literal(20),
          z.literal(30),
          z.literal(60),
        ])
        .optional()
        .describe("MP4: 30/60 (default 60). GIF: 10/15/20/30 (default 20)."),
      quality: z.enum(["standard", "high"]).default("high"),
      audio: z
        .boolean()
        .default(true)
        .describe(
          "System audio in screen; microphones in camera; mixed audio in combined. GIF is silent.",
        ),
      cameraAudio: z
        .boolean()
        .optional()
        .describe(
          "Deprecated and ignored: use audio. Microphone routing to camera is automatic.",
        ),
    },
    false,
    async (args, ctx) => {
      // Reserve before any await so simultaneous requests cannot bypass the limit.
      if (
        [...jobs.values()].some((j) =>
          ["starting", "running", "cancelling"].includes(j.status),
        )
      )
        throw new Error(
          "A render is already running. Wait or cancel it first.",
        );
      const job = {
        job_id: randomUUID(),
        status: "starting",
        progress: 0,
        track: "preparing",
        controller: new AbortController(),
      };
      jobs.set(job.job_id, job);
      try {
        const p = await snapshot(args);
        const { mode, format, height, fps, quality, audio, cameraAudio } = args;
        const options = normalizeExportOptions({
          mode,
          format,
          height,
          fps,
          quality,
          audio,
          cameraAudio,
        });
        if (args.mode !== "combined" && !p.tracks.camera)
          throw new Error("Separate exports require a webcam track");
        await mkdir(args.output_directory, { recursive: true });
        ctx.mcpReq.signal.throwIfAborted();
        job.controller.signal.throwIfAborted();
        Object.assign(job, {
          status: "running",
          project_path: p.directory,
          revision: p.revision,
          started_at: new Date().toISOString(),
          options,
        });
        job.done = exportProject(
          p,
          p.edits,
          job.options,
          args.output_directory,
          {
            signal: job.controller.signal,
            onProgress: ({
              ratio,
              track,
              elapsedSeconds,
              remainingSeconds,
              encoder,
            }) =>
              Object.assign(job, {
                progress: Math.max(job.progress, ratio),
                track,
                elapsed_seconds: elapsedSeconds,
                remaining_seconds: remainingSeconds,
                encoder,
              }),
          },
        )
          .then(
            (result) =>
              Object.assign(job, {
                status: "succeeded",
                progress: 1,
                ...result,
              }),
            (error) =>
              Object.assign(job, {
                status: job.controller.signal.aborted ? "cancelled" : "failed",
                error: error.message,
              }),
          )
          .finally(() => {
            job.finished_at = new Date().toISOString();
          });
        // Keep a bounded history without removing active jobs.
        while (jobs.size > 50) jobs.delete(jobs.keys().next().value);
        return json(jobView(job));
      } catch (error) {
        jobs.delete(job.job_id);
        throw error;
      }
    },
  );
  register(
    "render_status",
    "Read a render job's status, progress, snapshot revision and output file paths. Succeeded means all files were rendered and their durations verified.",
    { job_id: z.string().uuid() },
    true,
    async ({ job_id }) => json(jobView(jobAt(job_id))),
  );
  register(
    "cancel_render",
    "Cancel an unfinished render and wait for temporary output cleanup. Completed outputs are preserved. Safe to call repeatedly.",
    { job_id: z.string().uuid() },
    false,
    async ({ job_id }) => {
      const job = jobAt(job_id);
      if (["starting", "running", "cancelling"].includes(job.status)) {
        job.status = "cancelling";
        job.controller.abort();
        await job.done;
      }
      return json(jobView(job));
    },
  );
  const stop = async () => {
    stopping = true;
    for (const controller of todoWaiters) controller.abort();
    const active = [...jobs.values(), ...activePreviews];
    active.forEach((job) => job.controller.abort());
    await Promise.allSettled(active.map((job) => job.done));
  };
  server.server.onclose = () => {
    void stop();
  };
  return { server, stop };
}

export function startStdio() {
  let active;
  const connection = serveStdio(
    () => {
      active = createFrameServer();
      return active.server;
    },
    {
      onerror: (error) => console.error(error.message),
    },
  );
  const shutdown = async () => {
    await active?.stop();
    await connection.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  startStdio();
