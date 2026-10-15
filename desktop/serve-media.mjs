import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";

export function byteRange(header, size) {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  let start = match[1]
    ? Number(match[1])
    : Math.max(0, size - Number(match[2]));
  let end = match[1] && match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start >= size ||
    end < start ||
    (!match[1] && Number(match[2]) === 0)
  )
    return null;
  return { start, end: Math.min(end, size - 1), partial: true };
}
// net.fetch(file:) does not consistently preserve HTTP byte-range semantics.
// Chromium needs explicit 206/Content-Range responses to make local media seekable.
export async function serveMedia(file, request) {
  if (!["GET", "HEAD"].includes(request.method))
    return new Response(null, { status: 405 });
  const { size } = await stat(file),
    range = byteRange(request.headers.get("range"), size);
  const headers = new Headers({
    "Access-Control-Allow-Origin": "*",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Content-Type":
      {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".mp4": "video/mp4",
        ".m4v": "video/mp4",
        ".mov": "video/quicktime",
        ".mkv": "video/x-matroska",
        ".webm": "video/webm",
        ".flac": "audio/flac",
      }[path.extname(file).toLowerCase()] || "application/octet-stream",
  });
  if (!range) {
    headers.set("Content-Range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  const { start, end, partial } = range;
  headers.set("Content-Length", String(Math.max(0, end - start + 1)));
  if (partial) headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
  const body =
    request.method === "HEAD" || !size
      ? null
      : Readable.toWeb(createReadStream(file, { start, end }));
  return new Response(body, { status: partial ? 206 : 200, headers });
}
