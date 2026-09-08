// @vitest-environment node
// Cloudflare detection + FlareSolverr fallback behavior of defaultFetcher.
import { describe, it, expect, vi, afterEach } from "vitest";

import { isCfBlocked } from "../../lib/bypass";
import type { FetchEnvelope } from "../bridge/http";

function env(partial: Partial<FetchEnvelope>): FetchEnvelope {
  return { success: true, body: "", code: 200, headers: {}, ...partial };
}

describe("isCfBlocked", () => {
  it("detects challenge pages", () => {
    expect(isCfBlocked(env({ success: false, code: 403, body: "<title>Just a moment...</title>" }))).toBe(true);
    expect(isCfBlocked(env({ success: true, body: "<script src='/cdn-cgi/challenge-platform/x'>" }))).toBe(true);
    expect(isCfBlocked(env({ success: false, code: 503, body: "" }))).toBe(true);
  });

  it("does not flag normal content", () => {
    expect(isCfBlocked(env({ body: "<html><body>Chapter 1 text</body></html>" }))).toBe(false);
    expect(isCfBlocked(env({ body: "<html><body>protected by cloudflare cdn</body></html>".repeat(100) }))).toBe(false);
    expect(isCfBlocked(env({ success: false, code: -1, body: "" }))).toBe(false);
  });
});

describe("defaultFetcher CF fallback", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("retries through Jina automatically and returns rendered content", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const target = String(url);
        urls.push(target);

        // The test is intentionally sequence-independent: implementation may
        // add/reorder public GET fallbacks, but it must eventually try Jina.
        if (target.includes("r.jina.ai/")) {
          return Response.json({
            success: true,
            code: 200,
            body: "<html><body>real content</body></html>",
            headers: {},
          });
        }

        // Netlify/public fallback attempts before Jina simulate a CF challenge.
        const requestBody = String(init?.body ?? "");
        if (target.includes(".netlify/functions/fetch") && requestBody.includes("novelfire.net")) {
          return Response.json({ success: false, code: 403, body: "Just a moment...", headers: {} });
        }
        if (
          target.includes("api.allorigins.win") ||
          target.includes("corsproxy.io")
        ) {
          return Response.json({ success: false, code: 403, body: "Just a moment...", headers: {} });
        }

        return Response.json({ success: false, code: 403, body: "Just a moment...", headers: {} });
      }),
    );

    const { defaultFetcher } = await import("../bridge/http");
    const res = await defaultFetcher("https://novelfire.net/", {});
    expect(urls.some((url) => url.includes("r.jina.ai/"))).toBe(true);
    expect(res.success).toBe(true);
    expect(res.body).toContain("real content");
  }, 15000);
});
