# Timeline performance — 2026-10-14

The timeline now preserves clip, thumbnail, zoom-section and zoom-list elements across selection, trims, release and undo. Geometry is calculated in one pass, and only changed text, images or positions are written. Thumbnail updates wait until trim release; magnification refreshes them once per animation frame.

Clip and zoom drags coalesce pointer events once per display frame. Pointer-up flushes the last queued value before saving or undo. Continuous interactions update the relevant timeline and inspector fields without rebuilding the media list and other settings.

The playhead uses a composited transform and cached geometry from ResizeObserver. An invisible native range thumb was still invalidating layout each time the accessible slider value changed; suppressing that thumb removes those layouts while preserving keyboard input. Automatic scrolling follows playback in both directions.

Scrubbing keeps the latest requested time and paints a completed decoder seek before starting the next one. Screen and webcam decoders finish the visible batch together. Zoom and cursor use the timestamp of the displayed frame; the transport shows the requested time. This gives intermediate feedback during continuous scrubbing instead of waiting until input stops. Clicking the preview uses the frame actually displayed to select focus.

Trackpad pinch over the timeline (or Command+wheel) magnifies around the time under the pointer. Ordinary two-finger scrolling stays native. Wheel events are coalesced once per frame, and playback auto-scroll waits until the zoom gesture settles. The logarithmic slider reaches 240 pixels per second on long recordings (four pixels per 60 fps frame), with at least 16× magnification on short projects and an eight-million-pixel layout ceiling for extreme durations.

Thumbnails and audio waveforms, including microphone takes, render only the visible interval plus quantized overscan. Scrolling reuses the clip nodes and cached audio peaks; a long clip no longer creates thousands of thumbnails or stretches a small waveform across the entire magnified timeline. Ruler intervals adapt to magnification with subsecond labels. `tests/timeline-viewport.test.mjs` checks pointer anchoring, wheel coalescing, ordinary scrolling, bounded rendering, ruler density, and waveform source-time alignment. These are focused checks; the full browser E2E suite was not rerun for this change.

## Measurement

`tests/ui/timeline.spec.mjs` runs a generated 60-second 640×360 H.264 source with two video tracks, **100 retained clips and 80 zoom sections**. It measures 30 selections, a 30-frame trim with eight pointer events per frame, and 90 frames of reverse scrubbing with six inputs per frame. A separate 120-frame playback check measures layout count, frame cadence and playhead alignment. This uses the actual Electron renderer and video decoders; pointer bursts are injected at the UI event boundary.

| Measure | Before | After |
| --- | ---: | ---: |
| Selection handler p95 (ms) | 6.4 | 1.4 |
| Timeline child mutations during trim | 38798 | 4 |
| Distinct preview frames during continuous scrub | 7 | 51 |
| Playback layout passes over 120 frames | 122 | 12 |
| Total layout time during selection/drag/scrub (ms) | 195.2 | 26.5 |
| Total script time during selection/drag/scrub (ms) | 363.1 | 73.5 |

Machine-readable before/after measurements are `evidence/timeline/before.json` and `evidence/timeline/after.json`. Both include the tested app archive hash when run against a package. Package verification requires the latest performance evidence to match the rebuilt runtime.

The baseline is frozen from the preceding packaged build. Normal tests update only the after report. Timing varies with machine load; handler times exclude work deferred to the next animation frame, so Chromium's aggregate script/layout durations are also recorded. These short generated-media checks do not establish performance for 4K media or multi-hour recordings.

## Functional checks

- Clip and zoom DOM identity survives selection, trimming and release.
- No clip rebuilds during selection and zero element insertions/removals during the measured trim. Duration-label text updates are counted separately because they legitimately change as the trim crosses frame boundaries.
- Continuous scrubbing paints more than 15 distinct decoded frames during the input sequence; the final seek reaches the requested source time.
- Clip and fragmented zoom trims each undo in one step, including release before the next animation frame. Saved edits match the original after undo.
- Native slider arrow keys still work. Magnified playhead coordinates stay within one pixel of the timeline mapping.
- Playback p95 frame intervals remain below 45 ms and layout passes stay below 45 per 120 observed frames.
- Existing motion tests retain frame-level preview/export alignment, cursor placement, reverse seeking and webcam-seek clock checks.

## Reproduce

```sh
npm run typecheck
npm test
npm run test:e2e
node scripts/verify-package.mjs
```

For the focused test after a development build:

```sh
npm run build
npx playwright test tests/ui/timeline.spec.mjs
```
