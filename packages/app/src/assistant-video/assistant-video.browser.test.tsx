import "@/styles/unistyles";
import React from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { FileStreamResult, FileStreamSink } from "@getpaseo/client/internal/daemon-client";
import { i18n } from "@/i18n/i18next";
import { AssistantMarkdownVideo, type AssistantVideoClient } from "./assistant-video";
import { TINY_WEBM_BASE64 } from "./fixtures/tiny-webm";

let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  await i18n.changeLanguage("en");
  container = document.createElement("div");
  container.style.width = "480px";
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

const VIDEO = Uint8Array.from(atob(TINY_WEBM_BASE64), (character) => character.charCodeAt(0));

/** A host whose file stream the test releases chunk by chunk, or fails. */
class HostFiles implements AssistantVideoClient {
  readonly requests: string[] = [];
  private pending: { sink: FileStreamSink; done(error?: Error): void } | null = null;
  streamFile(cwd: string, path: string, sink: FileStreamSink): Promise<FileStreamResult> {
    this.requests.push(`${cwd} ${path}`);
    return new Promise((resolve, reject) => {
      this.pending = {
        sink,
        done: (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve({
            mime: "application/octet-stream",
            size: VIDEO.byteLength,
            path,
            kind: "binary",
            modifiedAt: "2026-10-15T00:00:00.000Z",
          });
        },
      };
    });
  }
  sendHalf(): void {
    const pending = this.take(false);
    pending.sink.begin({ mime: "application/octet-stream", size: VIDEO.byteLength });
    pending.sink.write(VIDEO.subarray(0, VIDEO.byteLength / 2));
  }
  finish(): void {
    const pending = this.take(true);
    pending.sink.write(VIDEO.subarray(VIDEO.byteLength / 2));
    pending.done();
  }
  fail(message: string): void {
    this.take(true).done(new Error(message));
  }
  private take(clear: boolean): { sink: FileStreamSink; done(error?: Error): void } {
    const pending = this.pending;
    if (!pending) throw new Error("No video transfer is open");
    if (clear) this.pending = null;
    return pending;
  }
}

function renderVideo(host: HostFiles, occurrenceKey: string) {
  flushSync(() =>
    root.render(
      <AssistantMarkdownVideo
        source="/Users/me/Movies/Shot 12.webm"
        occurrenceKey={occurrenceKey}
        alt="Shot 12"
        hasLeadingContent={false}
        client={host}
        serverId="mac"
      />,
    ),
  );
}

async function playable(): Promise<HTMLVideoElement> {
  await expect.poll(() => document.querySelector("video")).not.toBeNull();
  const element = document.querySelector("video");
  if (!(element instanceof HTMLVideoElement)) throw new Error("No video player");
  return element;
}

test("a tap brings the original video from the host and plays it in the chat as it is", async () => {
  const host = new HostFiles();
  renderVideo(host, "message-1:video");
  await expect.element(page.getByText("Shot 12")).toBeVisible();
  await expect.element(page.getByTestId("assistant-video-status")).toHaveTextContent("Play video");
  expect(host.requests).toEqual([]);

  await userEvent.click(page.getByTestId("assistant-video"));
  expect(host.requests).toEqual(["/ /Users/me/Movies/Shot 12.webm"]);
  host.sendHalf();
  await expect
    .element(page.getByTestId("assistant-video-status"))
    .toHaveTextContent("Loading video… 50%");
  host.finish();

  const video = await playable();
  expect(video.src.startsWith("blob:")).toBe(true);
  expect(video.controls).toBe(true);
  // The exact bytes the host sent, decoded by the browser's player.
  await expect.poll(() => video.readyState, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  expect(video.duration).toBeGreaterThan(0.5);
  expect(video.videoWidth).toBe(64);
  const played = await fetch(video.src).then((response) => response.arrayBuffer());
  expect(new Uint8Array(played)).toEqual(VIDEO);
});

test("a failed transfer says why and the next tap tries again", async () => {
  const host = new HostFiles();
  renderVideo(host, "message-2:video");
  await userEvent.click(page.getByTestId("assistant-video"));
  host.fail("File changed during transfer");
  await expect
    .element(page.getByTestId("assistant-video-status"))
    .toHaveTextContent("Couldn't load video: File changed during transfer. Tap to try again.");

  await userEvent.click(page.getByTestId("assistant-video"));
  host.sendHalf();
  host.finish();
  const video = await playable();
  await expect.poll(() => video.readyState, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  expect(host.requests).toHaveLength(2);
});

test("a video given as a URL plays directly, without a transfer", async () => {
  const host = new HostFiles();
  const url = URL.createObjectURL(new Blob([VIDEO], { type: "video/webm" }));
  flushSync(() =>
    root.render(
      <AssistantMarkdownVideo
        source={url}
        occurrenceKey="message-3:video"
        hasLeadingContent={false}
        client={host}
      />,
    ),
  );
  const video = await playable();
  await expect.poll(() => video.readyState, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  expect(video.autoplay).toBe(false);
  expect(host.requests).toEqual([]);
});
