# Recording todos: an agent → you → agent handoff

Use **Todos** in the app's top bar to see recording briefs from Claude or another local agent. Each brief can include video, image and audio references. Enable your camera and microphone, record, review your takes, and choose **Mark as Done** to hand the selected take back to your agent. Recording continues when the reference finishes, pauses, or is scrubbed. A stopped recording is **Ready to review**; only **Mark as Done** signals approval.

**Mark as Done** stays in the top-right corner while viewing recordings or comments. It becomes available after saving a take; a live or unfinished recording cannot be approved. The attachment picker appears only when a brief has multiple reference files.

References are copied into the inbox when the todo is created. Moving or deleting the agent's original draft does not break the recording brief. Retakes preserve previous recordings, and you can select any saved take before marking done. The preview is mirrored; saved webcam footage is not. Reference playback is muted initially; its own controls let you listen when needed.

## Connect Claude locally

In a build containing this feature, use **Open Record Studio → Copy MCP configuration** in the macOS menu. Paste that configuration into Claude Desktop's MCP configuration, or register the launcher with Claude Code:

```sh
claude mcp add --transport stdio open-record-studio -- \
  "/Applications/Open Record Studio.app/Contents/Resources/bin/open-record-studio-mcp"
```

For a source checkout, use an absolute Node executable and server path:

```json
{
  "mcpServers": {
    "open-record-studio": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/screen-studio/mcp/server.mjs"]
    }
  }
}
```

Reconnect the client after updating the app/server. The MCP server and CLI work with the desktop app closed. They use stdio and local files; there is no listening network port or account to configure.

## Agent workflow

1. Create the draft/reference media locally.
2. Call `create_todo` with `title`, `instructions`, and absolute local file paths in `attachments` (optional, up to 20). Supported reference formats: MP4, MOV, M4V, WebM, MKV, PNG, JPEG, WebP, MP3, WAV, M4A, OGG and FLAC. Playback depends on the codecs in each file; unsupported media shows an error while leaving the recording brief available.
3. Keep a completion waiter running. In Claude Code, ask Claude to run the CLI `todos wait ID` **as a background Bash task**, then continue editing when that task returns. Keep that Claude session running. Claude Code reports completed background commands to the session ([official background task documentation](https://code.claude.com/docs/en/interactive-mode#background-bash-commands)).
4. You open **Todos**, record webcam + voice, review, and mark the chosen take done.
5. The waiter returns `status: "done"` and `todo.result`, containing `camera_path`, `microphone_path`, `project_path`, `duration`, the approved take ID, and your notes. Claude can use the media in its existing edit or call `get_project` and the existing preview/edit/render tools on `project_path`.

An example instruction to Claude:

> Create the draft video, then create a recording todo with the draft attached and the speaking brief. Run `todos wait <returned-id>` as a background Bash task. When I mark the take done, use the returned camera and microphone files to finish the edit. Do not mark the todo done for me.

**MCP clients:** `wait_for_todo` waits up to 30 seconds; `waiting` means call again. `todo_events` reads durable events after a cursor, including `todo.done` and its selected output paths. Store its returned cursor and paginate while `has_more` is true. Events and approved results survive app and MCP-server restarts. MCP cannot itself start an idle/disconnected Claude conversation; use the background CLI waiter in an active Claude Code session, or a client that polls the wait/event tools.

## Video comments and agent handoff

Pause a reference video at the moment you want to discuss and click **Comment** below the player. For a recorded take, choose **Comment on this take** to open it in the large player. Post your comment in the **Comments** panel. Clicking a comment's timestamp returns to that exact media and position. You can filter open/resolved feedback, resolve a comment, or reopen it. Comments are also available after a recording is done.

Each comment stores a stable media ID, a timestamp in **seconds in that original file**, text, author (`user` for app comments, `agent` for MCP/CLI comments), status and revision. These are not timestamps in a later edited timeline. Comments on images use timestamp zero. Text is limited to 5,000 characters. Reference and take files stay unchanged.

Claude can call `list_todo_comments` to read comments with their local media paths. To receive the next batch:

1. Read the current comments and keep the returned `cursor`.
2. Run `todos wait-comments TODO_ID --after CURSOR` as a **background Bash task in an active Claude Code session**, or call `wait_for_todo_comments` through MCP.
3. When feedback arrives, use each event's `comment.media.path`, `timestamp_seconds` and `text` to make the edit. Call `update_todo_comment` with the **comment's revision** to mark it resolved and include an explanation in `resolution`.
4. Start another wait with the returned cursor. If `has_more` is true, consume the following batch immediately. The cursor prevents missing comments posted while the agent is working.

New comments and reopened comments release waiters. Resolutions are readable in the app and appear in `todo_events`. Events persist across app/MCP restarts and include an immutable comment snapshot; use `list_todo_comments` for its current state before acting. Background waiting does not start a closed or disconnected Claude conversation. Keep the Claude Code session running. The recording app can be closed while the agent reads comments, adds feedback or resolves it.

Example prompt for Claude Code:

> Read the open comments for this recording todo. Keep a background `todos wait-comments TODO_ID --after CURSOR` task running using the Open Record Studio MCP launcher. For each new or reopened comment, check its current state, inspect the specified file at timestamp_seconds, make the requested edit and resolve it with a short explanation. Start the next wait using the returned cursor. Do not approve my recording for me.

CLI examples (from the repository):

```sh
npm run --silent todos -- comments TODO_ID
npm run --silent todos -- wait-comments TODO_ID --after CURSOR
npm run --silent todos -- comment TODO_ID \
  --media-type attachment --media-id MEDIA_ID --at 12.5 --text "Review the new title"
npm run --silent todos -- resolve-comment TODO_ID \
  --comment COMMENT_ID --revision 1 --resolution "Made the headline larger"
```

The packaged launcher accepts the same `todos` arguments. `wait-comments` waits indefinitely by default; `--timeout SECONDS` returns exit code 2 with `status: "waiting"` on timeout. A batch returns exit code 0 with `status: "comments"`, `events`, `cursor` and `has_more`. To reopen feedback, use `resolve-comment ... --status open` with its latest revision. Posting is atomic and append-only, so simultaneous comments from the app and agents do not overwrite each other.

## CLI

From this repository:

```sh
npm run --silent todos -- create \
  --title "Record the product introduction" \
  --instructions "Explain the benefit, then introduce the demo. Take as long as you need." \
  --attach "/absolute/path/draft.mp4" \
  --attach "/absolute/path/storyboard.png"

npm run --silent todos -- list
npm run --silent todos -- get TODO_ID
npm run --silent todos -- wait TODO_ID
npm run --silent todos -- events --after 0
```

The packaged launcher supports the same commands without Node or this repository:

```sh
"/Applications/Open Record Studio.app/Contents/Resources/bin/open-record-studio-mcp" \
  todos create --title "Record the intro" --attach "/absolute/path/draft.mp4"

"/Applications/Open Record Studio.app/Contents/Resources/bin/open-record-studio-mcp" \
  todos wait TODO_ID
```

`todos wait` defaults to waiting indefinitely, and returns immediately if already done/cancelled. `--timeout 60` limits a wait to 60 seconds. Exit codes: **0** done, **2** still waiting, **3** cancelled, **1** error. No command is executed from todo content, and no completion callback launches an external program.

`todos update ID --revision N --title TEXT --instructions TEXT` changes a brief. `--status cancelled` cancels; `--status ready` reopens. Every mutation requires the latest `revision` from `get`/`list`. Omitted fields stay unchanged; conflicting writes are rejected. `todos done ID --revision N --take TAKE_ID --notes TEXT` is available only for an already recorded take and should be used only when the user has approved it.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `list_todo_comments` | Read timestamped feedback, media paths, resolutions and the current event cursor. |
| `add_todo_comment` | Add an agent-authored comment to a specific attachment or take. |
| `update_todo_comment` | Resolve or reopen a comment using its own revision; optionally explain the resolution. |
| `wait_for_todo_comments` | Wait for new/reopened comments after a durable cursor, up to 30 seconds per call. |
| `create_todo` | Add a brief and copy local reference attachments. |
| `list_todos` | List all todos, optionally filtering by status. |
| `get_todo` | Read the brief, revision, attachments, takes and approved result. |
| `update_todo` | Edit a brief, cancel or reopen, using `expected_revision`. |
| `complete_todo` | Approve a saved `take_id` using `expected_revision` and optional notes. Requires the user's approval. |
| `wait_for_todo` | Wait for done/cancelled; timeout returns `waiting`. |
| `todo_events` | Read durable events with `after` and `limit` (maximum 500). |

## Storage and recovery

The default macOS inbox is `~/Library/Application Support/Frame Studio/recording-todos`. The desktop, CLI and MCP share this location. `FRAME_DATA_DIR` changes the application profile; `OPEN_RECORD_STUDIO_TODO_DIR` explicitly changes the inbox. Set the same overrides in every process when using a separate inbox.

Every take has its own `.framestudio` project. It contains an indexed `camera.mkv` with webcam + voice, `microphone.flac` for separate voice editing, and the original `camera.webm`. The MKV is a lossless remux of the recorded stream. The project uses webcam footage as its full-frame source; the reference is not baked in and does not determine the project's duration.

When using the separate microphone file in an external editor, mute the camera file's embedded audio to avoid doubling the voice.

Captured chunks are streamed to disk during recording. A failed/interrupted take is not marked done. A recoverable error keeps its directory and reports it in the UI; a dead recording process is shown as **Interrupted** and allows a new take. Inbox writes are locked across processes and committed with atomic replacement; stale revisions are rejected. If a hard crash leaves `.write-lock` without an owner file, recovery waits 30 seconds before considering it abandoned. Recovery itself is serialized by `.lock-recovery`; if a process crashes during that recovery and the inbox stays busy, close all app/MCP/CLI writers before removing that empty directory. Closing the recording dialog is disabled during capture or finalization.

## Verification

```sh
npm run typecheck
node --test tests/todos.test.mjs
npm run build
npx playwright test tests/ui/todos.spec.mjs
npm run test:e2e
```

The todo E2E creates briefs through the CLI/MCP with the app closed, records synthetic camera/audio tracks using Chromium's real `MediaRecorder`, streams them through Electron IPC, finalizes with FFmpeg, verifies decoded video and non-silent audio, and exercises review, selected retakes, done events, both waiters, restart persistence, compact layout and permission denial. It records beyond the two-second reference and verifies the longer output duration. It does not access a physical webcam/microphone or run a live Claude conversation.

Screenshots and completion evidence: `evidence/todos/`. The packaged E2E uses the bundled MCP launcher and the same app that packaging produces.
