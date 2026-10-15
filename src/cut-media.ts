import { MediaAudio, resumeMediaAudio } from "./media-audio";

// Preroll the next retained span on a second decoder. The audible decoder is
// never sought at a prepared cut; the incoming audio pipeline is already live.
export class CutMedia {
  private spare: HTMLMediaElement | null = null;
  private prepared = "";
  private positioned = false;
  private lastRateChange = -Infinity;
  private pending: number | null = null;
  private lastSeek = -Infinity;
  private held: HTMLCanvasElement | null = null;
  private heldReady = false;
  private volume = 0;
  private audio = new Map<HTMLMediaElement, MediaAudio>();
  constructor(
    public element: HTMLMediaElement,
    private configure: (element: HTMLMediaElement) => void = () => {},
  ) {
    this.attach(element);
  }
  private attach(element: HTMLMediaElement) {
    element.addEventListener("seeked", () => {
      if (element !== this.element) return;
      if (this.pending !== null) {
        const target = this.pending;
        this.pending = null;
        this.seek(target);
      }
    });
    this.configure(element);
  }
  private gain(element: HTMLMediaElement, volume: number) {
    let channel = this.audio.get(element);
    if (!channel) {
      channel = new MediaAudio(element);
      this.audio.set(element, channel);
    }
    channel.set(volume);
  }
  setVolume(volume: number) {
    this.volume = volume;
    this.gain(this.element, volume);
    resumeMediaAudio();
  }
  seek(time: number) {
    const el = this.element;
    if (!Number.isFinite(el.duration)) return;
    const target = Math.max(0, Math.min(time, el.duration - 0.001));
    if (el.seeking) {
      this.pending = target;
      return;
    }
    this.pending = null;
    if (Math.abs(el.currentTime - target) <= 0.004) return;
    this.holdFrame();
    this.lastSeek = performance.now();
    el.currentTime = target;
  }
  follow(time: number, rate: number) {
    const el = this.element,
      drift = time - el.currentTime,
      now = performance.now();
    // Follower startup differences are corrected in rate, not with a seek loop.
    if (!el.seeking && Math.abs(drift) > 0.5 && now - this.lastSeek > 1500)
      this.seek(time);
    const correction =
      !el.seeking && Math.abs(drift) > 0.02
        ? Math.max(-0.08, Math.min(0.08, drift / rate))
        : 0;
    this.rate(el, rate * (1 + correction), now);
  }
  private rate(el: HTMLMediaElement, rate: number, now: number) {
    const value = Math.max(0.0625, Math.min(16, rate));
    if (
      Math.abs(el.playbackRate - value) > 0.002 &&
      now - this.lastRateChange >= 80
    ) {
      el.playbackRate = value;
      this.lastRateChange = now;
    }
  }
  prepare(key: string, target: number, remaining: number, rate: number) {
    if (remaining > 3 || remaining < 0 || target < 0) return;
    if (!this.spare) {
      this.spare = document.createElement(
        this.element.tagName.toLowerCase(),
      ) as HTMLMediaElement;
      this.spare.preload = "auto";
      this.spare.crossOrigin = this.element.crossOrigin;
      this.attach(this.spare);
    }
    const spare = this.spare;
    if (spare.src !== this.element.src) {
      spare.src = this.element.src;
      this.prepared = "";
      spare.load();
    }
    if (this.prepared !== key) {
      spare.pause();
      this.gain(spare, 0);
      this.prepared = key;
      this.positioned = false;
    }
    const desired = target - remaining * rate;
    if (spare.readyState < 1 || !Number.isFinite(spare.duration)) return;
    if (!this.positioned) {
      spare.currentTime = Math.max(
        0,
        Math.min(desired, spare.duration - 0.001),
      );
      spare.playbackRate = rate;
      this.positioned = true;
    }
    if (desired < 0) return;
    if (spare.paused) void spare.play().catch(() => {});
    if (spare.seeking) return;
    // Muted preroll can recover startup latency before its cut becomes visible.
    const correction = Math.max(
      -0.5,
      Math.min(0.5, ((desired - spare.currentTime) * 4) / rate),
    );
    const value = Math.max(0.0625, Math.min(16, rate * (1 + correction)));
    if (Math.abs(spare.playbackRate - value) > 0.005)
      spare.playbackRate = value;
  }
  handoff(key: string, target: number, rate: number) {
    const next = this.spare;
    if (
      !next ||
      this.prepared !== key ||
      !this.positioned ||
      next.seeking ||
      next.readyState < 2 ||
      next.paused ||
      Math.abs(next.currentTime - target) > 0.09
    )
      return false;
    const old = this.element;
    next.playbackRate = rate;
    this.gain(next, this.volume);
    this.gain(old, 0);
    old.pause();
    this.element = next;
    this.spare = old;
    this.prepared = "";
    this.positioned = false;
    this.pending = null;
    this.heldReady = false;
    this.lastSeek = performance.now();
    return true;
  }
  private holdFrame() {
    const el = this.element;
    if (
      !(el instanceof HTMLVideoElement) ||
      el.seeking ||
      el.readyState < 2 ||
      !el.videoWidth
    )
      return;
    this.held ||= document.createElement("canvas");
    const width = Math.min(1280, el.videoWidth),
      height = Math.round((width * el.videoHeight) / el.videoWidth);
    if (this.held.width !== width) this.held.width = width;
    if (this.held.height !== height) this.held.height = height;
    this.held.getContext("2d")!.drawImage(el, 0, 0, width, height);
    this.heldReady = true;
  }
  image(): HTMLVideoElement | HTMLCanvasElement | null {
    const el = this.element;
    if (el instanceof HTMLVideoElement && !el.seeking && el.readyState >= 2)
      return el;
    return this.heldReady ? this.held : null;
  }
  cancel() {
    this.spare?.pause();
    this.prepared = "";
    this.positioned = false;
    this.pending = null;
  }
  reset() {
    this.cancel();
    if (this.spare) {
      this.spare.removeAttribute("src");
      this.spare.load();
    }
    this.heldReady = false;
    if (this.held) this.held.width = this.held.height = 0;
  }
  dispose() {
    this.element.pause();
    this.reset();
    for (const channel of this.audio.values()) channel.dispose();
    this.audio.clear();
  }
}
