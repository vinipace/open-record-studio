import { CutMedia } from "./cut-media";

// Follow the project clock without repeatedly flushing the video/audio decoder.
// Keep the last presented frame available while a deliberate seek is in flight.
export class LayerVideo {
  private frame = document.createElement("canvas");
  private hasFrame = false;
  private callbacks = new Map<HTMLVideoElement, number>();
  private listeners = new Map<
    HTMLVideoElement,
    { present: () => void; seeked: () => void }
  >();
  private bank: CutMedia;
  private nextKey = "";
  private target = 0;
  private pendingSeek = false;
  private lastSeek = -Infinity;
  private lastRateChange = -Infinity;
  private nominalRate = 1;
  private disposed = false;
  constructor(
    element: HTMLVideoElement,
    private redraw: () => void,
  ) {
    this.bank = new CutMedia(element, (media) => {
      const video = media as HTMLVideoElement;
      const present = () => {
        if (video === this.element) this.present();
      };
      const seeked = () => {
        if (video === this.element) this.seeked();
      };
      video.addEventListener("loadeddata", present);
      video.addEventListener("seeked", seeked);
      this.listeners.set(video, { present, seeked });
      const presented = () => {
        if (this.disposed) return;
        present();
        this.callbacks.set(video, video.requestVideoFrameCallback(presented));
      };
      this.callbacks.set(video, video.requestVideoFrameCallback(presented));
    });
  }
  get element() {
    return this.bank.element as HTMLVideoElement;
  }
  prepare(time: number, remaining: number, rate: number) {
    this.nextKey = `${time}:${rate}`;
    this.bank.prepare(this.nextKey, time, remaining, rate);
  }
  setVolume(volume: number) {
    this.bank.setVolume(volume);
  }
  pause() {
    this.bank.cancel();
    this.nextKey = "";
    this.element.pause();
  }
  private present = () => {
    const v = this.element;
    if (v.seeking || v.readyState < 2 || !v.videoWidth) return;
    const width = Math.min(v.videoWidth, 1280),
      height = Math.round((width * v.videoHeight) / v.videoWidth);
    if (this.frame.width !== width || this.frame.height !== height) {
      this.frame.width = width;
      this.frame.height = height;
    }
    this.frame.getContext("2d")!.drawImage(v, 0, 0, width, height);
    this.hasFrame = true;
    this.redraw();
  };
  private seeked = () => {
    this.lastSeek = performance.now();
    this.present();
    this.seek();
  };
  private seek() {
    const v = this.element;
    if (!this.pendingSeek || v.seeking || v.readyState < 1) return;
    this.pendingSeek = false;
    if (Math.abs(v.currentTime - this.target) <= 0.004) return;
    this.lastSeek = performance.now();
    this.bank.seek(this.target);
  }
  sync(time: number, rate: number, playing: boolean, force = false) {
    const handed =
      playing && force && this.bank.handoff(this.nextKey, time, rate);
    if (handed) {
      this.pendingSeek = false;
      this.lastSeek = performance.now();
      this.present();
    }
    if (!playing) this.bank.cancel();
    const v = this.element,
      now = performance.now();
    this.target = time;
    const drift = time - v.currentTime;
    if (
      (force && !handed) ||
      !playing ||
      (!v.seeking && Math.abs(drift) > 0.5 && now - this.lastSeek > 1000)
    )
      this.pendingSeek = true;
    this.seek();
    // Small clock differences are corrected gradually. Seeking at 80 ms made
    // Opus startup latency trigger a perpetual seek/buffer loop on webcam takes.
    const correction =
      playing && !v.seeking && Math.abs(drift) > 0.025
        ? Math.max(-0.05, Math.min(0.05, (drift / rate) * 0.5))
        : 0;
    const desiredRate = Math.max(0.0625, Math.min(16, rate * (1 + correction)));
    if (
      Math.abs(v.playbackRate - desiredRate) > 0.002 &&
      (force ||
        !playing ||
        rate !== this.nominalRate ||
        now - this.lastRateChange >= 100)
    ) {
      v.playbackRate = desiredRate;
      this.lastRateChange = now;
    }
    this.nominalRate = rate;
    if (playing) {
      if (v.paused) void v.play().catch(() => {});
    } else if (!v.paused) v.pause();
  }
  image() {
    if (!this.hasFrame) this.present();
    return this.hasFrame ? this.frame : null;
  }
  dispose() {
    this.disposed = true;
    this.pause();
    for (const [video, callback] of this.callbacks)
      video.cancelVideoFrameCallback(callback);
    for (const [video, listeners] of this.listeners) {
      video.removeEventListener("loadeddata", listeners.present);
      video.removeEventListener("seeked", listeners.seeked);
    }
    this.bank.dispose();
    this.frame.width = this.frame.height = 0;
    this.hasFrame = false;
  }
}
