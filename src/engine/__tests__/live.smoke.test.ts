// @vitest-environment node
// LIVE smoke: engine -> deployed /api/fetch -> freewebnovel search.
// Run explicitly: node node_modules/vitest/vitest.mjs run src/engine/__tests__/live.smoke.test.ts
import { describe, it, expect, vi } from "vitest";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<html><body></body></html>");
vi.stubGlobal("DOMParser", dom.window.DOMParser);
vi.stubGlobal("Node", dom.window.Node);
vi.stubGlobal("Document", dom.window.Document);
vi.stubGlobal("Element", dom.window.Element);
vi.stubGlobal("window", dom.window);

import { LuaSource } from "../sourceAdapter";
import type { PageFetcher } from "../bridge/http";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const proxyFetcher: PageFetcher = async (url, init) => {
  const res = await fetch("https://novela-web.netlify.app/api/fetch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, ...init }),
  });
  return res.json();
};

describe("live data path (network)", () => {
  it("loads asurascans catalog through the deployed proxy", async () => {
    const code = readFileSync(join(__dirname, "../../assets/plugins/asurascans.lua"), "utf8");
    const src = await LuaSource.load(code, "asurascans.lua", proxyFetcher);
    const page = await src.catalogList(0);
    console.log("items:", page.items.length, "hasNext:", page.hasNext);
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items[0].title).not.toBe("");
    expect(page.items[0].url).toContain("asurascans");
  }, 60000);

  it("reports Cloudflare-gated sources with success:false", async () => {
    const res = await proxyFetcher("https://www.freewebnovel.com/", {});
    expect(res.success).toBe(false);
  }, 30000);
});
