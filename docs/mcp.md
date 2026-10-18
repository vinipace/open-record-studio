# Open Record Studio MCP

The local stdio server edits saved `.framestudio` projects and uses the desktop app's FFmpeg composition engine for previews and renders. The app does not need to be open. The server runs entirely on your computer and opens no network port.

## Connect

**MCP is included in the macOS app starting with v0.2.0.** No separate Node.js installation, source checkout, or `npm install` is needed.

Open the app once and choose **Open Record Studio → Copy MCP configuration** from the macOS menu bar. Paste it into your MCP client's configuration and reconnect. The copied configuration uses the app's actual location, including custom install folders. The desktop app can then stay closed.

For the standard Applications install, the configuration is:

```json
{
  "mcpServers": {
    "open-record-studio": {
      "command": "/Applications/Open Record Studio.app/Contents/Resources/bin/open-record-studio-mcp",
      "args": []
    }
  }
}
```

Homebrew also installs an `open-record-studio-mcp` command:

```sh
open-record-studio-mcp --print-config
open-record-studio-mcp --version
```

For a direct download, the same commands are available using the full launcher path:

```sh
"/Applications/Open Record Studio.app/Contents/Resources/bin/open-record-studio-mcp" --print-config
```

With no arguments, the launcher runs the stdio server. It uses the app's included Electron/Node runtime, production dependencies, native renderers, and audio model. It opens no editor window or network port. FFmpeg/ffprobe are still required for previews and renders (`brew install ffmpeg`); the Homebrew cask installs them automatically. No credentials are required.

After moving the app, copy the configuration again. After upgrading it, reconnect your MCP client so it launches the new server. Existing source-based configurations and client aliases remain supported.

### Run from source (developers)

Use Node 20+, `npm ci`, FFmpeg/ffprobe, and `npm run build:native` on macOS. Run `npm run --silent mcp`, or configure your client with an absolute Node executable as `command` and the absolute `mcp/server.mjs` path in `args`. Standard output is reserved for MCP messages.

Uses the [official MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk) with both legacy initialize and current discovery support.

## Tools

| Tool            | Behavior                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `get_project`   | Read tracks, retained clips, source/output timeline positions, zooms, style, capabilities, export settings, and revision.      |
| `get_interactions` | Query recorded activity with types, source/output time filters, pagination and optional revision consistency. |
| `update_style`  | Patch canvas ratio/template, screen fit, cursor, webcam, background, framing, audio or speed settings without replacing other settings.                          |
| `apply_edits`   | Validate up to 100 cut/zoom/style operations and save once, or dry-run without changing the project.                           |
| `get_preview`   | Return an inline PNG and frame metadata at an edited-output timestamp. Modes: combined, screen, camera; 360p/720p; 30/60 fps.   |
| `render`        | Start an asynchronous MP4 or looping GIF render. Combined, separate screen/webcam, or both. MP4 supports optional audio; GIF is silent. |
| `render_status` | Get progress, elapsed/remaining seconds, encoder, status, snapshot revision, and completed output paths.                                                            |
| `cancel_render` | Stop a job and wait for partial-output cleanup.                                                                                 |
| `add_cut`       | Insert a retained source range into an unused gap.                                                                              |
| `edit_cut`      | Change an existing retained clip's source in/out boundaries.                                                                    |
| `remove_cut`    | Remove a retained clip from the output. Originals are preserved.                                                                |
| `split_cut`     | Divide a retained clip at a source timestamp, retaining both pieces.                                                            |
| `add_zoom`      | Create a zoom section with a generated stable ID.                                                                               |
| `edit_zoom`     | Update selected fields of a zoom by ID.                                                                                         |
| `remove_zoom`   | Remove a zoom by ID.                                                                                                            |

All project tools take `project_path`, the absolute project **directory**, not `project.json`. First call `get_project`. Pass its `revision` as `expected_revision` to edits and render, then use the new revision returned by every successful edit. `apply_edits` returns its summary under `project`; use `project.revision` after a saved batch. Preview accepts an optional expected revision and always returns the actual revision used.

`get_project` includes `capabilities.aspect_ratios`, `capabilities.canvas_templates`, default-1080 composition dimensions, `capabilities.editable_style_fields`, `capabilities.zoom_modes`, `capabilities.default_zoom_mode`, available preview/render modes, MP4/GIF resolutions and frame rates, and clip/zoom/batch limits. These describe the saved project's supported edits; FFmpeg and the native cursor renderer are still required at runtime. Its `timeline` array maps every retained clip's `source_start`/`source_end` to `output_start`/`output_end`, accounting for speed. Existing `cuts` fields remain unchanged.

### Cursor, webcam and composition

`update_style` accepts a nonempty `changes` object. It preserves every omitted setting:

`changes: {"enhanceAudio": true}` enables local speech noise suppression (default `false`). `audioEnhancementModel` selects `deepfilternet3` (default), `rnnoise` (bundled), or `mossformer2`. DeepFilterNet3 and MossFormer2 download their local runtime and weights on first use, then run offline; each selection has its own audio cache. MP4 renders and desktop playback share the cached enhanced sources; originals, cuts, offsets, speed, gains and audio removal ranges are preserved. This also enhances recorded webcam-take microphones. GIF remains silent.

```json
{
  "project_path": "/absolute/Demo.framestudio",
  "expected_revision": "<latest revision>",
  "changes": {
    "showCursor": true,
    "cursorSize": 1.8,
    "cursorSmoothing": 0.1,
    "cursorClicks": false,
    "cameraRoundness": 0.5,
    "cameraMargin": 0.05,
    "cameraFlip": true,
    "cameraCorner": "bottom-left"
  }
}
```

Cursor visibility/size/smoothing/click controls require separate cursor data; imported or older videos with a baked pointer reject those changes. Webcam controls require a camera track. Roundness ranges from 0 (square) to 1 (circle) and applies to the overlay, preserving full-frame separate camera exports. `cameraShape` presets update roundness; if both are supplied, `cameraRoundness` wins and the preset is synchronized. `cameraFlip` is a boolean (default `false`) that flips the webcam horizontally in project/MCP previews and combined/separate MP4/GIF exports. It preserves the original media and is independent of the recording preview’s mirror toggle. `cameraMargin` adjusts the overlay inset from its selected corner (0–0.2; default 0.035). Like camera size, it uses the canvas width capped at 16:9 of canvas height, scales with export resolution, and is limited to the available space so the webcam stays on canvas. Zero places the overlay against the edges. Separate webcam exports remain full-frame. Other controls include background, padding, camera size/offset/visibility, base zoom/focus, speed, screen audio gain and microphone gain. Schemas expose their bounds; unknown fields, invalid types and out-of-range values are rejected.

### Atomic batches and dry runs

Use `apply_edits` to perform a sequence without intermediate saves. Each operation uses the corresponding tool's fields, plus `operation`; omit per-operation paths and revisions. Every step must be valid. Clip indices refer to the result of preceding steps. A failed operation leaves the entire saved project unchanged.

For one clip covering source 0–10, this discards 2–4 and changes speed:

```json
{
  "project_path": "/absolute/Demo.framestudio",
  "expected_revision": "<latest revision>",
  "dry_run": true,
  "operations": [
    { "operation": "split_cut", "cut_index": 0, "source_time": 2 },
    { "operation": "split_cut", "cut_index": 1, "source_time": 4 },
    { "operation": "remove_cut", "cut_index": 1 },
    { "operation": "update_style", "changes": { "speed": 1.5 } }
  ]
}
```

The result contains `saved`, `base_revision`, `project` and `operation_results`. With `dry_run:true`, `saved` is false and `project` describes the proposed result with the **unchanged base revision**. It is not a saved snapshot; previews/renders still use the saved project. Generated zoom IDs in a dry run are provisional. To commit, repeat the operations with `dry_run:false` (the default), using the latest saved revision. A successful batch saves once and returns the new revision, plus generated zoom IDs in `operation_results`. A concurrent edit still causes a conflict; no intermediate batch changes are written.

Handler errors include `structuredContent.error` with a code and message, an operation index when applicable, and recovery guidance for conflicts/busy projects/unsupported controls. Codes include `INVALID_EDIT`, `UNSUPPORTED_CONTROL`, `REVISION_CONFLICT`, and `PROJECT_BUSY`. Input-schema failures use the SDK's standard error response. Always check `isError`; for a revision conflict, read and review the current project before retrying.

### Timeline conventions

**Cuts are retained clips**, matching the desktop timeline. They are indexed from zero, ordered in source time, nonoverlapping, and at least 0.05 seconds long. Adjacent clips are allowed. At least one clip must remain. Adding a cut fills an unused range; use `split_cut` to divide an existing range. To discard a middle interval, split at both boundaries and remove the middle clip. Indices can change after any mutation; read the returned cuts before the next call. All tracks receive the same edits.

Zoom `mode` is `"follow"` or `"fixed"`. New sections default to smooth mouse following when visible recorded cursor samples exist, otherwise fixed focus. Following is independent of `showCursor` and pointer smoothing; hiding the pointer does not stop camera movement. `focusX`/`focusY` position fixed shots and provide a fallback if cursor metadata is missing. Explicit follow requests without cursor data return `UNSUPPORTED_CONTROL`. Legacy saved sections with no mode retain fixed behavior. To switch modes, use `edit_zoom` with `changes:{"mode":"fixed","focusX":0.7,"focusY":0.3}` or `changes:{"mode":"follow"}`.

Zoom `start` and `end` also use **source seconds**, so they stay anchored when cuts change. Sections cannot overlap and must be at least 0.1 seconds long. `zoom` ranges from 1 to 3. `focusX`/`focusY` are fractions of available crop travel: 0 is left/top, 0.5 center, 1 right/bottom. `ease` is transition duration in **output seconds** (0.1–2), clamped to half the retained section. Transitions use symmetric ease-in/out with zero velocity, acceleration and jerk at their endpoints and no overshoot. The editor defaults to 0.6 seconds at each edge; explicitly saved durations remain unchanged. Transitions run on the output clock, preserving camera continuity across cuts. Sections touching on the output timeline blend directly between their target views. Zooms wholly inside removed footage remain saved but do not appear in output.

Preview `time` uses **edited output seconds**, accounting for cuts and playback speed. It must be below `output_duration`. The result reports the selected frame, quantized output time, mapped source time, dimensions, and revision. Previews use the same output-clock crop and cursor paths as exports. MP4 exports of supported screen sources use the Metal compositor; previews retain the FFmpeg composition graph. They decode from the beginning to retain exact filter clocks; previews late in long recordings can take longer. Request cancellation stops processing and removes temporary files. Images are capped at 1920 pixels wide.

Render `format` defaults to `mp4` (1080p/60 fps). MP4 accepts 720/1080/2160 height and 30/60 fps. Use `format:"gif"` for a looping animation (480p/20 fps by default); GIF accepts 360/480/720/1080 height and 10/15/20/30 fps. `quality:"high"` uses a 256-color GIF palette with error-diffusion dithering; `standard` uses 128 colors and ordered dithering. GIF ignores audio flags. Both formats retain cuts, speed, zoom, cursor, webcam roundness, progress and cancellation.

### Example workflow

For a project containing one retained clip from source 0 to 10 seconds:

1. `get_project({"project_path":"/absolute/Demo.framestudio"})`
2. `split_cut({"project_path":"…","expected_revision":"<latest>","cut_index":0,"source_time":2})`
3. `split_cut({"project_path":"…","expected_revision":"<new latest>","cut_index":1,"source_time":4})`
4. `remove_cut({"project_path":"…","expected_revision":"<new latest>","cut_index":1})` removes source 2–4 from output.
5. `add_zoom({"project_path":"…","expected_revision":"<new latest>","start":4,"end":7,"zoom":2,"focusX":0.5,"focusY":0.5,"ease":0.5})`
6. `get_preview({"project_path":"…","time":3,"mode":"combined"})` previews source second 5 at speed 1.
7. `render({"project_path":"…","expected_revision":"<latest>","output_directory":"/absolute/Exports","mode":"both","height":1080,"fps":60})`
8. Poll `render_status({"job_id":"<returned ID>"})` until `succeeded`, `failed`, or `cancelled`.

Replace the ellipses and revision placeholders with actual returned values. Separate/both exports require a webcam track. `audio:true` (the default) routes system audio only to the screen file, and microphone audio, including added webcam takes, only to the camera file. Combined output mixes both. `audio:false` disables all audio; GIF is always silent. The legacy `cameraAudio` option is accepted but ignored. Completed renders live in unique directories with an `export.json` manifest. `render_status` reports `elapsed_seconds`, `remaining_seconds` (null during warmup or a prolonged stall), and the selected `encoder`. Estimates include preparation and all requested output files. MP4 uses VideoToolbox on supported Macs and retries with software H.264 if hardware encoding fails. Completion notifications are sent by the desktop app for desktop exports; MCP clients can use the job status for their own notifications.

## Desktop and concurrent clients

MCP only reads **saved** edits. The desktop checks for external changes and shows **Project updated on disk → Reload**. Reload asks before discarding unsaved local edits. Stale desktop saves and stale MCP mutations are rejected, preserving the newer file. Reload clears desktop undo history; subsequent desktop edits can be saved normally.

Writes use a shared filesystem lock and atomic replacement. A racing write receives a conflict or busy error and should re-read the project before retrying. A hard process/OS crash during the brief save transaction can leave `.frame-save.lock` in the project; if no editor or MCP process is saving, remove that empty lock directory to recover. Original media is never rewritten by these tools.

Each server allows one render and one preview at a time. Render jobs hold the saved project snapshot from launch, so later edits do not alter a running render. Keep the MCP connection alive until the job finishes. Disconnect or termination cancels unfinished jobs; up to 50 job results are retained in memory for that server process. Completed files remain on disk across restarts, but job IDs do not.

## Verification

```sh
npm run typecheck
npm test
npm run test:e2e
node scripts/verify-package.mjs
```

`npm run test:mcp` runs eight stdio integration workflows. They discover all 15 tools with legacy and modern clients, exercise cut/zoom CRUD, style changes, dry runs, batch rollback, sequential indices, generated IDs, and cross-process conflicts. Actual cursor pixels verify size and visibility changes; styled previews match rendered output. MP4/GIF rendering, all three outputs, five additional preview/export comparisons, and cancel/retry/disconnect cleanup are covered. The packaged Electron workflow verifies that a batch's cursor/webcam/zoom/cut settings appear after reload, stale saves preserve both editors, and subsequent desktop saves preserve the MCP settings. Fixtures use generated media; no live device recording is performed by these tests. Evidence is written to `evidence/mcp/`, including `styled-preview.png`, `styled-render.mp4`, and `checks.json`.

## Canvas settings

`update_style` and `apply_edits` accept `canvasTemplate`, `aspectRatio`, and `screenFit`. For example, `changes: {"canvasTemplate":"tiktok","screenFit":"fill"}` selects a 9:16 canvas. Templates automatically set their ratio; contradictory template/ratio changes are rejected atomically. A manual `aspectRatio` selects the custom canvas. Get valid values from `get_project.capabilities`.

The existing `height` parameter is the short edge for portrait/square compositions and height for landscape compositions. At `height:1080`, 9:16 yields 1080 × 1920. Separate track outputs keep their source ratio and always use `height` as the vertical height. Preview images use the same rules. Imported still images render and edit through their timed screen track. The additional `tests/composition.test.mjs` covers discovery, template edits, invalid combinations and real portrait preview dimensions over stdio.

Size-preset references: [Meta Reels](https://www.facebook.com/business/ads/facebook-instagram-reels-ads), [TikTok vertical-video specifications](https://ads.tiktok.com/help/article/tiktok-auction-in-feed-ads), and [YouTube Shorts formats](https://support.google.com/youtube/answer/15424877). These are canvas shortcuts, not upload validation.

## Canvas media layers

`get_project` includes `assets` (the copied image/video catalog) and `layers` in bottom-to-top order. Each layer has an asset ID, source-time start/end, video start offset, normalized center/width, opacity and visibility. Combined renders and preview images include saved layers, including transparent PNGs; separate tracks omit them. Existing cut/style/batch operations preserve the layer data. Add and arrange media in the desktop, then save before using MCP previews or renders. Added videos are muted. `tests/layers.test.mjs` checks catalog discovery and preservation through a real MCP style edit, plus inline previews and decoded layer export pixels.

`get_project.removed_audio` reports source-time audio removals. Existing edits preserve these ranges, and render jobs silence them in every output that includes the screen/microphone mix. Desktop Delete/Backspace creates removals; undo restores the audio without modifying the original files.

## Recorded interactions

`get_project.interactions` summarizes coverage, permissions, counts and truncation. `get_interactions` returns events without loading every event into an agent's context. Parameters: `project_path`, optional `expected_revision`, `types` (`click`, `typing`, `selection`, `scroll`, `drag`), `timebase` (`source` or `output`), optional `start`/`end`, `offset` (default 0) and `limit` (default 200, maximum 1000). Use the returned `next_offset` until null, passing its `revision` as `expected_revision` to keep pages consistent.

Each event has stable `id`, source `t`/`end`, normalized `x`/`y`, and optional count, mouse button, position provenance and rectangle. Clicks recovered from independently sampled cursor presses include `origin: "cursor"`. `output_times` maps the event's start to retained cuts; `output_ranges` gives the retained portions of a burst. An event may have no output start but still overlap a retained range. Source queries include removed events; output queries omit activity completely removed by edits. The response includes the revision, both durations, coverage and matched count.

```json
{
  "project_path": "/absolute/Demo.framestudio",
  "types": ["typing", "selection"],
  "timebase": "output",
  "start": 0,
  "end": 30,
  "limit": 100
}
```

Metadata never contains actual typed/selected text or clipboard data. Native capture requires macOS 15+; selection depends on Accessibility support in the recorded app. New screen recordings require Accessibility and Input Monitoring, with the text listener verified at startup. Coverage still reports missing permissions for older recordings. Native click events are reconciled with cursor presses on finalization, including when click support was reported but no events arrived. Older clean-cursor projects can derive click events; imported videos report unavailable activity. New recordings generate editable zooms once when finalized; later MCP edits preserve the original interaction metadata and do not regenerate deleted zooms.
