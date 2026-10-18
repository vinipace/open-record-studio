"""Local speech enhancement. Pinned weights; bounded-memory, sample-aligned I/O."""
import hashlib
import json
import os
from pathlib import Path
import ssl
import sys
import urllib.request
import zipfile


def report(message, progress=None):
    print("studio-progress:" + json.dumps({"message": message, "progress": progress}), flush=True)


def download(url, target, checksum):
    if target.is_file():
        return target
    report("Downloading model. This only happens on first use…")
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(os.environ["STUDIO_AUDIO_TEMP"]) / (target.name + ".part")
    import certifi
    try:
        digest = hashlib.sha256()
        with urllib.request.urlopen(url, context=ssl.create_default_context(cafile=certifi.where()), timeout=60) as response, temporary.open("wb") as output:
            size = int(response.headers.get("Content-Length", 0))
            received, previous = 0, -1
            while chunk := response.read(1024 * 1024):
                digest.update(chunk)
                output.write(chunk)
                received += len(chunk)
                percent = min(100, int(100 * received / size)) if size else 0
                if size and percent // 5 != previous:
                    previous = percent // 5
                    report(f"Downloading model… {percent}%")
        if digest.hexdigest() != checksum:
            raise RuntimeError("Model download failed verification. Please retry.")
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
    return target


def load_deepfilter(root):
    from df.enhance import init_df, enhance
    import torch
    archive = download(
        "https://raw.githubusercontent.com/Rikorose/DeepFilterNet/d375b2d8309e0935d165700c91da9de862a99c31/models/DeepFilterNet3.zip",
        root / "DeepFilterNet3.zip",
        "49c52edc8947ae1f9bf50d81530beaf3a2c3245aeaf34b6f31ff535cd22284d2",
    )
    model_dir = root / "DeepFilterNet3"
    # Extract only the two verified model files; replace each atomically so a
    # cancelled first run cannot leave a checkpoint that looks complete.
    with zipfile.ZipFile(archive) as files:
        for name in ["DeepFilterNet3/config.ini", "DeepFilterNet3/checkpoints/model_120.ckpt.best"]:
            target = root / name
            if not target.is_file():
                target.parent.mkdir(parents=True, exist_ok=True)
                temporary = Path(os.environ["STUDIO_AUDIO_TEMP"]) / (target.name + ".part")
                temporary.write_bytes(files.read(name))
                os.replace(temporary, target)
    report("Loading DeepFilterNet3…")
    model, state, _ = init_df(str(model_dir), log_level="ERROR", log_file=None)

    def process(audio):
        return enhance(model, state, torch.from_numpy(audio[None, :]), pad=True)[0].numpy()
    return process


def load_mossformer(root):
    import torch
    from types import SimpleNamespace
    from clearvoice.models.mossformer2_se.mossformer2_se_wrapper import MossFormer2_SE_48K
    from clearvoice.utils.decode import decode_one_audio_mossformer2_se_48k
    checkpoint = download(
        "https://huggingface.co/alibabasglab/MossFormer2_SE_48K/resolve/eff8c97925c8bec812af707814b3e5d777fd4503/last_best_checkpoint.pt",
        root / "MossFormer2_SE_48K.pt",
        "03692b9f773bbd6bb43b9c5a41f96b1e28affd66e13796b7bec66ad3d8b227c6",
    )
    # Same analysis/synthesis configuration as ClearVoice 0.1.2. Chunking is
    # handled below, avoiding the upstream long-file decoder's end padding.
    args = SimpleNamespace(sampling_rate=48000, one_time_decode_length=60,
                           decode_window=4, win_type="hamming", win_len=1920,
                           win_inc=384, fft_len=1920, num_mels=60)
    report("Loading MossFormer2…")
    model = MossFormer2_SE_48K(args).model
    weights = torch.load(checkpoint, map_location="cpu", weights_only=True)
    weights = weights.get("model", weights)
    weights = {key.removeprefix("module."): value for key, value in weights.items()}
    model.load_state_dict(weights, strict=True)
    # CPU is predictable across supported Macs and leaves the GPU available for
    # the editor. Two threads also avoid saturating video preview/export.
    device = torch.device("cpu")
    model.eval()
    return lambda audio: decode_one_audio_mossformer2_se_48k(model, device, audio[None, :], args)


def main():
    model_id, input_file, output_file, root = sys.argv[1:]
    report("Loading local audio engine…")
    import numpy as np
    import soundfile as sf
    import torch
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    loaders = {"deepfilternet3": load_deepfilter, "mossformer2": load_mossformer}
    process = loaders[model_id](Path(root))
    name = "DeepFilterNet3" if model_id == "deepfilternet3" else "MossFormer2"
    # Ten-second output blocks with one second of context on each side keep
    # memory bounded even for long recordings. Context is discarded, not added
    # to the timeline. Every channel retains its original timing and gain.
    with sf.SoundFile(input_file) as source, sf.SoundFile(output_file, mode="w", samplerate=48000, channels=source.channels, subtype="FLOAT") as output:
        if source.samplerate != 48000 or not len(source):
            raise ValueError("Expected non-empty 48 kHz audio")
        block, context = 480000, 48000
        for start in range(0, len(source), block):
            end = min(start + block, len(source))
            left, right = max(0, start - context), min(len(source), end + context)
            source.seek(left)
            audio = source.read(right - left, dtype="float32", always_2d=True)
            # Very short recordings still need enough context for FFT windows.
            if len(audio) < 4800:
                audio = np.pad(audio, ((0, 4800 - len(audio)), (0, 0)))
            channels = []
            with torch.inference_mode():
                for channel in range(source.channels):
                    clean = np.asarray(process(audio[:, channel].copy()), dtype=np.float32)
                    if len(clean) < end - left or not np.isfinite(clean).all():
                        raise RuntimeError("Model returned incomplete or invalid audio")
                    channels.append(clean[start - left:end - left])
            output.write(np.stack(channels, axis=1))
            report(f"Enhancing with {name}… {round(100 * end / len(source))}%", end / len(source))


if __name__ == "__main__":
    main()
