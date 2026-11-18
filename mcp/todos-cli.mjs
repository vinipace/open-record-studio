import { TodoStore } from "../desktop/todo-store.mjs";

export const todoHelp = `Recording todos (works with the app closed):
  todos create --title "Intro" --instructions "Read the attached draft" --attach /absolute/draft.mp4
  todos list [--status ready]
  todos get ID
  todos update ID --revision N [--title TEXT] [--instructions TEXT] [--attach /absolute/video.mp4] [--status ready|cancelled]
  todos remove-take ID --revision N --take TAKE_ID
  todos done ID --revision N --take TAKE_ID [--notes TEXT]
  todos wait ID [--timeout SECONDS]  (default: wait until done or cancelled)
  todos events [--after CURSOR]
  todos comments ID [--status open|resolved]
  todos comment ID --media-type attachment|take --media-id MEDIA_ID --at SECONDS --text TEXT
  todos resolve-comment ID --comment COMMENT_ID --revision N [--status resolved|open] [--resolution TEXT]
  todos wait-comments ID [--after CURSOR] [--timeout SECONDS]

Repeat --attach for more reference files. On update this replaces media on the SAME todo;
omit --attach to keep existing references. Use update for revisions, not create.
All output is JSON. A timed-out wait exits 2;
cancelled exits 3; errors exit 1. Done exits 0 and includes the selected take's paths.
Run 'todos wait ID' as a background Bash task in Claude Code to resume on completion.
Run 'todos wait-comments ID --after CURSOR' in the background for new/reopened comments.
After handling a batch, wait again with the returned cursor. Comments include media paths.
OPEN_RECORD_STUDIO_TODO_DIR overrides the shared inbox for both the app and CLI.`;

export async function runTodosCli(args) {
  if (!args.length || args[0] === "--help") {
    console.log(todoHelp);
    return;
  }
  const command = args.shift(),
    positional = [],
    flags = {};
  while (args.length) {
    const key = args.shift();
    if (!key.startsWith("--")) {
      positional.push(key);
      continue;
    }
    const value = args.shift();
    if (value === undefined) throw new Error(`Missing value for ${key}`);
    if (key === "--attach") (flags.attachments ||= []).push(value);
    else {
      if (Object.hasOwn(flags, key.slice(2)))
        throw new Error(`Repeated option ${key}`);
      flags[key.slice(2)] = value;
    }
  }
  const allowed = {
    create: ["title", "instructions", "attachments"],
    list: ["status"],
    get: [],
    update: ["revision", "title", "instructions", "status", "attachments"],
    "remove-take": ["revision", "take"],
    done: ["revision", "take", "notes"],
    wait: ["timeout"],
    events: ["after"],
    comments: ["status"],
    comment: ["media-type", "media-id", "at", "text"],
    "resolve-comment": ["comment", "revision", "status", "resolution"],
    "wait-comments": ["after", "timeout"],
  }[command];
  if (!allowed) throw new Error("Unknown todo command. Use todos --help.");
  for (const key of Object.keys(flags))
    if (!allowed.includes(key)) throw new Error(`Unknown option --${key}`);
  const needsId = [
    "get",
    "update",
    "remove-take",
    "done",
    "wait",
    "comments",
    "comment",
    "resolve-comment",
    "wait-comments",
  ].includes(command);
  if (positional.length !== (needsId ? 1 : 0))
    throw new Error(
      needsId ? "Supply one todo ID" : "Unexpected positional argument",
    );
  if (
    ["update", "done", "resolve-comment", "remove-take"].includes(command) &&
    (!Number.isInteger(Number(flags.revision)) || Number(flags.revision) < 1)
  )
    throw new Error("Supply --revision from todos get");
  const store = new TodoStore(),
    id = positional[0];
  let result;
  switch (command) {
    case "remove-take":
      result = await store.removeTake(id, Number(flags.revision), flags.take);
      break;
    case "comments":
      result = await store.comments(id, flags.status);
      break;
    case "comment":
      result = await store.addComment(id, {
        media_type: flags["media-type"],
        media_id: flags["media-id"],
        timestamp_seconds: Number(flags.at),
        text: flags.text,
      });
      break;
    case "resolve-comment":
      result = await store.updateComment(
        id,
        flags.comment,
        Number(flags.revision),
        flags.status || "resolved",
        flags.resolution,
      );
      break;
    case "wait-comments":
      result = await store.waitComments(id, Number(flags.after || 0), {
        timeout: Number(flags.timeout || 0) * 1000,
      });
      if (result.status === "waiting") process.exitCode = 2;
      break;
    case "create":
      result = await store.create(flags);
      break;
    case "list":
      result = await store.list(flags.status);
      break;
    case "get":
      result = await store.get(id);
      break;
    case "update": {
      const { revision, ...changes } = flags;
      result = await store.update(id, Number(revision), changes);
      break;
    }
    case "done":
      result = await store.complete(
        id,
        Number(flags.revision),
        flags.take,
        flags.notes,
      );
      break;
    case "events":
      result = await store.events(Number(flags.after || 0));
      break;
    case "wait":
      result = await store.wait(id, {
        timeout: Number(flags.timeout || 0) * 1000,
      });
      if (result.status === "waiting") process.exitCode = 2;
      if (result.status === "cancelled") process.exitCode = 3;
      break;
  }
  console.log(JSON.stringify(result, null, 2));
}
