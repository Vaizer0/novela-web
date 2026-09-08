// @vitest-environment node
import { describe, it, expect } from "vitest";
import { exactBoundaryRange, splitChunks } from "../TtsPlayer";

describe("splitChunks", () => {
  it("preserves exact offsets", () => {
    const text = "First sentence. Second one!\nTail";
    const chunks = splitChunks(text);
    expect(chunks.map((c) => c.text).join("")).toBe(text);
    for (const chunk of chunks) {
      expect(text.slice(chunk.offset, chunk.offset + chunk.text.length)).toBe(chunk.text);
    }
  });

  it("caps long chunks without losing source text", () => {
    const text = "word ".repeat(120).trimEnd();
    const chunks = splitChunks(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(300);
    expect(chunks.map((c) => c.text).join("")).toBe(text);
  });

  it("returns empty for empty text", () => {
    expect(splitChunks("")).toEqual([]);
  });
});

describe("exactBoundaryRange", () => {
  it("uses the engine-provided charIndex and charLength exactly", () => {
    const event = { charIndex: 6, charLength: 5 } as SpeechSynthesisEvent;
    expect(exactBoundaryRange(event)).toEqual({ start: 6, end: 11 });
  });

  it("does not invent a range when the engine gives no char length", () => {
    const event = { charIndex: 6, charLength: 0 } as SpeechSynthesisEvent;
    expect(exactBoundaryRange(event)).toBeNull();
  });
});
