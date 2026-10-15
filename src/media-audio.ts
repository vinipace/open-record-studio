// One output device for every decoder. Muting a media element can stop its
// native audio sink; making it audible again then stalls its media clock.
// Keep the elements feeding a live AudioContext and switch only mixer gains.
let output: AudioContext | null = null;
let resuming: Promise<void> | null = null;

export function resumeMediaAudio() {
  if (!output || output.state === "running" || resuming) return;
  resuming = output
    .resume()
    .catch(() => {})
    .finally(() => {
      resuming = null;
    });
}

export class MediaAudio {
  private source: MediaElementAudioSourceNode;
  private gain: GainNode;
  constructor(element: HTMLMediaElement) {
    output ||= new AudioContext({ latencyHint: "interactive" });
    this.source = output.createMediaElementSource(element);
    this.gain = output.createGain();
    this.gain.gain.value = 0;
    this.source.connect(this.gain);
    this.gain.connect(output.destination);
    element.volume = 1;
    element.muted = false;
  }
  set(volume: number) {
    if (this.gain.gain.value !== volume) this.gain.gain.value = volume;
  }
  dispose() {
    this.source.disconnect();
    this.gain.disconnect();
  }
}
