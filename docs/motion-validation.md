# Timeline, zoom and cursor — 2026-10-14

## What changed

- Timeline magnification (1–6×), horizontal scrolling, pointer scrubbing with shared ruler/track coordinates, linked edge trims and one undo per gesture. Clip, thumbnail and zoom nodes remain in place through selection, trimming and release. Pointer events are batched once per display frame. See [timeline performance](timeline-performance.md). Speed changes preserve the source position.
- A Zoom & cursor inspector and purple zoom lane. Drag an empty area in either direction to create a section, with a range preview, overlap clamping, cancellation and one undo per completed gesture. Add/remove sections, drag their outer edges, change their source boundaries, zoom scale, focus and transition duration. Ninth-order easing gives zero velocity, acceleration and jerk at transition endpoints, with symmetric entry/exit, a broad speed peak and no overshoot. Zoom sections persist through save/open, cuts and speed changes.
- New sections follow recorded mouse movement by default. The camera smooths positions over an output-time window, holds the last visible pointer position while hidden, and uses continuous bounded tangents. Camera tracking is independent of pointer appearance and click highlights. Fixed focus has a full-source preview picker with a crop outline. Imported media without cursor metadata defaults to fixed; legacy sections without a mode retain fixed framing.
- Camera motion uses logarithmic magnification and a fixed pivot for fixed sections instead of interpolating focus and magnification independently. Source-anchored zoom sections are mapped onto the retained output timeline, so a cut inside a transition cannot skip camera positions. Touching sections blend directly between views instead of zooming out and back in. New sections default to a 0.6-second transition; saved transition values are preserved. Desktop exports now default to 60 fps, matching MCP renders; 30 fps remains selectable. Short sections clamp transitions to half their retained duration; the inspector shows that limit and explains how to slow the move.
- Scrubbing paints each completed seek before dispatching the latest pending target, with zoom/cursor evaluated at that displayed frame time. Playback follows the audible media clock (screen audio, or microphone for a silent screen) instead of seeking to catch up with wall time. Intentional cuts seek directly; the browser handles buffering without an extra pause/play cycle. A delayed webcam decoder cannot restart the primary audio pipeline. Rendering follows decoded frames and avoids rebuilding timeline/transport DOM on every animation frame. Local media explicitly supports HTTP byte ranges; the previous file-response proxy could leave a seek at time zero.
- Automatic editable cursor capture, with all appearance controls in the **Zoom & cursor** inspector after recording. An original Swift ScreenCaptureKit helper records H.264 screen video at up to 60 fps with the native pointer excluded, and samples pointer position/button state separately. Cursor size, smoothing, visibility and click highlights are editable. The helper records no keystrokes and stops when its parent closes stdin.
- Imports without cursor metadata keep their existing pointer. Their cursor controls are disabled, preventing a duplicate pointer overlay.
- Opening a project at launch validates it before creating the window, avoiding a blank startup window. Packaged helper lookup resolves the actual app archive location.
- Preview and export share the output-time camera path, source-time media mapping and cursor interpolation. Export uses subpixel perspective sampling and a timestamped alpha cursor layer. Following paths compile into adaptive cubic expressions with a balanced lookup; the fitting tolerance is 0.000002 source units (under 0.01 pixels at 4K), checked at quarter points. The editor caches a bounded set of tracking positions for deterministic random seeks. Screen and combined exports include the edits; webcam exports keep the full camera frame.

## Evidence

- `tests/motion.test.mjs` checks easing endpoints through the third derivative, monotonic motion without bounce, symmetric entry/exit, a lower default peak magnification speed, cuts/speed mapping, validation, jitter reduction, click target preservation and baked-cursor behavior. It decodes all **140 frames at 60 fps** of a rendered gradient/cursor fixture, including a source cut and speed change. Gradient channels encode source position, so the test checks actual rendered crop coordinates. White cursor pixels verify the rasterized pointer location with allowance for its outline and source-resolution antialiasing.
- A second decoded 60 fps fixture places a cut inside the entry ramp and follows it with an adjacent pan. Its 142 frames verify viewport coordinates and bound consecutive-frame jumps. Mathematical checks cover fixed-pivot motion, velocity continuity at cuts at 0.5×/1×/2× speed, adjacent pans, mutable-edit cache invalidation, short retained sections and fully removed zooms. A maximum-capacity 80-section filter check protects against FFmpeg expression-depth failures.
- `tests/serve-media.test.mjs` checks full, partial, suffix and HEAD responses, byte counts, response headers and invalid-range rejection.
- `tests/native-capture.test.mjs` checks process startup messages, fragmented protocol delivery, waiting for final file closure, failure and repeated abort behavior. Helper pipe errors cannot crash the editor during cleanup.
- `tests/ui/motion.spec.mjs` checks rapid reverse scrubbing against a time-coded video channel, preview zoom/cursor pixels, cursor visibility/undo, frame timing, actual painted crop coordinates and frame-to-frame movement, a simulated 180 ms webcam seek while primary playback continues, timeline DOM stability, magnified pointer scrubbing, trim node stability, zoom editing, save/open, and the editable-cursor recording protocol through an actual export.
- The native-protocol UI test substitutes a generated capture process at the spawn boundary. Project creation, IPC, helper lifecycle, cursor validation/persistence, the Swift alpha renderer and FFmpeg output are real. It does **not** claim to exercise ScreenCaptureKit or real devices.

Easing measurements are in `evidence/motion/easing-check.json`. Machine-readable rendered results are in `evidence/motion/export-check.json`, `evidence/motion/continuity-check.json` and `evidence/motion/playback-check.json`. The exported fixture is `evidence/motion/zoom-and-cursor.mp4`; the cut/adjacent-pan fixture is `evidence/motion/continuous-zoom.mp4`; the recording-protocol export is `evidence/motion/native-protocol-export.mp4`.

- `tests/follow.test.mjs` verifies deterministic tracking, visibility/click independence, velocity continuity at cuts at 0.5×/1×/1.5×/2×, fixed fallback, 30/60 fps MP4, 20 fps GIF and previews against the camera path. GIF checks average local colors across each frame to account for palette quantization of the RGB gradient. An 80-follow-section filter verifies expression limits. `tests/ui/zoom.spec.mjs` verifies drag creation, cancellation, overlap, source cut boundaries, scrolling, focus selection, preview matching, actual follow-playback viewports/cadence, and cold reopen in the packaged app. The zoom test window is hidden from the shared desktop so physical mouse/focus changes cannot interrupt CDP gestures; browser pointer events, capture and rendering are exercised normally with background throttling disabled. Results: `evidence/follow/renders.json`, `evidence/follow/ui.json`; screenshot: `evidence/follow/editor.png`.

## Hardware boundary

The Mac was unlocked on October 14 and the packaged ScreenCaptureKit helper successfully recorded a dedicated generated native window for five seconds. The recording then passed MCP cuts/zoom, preview generation, export and full decoding. This exposed a `CGS_REQUIRE_INIT` crash in `SCContentFilter.init(desktopIndependentWindow:)`; initializing `NSApplication.shared` before starting capture fixed it. See [live-capture validation](live-capture.md).

The initial live checks recorded stationary system-cursor samples. Computer-use clicks and drags reach the target window as local events but do not change the system pointer or global pressed-button state; this was confirmed by comparing event positions with `CGEvent` positions in the test window. Physical pointer movement therefore needs the separate manual check described in the live report. Real webcam/microphone/system audio, window resizing, multiple displays, capture latency, device synchronization and long sessions remain unmeasured.

Editable cursor capture requires macOS 15 or later. It is automatic when the native helper is available; there is no cursor option in the recording dialog. Older macOS versions retain standard capture with a baked pointer. Automatic zoom placement, system cursor-shape tracking, motion blur and long-session performance work remain outside this pass.

## Reproduce

```sh
npm run typecheck
npm test
npm run test:e2e
```

`npm test` compiles the two original Swift helpers, then runs unit/media integration checks. `test:e2e` builds and ad-hoc signs a new app bundle before launching the Electron workflow suite against that exact executable. Building the helpers requires Xcode command-line tools; the packaged app includes both helpers.

## Primary API references

- [Apple: ScreenCaptureKit cursor visibility](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/showscursor)
- [Apple: recording screen content](https://developer.apple.com/documentation/screencapturekit/screcordingoutput)
- [FFmpeg perspective implementation](https://github.com/FFmpeg/FFmpeg/blob/master/libavfilter/vf_perspective.c) — its output-frame counter starts at one; the export expressions subtract one to align frame zero with the editor.
