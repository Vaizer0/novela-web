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

  it("annotates CF-blocked responses with actionable guidance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ success: false, code: 403, body: "<title>Just a moment...</title>", headers: {} }),
      ),
    );
    const { defaultFetcher } = await import("../bridge/http");
    const res = await defaultFetcher("https://freewebnovel.com/", {});
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Cloudflare-blocked/);
    expect(res.error).toMatch(/Settings → Cloudflare/);
  });

  it("retries through a configured bypass proxy and returns its result", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        call++;
        if (call === 1) {
          // Netlify function: CF challenge
          return Response.json({ success: false, code: 403, body: "Just a moment...", headers: {} });
        }
        // localStorage write happened before bypass attempt; assert endpoint shape
        const body = JSON.parse(String(init?.body)) as { cmd?: string };
        expect(body.cmd).toBe("request.get");
        return Response.json({
          status: "ok",
          solution: { status: 200, response: "<html><body>real content</body></html>", cookies: [] },
        });
      }),
    );
    // seed bypass URL without localStorage: stub the module getter via storage shim
    const store: Record<string, string> = { bypassProxyUrl: "http://localhost:8191" };
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => (store[k] = v),
    });
    const { defaultFetcher } = await import("../bridge/http");
    const res = await defaultFetcher("https://novelfire.net/", {});
    expect(call).toBe(2);
    expect(res.success).toBe(true);
    expect(res.body).toContain("real content");
  }, 15000);
});
