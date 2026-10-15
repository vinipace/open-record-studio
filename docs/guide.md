# Editor guide

[Back to the README](../README.md)

## Workflow

1. Choose **New recording**, select a screen/window and optional webcam/microphone, and start. Grant the macOS permissions when requested. The editor minimizes; with native capture on macOS 15+, a floating squircle webcam preview stays visible. Drag the video to move it or drag any corner to resize it while preserving the squircle. Hover to reveal the timer, mirror, hide and stop controls. The preview starts mirrored; its mirror toggle changes only the floating view. Open Record Studio's windows are explicitly excluded from display recordings.
2. Stop using the webcam preview's **Stop recording** button (shown on hover), **⌘⇧2**, the menu bar recording control, or **Stop & edit** in the app. **×** hides the preview without stopping the camera; restore it with **● REC → Show webcam preview**.
3. Scrub, split with **S**, select and delete unwanted clips, and edit source in/out boundaries. Screen, webcam, and audio share the timeline. **⌘Z** undoes, **⌘⇧Z** redoes, and **⌘S** saves.
4. **⌘-drag** across the timeline to select a time range, then press **Delete** or **Cut** to remove it across every track and close the gap. **⌘Z** restores it.
5. Drag across an empty part of the **Zoom** lane to add a section, or use **Motion → Add** at the playhead. New sections default to **Follow mouse**, which smoothly follows recorded cursor movement across cuts. Select **Fixed focus → Choose focus in preview** to pick a point on the full screen image. Media without cursor data defaults to fixed framing. Event-generated zooms have distinct markers: teal pointer for clicks, blue keyboard for typing, and amber text-selection icon for selections. Drag a section to move it, or drag its edges to resize it. Adjust scale and **Ease in & out** duration; new sections use a gentle 0.6-second transition with smooth starts and stops. Adjacent sections blend directly between views. Escape cancels a drag or focus selection. New recordings automatically capture an editable cursor on macOS 15+ with the native helper. After recording, use this inspector to show/hide the pointer and adjust its size, smoothing and click highlights. Imported videos with baked cursors keep their original pointer.
6. Use the inspector rail to adjust background/screen, camera, audio, or clip/speed settings. Sliders preview changes live; one undo restores the entire slider gesture. In **Camera → Shape**, adjust **Roundness** from square (0%) through rounded corners to a circle (100%), or click a shape preset. Roundness applies to the composition overlay; separate webcam output keeps the full frame. **Camera → Position → Margin** controls the webcam inset from the canvas edges (0–20%, default 3.5%) and is also available in the webcam’s media properties. Margin scales with export resolution, stays within the canvas, and is saved with the project. **Camera → Orientation → Flip horizontally** flips the webcam in both project previews and combined/separate exports, with undo/redo and saved-project persistence.
7. Switch between **Composition**, **Screen**, and **Webcam** above the preview to inspect each output. Drag timeline edges to trim, double-click a clip to open its inspector, and use the arrow keys to step frames (Shift for one second).
8. Choose **Export video**, then select **MP4 video** or **Animated GIF**. Choose the composition, **Separate tracks**, or **Both**. Both tracks receive the same cuts, speed, and timing. Separate screen output includes screen zoom; separate webcam output retains the full camera frame. Backgrounds and the picture-in-picture crop are only part of the combined video.

Choose your **Projects folder** once, either when creating your first project or from the button at the bottom of the inspector. Open Record Studio remembers it across restarts. Recordings are named **Recording 1**, **Recording 2**, and so on; imports use their media filename, adding a number for duplicates. No project name or save-location dialog appears after the folder is set. Change the folder anytime for future projects.

Double-click the project title to rename it. Enter or clicking away saves the name; Escape cancels. Keyboard users can focus the title and press Enter. Renaming preserves unsaved timeline edits and keeps the project's directory stable for existing file/MCP references. Existing projects stay in their original folders.

**Use video or image** opens the file picker directly. Choose MP4, MOV, MKV, WEBM or M4V, or a PNG/JPG/WEBP still image. Images start with a 10-second clip; trim it in **Media** or the timeline. Add an optional separate webcam video from **Media → Add webcam video**. Original files are copied into the project. Images also get a timed video track for playback, cuts, zooms and export. The recording picker offers the same **Use a video or image** entry. **Explore a sample project** generates local synthetic media with original artwork to exercise the editor without recording devices. Existing sample projects are preserved; the updated UI example is `examples/design-preview.framestudio`.

An export creates a new folder containing `screen.mp4`, `camera.mp4`, and/or `combined.mp4` (or `.gif` for GIF exports), plus `export.json`. GIFs loop continuously with no audio, using a global palette and dithering. GIF defaults are 480p/20 fps, with 360p–1080p and 10/15/20/30 fps choices. MP4/GIF resolution and frame-rate choices are remembered separately while the app is open. With audio enabled, separate screen output contains only system/source audio; separate webcam output contains microphone audio, including added webcam takes. Combined output mixes both. The same routing applies to **Both** exports. Capture startup gaps hold the first webcam frame in preview and export, preserving the timing of subsequent frames and audio. A deliberate positive camera adjustment still adds a blank lead-in; missing coverage after the camera ends stays black. Cancelling an export removes its temporary output folder. MP4 exports use Apple hardware H.264 encoding when available, with an automatic software fallback. MP4 exports of MP4/MOV/M4V screen sources decode through AVFoundation and draw zooms and cursors on Metal directly at output resolution, with no full-frame cursor movie. Separate screen output reuses those encoded frames without another encode; combined output reuses the same prepared screen. Other source formats and GIF retain the FFmpeg renderer with a working resolution sized for the deepest retained zoom. The progress bar includes preparation and all output tracks, with elapsed time and a live estimate after warmup. A desktop notification appears after every file has been verified; click it to open the export folder. macOS notification settings and Focus modes still apply.

## Audio enhancement

**Audio → Enhance Audio** reduces speech background noise using a bundled RNNoise recurrent neural network model. It is off by default. Enable it once and wait for local preparation; playback then uses cached lossless audio, with no inference in the playback loop. The same enhanced source feeds MP4 exports, including microphone audio in webcam takes. Cuts, timing, speed, volume and mute ranges still apply. Originals stay untouched; switching off restores the original audio. No audio is uploaded. The setting supports undo, save/reopen and MCP `update_style` (`enhanceAudio: true`). Model attribution is in [desktop/models/NOTICE.md](../desktop/models/NOTICE.md).

## Interaction zooms and metadata

Native recordings automatically create smooth, editable zooms around clicks, typing bursts and text selections. Nearby activity is grouped so individual keystrokes do not cause repeated zooms. Text activity uses the caret/selection area when the source app exposes it; clicks can follow the recorded cursor. Adjust or delete these sections in **Motion** like any other zoom.

In **New recording**, use **Enable required access** to grant macOS Accessibility and Input Monitoring access. Typing and selection tracking is always enabled: recording is blocked until both permissions are available, and startup verifies that the native listener is active. Missing click events are recovered from the independently sampled cursor even if the native listener reported click support. Text-selection support depends on the source app's accessibility information; secure text fields are excluded. Tracking runs only during recording and is scoped to the selected screen/window, excluding Open Record Studio. Only event types, timestamps, counts and normalized positions/rectangles are retained; typed characters, selected text and clipboard contents are not collected.

Projects save click, typing, selection, scroll and drag events. The MCP's **get_interactions** tool queries them with type/time filters, pagination, and mapping through cuts and speed. Old cursor recordings expose derived click times; imported videos have no interaction data. See [interaction capture](interactions.md).

## Media and its properties

The inspector has labeled **Canvas**, **Camera**, **Audio**, **Motion**, **Timing** and **Media** tabs. **Media → Properties** puts the selected item’s controls first, grouped by layout, appearance, audio and timing. **All media** lists source tracks and canvas overlays; selecting an item there, in the timeline, or on the canvas opens its properties at the top. **＋ Add** remains available in either view. One scroll surface handles long lists, tab switches restore scroll position, and both tab rows support arrow-key navigation. Source video/image controls include placement, padding, trim, speed and source-audio volume when available. Webcam controls include visibility, horizontal flip, size, roundness, position and timing offset. Added layers retain their position, size, opacity, ordering and timing controls. Source cuts and speed stay linked across screen, webcam and microphone tracks.

Imported sources show their original filename in the media list and timeline. Absent webcam/audio tracks are hidden; the empty editor shows an import/recording hint. Cancelling import keeps the current project and edits. Adding a webcam preserves unsaved edits; conflicting disk revisions are rejected.

## Additional canvas media

Use **＋ Add media** beside **Record**, or **Media → Add**, to add multiple PNG/JPG/WEBP images or MP4/MOV/MKV/WEBM/M4V videos to the current project. Images retain transparency. Up to 16 independent layers sit above the screen and webcam.

Select a layer in the canvas, inspector or timeline. Drag to position it and drag its bottom-right corner to resize with its proportions preserved. Adjust opacity, visibility and order in **Media → Properties**. Drag its timeline body to move it, drag its edges to trim, or enter source in/out times. Video start chooses an offset within the added video. Layers follow project cuts and speed, support undo/redo and save/reopen, and appear in combined MP4/GIF exports and MCP previews. Separate screen/webcam exports retain their original content. Added videos are muted; the screen and microphone supply the audio mix. Inactive video layers stay paused.

To record over an existing video, place the playhead at the desired start and choose **Record → Record webcam here**. Select a camera and microphone (or turn the microphone off), then press **Record**. The project plays while the webcam records; the floating preview remains available. **Stop & edit**, **Space**, **Escape**, or **⌘⇧2** saves the take. Recording also stops at the end of playback. The take is inserted at the chosen timestamp and selected for editing.

Each webcam take is an independent canvas layer with size, position, roundness, horizontal flip, microphone volume and timing controls. The recorded playback clock maps it across existing cuts and speed changes, including startup delays and stalls. Takes are included in combined exports and MCP previews; separate screen/webcam videos keep their original picture tracks, with microphone audio routed to the webcam output. A take's microphone is independent of removed source-audio ranges, so the original audio can be removed while retaining the replacement narration. Recording saves the project's current edits first; a revision conflict prevents overwriting external changes. Failed takes retain their captured files in the project for recovery.

Webcam takes recorded with a microphone show a separate amber audio lane directly below their video lane, including existing saved takes. The waveform follows recorded timing, cuts, speed and volume. Select it to adjust microphone volume; Delete mutes that take's audio without removing its video, and Undo restores it. Moving or trimming either lane keeps the take's video and audio together. Takes recorded without a microphone have no extra audio lane.

Files are copied into the project's `assets/` folder. Removing a layer preserves its media for undo. Adding media does not discard or automatically save other unsaved edits.

## Delete selected items

**Delete** or **Backspace** removes the selected canvas media layer, zoom section, or audio section. The toolbar trash button uses the same selection. Removing audio silences both screen and microphone audio for that source range while keeping the video and timeline duration. Removal persists in saved projects and combined/separate exports, and **⌘Z** restores it. Clicking another item changes the deletion target; repeated key events never cascade into another item. Text fields, editable text and open dialogs keep their normal keyboard behavior. Video clips remain linked, and the final screen clip is retained.

## Audio waveforms

The Audio lane shows real decoded waveforms for screen audio and microphone audio. With both sources, screen audio is the upper band and microphone audio the lower band; hover a clip for the labels. Silence stays flat, and volume, source offsets, cuts, trims, playback speed and timeline magnification are reflected in the display. Waveforms load in the background, with cached peak data and persistent canvases so selection and playback do not rebuild them. Existing projects get waveforms when reopened; no migration or re-recording is needed.

## Canvas ratios and social templates

New recordings and imports default to **Source**, matching the recorded screen/window or imported media's proportions in preview and export. In **Canvas → Format**, select Instagram Reels/Story/portrait/square, TikTok, YouTube/Shorts, or Presentation. Or choose 16:9, 9:16, 1:1, 4:5, 4:3, 3:4, or **Source**. Templates are size presets; platform upload limits are not enforced. **Fit** shows the full source within the background, while **Fill** crops it to cover the padded canvas. These settings support undo, save/reopen, MCP previews, MP4 and GIF.

At the 1080 resolution setting, 9:16 exports 1080 × 1920, 4:5 exports 1080 × 1350, square exports 1080 × 1080, and 16:9 exports 1920 × 1080. The export dialog displays exact dimensions. Composition ratios apply only to the combined output; separate screen/webcam outputs retain their full source proportions and use the selected height. Existing projects retain their saved ratio; legacy projects without a ratio continue to open as 16:9. Select **Source** to match an existing project's recording. Source ratio respects portrait rotation metadata in imported video.

## MCP automation

Connect the local **open-record-studio** MCP server using the [setup instructions](mcp.md). Its 15 tools provide render jobs with progress/cancellation, inline preview images, cut and zoom editing, cursor/webcam/appearance settings, and atomic batch edits with dry runs. Project summaries include source/output timeline positions and supported controls/export settings. It operates on saved projects with revision checks; the desktop shows **Reload** for external changes and protects unsaved edits from stale saves. Start a new MCP session to load the tools.

See [MCP setup, tool definitions and examples](mcp.md). The companion server runs from this checkout with `npm run --silent mcp`; it is independent of the desktop window.

## Project format

A `.framestudio` directory contains `project.json` and its independent media files. Version 1 records each track's file, dimensions, duration, audio presence, and offset from the screen clock. Edits contain ordered source-time segments, optional zoom sections, canvas layers and composition settings. Editable-cursor recordings also contain normalized source-time cursor samples. Standard captures stream chunks to disk and are remuxed to indexed MKV on completion without re-encoding. Editable-cursor screen captures are written to MP4 by the native helper; webcam and microphone tracks retain the MediaRecorder path. Imported videos keep their original container. Still images preserve the original file beside a timed MP4 screen track. Original capture files remain available after an unsuccessful finalization for manual recovery.

Timing uses MediaRecorder start events for browser tracks and the first screen presentation timestamp for native capture, with a manual webcam offset adjustment. Webcam and microphone recorders start before screen capture; their preroll is trimmed through track offsets. Exact hardware capture latency and long-recording clock drift have not yet been measured.

## Implementation

| Location              | Responsibility                                                                  |
| --------------------- | ------------------------------------------------------------------------------- |
| `src/main.ts`         | Recording controls, editor UI, canvas preview, playback, undo/redo              |
| `src/canvas-media.ts` | Canvas layer editing, selection, timeline gestures and independent visual decoders |
| `src/filmstrip.ts`    | Bounded media thumbnail extraction with independent decoders                    |
| `src/timeline-view.ts` | Persistent clip, thumbnail and zoom DOM for timeline interactions |
| `src/timeline.ts`     | Shared source/output timeline mapping                                           |
| `desktop/main.mjs`    | Electron permissions, source selection, project files, IPC and export lifecycle |
| `desktop/preload.cjs` | Narrow renderer bridge                                                          |
| `desktop/media.mjs`   | FFmpeg probing, validation, timeline filters, audio mixing, synchronized export |
| `scripts/package.mjs` | Packages only independent runtime code and verifies its local signature         |
