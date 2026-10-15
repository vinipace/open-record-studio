import {
  loadRecordingPreferences,
  saveRecordingPreferences,
  flushRecordingPreferences,
  devicePreference,
  populateDevices,
} from "./recording-preferences";
import type { Project, TakeSample } from "./types";
import { startRecorder } from "./recording";
import { clock } from "./timeline";

type Hooks = {
  state: () => {
    project: Project | null;
    time: number;
    total: number;
    playing: boolean;
    layerCount: number;
  };
  prepare: () => Promise<void>;
  play: () => void;
  pause: () => void;
  preview: (stream: MediaStream | null) => void;
  block: (active: boolean) => void;
  commit: (project: Project, layerId: string, time: number) => void;
  error: (error: unknown) => void;
};
const $ = <T extends HTMLElement>(id: string) => document.querySelector<T>(id)!;
export class WebcamTake {
  active = false;
  private dialog: HTMLDialogElement;
  private camera: MediaStream | null = null;
  private microphone: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private id = "";
  private starting: Promise<void> | null = null;
  private finishing = false;
  private queue = Promise.resolve();
  private failure: unknown;
  private samples: TakeSample[] = [];
  private startedAt = 0;
  private startTime = 0;
  private frame = 0;
  private generation = 0;
  private devices: MediaDeviceInfo[] = [];
  constructor(private hooks: Hooks) {
    document.body.insertAdjacentHTML(
      "beforeend",
      `<dialog id="webcam-take-dialog"><div class="dialog-header"><h2>Record webcam here</h2><button id="close-take" aria-label="Close">×</button></div><video id="take-camera-preview" autoplay muted playsinline></video><div class="record-inputs"><label>Camera<select id="take-camera"></select></label><label>Microphone<select id="take-microphone"></select></label></div><div class="dialog-footer"><span id="take-position"></span><button id="start-take" class="primary">Record</button></div><p id="take-error" role="alert" hidden></p></dialog>`,
    );
    this.dialog = $("#webcam-take-dialog");
    $("#close-take").onclick = () => this.dialog.close();
    this.dialog.addEventListener("close", () => {
      if (!this.active) this.release();
    });
    this.dialog.addEventListener("cancel", (event) => {
      if (this.active) event.preventDefault();
    });
    $("#take-camera").onchange = () => {
      void saveRecordingPreferences({
        camera: devicePreference(
          $<HTMLSelectElement>("#take-camera").value,
          this.devices,
        ),
      }).catch((e) => this.showError(e));
      void this.openCamera();
    };
    $("#take-microphone").onchange = () =>
      void saveRecordingPreferences({
        microphone: devicePreference(
          $<HTMLSelectElement>("#take-microphone").value,
          this.devices,
        ),
      }).catch((e) => this.showError(e));
    $("#start-take").onclick = () => {
      if (this.active) return;
      this.starting = this.start().finally(() => {
        this.starting = null;
      });
    };
  }
  async open() {
    const { project, time, total, layerCount } = this.hooks.state();
    if (!project || this.active) return;
    if (time >= total - 0.05)
      throw new Error("Move the playhead before the end of the video");
    if (layerCount >= 16)
      throw new Error("Remove an overlay before adding another recording");
    this.hooks.pause();
    this.startTime = time;
    $("#take-position").textContent = `Starts at ${clock(time)}`;
    $("#take-error").hidden = true;
    this.dialog.showModal();
    $<HTMLButtonElement>("#start-take").disabled = true;
    const [devices, preferences] = await Promise.all([
      navigator.mediaDevices.enumerateDevices(),
      loadRecordingPreferences(),
    ]);
    if (!this.dialog.open) return;
    this.devices = devices;
    populateDevices(
      $("#take-camera"),
      devices,
      "videoinput",
      preferences.camera,
      "Camera",
      true,
    );
    populateDevices(
      $("#take-microphone"),
      devices,
      "audioinput",
      preferences.microphone,
      "Microphone",
    );
    if (this.dialog.open) await this.openCamera();
  }
  private async openCamera() {
    const generation = ++this.generation;
    this.camera?.getTracks().forEach((t) => t.stop());
    this.camera = null;
    $<HTMLButtonElement>("#start-take").disabled = true;
    try {
      const id = $<HTMLSelectElement>("#take-camera").value;
      if (!id) throw new Error("Select an available camera");
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: id === "default" ? undefined : { exact: id },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: 30,
        },
        audio: false,
      });
      if (generation !== this.generation || !this.dialog.open) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.camera = stream;
      const video = $<HTMLVideoElement>("#take-camera-preview");
      video.srcObject = stream;
      await video.play();
      $<HTMLButtonElement>("#start-take").disabled = false;
      $("#take-error").hidden = true;
    } catch (error) {
      this.showError(error);
    }
  }
  private showError(error: unknown) {
    $("#take-error").hidden = false;
    $("#take-error").textContent =
      error instanceof Error ? error.message : String(error);
  }
  private async start() {
    if (!this.camera) return;
    this.active = true;
    this.hooks.block(true);
    $<HTMLButtonElement>("#start-take").disabled = true;
    $<HTMLButtonElement>("#close-take").disabled = true;
    $<HTMLSelectElement>("#take-camera").disabled = true;
    $<HTMLSelectElement>("#take-microphone").disabled = true;
    this.samples = [];
    this.failure = null;
    this.queue = Promise.resolve();
    try {
      await flushRecordingPreferences();
      await this.hooks.prepare();
      const project = this.hooks.state().project!;
      const mic = $<HTMLSelectElement>("#take-microphone").value;
      if (mic)
        this.microphone = await navigator.mediaDevices.getUserMedia({
          video: false,
          audio: {
            deviceId: mic === "default" ? undefined : { exact: mic },
            echoCancellation: true,
            noiseSuppression: true,
          },
        });
      this.id = (
        await window.studio.beginTake(project.id, project.revision)
      ).id;
      const stream = new MediaStream([
        ...this.camera.getVideoTracks(),
        ...(this.microphone?.getAudioTracks() || []),
      ]);
      const mimeType = ["video/webm;codecs=vp8,opus", "video/webm"].find(
        (type) => MediaRecorder.isTypeSupported(type),
      );
      if (!mimeType)
        throw new Error("Webcam recording is unavailable in this runtime");
      const recorder = (this.recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 6000000,
        audioBitsPerSecond: 192000,
      }));
      recorder.ondataavailable = (event) => {
        if (!event.data.size) return;
        this.queue = this.queue
          .then(async () => {
            await window.studio.append(
              this.id,
              "camera",
              await event.data.arrayBuffer(),
            );
          })
          .catch((error) => {
            this.failure = error;
            void this.stop();
          });
      };
      recorder.onerror = () => {
        this.failure = new Error(
          "The webcam stopped recording. Captured media is kept for recovery.",
        );
        void this.stop();
      };
      this.startedAt = (await startRecorder(recorder)).startedAt;
      for (const track of stream.getTracks())
        track.onended = () => void this.stop();
      this.hooks.preview(this.camera);
      this.dialog.close();
      $("#recording-banner").hidden = false;
      $("#record-clock").textContent = "00:00.0";
      await window.studio.recordingReady();
      this.hooks.play();
      let lastProgress = Date.now(),
        lastTime = this.startTime;
      const sample = () => {
        if (!this.active || this.finishing) return;
        const { time, playing } = this.hooks.state();
        const media = (Date.now() - this.startedAt) / 1000;
        if (time > lastTime + 0.00001) {
          lastProgress = Date.now();
          lastTime = time;
        }
        if (!this.samples.length && time > this.startTime)
          this.samples.push({
            output: this.startTime,
            media: Math.max(0, media - (time - this.startTime)),
          });
        if (this.samples.length && media - this.samples.at(-1)!.media >= 0.1)
          this.samples.push({
            output: Math.max(this.samples.at(-1)!.output, time),
            media,
          });
        $("#record-clock").textContent = clock(
          Math.max(0, time - this.startTime),
        );
        if (!playing || Date.now() - lastProgress > 10000) {
          void this.stop();
          return;
        }
        this.frame = requestAnimationFrame(sample);
      };
      this.frame = requestAnimationFrame(sample);
    } catch (error) {
      this.failure = error;
      await this.cleanup();
      if (this.dialog.open) await this.openCamera();
      this.showError(error);
      if (!this.dialog.open) this.hooks.error(error);
    } finally {
      for (const id of ["close-take", "take-camera", "take-microphone"])
        $<HTMLButtonElement>("#" + id).disabled = false;
      $<HTMLButtonElement>("#start-take").disabled =
        this.active || !this.camera;
    }
  }
  async stop() {
    if (this.starting) await this.starting;
    if (!this.active || this.finishing) return;
    this.finishing = true;
    cancelAnimationFrame(this.frame);
    const { time } = this.hooks.state();
    this.hooks.pause();
    if (this.samples.length)
      this.samples.push({
        output: Math.max(this.samples.at(-1)!.output, time),
        media: (Date.now() - this.startedAt) / 1000,
      });
    $("#record-clock").textContent = "Saving…";
    this.hooks.preview(null);
    try {
      const recorder = this.recorder;
      if (recorder && recorder.state !== "inactive")
        await new Promise<void>((resolve) => {
          recorder.addEventListener("stop", () => resolve(), { once: true });
          recorder.stop();
        });
      await this.queue;
      if (this.failure) throw this.failure;
      const result = await window.studio.finishTake(this.id, this.samples);
      this.id = "";
      this.hooks.commit(result.project, result.layerId, this.startTime);
    } catch (error) {
      this.hooks.error(error);
    } finally {
      await this.cleanup();
      this.finishing = false;
    }
  }
  private release() {
    ++this.generation;
    this.camera?.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    this.microphone?.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    this.camera = this.microphone = null;
    $<HTMLVideoElement>("#take-camera-preview").srcObject = null;
  }
  private async cleanup() {
    cancelAnimationFrame(this.frame);
    this.hooks.pause();
    this.hooks.preview(null);
    if (this.recorder) {
      this.recorder.ondataavailable = this.recorder.onerror = null;
      if (this.recorder.state !== "inactive") this.recorder.stop();
    }
    this.release();
    await this.queue;
    if (this.id) await window.studio.abort(this.id).catch(() => {});
    this.id = "";
    this.recorder = null;
    this.active = false;
    this.hooks.block(false);
    $("#recording-banner").hidden = true;
  }
}
