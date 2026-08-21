// @vitest-environment node
// Cloudflare detection + FlareSolverr fallback behavior of defaultFetcher.
import { describe, it, expect, vi, afterEach } from "vitest";

// no localStorage in node env — bypass URL helpers fall back to ""
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
    // a page merely mentioning cloudflare in the footer must not be flagged
    expect(isCfBlocked(env({ body: "<html><body>protected by cloudflare cdn</body></html>".repeat(100) }))).toBe(false);
    expect(isCfBlocked(env({ success: false, code: -1, body: "" }))).toBe(false);
  });
});

describe("defaultFetcher CF fallback", () => {
  afterEach(() => vi.unstubAllGlobals());


  it("retries through Jina automatically and returns rendered content", async () => {
    let call = 0;
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        call++;
        urls.push(String(url));
        const body = String(init?.body ?? "");
        if (call === 2) {
          // Jina retry is routed through our function; assert target + format
          expect(body).toContain("r.jina.ai");
          expect(body).toContain("x-return-format");
          return Response.json({
            success: true,
            code: 200,
            body: "<html><body>real content</body></html>",
            headers: {},
          });
        }
        // first call = Netlify function primary attempt: CF challenge
        return Response.json({ success: false, code: 403, body: "Just a moment...", headers: {} });
      }),
    );
    const { defaultFetcher } = await import("../bridge/http");
    const res = await defaultFetcher("https://novelfire.net/", {});
    expect(call).toBe(2);
    expect(res.success).toBe(true);
    expect(res.body).toContain("real content");
  }, 15000);
});
