import { getCookiesFor, storeSetCookies } from "./storage";
import { FETCH_ENDPOINT } from "../../lib/api";
import { fetchViaBypass, getBypassProxyUrl, isCfBlocked } from "../../lib/bypass";

/**
 * HTTP bridge for Lua extensions.
 *
 * GitHub Pages is a static host. Netlify credits can therefore not be treated
 * as a hard dependency for source browsing. Static-hosted builds use fast,
 * browser-safe fallbacks before the optional Netlify function.
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

const REQUEST_TIMEOUT_MS = 25_000;
const PUBLIC_FALLBACK_TIMEOUT_MS = 8_000;
const sourceUserAgents = new Map<string, string>();

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

function withTimeout<T>(promise: Promise<T>, ms = REQUEST_TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("request timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isStaticHosted(): boolean {
  if (typeof location === "undefined") return false;
  const host = location.hostname;
  return !(host === "localhost" || host === "127.0.0.1" || host.endsWith(".netlify.app"));
}

function normalizeHeaders(headers: Headers): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  headers.forEach((value, key) => {
    (out[key.toLowerCase()] ??= []).push(value);
  });
  return out;
}

function browserSafeHeaders(input: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    const lower = key.toLowerCase();
    if (lower === "user-agent" || lower === "referer" || lower === "cookie") continue;
    out[key] = value;
  }
  return out;
}

async function fetchDirect(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; charset?: string },
): Promise<FetchEnvelope> {
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return { success: false, body: "", code: -1, headers: {}, error: "direct browser fallback supports GET/HEAD only" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUBLIC_FALLBACK_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: browserSafeHeaders(init.headers ?? {}),
      redirect: "follow",
      signal: controller.signal,
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    let body = "";
    try {
      body = new TextDecoder(init.charset && init.charset.toLowerCase() !== "utf-8" ? init.charset : "utf-8").decode(bytes);
    } catch {
      body = new TextDecoder("utf-8").decode(bytes);
    }
    return { success: res.ok, body, code: res.status, headers: normalizeHeaders(res.headers) };
  } catch (e) {
    return { success: false, body: "", code: -1, headers: {}, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCorsProxy(url: string, proxy: "allorigins" | "corsproxy"): Promise<FetchEnvelope> {
  const endpoint = proxy === "allorigins"
    ? `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`
    : `https://corsproxy.io/?url=${encodeURIComponent(url)}`;
  try {
    const res = await withTimeout(fetch(endpoint, { redirect: "follow" }), PUBLIC_FALLBACK_TIMEOUT_MS);
    const body = await withTimeout(res.text(), PUBLIC_FALLBACK_TIMEOUT_MS);
    return {
      success: res.ok && body.trim() !== "",
      body,
      code: res.status,
      headers: normalizeHeaders(res.headers),
      ...(res.ok ? {} : { error: `${proxy} HTTP ${res.status}` }),
    };
  } catch (e) {
    return { success: false, body: "", code: -1, headers: {}, error: e instanceof Error ? e.message : String(e) };
  }
}

async function fetchJina(url: string, init: { headers?: Record<string, string> }): Promise<FetchEnvelope> {
  try {
    const headers: Record<string, string> = {
      Accept: "text/html, text/plain;q=0.9, */*;q=0.8",
      "x-respond-with": "html",
      ...(init.headers ?? {}),
    };
    for (const key of Object.keys(headers)) {
      const lower = key.toLowerCase();
      if (lower === "user-agent" || lower === "referer" || lower === "cookie") delete headers[key];
    }
    const res = await withTimeout(fetch(`https://r.jina.ai/${url}`, { headers, redirect: "follow" }), PUBLIC_FALLBACK_TIMEOUT_MS);
    const body = await withTimeout(res.text(), PUBLIC_FALLBACK_TIMEOUT_MS);
    return { success: res.ok && body.trim() !== "", body, code: res.status, headers: normalizeHeaders(res.headers) };
  } catch (e) {
    return { success: false, body: "", code: -1, headers: {}, error: e instanceof Error ? e.message : String(e) };
  }
}

async function fetchNetlify(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; charset?: string },
): Promise<FetchEnvelope> {
  try {
    const res = await withTimeout(fetch(FETCH_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, ...init }),
    }));
    const text = await withTimeout(res.text());
    try {
      return JSON.parse(text) as FetchEnvelope;
    } catch {
      return { success: false, body: "", code: res.status, headers: normalizeHeaders(res.headers), error: `proxy returned non-JSON (${res.status})` };
    }
  } catch (e) {
    return { success: false, body: "", code: -1, headers: {}, error: e instanceof Error ? e.message : String(e) };
  }
}

async function fetchPublicFallback(url: string, init: { method?: string; headers?: Record<string, string>; body?: string; charset?: string }): Promise<FetchEnvelope> {
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET") return { success: false, body: "", code: -1, headers: {}, error: "public fallback supports GET only" };

  const candidates = [
    fetchDirect(url, init),
    fetchCorsProxy(url, "allorigins"),
    fetchCorsProxy(url, "corsproxy"),
    fetchJina(url, init),
  ];

  try {
    return await Promise.any(
      candidates.map(async (promise) => {
        const env = await promise;
        if (!env.success || isCfBlocked(env) || env.body.trim() === "") {
          throw new Error(env.error ?? `fallback rejected (HTTP ${env.code})`);
        }
        return env;
      }),
    );
  } catch {
    return { success: false, body: "", code: -1, headers: {}, error: "all public fetch fallbacks failed" };
  }
}

async function fetchFallbacks(url: string, init: { method?: string; headers?: Record<string, string>; body?: string; charset?: string }): Promise<FetchEnvelope> {
  const method = (init.method ?? "GET").toUpperCase();

  if (method === "GET") {
    const publicResult = await fetchPublicFallback(url, init);
    if (publicResult.success) return publicResult;
  }

  const netlify = await fetchNetlify(url, init);
  if (netlify.success && !isCfBlocked(netlify)) return netlify;

  const bypass = getBypassProxyUrl();
  if (bypass !== "" && method === "GET") {
    const retried = await fetchViaBypass(bypass, url);
    if (retried.success && !isCfBlocked(retried)) return retried;
  }

  return {
    success: false,
    body: "",
    code: netlify.code || -1,
    headers: netlify.headers ?? {},
    error: isCfBlocked(netlify)
      ? `Cloudflare-blocked source — all fetch strategies failed: ${netlify.error ?? "netlify proxy unavailable"}`
      : `Source fetch failed: ${netlify.error ?? "all fetch strategies failed"}`,
  };
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
  return { "Accept-Language": "en-US,en;q=0.9", Referer: refererFromUrl(url) };
}

const CACHE_TTL_MS = 2_000;
const MAX_ENTRIES = 100;
const MAX_TOTAL_BODY = 4_000_000;
interface CacheEntry { env: FetchEnvelope; storedAt: number; }
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
    if (cookieHeader !== "") headers.Cookie = cookieHeader;
  }

  const ua = !Object.keys(headers).some((k) => k.toLowerCase() === "user-agent") ? sourceUserAgents.get(sourceId) : undefined;
  if (ua) headers["User-Agent"] = ua;

  const cacheKey = `${sourceId}|${url}|${charset}|${method}|${body ?? ""}|${hashString(JSON.stringify(headers))}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.storedAt < CACHE_TTL_MS) return hit.env;

  const env = await fetcher(url, { method, headers, body, charset });
  storeSetCookies(url, env.headers?.["set-cookie"]);
  putCache(cacheKey, env);
  return env;
}

export function makeHttpBridge(fetcher: PageFetcher, sourceId: string) {
  return {
    http_get: (url: string, config?: HttpConfig) => request(fetcher, sourceId, url, "GET", undefined, config),
    http_post: (url: string, body: string, config?: HttpConfig) => request(fetcher, sourceId, url, "POST", body, config),
    http_get_batch: (urls: string[]) =>
      Promise.all(urls.map(async (url) => {
        try {
          return await request(fetcher, sourceId, url, "GET", undefined, undefined);
        } catch {
          return { success: false, body: "", code: -1, headers: {} } as FetchEnvelope;
        }
      })),
  };
}

export const defaultFetcher: PageFetcher = async (url, init) => {
  if (isStaticHosted()) return fetchFallbacks(url, init);

  const netlify = await fetchNetlify(url, init);
  if (netlify.success && !isCfBlocked(netlify)) return netlify;

  return fetchFallbacks(url, init);
};

export { presetUserAgent };