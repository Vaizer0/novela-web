// @vitest-environment node
// EPUB export integrity: builds a real zip through buildEpubZip with the
// freewebnovel fixtures and validates ODF/EPUB structural requirements.
import { JSDOM } from "jsdom";
import { describe, it, expect, vi, beforeAll } from "vitest";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
vi.stubGlobal("DOMParser", dom.window.DOMParser);
vi.stubGlobal("Node", dom.window.Node);
vi.stubGlobal("Document", dom.window.Document);
vi.stubGlobal("Element", dom.window.Element);

import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../assets/plugins");

function ok(body: string) {
  return { success: true as const, body, code: 200, headers: {} };
}

const FWN_BOOK_PAGE = `
<html><body>
<h1 class="tit">Martial Peak</h1>
<div class="pic"><img src="/covers/mp.jpg"></div>
<div class="m-desc"><p class="txt">A journey of cultivation.</p></div>
</body></html>`;

const FWN_CHAPTERS_AJAX = JSON.stringify({
  totalPage: 1,
  html: `<a href="/book/x/chapter-1/" title="Chapter 1">Chapter 1</a>`,
});

const FWN_CHAPTER_PAGE = `
<html><body><div class="txt">
<p>First paragraph.</p>
<p>Second &lt;special&gt; paragraph.</p>
</div></body></html>`;

const fetcher = async (url: string) => {
  if (url.includes("ajax=chapters")) return ok(FWN_CHAPTERS_AJAX);
  if (url.includes("freewebnovel.com/book/x/") && !url.includes("chapter")) return ok(FWN_BOOK_PAGE);
  if (url.includes("chapter-1")) return ok(FWN_CHAPTER_PAGE);
  return { success: false, body: "", code: 404, headers: {} };
};

import { db } from "../../db/db";
import { buildEpubZip } from "../../lib/epubExport";
import type { SourceEntry } from "../../engine/registry";
import { LuaSource } from "../../engine/sourceAdapter";

const entry: SourceEntry = {
  id: "freewebnovel",
  name: "FreeWebNovel",
  version: "1.0",
  baseUrl: "https://www.freewebnovel.com/",
  icon: "",
  language: "en",
  contentType: "",
  bundled: true,
  getCode: async () => readFileSync(join(PLUGIN_DIR, "freewebnovel.lua"), "utf-8"),
};

describe("EPUB export", () => {
  beforeAll(async () => {
    await db.open();
    // Dexie v2 schema: translation cache table exists after upgrade
    expect(db.tables.map((t) => t.name)).toContain("translationCache");
  });

  it("builds a structurally valid EPUB 3 zip", async () => {
    const src = await LuaSource.load(
      readFileSync(join(PLUGIN_DIR, "freewebnovel.lua"), "utf-8"),
      "freewebnovel.lua",
      fetcher,
    );
    const zip = await buildEpubZip(entry, "https://www.freewebnovel.com/book/x/", undefined, src);

    // mimetype must be the first entry (ODF requirement)
    const names = Object.keys(zip.files);
    console.log("zip entries:", JSON.stringify(names));
    expect(names[0]).toBe("mimetype");
    expect(await zip.file("mimetype")!.async("string")).toBe("application/epub+zip");

    const container = await zip.file("META-INF/container.xml")!.async("string");
    expect(container).toContain('full-path="OEBPS/content.opf"');

    const opf = await zip.file("OEBPS/content.opf")!.async("string");
    expect(opf).toContain("<dc:title>Martial Peak</dc:title>");
    expect(opf).toContain('properties="nav"');
    expect(opf).toContain('<itemref idref="ch1"/>');
    expect(opf).toContain("urn:uuid:");

    const nav = await zip.file("OEBPS/nav.xhtml")!.async("string");
    expect(nav).toContain('href="ch1.xhtml"');
    expect(nav).toContain("Chapter 1");

    const ch = await zip.file("OEBPS/ch1.xhtml")!.async("string");
    expect(ch).toContain("<p>First paragraph.</p>");
    // XML escaping must survive into the xhtml body
    expect(ch).toContain("Second &lt;special&gt; paragraph.");
    expect(ch).toContain("</html>");

    // Round-trip: reload and confirm it parses as a zip with all members
    const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    const reloaded = await JSZip.loadAsync(buf);
    expect(Object.keys(reloaded.files)).toEqual(
      expect.arrayContaining([
        "mimetype",
        "META-INF/container.xml",
        "OEBPS/content.opf",
        "OEBPS/nav.xhtml",
        "OEBPS/ch1.xhtml",
      ]),
    );
  }, 60000);

  it("persists fetched chapter text to the cache during export", async () => {
    const cached = await db.chapterCache.get("https://freewebnovel.com/book/x/chapter-1/");
    expect(cached?.text).toContain("First paragraph");
  });
});
