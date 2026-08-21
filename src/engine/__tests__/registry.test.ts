// @vitest-environment node
import "fake-indexeddb/auto";
// Registry contract: bundled plugin corpus parses into unique, usable sources.
import { describe, it, expect, vi } from "vitest";

// jsdom globals not needed here, but localStorage must exist.
vi.stubGlobal("localStorage", {
  store: new Map<string, string>(),
  getItem(k: string) {
    return (this as { store: Map<string, string> }).store.get(k) ?? null;
  },
  setItem(k: string, v: string) {
    (this as { store: Map<string, string> }).store.set(k, v);
  },
});

import { listSources, metaFromCode } from "../registry";

describe("plugin registry", () => {
  it("lists ≥50 bundled sources with unique ids and non-empty names", async () => {
    const sources = await listSources();
    const bundled = sources.filter((s) => s.bundled);
    expect(bundled.length).toBeGreaterThanOrEqual(50);
    const ids = bundled.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of bundled) {
      expect(s.name).not.toBe("");
      expect(s.getCode).toBeTypeOf("function");
    }
    const byId = new Map(bundled.map((s) => [s.id, s]));
    expect(byId.get("freewebnovel")?.name.toLowerCase()).toContain("free");
    expect(byId.get("asurascans")).toBeTruthy();
    expect(byId.get("piaotia")).toBeTruthy();
  });

  it("falls back to filename-derived id when header lacks id", () => {
    const meta = metaFromCode('name = "No Id Here"\nbaseUrl = "https://x"', "mystery.lua");
    expect(meta.id).toBe("lua_mystery");
    expect(meta.name).toBe("No Id Here");
  });

  it("installs and removes custom plugins, merging them into the list", async () => {
    const { installCustomPlugin, removeCustomPlugin } = await import("../registry");
    const rec = await installCustomPlugin("myplugin.lua", 'id = "my_custom"\nname = "My Custom"\n');
    expect(rec.id).toBe("my_custom");
    let sources = await listSources();
    const added = sources.find((s) => s.id === "my_custom");
    expect(added?.name).toBe("My Custom");
    expect(added?.bundled).toBe(false);
    await removeCustomPlugin("my_custom");
    sources = await listSources();
    expect(sources.find((s) => s.id === "my_custom")).toBeUndefined();
  });
});
