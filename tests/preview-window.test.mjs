import test from "node:test";
import assert from "node:assert/strict";
import { resizePreviewBounds } from "../desktop/preview-window.mjs";

test("floating preview corner resizing preserves its anchor, square and display limits", () => {
  const area = { x: -1440, y: 40, width: 1440, height: 900 };
  const bounds = { x: -1100, y: 280, width: 248, height: 248 };
  for (const corner of ["nw", "ne", "sw", "se"]) {
    const sx = corner.endsWith("w") ? -1 : 1;
    const sy = corner.startsWith("n") ? -1 : 1;
    for (const delta of [-10000, -30, 0, 80, 10000]) {
      const next = resizePreviewBounds(
        bounds,
        corner,
        sx * delta,
        sy * delta,
        area,
      );
      assert.equal(next.width, next.height);
      assert.ok(next.width >= 192 && next.width <= 640);
      assert.equal(
        sx < 0 ? next.x + next.width : next.x,
        sx < 0 ? bounds.x + bounds.width : bounds.x,
      );
      assert.equal(
        sy < 0 ? next.y + next.height : next.y,
        sy < 0 ? bounds.y + bounds.height : bounds.y,
      );
      assert.ok(next.x >= area.x && next.y >= area.y);
      assert.ok(next.x + next.width <= area.x + area.width);
      assert.ok(next.y + next.height <= area.y + area.height);
      if (delta === 80) assert.equal(next.width, 328);
      if (delta === -10000) assert.equal(next.width, 192);
    }
  }
  // Project one-axis movement onto the resize diagonal rather than stretching.
  assert.equal(resizePreviewBounds(bounds, "se", 80, 0, area).width, 288);
});
