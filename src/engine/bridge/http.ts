import { getCookiesFor, storeSetCookies } from "./storage";
import { FETCH_ENDPOINT } from "../../lib/api";
import { fetchViaBypass, getBypassProxyUrl, isCfBlocked } from "../../lib/bypass";

/**
 * HTTP bridge: http_get / http_post / http_get_batch.
 * All traffic goes through the /api/fetch proxy function; response envelope
 * {success, body, code, headers} matches the Android LuaEngine contract.
 */

export interface FetchEnvelope {
  success: boolean;
  body: string;
  code: number;
  headers: Record<string, string[]>;
  error?: string;
}

export interface HttpConfig {
  headers?: Record<string, string>;
  charset?: string;
}

export type PageFetcher = (url: string, init: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  charset?: string;
}) => Promise<FetchEnvelope>;
/**
 * Default fetcher: POST to the Netlify function. When the response looks like
 * a Cloudflare challenge and a bypass proxy (FlareSolverr) is configured, the
 * request is retried through it automatically.
 */
export const defaultFetcher: PageFetcher = async (url, init) => {
  let env: FetchEnvelope;
  try {
    const res = await fetch(FETCH_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, ...init }),
    });
    env = (await res.json()) as FetchEnvelope;
  } catch (e) {
    return { success: false, body: "", code: -1, headers: {}, error: e instanceof Error ? e.message : String(e) };
  }
  if (isCfBlocked(env)) {
    const bypass = getBypassProxyUrl();
    if (bypass !== "") {
      const retried = await fetchViaBypass(bypass, url);
      if (retried.success || !isCfBlocked(retried)) return retried;
      return { ...env, error: "Cloudflare-blocked (bypass proxy also failed)" };
    }
    return {
      ...env,
      success: false,
      error: "Cloudflare-blocked source — configure a bypass proxy in Settings → Cloudflare",
    };
  }
  return env;
};

function refererFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/`;
  } catch {
    return url;
  }
}

function defaultHeaders(url: string): Record<string, string> {
  return {
    "Accept-Language": "en-US,en;q=0.9",
    Referer: refererFromUrl(url),
  };
}

// ── TTL cache (port of Android httpGetCache) ────────────────────────────────

const CACHE_TTL_MS = 2_000;
const MAX_ENTRIES = 100;
const MAX_TOTAL_BODY = 4_000_000;

interface CacheEntry {
  env: FetchEnvelope;
  storedAt: number;
}

const cache = new Map<string, CacheEntry>();

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

function putCache(key: string, env: FetchEnvelope): void {
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.storedAt >= CACHE_TTL_MS) cache.delete(k);
  cache.set(key, { env, storedAt: now });
  let totalLen = 0;
  for (const v of cache.values()) totalLen += v.env.body.length;
  if (cache.size > MAX_ENTRIES || totalLen > MAX_TOTAL_BODY) cache.clear();
}

// ── Core request path ───────────────────────────────────────────────────────

async function request(
  fetcher: PageFetcher,
  sourceId: string,
  url: string,
  method: "GET" | "POST",
  body: string | undefined,
  config: HttpConfig | undefined,
): Promise<FetchEnvelope> {
  const pluginHeaders = config?.headers ?? {};
  const charset = config?.charset || "utf-8";
  const headers: Record<string, string> = { ...defaultHeaders(url), ...pluginHeaders };

  // Attach persisted cookies unless the plugin set its own Cookie header.
  if (!Object.keys(pluginHeaders).some((k) => k.toLowerCase() === "cookie")) {
    const cookies = getCookiesFor(url);
    const cookieHeader = Object.entries(cookies).map(([n, v]) => `${n}=${v}`).join("; ");
    if (cookieHeader !== "") headers["Cookie"] = cookieHeader;
  }

  const cacheKey = `${url}|${charset}|${sourceId}|${hashString(JSON.stringify(headers))}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.storedAt < CACHE_TTL_MS) return hit.env;

  try {
    const env = await fetcher(url, { method, headers, body, charset });
    // Persist any cookies the server set so later requests carry them.
    storeSetCookies(url, env.headers?.["set-cookie"]);
    putCache(cacheKey, env);
    return env;
  } catch (e) {
    return { success: false, body: "", code: -1, headers: {}, error: e instanceof Error ? e.message : String(e) };
  }
}

export function makeHttpBridge(fetcher: PageFetcher, sourceId: string) {
  return {
    http_get: (url: string, config?: HttpConfig) => request(fetcher, sourceId, url, "GET", undefined, config),
    http_post: (url: string, body: string, config?: HttpConfig) => request(fetcher, sourceId, url, "POST", body, config),
    http_get_batch: (urls: string[]) =>
      Promise.all(
        urls.map(async (url) => {
          try {
            return await request(fetcher, sourceId, url, "GET", undefined, undefined);
          } catch {
            return { success: false, body: "", code: -1, headers: {} } as FetchEnvelope;
          }
        }),
      ),
  };
}
