import { LuaSource } from "./sourceAdapter";
import { defaultFetcher } from "./bridge/http";
import { db, type CustomPlugin } from "../db/db";

/**
 * Source registry: bundled plugins (loaded via import.meta.glob) merged with
 * user-installed custom plugins (Dexie). List metadata comes from a regex pass
 * over the script header; the Lua VM only spins up when a source is actually
 * used (getSourceRuntime).
 */

export interface SourceMeta {
  id: string;
  name: string;
  version: string;
  baseUrl: string;
  icon: string;
  language: string;
  contentType: string;
}

export interface SourceEntry extends SourceMeta {
  bundled: boolean;
  getCode: () => Promise<string>;
}
const pluginModules = import.meta.glob("../assets/plugins/*.lua", {
  query: "?raw",
  import: "default",
}) as Record<string, () => Promise<string>>;

function headerField(code: string, key: string): string {
  const m = code.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m"));
  return m?.[1] ?? "";
}

export function metaFromCode(code: string, fileName: string): SourceMeta {
  const id = headerField(code, "id") || `lua_${fileName.replace(/\.lua$/i, "")}`;
  return {
    id,
    name: headerField(code, "name") || id,
    version: headerField(code, "version"),
    baseUrl: headerField(code, "baseUrl"),
    icon: headerField(code, "icon"),
    language: headerField(code, "language"),
    contentType: headerField(code, "content_type"),
  };
}

const ENABLED_KEY = "enabledSources";

/** null = everything enabled (fresh install default). */
export function getEnabledSources(): Set<string> | null {
  const raw = localStorage.getItem(ENABLED_KEY);
  if (raw === null) return null;
  try {
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return null;
  }
}

export function setEnabledSources(ids: Set<string>): void {
  localStorage.setItem(ENABLED_KEY, JSON.stringify([...ids]));
}

let bundledCache: SourceEntry[] | null = null;
let customCache: SourceEntry[] | null = null;

async function bundledEntries(): Promise<SourceEntry[]> {
  if (!bundledCache) {
    bundledCache = await Promise.all(
      Object.entries(pluginModules).map(async ([path, load]) => {
        const fileName = path.split("/").pop() ?? path;
        const code = await load();
        return { ...metaFromCode(code, fileName), bundled: true, getCode: () => Promise.resolve(code) };
      }),
    );
  }
  return bundledCache;
}

async function customEntries(): Promise<SourceEntry[]> {
  if (!customCache) {
    const plugins = await db.customPlugins.toArray();
    customCache = plugins.map((p) => ({
      ...metaFromCode(p.code, p.name),
      bundled: false,
      getCode: () => Promise.resolve(p.code),
    }));
  }
  return customCache;
}

function invalidateCustom(): void {
  customCache = null;
}

/** All sources (bundled + custom), sorted by name. */
export async function listSources(): Promise<SourceEntry[]> {
  const [bundled, custom] = await Promise.all([bundledEntries(), customEntries()]);
  return [...bundled, ...custom].sort((a, b) => a.name.localeCompare(b.name));
}

const runtimeCache = new Map<string, LuaSource>();

/** LuaSource for a registry entry; one runtime per source id, cached. */
export async function getSourceRuntime(entry: SourceEntry): Promise<LuaSource> {
  const cached = runtimeCache.get(entry.id);
  if (cached) return cached;
  const src = await LuaSource.load(await entry.getCode(), `${entry.id}.lua`, defaultFetcher);
  runtimeCache.set(entry.id, src);
  return src;
}

export function dropRuntime(id: string): void {
  runtimeCache.delete(id);
}

export async function installCustomPlugin(name: string, code: string): Promise<CustomPlugin> {
  const meta = metaFromCode(code, name);
  const record: CustomPlugin = { id: meta.id, name, code, addedAt: Date.now() };
  await db.customPlugins.put(record);
  dropRuntime(record.id);
  invalidateCustom();
  return record;
}

export async function installCustomPluginFromUrl(url: string): Promise<CustomPlugin> {
  const res = await defaultFetcher(url, {});
  if (!res.success || !res.body) throw new Error(`fetch failed (code ${res.code})`);
  const fileName = url.split("/").pop()?.replace(/\.lua$/i, "") ?? "custom";
  return installCustomPlugin(fileName, res.body);
}

export async function removeCustomPlugin(id: string): Promise<void> {
  await db.customPlugins.delete(id);
  dropRuntime(id);
  invalidateCustom();
}
