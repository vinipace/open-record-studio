# Zoom movement and range cuts

New manual and event-generated zooms default to 0.6 seconds of easing at each edge. Existing saved easing values are preserved. Automatic zooms retain their triggering activity (`click`, `typing`, or `selection`) through validation, saves and MCP reads. Older `auto-N` zooms are recognized as event-generated. Click zooms use a teal pointer, typing zooms a blue keyboard, and selection zooms an amber text-selection icon. Manual sections stay purple; older automatic zooms without a known trigger use a neutral lightning marker. Selected sections have a brighter fill and inner border. The tooltip and zoom picker name the event type.

Drag a zoom's body to move it; its edges still resize it. Movement preserves its visible output duration across retained cuts and playback speed, and stops at neighboring zooms or the timeline bounds. Pointer updates are batched per frame, track scrolling, and scroll automatically at the viewport edge. Release commits one Undo entry. Escape, lost capture or window focus cancellation restores its original position.

Command-drag anywhere over the timeline tracks or ruler to select a time range. Delete or the compact Cut button removes that interval from every track and closes the gap. All media remains anchored to source time, preserving camera, microphone, overlays, cursor and motion synchronization. Items wholly removed from the retained timeline are removed from the edit list; Undo restores everything. Selection can span existing cuts and can be drawn in either direction. Escape clears it.

The existing project format requires at least one retained clip and at most 100 clips. Remainders shorter than its 0.05 source-second minimum are discarded. Removing the whole timeline is rejected without modifying the project.

Validation: `tests/timeline-editing.test.mjs` checks event provenance, legacy recognition, cut-aware movement, limits, range deletion, Delete/Undo/Redo, pointer coalescing, scrolling, final release and cancellation. Focused existing motion and interaction checks cover the 0.6-second easing and capture grouping. The UI/E2E suite was not rerun for this change.
