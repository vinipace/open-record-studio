# Enhance Audio model

`bd.rnnn` is the beguiling-drafter RNNoise model by Gregor Richards, trained
for voice with recording noise. It is bundled locally and used by FFmpeg's
`arnndn` recurrent neural network filter. No media is uploaded.

Source: https://github.com/GregorR/rnnoise-models/tree/3eee541a283fd3b8f81b85b1748e3b9ccbefa04d/beguiling-drafter-2018-08-30

The model checksum and a summary linking to the author's rights statement are
recorded in `RNNOISE-MODELS.md`. The model is not covered by the project's MIT license.
The FFmpeg filter implementation is provided by the installed FFmpeg binary.

## Optional local models

Advanced audio settings can download the following models. These weights are
not bundled in the app and are not relicensed under the project's MIT license.
Audio is processed locally; downloads only retrieve software and model files.

- **DeepFilterNet3**: Hendrik Schröter and contributors. DeepFilterNet 0.5.6
  (MIT / Apache-2.0), using the upstream full-band checkpoint at revision
  `d375b2d8309e0935d165700c91da9de862a99c31`.
  Source and terms: https://github.com/Rikorose/DeepFilterNet
  Model archive SHA-256:
  `49c52edc8947ae1f9bf50d81530beaf3a2c3245aeaf34b6f31ff535cd22284d2`.
- **MossFormer2 SE 48K**: Alibaba / Tongyi Speech Lab, via ClearVoice 0.1.2.
  The model card declares Apache-2.0. Pinned model revision:
  `eff8c97925c8bec812af707814b3e5d777fd4503`.
  Source and terms: https://huggingface.co/alibabasglab/MossFormer2_SE_48K
  Implementation: https://github.com/modelscope/ClearerVoice-Studio
  Checkpoint SHA-256:
  `03692b9f773bbd6bb43b9c5a41f96b1e28affd66e13796b7bec66ad3d8b227c6`.

The optional engine uses an isolated Python 3.11.13 environment managed by
**uv 0.12.6** (MIT / Apache-2.0, https://github.com/astral-sh/uv).
The Apple silicon uv archive is verified against SHA-256
`14b459d51ea2e71eeba28c45a268c922bdf8607fc6455e3f40b4e082895d160d`.
Pinned Python packages are recorded in `requirements-audio.txt`; their upstream
license files remain in the installed environment. Model files and the helper
live in `~/Library/Application Support/Open Record Studio/audio-models`.
uv shares its standard package and managed-Python caches to avoid duplicate
downloads and installations. The processing wrapper is `enhance.py`.
