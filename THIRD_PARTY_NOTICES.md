# Third-party components

The root MIT license covers this project's own code, documentation and generated
sample artwork. It does not replace third-party terms or grant rights to other
projects' names and logos.

## Desktop runtime

Electron is distributed under the MIT license and includes Chromium, Node.js and
other components with their own terms. Every packaged app includes the unmodified
`LICENSE` and `LICENSES.chromium.html` from the exact installed Electron release,
under `Contents/Resources/licenses/`. Open **Licenses & acknowledgements** in the
application menu to read them. The generated manifest records versions and
SHA-256 hashes, and packaging fails if a required notice is missing or changed.

Source: https://github.com/electron/electron

## MCP companion

The MCP companion is bundled in the app and can also run from source. Its production dependencies are
listed in `package-lock.json`; their original license/notice files are retained
by npm and also included in the app's acknowledgements for convenience.

- `@modelcontextprotocol/server` and `@modelcontextprotocol/core`: upstream's
  license file explains its Apache-2.0 transition, remaining MIT contributions
  and separate documentation terms. Preserve that full file.
  https://github.com/modelcontextprotocol/typescript-sdk
- `zod`: MIT. https://github.com/colinhacks/zod

Build and test tools keep their own licenses in their installed packages. They
are not included as application runtime dependencies. If distributing a checkout
with `node_modules`, retain all upstream license and notice files, including
file-level terms for MPL-2.0 build dependencies.

## Audio model

The bundled `desktop/models/bd.rnnn` model is by Gregor Richards. Its upstream
rights statement and pinned source are described in
[`desktop/models/NOTICE.md`](desktop/models/NOTICE.md) and
[`desktop/models/RNNOISE-MODELS.md`](desktop/models/RNNOISE-MODELS.md).
The model is not relicensed under this project's MIT license.

Advanced audio settings also offer optional DeepFilterNet3 and MossFormer2 SE
48K downloads. Their pinned sources, checksums, and upstream terms, together
with the downloaded uv/Python runtime, are listed in the same model notice.
These additional weights and runtime packages are fetched from upstream on
first use, rather than bundled with the app.

## FFmpeg

FFmpeg and ffprobe are external executables installed by the user. This repository
and the app packaging script do not bundle them. Their licenses depend on build
configuration and enabled components; invoking a particular local build does not
change its license. A future release that includes FFmpeg binaries must satisfy
the exact build's source, notice and redistribution requirements before shipping.

Source and licensing: https://ffmpeg.org/legal.html
