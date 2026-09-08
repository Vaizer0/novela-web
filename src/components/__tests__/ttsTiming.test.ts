// @vitest-environment node
// TTS highlight accuracy primitives: sentence chunking preserves offsets,
// boundary indices resolve to exact words, and pace calibration adapts to the
// real speech cadence.
import { describe, it, expect } from "vitest";
import { boundaryToWordIndex, splitChunks, calibratePace } from "../TtsPlayer";

describe("splitChunks", () => {
  it("splits sentences with correct offsets", () => {
    const chunks = splitChunks("A. B! C?");
    expect(chunks.map((c) => c.text)).toEqual(["A. ", "B! ", "C?"]);
    expect(chunks.map((c) => c.offset)).toEqual([0, 3, 6]);
  });

  it("chunk texts concatenate back to the input", () => {
    const text = "First sentence. Second one!\nNew line? Tail without punctuation";
    const chunks = splitChunks(text);
    expect(chunks.map((c) => c.text).join("")).toBe(text);
    for (const c of chunks) expect(text.slice(c.offset, c.offset + c.text.length)).toBe(c.text);
  });

  it("caps chunk length at 300 chars by splitting at spaces", () => {
    const text = "word ".repeat(120).trimEnd();
    const chunks = splitChunks(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(300);
    expect(chunks.map((c) => c.text).join("")).toBe(text);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].text.startsWith(" ") || chunks[i - 1].text.endsWith(" ")).toBe(true);
    }
  });

  it("returns empty for empty text", () => {
    expect(splitChunks("")).toEqual([]);
  });
});

describe("boundaryToWordIndex", () => {
  it("maps exact boundary offsets to the correct word", () => {
    const text = "Hello brave new world";
    expect(boundaryToWordIndex(text, 0)).toBe(0);
    expect(boundaryToWordIndex(text, 2)).toBe(0);
    expect(boundaryToWordIndex(text, 6)).toBe(1);
    expect(boundaryToWordIndex(text, 12)).toBe(2);
    expect(boundaryToWordIndex(text, 16)).toBe(3);
  });

  it("never returns an out-of-range word index", () => {
    const text = "One two three";
    expect(boundaryToWordIndex(text, -5)).toBe(0);
    expect(boundaryToWordIndex(text, 100)).toBe(2);
  });
});

describe("calibratePace", () => {
  it("blends measured pace into the estimate", () => {
    const prev = 60000 / 165;
    const next = calibratePace(prev, 2000, 5);
    expect(next).toBeCloseTo(prev * 0.65 + 400 * 0.35, 10);
  });

  it("ignores samples shorter than 500ms", () => {
    expect(calibratePace(363.6, 499, 5)).toBe(363.6);
  });

  it("ignores zero-word samples", () => {
    expect(calibratePace(363.6, 2000, 0)).toBe(363.6);
  });

  it("moves toward the measured cadence after repeated samples", () => {
    let pace = 60000 / 165;
    for (let i = 0; i < 20; i++) pace = calibratePace(pace, 1000, 2);
    expect(pace).toBeGreaterThan(490);
    expect(pace).toBeLessThan(510);
  });
});
