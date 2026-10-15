// A same-origin sub-window shares the existing camera stream. Closing the view
// never stops the track used by MediaRecorder or opens a second camera session.
import type { PreviewResize } from "./types";

export function createRecordingPreview(
  stream: MediaStream,
  stop: () => void,
  hide: () => void,
  resize: (gesture: PreviewResize) => Promise<void>,
  recording = true,
) {
  const preview = window.open("about:blank", "frame-recording-preview");
  if (!preview)
    throw new Error("The webcam preview could not open. Please retry.");
  preview.document.title = "Open Record Studio — Webcam preview";
  preview.document.head.insertAdjacentHTML(
    "beforeend",
    `<style>
    [hidden]{display:none!important}*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}
    body{background:transparent;color:white;font:12px -apple-system,BlinkMacSystemFont,sans-serif;user-select:none}
    .camera{position:relative;width:100%;height:100%;border-radius:28%;overflow:hidden;background:#09090b;-webkit-app-region:drag}
    @supports (corner-shape:squircle){.camera{border-radius:50%;corner-shape:squircle}}
    video{display:block;width:100%;height:100%;object-fit:cover;transform:scaleX(-1);pointer-events:none}
    .controls{position:absolute;left:0;right:0;display:flex;align-items:center;opacity:0;pointer-events:none;transition:opacity 160ms ease}
    .camera:hover .controls,.camera.keyboard-controls:has(button:focus-visible) .controls,body.resizing .controls{opacity:1;pointer-events:auto}
    header{top:0;gap:7px;padding:max(28px,11.3%) max(32px,13%);background:linear-gradient(#0008,transparent)}
    .dot{width:6px;height:6px;background:#ff6b7e;border-radius:50%;box-shadow:0 0 0 3px #ff6b7e20}
    #preview-clock{font-variant-numeric:tabular-nums;font-size:12px;font-weight:500;letter-spacing:.4px;text-shadow:0 1px 4px #0008}
    button{-webkit-app-region:no-drag;font:inherit;color:inherit;border:1px solid #ffffff28;outline:none;cursor:pointer;background:#09090bcc;backdrop-filter:blur(12px)}
    .circle-control{display:grid;place-items:center;flex-shrink:0;width:28px;height:28px;padding:0;border-radius:50%}
    #flip-preview{margin-left:auto}#flip-preview[aria-pressed=true]{background:#3a4bf8}
    .circle-control:hover{background:#27272ad9}
    footer{bottom:0;justify-content:center;padding:32px max(32px,13%) max(32px,13%);background:linear-gradient(transparent,#0008)}
    #stop-preview{display:flex;align-items:center;gap:8px;padding:9px 13px;border-radius:20px;font-size:12px;font-weight:500;white-space:nowrap}
    #stop-preview:hover{background:#682533d9}#stop-preview:disabled{opacity:.65;cursor:default}
    .square{background:#ff6b7e;width:9px;height:9px;border-radius:2px}
    .keyboard-controls button:focus-visible{outline:2px solid white;outline-offset:2px}
    .resize-corner{position:absolute;width:13%;height:13%;z-index:2;-webkit-app-region:no-drag;touch-action:none;opacity:0;transition:opacity 160ms ease}
    .resize-corner svg{width:100%;height:100%;pointer-events:none;filter:drop-shadow(0 1px 2px #0008)}
    [data-resize=nw]{top:0;left:0;cursor:nwse-resize}
    [data-resize=ne]{top:0;right:0;cursor:nesw-resize;transform:rotate(90deg)}
    [data-resize=se]{bottom:0;right:0;cursor:nwse-resize;transform:rotate(180deg)}
    [data-resize=sw]{bottom:0;left:0;cursor:nesw-resize;transform:rotate(270deg)}
    .camera:hover .resize-corner,body.resizing .resize-corner{opacity:.85}
    body.resizing .camera{-webkit-app-region:no-drag}
    @media(prefers-reduced-motion:reduce){.controls,.resize-corner{transition:none}}
  </style>`,
  );
  preview.document.body.innerHTML = `<div class="camera" title="Drag to move"><video id="recording-webcam" autoplay muted playsinline aria-label="Live webcam preview"></video><header class="controls"><span class="dot"></span><span id="preview-clock">00:00</span><button id="hide-preview" title="Hide preview — restore from the recording menu" aria-label="Hide webcam preview"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m3 3 6 6M9 3 3 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button></header><footer class="controls"><button id="stop-preview"><span class="square"></span><span id="stop-label">Stop recording</span></button></footer></div>`;
  const camera = preview.document.querySelector<HTMLElement>(".camera")!;
  const close =
    preview.document.querySelector<HTMLButtonElement>("#hide-preview")!;
  close.className = "circle-control";
  close.insertAdjacentHTML(
    "beforebegin",
    `<button id="flip-preview" class="circle-control" title="Mirror preview only" aria-label="Mirror webcam preview" aria-pressed="true"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 1v14M2 4v8l4-4-4-4Zm12 0v8l-4-4 4-4Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg></button>`,
  );
  for (const corner of ["nw", "ne", "sw", "se"] as const) {
    const grip = preview.document.createElement("div");
    grip.className = "resize-corner";
    grip.dataset.resize = corner;
    grip.title = "Drag to resize webcam preview";
    grip.innerHTML = `<svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M16 29Q19 19 29 16" stroke="white" stroke-width="2" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>`;
    camera.append(grip);
    grip.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !event.isPrimary) return;
      event.preventDefault();
      event.stopPropagation();
      let latest = event,
        frame = 0,
        finished = false;
      const send = (phase: PreviewResize["phase"]) => {
        void resize({
          phase,
          corner,
          screenX: latest.screenX,
          screenY: latest.screenY,
        }).catch(() => finish(true));
      };
      const flush = () => {
        if (frame) preview.cancelAnimationFrame(frame);
        frame = 0;
        send("move");
      };
      const move = (e: PointerEvent) => {
        if (e.pointerId !== event.pointerId) return;
        latest = e;
        if (!frame) frame = preview.requestAnimationFrame(flush);
      };
      const finish = (cancel = false) => {
        if (finished) return;
        finished = true;
        if (frame) preview.cancelAnimationFrame(frame);
        send(cancel ? "cancel" : "end");
        preview.document.body.classList.remove("resizing");
        preview.removeEventListener("pointermove", move);
        preview.removeEventListener("pointerup", up);
        preview.removeEventListener("pointercancel", cancelDrag);
        preview.removeEventListener("keydown", key);
        preview.removeEventListener("blur", cancelDrag);
        grip.removeEventListener("lostpointercapture", cancelDrag);
        if (grip.hasPointerCapture(event.pointerId))
          grip.releasePointerCapture(event.pointerId);
      };
      const up = (e: PointerEvent) => {
        if (e.pointerId !== event.pointerId) return;
        latest = e;
        finish();
      };
      const cancelDrag = () => finish(true);
      const key = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          e.preventDefault();
          finish(true);
        }
      };
      grip.setPointerCapture(event.pointerId);
      preview.document.body.classList.add("resizing");
      send("start");
      preview.addEventListener("pointermove", move);
      preview.addEventListener("pointerup", up);
      preview.addEventListener("pointercancel", cancelDrag);
      preview.addEventListener("keydown", key);
      preview.addEventListener("blur", cancelDrag);
      grip.addEventListener("lostpointercapture", cancelDrag);
    });
  }
  // Electron can focus the first button as the window opens. Reveal controls
  // for explicit keyboard navigation, not that automatic initial focus.
  preview.addEventListener("keydown", (event) => {
    if (event.key === "Tab") camera.classList.add("keyboard-controls");
  });
  const pointerControls = () => camera.classList.remove("keyboard-controls");
  preview.addEventListener("pointermove", pointerControls);
  preview.addEventListener("pointerdown", pointerControls);
  preview.addEventListener("blur", pointerControls);
  const video = preview.document.querySelector<HTMLVideoElement>("video")!;
  const flip =
    preview.document.querySelector<HTMLButtonElement>("#flip-preview")!;
  flip.onclick = () => {
    const mirrored = flip.getAttribute("aria-pressed") !== "true";
    flip.setAttribute("aria-pressed", String(mirrored));
    video.style.transform = mirrored ? "scaleX(-1)" : "none";
  };
  video.muted = true;
  video.srcObject = stream;
  void video.play().catch(() => {});
  preview.document.querySelector<HTMLButtonElement>("#hide-preview")!.onclick =
    hide;
  preview.document.querySelector<HTMLButtonElement>("#stop-preview")!.onclick =
    () => {
      preview.document.querySelector<HTMLButtonElement>(
        "#stop-preview",
      )!.disabled = true;
      preview.document.querySelector("#stop-label")!.textContent = "Saving…";
      stop();
    };
  const setRecording = (active: boolean) => {
    for (const selector of [".dot", "#preview-clock", "footer"])
      preview.document.querySelector<HTMLElement>(selector)!.hidden = !active;
    close.title = active
      ? "Hide preview — restore from the recording menu"
      : "Hide webcam preview";
  };
  setRecording(recording);
  return {
    setRecording,
    setStream(stream: MediaStream | null) {
      if (preview.closed) return;
      video.srcObject = stream;
      if (stream) void video.play().catch(() => {});
      else video.pause();
    },
    tick(elapsed: number) {
      if (preview.closed) return;
      const seconds = Math.max(0, Math.floor(elapsed));
      preview.document.querySelector("#preview-clock")!.textContent =
        `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    },
    close() {
      if (preview.closed) return;
      video.pause();
      video.srcObject = null;
      hide();
    },
  };
}
