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

## Bundled MCP

`Contents/Resources/bin/open-record-studio-mcp` uses the app's Electron executable
with `ELECTRON_RUN_AS_NODE=1`. The unpacked `mcp-runtime` contains the MCP source,
shared desktop modules, audio model, and only the production dependencies pinned
by `package-lock.json`. Relative symlinks reuse the app's signed native helpers.
The launcher resolves symlinks, supports paths containing spaces, and clears
external Node preload settings. The app menu copies a configuration using its
actual installation path. Homebrew links the same launcher into its bin directory.

Packaging checks the runtime against source and lockfile and signs it with the
rest of the app. `npm run test:e2e` relocates a copy outside the checkout, removes
Node from the server's PATH, exercises direct and symlink launchers, runs real
stdio editing/preview/render/cancellation workflows, and runs the desktop suite.
The tests use generated media and isolated profiles; live capture permissions
and camera hardware remain separate checks. `evidence/release-e2e.json` records
passing test counts and a fingerprint of the tested app. Release creation rejects
missing evidence or a changed bundle. `npm run test:mcp:packaged` reruns only the
relocated MCP checks against an already packaged app.

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

The command builds the app, runs packaged MCP and desktop E2E tests, then creates a ZIP and a drag-to-Applications
DMG, and emits `SHA256SUMS.txt`, `release.json`, installation instructions, and a
versioned Homebrew cask. Output lives in `release/v<version>/macos-arm64/`. Existing
output is never overwritten. Releases require a real Developer ID certificate;
ad-hoc builds remain available only through `npm run package`.

Without `--preview`, both app and disk image are submitted to Apple, their tickets
are stapled and validated, and Gatekeeper assessment must pass. An error aborts
the release; it never silently changes to an unnotarized release.

Create a GitHub draft release for the exact `sourceCommit` in `release.json`,
attach the seven generated files, and verify their downloaded SHA-256 hashes before
publishing. Mark unnotarized builds as previews. Copy the generated
`open-record-studio.rb` into `Casks/` and commit it on `main` after building; its
checksum pins the DMG. Keep the release tag on the build's source commit. Homebrew
uses this repository as an explicit tap and installs FFmpeg as a dependency.

See [installation instructions](install.md).

### In-app update metadata

Release creation generates `RELEASES.json` alongside the signed ZIP. Upload it to
the same GitHub release, with the exact filenames produced by the script. It
contains the release version, versioned ZIP URL, byte size and SHA-256 digest.
This is Electron/Squirrel.Mac's static JSON feed (`serverType: "json"`); no separate
update server, GitHub token, or bundled update dependency is required.

The app reads the public GitHub release list, ignores drafts, compares numeric
versions, and follows the user's preview preference. Download begins only after
the user chooses it. The feed is checked against the selected release and GitHub
asset metadata before passing it to Electron. Squirrel validates the ZIP digest
and app signature; keep the bundle identifier and Developer ID identity stable.
Never republish different app bytes under the same version. Bump the package and
lockfile versions for every release. A release without update metadata is offered
as a manual GitHub download, rather than incorrectly reported as up to date.

Create the release as a draft, upload and verify all assets, then publish it.
Unnotarized builds must remain previews. Existing 0.1–0.3 installs need one manual
upgrade to acquire the updater; later compatible releases update inside the app.

References: [Electron updates](https://www.electronjs.org/docs/latest/tutorial/updates)
and [autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater).

## Artwork and model sources

`scripts/generate_app_icon.py` generates the app icon;
`scripts/generate-demo-art.py` generates the illustrated sample screen and camera.
The example project's PNG files contain the same generated sample pixels. System
fonts used to render samples are not bundled as font files.

The audio model's upstream revision and checksum are recorded separately in its
notice. Preserve that source record when changing the model. Do not apply the
project's MIT license to third-party weights by implication.
