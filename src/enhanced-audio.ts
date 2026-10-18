import { CutMedia } from "./cut-media";
import { sourceTime, segmentAt, nextMediaCut } from "./timeline";
import { layerSample } from "../desktop/webcam-take.mjs";
import { audioRemovedAt } from "../desktop/audio-edits.mjs";
import { defaultAudioModel } from "../desktop/audio-models.mjs";
import type { Project, Edits } from "./types";

type Entry = {
  bank: CutMedia;
  key: string;
  layer?: string;
  segment: number;
  active: boolean;
};
export class EnhancedAudio {
  ready = false;
  pending = false;
  error = "";
  message = "";
  private requestId = "";
  private signature = "";
  private generation = 0;
  private projectId = "";
  private loading: AbortController | null = null;
  private entries: Entry[] = [];
  constructor(
    private changed: () => void,
    private prepared: () => void,
  ) {
    window.studio.onEnhanceProgress?.((progress) => {
      if (!this.pending || progress.requestId !== this.requestId) return;
      this.message = progress.message;
      this.changed();
    });
  }
  has(key: string) {
    return this.ready && this.entries.some((e) => e.key === key);
  }
  configure(project: Project, edits: Edits) {
    const enabled = edits.style.enhanceAudio;
    const signature = enabled
      ? JSON.stringify([
          project.id,
          edits.style.audioEnhancementModel ?? defaultAudioModel,
          project.tracks,
          project.assets,
          edits.layers?.map((l) => [l.id, l.assetId]),
        ])
      : "";
    if (signature === this.signature) return;
    this.reset();
    this.signature = signature;
    if (!enabled) {
      this.changed();
      return;
    }
    this.projectId = project.id;
    this.requestId = crypto.randomUUID();
    this.loading = new AbortController();
    this.pending = true;
    this.changed();
    const generation = this.generation;
    void this.load(project, edits, generation, this.loading);
  }
  private async load(
    project: Project,
    edits: Edits,
    generation: number,
    controller: AbortController,
  ) {
    const entries: Entry[] = [];
    try {
      const urls = await window.studio.enhanceAudio(
        project.id,
        edits.style.audioEnhancementModel ?? defaultAudioModel,
        this.requestId,
      );
      if (generation !== this.generation) return;
      const targets = [
        ...["screen", "microphone"]
          .filter((key) => urls[key])
          .map((key) => ({ key, layer: undefined as string | undefined })),
        ...(edits.layers || [])
          .filter((l) => urls[`asset-${l.assetId}`])
          .map((l) => ({ key: `asset-${l.assetId}`, layer: l.id })),
      ];
      await Promise.all(
        targets.map(async (target) => {
          const audio = document.createElement("audio");
          audio.crossOrigin = "anonymous";
          audio.preload = "auto";
          const bank = new CutMedia(audio);
          bank.setVolume(0);
          entries.push({ ...target, bank, segment: -1, active: false });
          await new Promise<void>((resolve, reject) => {
            const finish = (error?: Error) => {
              clearTimeout(timer);
              audio.oncanplay = audio.onerror = null;
              controller.signal.removeEventListener("abort", aborted);
              if (error) reject(error);
              else resolve();
            };
            const aborted = () =>
              finish(new Error("Audio enhancement cancelled"));
            const timer = setTimeout(
              () => finish(new Error("Enhanced audio took too long to load")),
              30000,
            );
            controller.signal.addEventListener("abort", aborted, {
              once: true,
            });
            if (controller.signal.aborted) {
              aborted();
              return;
            }
            audio.oncanplay = () => finish();
            audio.onerror = () =>
              finish(new Error("Could not load enhanced audio"));
            audio.src = urls[target.key];
            audio.load();
          });
        }),
      );
      if (generation !== this.generation) {
        this.release(entries);
        return;
      }
      this.entries = entries;
      this.pending = false;
      this.ready = true;
      this.changed();
      this.prepared();
    } catch (error) {
      controller.abort();
      this.release(entries);
      if (generation !== this.generation) return;
      this.pending = false;
      this.error =
        error instanceof Error ? error.message : "Could not enhance audio";
      this.changed();
    }
  }
  sync(
    project: Project,
    edits: Edits,
    playhead: number,
    playing: boolean,
    combined: boolean,
    force = false,
  ) {
    if (!this.ready) return;
    const source = sourceTime(edits, playhead),
      segment = segmentAt(edits, playhead),
      next = nextMediaCut(edits, playhead);
    for (const entry of this.entries) {
      const layer = entry.layer
        ? edits.layers?.find((l) => l.id === entry.layer)
        : null;
      const asset = layer ? project.assets![layer.assetId] : null;
      const track =
        entry.key === "screen"
          ? project.tracks.screen
          : project.tracks.microphone;
      const sample = (time: number) =>
        layer && asset
          ? combined && layer.visible && layer.opacity > 0
            ? layerSample(layer, asset, time)
            : null
          : track
            ? { time: time - track.offset, rate: 1 }
            : null;
      const current = sample(source),
        bank = entry.bank;
      const active =
        !!current &&
        current.time >= 0 &&
        current.time < (asset?.duration ?? track?.duration ?? 0);
      const entered = active && !entry.active;
      const cut =
        segment !== entry.segment &&
        entry.segment >= 0 &&
        (segment !== entry.segment + 1 ||
          Math.abs(
            edits.segments[segment].start - edits.segments[entry.segment].end,
          ) > 0.001);
      entry.segment = segment;
      entry.active = active;
      if (active && current) {
        const rate = edits.style.speed * current.rate;
        const handed =
          playing &&
          (cut || entered) &&
          bank.handoff(`${segment}:${rate}`, current.time, rate);
        if (!handed && (force || cut || entered || !playing))
          bank.seek(current.time);
        else if (playing) bank.follow(current.time, rate);
        const el = bank.element;
        if (!playing || force || cut) el.playbackRate = rate;
        bank.setVolume(
          layer
            ? (layer.volume ?? 1)
            : audioRemovedAt(edits, source)
              ? 0
              : entry.key === "screen"
                ? edits.style.volume
                : edits.style.microphoneVolume,
        );
        if (playing && el.paused) void el.play().catch(() => {});
        else if (!playing && !el.paused) el.pause();
      } else {
        bank.setVolume(0);
        bank.element.pause();
      }
      const incoming = next && playing ? sample(next.source) : null;
      if (incoming && next)
        bank.prepare(
          `${next.index}:${edits.style.speed * incoming.rate}`,
          incoming.time,
          next.time - playhead,
          edits.style.speed * incoming.rate,
        );
      else bank.cancel();
    }
  }
  pause() {
    for (const { bank } of this.entries) {
      bank.cancel();
      bank.element.pause();
    }
  }
  private release(entries: Entry[]) {
    for (const { bank } of entries) {
      bank.dispose();
      bank.element.removeAttribute("src");
      bank.element.load();
    }
  }
  reset() {
    this.loading?.abort();
    this.loading = null;
    if (this.pending && this.projectId)
      void window.studio
        .cancelEnhanceAudio(this.projectId, this.requestId)
        .catch(() => {});
    this.generation++;
    this.release(this.entries);
    this.entries = [];
    this.ready = this.pending = false;
    this.error =
      this.message =
      this.signature =
      this.projectId =
      this.requestId =
        "";
  }
}
