import { createSourceRuntime, type SourceRuntime } from "./luaHost";
import { defaultFetcher, type PageFetcher } from "./bridge/http";
import { WASM_URI } from "./wasmUri";
import type {
  ActiveFilters,
  BookResult,
  CatalogPage,
  ChapterResult,
  LuaFilter,
  PagedChapters,
} from "./types";
import { activeFiltersToLuaTable } from "./types";

/**
 * Port of LuaSourceAdapter: loads a plugin script into its own runtime,
 * extracts metadata globals, validates required entry points (warn-only),
 * and exposes the typed async API. All calls serialize through a mutex
 * (wasmoon states are not reentrant).
 */

export interface SourceMetadataInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  baseUrl: string;
  icon: string | null;
  language: string;
  charset: string;
  contentType: "" | "novel" | "manga";
}

const REQUIRED_FUNCTIONS = [
  "getCatalogList",
  "getCatalogSearch",
  "getBookTitle",
  "getBookCoverImageUrl",
  "getBookDescription",
  "getChapterText",
];

/** Simple async mutex for per-source call serialization. */
class Mutex {
  #chain: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(fn, fn);
    this.#chain = next.catch(() => {});
    return next;
  }
}

export class LuaSource {
  readonly meta: SourceMetadataInfo;
  readonly runtime: SourceRuntime;
  readonly hasParsePage: boolean;
  readonly hasGetPageList: boolean;
  readonly hasFilterList: boolean;
  private readonly mutex = new Mutex();

  private readonly scriptTable: Record<string, unknown> | null;

  private constructor(
    runtime: SourceRuntime,
    meta: SourceMetadataInfo,
    flags: { hasParsePage: boolean; hasGetPageList: boolean; hasFilterList: boolean },
    scriptTable: Record<string, unknown> | null,
  ) {
    this.runtime = runtime;
    this.meta = meta;
    this.hasParsePage = flags.hasParsePage;
    this.hasGetPageList = flags.hasGetPageList;
    this.hasFilterList = flags.hasFilterList;
    this.scriptTable = scriptTable;
  }
  static async load(code: string, fileName?: string, fetcher: PageFetcher = defaultFetcher): Promise<LuaSource> {
    // Cheap pre-parse of the metadata header so registries can list sources
    // without executing each script; full extraction happens after execution.
    const idGuess = /^id\s*=\s*["']([^"']+)["']/m.exec(code)?.[1] ?? `lua_${fileName ?? "unknown"}`;
    const runtime = await createSourceRuntime(idGuess, fetcher, WASM_URI);
    const result = (await runtime.lua.doString(code)) as unknown;
    const g = runtime.lua.global;

    // Plugins may either declare globals or `return { ... }` a table of
    // entry points (Android sets a metatable; we keep the table and look
    // functions up in it as a fallback).
    const scriptTable =
      result && typeof result === "object" && !Array.isArray(result)
        ? (result as Record<string, unknown>)
        : null;

    const s = (key: string, def = ""): string => {
      const v = g.get(key) ?? scriptTable?.[key];
      return typeof v === "string" ? v : typeof v === "number" ? String(v) : def;
    };
    const rawType = s("content_type").toLowerCase();

    const meta: SourceMetadataInfo = {
      id: s("id", `lua_${fileName ?? "unknown"}`),
      name: s("name", "Unknown Source"),
      version: s("version", "1.0.0"),
      description: s("description"),
      baseUrl: s("baseUrl"),
      icon: s("icon") || null,
      language: s("language", "en"),
      charset: s("charset", "UTF-8"),
      contentType: rawType === "manga" || rawType === "novel" ? (rawType as "manga" | "novel") : "",
    };

    const has = (fn: string) => typeof g.get(fn) === "function" || typeof scriptTable?.[fn] === "function";
    for (const fn of REQUIRED_FUNCTIONS) {
      if (!has(fn)) console.warn(`LuaSourceAdapter [${meta.id}]: missing '${fn}'`);
    }

    return new LuaSource(
      runtime,
      meta,
      {
        hasParsePage: has("parsePage"),
        hasGetPageList: has("getPageList"),
        hasFilterList: has("getFilterList"),
      },
      scriptTable,
    );
  }

  /**
   * Entry-point invocation. Must run through doString (wasmoon-driven thread)
   * so that :await() inside the __make_sync bridge wrappers can suspend;
   * calling Lua functions directly from JS breaks promise suspension.
   */
  private call<T>(fn: string, ...args: unknown[]): Promise<T> {
    return this.mutex.run(async () => {
      const f = this.runtime.lua.global.get(fn) ?? this.scriptTable?.[fn];
      if (typeof f !== "function") throw new Error(`missing function ${fn}`);
      const g = this.runtime.lua.global;
      // Marshal through JSON decoded inside the VM (__json_decode): JS objects
      // returned from bridge functions become userdata proxies, so args must
      // become genuine Lua tables via the pure-Lua decoder.
      g.set("__call_json", JSON.stringify(args));
      await this.runtime.lua.doString(
        `__call_args = __json_decode(__call_json); __call_res = ${fn}(table.unpack(__call_args))`,
      );
      return g.get("__call_res") as T;
    });
  }

  async catalogList(index: number): Promise<CatalogPage> {
    try {
      return toCatalogPage(await this.call("getCatalogList", index), this.meta.contentType);
    } catch (e) {
      console.error(`getCatalogList [${this.meta.id}]`, e);
      return { items: [], hasNext: false };
    }
  }

  async catalogSearch(index: number, query: string): Promise<CatalogPage> {
    try {
      return toCatalogPage(await this.call("getCatalogSearch", index, query), this.meta.contentType);
    } catch (e) {
      console.error(`getCatalogSearch [${this.meta.id}]`, e);
      return { items: [], hasNext: false };
    }
  }

  async catalogFiltered(index: number, filters: ActiveFilters): Promise<CatalogPage> {
    try {
      return toCatalogPage(await this.call("getCatalogFiltered", index, activeFiltersToLuaTable(filters)), this.meta.contentType);
    } catch (e) {
      console.error(`getCatalogFiltered [${this.meta.id}]`, e);
      return { items: [], hasNext: false };
    }
  }

  async filters(): Promise<LuaFilter[]> {
    if (!this.hasFilterList) return [];
    try {
      return parseFilterList(await this.call("getFilterList"));
    } catch (e) {
      console.error(`getFilterList [${this.meta.id}]`, e);
      return [];
    }
  }

  async bookDetails(bookUrl: string): Promise<BookResult & { genres: string[]; status?: string | null; lastUpdate?: string | null }> {
    const g = async <T>(fn: string): Promise<T | null> => {
      try {
        return await this.call<T>(fn, bookUrl);
      } catch (e) {
        console.error(`${fn} [${this.meta.id}]`, e);
        return null;
      }
    };
    const str = async (fn: string): Promise<string> => {
      const v = await g<string | number>(fn);
      return v == null ? "" : String(v);
    };
    const optStr = async (fn: string): Promise<string | null> => {
      const v = await g<string | number>(fn);
      return v == null || v === "" ? null : String(v);
    };
    let genres: string[] = [];
    try {
      const arr = await this.call<string[]>("getBookGenres", bookUrl);
      if (Array.isArray(arr)) genres = arr.filter((x) => typeof x === "string" && x.trim() !== "");
    } catch {
      /* optional */
    }
    return {
      title: await str("getBookTitle"),
      url: bookUrl,
      cover: await str("getBookCoverImageUrl"),
      description: await str("getBookDescription"),
      rating: await optStr("getBookRating"),
      status: await optStr("getBookStatus"),
      lastUpdate: await optStr("getBookLastUpdate"),
      genres,
      contentType: this.meta.contentType,
    };
  }

  /** Chapter list; uses parsePage pagination when the plugin declares it. */
  async chapters(bookUrl: string): Promise<ChapterResult[]> {
    if (this.hasParsePage) {
      const all: ChapterResult[] = [];
      let page = 1;
      for (;;) {
        let res: PagedChapters;
        try {
          res = await this.parsePage(bookUrl, page);
        } catch (e) {
          console.error(`parsePage [${this.meta.id}] page=${page}`, e);
          break;
        }
        all.push(...res.chapters);
        if (page >= Math.max(1, res.totalPages)) break;
        page++;
      }
      return all;
    }
    try {
      const arr = await this.call<Record<string, unknown>[]>("getChapterList", bookUrl);
      return (arr ?? []).map(toChapterResult).filter((c): c is ChapterResult => c !== null);
    } catch (e) {
      console.error(`getChapterList [${this.meta.id}]`, e);
      return [];
    }
  }

  private async parsePage(bookUrl: string, page: number): Promise<PagedChapters> {
    const res = await this.call<{ chapters?: Record<string, unknown>[]; totalPages?: number }>("parsePage", bookUrl, page);
    if (!res || typeof res !== "object") throw new Error("parsePage returned non-table");
    const chapters = (res.chapters ?? []).map(toChapterResult).filter((c): c is ChapterResult => c !== null);
    return { chapters, totalPages: res.totalPages ?? 1 };
  }

  /** getChapterText(html, url) → text or null. */
  async chapterText(html: string, url: string): Promise<string | null> {
    try {
      const v = await this.call<string>("getChapterText", html, url);
      return typeof v === "string" ? v : null;
    } catch (e) {
      console.error(`getChapterText [${this.meta.id}]`, e);
      return null;
    }
  }

  /** getPageList(html, url) → image URLs in page order; null when plugin doesn't declare it. */
  async pageList(html: string, url: string): Promise<string[] | null> {
    if (!this.hasGetPageList) return null;
    try {
      const v = await this.call<string[]>("getPageList", html, url);
      if (!Array.isArray(v)) return [];
      return v.filter((x): x is string => typeof x === "string" && x !== "");
    } catch (e) {
      console.error(`getPageList [${this.meta.id}]`, e);
      return [];
    }
  }
}

// ── Conversion helpers (port of convertLuaTableTo*) ─────────────────────────

function toCatalogPage(v: unknown, contentType: BookResult["contentType"]): CatalogPage {
  if (!v || typeof v !== "object") return { items: [], hasNext: false };
  const obj = v as { items?: unknown; hasNext?: unknown };
  const items = Array.isArray(obj.items)
    ? obj.items
        .map((it): BookResult | null => {
          const o = it as Record<string, unknown>;
          const title = typeof o?.title === "string" ? o.title : "";
          const url = typeof o?.url === "string" ? o.url : "";
          if (title === "" && url === "") return null;
          const rating = o?.rating == null ? null : String(o.rating);
          return {
            title,
            url,
            cover: typeof o?.cover === "string" ? o.cover : "",
            rating: rating === "" ? null : rating,
            contentType,
          };
        })
        .filter((b): b is BookResult => b !== null)
    : [];
  return { items, hasNext: Boolean(obj.hasNext) };
}
function toChapterResult(v: unknown): ChapterResult | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  return {
    title: typeof o.title === "string" ? o.title : "",
    url: typeof o.url === "string" ? o.url : "",
    volume: typeof o.volume === "string" ? o.volume : null,
    uploaded: typeof o.uploaded === "number" ? o.uploaded : null,
  };
}

// ── Filter parsing (port of parseLuaFilterList) ─────────────────────────────

function parseOptions(table: unknown): { value: string; label: string }[] {
  if (!Array.isArray(table)) return [];
  const out: { value: string; label: string }[] = [];
  for (const opt of table) {
    const o = opt as Record<string, unknown>;
    const value = typeof o?.value === "string" ? o.value : "";
    if (value === "") continue;
    const label = typeof o?.label === "string" && o.label !== "" ? o.label : value;
    out.push({ value, label });
  }
  return out;
}

export function parseFilterList(list: unknown): LuaFilter[] {
  if (!Array.isArray(list)) return [];
  const filters: LuaFilter[] = [];
  for (const item of list) {
    const t = item as Record<string, unknown>;
    const key = typeof t?.key === "string" ? t.key : "";
    if (key === "") continue;
    const type = typeof t?.type === "string" ? t.type : "select";
    const label = typeof t?.label === "string" && t.label !== "" ? t.label : key;
    switch (type) {
      case "sort": {
        const options = parseOptions(t.options);
        if (options.length === 0) break;
        filters.push({
          kind: "sort",
          key,
          label,
          options,
          defaultValue: typeof t.defaultValue === "string" && t.defaultValue !== "" ? t.defaultValue : options[0].value,
          defaultAscending: Boolean(t.defaultAscending),
        });
        break;
      }
      case "select": {
        const options = parseOptions(t.options);
        if (options.length === 0) break;
        filters.push({ kind: "select", key, label, options, defaultValue: typeof t.defaultValue === "string" ? t.defaultValue : "" });
        break;
      }
      case "checkbox": {
        const options = parseOptions(t.options);
        if (options.length === 0) break;
        filters.push({ kind: "checkbox", key, label, options, multiselect: t.multiselect !== false });
        break;
      }
      case "tristate": {
        const options = parseOptions(t.options);
        if (options.length === 0) break;
        filters.push({ kind: "tristate", key, label, options });
        break;
      }
      case "switch":
        filters.push({ kind: "switch", key, label, defaultValue: Boolean(t.defaultValue) });
        break;
      case "text":
        filters.push({ kind: "text", key, label, defaultValue: typeof t.defaultValue === "string" ? t.defaultValue : "" });
        break;
      default:
        console.warn(`parseLuaFilterList: unknown filter type '${type}' for key '${key}'`);
    }
  }
  return filters;
}
