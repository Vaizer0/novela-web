// @vitest-environment node
import { describe, it, expect } from "vitest";

function parseGoogleFixture(data: unknown): string {
  const root = data as unknown[];
  const segs = Array.isArray(root?.[0]) ? (root[0] as unknown[]) : [];
  return segs.map((seg) => Array.isArray(seg) ? String(seg[0] ?? "") : "").join("");
}

describe("translation parsing", () => {
  it("joins segmented Google translation output", () => {
    expect(parseGoogleFixture([
      [["Hello", "你好", null, null], [" world", "世界", null, null]],
      null,
    ])).toBe("Hello world");
  });

  it("does not treat an empty Google response as a translation", () => {
    expect(parseGoogleFixture([[], null])).toBe("");
  });
});
