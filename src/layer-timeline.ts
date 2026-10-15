import { layerSpans, takeOutputSpans } from "../desktop/webcam-take.mjs";
import { mergeRanges } from "../desktop/audio-edits.mjs";
import { sourceRanges } from "../desktop/motion.mjs";
import { duration } from "./timeline";
import { drawTakeWaveform, type Waveform } from "./waveform";
import { timelineSlice, type TimelineViewport } from "./timeline-viewport";
import type { Project, Edits, TimeRange, TakeSpan } from "./types";

type Part = "video" | "audio";
type Clip = {
  button: HTMLButtonElement;
  label: HTMLElement;
  canvas?: HTMLCanvasElement;
  paintKey?: string;
  waveform?: Waveform;
};
type Row = {
  node: HTMLElement;
  name: HTMLElement;
  symbol: HTMLElement;
  lane: HTMLElement;
  clips: Clip[];
};
type Group = { node: HTMLElement; video: Row; audio: Row };
type Peaks = { status: "loading" | "ready" | "error"; waveform?: Waveform };

/** Retain clip nodes and peak canvases across selection and playhead updates. */
export class LayerTimeline {
  private groups = new Map<string, Group>();
  private peaks = new Map<string, Peaks>();
  private projectId = "";
  private state?: [Project | null, Edits | null, string, Part];
  private viewport: TimelineViewport = { left: 0, width: Infinity };
  constructor(
    private root: HTMLElement,
    private icon: (name: string, size?: number) => string,
  ) {
    new ResizeObserver(() => this.refresh()).observe(root);
  }
  private refresh() {
    if (this.state) this.render(...this.state);
  }
  private makeRow(part: Part): Row {
    const node = document.createElement("div");
    node.className = `track-row layer-row${part === "audio" ? " take-audio-row" : ""}`;
    node.innerHTML =
      '<div class="track-label"><span class="track-symbol"></span><span></span></div><div class="lane layer-lane"></div>';
    return {
      node,
      symbol: node.querySelector(".track-symbol")!,
      name: node.querySelector(".track-label > span:last-child")!,
      lane: node.querySelector(".lane")!,
      clips: [],
    };
  }
  render(
    project: Project | null,
    edits: Edits | null,
    selected: string,
    part: Part,
    viewport = this.viewport,
  ) {
    this.viewport = viewport;
    this.state = [project, edits, selected, part];
    if (this.projectId !== (project?.id || "")) {
      this.projectId = project?.id || "";
      this.peaks.clear();
      this.groups.clear();
      this.root.replaceChildren();
    }
    const layers = [...(edits?.layers || [])].reverse();
    for (const [id, group] of this.groups) {
      if (!layers.some((layer) => layer.id === id)) {
        group.node.remove();
        this.groups.delete(id);
      }
    }
    for (const [index, layer] of layers.entries()) {
      const asset = project!.assets![layer.assetId];
      let group = this.groups.get(layer.id);
      if (!group) {
        const node = document.createElement("div");
        node.className = "layer-track-group";
        group = {
          node,
          video: this.makeRow("video"),
          audio: this.makeRow("audio"),
        };
        node.append(group.video.node, group.audio.node);
        this.groups.set(layer.id, group);
      }
      if (this.root.children[index] !== group.node)
        this.root.insertBefore(group.node, this.root.children[index] || null);
      const hasAudio = !!asset.timeMap && !!asset.audio;
      group.audio.node.hidden = !hasAudio;
      if (hasAudio && !this.peaks.has(layer.assetId)) {
        const peaks: Peaks = { status: "loading" };
        this.peaks.set(layer.assetId, peaks);
        void window.studio
          .assetWaveform(project!.id, layer.assetId)
          .then((waveform) => {
            peaks.waveform = waveform;
            peaks.status = "ready";
          })
          .catch(() => {
            peaks.status = "error";
          })
          .finally(() => {
            if (this.peaks.get(layer.assetId) === peaks) this.refresh();
          });
      }
      const ranges = mergeRanges(layerSpans(layer, asset)).flatMap(
        (span: TimeRange) => sourceRanges(edits!, span.start, span.end),
      );
      const spans = hasAudio ? takeOutputSpans(edits!, layer, asset) : [];
      const total = duration(edits!);
      const gain = layer.visible && layer.opacity > 0 ? (layer.volume ?? 1) : 0;
      for (const kind of ["video", "audio"] as const) {
        if (kind === "audio" && !hasAudio) continue;
        const row = group[kind];
        const name = asset.name + (kind === "audio" ? " audio" : "");
        row.name.textContent = name;
        row.name.parentElement!.title = name;
        row.symbol.className = `track-symbol ${kind === "audio" ? "audio" : "layer"}`;
        const symbol =
          kind === "audio"
            ? "mic"
            : asset.timeMap
              ? "camera"
              : asset.sourceKind === "image"
                ? "image"
                : "screen";
        if (row.symbol.dataset.icon !== symbol) {
          row.symbol.dataset.icon = symbol;
          row.symbol.innerHTML = this.icon(symbol, 17);
        }
        while (row.clips.length > ranges.length)
          row.clips.pop()!.button.remove();
        const laneWidth =
          kind === "audio" ? row.lane.getBoundingClientRect().width : 0;
        for (const [i, range] of ranges.entries()) {
          let clip = row.clips[i];
          if (!clip) {
            const button = document.createElement("button");
            button.className = `layer-clip${kind === "audio" ? " take-audio-clip" : ""}`;
            button.dataset.layer = layer.id;
            button.dataset.layerPart = kind;
            button.innerHTML =
              '<i data-layer-trim="start"></i><span class="layer-clip-label"></span><i data-layer-trim="end"></i>';
            clip = { button, label: button.querySelector("span")! };
            if (kind === "audio") {
              clip.canvas = document.createElement("canvas");
              clip.canvas.className = "audio-waveform";
              clip.canvas.setAttribute("aria-hidden", "true");
              button.prepend(clip.canvas);
            }
            row.clips.push(clip);
            row.lane.append(button);
          }
          clip.button.setAttribute(
            "aria-label",
            name + (kind === "video" ? " layer" : ""),
          );
          clip.button.setAttribute(
            "aria-pressed",
            String(layer.id === selected && kind === part),
          );
          clip.button.classList.toggle(
            "selected",
            layer.id === selected && kind === part,
          );
          clip.button.classList.toggle("layer-hidden", !layer.visible);
          clip.button.style.left = `${(range.start / total) * 100}%`;
          clip.button.style.width = `${((range.end - range.start) / total) * 100}%`;
          clip.label.textContent =
            name + (kind === "audio" && gain === 0 ? " · Muted" : "");
          if (kind === "audio")
            this.paintAudio(
              clip,
              this.peaks.get(layer.assetId)!,
              spans,
              range,
              gain,
              laneWidth,
              total,
            );
        }
      }
    }
    this.root
      .closest(".timeline-scroll")
      ?.classList.toggle("has-layers", !!layers.length);
  }
  private paintAudio(
    clip: Clip,
    peaks: Peaks,
    spans: TakeSpan[],
    range: TimeRange,
    gain: number,
    laneWidth: number,
    total: number,
  ) {
    clip.button.dataset.waveform = peaks.status;
    clip.button.title =
      peaks.status === "error"
        ? "Microphone waveform unavailable"
        : peaks.status === "loading"
          ? "Loading microphone waveform…"
          : "Microphone audio · timing linked to webcam take";
    if (!peaks.waveform) return;
    const slice = timelineSlice(
      (range.start / total) * laneWidth + 3,
      ((range.end - range.start) / total) * laneWidth - 6,
      this.viewport,
    );
    clip.canvas!.hidden = !slice.width;
    if (!slice.width) return;
    clip.canvas!.style.left = `${2 + slice.offset}px`;
    clip.canvas!.style.width = `${slice.width}px`;
    const start = range.start + (range.end - range.start) * slice.from;
    const end = range.start + (range.end - range.start) * slice.to;
    const width = slice.width;
    const key = JSON.stringify([
      range,
      spans,
      width,
      start,
      end,
      window.devicePixelRatio,
      gain,
    ]);
    if (clip.paintKey === key && clip.waveform === peaks.waveform) return;
    clip.paintKey = key;
    clip.waveform = peaks.waveform;
    drawTakeWaveform(
      clip.canvas!,
      peaks.waveform,
      spans,
      start,
      end,
      width,
      gain,
    );
  }
}
