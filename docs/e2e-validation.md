# End-to-end validation — 2026-10-14

The packaged app passes **twenty-five Electron workflows**, and **forty-four unit/media/MCP integration checks** pass. See [motion validation](motion-validation.md) and [MCP validation](mcp.md) for coverage. The additional [timeline performance test](timeline-performance.md) exercises 100 clips and 80 zooms with continuous scrubbing and burst pointer input. After the Mac was unlocked on October 14, a real five-second ScreenCaptureKit window recording passed saved-project creation, MCP cuts/zoom, preview generation, export and full decoding. The live check also exposed and fixed a native startup crash. See [the live-capture report](live-capture.md). Webcam, microphone and system audio were off in that capture check; the current startup fix uses synthetic capture tests and read-only validation of an existing webcam recording.

Typing and selection tracking is required for new recordings. Permission checks run in the dialog and main process before creating a project; the native helper and main process verify the listener at startup. Regression coverage includes denied access, permissions changing before Start, failed listener startup, and a native track reporting click support while delivering no events. Independently sampled cursor presses recover missing clicks without duplicates; those clicks produce editable zooms and remain queryable through MCP. Older recordings retain their truthful permission coverage; missing text activity cannot be reconstructed.

The interaction-fix run passed 23 of 24 app workflows on its first pass. The playback startup budget failed with the system Bluetooth output (about 0.55–0.65 seconds before clock advancement). The unchanged timing and cadence assertions passed when the isolated test routed its media to built-in speakers; `tests/ui/playback.spec.mjs` now selects that output when available without changing the system default. This validates app playback on that route, not Bluetooth device latency. Logs: `.cache/interaction-fix-e2e.log` and `.cache/interaction-fix-playback-builtin.log`.

## Workflows exercised in the packaged executable

| Workflow                                                                                     | Evidence checked                                                                                                                                                                                     | Result         |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Synthetic screen + webcam + microphone recording → Stop & edit → playback → combined and separate export  | Generated native screen fixture plus actual webcam/microphone MediaRecorder, IPC chunk writes and MKV remux, 16:10 source canvas in preview and combined export, independent webcam proportions, decoded camera frames and advancing playback, synchronized MP4 durations, audible signal in decoded audio | Pass |
| Import two MP4s → split/trim → change speed, camera offset/layout, padding/background → save | Original files and project copies have identical hashes; edits match the UI                                                                                                                          | Pass           |
| Fully close app → new process → Open project                                                 | Persisted edits, clip count, total duration, padding, and decoded camera preview survive a cold reopen                                                                                               | Pass           |
| Export Both at 1080p/60 fps                                                                  | Three MP4s, two-second edited duration, correct frame rates/aspect ratios, full decode with no corrupt packets, mixed audio only in screen/combined                                                  | Pass           |
| Export Separate at 720p/30 fps with webcam audio enabled                                     | Two MP4s, matched duration, non-silent decoded audio in both, source aspect ratios preserved                                                                                                         | Pass           |
| Camera synchronization and framing                                                           | Intentional manual delay stays blank; capture startup holds the first frame in webcam/composition previews and exports; later frames remain synchronized across cuts and speed changes | Pass           |
| Capture startup and existing webcam recordings | Actual MediaRecorder starts before a native helper with a simulated 300 ms startup delay; negative capture offset and frame-zero image verified. Existing 290 ms gaps, positive/negative manual adjustments, reverse scrubbing and playback checked | Pass |
| Screen-only project → cancel destination picker                                              | Separate export remains unavailable without a camera                                                                                                                                                 | Pass after fix |
| Start 4K/60 fps render → cancel after nonzero progress → retry successfully                  | Temporary output removed, controls restored, subsequent 720p silent combined output fully decoded                                                                                                    | Pass           |
| Available capture sources → reopen picker after a simulated capture-permission error         | Previous source is cleared; Start recording is disabled                                                                                                                                              | Pass after fix |
| Editor interaction/layout                                                                    | Undo/redo, live slider gesture undo, drag trim, keyboard navigation, Space play/pause with clip/scrubber/control focus and key repeat, preserved field/dialog behavior, separate preview aspect ratios, large and 1024 × 700 layouts | Pass |

Webcam roundness is validated at 0%, 50% and 100% using decoded export and MCP-preview pixels. The packaged UI checks live slider updates, one-step undo/redo, preset synchronization, saving/cold reopening, and actual rounded-corner pixels. Separate camera exports retain their full frame. Legacy circle/square projects retain their appearance.

Cursor capture is automatic on supported macOS versions. The packaged recording test starts without a cursor option, checks separate cursor data, edits visibility/size/smoothing/click highlights after recording, saves and reopens those settings, and renders a decoded export. The recording workflow simulates macOS 14 to verify that required native text tracking blocks recording, then restores native capture support and exercises the generated screen fixture with real camera/microphone MediaRecorder streams. Imported media remains available. Screenshots: `evidence/motion/recording-picker.png` and `evidence/motion/cursor-editor.png`.

The same recording workflow verifies the floating webcam preview: shared camera stream, transparent squircle corners, full-bleed video, all four corner resize gestures with a fixed opposite anchor and square bounds, size limits, Escape cancellation, a preview-only mirror toggle, controls that reveal on hover or keyboard navigation and disappear on pointer leave, live video while the editor is minimized, hide/restore, stopping from the preview, and cleanup when capture exclusion cannot be confirmed. The additional [native webcam-preview check](webcam-preview.md) is designed to compare filtered and unfiltered ScreenCaptureKit recordings and independent exports. After the user unlocked the Mac and requested a retry, the real display check passed: preview pixels appeared in the unfiltered control, were absent from both the app screen track and separate screen export, and remained present in the webcam export. See `evidence/webcam-preview/latest.json` for the exact tested package and helper hashes.

GIF exports are checked through the UI and MCP: all three outputs, looping metadata, full decoding, durations after cuts/speed changes, colors across cut boundaries, no audio, palette cleanup after cancellation, remembered format settings, and zoom/cursor alignment after palette dithering. Evidence includes `evidence/e2e/gif-export.png`, `evidence/e2e/combined.gif`, and the GIF section of `evidence/mcp/checks.json`.

## Bugs fixed during validation

1. Cancelling export restored every control indiscriminately, enabling Separate tracks for screen-only projects. Export controls now reapply project capabilities and audio choices after cancellation/completion.
2. A failed source refresh retained the last capture source and enabled Start recording. Opening the picker now clears stale state, disables recording during loading, and leaves it disabled after failure.
3. The native screen recorder started before the webcam recorder, leaving a black lead-in. The webcam/microphone now start first. Existing recordings hold their first webcam frame over the capture offset without moving later frames or audio. The reported recording's saved offset was 0.289707 seconds and its first source frame was valid. Read-only checks confirmed the corrected preview at 0, 0.1 and 0.25 seconds matches that first frame; the project file was unchanged (`evidence/webcam/existing-recording.json`).

## Test boundaries

- In the import/export workflows, only native file-picker answers and opening Finder are substituted. The app UI, preload/IPC, project creation/import/persistence, media playback, and FFmpeg rendering are real.
- The recording test supplies generated browser media streams and a fake source/device inventory. It exercises actual encoding, saving, playback and export, but does **not** prove ScreenCaptureKit selection, camera drivers, microphone access, macOS permission dialogs, global recording hotkeys, or hardware timing.
- The permission-error test intentionally injects a source-enumeration failure; it proves UI recovery from that failure, not a successful native capture.
- Read-only permission status from the packaged process was: screen **granted**, microphone **granted**, camera **not-determined**. Permission status is not recording evidence.
- Initial native inspection was blocked by the Mac lock screen. The later live check used only a dedicated generated window after unlock. The existing user editor and its unsaved changes were left open; camera/microphone permissions were not changed.
- Tests use short recordings. Long-session drift, memory use and hardware capture performance remain unmeasured.

## Reproduce

```sh
npm run typecheck
npm test
npm run test:e2e
```

`test:e2e` builds and signs the app, then runs the entire Electron suite against that exact packaged executable. It uses isolated profiles and generated media in `.cache/ui-test` and `.cache/e2e-workflow`, leaving user projects untouched.

Machine-readable results: `evidence/e2e/workflow-results.json`. Decoded-output inspection: `evidence/e2e/export-inspection.json`. Packaged runtime hashes: `evidence/verification.json`. Screenshots: `evidence/e2e/` and the editor screenshots in `evidence/`.

## Canvas and imported image workflow

Playback continuity is covered by `tests/ui/playback.spec.mjs`: 60 fps portrait HEVC with 44.1 kHz AAC, uninterrupted audio startup, one intentional cut at 1.5× speed, and a silent screen following a separate microphone clock. The actual reported video was also profiled read-only in an isolated app. See [playback performance](playback-performance.md) for the reproduction, before/after measurements and scope.

`tests/ui/canvas.spec.mjs` imports a generated 640 × 400 PNG and webcam MP4 through real IPC/file import with desktop capture disabled; verifies the new project's Source ratio and 16:10 preview; chooses TikTok and Instagram sizes; verifies fit/fill pixels and undo; saves, cold reopens and exports portrait composition plus full-frame independent tracks. All outputs are fully decoded and colors are compared between the editor and final composition. Screenshots cover 1440 × 930 and 1024 × 700. It also imports a rotated portrait MP4, preserves the original bytes, and verifies that the default Source ratio uses displayed dimensions. Evidence is `evidence/canvas/checks.json` and `evidence/canvas/source-default.png`.

`tests/composition.test.mjs` checks seven ratios in actual FFmpeg previews, fit/fill colors, unchanged source-image bytes, cuts on image media, portrait MP4 and square GIF, and MCP template discovery/edit validation/portrait previews.

## Audio waveform validation

`tests/waveform.test.mjs` decodes timed audio pulses and silence, preserves opposite-phase stereo, bounds peak storage for long recordings, verifies cancellation/error handling, and invalidates cached peaks after source media changes.

`tests/ui/waveform.spec.mjs` verifies waveform canvas pixels against generated audio: independent screen/microphone bands, a one-second microphone offset, volume and undo, splitting, trimming, speed changes, and magnification with stable canvas nodes. The dense timeline test now contains real audio and waits for all 100 waveform clips before profiling selection, dragging, scrubbing and playback. Evidence: `evidence/waveform/checks.json`, `evidence/waveform/audio-timeline.png`, and `evidence/timeline/after.json`.

## Drag creation and follow/fixed zooms

The packaged zoom workflow tests the 1.2-second ease-in/out default, short-section duration feedback, duration edits with undo/redo and cold reopen, forward/reverse dragging, a cut endpoint, overlap clamping, Escape/pointer cancellation, one undo per gesture, magnified/scrolled coordinate mapping, follow preview pixels, fixed focus selection on the full source, persistence after cold reopen and fixed fallback for imported media. `tests/follow.test.mjs` checks deterministic smooth tracking across cuts and hidden/clicked cursors, decoded MP4 at 30/60 fps, GIF at 20 fps, preview images and an 80-section FFmpeg filter. Evidence is in `evidence/follow/`. Generated media and cursor tracks exercise these controls without starting a live capture.

## Additional canvas media

`tests/layers.test.mjs` verifies layer validation, project-relative asset safety, transparent image preservation, stacking, opacity, timed video, retained cuts and speed. Decoded preview, MP4 and GIF pixels are checked; independent exports exclude canvas layers. MCP discovery includes the layer and asset catalog, and existing style edits preserve layers.

`tests/ui/layers.spec.mjs` exercises the file picker through real IPC with multiple files, preserves an unsaved ratio change, moves and resizes on the canvas, trims on the layer timeline, changes stacking, removes/undoes, plays active videos and checks inactive decoders pause, saves, cold reopens and exports. Screenshots cover normal and compact windows in `evidence/layers/`; `checks.json` ties the workflow to its packaged ASAR hash. Video layers are visual and muted. Synthetic media is used; this feature does not require a new live capture.

## Delete selection and audio removal

`tests/ui/delete.spec.mjs` checks Delete and Backspace for canvas media, zooms and audio; switching targets; toolbar parity; undo/redo; number fields, editable text, dialogs and repeated-key guards; screen/microphone preview volume; and cold reopen. Its exported MP4 retains four seconds of video, with decoded silence in the removed audio range and audible samples in the retained range. Evidence: `evidence/delete/checks.json`.

`tests/audio-edits.test.mjs` validates and merges source-time removal ranges, checks remaining audio fragments, preserves removals through MCP style edits, and decodes combined/screen/webcam exports after cuts, offsets and speed changes. Export uses a balanced sample-time lookup to silence precisely the removed output ranges without changing the playback clock or media duration.

## Webcam orientation

The packaged camera workflow verifies actual camera and composition pixels before and after **Flip horizontally**, unchanged screen pixels, undo/redo and cold reopen. Evidence: `evidence/camera/checks.json` and `flip.png`. `tests/camera-flip.test.mjs` changes the setting through MCP and checks decoded preview, combined/separate MP4 and GIF pixels across cuts, offsets and speed changes. Old projects default to unflipped; source media remains byte-identical. `tests/preview-window.test.mjs` additionally covers all four resize directions, negative display coordinates, display limits and minimum/maximum square sizes.

## Project organization

The packaged projects workflow selects a projects folder once, cancels an initial selection safely, imports into automatically named folders, repeats imports without another folder/name dialog, and allocates numbered recording folders through the real recording IPC. It checks Enter/blur rename, Escape cancellation, blank-name rejection, preservation of unsaved edits, stale-revision rejection, cold reopening, persistence of the chosen folder, and changing the folder for subsequent projects. Evidence: `evidence/projects/checks.json`, `folder.png` and `rename.png`. A unit integration check covers concurrent exclusive allocations, name collisions, missing folders and prevention of nesting projects inside projects. Existing recording/import/export tests exercise the updated creation flow.

## Direct import and media properties

`tests/ui/media.spec.mjs` verifies that **Use video or image** opens the native chooser directly, cancellation keeps the project and unsaved edits, and selecting a source or added layer shows its own properties. It edits trim, speed, placement, volume, webcam flip/roundness and layer opacity; exercises undo/redo; selects from the canvas and timeline; attaches a webcam without discarding unsaved edits; rejects a stale attachment revision and cleans up its staged file; checks unchanged original media bytes; and cold reopens the result. The source filename and kind survive reopening. Screenshots include the empty timeline, source and webcam properties, and a compact layer inspector. Evidence: `evidence/media/checks.json`, tied to the packaged ASAR hash. Native picker answers use generated files; editing, IPC and persistence run in the real app.

## Interaction recording and automatic zooms

The packaged interaction workflow uses a generated native-protocol fixture, the real recording UI/IPC, saving, cold reopen, undo/edit/delete, MCP filtering and source/output mapping after cuts and speed changes, inline preview and a fully decoded render. `evidence/interactions/checks.json` identifies the exact ASAR. The separate native check (`node scripts/check-interactions.mjs`) records a dedicated generated text window with ScreenCaptureKit, injected click/key events and AppKit selection changes; it verifies the passive event tap, Accessibility geometry, typing-burst grouping and synchronized timestamps. It does not test physical keyboard drivers or every third-party editor. Evidence is in `evidence/interactions/native.json` and tied to the helper hash.

## Inspector redesign

The inspector now uses labeled horizontal tabs, separates selected properties from the media library, and removes nested scrolling. `tests/ui/inspector.spec.mjs` checks 15 media items, long names, 1440 × 930 and 1024 × 700 windows, keyboard navigation/selection, selected controls above the fold, accurate slider fills, undo/redo and restored tab scroll positions. Existing import, webcam attachment, layer selection/deletion, waveform, timeline and editor workflows exercise the new browsing flow. Screenshots and package identity are in `evidence/inspector/`.
