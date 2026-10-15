import { describe, expect, it } from "vitest";
import { assistantVideoType } from "./source";

describe("assistantVideoType", () => {
  it("recognizes the video files the chat plays, by extension and in any case", () => {
    expect(assistantVideoType("/Users/me/Movies/shot 12.MP4")).toEqual({
      extension: ".mp4",
      mime: "video/mp4",
    });
    expect(assistantVideoType("~/clips/take.mov")).toEqual({
      extension: ".mov",
      mime: "video/mp4",
    });
    expect(assistantVideoType("renders/a.m4v")?.mime).toBe("video/mp4");
    expect(assistantVideoType("https://example.com/demo.webm?t=3#start")).toEqual({
      extension: ".webm",
      mime: "video/webm",
    });
  });

  it("leaves images and extensionless paths to the image renderer", () => {
    expect(assistantVideoType("/Users/me/Pictures/photo.jpg")).toBeNull();
    expect(assistantVideoType("/Users/me/videos.d/readme")).toBeNull();
    expect(assistantVideoType("")).toBeNull();
  });
});
