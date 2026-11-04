"""On-device, multilingual transcription; no audio is sent to a service."""
import json
from pathlib import Path
import sys
import wave

MODEL = "mlx-community/whisper-small-mlx"
REVISION = "45f3915923c7a79a5a5b5a7d909d39aeb0e5630e"


def report(message):
    print("studio-progress:" + json.dumps({"message": message}), flush=True)


def main():
    input_file, output_file, root = sys.argv[1:]
    import numpy as np
    with wave.open(input_file, "rb") as source:
        if source.getframerate() != 16000 or source.getnchannels() != 1 or source.getsampwidth() != 2:
            raise ValueError("Expected mono 16 kHz PCM audio")
        audio = np.frombuffer(source.readframes(source.getnframes()), dtype=np.int16).astype(np.float32) / 32768
    if not len(audio) or float(np.max(np.abs(audio))) < 0.0001:
        result = {"text": "", "language": None}
    else:
        from huggingface_hub import snapshot_download
        import mlx_whisper
        report("Preparing speech model. First use downloads about 500 MB…")
        model = snapshot_download(MODEL, revision=REVISION,
            cache_dir=str(Path(root) / "models"), allow_patterns=["config.json", "weights.npz"])
        report("Transcribing on your Mac…")
        transcript = mlx_whisper.transcribe(audio, path_or_hf_repo=model,
            language=None, task="transcribe", verbose=None, temperature=0.0,
            condition_on_previous_text=False)
        result = {"text": transcript["text"].strip(), "language": transcript.get("language")}
    Path(output_file).write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
