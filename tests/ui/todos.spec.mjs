import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { call } from "../mcp-client.mjs";
import { binary, run, probe } from "../../desktop/media.mjs";
import { audioEnergy } from "../media-checks.mjs";

const exec = promisify(execFile);
const directory = path.resolve(".cache/todos-e2e");
const inbox = path.join(directory, "inbox");
const evidence = path.resolve("evidence/todos");
const env = {
  ...process.env,
  FRAME_DATA_DIR: directory,
  OPEN_RECORD_STUDIO_TODO_DIR: inbox,
};
const cli = async (...args) => {
  const result = await exec(
    process.env.FRAME_MCP_COMMAND || process.execPath,
    [
      ...(process.env.FRAME_MCP_COMMAND ? [] : [path.resolve("mcp/cli.mjs")]),
      "todos",
      ...args,
    ],
    { env },
  );
  return JSON.parse(result.stdout);
};
let app, page, client, todo, source;
const errors = [];
async function launch() {
  app = await electron.launch({
    ...(process.env.FRAME_EXECUTABLE
      ? { executablePath: process.env.FRAME_EXECUTABLE, args: [] }
      : { args: ["."] }),
    env,
    timeout: 30000,
  });
  page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(page.locator("#recording-todos")).toBeVisible();
}
async function close() {
  await app
    ?.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().forEach((w) => w.destroy()),
    )
    .catch(() => {});
  await app?.close().catch(() => {});
  app = null;
}
test.beforeAll(async () => {
  await fs.rm(directory, { recursive: true, force: true });
  await fs.mkdir(directory, { recursive: true });
  await fs.mkdir(evidence, { recursive: true });
  source = path.join(directory, "01-product-walkthrough.mp4");
  await run(await binary("ffmpeg"), [
    "-v",
    "error",
    "-y",
    "-loop",
    "1",
    "-i",
    path.resolve("desktop/assets/demo-screen.png"),
    "-t",
    "2",
    "-vf",
    "scale=960:-2",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    source,
  ]);
  // The CLI creates the initial handoff before any desktop process exists.
  todo = await cli(
    "create",
    "--title",
    "A more personal product demo",
    "--instructions",
    "Introduce the new workflow in your own words.\n\nWalk through what changed, why it matters, and who it helps. Leave a short pause before the closing line.\n\nThe draft is a reference. Keep talking for as long as you need.",
    "--attach",
    source,
    "--attach",
    path.resolve("desktop/assets/demo-camera.png"),
  );
  await cli(
    "create",
    "--title",
    "One quick closing thought",
    "--instructions",
    "Invite viewers to try the workflow for their next video.",
  );
  client = new Client({ name: "claude-handoff-e2e", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.env.FRAME_MCP_COMMAND || process.execPath,
      args: process.env.FRAME_MCP_COMMAND
        ? []
        : [path.resolve("mcp/server.mjs")],
      env,
      stderr: "pipe",
    }),
  );
  expect((await call(client, "get_todo", { todo_id: todo.id })).title).toBe(
    todo.title,
  );
  await launch();
});
test.afterAll(async () => {
  await close();
  await client?.close();
});
test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus && page && !page.isClosed()) {
    console.log(
      "Todo error:",
      await page.locator("#todo-error").textContent(),
      errors,
    );
    await page.screenshot({ path: path.join(evidence, "failure.png") });
  }
});
test.describe.configure({ mode: "serial" });

test("CLI → inbox → real webcam recorder → approved take → MCP and CLI completion", async () => {
  test.setTimeout(90000);
  await page.locator("#recording-todos").click();
  await page.locator(`[data-todo-id="${todo.id}"]`).click();
  await expect(page.locator("#todo-title")).toHaveText(todo.title);
  await expect(page.locator(".todo-header")).toHaveCount(0);
  await expect(page.getByText("A little more you.")).toHaveCount(0);
  const workspace = await page.locator("#todos-dialog").boundingBox();
  const viewport = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
  }));
  expect(workspace.width).toBe(viewport.width);
  expect(workspace.height).toBe(viewport.height - 44);
  await expect
    .poll(() =>
      page
        .locator(`[data-todo-id="${todo.id}"] .todo-thumbnail video`)
        .evaluate((v) => v.readyState),
    )
    .toBeGreaterThanOrEqual(2);
  await expect(page.locator("#todo-media video")).toBeVisible();
  await expect
    .poll(() => page.locator("#todo-media video").evaluate((v) => v.readyState))
    .toBeGreaterThanOrEqual(2);
  // No physical camera or microphone is accessed. Synthetic tracks exercise
  // Chromium's actual MediaRecorder, streamed IPC writes, FFmpeg and playback.
  await page.evaluate(async () => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.src = document.querySelectorAll("#todo-attachments button").length
      ? (await window.studio.listTodos()).todos
          .flatMap((t) => t.attachments)
          .find((a) => a.name === "demo-camera.png").url
      : "";
    await image.decode();
    window.testTodoImage = image;
    window.testTodoStreams = [];
    navigator.mediaDevices.enumerateDevices = async () => [
      {
        kind: "videoinput",
        deviceId: "test-camera",
        label: "Studio camera (test)",
        groupId: "test",
      },
      {
        kind: "audioinput",
        deviceId: "test-mic",
        label: "Studio microphone (test)",
        groupId: "test",
      },
    ];
    navigator.mediaDevices.getUserMedia = async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 480;
      const ctx = canvas.getContext("2d");
      const draw = () => {
        ctx.drawImage(window.testTodoImage, 0, 0, 640, 480);
        ctx.fillStyle = "#d4e3ca";
        ctx.fillRect(0, 476, (Date.now() / 12) % 640, 4);
      };
      draw();
      const timer = setInterval(draw, 33);
      const audio = new AudioContext(),
        oscillator = audio.createOscillator(),
        gain = audio.createGain(),
        output = audio.createMediaStreamDestination();
      oscillator.frequency.value = 280;
      gain.gain.value = 0.12;
      oscillator.connect(gain);
      gain.connect(output);
      oscillator.start();
      await audio.resume();
      const stream = new MediaStream([
        ...canvas.captureStream(30).getVideoTracks(),
        ...output.stream.getAudioTracks(),
      ]);
      window.testTodoStreams.push(stream);
      const stop = stream
        .getVideoTracks()[0]
        .stop.bind(stream.getVideoTracks()[0]);
      stream.getVideoTracks()[0].stop = () => {
        clearInterval(timer);
        oscillator.stop();
        void audio.close();
        stop();
      };
      return stream;
    };
  });
  await page.locator("#todo-enable").click();
  await expect(page.locator("#todo-record")).toBeEnabled();
  await page.screenshot({
    path: path.join(evidence, "01-recording-inbox.png"),
  });
  await page.locator("#todo-record").click();
  await expect(page.locator("#todo-stop")).toBeEnabled();
  await expect(page.locator("#todos-close")).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.locator("#todos-dialog")).toBeVisible();
  await expect
    .poll(() => page.locator("#todo-media video").evaluate((v) => v.ended))
    .toBe(true);
  await expect(page.locator("#todo-live-label")).toHaveText("Still recording");
  await expect(page.locator("#todo-clock")).toHaveText(/00:0[5-9]/, {
    timeout: 12000,
  });
  await page.screenshot({
    path: path.join(evidence, "02-recording-past-reference.png"),
  });
  await page.locator("#todo-stop").click();
  await expect(page.locator("#todo-status")).toHaveText("Ready to review", {
    timeout: 20000,
  });
  await expect(page.locator("#todo-done")).toBeEnabled();
  await expect(page.locator("#todo-done")).toBeInViewport();
  await expect(page.locator("#todo-record")).toBeEnabled();
  await expect(page.locator("#todo-record")).toBeInViewport();
  await expect(page.locator("#todo-review")).toBeVisible();
  const review = await call(client, "get_todo", { todo_id: todo.id });
  expect(review.status).toBe("review");
  expect(review.takes[0].duration).toBeGreaterThan(4.5);
  const media = await probe(review.takes[0].camera_path);
  expect(media.video && media.audio).toBe(true);
  const codecs = JSON.parse(
    await run(await binary("ffprobe"), [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type,codec_name",
      "-of",
      "json",
      review.takes[0].camera_path,
    ]),
  ).streams;
  expect(codecs.find((s) => s.codec_type === "video").codec_name).toBe("h264");
  expect(codecs.find((s) => s.codec_type === "audio").codec_name).toBe("aac");
  expect(
    (await fs.stat(path.join(review.takes[0].project_path, "camera.mp4"))).size,
  ).toBeGreaterThan(0);
  expect(await audioEnergy(review.takes[0].camera_path)).toBeGreaterThan(0.01);
  const microphone = await probe(review.takes[0].microphone_path);
  expect(microphone.audio).toBe(true);
  const project = await call(client, "get_project", {
    project_path: review.takes[0].project_path,
  });
  expect(project.source_duration).toBeGreaterThan(4.5);
  await page.locator("#todo-playback").evaluate((v) => v.play());
  await expect
    .poll(() => page.locator("#todo-playback").evaluate((v) => v.currentTime))
    .toBeGreaterThan(0.2);
  await page.locator("#todo-playback").evaluate((v) => v.pause());
  await page
    .locator("#todo-notes")
    .fill("Use this take. Keep the pause before the closing line.");
  await page.screenshot({ path: path.join(evidence, "03-review-take.png") });
  await page.locator("#todo-comments-tab").click();
  await expect(page.locator("#todo-done")).toBeInViewport();
  const mcpWait = call(client, "wait_for_todo", {
    todo_id: todo.id,
    timeout_seconds: 25,
  });
  const cliWait = cli("wait", todo.id, "--timeout", "25");
  await page.locator("#todo-done").click();
  await expect(page.locator("#todo-completed")).toBeVisible();
  await expect(page.locator("#todo-next")).toBeFocused();
  await expect(page.locator("#todo-next")).toBeInViewport();
  await expect(page.locator("#todo-progress")).toHaveAttribute(
    "aria-valuenow",
    "50",
  );
  await expect(page.locator("#todos-dialog")).toHaveClass(/todo-celebrate/);
  await expect
    .poll(() =>
      page
        .locator(".todo-completion-check path")
        .evaluate((el) => getComputedStyle(el).strokeDashoffset),
    )
    .toBe("0px");
  const [mcpResult, cliResult] = await Promise.all([mcpWait, cliWait]);
  expect(mcpResult.status).toBe("done");
  expect(cliResult.todo.result.camera_path).toBe(review.takes[0].camera_path);
  expect(mcpResult.todo.result.notes).toContain("Keep the pause");
  const events = await call(client, "todo_events", {});
  expect(events.events.filter((e) => e.type === "todo.done")).toHaveLength(1);
  expect(
    await page.evaluate(() =>
      window.testTodoStreams.every((s) =>
        s.getTracks().every((t) => t.readyState === "ended"),
      ),
    ),
  ).toBe(true);
  await page.screenshot({
    path: path.join(evidence, "04-completed-handoff.png"),
  });
  const pending = (await call(client, "list_todos", { status: "ready" }))
    .todos[0];
  const cancelled = await call(client, "update_todo", {
    todo_id: pending.id,
    expected_revision: pending.revision,
    changes: { status: "cancelled" },
  });
  await expect(page.locator("#todo-completion-title")).toHaveText(
    "All recordings complete",
  );
  await expect(page.locator("#todo-next")).toHaveText("Back to editor");
  await expect(page.locator("#todo-progress")).toHaveAttribute(
    "aria-valuenow",
    "100",
  );
  await call(client, "update_todo", {
    todo_id: pending.id,
    expected_revision: cancelled.revision,
    changes: { status: "ready" },
  });
  await expect(page.locator("#todo-completion-progress")).toHaveText(
    "1 of 2 recordings complete",
  );
  await expect(page.locator("#todo-next")).toHaveText("Next recording →");
  await page.locator("#todo-next").click();
  await expect(page.locator("#todo-title")).toHaveText(
    "One quick closing thought",
  );
  await expect(page.locator(".todo-camera-panel")).toBeVisible();
  await expect(page.locator("#todo-completed")).toBeHidden();
  await page.locator(`[data-todo-id="${todo.id}"]`).click();
  await expect(page.locator("#todo-completed")).toBeVisible();
  await fs.writeFile(
    path.join(evidence, "handoff.json"),
    JSON.stringify(
      {
        source:
          "Synthetic webcam and microphone through real MediaRecorder / Electron / FFmpeg",
        referenceDuration: 2,
        recorded: media,
        mcpResult,
        cliResult,
        events,
      },
      null,
      2,
    ),
  );
  expect(errors).toEqual([]);
});

test("retakes preserve originals, inbox survives restart, and compact layout stays usable", async () => {
  await expect(page.locator("#todo-record")).toBeInViewport();
  await expect(page.locator("#todo-record")).toBeEnabled();
  await page.locator("#todo-record").click();
  await expect(page.locator("#todo-clock")).toHaveText("00:02", {
    timeout: 10000,
  });
  await page.locator("#todo-stop").click();
  await expect(page.locator("#todo-take-select option")).toHaveCount(2);
  const review = await call(client, "get_todo", { todo_id: todo.id });
  expect(review.takes).toHaveLength(2);
  await page.locator("#todo-take-select").selectOption(review.takes[0].id);
  await page.locator("#todo-done").click();
  await expect(page.locator("#todo-completed")).toBeVisible();
  expect((await call(client, "get_todo", { todo_id: todo.id })).result.id).toBe(
    review.takes[0].id,
  );
  await close();
  const created = await call(client, "create_todo", {
    title: "A brief created while the app is closed",
    instructions: "Record a quick update.",
  });
  await launch();
  await page.locator("#recording-todos").click();
  await expect(page.locator(`[data-todo-id="${created.id}"]`)).toBeVisible();
  await page.locator(`[data-todo-id="${todo.id}"]`).click();
  await expect(page.locator("#todo-status")).toHaveText("Done");
  await expect(page.locator("#todo-instructions")).toContainText(
    "Introduce the new workflow",
  );
  await expect(page.locator("#todo-take-select option")).toHaveCount(2);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1024, 700),
  );
  expect(
    await page
      .locator(".todo-workspace")
      .evaluate((el) => el.scrollWidth > el.clientWidth),
  ).toBe(false);
  await expect
    .poll(() =>
      page
        .locator("#todo-media video, #todo-playback, #todo-attachments video")
        .evaluateAll((videos) =>
          videos.every((video) => video.readyState >= 2 && !video.seeking),
        ),
    )
    .toBe(true);
  // Reopened media must actually play, including the persisted approved take.
  await page
    .locator("#todo-media video, #todo-playback")
    .evaluateAll(async (videos) => {
      await Promise.all(videos.map((video) => video.play()));
    });
  await expect
    .poll(() =>
      page
        .locator("#todo-media video, #todo-playback")
        .evaluateAll((videos) =>
          videos.every(
            (video) => video.currentTime > 0.2 && video.readyState === 4,
          ),
        ),
    )
    .toBe(true);
  await page
    .locator("#todo-media video, #todo-playback")
    .evaluateAll((videos) => {
      videos.forEach((video) => video.pause());
    });
  await page.screenshot({ path: path.join(evidence, "05-compact-inbox.png") });
  await expect(page.locator("#todo-next")).toBeInViewport();
  await expect(page.locator("#todo-open-completed")).toBeInViewport();
  await page.locator("#todo-open-completed").click();
  await expect(page.locator("#todos-dialog")).toBeHidden();
  await expect(page.locator("#project-title")).toHaveText(todo.title);
  await expect(page.locator("#export")).toBeEnabled();
  expect(errors).toEqual([]);
});

test("permission failure leaves the todo ready and explicit errors are recoverable", async () => {
  await page.locator("#recording-todos").click();
  const pending = (await call(client, "list_todos", { status: "ready" }))
    .todos[0];
  await page.locator(`[data-todo-id="${pending.id}"]`).click();
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException("Camera permission denied", "NotAllowedError");
    };
  });
  await page.locator("#todo-enable").click();
  await expect(page.locator("#todo-error")).toContainText(
    "Camera permission denied",
  );
  await expect(page.locator("#todo-record")).toBeEnabled();
  await expect(page.locator("#todos-close")).toBeEnabled();
  expect((await call(client, "get_todo", { todo_id: pending.id })).status).toBe(
    "ready",
  );
  const change = await call(client, "update_todo", {
    todo_id: pending.id,
    expected_revision: pending.revision,
    changes: { title: "<img src=x onerror=alert(1)>" },
  });
  await expect(page.locator("#todo-title")).toHaveText(change.title);
  expect(await page.locator("#todo-title img").count()).toBe(0);
  await call(client, "update_todo", {
    todo_id: pending.id,
    expected_revision: change.revision,
    changes: { title: pending.title },
  });
  expect(errors).toEqual([]);
});

test("single media stays uncluttered and timestamped comments reach MCP and CLI across restarts", async () => {
  test.setTimeout(90000);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1440, 930),
  );
  const feedbackTodo = await cli(
    "create",
    "--title",
    "A clearer product walkthrough",
    "--instructions",
    "Review the draft and leave feedback at any moment that needs a change.",
    "--attach",
    source,
  );
  await page.locator(`[data-todo-id="${feedbackTodo.id}"]`).click();
  await expect(page.locator("#todo-attachments")).toBeHidden();
  await expect(page.locator("#todo-done")).toBeInViewport();
  await expect(page.locator("#todo-done")).toBeDisabled();
  const doneBox = await page.locator("#todo-done").boundingBox();
  expect(doneBox.y).toBeLessThan(90);
  expect(doneBox.x).toBeGreaterThan(1000);
  const recordBox = await page.locator("#todo-record").boundingBox();
  expect(recordBox.x).toBeGreaterThan(doneBox.x + doneBox.width);
  expect(recordBox.y).toBe(doneBox.y);
  await expect
    .poll(() => page.locator("#todo-media video").evaluate((v) => v.readyState))
    .toBeGreaterThanOrEqual(2);
  await page.locator("#todo-media video").evaluate((v) => {
    v.currentTime = 1.25;
  });
  await expect
    .poll(() => page.locator("#todo-media video").evaluate((v) => v.seeking))
    .toBe(false);
  const { cursor } = await call(client, "list_todo_comments", {
    todo_id: feedbackTodo.id,
  });
  const mcpWait = call(client, "wait_for_todo_comments", {
    todo_id: feedbackTodo.id,
    after: cursor,
    timeout_seconds: 25,
  });
  const cliWait = cli(
    "wait-comments",
    feedbackTodo.id,
    "--after",
    String(cursor),
    "--timeout",
    "25",
  );
  await page.locator("#todo-comment-reference").click();
  await expect(page.locator("#todo-comment-context")).toContainText("00:01.2");
  await page
    .locator("#todo-comment-text")
    .fill("Make this headline easier to read. Hold it for another second.");
  await page.locator("#todo-comment-text").press("Meta+Enter");
  await expect(page.locator(".todo-comment")).toHaveCount(1);
  await expect(
    page.locator(`[data-todo-id="${feedbackTodo.id}"] .todo-item-comments`),
  ).toHaveText("1");
  const [mcpResult, cliResult] = await Promise.all([mcpWait, cliWait]);
  const comment = mcpResult.events[0].comment;
  expect(comment.author).toBe("user");
  expect(comment.timestamp_seconds).toBeCloseTo(1.25, 2);
  expect(comment.media.path).toBe(feedbackTodo.attachments[0].path);
  expect(cliResult.events[0].comment.id).toBe(comment.id);
  await page.locator("#todo-media video").evaluate((v) => v.play());
  await expect
    .poll(() =>
      page.locator("#todo-media video").evaluate((v) => v.currentTime),
    )
    .toBeGreaterThan(1.5);
  await page.locator("#todo-media video").evaluate((v) => v.pause());
  await page.screenshot({
    path: path.join(evidence, "06-reference-comments.png"),
  });
  // An incoming agent resolution must not erase an in-progress user comment.
  await page.locator("#todo-comment-reference").click();
  await page.locator("#todo-comment-text").fill("A draft I am still writing");
  await call(client, "update_todo_comment", {
    todo_id: feedbackTodo.id,
    comment_id: comment.id,
    expected_revision: comment.revision,
    status: "resolved",
    resolution: "Increased the headline size and extended its hold.",
  });
  await expect(page.locator(".todo-comment-resolution")).toContainText(
    "Increased the headline",
  );
  await expect(page.locator("#todo-comment-text")).toHaveValue(
    "A draft I am still writing",
  );
  await page.locator("#todo-comment-cancel").click();
  await page.locator(".todo-comment-jump").click();
  await expect
    .poll(() =>
      page.locator("#todo-media video").evaluate((v) => v.currentTime),
    )
    .toBeCloseTo(1.25, 2);
  await close();
  const saved = await cli("comments", feedbackTodo.id);
  expect(saved.comments[0].status).toBe("resolved");
  const offline = await call(client, "add_todo_comment", {
    todo_id: feedbackTodo.id,
    media_type: "attachment",
    media_id: feedbackTodo.attachments[0].id,
    timestamp_seconds: 0.5,
    text: "Please check the revised opening.",
  });
  await launch();
  await page.locator("#recording-todos").click();
  await page.locator(`[data-todo-id="${feedbackTodo.id}"]`).click();
  await page.locator("#todo-comments-tab").click();
  await expect(page.locator(".todo-comment")).toHaveCount(2);
  await expect(
    page.locator(`[data-comment-id="${offline.comment.id}"]`),
  ).toContainText("Agent");
  await expect(page.locator(".todo-comment-resolution")).toContainText(
    "extended its hold",
  );
  const after = (
    await call(client, "list_todo_comments", { todo_id: feedbackTodo.id })
  ).cursor;
  const reopenedWait = call(client, "wait_for_todo_comments", {
    todo_id: feedbackTodo.id,
    after,
    timeout_seconds: 25,
  });
  await page
    .locator(`[data-comment-id="${comment.id}"] .todo-comment-resolve`)
    .click();
  expect((await reopenedWait).events[0].type).toBe("todo.comment_reopened");
  // Saved takes can be annotated in the large player as well as reference media.
  await page.locator(`[data-todo-id="${todo.id}"]`).click();
  await expect
    .poll(() => page.locator("#todo-playback").evaluate((v) => v.readyState))
    .toBeGreaterThanOrEqual(2);
  await page.locator("#todo-playback").evaluate((v) => {
    v.currentTime = 0.8;
  });
  await page.locator("#todo-comment-take").click();
  await expect(page.locator("#todo-reference-label")).toContainText("Take 1");
  await expect(page.locator("#todo-comment-context")).toContainText("00:00.8");
  await page
    .locator("#todo-comment-text")
    .fill("Trim the pause before this sentence. Keep the delivery natural.");
  await page.locator("#todo-comment-submit").click();
  await expect(page.locator(".todo-comment")).toHaveCount(1);
  const takeComments = await call(client, "list_todo_comments", {
    todo_id: todo.id,
  });
  const completed = await call(client, "get_todo", { todo_id: todo.id });
  expect(takeComments.comments[0].media.path).toBe(
    completed.result.camera_path,
  );
  expect(takeComments.comments[0].media_type).toBe("take");
  expect(takeComments.comments[0].timestamp_seconds).toBeCloseTo(0.8, 2);
  await page.locator(".todo-comment-jump").click();
  await expect
    .poll(() =>
      page.locator("#todo-media video").evaluate((v) => v.currentTime),
    )
    .toBeCloseTo(0.8, 2);
  await expect
    .poll(() => page.locator("#todo-media video").evaluate((v) => v.readyState))
    .toBeGreaterThanOrEqual(2);
  await page.locator("#todo-media video").evaluate((v) => v.play());
  await expect
    .poll(() =>
      page.locator("#todo-media video").evaluate((v) => v.currentTime),
    )
    .toBeGreaterThan(1);
  await page.locator("#todo-media video").evaluate((v) => v.pause());
  await page.screenshot({ path: path.join(evidence, "07-take-comments.png") });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1024, 700),
  );
  await expect(page.locator("#todo-done")).toBeInViewport();
  await page.locator("#todo-comment-reference").click();
  await expect(page.locator("#todo-comment-text")).toBeInViewport();
  await expect(page.locator("#todo-comment-submit")).toBeInViewport();
  expect(
    await page
      .locator(".todo-workspace")
      .evaluate((el) => el.scrollWidth > el.clientWidth),
  ).toBe(false);
  await page
    .locator("#todo-comment-text")
    .fill("Keep this moment, but tighten the transition.");
  await page.screenshot({
    path: path.join(evidence, "08-compact-comment-composer.png"),
  });
  await page.locator("#todo-comment-cancel").click();
  const escaped = await call(client, "add_todo_comment", {
    todo_id: todo.id,
    media_type: "take",
    media_id: completed.result.id,
    timestamp_seconds: 0.5,
    text: "<script>unsafe()</script>",
  });
  await expect(
    page.locator(`[data-comment-id="${escaped.comment.id}"]`),
  ).toContainText("<script>unsafe()</script>");
  expect(await page.locator(".todo-comment script").count()).toBe(0);
  await fs.writeFile(
    path.join(evidence, "comments-handoff.json"),
    JSON.stringify(
      {
        mcpResult,
        cliResult,
        reopened: true,
        offlineComment: offline,
        takeComments,
        deviceSource: "Synthetic webcam/audio; real Electron, MCP and CLI",
      },
      null,
      2,
    ),
  );
  expect(errors).toEqual([]);
});

test("portrait references update the same todo, cancelled items stay hidden, and clips can be removed", async () => {
  test.setTimeout(90000);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1440, 930),
  );
  const cancelled = await cli("create", "--title", "Cancelled recording");
  await cli(
    "update",
    cancelled.id,
    "--revision",
    String(cancelled.revision),
    "--status",
    "cancelled",
  );
  const beforeCount = (await call(client, "list_todos", {})).todos.length;
  let portraitTodo = await cli(
    "create",
    "--title",
    "Your voice, your story",
    "--instructions",
    "Introduce the new workflow in your own words.\n\nExplain what changed and why it matters. Keep the delivery relaxed and leave a short pause before the final line.\n\nThe video is only a reference. Record for as long as you need.",
    "--attach",
    source,
  );
  await page.locator(`[data-todo-id="${portraitTodo.id}"]`).click();
  await expect(page.locator(`[data-todo-id="${cancelled.id}"]`)).toHaveCount(0);
  await expect(
    page.locator(".todo-group-title").filter({ hasText: "Cancelled" }),
  ).toHaveCount(0);
  const portrait = path.join(directory, "portrait-draft.mp4");
  const poster = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 360;
    canvas.height = 640;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#152b21";
    ctx.fillRect(0, 0, 360, 640);
    ctx.fillStyle = "#f5f5eb";
    ctx.font = "36px system-ui";
    ctx.fillText("YOUR VOICE", 26, 120);
    ctx.fillStyle = "#b5cf83";
    ctx.font = "42px system-ui";
    ctx.fillText("Your story.", 26, 174);
    ctx.fillStyle = "#f5f5eb";
    ctx.font = "23px system-ui";
    ctx.fillText("Make it personal.", 26, 290);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const posterPath = path.join(directory, "portrait-poster.png");
  await fs.writeFile(posterPath, Buffer.from(poster, "base64"));
  await run(await binary("ffmpeg"), [
    "-v",
    "error",
    "-y",
    "-loop",
    "1",
    "-i",
    posterPath,
    "-t",
    "2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    portrait,
  ]);
  const firstComment = await call(client, "add_todo_comment", {
    todo_id: portraitTodo.id,
    media_type: "attachment",
    media_id: portraitTodo.attachments[0].id,
    timestamp_seconds: 0.5,
    text: "Reframe this version vertically.",
  });
  portraitTodo = await call(client, "get_todo", { todo_id: portraitTodo.id });
  const updated = await call(client, "update_todo", {
    todo_id: portraitTodo.id,
    expected_revision: portraitTodo.revision,
    changes: { attachments: [portrait] },
  });
  expect(updated.id).toBe(portraitTodo.id);
  expect((await call(client, "list_todos", {})).todos).toHaveLength(
    beforeCount + 1,
  );
  await expect(page.locator(`[data-todo-id="${portraitTodo.id}"]`)).toHaveCount(
    1,
  );
  await expect(page.locator("#todos-dialog")).toHaveAttribute(
    "data-orientation",
    "portrait",
  );
  await expect(page.locator("#todo-attachments")).toBeHidden();
  const reference = await page.locator(".todo-reference").boundingBox();
  const brief = await page.locator(".todo-brief").boundingBox();
  const capture = await page.locator(".todo-capture-column").boundingBox();
  expect(reference.x + reference.width).toBeLessThanOrEqual(brief.x + 1);
  expect(brief.x + brief.width).toBeLessThanOrEqual(capture.x + 1);
  expect(Math.abs(reference.y - brief.y)).toBeLessThan(1);
  expect(Math.abs(brief.y - capture.y)).toBeLessThan(1);
  await page.locator("#todo-comment-reference").click();
  await page.locator("#todo-comment-text").press("Meta+Enter");
  await expect(page.locator(".todo-comment")).toHaveCount(1);
  await page.locator("#todo-comment-text").fill("Hold this opening");
  await page.locator("#todo-comment-text").press("Enter");
  await page
    .locator("#todo-comment-text")
    .pressSequentially("for one more second.");
  await expect(page.locator("#todo-comment-text")).toHaveValue(
    "Hold this opening\nfor one more second.",
  );
  await page.locator("#todo-comment-text").press("Meta+Enter");
  await expect(page.locator(".todo-comment")).toHaveCount(2);
  await expect(
    page.locator(`[data-todo-id="${portraitTodo.id}"] .todo-item-comments`),
  ).toHaveText("2");
  await expect(page.locator("#todo-record")).toBeInViewport();
  await expect(page.locator("#todo-record")).toBeEnabled();
  await expect(page.locator("#todo-done")).toBeInViewport();
  await page.locator("#todo-media video").evaluate((v) => v.play());
  await expect
    .poll(() =>
      page.locator("#todo-media video").evaluate((v) => v.currentTime),
    )
    .toBeGreaterThan(0.2);
  await page.locator("#todo-media video").evaluate((v) => v.pause());
  const bubble = await page
    .locator(`[data-todo-id="${portraitTodo.id}"] .todo-item-comments`)
    .boundingBox();
  const queueBounds = await page.locator("#todo-list").boundingBox();
  expect(bubble.y).toBeGreaterThanOrEqual(queueBounds.y);
  await page.screenshot({
    path: path.join(evidence, "09-portrait-comments.png"),
  });
  // Older feedback still opens the exact original media, then returns to the current reference.
  await page
    .locator(
      `[data-comment-id="${firstComment.comment.id}"] .todo-comment-jump`,
    )
    .click();
  await expect(page.locator("#todo-reference-label")).toHaveText(
    "Earlier reference",
  );
  await expect(page.locator("#todos-dialog")).toHaveAttribute(
    "data-orientation",
    "landscape",
  );
  await page.locator("#todo-back-reference").click();
  await expect(page.locator("#todos-dialog")).toHaveAttribute(
    "data-orientation",
    "portrait",
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1024, 700),
  );
  await expect(page.locator("#todo-record")).toBeInViewport();
  await expect(page.locator("#todo-done")).toBeInViewport();
  expect(
    await page
      .locator(".todo-workspace")
      .evaluate((el) => el.scrollWidth > el.clientWidth),
  ).toBe(false);
  await page.screenshot({
    path: path.join(evidence, "10-compact-portrait.png"),
  });
  // Removing the approved take clears the handoff, while earlier feedback remains readable.
  await page.locator(`[data-todo-id="${todo.id}"]`).click();
  const saved = await call(client, "get_todo", { todo_id: todo.id });
  const approvedId = saved.result.id;
  await page
    .locator(`[data-take-id="${approvedId}"] .todo-remove-clip`)
    .click();
  await expect(page.locator("#todo-status")).toHaveText("Ready to review");
  await expect(page.locator(".todo-saved-clip")).toHaveCount(1);
  const remaining = await call(client, "get_todo", { todo_id: todo.id });
  expect(remaining.result).toBeUndefined();
  expect(remaining.comments[0].media.removed).toBe(true);
  expect((await fs.stat(saved.result.camera_path)).size).toBeGreaterThan(0);
  await page.locator("#todo-comments-tab").click();
  await page.locator(".todo-comment-jump").first().click();
  await expect
    .poll(() => page.locator("#todo-media video").evaluate((v) => v.readyState))
    .toBeGreaterThanOrEqual(2);
  await expect(page.locator(".todo-comment-media").first()).toContainText(
    "Removed clip",
  );
  await page.locator("#todo-recording-tab").click();
  await page.locator(".todo-remove-clip").click();
  await expect(page.locator("#todo-status")).toHaveText("Ready to record");
  await expect(page.locator("#todo-saved-clips")).toBeHidden();
  await expect(page.locator("#todo-done")).toBeDisabled();
  await expect(page.locator("#todo-record")).toBeEnabled();
  await close();
  expect((await cli("get", todo.id)).takes).toHaveLength(0);
  await launch();
  await page.locator("#recording-todos").click();
  await expect(page.locator(`[data-todo-id="${cancelled.id}"]`)).toHaveCount(0);
  await page.locator(`[data-todo-id="${portraitTodo.id}"]`).click();
  await expect(page.locator("#todos-dialog")).toHaveAttribute(
    "data-orientation",
    "portrait",
  );
  expect(errors).toEqual([]);
});
