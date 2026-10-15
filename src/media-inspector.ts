import type { Edits, Project, Style } from "./types";
import { clock } from "./timeline";

export type MediaTrack = "screen" | "camera" | "microphone";
type Hooks = {
  state: () => {
    project: Project | null;
    edits: Edits | null;
    track: MediaTrack | null;
    layer: string;
    clip: number;
  };
  select: (track: MediaTrack) => void;
  style: <K extends keyof Style>(
    key: K,
    value: Style[K],
    remember?: boolean,
  ) => void;
  trim: (side: "start" | "end", value: number) => void;
  import: () => void;
  camera: () => void;
};
const $ = <T extends HTMLElement = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const range = (
  key: string,
  title: string,
  min: number,
  max: number,
  step = 1,
) =>
  `<label class="range-label" for="media-${key}">${title}<output id="media-${key}-value"></output></label><input id="media-${key}" type="range" min="${min}" max="${max}" step="${step}"/>`;
const speeds = [0.5, 0.75, 1, 1.25, 1.5, 2];

export class MediaInspector {
  private listKey = "";
  private selectionKey = "";
  constructor(
    private hooks: Hooks,
    private icon: (name: string, size?: number) => string,
  ) {
    $("#media-source-settings").innerHTML = `
      <div class="media-properties-heading"><span id="media-source-icon" class="media-icon"></span><div><h3 id="media-source-name" tabindex="-1"></h3><p id="media-source-info" class="hint"></p></div></div>
      <div id="media-screen-controls" class="property-group"><h3>Layout</h3><label class="field-caption" for="media-screenFit">Placement</label><select id="media-screenFit" class="wide-select"><option value="fit">Fit · show entire media</option><option value="fill">Fill · crop to canvas</option></select>${range("padding", "Canvas padding", 0, 20)}</div>
      <div id="media-camera-controls" class="property-group"><h3>Appearance</h3><label class="check-row"><input id="media-showCamera" type="checkbox"/>Show on canvas</label><label class="check-row"><input id="media-cameraFlip" type="checkbox"/>Flip horizontally</label>${range("cameraSize", "Size", 10, 50)}${range("cameraRoundness", "Roundness", 0, 100)}<label class="field-caption" for="media-cameraCorner">Position</label><select id="media-cameraCorner" class="wide-select"><option value="top-left">Top left</option><option value="top-right">Top right</option><option value="bottom-left">Bottom left</option><option value="bottom-right">Bottom right</option></select>${range("cameraMargin", "Margin", 0, 20, 0.5)}<label class="field-row" for="media-cameraOffset">Time offset<div class="unit-input"><input id="media-cameraOffset" type="number" min="-60" max="60" step="0.01"/><span>s</span></div></label></div>
      <div id="media-audio-controls" class="property-group"><h3>Screen audio</h3>${range("volume", "Volume", 0, 100)}</div>
      <div id="media-mic-controls" class="property-group"><h3>Microphone</h3>${range("microphoneVolume", "Volume", 0, 100)}</div>
      <div class="property-group"><h3>Timing <span id="media-clip-duration" class="section-value"></span></h3><div class="clip-fields"><label for="media-trim-start">Source in<input id="media-trim-start" type="number" min="0" step="0.1"/></label><label for="media-trim-end">Source out<input id="media-trim-end" type="number" min="0.05" step="0.1"/></label></div>
      <div class="field-row"><label for="media-speed">Playback speed</label><select id="media-speed">${speeds.map((n) => `<option value="${n}">${n}×</option>`).join("")}</select></div></div>`;
    for (const view of ["properties", "library"] as const) {
      const button = $("#media-" + view + "-tab");
      button.onclick = () => this.setView(view);
      button.onkeydown = (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
          return;
        event.preventDefault();
        const next =
          event.key === "Home"
            ? "properties"
            : event.key === "End"
              ? "library"
              : view === "properties"
                ? "library"
                : "properties";
        const target = $<HTMLButtonElement>("#media-" + next + "-tab");
        if (!target.disabled) {
          this.setView(next);
          target.focus();
        }
      };
    }
    $("#media-list").onclick = (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>(
        "[data-media-track]",
      );
      if (button) {
        hooks.select(button.dataset.mediaTrack as MediaTrack);
        $("#media-source-name").focus({ preventScroll: true });
      }
    };
    $("#media-start").onclick = hooks.import;
    $("#attach-camera").onclick = hooks.camera;
    for (const field of [
      "padding",
      "volume",
      "microphoneVolume",
      "cameraSize",
      "cameraMargin",
      "cameraRoundness",
    ] as const) {
      const input = $<HTMLInputElement>(`#media-${field}`);
      let gesture = false;
      input.oninput = () => {
        const first = !gesture;
        gesture = true;
        hooks.style(field, Number(input.value) / 100, first);
      };
      input.onchange = input.onblur = () => {
        gesture = false;
      };
    }
    $("#media-screenFit").onchange = () =>
      hooks.style(
        "screenFit",
        $<HTMLSelectElement>("#media-screenFit").value as Style["screenFit"],
      );
    $("#media-cameraCorner").onchange = () =>
      hooks.style(
        "cameraCorner",
        $<HTMLSelectElement>("#media-cameraCorner").value,
      );
    $("#media-speed").onchange = () =>
      hooks.style("speed", Number($<HTMLSelectElement>("#media-speed").value));
    for (const field of ["cameraFlip", "showCamera"] as const)
      $("#media-" + field).onchange = () =>
        hooks.style(field, $<HTMLInputElement>("#media-" + field).checked);
    $("#media-cameraOffset").onchange = () => {
      const input = $<HTMLInputElement>("#media-cameraOffset");
      if (input.reportValidity())
        hooks.style("cameraOffset", Number(input.value));
    };
    for (const side of ["start", "end"] as const) {
      const input = $<HTMLInputElement>(`#media-trim-${side}`);
      input.onchange = () => hooks.trim(side, Number(input.value));
      input.onblur = () => this.update();
    }
  }
  private setView(view: "properties" | "library") {
    for (const name of ["properties", "library"] as const) {
      const active = name === view,
        button = $("#media-" + name + "-tab");
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
      $("#media-" + name + "-view").hidden = !active;
    }
    $("#settings").scrollTop = 0;
  }
  showProperties() {
    const { project, track, layer } = this.hooks.state();
    if (project && (track || layer)) this.setView("properties");
  }
  update() {
    const { project, edits, track: selected, layer, clip } = this.hooks.state();
    const hasSelection = !!project && (!!selected || !!layer);
    $<HTMLButtonElement>("#media-properties-tab").disabled = !hasSelection;
    const selectionKey = JSON.stringify([project?.id, selected, layer]);
    if (selectionKey !== this.selectionKey) {
      this.selectionKey = selectionKey;
      this.setView(hasSelection ? "properties" : "library");
    }
    $("#media-count").textContent = String(
      Object.keys(project?.tracks || {}).length + (edits?.layers?.length || 0),
    );
    $("#media-sources").hidden = !project;
    $("#media-empty").hidden = !!project;
    $("#media-additions").hidden = !project;
    const camera = $<HTMLButtonElement>("#attach-camera");
    camera.hidden = !!project?.tracks.camera;
    const key = JSON.stringify([project?.id, project?.tracks, selected]);
    if (key !== this.listKey) {
      this.listKey = key;
      $("#media-list").innerHTML = project
        ? Object.entries(project.tracks)
            .map(([k, t]) => {
              const title =
                t.name ||
                (k === "screen"
                  ? "Screen recording"
                  : k === "camera"
                    ? "Webcam recording"
                    : "Microphone recording");
              const kind =
                k === "camera"
                  ? "Webcam"
                  : k === "microphone"
                    ? "Audio"
                    : t.sourceKind === "image"
                      ? "Image"
                      : t.sourceKind === "video"
                        ? "Video"
                        : "Screen";
              return `<button class="media-item ${selected === k ? "active" : ""}" data-media-track="${k}" aria-pressed="${selected === k}" title="${escape(title)}"><span class="media-icon ${k}">${this.icon(k === "microphone" ? "mic" : t.sourceKind === "image" ? "image" : k, 18)}</span><span class="media-item-copy"><strong>${escape(title)}</strong><small>${kind} · ${clock(t.duration)}</small></span><span class="media-selected-mark" aria-hidden="true">${selected === k ? this.icon("check", 14) : ""}</span></button>`;
            })
            .join("")
        : "";
    }
    const track = selected && project?.tracks[selected];
    $("#media-source-settings").hidden = !track || !edits;
    if (!track || !edits) return;
    $("#media-source-name").textContent =
      track.name ||
      (selected === "screen"
        ? "Screen recording"
        : selected === "camera"
          ? "Webcam"
          : "Microphone");
    const sourceIcon = $("#media-source-icon");
    sourceIcon.className = "media-icon " + selected;
    sourceIcon.innerHTML = this.icon(
      selected === "microphone"
        ? "mic"
        : track.sourceKind === "image"
          ? "image"
          : selected!,
      18,
    );
    $("#media-source-name").title = $("#media-source-name").textContent!;
    $("#media-source-info").textContent =
      `${track.width ? `${track.width} × ${track.height} · ` : ""}${clock(track.duration)} source`;
    $("#media-screen-controls").hidden = selected !== "screen";
    $("#media-camera-controls").hidden = selected !== "camera";
    $("#media-audio-controls").hidden = selected !== "screen" || !track.audio;
    $("#media-mic-controls").hidden = selected !== "microphone";
    const style = edits.style;
    for (const field of [
      "padding",
      "volume",
      "microphoneVolume",
      "cameraSize",
      "cameraMargin",
      "cameraRoundness",
    ] as const) {
      const input = $<HTMLInputElement>("#media-" + field),
        value = Math.round(style[field] * 1000) / 10;
      if (document.activeElement !== input) input.value = String(value);
      input.style.setProperty(
        "--fill",
        `${((value - Number(input.min)) / (Number(input.max) - Number(input.min))) * 100}%`,
      );
      $("#media-" + field + "-value").textContent = value + "%";
    }
    for (const field of [
      "screenFit",
      "cameraCorner",
      "speed",
      "cameraOffset",
    ] as const) {
      const input = $<HTMLInputElement>("#media-" + field);
      if (document.activeElement !== input) input.value = String(style[field]);
    }
    for (const field of ["cameraFlip", "showCamera"] as const)
      $<HTMLInputElement>("#media-" + field).checked = style[field];
    const segment = edits.segments[Math.min(clip, edits.segments.length - 1)];
    for (const side of ["start", "end"] as const) {
      const input = $<HTMLInputElement>(`#media-trim-${side}`);
      if (document.activeElement !== input)
        input.value = String(Number(segment[side].toFixed(3)));
      input.max = String(project!.duration);
    }
    $("#media-clip-duration").textContent = clock(
      (segment.end - segment.start) / style.speed,
    );
  }
}
