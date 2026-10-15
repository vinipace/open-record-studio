# Webcam preview while recording

Selecting a webcam automatically opens a floating preview during native recording on macOS 15+. It stays above other windows while the editor is minimized. The preview starts at 248 × 248 and shows only the muted webcam image in a squircle, with transparent corners and no permanent header or footer. Drag the image to move it. Drag any of the four corners to resize it; the opposite corner stays fixed, the window stays square, and the squircle scales with it. Size is limited to 192–640 points and the available display area. Press Escape during a resize to restore the starting size. Hover to fade in the corner grips, recording timer, mirror toggle, hide button and Stop recording button; leaving fades them out. Tab navigation also reveals the controls, while automatic window focus does not. Reduced-motion settings disable the fade. It shares the existing MediaStream with MediaRecorder, so there is no second camera acquisition or preview re-encoding.

The floating view starts mirrored. Its mirror toggle affects only that live view. In the editor, **Camera → Orientation → Flip horizontally** controls the saved project orientation, including the composition and full-frame camera previews, MP4/GIF exports and MCP previews. This setting supports undo/redo and does not rewrite the original media.

The × button hides the view while the camera continues recording. Use **● REC → Show webcam preview** to restore it. Hiding or moving the preview does not change the exported camera layout. Stopping, cancellation and failed startup release the preview. Camera-disabled recordings open no preview. Standard capture on unsupported systems keeps the independent webcam track but does not show a floating preview.

## Capture exclusion

For display capture, the native helper uses ScreenCaptureKit's application exclusion filter with the recording Electron process ID. This excludes Open Record Studio's windows, including the preview, even after hiding/restoring or moving it. Single-window capture uses an independent window filter, so a separate floating window is not included. The preview starts hidden and is shown only after the helper confirms an exclusion filter or single-window capture. If confirmation fails, recording is aborted and the hidden preview is destroyed. `setContentProtection` is applied as an additional measure, but the recording does not rely on it.

The saved screen track remains independent of the webcam. Combined exports still include the webcam according to the editor's overlay settings; separate screen exports contain no webcam preview.

## Checks

The initial October 14 attempt was blocked by the lock screen. After the user unlocked the Mac and explicitly requested the test, real ScreenCaptureKit display capture passed. The unfiltered control contained the generated red preview pixels; the app screen track and separate screen export each contained zero red pixels and zero black replacement pixels. The camera export retained the generated red feed. The evidence records exact package/helper hashes; this verifies a short generated-media display session, not physical webcam drivers or long recording sessions.

The packaged Electron recording workflow checks square full-bleed video, actual transparent corner pixels, squircle clipping, native window bounds after real pointer drags at all four corners, opposite-corner anchoring, minimum size, Escape cancellation, preview-only mirroring, hidden idle controls, hover/leave, keyboard navigation, restore without sticky controls, a decoded live preview, one camera acquisition, a minimized editor and floating window, hide/restore through the recording menu, stopping from the preview, independent-track finalization, and rendering. A missing-exclusion response verifies that startup aborts, tracks stop, the banner clears, the preview closes, and captured data is marked for recovery. The standard-capture workflow verifies that no preview window opens.

Appearance screenshots and package-linked checks are in `evidence/webcam-preview/squircle-idle.png`, `squircle-hover.png` and `appearance.json`. Appearance checks use a generated camera feed; the historical native display check below retains its own exact package hash.

Run the native display check with:

```sh
npm run package
node scripts/check-webcam-preview.mjs
```

This briefly covers one display with generated artwork and uses a generated red camera stream. The packaged app records that display with the real ScreenCaptureKit helper. An independent unfiltered control records the same display while the preview is visible, hidden, restored and moved. The test disables content protection on this generated preview to isolate the application exclusion filter. It checks that red preview pixels appear in the control but not in the app's screen track or separate screen export, that there is no black rectangle replacing the preview, and that the separate webcam export retains the red camera frames. Outputs are fully decoded. No physical camera or microphone is used.

Evidence is stored under `evidence/webcam-preview/`; each successful run writes `latest.json` with the exact packaged app/helper hashes. The blocked attempt is `2026-10-14T12-53-30-996Z/validation.json`. The generated cover and test app are closed afterward, preserving the user's existing editor and projects. This is a short display-capture check; live camera drivers, long sessions and moving between multiple displays are outside its scope.

## API references

- [Electron same-origin subwindows](https://www.electronjs.org/docs/latest/api/window-open)
- [ScreenCaptureKit application exclusion](https://developer.apple.com/documentation/screencapturekit/sccontentfilter/init(display:excludingapplications:exceptingwindows:))

Selecting a camera in New recording opens the same floating preview before capture starts. The selected stream is reused for recording. Canceling the dialog or selecting Off stops the camera and destroys the preview; selecting another camera releases the old stream. Before recording, the timer and Stop control are hidden. The preview remains excluded from screen capture.
