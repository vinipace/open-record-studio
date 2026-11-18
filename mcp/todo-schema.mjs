import path from "node:path";
import { z } from "zod";

export const todoInput = {
  title: z.string().trim().min(1).max(160),
  instructions: z.string().max(20000).default(""),
  attachments: z
    .array(z.string().refine(path.isAbsolute, "Use absolute attachment paths"))
    .max(20)
    .default([]),
};
export const todoPatch = {
  title: todoInput.title.optional(),
  instructions: z.string().max(20000).optional(),
  attachments: todoInput.attachments
    .removeDefault()
    .optional()
    .describe(
      "Replace the reference media on this same todo with these absolute paths. Omit to keep current attachments; use [] to clear. Previous commented media remains available.",
    ),
  status: z.enum(["ready", "cancelled"]).optional(),
};
export const todoCommentInput = {
  media_type: z.enum(["attachment", "take"]),
  media_id: z.string().uuid(),
  timestamp_seconds: z.number().nonnegative(),
  text: z.string().trim().min(1).max(5000),
};
