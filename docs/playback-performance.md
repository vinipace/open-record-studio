# Imported-video playback — 2026-10-14

The reported project contains 1080 × 1920 HEVC at 60 fps with stereo AAC at 44.1 kHz. Chromium uses the hardware VideoToolbox decoder for this file. Decode and Canvas drawing were fast; synchronization caused the stutter.

The editor advanced a wall clock before the audio device finished startup. Once the media clock lagged by 250 ms, it sought forward, paused all tracks and restarted audio. That startup delay triggered the same correction again, producing a seek/pause loop.

Playback follows the audible media clock: screen audio, or the microphone for a silent screen. The primary track is never repeatedly sought to catch up with wall time. The initial correction still sought at intentional cuts; the subsequent cut-handoff update below removes that seek when the incoming section is prepared. Playback rate and volume are assigned only when changed. Source files and export rendering are unchanged.

## Actual reported video

The same saved project was opened read-only in isolated profiles. Its project JSON hash was checked before and after each run. No transcode or proxy was used.

| Measurement over about 12 seconds |        Before | Fixed package |
| --------------------------------- | ------------: | ------------: |
| Presented video callbacks         |           112 |           706 |
| Repeated seeks                    |            40 |             0 |
| Pause calls                       |           134 |             0 |
| Play calls                        |            41 |             1 |
| 95th-percentile frame interval    |      270.8 ms |       24.8 ms |
| Maximum frame interval            |        275 ms |       25.8 ms |
| Dropped video frames              | Not collected |             0 |

The fixed run advanced 11.753 seconds of media in 12.025 seconds of wall time, including normal audio-device startup, and presented approximately 60 frames per media second. Decoder-only playback on the original build was similarly smooth, confirming the editor's synchronization loop as the cause. This is a measured sample of the reported file, not a guarantee for every codec, machine or long recording.

Evidence: `evidence/playback/imported-before.json`, `imported-native.json`, and `imported-after.json`. Fixed ASAR SHA-256: `4a46241344df6d242f77e53896ca4007b39c1b3cc92e0f6f945d666d3375765e`.

## Original playback regression coverage

`tests/ui/playback.spec.mjs` generates a separate HEVC/AAC fixture and checks continuous playback without corrective seeks or pauses, source-clock alignment, frame cadence, a cut at 1.5× speed, and independent microphone playback. The microphone run had zero seeks/pauses and screen/audio alignment within 35 ms. Existing tests cover smooth zoom/cursor motion, a delayed webcam decoder, scrubbing, cuts, source-ratio defaults, exports and dense timelines.

All 17 packaged Electron workflows passed. The 30 unit/media/MCP tests passed in this change set; media/export modules were unchanged by the playback correction. Package verification matched 24 runtime files and both signed helpers. The previous live-capture checks do not apply to this new package hash.

To profile a saved project without changing its edits:

```sh
FRAME_EXECUTABLE="$PWD/release/Open Record Studio.app/Contents/MacOS/Electron" \
  node scripts/profile-playback.mjs /absolute/path/project.framestudio evidence/playback/profile.json
```

Add `--raw` to compare the native media player without the editor playback loop. `FRAME_PROFILE_SECONDS` controls the sample duration (default 12).

The earlier media-inspector regression pass additionally exposed a follower video retaining nearly 250 ms of startup offset when microphone audio owned the clock. Its initial correction sought followers at 80 ms; the cut-handoff update replaces that with gradual playback-rate correction to avoid repeatedly flushing the decoder.

## Cut handoff — 2026-10-14

The reported `Recording 3.framestudio` retains source spans 0–2.954 s and 4.867–11.825 s, with screen, webcam and microphone tracks. Seeking all three active decoders at the removed section reproduced a 383.4 ms gap between presented frames.

`CutMedia` now reuses two decoders per track. It silently prerolls the incoming retained section up to three seconds before a cut, then switches to its running decoder without seeking or restarting it. Plain splits with continuous source time need no handoff. The same preparation covers added video/webcam layers. Small follower drift is corrected gradually through playback rate, and deliberate unprepared seeks retain the last decoded image instead of painting an empty track. Pausing cancels preroll; loading another project unloads it.

The focused native decoder benchmark reads the existing project and media without opening the editor or changing the project. Its project JSON hash is checked before and after. This is a targeted playback measurement; the UI E2E suite was not rerun for this update.

| Reported cut, native decoder sample | Previous active-seek path | Prepared handoff |
| ----------------------------------- | ------------------------: | ---------------: |
| Longest screen-frame gap near cut   |                  383.4 ms |          42.5 ms |
| Longest webcam-frame gap near cut   |                  383.4 ms |          83.5 ms |
| Active decoder seeks                |                         3 |                0 |
| Unavailable preview image samples   |                        10 |                0 |
| Tracks prepared at boundary         |                     0 / 3 |            3 / 3 |

The camera source has variable frame intervals. These are measured frame gaps around the cut, not rendering time or a guarantee for arbitrary codecs or storage. All three prepared tracks were within 1 ms of their target source time. An additional in-memory edit with a 0.35-second middle clip at 1.5× speed crossed both cuts with all tracks prepared, no active seeks and no unavailable preview images; its longest screen-frame gap near either cut was 34.2 ms. No saved edits were modified.

Evidence: `evidence/playback/cut-handoff.json` and `evidence/playback/short-cut-handoff.json`. Focused unit coverage checks decoder handoff, queued scrubbing, frame retention, rate correction, actual editor synchronization, contiguous splits, layer playback and timeline editing. Type checking also passed.

```sh
node_modules/.bin/electron scripts/check-cut-playback.mjs \
  '/absolute/path/project.framestudio' evidence/playback/cut-handoff.json
```

The benchmark is intended for a project with an early cut. `--dense --only-prepared` uses an in-memory short-clip fixture for sources longer than 4.867 seconds. If playback starts too close to a cut for preparation to finish, the fallback retains the last image during a necessary seek; its decode latency still depends on the source and storage.

## Audible cut clock — follow-up

The decoder-only benchmark above silenced every media element. That missed a second problem in the real editor: changing the prepared microphone element from volume 0 to 1 restarts Chromium's native audio sink. Its `currentTime` stops briefly, and the editor correctly following that clock freezes with it. A trace of the installed app reproduced a 200 ms playhead plateau at output 2.97 seconds even though new video frames continued arriving. The previous frame-gap measurement was therefore insufficient proof of smooth editor playback.

All playback decoders now feed one persistent Web Audio output. Each has a mixer gain; preroll and cut handoff change those gains while leaving native media volume at 1. This keeps the audio device and source clocks running through the cut. Screen audio, microphone volume, removed-audio ranges and inserted webcam audio use the same mixer. Removed media disconnects its audio nodes.

`scripts/profile-cut-editor.mjs` traces the full editor in an isolated profile, with the actual project protocol and audible output enabled. It measures the playhead as well as presented frames and checks that incoming audio reaches the mixer. It never saves edits. On `Recording 3`, the updated trace from the start had no 200 ms boundary plateau (longest repeated playhead sample: 10.8 ms). Starting at 2.58 seconds had no repeated playhead sample; starting only 54 ms before the cut had a 9.5 ms maximum repeated sample and nonzero incoming audio. The very short run-up still needed decoder recovery: the longest screen-frame gap was 83.7 ms, webcam 125.3 ms. These are sample results, not a claim that arbitrarily cold decoders can seek instantly.

Evidence: `editor-before.json`, `editor-near-before.json`, `editor-mixer-after.json`, `editor-mixer-near-after.json`, and `editor-mixer-immediate-after.json` under `evidence/playback/`. Eleven focused unit checks cover the shared output, gain handoff, media synchronization and layer playback. The broad UI E2E suite was not rerun.

```sh
node scripts/profile-cut-editor.mjs \
  '/absolute/path/project.framestudio' evidence/playback/editor-cut.json 2.58 --assert
```

Use `FRAME_EXECUTABLE` to profile a packaged app. The optional assertions target this audible two-clip regression fixture: cross the cut, keep playhead plateaus under 80 ms, keep screen-frame gaps near the cut under 100 ms, and require nonzero incoming audio.
