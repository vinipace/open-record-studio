# Install Open Record Studio

The downloadable build supports **Apple silicon Macs (M1 or later), macOS 15+**.
You do not need Node.js, Xcode, or the source checkout to run it.

## Download

1. Open the [releases page](https://github.com/vinipace/open-record-studio/releases).
2. Download `Open-Record-Studio-<version>-macOS-arm64.dmg` from **Assets**.
3. Open the disk image and drag **Open Record Studio** into **Applications**.
4. Install the media tools with [Homebrew](https://brew.sh): `brew install ffmpeg`.
5. Open the app from Applications.

A ZIP of the same app is also available. Extract it and move the app into
Applications. FFmpeg and ffprobe are installed separately to preserve their own
distribution and licensing requirements. Recordings, imports, and exports use
these tools.

**The first release is a preview:** it is Developer ID signed, but not notarized
by Apple. macOS may block its first launch. Review the source and signing identity
before deciding whether to allow it in **System Settings → Privacy & Security**.
Do not disable Gatekeeper. Future notarized releases will say so explicitly.

While the repository is private, GitHub requires an account with repository access
to download releases. Public downloads and Homebrew installation become available
when the repository is public. Authorized collaborators can also download with:

```sh
gh release download v0.1.0 --repo vinipace/open-record-studio --pattern '*.dmg'
```

## Homebrew

Once the release assets are publicly readable:

```sh
brew tap vinipace/open-record-studio https://github.com/vinipace/open-record-studio
brew install --cask vinipace/open-record-studio/open-record-studio
```

The cask installs the app and FFmpeg. To update later:

```sh
brew update
brew upgrade --cask vinipace/open-record-studio/open-record-studio
```

## First launch and permissions

Choose **Explore a sample project** to try the editor without a recording.
When recording, grant access for the selected screen, camera, and microphone.
Screen interaction tracking also requires Accessibility and Input Monitoring.

The app retains the previous bundle identifier and preferences directory so
existing projects, saved device choices, and permissions can continue to work.
Quit an older installed copy before opening this one.

## Verify a download

Each release includes `SHA256SUMS.txt` and `release.json`. The latter records the
source commit, platform, architecture, signing/notarization status, and asset
hashes. Download the assets and checksum file into the same directory, then run:

```sh
shasum -a 256 -c SHA256SUMS.txt
```

Only files present in the directory can be checked. To check a single downloaded
DMG, compare `shasum -a 256 Open-Record-Studio-*-macOS-arm64.dmg` with its entry in
`SHA256SUMS.txt`.
