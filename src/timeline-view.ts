import { audibleRanges } from "../desktop/audio-edits.mjs";
import type { Edits, Project, TimeRange, Zoom } from "./types";
import type { Filmstrip } from "./filmstrip";
import { frameAt } from "./filmstrip";
import { clock } from "./timeline";
import { sourceRanges } from "../desktop/motion.mjs";
import { drawWaveform, type WaveformState } from "./waveform";
import {
  timelineSlice,
  timelineTicks,
  type TimelineViewport,
} from "./timeline-viewport";

const zoomAppearance = {
  click: {
    label: "Click",
    icon: '<path d="m5 3 14 9-7 1-3 7zM13 14l4 6"/>',
  },
  typing: {
    label: "Typing",
    icon: '<rect x="2" y="5" width="20" height="14" rx="3"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 16h10"/>',
  },
  selection: {
    label: "Text selection",
    icon: '<path d="M8 3h3l2 2v14l-2 2H8M18 3h-3l-2 2m0 14 2 2h3"/><rect x="3" y="7" width="18" height="10" rx="1" stroke-dasharray="2 3"/>',
  },
  scroll: {
    label: "Scroll",
    icon: '<path d="M12 3v18m-4-14 4-4 4 4M8 17l4 4 4-4"/>',
  },
  drag: {
    label: "Drag",
    icon: '<path d="M5 3v15l4-4 3 7 3-2-3-6h6zM17 3h4v4"/>',
  },
  event: {
    label: "Automatic",
    icon: '<path d="m13 2-9 12h7l-1 8 10-13h-7z"/>',
  },
};
const zoomTrigger = (zoom: Zoom) =>
  zoom.trigger ?? (/^auto-\d+$/.test(zoom.id) ? "event" : undefined);

type ClipNode = {
  node: HTMLButtonElement;
  duration: HTMLElement;
  filmstrip: HTMLElement;
  frames?: Filmstrip;
  thumbnailKey?: string;
  waveform?: HTMLCanvasElement;
  waveformStatus?: HTMLElement;
  waveformKey?: string;
  waveforms?: WaveformState;
};
const text = (node: Element, value: string) => {
  if (node.textContent !== value) node.textContent = value;
};
const style = (node: HTMLElement, key: "left" | "width", value: number) => {
  const next = `${Number(value.toFixed(6))}%`;
  if (node.style[key] !== next) node.style[key] = next;
};

// Keep nodes (including decoded thumbnail images and focused handles) across
// selection, trims and undo. Only structural edits add/remove clip nodes.
export class TimelineView {
  private lanes = new Map<string, ClipNode[]>();
  private zoomNodes = new Map<string, HTMLButtonElement>();
  private zoomOptions = new Map<string, HTMLOptionElement>();
  private project = "";
  private ticksKey = "";
  constructor(private icon: (name: string, size: number) => string) {}

  render(
    project: Project,
    edits: Edits,
    selected: number,
    selectedZoom: string,
    filmstrips: Partial<Record<"screen" | "camera", Filmstrip>>,
    total: number,
    trimming: boolean,
    waveforms: WaveformState,
    laneWidth: number,
    selectedAudio: TimeRange | null = null,
    viewport: TimelineViewport = { left: 0, width: laneWidth },
  ) {
    if (this.project !== project.id) {
      this.project = project.id;
      this.lanes.clear();
      for (const key of ["screen", "camera", "audio"])
        document.querySelector(`#${key}-lane`)!.replaceChildren();
    }
    const positions: { left: number; width: number; duration: number }[] = [];
    let offset = 0;
    for (const seg of edits.segments) {
      const duration = (seg.end - seg.start) / edits.style.speed;
      positions.push({
        left: (offset / total) * 100,
        width: (duration / total) * 100,
        duration,
      });
      offset += duration;
    }
    const { ticks, spacing } = timelineTicks(total, laneWidth, viewport);
    const ticksKey = JSON.stringify(ticks);
    if (this.ticksKey !== ticksKey) {
      this.ticksKey = ticksKey;
      const root = document.querySelector<HTMLElement>("#ticks")!;
      root.style.setProperty("--tick-spacing", `${spacing / 5}px`);
      while (root.children.length > ticks.length)
        root.lastElementChild!.remove();
      ticks.forEach(({ label, left }, i) => {
        if (!root.children[i]) root.append(document.createElement("span"));
        const node = root.children[i] as HTMLElement;
        text(node, label);
        node.style.left = `${left}px`;
        node.style.transform = left > laneWidth - 70 ? "translateX(-100%)" : "";
      });
    }
    for (const key of ["screen", "camera", "audio"] as const) {
      const lane = document.querySelector(`#${key}-lane`)!;
      const track = key === "audio" ? undefined : project.tracks[key];
      const present =
        key === "audio"
          ? project.tracks.screen.audio || project.tracks.microphone?.audio
          : track;
      if (!present) {
        if (!lane.querySelector(".empty-track"))
          lane.innerHTML = `<span class="empty-track">No ${key === "camera" ? "webcam" : "audio"} track</span>`;
        this.lanes.delete(key);
        continue;
      }
      let clips = this.lanes.get(key);
      if (!clips) {
        lane.replaceChildren();
        clips = [];
        this.lanes.set(key, clips);
      }
      const items = edits.segments.flatMap((seg, clipIndex) =>
        (key === "audio" ? audibleRanges(edits, seg) : [seg]).map((range) => ({
          ...range,
          clipIndex,
          left:
            positions[clipIndex].left +
            ((range.start - seg.start) / edits.style.speed / total) * 100,
          width: ((range.end - range.start) / edits.style.speed / total) * 100,
          duration: (range.end - range.start) / edits.style.speed,
        })),
      );
      while (clips.length > items.length) clips.pop()!.node.remove();
      const empty = lane.querySelector(".empty-track");
      if (items.length) empty?.remove();
      else if (!empty)
        lane.insertAdjacentHTML(
          "beforeend",
          '<span class="empty-track">Audio removed · Undo to restore</span>',
        );
      for (const [i, seg] of items.entries()) {
        let clip = clips[i];
        if (!clip) {
          const node = document.createElement("button");
          node.className = `clip ${key}`;
          node.dataset.clip = String(i);
          node.dataset.track = key;
          node.setAttribute("aria-label", `Select ${key} clip ${i + 1}`);
          const label =
            key === "screen" ? "Screen" : key === "camera" ? "Webcam" : "Audio";
          node.innerHTML = `<span class="filmstrip" aria-hidden="true"></span><span class="clip-label">${this.icon(key === "audio" ? "volume" : key, 12)}<span>${label} ${i + 1}</span><small></small></span><span class="trim-handle start" data-trim="start" title="Drag to trim start"></span><span class="trim-handle end" data-trim="end" title="Drag to trim end"></span>`;
          clip = {
            node,
            duration: node.querySelector("small")!,
            filmstrip: node.querySelector(".filmstrip")!,
          };
          if (key === "audio") {
            clip.waveform = document.createElement("canvas");
            clip.waveform.className = "audio-waveform";
            clip.waveform.setAttribute("aria-hidden", "true");
            clip.waveformStatus = document.createElement("span");
            clip.waveformStatus.className = "waveform-status";
            clip.waveformStatus.setAttribute("role", "status");
            node.prepend(clip.waveform, clip.waveformStatus);
          }
          clips.push(clip);
          lane.append(node);
        }
        clip.node.dataset.clip = String(seg.clipIndex);
        clip.node.setAttribute(
          "aria-label",
          `Select ${key} clip ${seg.clipIndex + 1}`,
        );
        text(
          clip.node.querySelector(".clip-label > span")!,
          `${key === "screen" ? track?.name || (track?.sourceKind ? "Media" : "Screen") : key === "camera" ? "Webcam" : "Audio"} ${seg.clipIndex + 1}`,
        );
        if (key === "audio") {
          clip.node.dataset.audioStart = String(seg.start);
          clip.node.dataset.audioEnd = String(seg.end);
          // A fragment edge inside removed audio cannot trim the linked video.
          for (const side of ["start", "end"] as const)
            (
              clip.node.querySelector(`[data-trim="${side}"]`) as HTMLElement
            ).hidden = seg[side] !== edits.segments[seg.clipIndex][side];
        }
        style(clip.node, "left", seg.left);
        style(clip.node, "width", seg.width);
        const isSelected =
          key === "audio"
            ? selectedAudio?.start === seg.start &&
              selectedAudio?.end === seg.end
            : seg.clipIndex === selected;
        const pressed = String(isSelected);
        if (clip.node.getAttribute("aria-pressed") !== pressed) {
          clip.node.classList.toggle("selected", isSelected);
          clip.node.setAttribute("aria-pressed", pressed);
        }
        text(clip.duration, clock(seg.duration));
        const width = Math.max(1, (laneWidth * seg.width) / 100 - 6);
        const slice = timelineSlice(
          (laneWidth * seg.left) / 100 + 3,
          width,
          viewport,
        );
        if (key === "audio") {
          clip.waveform!.hidden = slice.width === 0;
          if (!slice.width) continue;
          clip.waveform!.style.left = `${2 + slice.offset}px`;
          clip.waveform!.style.width = `${slice.width}px`;
          const from = seg.start + (seg.end - seg.start) * slice.from;
          const to = seg.start + (seg.end - seg.start) * slice.to;
          const waveformKey = `${from}:${to}:${slice.width}:${window.devicePixelRatio}:${project.tracks.screen.offset}:${project.tracks.microphone?.offset}:${edits.style.volume}:${edits.style.microphoneVolume}`;
          if (
            clip.waveformKey !== waveformKey ||
            clip.waveforms !== waveforms
          ) {
            clip.waveformKey = waveformKey;
            clip.waveforms = waveforms;
            clip.node.dataset.waveform = waveforms.status;
            clip.waveformStatus!.hidden = waveforms.status === "ready";
            text(
              clip.waveformStatus!,
              waveforms.status === "error"
                ? "Waveform unavailable"
                : "Loading waveform…",
            );
            clip.node.title =
              Object.keys(waveforms.tracks).length === 2
                ? "Screen waveform (top) · Microphone waveform (bottom)"
                : project.tracks.microphone?.audio
                  ? "Microphone waveform"
                  : "Screen audio waveform";
            drawWaveform(
              clip.waveform!,
              waveforms.tracks,
              project,
              edits,
              from,
              to,
              slice.width,
            );
          }
          continue;
        }
        if (trimming) continue;
        const count = Math.max(1, Math.ceil(width / 100));
        const first = slice.width ? Math.floor(slice.from * count) : 0;
        const last = slice.width ? Math.ceil(slice.to * count) : 0;
        const visibleCount = last - first;
        const offset =
          (track?.offset || 0) +
          (key === "camera" ? edits.style.cameraOffset : 0);
        const thumbnailKey = `${seg.start}:${seg.end}:${offset}:${count}:${first}:${last}`;
        const frames = filmstrips[key];
        if (clip.thumbnailKey === thumbnailKey && clip.frames === frames)
          continue;
        clip.thumbnailKey = thumbnailKey;
        clip.frames = frames;
        while (clip.filmstrip.children.length > visibleCount)
          clip.filmstrip.lastElementChild!.remove();
        for (let j = first; j < last; j++) {
          let thumb = clip.filmstrip.children[j - first] as
            HTMLElement | undefined;
          if (!thumb) {
            thumb = document.createElement("span");
            clip.filmstrip.append(thumb);
          }
          thumb.style.left = `${(j / count) * 100}%`;
          thumb.style.width = `${100 / count}%`;
          const time =
            seg.start + ((seg.end - seg.start) * (j + 0.5)) / count - offset;
          const image =
            time >= 0 && time < (track?.duration || 0)
              ? frameAt(frames, time)
              : "";
          thumb.style.backgroundImage = image ? `url("${image}")` : "";
          thumb.style.backgroundColor = image ? "" : "#09090b";
        }
      }
    }
    this.renderZooms(edits, selectedZoom, total);
  }

  private renderZooms(edits: Edits, selected: string, total: number) {
    const lane = document.querySelector("#zoom-lane")!;
    const retained = new Set<string>();
    let previous: Element | null = null;
    for (const [i, zoom] of (edits.zooms || []).entries()) {
      const ranges = sourceRanges(edits, zoom.start, zoom.end);
      for (const [part, range] of ranges.entries()) {
        const key = `${zoom.id}:${part}`;
        retained.add(key);
        let node = this.zoomNodes.get(key);
        if (!node) {
          lane.querySelector(".empty-track")?.remove();
          node = document.createElement("button");
          node.className = "zoom-clip";
          node.dataset.zoomId = zoom.id;
          node.innerHTML =
            '<span data-zoom-trim="start" class="trim-handle start"></span><svg class="zoom-event-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"></svg><span class="zoom-label"></span><span data-zoom-trim="end" class="trim-handle end"></span>';
          this.zoomNodes.set(key, node);
          lane.append(node);
        }
        if (node.previousElementSibling !== previous)
          lane.insertBefore(
            node,
            previous ? previous.nextElementSibling : lane.firstElementChild,
          );
        previous = node;
        node.classList.toggle("selected", selected === zoom.id);
        node.setAttribute("aria-pressed", String(selected === zoom.id));
        const trigger = zoomTrigger(zoom);
        node.classList.toggle("automatic", Boolean(trigger));
        if (node.dataset.zoomTrigger !== (trigger ?? "manual")) {
          node.dataset.zoomTrigger = trigger ?? "manual";
          node.querySelector(".zoom-event-icon")!.innerHTML = trigger
            ? zoomAppearance[trigger].icon
            : "";
        }
        const label = `${trigger ? zoomAppearance[trigger].label + " zoom" : "Zoom"} ${i + 1}`;
        node.setAttribute("aria-label", label);
        node.title = `${label} · Drag to move, drag edges to resize`;
        style(node, "left", (range.start / total) * 100);
        style(node, "width", ((range.end - range.start) / total) * 100);
        text(
          node.querySelector(".zoom-label")!,
          `${trigger ? "" : "＋ "}${zoom.zoom}×`,
        );
        (node.querySelector('[data-zoom-trim="start"]') as HTMLElement).hidden =
          part !== 0;
        (node.querySelector('[data-zoom-trim="end"]') as HTMLElement).hidden =
          part !== ranges.length - 1;
      }
    }
    for (const [key, node] of this.zoomNodes)
      if (!retained.has(key)) {
        node.remove();
        this.zoomNodes.delete(key);
      }
    if (!retained.size && !lane.querySelector(".empty-track"))
      lane.innerHTML =
        '<span class="empty-track">Drag to add a zoom <button id="lane-add-zoom">＋</button></span>';
  }

  renderZoomSelector(edits: Edits, selected: string) {
    const root = document.querySelector<HTMLSelectElement>("#zoom-selector")!;
    const retained = new Set<string>();
    const placeholder = root.options[0];
    text(placeholder, edits.zooms?.length ? "Select zoom" : "No zooms");
    let previous: Element = placeholder;
    for (const [i, z] of (edits.zooms || []).entries()) {
      retained.add(z.id);
      let node = this.zoomOptions.get(z.id);
      if (!node) {
        node = document.createElement("option");
        node.value = z.id;
        this.zoomOptions.set(z.id, node);
      }
      if (
        node.previousElementSibling !== previous ||
        node.parentElement !== root
      )
        root.insertBefore(node, previous.nextElementSibling);
      previous = node;
      const trigger = zoomTrigger(z);
      text(
        node,
        `${trigger ? zoomAppearance[trigger].label + " zoom" : "Zoom"} ${i + 1} · ${clock(z.start)} – ${clock(z.end)}`,
      );
    }
    for (const [id, node] of this.zoomOptions)
      if (!retained.has(id)) {
        node.remove();
        this.zoomOptions.delete(id);
      }
    root.value = selected;
    root.disabled = !retained.size;
  }
}
