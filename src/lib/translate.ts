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

export function getTranslationConfig(): TranslationConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) return { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<TranslationConfig>) };
  } catch { /* fall through */ }
  return { ...DEFAULT_CONFIG };
}

export function setTranslationConfig(cfg: TranslationConfig): void { localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)); }

export async function getBookTranslationSettings(bookUrl: string): Promise<TranslationConfig> {
  const row = await db.translationSettings.get(bookUrl);
  const global = getTranslationConfig();
  if (!row) return global;
  return { ...global, backend: row.backend, fromLang: row.fromLang, toLang: row.toLang };
}

export async function setBookTranslationSettings(bookUrl: string, cfg: Pick<TranslationConfig, "backend" | "fromLang" | "toLang">): Promise<void> {
  const existing = await db.translationSettings.get(bookUrl);
  await db.translationSettings.put({ ...existing, bookUrl, ...cfg, enabled: existing?.enabled ?? false });
}

export async function getBookTranslateEnabled(bookUrl: string): Promise<boolean> {
  const row = await db.translationSettings.get(bookUrl);
  return row?.enabled ?? false;
}

export async function setBookTranslateEnabled(bookUrl: string, enabled: boolean): Promise<void> {
  const row = (await db.translationSettings.get(bookUrl)) ?? { bookUrl, ...getTranslationConfig() };
  await db.translationSettings.put({ ...row, bookUrl, enabled });
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function cacheKey(backend: string, cfg: TranslationConfig, text: string): Promise<string> {
  return sha256Hex(text).then((h) => `${backend}|${cfg.fromLang}|${cfg.toLang}|${h}`);
}

const GOOGLE_MAX_CHARS = 1800;
const REQUEST_TIMEOUT_MS = 12000;
const GOOGLE_HOSTS = ["https://translate.googleapis.com", "https://translate.google.com"];

async function withTimeout<T>(promise: Promise<T>, ms = REQUEST_TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("translation request timeout")), ms);
    promise.then((v) => { window.clearTimeout(timer); resolve(v); }, (e) => { window.clearTimeout(timer); reject(e); });
  });
}

function splitForGoogle(text: string): string[] {
  if (text.length <= GOOGLE_MAX_CHARS) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > GOOGLE_MAX_CHARS) {
    const limit = rest.slice(0, GOOGLE_MAX_CHARS + 1);
    let cut = Math.max(limit.lastIndexOf(" "), limit.lastIndexOf("\n"), limit.lastIndexOf("。"), limit.lastIndexOf("，"));
    if (cut < GOOGLE_MAX_CHARS * 0.55) cut = GOOGLE_MAX_CHARS;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function parseGoogle(data: unknown): string {
  if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error("Google returned an invalid translation response");
  const segs = data[0] as unknown[];
  const out = segs.map((seg) => Array.isArray(seg) ? String(seg[0] ?? "") : "").join("");
  if (!out.trim()) throw new Error("Google returned an empty translation");
  return out;
}

async function requestGoogle(host: string, text: string, cfg: TranslationConfig): Promise<string> {
  const url = `${host}/translate_a/single?client=gtx&sl=${encodeURIComponent(cfg.fromLang)}&tl=${encodeURIComponent(cfg.toLang)}&dt=t&q=${encodeURIComponent(text)}`;
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await withTimeout(fetch(url, {
        method: "GET",
        headers: { Accept: "application/json, text/plain, */*" },
        mode: "cors",
        credentials: "omit",
      }));
      const raw = await res.text();
      if (!res.ok) throw new Error(`Google HTTP ${res.status}`);
      let data: unknown;
      try { data = JSON.parse(raw); } catch { throw new Error("Google returned a non-JSON response"); }
      return parseGoogle(data);
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      if (attempt === 0) await new Promise((resolve) => window.setTimeout(resolve, 350));
    }
  }
  throw lastError ?? new Error("Google translation failed");
}

async function directGoogle(text: string, cfg: TranslationConfig): Promise<string> {
  let firstError: Error | null = null;
  for (const host of GOOGLE_HOSTS) {
    try { return await requestGoogle(host, text, cfg); } catch (e) {
      if (!firstError) firstError = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw firstError ?? new Error("Google translation failed");
}

async function viaProxy(url: string, init: RequestInit = {}): Promise<Response> {
  const res = await withTimeout(fetch(FETCH_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, method: init.method ?? "GET", headers: init.headers, body: typeof init.body === "string" ? init.body : undefined }),
  }));
  const text = await res.text();
  let json: { success?: boolean; body?: string; code?: number; error?: string };
  try { json = JSON.parse(text) as { success?: boolean; body?: string; code?: number; error?: string }; } catch { throw new Error(`translation proxy returned invalid response (${res.status})`); }
  if (!json.success) throw new Error(json.error || `translation proxy failed (${json.code ?? res.status})`);
  return new Response(json.body ?? "", { status: json.code ?? 200 });
}

async function googleThroughProxy(text: string, cfg: TranslationConfig): Promise<string> {
  let firstError: Error | null = null;
  for (const host of GOOGLE_HOSTS) {
    const url = `${host}/translate_a/single?client=gtx&sl=${encodeURIComponent(cfg.fromLang)}&tl=${encodeURIComponent(cfg.toLang)}&dt=t&q=${encodeURIComponent(text)}`;
    try { return parseGoogle(await (await viaProxy(url)).json()); } catch (e) {
      if (!firstError) firstError = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw firstError ?? new Error("Google proxy translation failed");
}

async function translateGoogleSimple(text: string, cfg: TranslationConfig): Promise<string> {
  const chunks = splitForGoogle(text);
  const out: string[] = [];
  for (const chunk of chunks) {
    try {
      out.push(await directGoogle(chunk, cfg));
    } catch (directError) {
      try {
        out.push(await googleThroughProxy(chunk, cfg));
      } catch (proxyError) {
        throw new Error(`Translation failed: ${directError instanceof Error ? directError.message : String(directError)}; proxy: ${proxyError instanceof Error ? proxyError.message : String(proxyError)}`);
      }
    }
  }
  return out.join(" ");
}

async function translateGoogleEnhanced(texts: string[], cfg: TranslationConfig): Promise<string[]> {
  return Promise.all(texts.map((text) => translateGoogleSimple(text, cfg)));
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
  const out = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  const byIndex = new Map<number, string>();
  for (const m of out.matchAll(/^\[(\d+)\]\s?(.*)$/gm)) byIndex.set(Number(m[1]), m[2]);
  return texts.map((orig, i) => byIndex.get(i) ?? orig);
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
  const out = data.choices?.[0]?.message?.content ?? "";
  const byIndex = new Map<number, string>();
  for (const m of out.matchAll(/^\[(\d+)\]\s?(.*)$/gm)) byIndex.set(Number(m[1]), m[2]);
  return texts.map((orig, i) => byIndex.get(i) ?? orig);
}

export async function translateParagraphs(texts: string[], cfg: TranslationConfig, onProgress?: (done: number, total: number) => void): Promise<string[]> {
  const out: string[] = new Array(texts.length).fill("");
  const pending: Array<{ idx: number; text: string; key: string }> = [];
  await Promise.all(texts.map(async (text, idx) => {
    if (!text.trim()) { out[idx] = text; return; }
    const key = await cacheKey(cfg.backend, cfg, text);
    const hit = await db.translationCache.get(key);
    if (hit?.text?.trim()) out[idx] = hit.text; else pending.push({ idx, text, key });
  }));
  let done = texts.length - pending.length;
  onProgress?.(done, texts.length);

  const translateOne = async (text: string): Promise<string> => {
    switch (cfg.backend) {
      case "google-enhanced": return (await translateGoogleEnhanced([text], cfg))[0] ?? text;
      case "gemini": return (await translateGemini([text], cfg))[0] ?? text;
      case "openai-compatible": return (await translateOpenAI([text], cfg))[0] ?? text;
      default: return translateGoogleSimple(text, cfg);
    }
  };

  const CONCURRENCY = cfg.backend.startsWith("google") ? 2 : 2;
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
      } catch (e) {
        if (!firstError) firstError = e instanceof Error ? e : new Error(String(e));
        out[item.idx] = item.text;
      }
      done++;
      onProgress?.(done, texts.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));
  if (pending.length > 0 && pending.every(({ idx }) => out[idx] === texts[idx]) && firstError) throw firstError;
  return out.map((t, i) => t || texts[i]);
}
