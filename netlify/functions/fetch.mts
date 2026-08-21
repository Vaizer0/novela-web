import type { Config, Context } from "@netlify/functions";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

type FetchBody = {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  charset?: string;
};

function fail(body = "", message?: string) {
  return Response.json(
    { success: false, code: -1, body, headers: {}, ...(message ? { error: message } : {}) },
    { status: 200 },
  );
}

function ipIsBlocked(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === "::" || s === "::1") return true;
    if (s.startsWith("fe80") || s.startsWith("fc") || s.startsWith("fd")) return true;
    if (s.startsWith("::ffff:")) return ipIsBlocked(s.slice(7)); // IPv4-mapped
    return false;
  }
  return true; // unparseable → block
}

async function ssrfSafe(urlStr: string): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname;
  // Literal IP in hostname
  if (isIP(host.replace(/^\[|\]$/g, ""))) return !ipIsBlocked(host.replace(/^\[|\]$/g, ""));
  try {
    const addrs = await lookup(host, { all: true, verbatim: true });
    return addrs.length > 0 && addrs.every((a) => !ipIsBlocked(a.address));
  } catch {
    return false;
  }
}

function lowerHeaders(h: Headers): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of h.entries()) {
    (out[k.toLowerCase()] ??= []).push(v);
  }
  // getSetCookie preserves multi-value set-cookie that entries() may join
  const sc = h.getSetCookie?.() ?? [];
  if (sc.length > 0) out["set-cookie"] = sc;
  return out;
}

async function proxyFetch(req: FetchBody): Promise<Response> {
  const url = req.url;
  if (!url) return fail("", "missing url");
  if (!(await ssrfSafe(url))) return fail(`SSRF blocked: private/loopback address not allowed (${url})`);

  const charset = req.charset || "utf-8";
  const headers: Record<string, string> = {
    "User-Agent": DEFAULT_UA,
    "Accept-Language": "en-US,en;q=0.9",
    ...(req.headers || {}),
  };
  // Referer default like the Android engine
  try {
    const u = new URL(url);
    if (!Object.keys(req.headers || {}).some((k) => k.toLowerCase() === "referer")) {
      headers["Referer"] = `${u.protocol}//${u.host}/`;
    }
  } catch {
    /* unreachable after ssrfSafe */
  }

  try {
    const method = (req.method || "GET").toUpperCase();
    const init: RequestInit = { method, headers, redirect: "follow" };
    if (method !== "GET" && method !== "HEAD" && req.body != null) {
      init.body = req.body;
    }
    const res = await fetch(url, init);

    if (res.status === 301 || res.status === 302 || res.status === 303 || res.status === 307 || res.status === 308) {
      return fail("", `too many redirects at ${url}`);
    }

    const lenHeader = res.headers.get("content-length");
    if (lenHeader && Number(lenHeader) > MAX_BYTES) {
      return fail("", `response too large (${lenHeader} bytes)`);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    const capped = buf.subarray(0, MAX_BYTES);
    let text: string;
    try {
      text = new TextDecoder(charset, { fatal: false }).decode(capped);
    } catch {
      text = new TextDecoder("utf-8", { fatal: false }).decode(capped);
    }
    return Response.json({
      success: res.ok,
      body: text,
      code: res.status,
      headers: lowerHeaders(res.headers),
    });
  } catch (e) {
    return fail("", e instanceof Error ? e.message : String(e));
  }
}

async function proxyRaw(urlParam: string | null): Promise<Response> {
  if (!urlParam) return new Response("missing url", { status: 400 });
  if (!(await ssrfSafe(urlParam))) return new Response("SSRF blocked", { status: 403 });
  try {
    const res = await fetch(urlParam, {
      headers: { "User-Agent": DEFAULT_UA, Accept: "*/*" },
      redirect: "follow",
    });
    const h = new Headers();
    const ct = res.headers.get("content-type");
    if (ct) h.set("content-type", ct);
    const cl = res.headers.get("content-length");
    if (cl && Number(cl) <= MAX_BYTES) h.set("content-length", cl);
    h.set("cache-control", "public, max-age=3600");
    const bytes = new Uint8Array(await res.arrayBuffer());
    return new Response(bytes.subarray(0, MAX_BYTES), { status: res.status, headers: h });
  } catch (e) {
    let msg = e instanceof Error ? e.message : String(e);
    if (e && typeof e === "object" && "cause" in e && e.cause instanceof Error) {
      msg += `: ${e.cause.message}`;
    }
    return new Response(`fetch failed: ${msg}`, { status: 502 });
  }
}

export default async (req: Request, _context: Context): Promise<Response> => {
  const u = new URL(req.url);
  if (u.searchParams.get("mode") === "raw") {
    return proxyRaw(u.searchParams.get("url"));
  }
  if (req.method === "POST") {
    let parsed: FetchBody;
    try {
      parsed = (await req.json()) as FetchBody;
    } catch {
      return fail("", "invalid JSON body");
    }
    return proxyFetch(parsed);
  }
  // GET convenience: /api/fetch?url=...&charset=...
  return proxyFetch({ url: u.searchParams.get("url") ?? undefined, charset: u.searchParams.get("charset") ?? undefined });
};
