import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  reconcileInteractions,
  validateInteractions,
  cursorClicks,
  automaticZooms,
  queryInteractions,
} from "../desktop/interactions.mjs";
import {
  defaults,
  readProject,
  saveProject,
  validateEdits,
} from "../desktop/media.mjs";
import { motionFixture } from "./motion-fixture.mjs";
import { connectMcp, call } from "./mcp-client.mjs";

const event = (type, t, end = t, x = 0.4, y = 0.3) => ({
  id: `${type}-${t}`,
  type,
  t,
  end,
  x,
  y,
});
const raw = (events) => ({
  version: 1,
  capabilities: {
    click: true,
    typing: true,
    selection: true,
    scroll: true,
    drag: true,
  },
  permissions: { accessibility: true, inputMonitoring: true },
  events,
});

test("interaction metadata is bounded, content-free and derives clicks from older cursor recordings", () => {
  const data = validateInteractions(
    raw([
      {
        ...event("typing", 1, 2),
        text: "never retain",
        key: "a",
        arbitrary: "secret",
        count: 3,
      },
    ]),
    4,
  );
  assert(!JSON.stringify(data).includes("secret"));
  assert(!JSON.stringify(data).includes("never retain"));
  assert.equal(data.events[0].count, 3);
  for (const input of [
    raw([event("unknown", 1)]),
    raw([event("click", -1)]),
    raw([event("typing", 2, 1)]),
    raw([event("selection", 1, 5)]),
    raw([event("click", 1, 1, NaN)]),
    raw([event("click", 1), event("click", 1)]),
    raw([{ ...event("typing", 1), count: 1.5 }]),
    raw([
      {
        ...event("selection", 1),
        rect: { x: 0.9, y: 0, width: 0.2, height: 0.1 },
      },
    ]),
  ])
    assert.throws(() => validateInteractions(input, 4), /Invalid|Duplicate/);
  const clicks = cursorClicks(
    {
      clean: true,
      samples: [
        { t: 0, x: 0.4, y: 0.5, visible: true, pressed: false },
        { t: 1, x: 0.4, y: 0.5, visible: true, pressed: true },
        { t: 1.1, x: 0.4, y: 0.5, visible: true, pressed: true },
        { t: 1.2, x: 0.4, y: 0.5, visible: false, pressed: false },
        { t: 2, x: 0.4, y: 0.5, visible: false, pressed: true },
      ],
    },
    4,
  );
  assert.equal(clicks.events.length, 1);
  assert.equal(clicks.events[0].t, 1);
});

test("automatic zooms cluster activity, preserve text focus, ease smoothly and avoid overlapping or delayed targets", () => {
  const track = validateInteractions(
    raw([
      event("click", 0.1),
      event("typing", 0.6, 3),
      event("selection", 3.5, 3.5),
      event("click", 8, 8, 0.8, 0.8),
      event("scroll", 12),
      event("typing", 15, 18, 0.2, 0.7),
    ]),
    20,
  );
  const zooms = automaticZooms(track, 20, { clean: true }, { click: true });
  assert.equal(zooms.length, 3);
  assert.equal(zooms[0].mode, "fixed");
  assert.equal(zooms[1].mode, "follow");
  assert.equal(zooms[2].mode, "fixed");
  assert(zooms.every((z) => z.ease === 0.6 && z.start >= 0 && z.end <= 20));
  assert(zooms.every((z, i) => i === 0 || z.start >= zooms[i - 1].end));
  validateEdits(
    { style: defaults, segments: [{ start: 0, end: 20 }], zooms },
    20,
  );
  const closeTargets = automaticZooms(
    raw([
      event("click", 0.1, 0.1, 0.1, 0.1),
      event("typing", 0.4, 2, 0.8, 0.8),
    ]),
    4,
    { clean: true },
  );
  assert.equal(closeTargets.length, 1);
  assert(closeTargets[0].start <= 0.4 && closeTargets[0].end >= 2);
  assert.equal(closeTargets[0].focusX, 1);
  assert.equal(
    automaticZooms(raw([event("click", 1)]), 4, null, { click: true }).at(0)
      .mode,
    "fixed",
  );
  assert.equal(
    automaticZooms(
      raw(Array.from({ length: 150 }, (_, i) => event("click", i * 5))),
      800,
      null,
      { click: true },
    ).length,
    80,
  );
});

test("interaction queries paginate and map source activity through cuts and playback speed", () => {
  const project = {
    duration: 10,
    interactions: validateInteractions(
      raw([
        event("click", 1),
        event("typing", 2, 8),
        event("selection", 4),
        event("click", 6),
      ]),
      10,
    ),
    edits: {
      style: { ...defaults, speed: 2 },
      segments: [
        { start: 0, end: 3 },
        { start: 5, end: 10 },
      ],
    },
  };
  const query = queryInteractions(project, { limit: 2 });
  assert.equal(query.matched, 4);
  assert.equal(query.next_offset, 2);
  assert.deepEqual(query.events[0].output_times, [{ t: 0.5, cut_index: 0 }]);
  assert.deepEqual(query.events[1].output_ranges, [
    { start: 1, end: 1.5 },
    { start: 1.5, end: 3 },
  ]);
  assert.equal(
    queryInteractions(project, { timebase: "output", start: 0, end: 4 })
      .matched,
    3,
  );
  assert.equal(
    queryInteractions(project, { types: ["selection"] }).events[0].output_times
      .length,
    0,
  );
  assert.equal(
    queryInteractions(project, { offset: 2, limit: 2 }).next_offset,
    null,
  );
  project.edits.style.speed = 0.5;
  assert.equal(queryInteractions(project, { timebase: "output" }).matched, 3);
});

test("MCP exposes interaction coverage and timestamps, preserving metadata across edits and cold reopen", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "frame-interactions-"));
  const connection = await connectMcp();
  try {
    await motionFixture(root);
    const project = await readProject(root);
    project.interactions = validateInteractions(
      raw([
        event("click", 0.5),
        event("typing", 1, 2.5),
        event("selection", 3),
      ]),
      4,
    );
    project.edits.zooms = automaticZooms(
      project.interactions,
      4,
      project.cursor,
    );
    await saveProject(project);
    const args = { project_path: root };
    let saved = await call(connection.client, "get_project", args);
    assert.equal(saved.interactions.total, 3);
    assert.equal(saved.interactions.capabilities.typing, true);
    assert(!("events" in saved.interactions));
    const page = await call(connection.client, "get_interactions", {
      ...args,
      types: ["typing"],
      limit: 1,
    });
    assert.equal(page.revision, saved.revision);
    assert.equal(page.events[0].t, 1);
    assert.equal(page.events[0].end, 2.5);
    saved = await call(connection.client, "update_style", {
      ...args,
      expected_revision: saved.revision,
      changes: { speed: 0.5 },
    });
    await assert.rejects(
      () =>
        call(connection.client, "get_interactions", {
          ...args,
          expected_revision: page.revision,
        }),
      /Project changed on disk/,
    );
    const output = await call(connection.client, "get_interactions", {
      ...args,
      timebase: "output",
      start: 5,
      end: 7,
    });
    assert.equal(output.events.at(-1).type, "selection");
    assert.equal(output.events.at(-1).output_times[0].t, 5);
    assert.deepEqual(
      (await readProject(root)).interactions,
      project.interactions,
    );
    await assert.rejects(
      () =>
        call(connection.client, "get_interactions", {
          ...args,
          start: 3,
          end: 1,
        }),
      /End must follow start/,
    );
    await assert.rejects(() =>
      call(connection.client, "get_interactions", { ...args, limit: 1001 }),
    );
  } finally {
    await connection.client.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("cursor button edges recover silent and partial event taps without duplicate clicks or invented text activity", () => {
  const cursor = {
    clean: true,
    samples: [
      { t: 0, x: 0.4, y: 0.3, visible: true, pressed: false },
      { t: 1, x: 0.4, y: 0.3, visible: true, pressed: true },
      { t: 1.05, x: 0.4, y: 0.3, visible: true, pressed: false },
      { t: 1.1, x: 0.4, y: 0.3, visible: true, pressed: true },
      { t: 1.2, x: 0.4, y: 0.3, visible: true, pressed: false },
      { t: 3, x: 0.7, y: 0.8, visible: true, pressed: true },
    ],
  };
  const silent = {
    version: 1,
    capabilities: { click: true, scroll: true, drag: true },
    permissions: { accessibility: false, inputMonitoring: false },
    events: [],
  };
  const recovered = reconcileInteractions(silent, cursor, 4);
  assert.equal(recovered.events.length, 3);
  assert(
    recovered.events.every(
      (event) => event.type === "click" && event.origin === "cursor",
    ),
  );
  assert.equal(recovered.capabilities.typing, false);
  assert.equal(recovered.capabilities.selection, false);
  assert.equal(silent.events.length, 0);
  assert(automaticZooms(recovered, 4, cursor, { click: true }).length > 0);
  assert.deepEqual(reconcileInteractions(recovered, cursor, 4), recovered);
  const partial = raw([
    { ...event("click", 0.99), id: "native-click" },
    event("typing", 1.3, 2),
  ]);
  const merged = reconcileInteractions(partial, cursor, 4);
  assert.equal(merged.events.filter((e) => e.type === "click").length, 3);
  assert(merged.events.some((e) => e.id === "native-click"));
  assert(merged.events.some((e) => e.type === "typing"));
  assert.deepEqual(reconcileInteractions(merged, cursor, 4), merged);
  assert.equal(
    reconcileInteractions(silent, { ...cursor, clean: false }, 4).events.length,
    0,
  );
});

test("text zooms use viewport coordinates and contain whole typing regions at every screen edge", () => {
  for (const rect of [
    { x: 0.02, y: 0.87, width: 0.42, height: 0.1 },
    { x: 0.63, y: 0.02, width: 0.35, height: 0.14 },
    { x: 0.05, y: 0.2, width: 0.7, height: 0.3 },
    { x: 0.02, y: 0.01, width: 0.92, height: 0.95 },
  ]) {
    const data = validateInteractions(
      raw([
        {
          ...event("typing", 1, 3, rect.x + 0.1, rect.y + 0.04),
          contextRect: rect,
        },
      ]),
      6,
    );
    const zooms = automaticZooms(data, 6);
    if (!zooms.length) {
      assert(rect.width > 0.9 || rect.height > 0.9);
      continue;
    }
    const z = zooms[0],
      size = 1 / z.zoom,
      left = (1 - size) * z.focusX,
      top = (1 - size) * z.focusY;
    assert(left <= rect.x + 1e-9 && top <= rect.y + 1e-9);
    assert(
      left + size >= rect.x + rect.width - 1e-9 &&
        top + size >= rect.y + rect.height - 1e-9,
    );
  }
  // Exact source position from the user's bottom-left composer regression.
  const z = automaticZooms(
    raw([event("typing", 1.84, 3.14, 0.133798, 0.951055)]),
    6.25,
  )[0];
  assert.equal(z.focusX, 0);
  assert.equal(z.focusY, 1);
  // A moving caret must retain the beginning of the line, not just its last rect.
  const zoom = automaticZooms(
    raw([
      {
        ...event("typing", 1, 1.4, 0.2, 0.5),
        rect: { x: 0.1, y: 0.5, width: 0.1, height: 0.03 },
      },
      {
        ...event("typing", 1.6, 2, 0.4, 0.5),
        rect: { x: 0.3, y: 0.5, width: 0.3, height: 0.03 },
      },
    ]),
    5,
  )[0];
  const size = 1 / zoom.zoom,
    left = (1 - size) * zoom.focusX;
  assert(left <= 0.1 && left + size >= 0.6);
});
