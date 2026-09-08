import { getCookiesFor, storeSetCookies } from "./storage";
import { FETCH_ENDPOINT } from "../../lib/api";
import { fetchViaBypass, getBypassProxyUrl, isCfBlocked } from "../../lib/bypass";

/**
 * HTTP bridge: http_get / http_post / http_get_batch.
 * All traffic prefers the configured server-side proxy; browser-safe direct
 * fallbacks keep GET-based Lua sources usable from GitHub Pages when the
 * serverless proxy is unavailable.
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

const DIRECT_TIMEOUT_MS = 45_000;
const sourceUserAgents = new Map<string, string>();

/** Register the effective UA for a Lua source, mirroring NoveLA's PluginUARegistry. */
export function setSourceUserAgent(sourceId: string, userAgent: string): void {
  const value = userAgent.trim();
  if (value) sourceUserAgents.set(sourceId, value);
  else sourceUserAgents.delete(sourceId);
}

export function clearSourceUserAgent(sourceId: string): void {
  sourceUserAgents.delete(sourceId);
}

function presetUserAgent(preset: string): string | null {
  const aliases: Record<string, string> = {
    "Chrome 150 (Windows)": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
    "Safari 18 (macOS)": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
    "Firefox 152 (Windows)": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0",
    "Edge 150 (Windows)": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0",
    "Chrome 150 (Android)": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36",
    "Safari 18 (iOS)": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    "Firefox 152 (Android)": "Mozilla/5.0 (Android 16; Mobile; rv:152.0) Gecko/152.0 Firefox/152.0",
    "Edge 150 (Android)": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36 EdgA/150.0.0.0",
    "Samsung Internet 30.0 (Android)": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/30.0 Chrome/143.0.0.0 Mobile Safari/537.36",
    "Chrome Desktop": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
    "Safari Desktop": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
    "Firefox Desktop": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0",
    "Edge Desktop": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0",
    "Chrome Mobile": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36",
    "Safari Mobile": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    "Firefox Mobile": "Mozilla/5.0 (Android 16; Mobile; rv:152.0) Gecko/152.0 Firefox/152.0",
    "Edge Mobile": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36 EdgA/150.0.0.0",
    "Samsung Mobile": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/30.0 Chrome/143.0.0.0 Mobile Safari/537.36",
  };
  return aliases[preset] ?? (preset.startsWith("Mozilla/") ? preset : null);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchDirect(url: string, init: { method?: string; headers?: Record<string, string>; body?: string; charset?: string }): Promise<FetchEnvelope> {
  const method = (init.method ?? "GET").toUpperCase();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DIRECT_TIMEOUT_MS);
  try {
    const headers = { ...(init.headers ?? {}) };
    // Browsers treat User-Agent as a forbidden request header. The server-side
    // proxy can still honor source-specific UAs, but a direct fallback cannot.
    for (const key of Object.keys(headers)) if (key.toLowerCase() === "user-agent") delete headers[key];
    const res = await fetch(url, {
      method,
      headers,
      body: method !== "GET" && method !== "HEAD" ? init.body : undefined,
      redirect: "follow",
      signal: controller.signal,
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    let body: string;
    try {
      const charset = init.charset && init.charset.toLowerCase() !== "utf-8" ? init.charset : "utf-8";
      body = new TextDecoder(charset, { fatal: false }).decode(bytes);
    } catch {
      body = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    }
    const headersOut: Record<string, string[]> = {};
    res.headers.forEach((value, key) => {
      (headersOut[key.toLowerCase()] ??= []).push(value);
    });
    return { success: res.ok, body, code: res.status, headers: headersOut };
  } catch (e) {
    return {
      success: false,
      body: "",
      code: -1,
      headers: {},
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Direct Jina Reader fallback. */
async function fetchDirectJina(url: string, sourceInit: { headers?: Record<string, string> }): Promise<FetchEnvelope> {
  const jinaUrl = `https://r.jina.ai/${url}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DIRECT_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      Accept: "text/html, text/plain;q=0.9, */*;q=0.8",
      "x-respond-with": "html",
      ...(sourceInit.headers ?? {}),
    };
    for (const key of Object.keys(headers)) if (key.toLowerCase() === "user-agent") delete headers[key];
    const res = await fetch(jinaUrl, { headers, redirect: "follow", signal: controller.signal });
    const body = await res.text();
    const outHeaders: Record<string, string[]> = {};
    res.headers.forEach((value, key) => {
      (outHeaders[key.toLowerCase()] ??= []).push(value);
    });
    return {
      success: res.ok && body.trim() !== "",
      body,
      code: res.status,
      headers: outHeaders,
      ...(res.ok ? {} : { error: `Jina Reader HTTP ${res.status}` }),
    };
  } catch (e) {
    return {
      success: false,
      body: "",
      code: -1,
      headers: {},
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Default fetcher:
 *  1. server-side proxy
 *  2. direct browser GET
 *  3. direct Jina Reader GET
 *  4. Jina Reader through server-side proxy
 *  5. optional user-hosted FlareSolverr
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
  } catch {
    env = { success: false, body: "", code: -1, headers: {}, error: "proxy unreachable" };
  }
  if (!isCfBlocked(env) && env.success) return env;

  const method = (init.method ?? "GET").toUpperCase();

  if (method === "GET" && !isCfBlocked(env)) {
    const direct = await fetchDirect(url, init);
    if (!isCfBlocked(direct) && direct.success) return direct;
  }

  if (method === "GET") {
    const jinaDirect = await fetchDirectJina(url, init);
    if (!isCfBlocked(jinaDirect) && jinaDirect.success) return jinaDirect;
  }

  const jinaProxy = await viaFunction(`https://r.jina.ai/${url}`, {
    headers: { "x-return-format": "html", "x-respond-with": "html" },
  });
  if (!isCfBlocked(jinaProxy) && jinaProxy.success) return jinaProxy;

  const bypass = getBypassProxyUrl();
  if (bypass !== "") {
    const retried = await fetchViaBypass(bypass, url);
    if (!isCfBlocked(retried) && retried.success) return retried;
  }

  const fallbackError = jinaProxy.error ?? env.error ?? "fallbacks unavailable";
  return {
    ...env,
    success: false,
    error: isCfBlocked(env)
      ? `Cloudflare-blocked source — all fetch strategies failed: ${fallbackError}`
      : `Source fetch failed: ${fallbackError}`,
  };
};

/** GET through the Netlify function with custom headers. */
async function viaFunction(url: string, init?: RequestInit): Promise<FetchEnvelope> {
  try {
    const res = await fetch(FETCH_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, method: init?.method ?? "GET", headers: init?.headers }),
    });
    return (await res.json()) as FetchEnvelope;
  } catch (e) {
    return { success: false, body: "", code: -1, headers: {}, error: e instanceof Error ? e.message : String(e) };
  }
}

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
  if (!Object.keys(pluginHeaders).some((k) => k.toLowerCase() === "cookie")) {
    const cookies = getCookiesFor(url);
    const cookieHeader = Object.entries(cookies).map(([n, v]) => `${n}=${v}`).join("; ");
    if (cookieHeader !== "") headers["Cookie"] = cookieHeader;
  }

  const ua = !Object.keys(headers).some((k) => k.toLowerCase() === "user-agent") ? sourceUserAgents.get(sourceId) : undefined;
  if (ua) headers["User-Agent"] = ua;

  const cacheKey = `${url}|${charset}|${sourceId}|${method}|${body ?? ""}|${hashString(JSON.stringify(headers))}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.storedAt < CACHE_TTL_MS) return hit.env;

  try {
    const env = await fetcher(url, { method, headers, body, charset });
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

export { presetUserAgent };
