import { LuaSource } from "./sourceAdapter";
import { defaultFetcher, clearSourceUserAgent, presetUserAgent, setSourceUserAgent } from "./bridge/http";
import { db, type CustomPlugin } from "../db/db";

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
  const m = code.match(new RegExp(`^\\s*${key}\\s*=\\s*\\"([^\\"]*)\\"`, "m"));
  return m?.[1] ?? "";
}

export function metaFromCode(code: string, fileName: string): SourceMeta {
  const id = headerField(code, "id") || `lua_${fileName.replace(/\\.lua$/i, "")}`;
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
const CUSTOM_IMPORT_MIGRATION_KEY = "customLuaSourcesEnabledV1";
const BUNDLED_IMPORT_MIGRATION_KEY = "bundledLuaSourcesEnabledV1";

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
    const entries = await Promise.all(
      Object.entries(pluginModules).map(async ([path, load]) => {
        const fileName = path.split("/").pop() ?? path;
        try {
          const code = await load();
          return { ...metaFromCode(code, fileName), bundled: true, getCode: () => Promise.resolve(code) } as SourceEntry;
        } catch (error) {
          console.error(`Failed to load bundled Lua source ${fileName}`, error);
          return null;
        }
      }),
    );
    bundledCache = entries.filter((entry): entry is SourceEntry => entry !== null);
  }
  return bundledCache;
}

async function customEntries(): Promise<SourceEntry[]> {
  if (!customCache) {
    try {
      const plugins = await db.customPlugins.toArray();
      customCache = plugins.map((p) => ({
        ...metaFromCode(p.code, p.name),
        bundled: false,
        getCode: () => Promise.resolve(p.code),
      }));
    } catch (error) {
      console.error("Failed to load custom Lua sources", error);
      customCache = [];
    }
  }
  return customCache;
}

function invalidateCustom(): void {
  customCache = null;
}

/** Resolve a promise without allowing a broken local database to freeze the app. */
async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      () => {
        window.clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

export async function listSources(): Promise<SourceEntry[]> {
  // Bundled sources are the critical path. Resolve them first so an IndexedDB
  // problem or stale database can never leave Browse stuck on "Loading…".
  const bundled = await bundledEntries();
  const custom = await withTimeout(customEntries(), 2_000, []);
  const byId = new Map<string, SourceEntry>();
  for (const entry of bundled) byId.set(entry.id, entry);
  for (const entry of custom) byId.set(entry.id, entry);

  if (localStorage.getItem(CUSTOM_IMPORT_MIGRATION_KEY) !== "1") {
    const enabled = getEnabledSources();
    if (enabled !== null && custom.length > 0) {
      for (const entry of custom) enabled.add(entry.id);
      setEnabledSources(enabled);
    }
    localStorage.setItem(CUSTOM_IMPORT_MIGRATION_KEY, "1");
  }

  if (localStorage.getItem(BUNDLED_IMPORT_MIGRATION_KEY) !== "1") {
    const enabled = getEnabledSources();
    if (enabled !== null && bundled.length > 0) {
      for (const entry of bundled) enabled.add(entry.id);
      setEnabledSources(enabled);
    }
    localStorage.setItem(BUNDLED_IMPORT_MIGRATION_KEY, "1");
  }

  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const runtimeCache = new Map<string, LuaSource>();

async function registerUserAgentPreset(src: LuaSource): Promise<void> {
  clearSourceUserAgent(src.meta.id);
  try {
    if (typeof src.runtime.lua.global.get("getUserAgentPreset") !== "function") return;
    await src.runtime.lua.doString("__novela_ua_preset = getUserAgentPreset()");
    const value = src.runtime.lua.global.get("__novela_ua_preset");
    if (typeof value !== "string") return;
    const ua = presetUserAgent(value);
    if (ua) setSourceUserAgent(src.meta.id, ua);
  } catch {
    /* Presets are optional; normal UA remains active. */
  }
}

export async function getSourceRuntime(entry: SourceEntry): Promise<LuaSource> {
  const cached = runtimeCache.get(entry.id);
  if (cached) return cached;
  const src = await LuaSource.load(await entry.getCode(), `${entry.id}.lua`, defaultFetcher);
  src.runtime.lua.global.set("string_lower", (value: string) => String(value ?? "").toLowerCase());
  src.runtime.lua.global.set("string_upper", (value: string) => String(value ?? "").toUpperCase());
  await registerUserAgentPreset(src);

  const fetchPage = src.fetchPage.bind(src);
  src.fetchPage = async (url: string) => {
    const env = await fetchPage(url);
    if (!env.success) {
      const detail = env.error ? `: ${env.error}` : "";
      throw new Error(`Failed to fetch ${url} (HTTP ${env.code})${detail}`);
    }
    if (env.body.trim() === "") throw new Error(`Source returned an empty response for ${url}`);
    return env;
  };

  runtimeCache.set(entry.id, src);
  return src;
}

export function dropRuntime(id: string): void {
  runtimeCache.delete(id);
  clearSourceUserAgent(id);
}

function enableNewSourceIds(ids: string[]): void {
  const enabled = getEnabledSources();
  if (enabled === null) return;
  let changed = false;
  for (const id of ids) {
    if (!enabled.has(id)) {
      enabled.add(id);
      changed = true;
    }
  }
  if (changed) setEnabledSources(enabled);
}

export async function installCustomPlugin(name: string, code: string): Promise<CustomPlugin> {
  const meta = metaFromCode(code, name);
  const record: CustomPlugin = { id: meta.id, name, code, addedAt: Date.now() };
  await db.customPlugins.put(record);
  dropRuntime(record.id);
  invalidateCustom();
  enableNewSourceIds([record.id]);
  return record;
}

export async function installCustomPlugins(plugins: Array<{ name: string; code: string }>): Promise<CustomPlugin[]> {
  const records: CustomPlugin[] = [];
  for (const plugin of plugins) {
    const meta = metaFromCode(plugin.code, plugin.name);
    const record: CustomPlugin = { id: meta.id, name: plugin.name, code: plugin.code, addedAt: Date.now() };
    await db.customPlugins.put(record);
    dropRuntime(record.id);
    records.push(record);
  }
  invalidateCustom();
  enableNewSourceIds(records.map((record) => record.id));
  return records;
}

export async function installCustomPluginFromUrl(url: string): Promise<CustomPlugin> {
  const res = await defaultFetcher(url, {});
  if (!res.success || !res.body) throw new Error(`fetch failed (code ${res.code})`);
  const fileName = url.split("/").pop()?.replace(/\\.lua$/i, "") ?? "custom";
  return installCustomPlugin(fileName, res.body);
}

export async function removeCustomPlugin(id: string): Promise<void> {
  await db.customPlugins.delete(id);
  dropRuntime(id);
  invalidateCustom();
}
