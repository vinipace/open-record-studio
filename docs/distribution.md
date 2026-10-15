# Distribution

## Compatibility

The app is named **Open Record Studio**. Existing `.framestudio` projects,
the macOS bundle identifier, preferences directory, audio cache, and `FRAME_*`
environment variables retain their original identifiers for compatibility.
Existing MCP client entries may keep their configured alias; the server now
identifies itself as `open-record-studio`.

## Source release

- Include `LICENSE`, `THIRD_PARTY_NOTICES.md`, the package lockfile, and model notices.
- The MIT license applies to project-owned material; third-party files retain
  their own terms. Contributions must be original or provided under compatible
  terms, with their source and required attribution recorded.
- Keep private recordings, credentials, caches and development evidence out of
  release archives. Use Git's tracked-file archive instead of archiving the
  entire workspace.
- A new product name requires a separate trademark check. Naming, licensing and
  code review do not themselves constitute legal clearance.

## App release

Run `npm ci`, `npm run typecheck`, and `npm run package` on macOS with Xcode
command-line tools installed. Packaging copies the exact installed Electron and
Chromium notices, production dependency license files, the project license, and
audio-model notices. It verifies their bytes before signing. Missing notices
stop the build. `Contents/Resources/licenses/index.html` is accessible from the
application menu; `manifest.json` records versions and file hashes.

FFmpeg and ffprobe remain user-installed dependencies. Do not add them to a
release archive without reviewing that build's terms and source obligations.

Developer ID builds use Hardened Runtime, secure timestamps, and explicit signing
of nested Electron components and native helpers. A successful local signature
check does not prove notarization. The packaging command does not submit an app
to Apple.

## Downloadable releases

Commit changes and set the intended version in `package.json` and the lockfile.
Build a signed preview with:

```sh
npm run release:mac -- --preview
```

For a notarized release, first store Apple credentials in your local Keychain
using `xcrun notarytool store-credentials` and its interactive prompts. Do not put
passwords, private keys, or signing certificates in this repository. Then run:

```sh
NOTARYTOOL_PROFILE="your-saved-profile-name" npm run release:mac
```

The command builds and checks the app, creates a ZIP and a drag-to-Applications
DMG, and emits `SHA256SUMS.txt`, `release.json`, installation instructions, and a
versioned Homebrew cask. Output lives in `release/v<version>/macos-arm64/`. Existing
output is never overwritten. Releases require a real Developer ID certificate;
ad-hoc builds remain available only through `npm run package`.

Without `--preview`, both app and disk image are submitted to Apple, their tickets
are stapled and validated, and Gatekeeper assessment must pass. An error aborts
the release; it never silently changes to an unnotarized release.

Create a GitHub draft release for the exact `sourceCommit` in `release.json`,
attach the six generated files, and verify their downloaded SHA-256 hashes before
publishing. Mark unnotarized builds as previews. Copy the generated
`open-record-studio.rb` into `Casks/` and commit it on `main` after building; its
checksum pins the DMG. Keep the release tag on the build's source commit. Homebrew
uses this repository as an explicit tap and installs FFmpeg as a dependency.

Release visibility follows repository visibility. Publishing a release in a
private repository does not make its files publicly downloadable. See
[installation instructions](install.md).

## Artwork and model sources

`scripts/generate_app_icon.py` generates the app icon;
`scripts/generate-demo-art.py` generates the illustrated sample screen and camera.
The example project's PNG files contain the same generated sample pixels. System
fonts used to render samples are not bundled as font files.

The audio model's upstream revision and checksum are recorded separately in its
notice. Preserve that source record when changing the model. Do not apply the
project's MIT license to third-party weights by implication.
