import type { Context } from "@netlify/functions";

const GOOGLE_URL = "https://translate.googleapis.com/translate_a/single";
const MAX_CHUNK_CHARS = 8000;
const REQUEST_TIMEOUT_MS = 15000;
const RETRIES = 3;
const RETRY_DELAYS_MS = [0, 300, 700];
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

type TranslateBody = {
  texts?: unknown;
  source?: unknown;
  target?: unknown;
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: CORS_HEADERS });
}

function normalizeLang(value: unknown, fallback: string): string {
  const s = typeof value === "string" ? value.trim() : "";
  return s ? s : fallback;
}

function splitParagraphs(texts: string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentLength = 0;

  for (const text of texts) {
    const addLength = text.length + (current.length ? 1 : 0);
    if (current.length && currentLength + addLength > MAX_CHUNK_CHARS) {
      chunks.push(current);
      current = [];
      currentLength = 0;
    }

    // An individual paragraph larger than the provider limit is split by text.
    if (text.length > MAX_CHUNK_CHARS) {
      let rest = text;
      while (rest.length > MAX_CHUNK_CHARS) {
        const cut = Math.max(
          rest.lastIndexOf(" ", MAX_CHUNK_CHARS),
          rest.lastIndexOf("\n", MAX_CHUNK_CHARS),
          rest.lastIndexOf("。", MAX_CHUNK_CHARS),
          rest.lastIndexOf("，", MAX_CHUNK_CHARS),
        );
        const at = cut >= Math.floor(MAX_CHUNK_CHARS * 0.55) ? cut : MAX_CHUNK_CHARS;
        chunks.push([rest.slice(0, at)]);
        rest = rest.slice(at).replace(/^\s+/, "");
      }
      if (rest) chunks.push([rest]);
      continue;
    }

    current.push(text);
    currentLength += addLength;
  }

  if (current.length) chunks.push(current);
  return chunks;
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function parseGoogle(body: string): string {
  const data = JSON.parse(body) as unknown;
  if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error("unexpected Google response");
  const result = (data[0] as unknown[])
    .map((segment) => (Array.isArray(segment) ? String(segment[0] ?? "") : ""))
    .join("")
    .trim();
  if (!result) throw new Error("Google returned an empty translation");
  return result;
}

function getSetCookie(response: Response): string[] {
  const getter = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  return typeof getter === "function" ? getter.call(response.headers) : [];
}

function cookieHeader(cookies: string[]): string {
  return cookies
    .map((value) => value.split(";", 1)[0])
    .filter(Boolean)
    .join("; ");
}

async function seedGoogleCookies(cookies: string[]): Promise<string[]> {
  try {
    const response = await fetchWithTimeout("https://translate.google.com/?hl=en", {
      headers: { "User-Agent": DEFAULT_UA },
      redirect: "follow",
    });
    const seeded = [...cookies, ...getSetCookie(response)];
    await response.arrayBuffer();
    return seeded;
  } catch {
    return cookies;
  }
}

async function translateChunk(text: string, source: string, target: string): Promise<string> {
  let cookies: string[] = [];
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < RETRIES; attempt += 1) {
    try {
      if (attempt > 0) {
        const delay = RETRY_DELAYS_MS[attempt] ?? 700;
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      }

      let response: Response;
      if (text.length > 500) {
        const body = new URLSearchParams({
          client: "gtx",
          sl: source,
          tl: target,
          dt: "t",
          q: text,
        }).toString();
        response = await fetchWithTimeout(GOOGLE_URL, {
          method: "POST",
          headers: {
            "User-Agent": DEFAULT_UA,
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            ...(cookieHeader(cookies) ? { Cookie: cookieHeader(cookies) } : {}),
          },
          body,
        });
      } else {
        const url = new URL(GOOGLE_URL);
        url.searchParams.set("client", "gtx");
        url.searchParams.set("sl", source);
        url.searchParams.set("tl", target);
        url.searchParams.set("dt", "t");
        url.searchParams.set("q", text);
        response = await fetchWithTimeout(url, {
          headers: {
            "User-Agent": DEFAULT_UA,
            Accept: "application/json, text/plain, */*",
            ...(cookieHeader(cookies) ? { Cookie: cookieHeader(cookies) } : {}),
          },
        });
      }

      if (response.status === 429 && attempt < RETRIES - 1) {
        cookies = await seedGoogleCookies(cookies);
        continue;
      }

      const body = await response.text();
      if (!response.ok) throw new Error(`Google HTTP ${response.status}: ${body.slice(0, 120)}`);
      return parseGoogle(body);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError ?? new Error("Google translation failed");
}

async function translateBatch(texts: string[], source: string, target: string): Promise<string[]> {
  const clean = texts.map((text) => String(text ?? ""));
  const out = clean.slice();
  const chunks = splitParagraphs(clean);

  // Preserve the NoveLA strategy: sequential chunks with a short pause to
  // reduce rate limiting on the public Google endpoint.
  let cursor = 0;
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const chunk = chunks[chunkIndex];
    if (chunkIndex > 0) await new Promise((resolve) => setTimeout(resolve, 300));

    // Normally each chunk contains several paragraphs. Translate them as one
    // newline-delimited request, then map the returned lines back conservatively.
    if (chunk.length > 1) {
      const joined = chunk.join("\n");
      try {
        const translated = await translateChunk(joined, source, target);
        const lines = translated.split("\n").map((line) => line.trim()).filter(Boolean);
        for (let i = 0; i < chunk.length && i < lines.length; i += 1) out[cursor + i] = lines[i];
        if (lines.length < chunk.length) {
          for (let i = lines.length; i < chunk.length; i += 1) {
            out[cursor + i] = await translateChunk(chunk[i], source, target);
          }
        }
      } catch {
        for (let i = 0; i < chunk.length; i += 1) {
          try {
            out[cursor + i] = await translateChunk(chunk[i], source, target);
          } catch {
            out[cursor + i] = chunk[i];
          }
        }
      }
      cursor += chunk.length;
    } else {
      try {
        out[cursor] = await translateChunk(chunk[0], source, target);
      } catch {
        out[cursor] = chunk[0];
      }
      cursor += 1;
    }
  }

  return out;
}

export default async function handler(request: Request, _context: Context): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== "POST") return json({ error: "POST required" }, 405);

  let body: TranslateBody;
  try {
    body = (await request.json()) as TranslateBody;
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  if (!Array.isArray(body.texts) || body.texts.length === 0 || body.texts.length > 200) {
    return json({ error: "texts must be a non-empty array of at most 200 items" }, 400);
  }

  const texts = body.texts.map((value) => String(value ?? ""));
  const source = normalizeLang(body.source, "auto");
  const target = normalizeLang(body.target, "en");

  try {
    const translations = await translateBatch(texts, source, target);
    return json({ ok: true, source, target, translations });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 502);
  }
}
