// @vitest-environment node
// wasmoon's emscripten glue breaks under vitest's jsdom environment
// (document.currentScript shim → fileURLToPath throw), so we run in node and
// install the DOM globals the HTML bridge needs from jsdom manually.
import { JSDOM } from "jsdom";
import { describe, it, expect, vi } from "vitest";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
vi.stubGlobal("DOMParser", dom.window.DOMParser);
vi.stubGlobal("Node", dom.window.Node);
vi.stubGlobal("Document", dom.window.Document);
vi.stubGlobal("Element", dom.window.Element);

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { LuaSource } from "../sourceAdapter";
import type { PageFetcher, FetchEnvelope } from "../bridge/http";

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../assets/plugins");

function loadPlugin(name: string): string {
  return readFileSync(join(PLUGIN_DIR, name), "utf-8");
}

function pluginNames(): string[] {
  return readdirSync(PLUGIN_DIR).filter((f) => f.endsWith(".lua"));
}

function ok(body: string): FetchEnvelope {
  return { success: true, body, code: 200, headers: {} };
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const FWN_SEARCH = `
<div class="serach-result">
  <div class="li-row">
    <div class="pic"><img src="/covers/one.jpg"></div>
    <div class="tit"><a href="/book/1571027106/">Martial Peak</a></div>
    <div class="core"><span>3.8</span></div>
  </div>
  <div class="li-row">
    <div class="pic"><img src="https://cdn.example.com/covers/two.jpg"></div>
    <div class="tit"><a href="//freewebnovel.com/book/two/">Second Book</a></div>
    <div class="core"><span></span></div>
  </div>
</div>`;

const FWN_CHAPTERS_AJAX_PAGE1 = JSON.stringify({
  totalPage: 2,
  html: `<div>
    <a href="/book/x/chapter-2/" title="Chapter 2">Chapter 2</a>
    <a href="/book/x/chapter-1/" title="Chapter 1">Chapter 1</a>
  </div>`,
});

const FWN_CHAPTERS_AJAX_PAGE2 = JSON.stringify({
  totalPage: 2,
  html: `<a href="/book/x/chapter-0/prologue/" title="Prologue">Prologue</a>`,
});

const FWN_CHAPTER_PAGE = `
<html><body>
<script>tracker();</script>
<div class="ads">AD</div>
<div class="chapter-nav">next</div>
<h4>Chapter 1</h4>
<div class="txt">
  <p>  First   paragraph here. </p>
  <p>Read at freewebnovel.com — do not read there.</p>
  <script>evil()</script>
  <p>Second paragraph.</p>
</div>
</body></html>`;

const PIAOTIA_SEARCH = `
<html><body>
<a href="/bookinfo/1/2345/">斗破苍穹</a>
<a href="/bookinfo/2/3456.html">武动乾坤</a>
</body></html>`;

const PIAOTIA_CHAPTER_LIST = `
<div class="centent"><ul>
<li><a href="/html/2345/10001.html">第一章</a></li>
<li><a href="/html/2345/10002.html">第二章</a></li>
</ul></div>`;

const ASURA_BOOK_PAGE = `
<html><head><title>x</title></head><body>
<h1>Dungeon Reset</h1>
<img src="https://asura-images/covers/dungeon.jpg">
<a href="/series/dungeon-reset/chapter/206/" title="Chapter 206 Aug 9, 2026">Chapter 206 Aug 9, 2026</a>
<a href="/series/dungeon-reset/chapter/205/" title="Chapter 205">Chapter 205</a>
<a href="/series/dungeon-reset/chapter/206/" title="dup">dup</a>
<a href="/">Last chapter</a>
</body></html>`;

const ASURA_CHAPTER_PAGE = `
<astro-island props="{&quot;pages&quot;:[1,[[0,{&quot;url&quot;:&quot;https://img.asura/page-01.webp&quot;,&quot;width&quot;:800,&quot;height&quot;:1200}],[0,{&quot;url&quot;:&quot;https://img.asura/page-02.webp&quot;,&quot;width&quot;:800,&quot;height&quot;:1200}]]]}"></astro-island>`;

// ── Mock fetcher ────────────────────────────────────────────────────────────

function makeFetcher(): { fetcher: PageFetcher; calls: { url: string; charset?: string; headers?: Record<string, string> }[] } {
  const calls: { url: string; charset?: string; headers?: Record<string, string> }[] = [];
  const fetcher: PageFetcher = async (url, init) => {
    calls.push({ url, charset: init.charset, headers: init.headers });
    if (url.includes("freewebnovel.com/search")) return ok(FWN_SEARCH);
    if (url.includes("ajax=chapters&page=1")) return ok(FWN_CHAPTERS_AJAX_PAGE1);
    if (url.includes("ajax=chapters&page=2")) return ok(FWN_CHAPTERS_AJAX_PAGE2);
    if (url.includes("freewebnovel.com/book/x/chapter-1")) return ok(FWN_CHAPTER_PAGE);
    if (url.includes("piaotia.com/modules/article/search.php")) return ok(PIAOTIA_SEARCH);
    if (url.includes("piaotia.com/html/")) return ok(PIAOTIA_CHAPTER_LIST);
    if (url.includes("asurascans.com/dungeon-reset") && url.includes("/chapter-")) return ok(ASURA_CHAPTER_PAGE);
    if (url.includes("asurascans.com")) return ok(ASURA_BOOK_PAGE);
    return { success: false, body: "", code: 404, headers: {} };
  };
  return { fetcher, calls };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("plugin corpus sanity", () => {
  it("bundled plugins are present", () => {
    const names = pluginNames();
    expect(names.length).toBeGreaterThanOrEqual(50);
    expect(names).toContain("freewebnovel.lua");
    expect(names).toContain("piaotia.lua");
    expect(names).toContain("asurascans.lua");
  });
});

describe("freewebnovel contract", () => {
  it("search returns items with title/url/cover/rating and hasNext", async () => {
    const { fetcher } = makeFetcher();
    const src = await LuaSource.load(loadPlugin("freewebnovel.lua"), "freewebnovel.lua", fetcher);
    expect(src.meta.id).toBe("freewebnovel");
    expect(src.hasParsePage).toBe(true);

    const page = await src.catalogSearch(0, "martial");
    expect(page.items.length).toBe(2);
    expect(page.hasNext).toBe(true);
    expect(page.items[0]).toMatchObject({
      title: "Martial Peak",
      url: "https://freewebnovel.com/book/1571027106/",
      cover: "https://freewebnovel.com/covers/one.jpg",
      rating: "3.8",
      contentType: "",
    });
    // protocol-relative href resolved
    expect(page.items[1].url).toBe("https://freewebnovel.com/book/two/");
    // empty rating → null
    expect(page.items[1].rating).toBeNull();
  });

  it("chapters paginate through parsePage until totalPages", async () => {
    const { fetcher } = makeFetcher();
    const src = await LuaSource.load(loadPlugin("freewebnovel.lua"), "freewebnovel.lua", fetcher);
    const chapters = await src.chapters("https://freewebnovel.com/book/x/");
    expect(chapters.map((c) => c.title)).toEqual(["Chapter 2", "Chapter 1", "Prologue"]);
    expect(chapters[0].url).toBe("https://freewebnovel.com/book/x/chapter-2/");
  });

  it("chapter text strips scripts/ads and applies regex transforms", async () => {
    const { fetcher } = makeFetcher();
    const src = await LuaSource.load(loadPlugin("freewebnovel.lua"), "freewebnovel.lua", fetcher);
    const text = await src.chapterText(FWN_CHAPTER_PAGE, "https://freewebnovel.com/book/x/chapter-1/");
    expect(text).toMatch(/First\s+paragraph here\./);
    expect(text).toContain("Second paragraph.");
    expect(text).not.toContain("evil");
    expect(text).not.toContain("AD");
    expect(text?.toLowerCase()).not.toContain("read at freewebnovel");
  });

  it("filter list parses select/sort schema", async () => {
    const { fetcher } = makeFetcher();
    const src = await LuaSource.load(loadPlugin("freewebnovel.lua"), "freewebnovel.lua", fetcher);
    const filters = await src.filters();
    expect(filters.length).toBeGreaterThan(0);
    for (const f of filters) {
      expect(f.key).not.toBe("");
      if (f.kind === "select" || f.kind === "sort" || f.kind === "checkbox" || f.kind === "tristate") {
        expect(f.options.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("piaotia (GBK) contract", () => {
  it("search encodes query in GBK and passes charset to the proxy", async () => {
    const { fetcher, calls } = makeFetcher();
    const src = await LuaSource.load(loadPlugin("piaotia.lua"), "piaotia.lua", fetcher);
    expect(src.meta.charset).toBe("GBK");

    await src.catalogSearch(0, "搜索");
    const searchCall = calls.find((c) => c.url.includes("searchkey="));
    expect(searchCall).toBeDefined();
    // GBK bytes for 搜索: CB D1 CB F7 → %CB%D1+%CB%F7 with '+' for space handling
    expect(searchCall!.url).toContain("searchkey=%CB%D1%CB%F7");
    expect(searchCall!.charset?.toUpperCase()).toBe("GBK");
  });

  it("search parses bookinfo links into catalog items", async () => {
    const { fetcher } = makeFetcher();
    const src = await LuaSource.load(loadPlugin("piaotia.lua"), "piaotia.lua", fetcher);
    const page = await src.catalogSearch(0, "x");
    expect(page.items.length).toBe(2);
    expect(page.items[0].title).toBe("斗破苍穹");
    expect(page.items[0].url).toBe("https://www.piaotia.com/bookinfo/1/2345/");
    // cover built from /FOLDERID/BOOKID/ pattern
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
    // Plugin doesn't declare content_type (Android readContentType → ""); manga
    // mode is detected via getPageList presence.
    expect(src.meta.contentType).toBe("");
    expect(src.hasGetPageList).toBe(true);

    const chapters = await src.chapters("https://asurascans.com/series/dungeon-reset/");
    expect(chapters.map((c) => c.title)).toEqual(["Chapter 205", "Chapter 206"]);
    expect(chapters[1].uploaded).toBeTypeOf("number");
  });

  it("getPageList extracts image URLs from astro props JSON", async () => {
    const { fetcher } = makeFetcher();
    const src = await LuaSource.load(loadPlugin("asurascans.lua"), "asurascans.lua", fetcher);
    const pages = await src.pageList(ASURA_CHAPTER_PAGE, "https://asurascans.com/dungeon-reset/chapter-206/");
    // Plugin flattens astro props to plain CDN URL strings in page order.
    expect(pages).toEqual([
      "https://img.asura/page-01.webp",
      "https://img.asura/page-02.webp",
    ]);
  });
});
