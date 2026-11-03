import type { Edits, Project } from "./types";

export class Transcript {
  pending = false;
  message = "";
  private key = "";
  private job: { id: string; requestId: string } | null = null;

  constructor(
    private changed: () => void,
    private api = window.studio,
  ) {
    api.onTranscriptProgress(({ requestId, message }) => {
      if (this.job?.requestId !== requestId) return;
      this.message = message;
      this.changed();
    });
  }

  configure(project: Project | null, edits: Edits | null, unavailable = false) {
    const key = unavailable
      ? ""
      : JSON.stringify([project?.id, project?.revision, edits]);
    if (this.key === key) return;
    this.key = key;
    this.cancel("");
  }

  cancel(message = "Transcription cancelled.") {
    const job = this.job;
    this.job = null;
    this.pending = false;
    this.message = message;
    if (job)
      void this.api.cancelTranscription(job.id, job.requestId).catch(() => {});
    this.changed();
  }

  async copy(project: Project, edits: Edits) {
    if (this.pending) return;
    const job = { id: project.id, requestId: crypto.randomUUID() };
    this.job = job;
    this.pending = true;
    this.message = "Preparing transcript…";
    this.changed();
    try {
      const text = await this.api.transcribe(
        project.id,
        structuredClone(edits),
        job.requestId,
      );
      if (this.job !== job) return;
      if (!text.trim()) {
        this.message = "No speech found in the edited audio.";
        return;
      }
      await this.api.copyTranscript(text);
      if (this.job === job) this.message = "Transcript copied.";
    } catch (error) {
      if (this.job === job) {
        const detail = error instanceof Error ? error.message : String(error);
        this.message = /no space|ENOSPC|disk space/i.test(detail)
          ? "Not enough disk space. Free some space, then try again."
          : /network|fetch|download|connection|timeout|offline/i.test(detail)
            ? "Couldn't download the speech tools. Check your connection and try again."
            : "Couldn't create the transcript. Please try again.";
      }
    } finally {
      if (this.job === job) {
        this.job = null;
        this.pending = false;
        this.changed();
      }
    }
  }
}
