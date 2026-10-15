import { autoZoomOptions } from "./recording-options.mjs";
import { defaultZoomEase, sourceRanges } from "./motion.mjs";

export const interactionKinds = [
  "click",
  "typing",
  "selection",
  "scroll",
  "drag",
];
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const number = (value, min, max, label) => {
  if (!Number.isFinite(value) || value < min || value > max)
    throw new Error(`Invalid interaction ${label}`);
  return value;
};

// Whitelist metadata: text, key values and arbitrary native fields never enter
// saved projects or MCP responses through this schema.
export function validateInteractions(raw, duration) {
  if (raw == null) return undefined;
  if (
    raw.version !== 1 ||
    !Array.isArray(raw.events) ||
    raw.events.length > 200000
  )
    throw new Error("Invalid interaction metadata");
  const ids = new Set();
  const events = raw.events
    .map((event, index) => {
      if (!interactionKinds.includes(event.type))
        throw new Error("Invalid interaction type");
      const id =
        typeof event.id === "string" && /^[\w-]{1,80}$/.test(event.id)
          ? event.id
          : `event-${index + 1}`;
      if (ids.has(id)) throw new Error("Duplicate interaction ID");
      ids.add(id);
      if (event.count !== undefined && !Number.isInteger(event.count))
        throw new Error("Invalid interaction count");
      if (
        event.rect &&
        (event.rect.x + event.rect.width > 1.000001 ||
          event.rect.y + event.rect.height > 1.000001)
      )
        throw new Error("Invalid interaction rectangle");
      const t = number(event.t, 0, duration, "timestamp"),
        end = number(event.end ?? t, t, duration, "end");
      return {
        id,
        type: event.type,
        t,
        end,
        x: number(event.x, 0, 1, "x"),
        y: number(event.y, 0, 1, "y"),
        ...(event.origin === "cursor" ? { origin: "cursor" } : {}),
        ...(event.count !== undefined
          ? { count: number(event.count, 1, 1000000, "count") }
          : {}),
        ...(event.button !== undefined &&
        ["left", "right", "middle", "unknown"].includes(event.button)
          ? { button: event.button }
          : {}),
        ...(event.position === "caret" ||
        event.position === "selection" ||
        event.position === "pointer" ||
        event.position === "element"
          ? { position: event.position }
          : {}),
        ...Object.fromEntries(
          ["rect", "contextRect"]
            .filter((key) => event[key])
            .map((key) => {
              const r = event[key];
              if (r.x + r.width > 1.000001 || r.y + r.height > 1.000001)
                throw new Error("Invalid interaction rectangle");
              return [
                key,
                {
                  x: number(r.x, 0, 1, "rectangle x"),
                  y: number(r.y, 0, 1, "rectangle y"),
                  width: number(r.width, 0, 1, "rectangle width"),
                  height: number(r.height, 0, 1, "rectangle height"),
                },
              ];
            }),
        ),
      };
    })
    .sort((a, b) => a.t - b.t || a.end - b.end);
  return {
    version: 1,
    capabilities: Object.fromEntries(
      interactionKinds.map((kind) => [kind, raw.capabilities?.[kind] === true]),
    ),
    permissions: {
      accessibility: raw.permissions?.accessibility === true,
      inputMonitoring: raw.permissions?.inputMonitoring === true,
    },
    ...(raw.diagnostics
      ? {
          diagnostics: Object.fromEntries(
            ["keyboardEvents", "missingFocus", "missingGeometry"].map((key) => [
              key,
              Number.isSafeInteger(raw.diagnostics[key]) &&
              raw.diagnostics[key] >= 0
                ? raw.diagnostics[key]
                : 0,
            ]),
          ),
        }
      : {}),
    truncated: raw.truncated === true,
    events,
  };
}

export function cursorClicks(cursor, duration) {
  let pressed = false;
  const events = [];
  for (const sample of cursor?.samples || []) {
    if (sample.pressed && !pressed && sample.visible && sample.t <= duration)
      events.push({
        id: `click-${events.length + 1}`,
        type: "click",
        t: sample.t,
        end: sample.t,
        x: sample.x,
        y: sample.y,
        button: "unknown",
        position: "pointer",
      });
    pressed = sample.pressed;
  }
  return { version: 1, capabilities: { click: !!cursor?.clean }, events };
}

// A successfully created event tap does not guarantee delivery on macOS.
// Reconcile against the independently sampled button edges, even when native
// capture advertised click support. Match each native event at most once.
export function reconcileInteractions(raw, cursor, duration) {
  const track = validateInteractions(
    raw ?? { version: 1, events: [] },
    duration,
  );
  if (!cursor?.clean) return track;
  const clicks = track.events.filter((event) => event.type === "click");
  const used = new Set(),
    ids = new Set(track.events.map((event) => event.id));
  let first = 0;
  for (const click of cursorClicks(cursor, duration).events) {
    while (first < clicks.length && clicks[first].t < click.t - 0.12) first++;
    let nearest = -1,
      distance = Infinity;
    for (
      let i = first;
      i < clicks.length && clicks[i].t <= click.t + 0.12;
      i++
    ) {
      const delta = Math.abs(clicks[i].t - click.t);
      if (!used.has(i) && delta < distance) {
        nearest = i;
        distance = delta;
      }
    }
    if (nearest !== -1) {
      used.add(nearest);
      continue;
    }
    if (track.events.length >= 200000) {
      track.truncated = true;
      break;
    }
    let id = `cursor-${click.id}`,
      suffix = 1;
    while (ids.has(id)) id = `cursor-${click.id}-${suffix++}`;
    ids.add(id);
    track.events.push({ ...click, id, origin: "cursor" });
  }
  track.capabilities.click = true;
  track.events.sort((a, b) => a.t - b.t || a.end - b.end);
  return track;
}

export function interactionSummary(project) {
  const track =
    project.interactions ||
    validateInteractions(
      cursorClicks(project.cursor, project.duration),
      project.duration,
    );
  return {
    available: !!project.interactions || !!project.cursor?.clean,
    source: project.interactions
      ? "recorded"
      : project.cursor?.clean
        ? "cursor"
        : "unavailable",
    capabilities: track.capabilities,
    permissions: track.permissions,
    counts: Object.fromEntries(
      interactionKinds.map((type) => [
        type,
        track.events.filter((event) => event.type === type).length,
      ]),
    ),
    ...(track.diagnostics ? { diagnostics: track.diagnostics } : {}),
    ...(project.recording?.autoZoom
      ? { auto_zoom: autoZoomOptions(project.recording.autoZoom) }
      : {}),
    total: track.events.length,
    truncated: track.truncated,
  };
}

export function queryInteractions(
  project,
  {
    types = interactionKinds,
    start = 0,
    end,
    timebase = "source",
    offset = 0,
    limit = 200,
  } = {},
) {
  const track =
    project.interactions ||
    validateInteractions(
      cursorClicks(project.cursor, project.duration),
      project.duration,
    );
  end ??=
    timebase === "output"
      ? project.edits.segments.reduce(
          (sum, segment) => sum + segment.end - segment.start,
          0,
        ) / project.edits.style.speed
      : project.duration;
  const mapped = track.events
    .filter(
      (event) =>
        types.includes(event.type) &&
        (timebase !== "source" || (event.end >= start && event.t <= end)),
    )
    .map((event) => {
      const ranges =
        event.end > event.t
          ? sourceRanges(project.edits, event.t, event.end)
          : [];
      let retained = 0;
      const times = [];
      project.edits.segments.forEach((segment, cut_index) => {
        if (
          event.t >= segment.start &&
          (event.t < segment.end ||
            (event.t === project.duration && event.t === segment.end))
        )
          times.push({
            t: (retained + event.t - segment.start) / project.edits.style.speed,
            cut_index,
          });
        retained += segment.end - segment.start;
      });
      return { ...event, output_times: times, output_ranges: ranges };
    })
    .filter((event) =>
      timebase === "source"
        ? event.end >= start && event.t <= end
        : event.output_times.some(
            (point) => point.t >= start && point.t <= end,
          ) ||
          event.output_ranges.some(
            (range) => range.end >= start && range.start <= end,
          ),
    );
  return {
    ...interactionSummary(project),
    timebase,
    matched: mapped.length,
    events: mapped.slice(offset, offset + limit),
    next_offset: offset + limit < mapped.length ? offset + limit : null,
  };
}

const unionRect = (a, b) => {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x),
    y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
};
const eventRect = (event) =>
  unionRect(
    event.contextRect,
    event.rect || { x: event.x, y: event.y, width: 0, height: 0 },
  );

// Turn clustered interactions into ordinary editable zoom sections. Text regions
// are framed as a whole, including every caret position in the burst.
export function automaticZooms(interactions, duration, cursor, options) {
  const enabled = autoZoomOptions(options);
  const relevant =
    interactions?.events.filter((e) => enabled[e.type] === true) || [];
  const groups = [];
  for (const event of relevant) {
    const last = groups.at(-1),
      text = ["typing", "selection"].includes(event.type);
    if (
      last &&
      event.t - last.end <= 1.4 &&
      Math.hypot(last.x - event.x, last.y - event.y) < 0.24
    ) {
      last.end = Math.max(last.end, event.end);
      if (text || !last.text) {
        last.x = event.x;
        last.y = event.y;
        last.rect =
          text && last.text
            ? unionRect(last.rect, eventRect(event))
            : eventRect(event);
        last.trigger = event.type;
      }
      last.text ||= text;
    } else
      groups.push({
        start: event.t,
        end: event.end,
        x: event.x,
        y: event.y,
        rect: eventRect(event),
        text,
        trigger: event.type,
      });
  }
  const zooms = [];
  for (const [index, group] of groups.entries()) {
    const start = Math.max(group.start - 0.6, 0),
      nextStart = Math.max(0, (groups[index + 1]?.start ?? Infinity) - 0.6);
    const end = Math.min(
      duration,
      nextStart,
      Math.max(group.end + 1.8, start + 3),
    );
    if (end - start < 0.4 || zooms.length >= 80) continue;
    const region = group.rect;
    // Leave room around the entire field/selection. If it is too large, keep
    // the wide shot rather than forcing a minimum zoom that clips the text.
    const margin = group.text ? 0.04 : 0;
    const left = clamp(region.x - margin, 0, 1),
      top = clamp(region.y - margin, 0, 1);
    const right = clamp(region.x + region.width + margin, 0, 1),
      bottom = clamp(region.y + region.height + margin, 0, 1);
    const size = Math.max(0.5, right - left, bottom - top);
    const zoom = 1 / size;
    if (zoom < 1.05) continue;
    const x = (left + right) / 2,
      y = (top + bottom) / 2;
    // Editor focus is a fraction of the available crop travel, NOT a source
    // point. Convert the desired center; direct x/y assignment crops edge text.
    const travel = 1 - size;
    zooms.push({
      id: `auto-${zooms.length + 1}`,
      trigger: group.trigger,
      start,
      end,
      zoom,
      mode: !group.text && cursor?.clean ? "follow" : "fixed",
      focusX: clamp((x - size / 2) / travel, 0, 1),
      focusY: clamp((y - size / 2) / travel, 0, 1),
      ease: defaultZoomEase,
    });
  }
  return zooms;
}
