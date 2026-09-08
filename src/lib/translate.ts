import { db } from "../db/db";
import { FETCH_ENDPOINT } from "./api";

export type TranslationBackend = "google-simple" | "google-enhanced" | "gemini" | "openai-compatible";

export interface TranslationConfig {
  backend: TranslationBackend;
  fromLang: string;
  toLang: string;
  geminiKey?: string;
  openaiEndpoint?: string;
  openaiKey?: string;
  openaiModel?: string;
}

const CONFIG_KEY = "translationConfig";
const DEFAULT_CONFIG: TranslationConfig = { backend: "google-simple", fromLang: "auto", toLang: "en" };
const GOOGLE_URL = "https://translate.googleapis.com/translate_a/single";
const GOOGLE_BATCH_URL = "https://translate.googleapis.com/translate_a/t";
const REQUEST_TIMEOUT_MS = 15000;
const GOOGLE_BATCH_CHARS = 8000;

export function getTranslationConfig(): TranslationConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) return { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<TranslationConfig>) };
  } catch { /* use defaults */ }
  return { ...DEFAULT_CONFIG };
}

export function setTranslationConfig(cfg: TranslationConfig): void {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}

export async function getBookTranslationSettings(bookUrl: string): Promise<TranslationConfig> {
  const row = await db.translationSettings.get(bookUrl);
  const global = getTranslationConfig();
  return row ? { ...global, backend: row.backend, fromLang: row.fromLang, toLang: row.toLang } : global;
}

export async function setBookTranslationSettings(bookUrl: string, cfg: Pick<TranslationConfig, "backend" | "fromLang" | "toLang">): Promise<void> {
  const existing = await db.translationSettings.get(bookUrl);
  await db.translationSettings.put({ ...existing, bookUrl, ...cfg, enabled: existing?.enabled ?? false });
}

export async function getBookTranslateEnabled(bookUrl: string): Promise<boolean> {
  return (await db.translationSettings.get(bookUrl))?.enabled ?? false;
}

export async function setBookTranslateEnabled(bookUrl: string, enabled: boolean): Promise<void> {
  const row = (await db.translationSettings.get(bookUrl)) ?? { bookUrl, ...getTranslationConfig() };
  await db.translationSettings.put({ ...row, bookUrl, enabled });
}

async function withTimeout<T>(promise: Promise<T>, ms = REQUEST_TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("translation request timeout")), ms);
    promise.then((value) => { window.clearTimeout(timer); resolve(value); }, (error) => { window.clearTimeout(timer); reject(error); });
  });
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function cacheKey(backend: string, cfg: TranslationConfig, text: string): Promise<string> {
  return sha256Hex(text).then((h) => `${backend}|${cfg.fromLang}|${cfg.toLang}|${h}`);
}

/**
 * Browser-safe Google transport. NoveLA can call Google directly with OkHttp;
 * the web app uses the existing server-side proxy because browser CORS cannot
 * be assumed for Google's internal translation endpoint.
 */
async function viaProxy(url: string, init: RequestInit = {}): Promise<Response> {
  const res = await withTimeout(fetch(FETCH_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, method: init.method ?? "GET", headers: init.headers, body: typeof init.body === "string" ? init.body : undefined }),
  }));
  const raw = await res.text();
  let json: { success?: boolean; body?: string; code?: number; error?: string };
  try { json = JSON.parse(raw) as typeof json; } catch { throw new Error(`translation proxy returned invalid response (${res.status})`); }
  if (!json.success) throw new Error(json.error || `translation proxy failed (${json.code ?? res.status})`);
  return new Response(json.body ?? "", { status: json.code ?? 200 });
}

function parseGoogle(body: string): string {
  const data = JSON.parse(body) as unknown;
  if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error("unexpected Google Translate response");
  const result = (data[0] as unknown[]).map((segment) => Array.isArray(segment) ? String(segment[0] ?? "") : String(segment ?? "")).join("").trim();
  if (!result) throw new Error("Google Translate returned an empty translation");
  return result;
}

function googleSingleUrl(text: string, cfg: TranslationConfig): string {
  const u = new URL(GOOGLE_URL);
  u.searchParams.set("client", "gtx");
  u.searchParams.set("sl", cfg.fromLang);
  u.searchParams.set("tl", cfg.toLang);
  u.searchParams.set("dt", "t");
  u.searchParams.set("q", text);
  return u.toString();
}

/** Mirrors NoveLA's GoogleFree request strategy: GET for short text,
 * form-urlencoded POST for larger text, retry once, then surface failure. */
async function translateGoogleFree(text: string, cfg: TranslationConfig): Promise<string> {
  if (!text.trim()) return text;
  let lastError: unknown = null;
  let seeded = false;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const large = text.length > 500;
      const response = large
        ? await viaProxy(GOOGLE_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ client: "gtx", sl: cfg.fromLang, tl: cfg.toLang, dt: "t", q: text }).toString(),
          })
        : await viaProxy(googleSingleUrl(text, cfg));

      const body = await response.text();
      if (response.status === 429 && !seeded) {
        seeded = true;
        try { await viaProxy("https://translate.google.com/?hl=en"); } catch { /* retry anyway */ }
        continue;
      }
      if (!response.ok) throw new Error(`Google Translate HTTP ${response.status}`);
      return parseGoogle(body);
    } catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise((resolve) => window.setTimeout(resolve, 250));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Google Translate request failed");
}

async function translateGoogleEnhanced(texts: string[], cfg: TranslationConfig): Promise<string[]> {
  // Keep the existing backend name, but use NoveLA-style Google requests with
  // paragraph-sized units. A failed batch falls back to independent requests.
  const out = texts.slice();
  for (let start = 0; start < texts.length;) {
    let end = start;
    let size = 0;
    while (end < texts.length && (end === start || size + texts[end].length + 1 <= GOOGLE_BATCH_CHARS)) {
      size += texts[end].length + 1;
      end += 1;
    }
    const batch = texts.slice(start, end);
    const form = new URLSearchParams();
    for (const text of batch) form.append("q", text);
    const u = new URL(GOOGLE_BATCH_URL);
    u.searchParams.set("client", "gtx");
    u.searchParams.set("sl", cfg.fromLang);
    u.searchParams.set("tl", cfg.toLang);
    try {
      const response = await viaProxy(u.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      if (!response.ok) throw new Error(`Google batch HTTP ${response.status}`);
      const data = JSON.parse(await response.text()) as unknown;
      if (!Array.isArray(data)) throw new Error("unexpected Google batch response");
      for (let i = 0; i < batch.length; i += 1) {
        const item = data[i] as unknown;
        const value = typeof item === "string" ? item : item && typeof item === "object" && "trans" in item ? String((item as { trans?: unknown }).trans ?? "") : "";
        out[start + i] = value.trim() || batch[i];
      }
    } catch {
      for (let i = 0; i < batch.length; i += 1) out[start + i] = await translateGoogleFree(batch[i], cfg);
    }
    start = end;
    if (start < texts.length) await new Promise((resolve) => window.setTimeout(resolve, 400));
  }
  return out;
}

async function translateGemini(texts: string[], cfg: TranslationConfig): Promise<string[]> {
  if (!cfg.geminiKey) throw new Error("Gemini API key not configured");
  const joined = texts.map((t, i) => `[${i}] ${t}`).join("\n");
  const prompt = `Translate each numbered line to ${cfg.toLang}. Keep the [n] prefixes. Output ONLY the numbered lines.\n\n${joined}`;
  const res = await withTimeout(fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(cfg.geminiKey)}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0 } }),
  }));
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
  const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const output = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  const byIndex = new Map<number, string>();
  for (const m of output.matchAll(/^\[(\d+)\]\s?(.*)$/gm)) byIndex.set(Number(m[1]), m[2]);
  return texts.map((original, i) => byIndex.get(i) ?? original);
}

async function translateOpenAI(texts: string[], cfg: TranslationConfig): Promise<string[]> {
  if (!cfg.openaiEndpoint || !cfg.openaiKey) throw new Error("OpenAI-compatible endpoint not configured");
  const joined = texts.map((t, i) => `[${i}] ${t}`).join("\n");
  const res = await withTimeout(fetch(`${cfg.openaiEndpoint.replace(/\/$/, "")}/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.openaiKey}` },
    body: JSON.stringify({ model: cfg.openaiModel || "gpt-4o-mini", temperature: 0, messages: [
      { role: "system", content: `You are a translator. Translate each numbered line to ${cfg.toLang}. Keep the [n] prefixes. Output ONLY the numbered lines.` },
      { role: "user", content: joined },
    ] }),
  }));
  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}`);
  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  const output = data.choices?.[0]?.message?.content ?? "";
  const byIndex = new Map<number, string>();
  for (const m of output.matchAll(/^\[(\d+)\]\s?(.*)$/gm)) byIndex.set(Number(m[1]), m[2]);
  return texts.map((original, i) => byIndex.get(i) ?? original);
}

export async function translateParagraphs(texts: string[], cfg: TranslationConfig, onProgress?: (done: number, total: number) => void): Promise<string[]> {
  const out: string[] = new Array(texts.length).fill("");
  const pending: Array<{ idx: number; text: string; key: string }> = [];

  await Promise.all(texts.map(async (text, idx) => {
    if (!text.trim()) { out[idx] = text; return; }
    const key = await cacheKey(cfg.backend, cfg, text);
    const hit = await db.translationCache.get(key);
    if (hit?.text?.trim()) out[idx] = hit.text;
    else pending.push({ idx, text, key });
  }));

  let done = texts.length - pending.length;
  onProgress?.(done, texts.length);

  const translateOne = async (text: string): Promise<string> => {
    switch (cfg.backend) {
      case "google-enhanced": return (await translateGoogleEnhanced([text], cfg))[0] ?? text;
      case "gemini": return (await translateGemini([text], cfg))[0] ?? text;
      case "openai-compatible": return (await translateOpenAI([text], cfg))[0] ?? text;
      default: return translateGoogleFree(text, cfg);
    }
  };

  let cursor = 0;
  let firstError: Error | null = null;
  async function worker(): Promise<void> {
    while (true) {
      const n = cursor++;
      if (n >= pending.length) return;
      const item = pending[n];
      try {
        const translated = await translateOne(item.text);
        out[item.idx] = translated;
        await db.translationCache.put({ key: item.key, text: translated });
      } catch (error) {
        if (!firstError) firstError = error instanceof Error ? error : new Error(String(error));
        out[item.idx] = item.text;
      }
      done += 1;
      onProgress?.(done, texts.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(2, pending.length) }, worker));
  if (pending.length > 0 && pending.every(({ idx }) => out[idx] === texts[idx]) && firstError) throw firstError;
  return out.map((text, i) => text || texts[i]);
}
