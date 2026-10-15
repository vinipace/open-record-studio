import { z } from "zod";
import { randomUUID } from "node:crypto";
import { canFollowCursor } from "../desktop/motion.mjs";
import {
  aspectRatios,
  canvasTemplates,
  applyCanvasStyle,
} from "../desktop/composition.mjs";

export const seconds = z.number().finite().min(0).max(86400);
const rangeFields = {
  start: seconds.describe("Inclusive source seconds"),
  end: seconds.describe("Exclusive source seconds"),
};
const cutIndex = z
  .number()
  .int()
  .min(0)
  .max(99)
  .describe(
    "Zero-based retained clip index; in a batch, use indices after preceding operations",
  );
const zoomId = z.string().regex(/^[a-zA-Z0-9-]{1,80}$/);
const zoomFields = {
  ...rangeFields,
  mode: z
    .enum(["follow", "fixed"])
    .optional()
    .describe(
      "Follow smoothly tracks recorded mouse movement; fixed uses focusX/focusY. New sections default to follow when cursor data exists, otherwise fixed.",
    ),
  zoom: z.number().min(1).max(3).describe("Magnification, 1–3"),
  focusX: z
    .number()
    .min(0)
    .max(1)
    .describe("Horizontal pan fraction: 0=left, 0.5=center, 1=right"),
  focusY: z
    .number()
    .min(0)
    .max(1)
    .describe("Vertical pan fraction: 0=top, 0.5=center, 1=bottom"),
  ease: z
    .number()
    .min(0.1)
    .max(2)
    .describe(
      "Smooth ease-in/out duration at each edge in output seconds; 0.6 is the editor default. Clamped to half the retained section; adjacent sections blend directly. Starts and stops with zero velocity, acceleration and jerk, without overshoot.",
    ),
};
export const styleFields = {
  enhanceAudio: z
    .boolean()
    .describe(
      "Locally reduce speech background noise with the bundled RNNoise RNN model. Applies to preview and audio exports; originals stay unchanged.",
    ),
  aspectRatio: z
    .enum(aspectRatios)
    .describe(
      "Composition ratio; source matches the screen media. Separate tracks retain their own ratios.",
    ),
  canvasTemplate: z
    .enum(["custom", ...canvasTemplates.map((t) => t.id)])
    .describe(
      "Social size preset; automatically sets its aspect ratio. Use custom for a manual ratio.",
    ),
  screenFit: z
    .enum(["fit", "fill"])
    .describe(
      "Fit preserves the full screen media; fill crops to cover the composition's padded area.",
    ),
  background: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .describe("Solid background color, #RRGGBB"),
  padding: z.number().min(0).max(0.2),
  cameraSize: z.number().min(0.1).max(0.5),
  cameraMargin: z
    .number()
    .min(0)
    .max(0.2)
    .describe(
      "Webcam overlay inset from its chosen canvas corner, as a fraction of the camera-size reference width (0–0.2; default 0.035). Scales with export resolution and is limited to keep the overlay on canvas. Separate webcam exports stay full-frame.",
    ),
  cameraFlip: z
    .boolean()
    .describe(
      "Flip webcam video horizontally in the project preview and combined/separate camera exports",
    ),
  cameraCorner: z.enum([
    "bottom-right",
    "bottom-left",
    "top-right",
    "top-left",
  ]),
  cameraShape: z
    .enum(["circle", "square"])
    .describe(
      "Preset: sets roundness to 1 or 0 unless cameraRoundness is also supplied",
    ),
  cameraRoundness: z
    .number()
    .min(0)
    .max(1)
    .describe(
      "Webcam overlay: 0=square, 1=circle; takes precedence over cameraShape",
    ),
  showCamera: z.boolean(),
  cameraOffset: z
    .number()
    .min(-60)
    .max(60)
    .describe("Manual webcam delay in seconds; positive delays it"),
  zoom: z.number().min(1).max(3),
  focusX: z.number().min(0).max(1),
  focusY: z.number().min(0).max(1),
  speed: z
    .number()
    .min(0.5)
    .max(2)
    .describe(
      "Playback speed for all tracks; changes output timeline duration",
    ),
  volume: z.number().min(0).max(1).describe("Screen audio gain"),
  microphoneVolume: z.number().min(0).max(1),
  showCursor: z.boolean(),
  cursorSize: z.number().min(0.5).max(3),
  cursorSmoothing: z
    .number()
    .min(0)
    .max(0.15)
    .describe("Cursor smoothing in seconds"),
  cursorClicks: z.boolean().describe("Highlight cursor clicks"),
};
const partialChanges = (fields) =>
  z
    .strictObject(fields)
    .partial()
    .refine(
      (value) => Object.keys(value).length > 0,
      "Provide at least one field to change",
    );
function cutAt(edits, index) {
  const cut = edits.segments[index];
  if (!cut) throw new Error("Cut index does not exist in this revision");
  return cut;
}
function zoomAt(edits, id) {
  const zoom = edits.zooms?.find((item) => item.id === id);
  if (!zoom) throw new Error("Zoom ID does not exist in this revision");
  return zoom;
}
const cursorKeys = [
  "showCursor",
  "cursorSize",
  "cursorSmoothing",
  "cursorClicks",
];
const cameraKeys = [
  "cameraSize",
  "cameraMargin",
  "cameraFlip",
  "cameraCorner",
  "cameraShape",
  "cameraRoundness",
  "showCamera",
  "cameraOffset",
];
export function availableStyleFields(project) {
  return Object.keys(styleFields).filter(
    (key) =>
      (!cursorKeys.includes(key) || project.cursor?.clean) &&
      (!cameraKeys.includes(key) || project.tracks.camera),
  );
}
export const editOperations = {
  add_cut: {
    description:
      "Insert a retained source range into a gap in the timeline. Existing clips must not overlap it. To split an existing clip use split_cut. All tracks share the cuts.",
    fields: rangeFields,
    apply: ({ edits }, args) => {
      edits.segments.push({ start: args.start, end: args.end });
      edits.segments.sort((a, b) => a.start - b.start);
    },
  },
  edit_cut: {
    description:
      "Set the source in/out boundaries of an existing retained clip. Ranges must remain ordered, nonoverlapping and at least 0.05 seconds long.",
    fields: { cut_index: cutIndex, ...rangeFields },
    apply: ({ edits }, args) => {
      Object.assign(cutAt(edits, args.cut_index), {
        start: args.start,
        end: args.end,
      });
    },
  },
  remove_cut: {
    description:
      "Remove a retained clip from output, preserving original media. Cannot remove the last clip. Use returned cuts/revision for subsequent edits.",
    fields: { cut_index: cutIndex },
    apply: ({ edits }, args) => {
      cutAt(edits, args.cut_index);
      edits.segments.splice(args.cut_index, 1);
    },
  },
  split_cut: {
    description:
      "Split a retained clip at a source timestamp; both resulting clips must be at least 0.05 seconds long. Does not discard footage.",
    fields: { cut_index: cutIndex, source_time: seconds },
    apply: ({ edits }, args) => {
      const cut = cutAt(edits, args.cut_index);
      if (args.source_time <= cut.start || args.source_time >= cut.end)
        throw new Error("Split time must be inside the selected clip");
      edits.segments.splice(
        args.cut_index,
        1,
        { start: cut.start, end: args.source_time },
        { start: args.source_time, end: cut.end },
      );
    },
  },
  add_zoom: {
    description:
      "Add an eased zoom in source seconds with a generated stable ID. Sections must not overlap and must last at least 0.1 seconds.",
    fields: zoomFields,
    apply: (project, args) => {
      const { edits } = project;
      if (args.mode === "follow" && !canFollowCursor(project.cursor))
        throw Object.assign(
          new Error(
            "Follow zoom requires recorded cursor data; use fixed mode for imported media.",
          ),
          { code: "UNSUPPORTED_CONTROL" },
        );
      const zoom = Object.fromEntries(
        Object.keys(zoomFields).map((key) => [key, args[key]]),
      );
      const id = randomUUID();
      (edits.zooms ||= []).push({
        id,
        ...zoom,
        mode:
          args.mode ?? (canFollowCursor(project.cursor) ? "follow" : "fixed"),
      });
      edits.zooms.sort((a, b) => a.start - b.start);
      return { zoom_id: id };
    },
  },
  edit_zoom: {
    description:
      "Update zoom fields by ID. Boundaries are source seconds, focus is a pan fraction, and easing is output seconds. Sections must not overlap.",
    fields: { zoom_id: zoomId, changes: partialChanges(zoomFields) },
    apply: (project, args) => {
      const { edits } = project;
      if (args.changes.mode === "follow" && !canFollowCursor(project.cursor))
        throw Object.assign(
          new Error(
            "Follow zoom requires recorded cursor data; use fixed mode for imported media.",
          ),
          { code: "UNSUPPORTED_CONTROL" },
        );
      Object.assign(zoomAt(edits, args.zoom_id), args.changes);
      edits.zooms.sort((a, b) => a.start - b.start);
    },
  },
  remove_zoom: {
    description:
      "Remove one zoom by ID, preserving all clips, style and other zooms.",
    fields: { zoom_id: zoomId },
    apply: ({ edits }, args) => {
      zoomAt(edits, args.zoom_id);
      edits.zooms = edits.zooms.filter((zoom) => zoom.id !== args.zoom_id);
    },
  },
  update_style: {
    description:
      "Change only supplied cursor, webcam, framing, background, audio or speed settings. Cursor controls require separate cursor data; webcam controls require a camera track. Presets and roundness stay synchronized. Original media is preserved.",
    fields: { changes: partialChanges(styleFields) },
    apply: (project, { changes }) => {
      const allowed = availableStyleFields(project);
      const unsupported = Object.keys(changes).filter(
        (key) => !allowed.includes(key),
      );
      if (unsupported.length)
        throw Object.assign(
          new Error(
            `Unavailable style controls: ${unsupported.join(", ")}. Cursor controls require separate cursor data; webcam controls require a camera track.`,
          ),
          { code: "UNSUPPORTED_CONTROL" },
        );
      const style = project.edits.style;
      Object.assign(style, applyCanvasStyle(style, changes));
      if (changes.cameraRoundness !== undefined)
        style.cameraShape = changes.cameraRoundness === 1 ? "circle" : "square";
      else if (changes.cameraShape !== undefined)
        style.cameraRoundness = changes.cameraShape === "circle" ? 1 : 0;
    },
  },
};
export const batchOperations = z
  .array(
    z.discriminatedUnion(
      "operation",
      Object.entries(editOperations).map(([name, definition]) =>
        z.strictObject({ operation: z.literal(name), ...definition.fields }),
      ),
    ),
  )
  .min(1)
  .max(100);
