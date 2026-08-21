// @vitest-environment node
// LIVE: defaultFetcher must recover CF-blocked sources via the Jina fallback.
import { JSDOM } from "jsdom";
import { describe, it, expect, vi } from "vitest";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
vi.stubGlobal("DOMParser", dom.window.DOMParser);
vi.stubGlobal("Node", dom.window.Node);
vi.stubGlobal("Document", dom.window.Document);
vi.stubGlobal("Element", dom.window.Element);

import { defaultFetcher } from "../bridge/http";
import { LuaSource } from "../sourceAdapter";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../assets/plugins");

describe("live CF fallback (network)", () => {
  it("fetches freewebnovel through the automatic Jina fallback", async () => {
    const res = await defaultFetcher("https://freewebnovel.com/", {});
    expect(res.success).toBe(true);
    expect(res.body).not.toMatch(/just a moment/i);
    expect(res.body.length).toBeGreaterThan(10000);
  }, 90000);
  it("loads full book details from a CF-blocked source", async () => {
    const code = readFileSync(join(PLUGIN_DIR, "freewebnovel.lua"), "utf-8");
    const src = await LuaSource.load(code, "freewebnovel.lua", defaultFetcher);
    const details = await src.bookDetails("https://freewebnovel.com/novel/hogwarts-john-wick");
    console.log("title:", details.title, "| chapters via url ok");
    expect(details.title.length).toBeGreaterThan(0);
    expect(details.title.toLowerCase()).toContain("hogwarts");
  }, 120000);
});
