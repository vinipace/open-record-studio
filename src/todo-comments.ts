export type CommentInput = {
  media_type: "attachment" | "take";
  media_id: string;
  timestamp_seconds: number;
  text: string;
};
export type TodoComment = CommentInput & {
  id: string;
  author: "user" | "agent";
  status: "open" | "resolved";
  revision: number;
  created_at: string;
  resolution?: string;
  media: { name: string; path: string; kind: string };
};
export const commentTime = (seconds: number) => {
  const value = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  return `${Math.floor(value / 60)
    .toString()
    .padStart(
      2,
      "0",
    )}:${(Math.floor((value % 60) * 10) / 10).toFixed(1).padStart(4, "0")}`;
};

export class TodoComments {
  private todoId = "";
  private comments: TodoComment[] = [];
  private draft?: Omit<CommentInput, "text">;
  private busy = false;
  private disabled = false;
  private signature = "";
  private $ = <T extends HTMLElement = HTMLElement>(selector: string) =>
    this.root.querySelector<T>(selector)!;

  constructor(
    private root: HTMLElement,
    private hooks: {
      add: (id: string, input: CommentInput) => Promise<void>;
      update: (
        id: string,
        comment: TodoComment,
        status: "open" | "resolved",
      ) => Promise<void>;
      jump: (comment: TodoComment) => void;
    },
  ) {
    root.innerHTML = `
      <div class="todo-comments-heading"><h4>Video comments</h4><select id="todo-comment-filter" aria-label="Filter comments"><option value="all">All</option><option value="open">Open</option><option value="resolved">Resolved</option></select></div>
      <p class="todo-comments-intro">Feedback stays with its video and timestamp.</p>
      <div id="todo-comment-list" aria-label="Video comments"></div>
      <form id="todo-comment-form" hidden>
        <div class="todo-comment-context"><span id="todo-comment-context"></span><button type="button" id="todo-comment-cancel" aria-label="Cancel comment">×</button></div>
        <label class="todo-comment-input-label" for="todo-comment-text">Your comment</label>
        <textarea id="todo-comment-text" rows="3" maxlength="5000" placeholder="What should change at this moment?" required></textarea>
        <button id="todo-comment-submit" class="primary" type="submit">Post comment</button>
      </form>
      <p id="todo-comment-feedback" role="status"></p>
      <p id="todo-comment-error" role="alert" hidden></p>`;
    this.$("#todo-comment-filter").onchange = () => this.render();
    this.$("#todo-comment-cancel").onclick = () => {
      this.draft = undefined;
      this.$<HTMLTextAreaElement>("#todo-comment-text").value = "";
      this.$("#todo-comment-form").hidden = true;
    };
    this.$<HTMLTextAreaElement>("#todo-comment-text").oninput = () =>
      this.controls();
    this.$("#todo-comment-form").onsubmit = (event) => {
      event.preventDefault();
      if (!this.draft || this.busy || this.disabled) return;
      const id = this.todoId,
        draft = this.draft;
      const text =
        this.$<HTMLTextAreaElement>("#todo-comment-text").value.trim();
      if (!text) return;
      void this.action(async () => {
        await this.hooks.add(id, { ...draft, text });
        if (this.todoId !== id || this.draft !== draft) return;
        this.draft = undefined;
        this.$<HTMLTextAreaElement>("#todo-comment-text").value = "";
        this.$("#todo-comment-form").hidden = true;
        this.$("#todo-comment-feedback").textContent =
          "Comment saved. Ready for your agent.";
      });
    };
  }
  setTodo(id: string, comments: TodoComment[]) {
    if (this.todoId !== id) {
      this.todoId = id;
      this.draft = undefined;
      this.signature = "";
      this.$("#todo-comment-form").hidden = true;
      this.$<HTMLTextAreaElement>("#todo-comment-text").value = "";
      this.$("#todo-comment-feedback").textContent = "";
      this.$("#todo-comment-error").hidden = true;
    }
    this.comments = comments;
    const signature = JSON.stringify(comments.map((c) => [c.id, c.revision]));
    if (signature !== this.signature) {
      this.signature = signature;
      this.render();
    }
    this.controls();
  }
  start(input: Omit<CommentInput, "text">, name: string) {
    if (this.busy || this.disabled) return;
    this.draft = input;
    this.$("#todo-comment-context").textContent =
      `${name} · ${commentTime(input.timestamp_seconds)}`;
    this.$("#todo-comment-form").hidden = false;
    this.$("#todo-comment-feedback").textContent = "";
    this.$("#todo-comment-error").hidden = true;
    this.controls();
    this.$("#todo-comment-text").focus();
  }
  setDisabled(disabled: boolean) {
    this.disabled = disabled;
    this.controls();
  }
  private controls() {
    this.root
      .querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>(
        "button, textarea",
      )
      .forEach((el) => {
        el.disabled = this.busy || this.disabled;
      });
    this.$<HTMLButtonElement>("#todo-comment-submit").disabled ||=
      !this.$<HTMLTextAreaElement>("#todo-comment-text").value.trim();
  }
  private async action(fn: () => Promise<void>) {
    if (this.busy || this.disabled) return;
    this.busy = true;
    const id = this.todoId;
    this.controls();
    this.$("#todo-comment-error").hidden = true;
    try {
      await fn();
    } catch (error) {
      if (this.todoId === id) {
        this.$("#todo-comment-error").hidden = false;
        this.$("#todo-comment-error").textContent =
          error instanceof Error ? error.message : String(error);
      }
    } finally {
      this.busy = false;
      this.controls();
    }
  }
  private render() {
    const list = this.$("#todo-comment-list"),
      filter = this.$<HTMLSelectElement>("#todo-comment-filter").value;
    list.replaceChildren();
    const comments = this.comments.filter(
      (c) => filter === "all" || c.status === filter,
    );
    if (!comments.length) {
      const empty = document.createElement("p");
      empty.className = "todo-comments-empty";
      empty.textContent = this.comments.length
        ? "No comments in this view."
        : "Pause on a moment, then choose Comment to leave feedback.";
      list.append(empty);
    }
    for (const comment of comments.toReversed()) {
      const card = document.createElement("article");
      card.className = "todo-comment";
      card.dataset.commentId = comment.id;
      card.dataset.status = comment.status;
      const header = document.createElement("div");
      header.className = "todo-comment-meta";
      const timestamp = document.createElement("button");
      timestamp.className = "todo-comment-jump";
      timestamp.textContent = commentTime(comment.timestamp_seconds);
      timestamp.title = `Jump to ${commentTime(comment.timestamp_seconds)} in ${comment.media.name}`;
      timestamp.onclick = () => this.hooks.jump(comment);
      const author = document.createElement("span");
      author.textContent = comment.author === "user" ? "You" : "Agent";
      header.append(timestamp, author);
      const media = document.createElement("div");
      media.className = "todo-comment-media";
      media.textContent = comment.media.name;
      const text = document.createElement("p");
      text.textContent = comment.text;
      card.append(header, media, text);
      if (comment.resolution) {
        const resolution = document.createElement("p");
        resolution.className = "todo-comment-resolution";
        resolution.textContent = `Resolution: ${comment.resolution}`;
        card.append(resolution);
      }
      const resolve = document.createElement("button");
      resolve.className = "todo-comment-resolve";
      resolve.textContent =
        comment.status === "resolved" ? "✓ Resolved · Reopen" : "Mark resolved";
      resolve.onclick = () => {
        const id = this.todoId;
        void this.action(() =>
          this.hooks.update(
            id,
            comment,
            comment.status === "resolved" ? "open" : "resolved",
          ),
        );
      };
      card.append(resolve);
      list.append(card);
    }
    this.controls();
  }
}
