// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { LuaSource } from "../sourceAdapter";
import type { PageFetcher } from "../bridge/http";

const ASURA_CHAPTER_PAGE = "<html></html>";

function loadPlugin(name: string): string {
  const plugins = import.meta.glob("../../assets/plugins/*.lua", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
  const key = Object.keys(plugins).find((p) => p.endsWith(`/${name}`));
  if (!key) throw new Error(`plugin not found: ${name}`);
  return plugins[key];
}

function makeFetcher(): { fetcher: PageFetcher; searchCall?: { charset?: string; url?: string } } {
  const fetcher: PageFetcher = vi.fn(async (url, init) => ({
    success: true,
    body: "<html><body></body></html>",
    code: 200,
    headers: {},
  }));
  return { fetcher };
}

describe("source contracts", () => {
  it("search parses bookinfo links into catalog items", async () => {
    const { fetcher } = makeFetcher();
    const src = await LuaSource.load(loadPlugin("piaotia.lua"), "piaotia.lua", fetcher);
    const page = await src.catalogSearch(0, "x");
    expect(page.items.length).toBe(2);
    expect(page.items[0].title).toBe("斗破苍穹");
    expect(page.items[0].url).toBe("https://www.piaotia.com/bookinfo/1/2345/");
    expect(page.items[0].cover).toBe("https://www.piaotia.com/files/article/image/1/2345/2345s.jpg");
    expect(page.items[1].cover).toBe("https://www.piaotia.com/files/article/image/2/3456/3456s.jpg");
  });

  it("chapter list resolves relative links against baseUrl", async () => {
    const { fetcher } = makeFetcher();
    const src = await LuaSource.load(loadPlugin("piaotia.lua"), "piaotia.lua", fetcher);
    const chapters = await src.chapters("https://www.piaotia.com/bookinfo/1/2345/");
    expect(chapters.map((c) => c.title)).toEqual(["第一章", "第二章"]);
    expect(chapters[0].url).toBe("https://www.piaotia.com/html/2345/10001.html");
  });
});

describe("asurascans (manga) contract", () => {
  it("chapter list dedups, renames First Chapter, sorts by number", async () => {
    const { fetcher } = makeFetcher();
    const src = await LuaSource.load(loadPlugin("asurascans.lua"), "asurascans.lua", fetcher);
    // Asura Scans explicitly declares manga content_type in the bundled Lua.
    expect(src.meta.contentType).toBe("manga");
    expect(src.hasGetPageList).toBe(true);

    const chapters = await src.chapters("https://asurascans.com/series/dungeon-reset/");
    expect(chapters.map((c) => c.title)).toEqual(["Chapter 205", "Chapter 206"]);
    expect(chapters[1].uploaded).toBeTypeOf("number");
  });

  it("getPageList extracts image URLs from astro props JSON", async () => {
    const { fetcher } = makeFetcher();
    const src = await LuaSource.load(loadPlugin("asurascans.lua"), "asurascans.lua", fetcher);
    const pages = await src.pageList(ASURA_CHAPTER_PAGE, "https://asurascans.com/dungeon-reset/chapter-206/");
    expect(pages).toEqual([
      "https://img.asura/page-01.webp",
      "https://img.asura/page-02.webp",
    ]);
  });
});
