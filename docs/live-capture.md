# Live native capture — October 14, 2026

After the user unlocked the Mac, the packaged capture helper recorded a dedicated native test window for five seconds. Only generated artwork, an animated clock and moving color markers were captured. Webcam, microphone and system audio were off. The user's existing Open Record Studio window, including its unsaved edits, was left untouched.

## Fix found by the live check

The first real window capture aborted inside `SCContentFilter.init(desktopIndependentWindow:)`, with `CGS_REQUIRE_INIT` asserting that the window-server connection had not initialized. The command-line helper imports AppKit but has no `NSApplicationMain` entry point. It now initializes `NSApplication.shared` and sets the activation policy to `.prohibited` before starting ScreenCaptureKit. This keeps the helper without a visible application window while establishing the connection it needs.

The rebuilt and locally signed package passed the live recording check. All 15 unit/media/MCP checks and all 10 packaged Electron workflows also pass after the fix.

## Verified

- Real ScreenCaptureKit capture of one native window at 1600 × 1024 for approximately five seconds.
- Finalized H.264 MP4, valid source duration and no audio stream.
- Cursor metadata written and validated against source duration.
- Saved `.framestudio` project re-read through the actual MCP stdio server.
- Two splits and removal of source seconds 1–1.5, plus an eased 1.6× zoom.
- Inline screen PNG generated through the export composition graph.
- Combined 720p/60 fps MP4 with the expected edited duration and a complete decode with no FFmpeg errors.

This run invokes the packaged helper and then the shared project/MCP pipeline. It does not claim a manual pass through the desktop's source picker, recording controls or file dialogs; those paths have separate packaged integration coverage with generated inputs.

## Physical pointer check

The initial live runs contain stationary system-cursor samples. Computer-use input sends events directly to the target window without changing the global pointer location or pressed-button state. A diagnostic native view received changing local coordinates while `CGEvent` coordinates stayed fixed and `NSEvent.pressedMouseButtons` remained zero. Those synthetic clicks therefore cannot prove physical cursor capture.

A dedicated test window is offered for a manual five-second run: click **Run five-second check**, move the physical mouse inside that window, and click its targets. `evidence/live/latest.json` records `cursorMovementVerified` separately from `captureVerified`, based on actual visible movement and pressed samples. Until that flag is true, physical cursor tracking remains unverified. Export geometry, smoothing and click rendering are already covered by the frame-by-frame generated-media tests.

## Evidence and reproduction

`evidence/live/latest.json` points to the latest successful live run, its saved project, output video, exact helper/package hashes and `validation.json`. Each run folder also contains source frames and `edited-preview.png`. `evidence/verification.json` only marks live window capture verified when those hashes match the current package.

Run `node scripts/check-live-capture.mjs` in an unlocked desktop session. It opens only a generated test window and waits for its Run button before recording that exact window for five seconds. It never selects a display or activates webcam, microphone or system audio. The fixture closes when verification finishes. The check is deliberately excluded from unattended test suites.

Real camera/microphone/system audio capture, device synchronization, long sessions, resizing/moving a recorded window and multiple displays remain untested.
