import { startRecorder } from "./recording";
import { cameraRecordingType } from "../desktop/recording-options.mjs";
import { TodoComments, commentTime, type TodoComment } from "./todo-comments";
import "./todos.css";

export type TodoTake = {
  id: string;
  name?: string;
  duration: number;
  url: string;
  camera_path: string;
  microphone_path: string;
  project_path: string;
};
type TodoAttachment = {
  id: string;
  name: string;
  kind: "video" | "image" | "audio";
  url: string;
};
export type RecordingTodo = {
  id: string;
  title: string;
  instructions: string;
  revision: number;
  status:
    "ready" | "recording" | "interrupted" | "review" | "done" | "cancelled";
  attachments: TodoAttachment[];
  archived_attachments?: TodoAttachment[];
  takes: TodoTake[];
  removed_takes?: TodoTake[];
  comments: TodoComment[];
  result?: TodoTake & { notes: string };
  recovery?: { message: string; directory: string };
};
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.querySelector<T>(id)!;
const time = (seconds: number) =>
  `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0")}`;
const labels = {
  ready: "Ready to record",
  recording: "Recording",
  interrupted: "Interrupted",
  review: "Ready to review",
  done: "Done",
  cancelled: "Cancelled",
};

export class RecordingTodos {
  active = false;
  private working = false;
  private todos: RecordingTodo[] = [];
  private selected = "";
  private selectedTake = "";
  private retaking = false;
  private attachment = "";
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private session = "";
  private queue = Promise.resolve();
  private failure: unknown;
  private timer?: ReturnType<typeof setInterval>;
  private refreshing = false;
  private dialog: HTMLDialogElement;
  private comments: TodoComments;
  private viewingTake = "";

  constructor(
    private hooks: {
      prepare: () => void;
      openProject: (id: string, takeId: string) => Promise<boolean>;
    },
  ) {
    document.body.insertAdjacentHTML(
      "beforeend",
      `
      <dialog id="todos-dialog" aria-labelledby="todos-heading">
        <button id="todos-close" aria-label="Close recording todos">×</button>
        <div class="todo-layout">
          <aside class="todo-sidebar">
            <div class="todo-sidebar-title"><h2 id="todos-heading">Recordings</h2><span id="todo-count"></span></div>
            <div class="todo-queue-progress"><span id="todo-progress-label"></span><div id="todo-progress" role="progressbar" aria-label="Completed recordings" aria-valuemin="0" aria-valuemax="100"><i></i></div></div>
            <div id="todo-list" aria-label="Recording todos"></div>
          </aside>
          <section class="todo-workspace">
            <div id="todo-empty"><h3>No recordings yet</h3><p>Ask your agent to add a recording brief and reference media.</p><details><summary>Connect your agent</summary><p>Use <strong>Open Record Studio → Copy MCP configuration</strong> in the app menu, or the <code>todos create</code> CLI command.</p></details></div>
            <div id="todo-detail" hidden>
              <div class="todo-heading-row"><h3 id="todo-title"></h3><span id="todo-status" class="todo-status"></span><div class="todo-heading-actions"><button id="todo-done" class="primary">✓ <span>Mark as Done</span></button><button id="todo-record" class="primary"><span class="todo-record-dot"></span>Record</button><button id="todo-stop" hidden>■ Stop recording</button></div></div>
              <div class="todo-stage">
                <section class="todo-reference">
                  <div class="todo-section-label"><span id="todo-reference-label">Reference</span><span id="todo-reference-count"></span></div>
                  <div id="todo-media"></div>
                  <div class="todo-media-actions"><button id="todo-comment-reference">＋ Comment <span id="todo-comment-playhead">00:00.0</span></button><button id="todo-back-reference" class="text-button" hidden>Back to reference</button></div>
                  <div id="todo-attachments" aria-label="Attached media"></div>
                </section>
                <section class="todo-brief"><h4>Recording brief</h4><p id="todo-instructions"></p></section>
                <aside class="todo-capture-column">
                  <div class="todo-capture-tabs"><button id="todo-recording-tab" aria-pressed="true">Recording</button><button id="todo-comments-tab" aria-pressed="false">Comments <span id="todo-comments-count">0</span></button></div>
                  <div id="todo-capture-content">
                  <section class="todo-camera-panel">
                    <div class="todo-section-label"><span>Your camera</span><span id="todo-live-label">Preview off</span></div>
                    <div class="todo-camera-view"><video id="todo-camera" muted autoplay playsinline aria-label="Live webcam preview"></video><div id="todo-camera-placeholder"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><rect x="3" y="5" width="13" height="14" rx="3"/><path d="m16 9 5-3v12l-5-3"/></svg><button id="todo-enable">Enable camera & mic</button></div><span id="todo-clock" hidden>00:00</span></div>
                    <details class="todo-device-settings"><summary>Camera & microphone</summary><div class="todo-devices"><label>Camera<select id="todo-camera-device"><option value="default">Default camera</option></select></label><label>Microphone<select id="todo-mic-device"><option value="default">Default microphone</option></select></label></div></details>
                    <p class="todo-record-hint">Webcam + voice. Each recording adds a new clip.</p>
                  </section>
                  <section id="todo-review" hidden>
                    <div class="todo-review-title"><h4 id="todo-review-heading">Review your take</h4><select id="todo-take-select" aria-label="Take to review"></select></div>
                    <video id="todo-playback" controls playsinline aria-label="Review recorded take"></video>
                    <button id="todo-comment-take" class="text-button">Comment on this take</button>
                    <div class="todo-review-form"><label for="todo-notes">Notes for your agent <span>Optional</span></label><textarea id="todo-notes" rows="3" maxlength="20000" placeholder="Anything to keep in mind for the edit?"></textarea><div class="todo-review-secondary"><button id="todo-open-take">Open in editor ↗</button></div><p id="todo-handoff-hint">When you're happy, mark this take done above.</p></div>
                  </section>
                  <section id="todo-completed" hidden aria-live="polite">
                    <div class="todo-completion-art"><div class="todo-completion-ring"></div><svg class="todo-completion-check" width="56" height="56" viewBox="0 0 56 56" fill="none" aria-hidden="true"><circle cx="28" cy="28" r="26"/><path d="m17 28 8 8 15-17"/></svg><span class="todo-spark s1"></span><span class="todo-spark s2"></span><span class="todo-spark s3"></span><span class="todo-spark s4"></span><span class="todo-spark s5"></span><span class="todo-spark s6"></span></div>
                    <h4 id="todo-completion-title">Take complete</h4><p>Saved and ready for editing.</p><div id="todo-completion-progress"></div><button id="todo-next" class="primary">Next recording →</button><div class="todo-completed-secondary"><button id="todo-open-completed" class="text-button">Open in editor ↗</button></div>
                  </section>
                  <section id="todo-saved-clips" hidden><div class="todo-section-label"><span>Recorded clips</span><span id="todo-take-count"></span></div><div id="todo-takes"></div></section>
                  <div id="todo-recovery" hidden></div></div><section id="todo-comments-panel" hidden></section><p id="todo-error" role="alert" hidden></p>
                </aside>
              </div>
            </div>
          </section>
        </div>
      </dialog>`,
    );
    this.dialog = $("#todos-dialog");
    this.comments = new TodoComments($("#todo-comments-panel"), {
      add: async (id, input) => {
        await window.studio.addTodoComment(id, input);
        await this.refresh();
      },
      update: async (id, comment, status) => {
        await window.studio.updateTodoComment(
          id,
          comment.id,
          comment.revision,
          status,
        );
        await this.refresh();
      },
      jump: (comment) => this.jumpToComment(comment),
    });
    $("#todo-comments-tab").onclick = () => this.showComments(true);
    $("#todo-recording-tab").onclick = () => {
      this.showComments(false);
      if (this.viewingTake) {
        this.viewingTake = "";
        this.renderReference();
      }
    };
    $("#todo-back-reference").onclick = () => {
      this.viewingTake = "";
      if (!this.current?.attachments.some((a) => a.id === this.attachment))
        this.attachment = this.current?.attachments[0]?.id || "";
      this.renderReference();
    };
    $("#todo-comment-reference").onclick = () => this.startComment();
    $("#todo-comment-take").onclick = () => {
      const playback = $<HTMLVideoElement>("#todo-playback");
      const timestamp = playback.currentTime || 0;
      this.pauseMedia();
      this.viewingTake = this.selectedTake;
      this.renderReference();
      this.seekReference(timestamp);
      this.startComment(timestamp);
    };
    $("#recording-todos").onclick = () => void this.run(() => this.open());
    $("#todos-close").onclick = () => this.dialog.close();
    this.dialog.addEventListener("cancel", (e) => {
      if (this.active || this.working) e.preventDefault();
    });
    this.dialog.addEventListener("close", () => {
      this.release();
      this.pauseMedia();
    });
    $("#todo-enable").onclick = () => void this.run(() => this.enable());
    $("#todo-record").onclick = () => void this.run(() => this.start());
    $("#todo-stop").onclick = () => void this.stop();
    $("#todo-done").onclick = () =>
      void this.run(async () => {
        const todo = this.current!;
        await window.studio.completeTodo(
          todo.id,
          todo.revision,
          this.selectedTake,
          $<HTMLTextAreaElement>("#todo-notes").value,
        );
        this.release();
        await this.refresh();
        this.showComments(false);
        this.dialog.classList.remove("todo-celebrate");
        void this.dialog.offsetWidth;
        this.dialog.classList.add("todo-celebrate");
        requestAnimationFrame(() =>
          $("#todo-next").focus({ preventScroll: true }),
        );
      });
    $("#todo-next").onclick = () => {
      const next = this.todos.find(
        (t) =>
          t.id !== this.selected &&
          ["ready", "review", "interrupted"].includes(t.status),
      );
      if (next) this.selectTodo(next.id);
      else this.dialog.close();
    };
    $("#todo-open-completed").onclick = () => $("#todo-open-take").click();
    $("#todo-open-take").onclick = () =>
      void this.run(async () => {
        if (await this.hooks.openProject(this.selected, this.selectedTake))
          this.dialog.close();
      });
    $<HTMLSelectElement>("#todo-take-select").onchange = (e) => {
      this.selectedTake = (e.target as HTMLSelectElement).value;
      this.renderTake();
      this.renderClips();
    };
    for (const id of ["#todo-camera-device", "#todo-mic-device"])
      $(id).onchange = () =>
        void this.run(async () => {
          if (this.stream) await this.enable();
        });
    setInterval(() => {
      if (!this.active && !this.working)
        void this.refresh().catch((e) => {
          if (this.dialog.open) this.error(e);
        });
    }, 1500);
    void this.refresh().catch(() => {});
  }
  private get current() {
    return this.todos.find((t) => t.id === this.selected);
  }
  private error(error: unknown) {
    $("#todo-error").hidden = false;
    $("#todo-error").textContent =
      error instanceof Error ? error.message : String(error);
  }
  private async run(fn: () => Promise<void>) {
    if (this.working) return;
    this.working = true;
    this.controls();
    $("#todo-error").hidden = true;
    try {
      await fn();
    } catch (error) {
      this.error(error);
    } finally {
      this.working = false;
      this.controls();
    }
  }
  private async open() {
    this.hooks.prepare();
    this.dialog.showModal();
    await this.refresh(true);
    await this.devices();
  }
  private async refresh(force = false) {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const previous = this.current;
      const result = await window.studio.listTodos();
      const todos = result.todos.filter((todo) => todo.status !== "cancelled");
      const changed =
        force ||
        todos.length !== this.todos.length ||
        todos.some((todo, index) => {
          const old = this.todos[index];
          return (
            old?.id !== todo.id ||
            old.revision !== todo.revision ||
            old.status !== todo.status
          );
        });
      this.todos = todos;
      const count = todos.filter(
        (t) => !["done", "cancelled"].includes(t.status),
      ).length;
      $("#todo-badge").textContent = String(count);
      $("#todo-badge").hidden = count === 0;
      $("#todo-count").textContent = `${count} left`;
      const total = todos.filter((t) => t.status !== "cancelled").length;
      const completed = todos.filter((t) => t.status === "done").length;
      $("#todo-progress-label").textContent =
        `${completed} of ${total} complete`;
      const progress = total ? (completed / total) * 100 : 0;
      $("#todo-progress").setAttribute(
        "aria-valuenow",
        String(Math.round(progress)),
      );
      $("#todo-progress i").style.width = `${progress}%`;
      if (!this.dialog.open) return;
      // Polling an unchanged inbox must preserve keyboard focus in the queue.
      if (!changed && !$("#todo-detail").hidden) return;
      if (!this.current)
        this.selected =
          todos.find((t) => !["done", "cancelled"].includes(t.status))?.id ||
          todos[0]?.id ||
          "";
      if (previous?.id !== this.current?.id) {
        this.release();
        this.pauseMedia();
        this.retaking = false;
      }
      this.renderList();
      // Completion progress and the next action also depend on other todos.
      this.renderDetail(previous?.id !== this.current?.id);
      // An agent may replace references on the selected todo in place.
      if (
        previous?.id === this.current?.id &&
        JSON.stringify(previous?.attachments) !==
          JSON.stringify(this.current?.attachments)
      ) {
        if (!this.current!.attachments.some((a) => a.id === this.attachment))
          this.attachment = this.current!.attachments[0]?.id || "";
        if (!this.viewingTake) this.renderReference();
      }
    } finally {
      this.refreshing = false;
    }
  }
  private selectTodo(id: string) {
    this.release();
    this.pauseMedia();
    this.selected = id;
    this.retaking = false;
    this.attachment = "";
    this.viewingTake = "";
    this.dialog.classList.remove("todo-celebrate");
    $("#todo-error").hidden = true;
    this.renderList();
    this.renderDetail(true);
    this.dialog
      .querySelector('.todo-item[aria-pressed="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }
  private thumbnail(media?: { kind: string; url: string; name?: string }) {
    const frame = document.createElement("span");
    frame.className = "todo-thumbnail";
    frame.setAttribute("aria-hidden", "true");
    if (media?.kind === "image") {
      const img = document.createElement("img");
      img.src = media.url;
      img.alt = "";
      img.loading = "lazy";
      frame.append(img);
    } else if (media?.kind === "video") {
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.preload = "metadata";
      video.src = media.url;
      const duration = document.createElement("span");
      duration.className = "todo-thumbnail-duration";
      video.onloadedmetadata = () => {
        duration.textContent = time(video.duration || 0);
        video.currentTime = Math.min(0.1, video.duration / 2 || 0);
      };
      frame.append(video, duration);
    } else {
      frame.classList.add("todo-thumbnail-empty");
      frame.innerHTML = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="3" y="5" width="13" height="14" rx="3"/><path d="m16 9 5-3v12l-5-3"/></svg><span>${media?.kind === "audio" ? "Audio reference" : "Webcam + voice"}</span>`;
    }
    return frame;
  }
  private renderList() {
    const list = $("#todo-list");
    list.replaceChildren();
    const pending = this.todos.filter(
      (t) => t.status !== "done" && t.status !== "cancelled",
    );
    const completed = this.todos.filter((t) => t.status === "done");
    for (const [label, group] of [
      ["To record", pending],
      ["Completed", completed],
    ] as const) {
      if (!group.length) continue;
      const heading = document.createElement("h3");
      heading.className = "todo-group-title";
      heading.textContent = `${label} · ${group.length}`;
      list.append(heading);
      for (const todo of group) {
        const button = document.createElement("button");
        button.className = "todo-item";
        button.dataset.todoId = todo.id;
        button.dataset.status = todo.status;
        button.setAttribute("aria-pressed", String(todo.id === this.selected));
        const approved = todo.takes.find((t) => t.id === todo.result?.id);
        const preview = approved
          ? { kind: "video", url: approved.url }
          : todo.attachments.find((a) => a.kind !== "audio") ||
            todo.attachments[0];
        const thumbnail = this.thumbnail(preview);
        const commentCount = todo.comments?.length || 0;
        if (commentCount) {
          const bubble = document.createElement("span");
          bubble.className = "todo-item-comments";
          bubble.setAttribute("aria-hidden", "true");
          bubble.innerHTML =
            '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5a9.5 9.5 0 1 1 19 0Z"/></svg>';
          bubble.append(document.createTextNode(String(commentCount)));
          button.append(bubble);
          button.setAttribute(
            "aria-label",
            `${todo.title}, ${commentCount} ${commentCount === 1 ? "comment" : "comments"}`,
          );
        }
        const mark = document.createElement("span");
        mark.className = "todo-item-mark";
        mark.textContent = todo.status === "done" ? "✓" : "";
        thumbnail.append(mark);
        const text = document.createElement("span");
        text.className = "todo-item-copy";
        const title = document.createElement("strong"),
          meta = document.createElement("small");
        title.textContent = todo.title;
        meta.textContent =
          todo.status === "done"
            ? "Ready for editing"
            : `${labels[todo.status]}${todo.attachments.length ? ` · ${todo.attachments.length} ${todo.attachments.length === 1 ? "file" : "files"}` : ""}`;
        text.append(title, meta);
        button.append(thumbnail, text);
        button.disabled = this.active || this.working;
        button.onclick = () => this.selectTodo(todo.id);
        list.append(button);
      }
    }
  }
  private renderDetail(changed: boolean) {
    const todo = this.current;
    $("#todo-empty").hidden = Boolean(todo);
    $("#todo-detail").hidden = !todo;
    if (!todo) return;
    $("#todo-title").textContent = todo.title;
    $("#todo-instructions").textContent =
      todo.instructions ||
      "Record your webcam and voice. Your agent will use the take to finish the video.";
    $("#todo-status").textContent = labels[todo.status];
    $("#todo-status").dataset.status = todo.status;
    if (
      !["ready", "review", "interrupted"].includes(todo.status) &&
      !this.active
    )
      this.release();
    $("#todo-reference-count").textContent =
      `${todo.attachments.length} attached`;
    if (changed) {
      this.viewingTake = "";
      this.showComments(false);
      this.attachment = todo.attachments[0]?.id || "";
      this.selectedTake = todo.result?.id || todo.takes.at(-1)?.id || "";
      $<HTMLTextAreaElement>("#todo-notes").value = todo.result?.notes || "";
      this.renderReference();
    }
    if (!todo.takes.some((t) => t.id === this.selectedTake))
      this.selectedTake = todo.takes.at(-1)?.id || "";
    const reviewing =
      ["review", "done"].includes(todo.status) && !this.retaking;
    this.dialog.dataset.phase =
      todo.status === "done" ? "done" : reviewing ? "review" : "record";
    $(".todo-camera-panel").hidden = reviewing;
    $("#todo-review").hidden = !reviewing;
    $("#todo-review-heading").textContent =
      todo.status === "done" ? "Approved take" : "Review your take";
    $("#todo-completed").hidden = todo.status !== "done";
    const total = this.todos.filter((t) => t.status !== "cancelled").length;
    const completed = this.todos.filter((t) => t.status === "done").length;
    const next = this.todos.some(
      (t) =>
        t.id !== todo.id &&
        ["ready", "review", "interrupted"].includes(t.status),
    );
    $("#todo-completion-title").textContent =
      completed === total ? "All recordings complete" : "Take complete";
    $("#todo-completion-progress").textContent =
      `${completed} of ${total} recordings complete`;
    $("#todo-next").textContent = next ? "Next recording →" : "Back to editor";
    $("#todo-recovery").hidden =
      !todo.recovery && todo.status !== "interrupted";
    $("#todo-recovery").textContent = todo.recovery
      ? `${todo.recovery.message} Files: ${todo.recovery.directory}`
      : "The previous recording was interrupted. Captured files are kept; you can record a new take.";
    const select = $<HTMLSelectElement>("#todo-take-select");
    select.replaceChildren();
    todo.takes.forEach((take, i) =>
      select.add(
        new Option(
          `${take.name || `Take ${i + 1}`} · ${time(take.duration)}`,
          take.id,
        ),
      ),
    );
    this.renderTake();
    this.renderClips();
    this.comments.setTodo(todo.id, todo.comments || []);
    $("#todo-comments-count").textContent = String(
      (todo.comments || []).length,
    );
    this.controls();
  }
  private renderReference() {
    const todo = this.current!,
      media = $("#todo-media"),
      attachments = $("#todo-attachments");
    media
      .querySelectorAll("video,audio")
      .forEach((v) => (v as HTMLMediaElement).pause());
    media.replaceChildren();
    attachments.replaceChildren();
    const take = [...todo.takes, ...(todo.removed_takes || [])].find(
      (t) => t.id === this.viewingTake,
    );
    const selected = take
      ? {
          id: take.id,
          name: take.name || `Take ${todo.takes.indexOf(take) + 1}`,
          kind: "video",
          url: take.url,
        }
      : [...todo.attachments, ...(todo.archived_attachments || [])].find(
          (a) => a.id === this.attachment,
        );
    this.dialog.dataset.orientation = "landscape";
    const archived =
      !!selected &&
      !take &&
      !todo.attachments.some((a) => a.id === selected.id);
    const removed = !!take && !todo.takes.some((t) => t.id === take.id);
    $("#todo-reference-label").textContent = take
      ? `${selected!.name} · Recorded video`
      : archived
        ? "Earlier reference"
        : "Reference";
    $("#todo-reference-count").hidden =
      Boolean(take) || todo.attachments.length <= 1;
    $("#todo-back-reference").hidden = !take && !archived;
    attachments.hidden = Boolean(take) || todo.attachments.length <= 1;
    $("#todo-comment-reference").hidden = !selected || archived || removed;
    $(".todo-media-actions").hidden = !selected;
    $("#todo-comment-playhead").textContent = commentTime(0);
    if (!selected) {
      const note = document.createElement("p");
      note.textContent =
        "Your brief is all you need. No reference media attached.";
      media.append(note);
    } else {
      const element = document.createElement(
        selected.kind === "image" ? "img" : selected.kind,
      );
      if (element instanceof HTMLImageElement) {
        element.src = selected.url;
        element.alt = selected.name;
      } else if (element instanceof HTMLMediaElement) {
        element.src = selected.url;
        element.controls = true;
        element.preload = "metadata";
        element.muted = true;
        if (element instanceof HTMLVideoElement) element.playsInline = true;
        element.onloadedmetadata = () => {
          if (element.isConnected && element instanceof HTMLVideoElement) {
            this.dialog.dataset.orientation =
              element.videoHeight > element.videoWidth
                ? "portrait"
                : "landscape";
          }
        };
        element.onended = () => {
          if (this.active)
            $("#todo-live-label").textContent = "Still recording";
        };
        element.ontimeupdate = () => {
          $("#todo-comment-playhead").textContent = commentTime(
            element.currentTime,
          );
        };
      }
      element.addEventListener("error", () =>
        this.error(
          "This reference could not be played. Its file is still attached; you can continue recording from the brief.",
        ),
      );
      media.append(element);
    }
    for (const attachment of todo.attachments) {
      const button = document.createElement("button");
      button.title = attachment.name;
      const name = document.createElement("span");
      name.textContent = attachment.name;
      button.append(this.thumbnail(attachment), name);
      button.setAttribute(
        "aria-pressed",
        String(attachment.id === this.attachment),
      );
      button.onclick = () => {
        this.attachment = attachment.id;
        this.renderReference();
      };
      attachments.append(button);
    }
  }
  private renderTake() {
    const take = this.current?.takes.find((t) => t.id === this.selectedTake);
    $<HTMLSelectElement>("#todo-take-select").value = this.selectedTake;
    const playback = $<HTMLVideoElement>("#todo-playback");
    if (take && playback.src !== take.url) playback.src = take.url;
    if (!take) playback.removeAttribute("src");
  }
  private renderClips() {
    const todo = this.current!,
      list = $("#todo-takes");
    $("#todo-saved-clips").hidden = !todo.takes.length;
    $("#todo-take-count").textContent = String(todo.takes.length);
    list.replaceChildren();
    todo.takes.forEach((take, index) => {
      const name = take.name || `Take ${index + 1}`;
      const row = document.createElement("div");
      row.className = "todo-saved-clip";
      row.dataset.takeId = take.id;
      const select = document.createElement("button");
      select.className = "todo-select-clip";
      select.setAttribute(
        "aria-pressed",
        String(this.selectedTake === take.id),
      );
      select.append(
        this.thumbnail({ kind: "video", url: take.url }),
        document.createTextNode(`${name} · ${time(take.duration)}`),
      );
      select.onclick = () => {
        this.selectedTake = take.id;
        this.retaking = false;
        this.pauseMedia();
        this.renderDetail(false);
      };
      const remove = document.createElement("button");
      remove.className = "todo-remove-clip";
      remove.textContent = "×";
      remove.title = `Remove ${name}`;
      remove.setAttribute("aria-label", `Remove ${name}`);
      remove.onclick = () =>
        void this.run(async () => {
          this.pauseMedia();
          await window.studio.removeTodoTake(
            todo.id,
            this.current!.revision,
            take.id,
          );
          if (this.viewingTake === take.id) {
            this.viewingTake = "";
            this.renderReference();
          }
          await this.refresh();
        });
      row.append(select, remove);
      list.append(row);
    });
  }
  private showComments(show: boolean) {
    $("#todo-comments-panel").hidden = !show;
    $("#todo-capture-content").hidden = show;
    $("#todo-comments-tab").setAttribute("aria-pressed", String(show));
    $("#todo-recording-tab").setAttribute("aria-pressed", String(!show));
  }
  private startComment(timestamp?: number) {
    if (!this.current || this.active || this.working) return;
    const take = this.current.takes.find((t) => t.id === this.viewingTake);
    const attachment = this.current.attachments.find(
      (a) => a.id === this.attachment,
    );
    if (!take && !attachment) return;
    const media = document.querySelector<HTMLMediaElement>(
      "#todo-media video, #todo-media audio",
    );
    this.pauseMedia();
    this.showComments(true);
    this.comments.start(
      {
        media_type: take ? "take" : "attachment",
        media_id: take?.id || attachment!.id,
        timestamp_seconds: Math.max(0, timestamp ?? media?.currentTime ?? 0),
      },
      take
        ? take.name || `Take ${this.current.takes.indexOf(take) + 1}`
        : attachment!.name,
    );
  }
  private seekReference(timestamp: number) {
    const media = document.querySelector<HTMLMediaElement>(
      "#todo-media video, #todo-media audio",
    );
    if (!media) return;
    const seek = () => {
      media.pause();
      media.currentTime = Math.min(
        timestamp,
        Number.isFinite(media.duration) ? media.duration : timestamp,
      );
    };
    if (media.readyState) seek();
    else media.addEventListener("loadedmetadata", seek, { once: true });
  }
  private jumpToComment(comment: TodoComment) {
    if (this.active || this.working) return;
    this.pauseMedia();
    this.viewingTake = comment.media_type === "take" ? comment.media_id : "";
    if (
      this.viewingTake &&
      this.current?.takes.some((t) => t.id === this.viewingTake)
    ) {
      this.selectedTake = this.viewingTake;
      this.renderTake();
    }
    if (!this.viewingTake) this.attachment = comment.media_id;
    this.renderReference();
    this.seekReference(comment.timestamp_seconds);
  }
  private controls() {
    const blocked = this.active || this.working;
    const ready =
      this.current &&
      ["ready", "review", "interrupted", "done"].includes(this.current.status);
    for (const id of [
      "#todos-close",
      "#todo-camera-device",
      "#todo-mic-device",
      "#todo-open-take",
      "#todo-take-select",
      "#todo-next",
      "#todo-open-completed",
      "#todo-comment-reference",
      "#todo-comment-take",
      "#todo-back-reference",
      "#todo-recording-tab",
      "#todo-comments-tab",
    ])
      $<HTMLButtonElement>(id).disabled = blocked;
    document
      .querySelectorAll<HTMLButtonElement>(
        ".todo-item, .todo-saved-clip button",
      )
      .forEach((b) => (b.disabled = blocked));
    $<HTMLButtonElement>("#todo-enable").disabled = blocked || !ready;
    $<HTMLButtonElement>("#todo-record").disabled = blocked || !ready;
    $("#todo-record").hidden = this.active;
    $("#todo-stop").hidden = !this.active;
    $<HTMLButtonElement>("#todo-stop").disabled = this.working;
    $<HTMLButtonElement>("#todo-done").disabled =
      blocked || this.current?.status !== "review" || !this.selectedTake;
    $("#todo-done span").textContent =
      this.current?.status === "done" ? "Done" : "Mark as Done";
    $("#todo-done").title =
      this.current?.status === "review"
        ? "Approve the selected take and notify waiting agents"
        : this.current?.status === "done"
          ? "This recording is complete"
          : "Record and review a take before marking it done";
    this.comments?.setDisabled(blocked);
    $<HTMLTextAreaElement>("#todo-notes").disabled =
      blocked || this.current?.status === "done";
    $<HTMLSelectElement>("#todo-take-select").disabled = blocked;
  }
  private async devices() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    for (const [id, kind] of [
      ["#todo-camera-device", "videoinput"],
      ["#todo-mic-device", "audioinput"],
    ]) {
      const select = $<HTMLSelectElement>(id),
        value = select.value;
      select.replaceChildren(
        new Option(
          kind === "videoinput" ? "Default camera" : "Default microphone",
          "default",
        ),
      );
      for (const device of devices.filter(
        (d) => d.kind === kind && d.deviceId && d.deviceId !== "default",
      ))
        select.add(
          new Option(
            device.label ||
              `${kind === "videoinput" ? "Camera" : "Microphone"} ${select.length}`,
            device.deviceId,
          ),
        );
      if ([...select.options].some((o) => o.value === value))
        select.value = value;
    }
  }
  private async enable() {
    this.release();
    const camera = $<HTMLSelectElement>("#todo-camera-device").value,
      mic = $<HTMLSelectElement>("#todo-mic-device").value;
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: camera === "default" ? undefined : { exact: camera },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30 },
      },
      audio: {
        deviceId: mic === "default" ? undefined : { exact: mic },
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    if (!this.dialog.open) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.stream = stream;
    const preview = $<HTMLVideoElement>("#todo-camera");
    preview.srcObject = stream;
    try {
      await preview.play();
    } catch (error) {
      this.release();
      throw error;
    }
    $("#todo-camera-placeholder").hidden = true;
    $("#todo-live-label").textContent = "Live preview · muted";
    await this.devices();
  }
  private async start() {
    if (!this.current) return;
    if (!this.stream) await this.enable();
    if (!this.stream) return;
    this.showComments(false);
    if (this.viewingTake) {
      this.viewingTake = "";
      this.renderReference();
    }
    this.pauseMedia();
    this.failure = undefined;
    this.queue = Promise.resolve();
    try {
      this.session = (
        await window.studio.beginTodo(this.selected, this.current.revision)
      ).id;
      const mimeType = cameraRecordingType(
        (type) => MediaRecorder.isTypeSupported(type),
        true,
      );
      const recorder = (this.recorder = new MediaRecorder(this.stream, {
        mimeType,
        videoBitsPerSecond: 8000000,
        audioBitsPerSecond: 192000,
      }));
      recorder.ondataavailable = (event) => {
        if (!event.data.size) return;
        this.queue = this.queue
          .then(async () =>
            window.studio.append(
              this.session,
              "camera",
              await event.data.arrayBuffer(),
              recorder.mimeType,
            ),
          )
          .catch((error) => {
            this.failure = error;
            void this.stop();
          });
      };
      recorder.onerror = () => {
        this.failure = new Error(
          "Recording stopped unexpectedly. Captured media is kept for recovery.",
        );
        void this.stop();
      };
      const { startedAt } = await startRecorder(recorder);
      this.active = true;
      this.current!.status = "recording";
      this.retaking = true;
      this.dialog.classList.remove("todo-celebrate");
      this.renderDetail(false);
      for (const track of this.stream.getTracks())
        track.onended = () => void this.stop();
      recorder.onstop = () => {
        if (this.active && !this.working) void this.stop();
      };
      $("#todo-status").textContent = "Recording";
      $("#todo-live-label").textContent = "Recording webcam + voice";
      $("#todo-clock").hidden = false;
      $("#todo-clock").textContent = "00:00";
      this.timer = setInterval(() => {
        $("#todo-clock").textContent = time((Date.now() - startedAt) / 1000);
      }, 200);
      const reference = document.querySelector<HTMLMediaElement>(
        "#todo-media video, #todo-media audio",
      );
      if (reference) {
        reference.currentTime = 0;
        void reference.play().catch(() => {});
      }
    } catch (error) {
      if (this.recorder?.state === "recording") {
        await new Promise<void>((resolve) => {
          this.recorder!.addEventListener("stop", () => resolve(), {
            once: true,
          });
          this.recorder!.stop();
        });
      }
      await this.queue;
      if (this.session) await window.studio.abort(this.session);
      this.session = "";
      this.release();
      throw error;
    }
  }
  async stop() {
    if (!this.active || this.working) return;
    await this.run(async () => {
      clearInterval(this.timer);
      this.pauseMedia();
      $("#todo-live-label").textContent = "Saving your take…";
      try {
        const recorder = this.recorder;
        if (recorder && recorder.state !== "inactive")
          await new Promise<void>((resolve) => {
            recorder.addEventListener("stop", () => resolve(), { once: true });
            recorder.stop();
          });
        await this.queue;
        if (this.failure) throw this.failure;
        const todo = await window.studio.finishTodo(this.session);
        this.selectedTake = todo.takes.at(-1)!.id;
        this.retaking = false;
      } catch (error) {
        await window.studio.abort(this.session);
        throw error;
      } finally {
        this.session = "";
        this.active = false;
        this.release();
        await this.refresh();
      }
      $("#todo-review").scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      });
    });
  }
  private pauseMedia() {
    this.dialog
      .querySelectorAll<HTMLMediaElement>(
        "#todo-media video, #todo-media audio, #todo-playback",
      )
      .forEach((media) => media.pause());
  }
  private release() {
    this.stream?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    this.stream = null;
    $<HTMLVideoElement>("#todo-camera").srcObject = null;
    $("#todo-camera-placeholder").hidden = false;
    $("#todo-clock").hidden = true;
    $("#todo-live-label").textContent = "Preview off";
    this.controls();
  }
}
