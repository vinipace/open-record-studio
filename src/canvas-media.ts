import {
  layerDuration,
  layerSample,
  layerSpans,
} from "../desktop/webcam-take.mjs";
import type { CanvasLayer, Edits, Project } from "./types";
import { layerRect } from "../desktop/canvas-media.mjs";
import { sourceRanges } from "../desktop/motion.mjs";
import { duration, sourceTime } from "./timeline";
import { LayerVideo } from "./layer-video";
import { LayerTimeline } from "./layer-timeline";
import type { TimelineViewport } from "./timeline-viewport";

type State = {
  project: Project | null;
  edits: Edits | null;
  source: number;
  combined: boolean;
  picking: boolean;
  playing: boolean;
  enhancedAudio: boolean;
};
type Hooks = {
  state: () => State;
  history: () => void;
  changed: () => void;
  redraw: () => void;
  pause: () => void;
  seek: (t: number) => void;
  select: () => void;
  error: (message: string) => void;
};
const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const $ = <T extends HTMLElement = HTMLElement>(s: string) =>
  document.querySelector<T>(s)!;
type Decoder = {
  element: HTMLVideoElement | HTMLImageElement;
  active: boolean;
  playback?: LayerVideo;
};

export class CanvasMedia {
  selected = "";
  selectedPart: "video" | "audio" = "video";
  private projectId = "";
  private decoders = new Map<string, Decoder>();
  private listKey = "";
  private timeline: LayerTimeline;
  private importing = false;
  private suppressClick = false;
  private cancelDrag: (() => void) | null = null;
  private outline = document.createElement("div");
  constructor(
    private canvas: HTMLCanvasElement,
    private hooks: Hooks,
    private icon: (name: string, size?: number) => string,
  ) {
    this.timeline = new LayerTimeline($("#layer-tracks"), icon);
    $("#canvas-layers").innerHTML =
      `<div class="media-layers-heading"><h3 class="library-group-title">Canvas overlays <span id="layer-count" class="section-value">0 / 16</span></h3></div><div id="layer-list" class="layer-list"></div>`;
    $("#layer-settings").innerHTML =
      `<div class="media-properties-heading"><span id="layer-source-icon" class="media-icon"></span><div><h3 id="layer-name" tabindex="-1">Selected layer</h3><p id="layer-info" class="hint"></p></div><button id="remove-layer" class="text-reset" title="Remove selected overlay">Remove</button></div><div id="layer-layout" class="property-group"><h3>Layout</h3><div class="layer-order"><button id="layer-back" title="Move layer backward">↓ Backward</button><button id="layer-front" title="Move layer forward">↑ Forward</button></div><label class="range-label">Visible on canvas<input id="layer-visible" type="checkbox" aria-label="Layer visibility"/></label><div class="clip-fields"><label>Horizontal %<input id="layer-x" type="number" min="0" max="100" step="1"/></label><label>Vertical %<input id="layer-y" type="number" min="0" max="100" step="1"/></label></div><label class="range-label" for="layer-width">Size <output id="layer-width-value"></output></label><input id="layer-width" type="range" min="3" max="200" step="1"/><label class="range-label" for="layer-opacity">Opacity <output id="layer-opacity-value"></output></label><input id="layer-opacity" type="range" min="0" max="100" step="1"/></div><div id="layer-take-controls" class="property-group" hidden><div id="layer-take-appearance"><label class="check-row"><input id="layer-flip" type="checkbox"/>Flip horizontally</label><label class="range-label" for="layer-roundness">Roundness <output id="layer-roundness-value"></output></label><input id="layer-roundness" type="range" min="0" max="100" step="1"/></div><label class="range-label" for="layer-volume">Microphone <output id="layer-volume-value"></output></label><input id="layer-volume" type="range" min="0" max="100" step="1"/></div><div class="property-group"><h3>Timing</h3><div class="clip-fields"><label>Source in<input id="layer-start" type="number" min="0" step="0.1"/></label><label>Source out<input id="layer-end" type="number" min="0.05" step="0.1"/></label></div><div id="layer-video-fields"><label class="field-row">Video start<div class="unit-input"><input id="layer-mediaStart" type="number" min="0" step="0.1"/><span>s</span></div></label></div></div>`;
    this.outline.className = "canvas-layer-outline";
    this.outline.innerHTML = "<i></i>";
    this.outline.hidden = true;
    canvas.parentElement!.append(this.outline);
    new ResizeObserver(() => this.paintSelection()).observe(canvas);
    $("#add-media").onclick = $("#add-layer").onclick = () => void this.add();
    $("#remove-layer").onclick = () => this.remove();
    $("#layer-back").onclick = () => this.reorder(-1);
    $("#layer-front").onclick = () => this.reorder(1);
    $("#layer-visible").onchange = () =>
      this.edit((layer) => {
        layer.visible = $<HTMLInputElement>("#layer-visible").checked;
      });
    for (const field of ["x", "y", "start", "end", "mediaStart"] as const) {
      $<HTMLInputElement>(`#layer-${field}`).onblur = () => this.update();
      $<HTMLInputElement>(`#layer-${field}`).onchange = () => {
        const value = Number($<HTMLInputElement>(`#layer-${field}`).value);
        if (!Number.isFinite(value)) return this.update();
        this.edit((layer) => {
          const state = this.hooks.state(),
            asset = state.project!.assets![layer.assetId];
          if (field === "x" || field === "y")
            layer[field] = clamp(value / 100, 0, 1);
          else if (field === "start") {
            layer.start = clamp(value, 0, state.project!.duration - 0.05);
            layer.end = clamp(
              layer.end,
              layer.start + 0.05,
              Math.min(
                state.project!.duration,
                layer.start +
                  (asset.sourceKind === "image"
                    ? state.project!.duration
                    : layerDuration(asset) - layer.mediaStart),
              ),
            );
          } else if (field === "end")
            layer.end = clamp(
              value,
              layer.start + 0.05,
              Math.min(
                state.project!.duration,
                layer.start +
                  (asset.sourceKind === "image"
                    ? state.project!.duration
                    : layerDuration(asset) - layer.mediaStart),
              ),
            );
          else
            layer.mediaStart = clamp(
              value,
              0,
              layerDuration(asset) - (layer.end - layer.start),
            );
        });
      };
    }
    $("#layer-flip").onchange = () =>
      this.edit((layer) => {
        layer.flip = $<HTMLInputElement>("#layer-flip").checked;
      });
    for (const field of ["width", "opacity", "roundness", "volume"] as const) {
      const input = $<HTMLInputElement>(`#layer-${field}`);
      let gesture = false;
      input.oninput = () => {
        const layer = this.layer();
        if (!layer) return;
        if (!gesture) {
          this.hooks.pause();
          this.hooks.history();
          gesture = true;
        }
        layer[field] = Number(input.value) / 100;
        this.hooks.changed();
      };
      input.onchange = input.onblur = () => {
        gesture = false;
      };
    }
    $("#layer-list").onclick = (e) => {
      const button = (e.target as Element).closest<HTMLElement>("[data-layer]");
      if (button) {
        this.select(button.dataset.layer!, true);
        $("#layer-name").focus({ preventScroll: true });
      }
    };
    $("#layer-tracks").addEventListener("pointerdown", (e) =>
      this.timelineDrag(e),
    );
    $("#layer-tracks").addEventListener("click", (e) => {
      if (this.suppressClick) return;
      const button = (e.target as Element).closest<HTMLElement>("[data-layer]");
      if (button)
        this.select(
          button.dataset.layer!,
          true,
          button.dataset.layerPart === "audio" ? "audio" : "video",
        );
    });
    canvas.addEventListener("pointerdown", (e) => this.canvasDrag(e), true);
    canvas.addEventListener(
      "click",
      (e) => {
        if (this.suppressClick) {
          e.stopImmediatePropagation();
          e.preventDefault();
        }
      },
      true,
    );
  }
  private layer() {
    return this.hooks
      .state()
      .edits?.layers?.find((l) => l.id === this.selected);
  }
  clearSelection() {
    this.selected = "";
    this.selectedPart = "video";
    this.update();
  }
  select(id: string, seek = false, part: "video" | "audio" = "video") {
    this.selected = id;
    this.selectedPart = part;
    this.hooks.select();
    const { edits, source } = this.hooks.state(),
      layer = this.layer();
    if (seek && layer && (source < layer.start || source >= layer.end)) {
      const range = sourceRanges(edits!, layer.start, layer.end)[0];
      if (range) this.hooks.seek(range.start);
    }
    this.update();
    this.hooks.redraw();
  }
  private edit(fn: (layer: CanvasLayer) => void) {
    const layer = this.layer();
    if (!layer) return;
    this.hooks.pause();
    this.hooks.history();
    fn(layer);
    this.hooks.changed();
  }
  remove() {
    if (!this.layer()) return false;
    if (this.selectedPart === "audio") {
      this.edit((layer) => {
        layer.volume = 0;
      });
      return true;
    }
    this.hooks.pause();
    this.hooks.history();
    const edits = this.hooks.state().edits!;
    edits.layers = edits.layers!.filter((l) => l.id !== this.selected);
    this.selected = "";
    this.hooks.changed();
    return true;
  }
  private reorder(delta: number) {
    const layers = this.hooks.state().edits?.layers;
    const index = layers?.findIndex((l) => l.id === this.selected) ?? -1;
    if (
      !layers ||
      index < 0 ||
      index + delta < 0 ||
      index + delta >= layers.length
    )
      return;
    this.hooks.history();
    [layers[index], layers[index + delta]] = [
      layers[index + delta],
      layers[index],
    ];
    this.hooks.changed();
  }
  private async add() {
    const { project, edits, source } = this.hooks.state();
    if (!project || !edits || this.importing) return;
    const remaining = 16 - (edits.layers?.length || 0);
    if (!remaining) return this.hooks.error("Keep at most 16 canvas layers");
    this.hooks.pause();
    this.importing = true;
    this.update();
    try {
      const assets = await window.studio.addMedia(project.id, remaining);
      if (!assets || this.hooks.state().project !== project) return;
      // Use the current edit object: undo can replace it while the dialog is open.
      const current = this.hooks.state().edits!;
      this.hooks.history();
      project.assets = { ...project.assets, ...assets };
      current.layers ??= [];
      const last = current.segments.at(-1)!;
      const start = clamp(
        source >= last.end - 0.001 ? last.start : source,
        0,
        project.duration - 0.05,
      );
      for (const [assetId, asset] of Object.entries(assets)) {
        const id = crypto.randomUUID();
        current.layers.push({
          id,
          assetId,
          start,
          end:
            asset.sourceKind === "image"
              ? project.duration
              : Math.min(project.duration, start + asset.duration),
          mediaStart: 0,
          x: 0.5,
          y: 0.5,
          width: Math.max(
            0.03,
            Math.min(
              0.4,
              (0.4 * (asset.width / asset.height)) /
                (this.canvas.width / this.canvas.height),
            ),
          ),
          opacity: 1,
          visible: true,
        });
        this.selected = id;
      }
      this.select(this.selected, true);
      this.hooks.changed();
    } catch (error) {
      this.hooks.error((error as Error).message);
    } finally {
      this.importing = false;
      this.update();
    }
  }
  update() {
    const { project, edits } = this.hooks.state();
    if (this.projectId !== project?.id) {
      this.cancelDrag?.();
      this.dispose();
      this.projectId = project?.id || "";
      this.selected = "";
    }
    const layers = edits?.layers || [];
    for (const [id, decoder] of this.decoders)
      if (!layers.some((l) => l.id === id)) {
        this.release(decoder);
        this.decoders.delete(id);
      }
    if (!layers.some((l) => l.id === this.selected)) this.selected = "";
    for (const layer of layers) {
      if (this.decoders.has(layer.id)) continue;
      const asset = project!.assets![layer.assetId];
      const element =
        asset.sourceKind === "image"
          ? new Image()
          : document.createElement("video");
      const decoder: Decoder = { element, active: false };
      element.crossOrigin = "anonymous";
      if (element instanceof HTMLVideoElement) {
        element.muted = true;
        element.preload = "metadata";
        element.playsInline = true;
        decoder.playback = new LayerVideo(element, this.hooks.redraw);
        element.onloadedmetadata = () => {
          this.sync(true);
          this.hooks.redraw();
        };
      } else element.onload = () => this.hooks.redraw();
      element.onerror = () => this.hooks.error(`Could not load ${asset.name}`);
      this.decoders.set(layer.id, decoder);
      element.src = asset.url;
    }
    for (const id of ["add-media", "add-layer"]) {
      const button = $<HTMLButtonElement>("#" + id);
      button.disabled = !project || this.importing || layers.length >= 16;
      button.textContent = this.importing
        ? "Adding media…"
        : id === "add-media"
          ? "＋ Add media"
          : "＋ Add";
    }
    $("#canvas-layers").hidden = !project;
    $("#layer-count").textContent = `${layers.length} / 16`;
    const key = JSON.stringify([
      layers.map((l) => [l.id, l.visible]),
      this.selected,
      project?.id,
    ]);
    if (key !== this.listKey) {
      this.listKey = key;
      $("#layer-list").innerHTML = layers.length
        ? [...layers]
            .reverse()
            .map((l) => {
              const asset = project!.assets![l.assetId];
              return `<button data-layer="${l.id}" aria-pressed="${l.id === this.selected}" class="layer-item ${l.id === this.selected ? "active" : ""}"><span class="layer-kind">${this.icon(asset.timeMap ? "camera" : asset.sourceKind === "image" ? "image" : "screen", 17)}</span><span>${escape(asset.name)}<small>${l.visible ? (asset.timeMap ? "Webcam take" : asset.sourceKind === "image" ? "Image" : "Video · muted") : "Hidden"}</small></span></button>`;
            })
            .join("")
        : '<p class="layer-empty">No overlays</p>';
    }
    const layer = this.layer();
    $("#layer-settings").hidden = !layer;
    if (layer) {
      const asset = project!.assets![layer.assetId];
      const audioSelected = this.selectedPart === "audio";
      $("#layer-layout").hidden = audioSelected;
      $("#layer-take-appearance").hidden = audioSelected;
      $("#remove-layer").textContent = audioSelected ? "Mute" : "Remove";
      $("#remove-layer").title = audioSelected
        ? "Mute this take's microphone"
        : "Remove selected overlay";
      $("#layer-source-icon").innerHTML = this.icon(
        audioSelected
          ? "mic"
          : asset.timeMap
            ? "camera"
            : asset.sourceKind === "image"
              ? "image"
              : "screen",
        18,
      );
      $("#layer-name").textContent =
        asset.name + (audioSelected ? " audio" : "");
      $("#layer-name").title = asset.name;
      $("#layer-info").textContent = audioSelected
        ? "Microphone · timing linked to webcam take"
        : `${asset.timeMap ? "Webcam take" : asset.sourceKind === "image" ? "Image" : "Video · muted"} · ${asset.width} × ${asset.height}`;
      $("#layer-take-controls").hidden = !asset.timeMap;
      for (const [field, value] of [
        ["roundness", layer.roundness ?? 0],
        ["volume", layer.volume ?? 1],
      ] as const) {
        $<HTMLInputElement>("#layer-" + field).value = String(value * 100);
        $("#layer-" + field + "-value").textContent =
          `${Math.round(value * 100)}%`;
        $("#layer-" + field).style.setProperty("--fill", `${value * 100}%`);
      }
      $<HTMLInputElement>("#layer-flip").checked = !!layer.flip;
      $<HTMLInputElement>("#layer-volume").disabled = !asset.audio;
      for (const field of [
        "x",
        "y",
        "width",
        "opacity",
        "start",
        "end",
        "mediaStart",
      ] as const) {
        const input = $<HTMLInputElement>(`#layer-${field}`);
        if (document.activeElement !== input)
          input.value = String(
            Math.round(
              layer[field] *
                (["x", "y", "width", "opacity"].includes(field) ? 10000 : 1000),
            ) / (["x", "y", "width", "opacity"].includes(field) ? 100 : 1000),
          );
      }
      $("#layer-width-value").textContent = `${Math.round(layer.width * 100)}%`;
      $("#layer-opacity-value").textContent =
        `${Math.round(layer.opacity * 100)}%`;
      $<HTMLInputElement>("#layer-visible").checked = layer.visible;
      $("#layer-video-fields").hidden = asset.sourceKind === "image";
      $<HTMLButtonElement>("#layer-back").disabled = layers[0] === layer;
      $<HTMLButtonElement>("#layer-front").disabled = layers.at(-1) === layer;
    }
    this.renderTimeline();
    this.sync();
    this.paintSelection();
  }
  renderTimeline(viewport?: TimelineViewport) {
    const { project, edits } = this.hooks.state();
    this.timeline.render(
      project,
      edits,
      this.selected,
      this.selectedPart,
      viewport,
    );
  }

  sync(
    force = false,
    nextCut: { source: number; remaining: number } | null = null,
  ) {
    const { project, edits, source, combined, playing, enhancedAudio } =
      this.hooks.state();
    if (!project || !edits) return;
    for (const layer of edits.layers || []) {
      const decoder = this.decoders.get(layer.id);
      if (!decoder || !(decoder.element instanceof HTMLVideoElement)) continue;
      const v = decoder.element,
        asset = project.assets![layer.assetId];
      const sample = layerSample(layer, asset, source);
      const active =
        combined &&
        !!sample &&
        layer.visible &&
        layer.opacity > 0 &&
        source >= layer.start &&
        source < layer.end;
      const entered = active && !decoder.active;
      decoder.active = active;
      if (!active) {
        if (!v.paused) v.pause();
        const incoming =
          nextCut && combined && layer.visible && layer.opacity > 0
            ? layerSample(layer, asset, nextCut.source)
            : null;
        if (incoming && nextCut) {
          decoder.playback!.prepare(
            incoming.time,
            nextCut.remaining,
            edits.style.speed * incoming.rate,
          );
          continue;
        }
        decoder.playback!.pause();
        // Warm the next visible layer without running another playback clock.
        if (
          combined &&
          layer.visible &&
          source < layer.start &&
          layer.start - source < 0.75 * edits.style.speed
        ) {
          v.preload = "auto";
          const initialTime = layerSpans(layer, asset)[0]?.mediaStart ?? 0;
          decoder.playback!.sync(initialTime, edits.style.speed, false);
        }
        continue;
      }
      if (v.preload !== "auto") v.preload = "auto";
      const time = clamp(sample!.time, 0, asset.duration - 0.001);
      const volume = asset.timeMap ? (layer.volume ?? 1) : 0;
      decoder.playback!.setVolume(enhancedAudio ? 0 : volume);
      decoder.playback!.sync(
        time,
        edits.style.speed * sample!.rate,
        playing,
        force || entered,
      );
      decoder.element = decoder.playback!.element;
      if (playing && nextCut) {
        const incoming = layerSample(layer, asset, nextCut.source);
        if (incoming)
          decoder.playback!.prepare(
            incoming.time,
            nextCut.remaining,
            edits.style.speed * incoming.rate,
          );
      }
    }
  }
  pause() {
    for (const d of this.decoders.values()) d.playback?.pause();
  }
  draw(ctx: CanvasRenderingContext2D, source: number) {
    const { project, edits } = this.hooks.state();
    for (const layer of edits?.layers || []) {
      if (
        !layer.visible ||
        source < layer.start ||
        source >= layer.end ||
        layer.opacity <= 0 ||
        !layerSample(layer, project!.assets![layer.assetId], source)
      )
        continue;
      const decoder = this.decoders.get(layer.id);
      const element = decoder?.playback
        ? decoder.playback.image()
        : (decoder?.element as HTMLImageElement | undefined);
      if (
        !element ||
        (element instanceof HTMLImageElement &&
          (!element.complete || !element.naturalWidth))
      )
        continue;
      const r = layerRect(
        layer,
        project!.assets![layer.assetId],
        this.canvas.width,
        this.canvas.height,
      );
      ctx.save();
      ctx.globalAlpha = layer.opacity;
      if (layer.roundness !== undefined) {
        ctx.beginPath();
        ctx.roundRect(
          r.x,
          r.y,
          r.width,
          r.height,
          (r.width * layer.roundness) / 2,
        );
        ctx.clip();
      }
      if (layer.flip) {
        ctx.translate(r.x * 2 + r.width, 0);
        ctx.scale(-1, 1);
      }
      if (layer.roundness !== undefined) {
        const width =
            element instanceof HTMLImageElement
              ? element.naturalWidth
              : element.width,
          height =
            element instanceof HTMLImageElement
              ? element.naturalHeight
              : element.height,
          side = Math.min(width, height);
        ctx.drawImage(
          element,
          (width - side) / 2,
          (height - side) / 2,
          side,
          side,
          r.x,
          r.y,
          r.width,
          r.height,
        );
      } else ctx.drawImage(element, r.x, r.y, r.width, r.height);
      ctx.restore();
    }
    this.paintSelection();
  }
  paintSelection() {
    const state = this.hooks.state(),
      layer = this.layer();
    this.outline.hidden =
      this.selectedPart === "audio" ||
      !layer ||
      !state.combined ||
      state.picking ||
      state.playing ||
      !layer.visible ||
      state.source < layer.start ||
      state.source >= layer.end ||
      !layerSample(layer, state.project!.assets![layer.assetId], state.source);
    if (this.outline.hidden || !layer) return;
    const r = layerRect(
      layer,
      state.project!.assets![layer.assetId],
      this.canvas.width,
      this.canvas.height,
    );
    const box = this.canvas.getBoundingClientRect(),
      parent = this.canvas.parentElement!.getBoundingClientRect();
    Object.assign(this.outline.style, {
      left: `${box.left - parent.left + (r.x * box.width) / this.canvas.width}px`,
      top: `${box.top - parent.top + (r.y * box.height) / this.canvas.height}px`,
      width: `${(r.width * box.width) / this.canvas.width}px`,
      height: `${(r.height * box.height) / this.canvas.height}px`,
    });
  }
  private gesture(
    e: PointerEvent,
    layer: CanvasLayer,
    apply: (event: PointerEvent, initial: CanvasLayer) => void,
  ) {
    e.preventDefault();
    e.stopPropagation();
    this.hooks.pause();
    const initial = { ...layer };
    let moved = false,
      pending: PointerEvent | null = null,
      frame = 0;
    const paint = () => {
      frame = 0;
      if (!pending) return;
      if (!moved) {
        this.hooks.history();
        moved = true;
      }
      apply(pending, initial);
      pending = null;
      this.hooks.changed();
    };
    const move = (event: PointerEvent) => {
      if (
        !moved &&
        Math.hypot(event.clientX - e.clientX, event.clientY - e.clientY) < 3
      )
        return;
      pending = event;
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const finish = (cancel = false) => {
      cancelAnimationFrame(frame);
      if (cancel) {
        Object.assign(layer, initial);
        pending = null;
      } else paint();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", canceled);
      window.removeEventListener("keydown", key);
      this.cancelDrag = null;
      this.suppressClick = true;
      setTimeout(() => {
        this.suppressClick = false;
      }, 0);
      if (moved) this.hooks.changed();
    };
    const up = () => finish(),
      canceled = () => finish(true);
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        finish(true);
      }
    };
    this.cancelDrag = canceled;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", canceled);
    window.addEventListener("keydown", key);
  }
  private canvasDrag(e: PointerEvent) {
    const state = this.hooks.state();
    if (
      e.button !== 0 ||
      !state.project ||
      !state.edits ||
      !state.combined ||
      state.picking
    )
      return;
    const box = this.canvas.getBoundingClientRect(),
      x = (e.clientX - box.left) / box.width,
      y = (e.clientY - box.top) / box.height;
    let resize = false,
      layer = this.layer();
    if (
      layer &&
      layer.visible &&
      state.source >= layer.start &&
      state.source < layer.end &&
      layerSample(layer, state.project.assets![layer.assetId], state.source)
    ) {
      const r = layerRect(
        layer,
        state.project.assets![layer.assetId],
        this.canvas.width,
        this.canvas.height,
      );
      resize =
        Math.hypot(
          (x - (r.x + r.width) / this.canvas.width) * box.width,
          (y - (r.y + r.height) / this.canvas.height) * box.height,
        ) < 15;
    }
    if (!resize)
      layer = [...(state.edits.layers || [])].reverse().find((l) => {
        if (
          !l.visible ||
          !layerSample(l, state.project!.assets![l.assetId], state.source)
        )
          return false;
        const r = layerRect(
          l,
          state.project!.assets![l.assetId],
          this.canvas.width,
          this.canvas.height,
        );
        return (
          x * this.canvas.width >= r.x &&
          x * this.canvas.width <= r.x + r.width &&
          y * this.canvas.height >= r.y &&
          y * this.canvas.height <= r.y + r.height
        );
      });
    if (!layer) {
      if (this.selected) {
        this.clearSelection();
      }
      return;
    }
    this.select(layer.id);
    this.gesture(e, layer, (event, initial) => {
      if (resize)
        layer!.width = clamp(
          initial.width + (2 * (event.clientX - e.clientX)) / box.width,
          0.03,
          2,
        );
      else {
        layer!.x = clamp(
          initial.x + (event.clientX - e.clientX) / box.width,
          0,
          1,
        );
        layer!.y = clamp(
          initial.y + (event.clientY - e.clientY) / box.height,
          0,
          1,
        );
      }
    });
  }
  private timelineDrag(e: PointerEvent) {
    if (e.button !== 0) return;
    const target = (e.target as Element).closest<HTMLElement>("[data-layer]");
    if (!target) return;
    const state = this.hooks.state(),
      layer = state.edits!.layers!.find((l) => l.id === target.dataset.layer)!;
    const box = target.parentElement!.getBoundingClientRect(),
      total = duration(state.edits!);
    const trim = (e.target as HTMLElement).dataset.layerTrim;
    this.select(
      layer.id,
      true,
      target.dataset.layerPart === "audio" ? "audio" : "video",
    );
    const initialSource = sourceTime(
      state.edits!,
      clamp(((e.clientX - box.left) / box.width) * total, 0, total),
    );
    this.gesture(e, layer, (event, initial) => {
      const source = sourceTime(
        state.edits!,
        clamp(((event.clientX - box.left) / box.width) * total, 0, total),
      );
      const delta = source - initialSource,
        asset = state.project!.assets![layer.assetId];
      if (trim === "start") {
        const start = clamp(
          initial.start + delta,
          asset.sourceKind === "image"
            ? 0
            : Math.max(0, initial.start - initial.mediaStart),
          initial.end - 0.05,
        );
        layer.start = start;
        layer.mediaStart =
          asset.sourceKind === "image"
            ? 0
            : initial.mediaStart + start - initial.start;
      } else if (trim === "end")
        layer.end = clamp(
          initial.end + delta,
          initial.start + 0.05,
          Math.min(
            state.project!.duration,
            initial.start +
              (asset.sourceKind === "image"
                ? state.project!.duration
                : layerDuration(asset) - initial.mediaStart),
          ),
        );
      else {
        layer.start = clamp(
          initial.start + delta,
          0,
          state.project!.duration - (initial.end - initial.start),
        );
        layer.end = layer.start + initial.end - initial.start;
      }
    });
  }
  private release(decoder: Decoder) {
    decoder.playback?.dispose();
    const el = decoder.element;
    el.onerror = null;
    if (el instanceof HTMLVideoElement) {
      el.pause();
      el.onloadedmetadata = el.onloadeddata = el.onseeked = null;
      el.removeAttribute("src");
      el.load();
    } else {
      el.onload = null;
      el.removeAttribute("src");
    }
  }
  private dispose() {
    for (const d of this.decoders.values()) this.release(d);
    this.decoders.clear();
    this.listKey = "";
  }
}
