import { describe, expect, it } from "vitest";
import { BlankFinalTranscriptError, resolveFinalTranscript } from "@/hooks/use-dictation.shared";

describe("resolveFinalTranscript", () => {
  it("returns the engine's final words unchanged apart from surrounding whitespace", () => {
    const engine = "  Please keep exactly these words. 42 blue cubes. No, wait, 43 blue cubes.\n";
    expect(resolveFinalTranscript(engine)).toBe(
      "Please keep exactly these words. 42 blue cubes. No, wait, 43 blue cubes.",
    );
  });

  it("keeps corrections and hesitations the engine transcribed", () => {
    expect(resolveFinalTranscript("um I think Tuesday, no, Wednesday")).toBe(
      "um I think Tuesday, no, Wednesday",
    );
  });

  it("treats a blank final as an explicit error instead of substituting provisional text", () => {
    expect(() => resolveFinalTranscript("")).toThrow(BlankFinalTranscriptError);
    expect(() => resolveFinalTranscript(" \n\t ")).toThrow(BlankFinalTranscriptError);
    expect(() => resolveFinalTranscript("")).toThrow(/Provisional text was not inserted/);
  });
});
