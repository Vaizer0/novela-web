// @vitest-environment node
// TTS highlight accuracy primitives: sentence chunking keeps utterances short
// and offsets round-trip to the original paragraph; pace calibration EMA-blends
// measured ms-per-word toward the engine's real cadence.
import { describe, it, expect } from "vitest";
import { splitChunks, calibratePace } from "../TtsPlayer";

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
    for (const c of chunks) {
      expect(text.slice(c.offset, c.offset + c.text.length)).toBe(c.text);
    }
  });

  it("caps chunk length at 300 chars by splitting at spaces", () => {
    const text = "word ".repeat(120).trimEnd(); // 600 chars, no sentence ends
    const chunks = splitChunks(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(300);
    // no word torn apart: every split lands on a space boundary
    expect(chunks.map((c) => c.text).join("")).toBe(text);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].text.startsWith(" ") || chunks[i - 1].text.endsWith(" ")).toBe(true);
    }
  });

  it("returns empty for empty text", () => {
    expect(splitChunks("")).toEqual([]);
  });
});

describe("calibratePace", () => {
  it("blends measured pace into the estimate (0.6/0.4 EMA)", () => {
    // 5 words in 2000ms -> actual 400ms/word; prev 363.6 (60000/165)
    const prev = 60000 / 165;
    const next = calibratePace(prev, 2000, 5);
    expect(next).toBeCloseTo(prev * 0.6 + 400 * 0.4, 10);
  });

  it("ignores samples shorter than 500ms", () => {
    expect(calibratePace(363.6, 499, 5)).toBe(363.6);
  });

  it("ignores zero-word samples", () => {
    expect(calibratePace(363.6, 2000, 0)).toBe(363.6);
  });

  it("moves toward the measured cadence after repeated samples", () => {
    let pace = 60000 / 165;
    for (let i = 0; i < 20; i++) pace = calibratePace(pace, 1000, 2); // real: 500ms/word
    expect(pace).toBeGreaterThan(490);
    expect(pace).toBeLessThan(510);
  });
});
