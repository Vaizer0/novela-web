import { db } from "../db/db";
import { FETCH_ENDPOINT } from "./api";

export type TranslationBackend =
  | "google-simple"
  | "google-enhanced"
  | "gemini"
  | "openai-compatible";

export interface TranslationConfig {
  backend: TranslationBackend;
  fromLang: string; // "auto" or ISO code
  toLang: string;
  geminiKey?: string;
  openaiEndpoint?: string;
  openaiKey?: string;
  openaiModel?: string;
}

const CONFIG_KEY = "translationConfig";

const DEFAULT_CONFIG: TranslationConfig = {
  backend: "google-simple",
  fromLang: "auto",
  toLang: "en",
};

export function getTranslationConfig(): TranslationConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) return { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<TranslationConfig>) };
  } catch {
    /* fall through */
  }
  return { ...DEFAULT_CONFIG };
}

export function setTranslationConfig(cfg: TranslationConfig): void {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}

/** Per-book translation settings stored in Dexie, falling back to global. */
export async function getBookTranslationSettings(
  bookUrl: string,
): Promise<TranslationConfig> {
  const row = await db.translationSettings.get(bookUrl);
  const global = getTranslationConfig();
  if (!row) return global;
  return { ...global, backend: row.backend, fromLang: row.fromLang, toLang: row.toLang };
}

export async function setBookTranslationSettings(
  bookUrl: string,
  cfg: Pick<TranslationConfig, "backend" | "fromLang" | "toLang">,
): Promise<void> {
  const existing = await db.translationSettings.get(bookUrl);
  await db.translationSettings.put({ ...existing, bookUrl, ...cfg, enabled: existing?.enabled ?? false });
}

export async function getBookTranslateEnabled(bookUrl: string): Promise<boolean> {
  const row = await db.translationSettings.get(bookUrl);
  return row?.enabled ?? false;
}

export async function setBookTranslateEnabled(bookUrl: string, enabled: boolean): Promise<void> {
  const row = (await db.translationSettings.get(bookUrl)) ?? {
    bookUrl,
    ...getTranslationConfig(),
  };
  await db.translationSettings.put({ ...row, bookUrl, enabled });
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function cacheKey(backend: string, cfg: TranslationConfig, text: string): Promise<string> {
  return sha256Hex(text).then((h) => `${backend}|${cfg.fromLang}|${cfg.toLang}|${h}`);
}

/** POST through the serverless proxy (google endpoints block browser CORS). */
async function viaProxy(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${FETCH_ENDPOINT}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, method: init?.method ?? "GET", headers: init?.headers as Record<string, string>, body: typeof init?.body === "string" ? init.body : undefined }),
  });
  const json = (await res.json()) as { success: boolean; body: string; code: number };
  if (!json.success) throw new Error(`proxy fetch failed (${json.code})`);
  return new Response(json.body, { status: json.code });
}

async function translateGoogleSimple(text: string, cfg: TranslationConfig): Promise<string> {
  const url =
    `https://translate.googleapis.com/translate_a/single?client=gtx` +
    `&sl=${encodeURIComponent(cfg.fromLang)}&tl=${encodeURIComponent(cfg.toLang)}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await viaProxy(url);
  const data = (await res.json()) as [[Array<string | null> | string, unknown], ...unknown[]];
  // segments: [[translated, original, null, null, ...], ...]
  const segs = data[0];
  if (!Array.isArray(segs)) throw new Error("unexpected google response");
  return segs
    .map((seg) => (Array.isArray(seg) ? String(seg[0] ?? "") : String(seg ?? "")))
    .join("");
}

async function translateGoogleEnhanced(texts: string[], cfg: TranslationConfig): Promise<string[]> {
  const url =
    `https://translate.googleapis.com/translate_a/t?client=gtx` +
    `&sl=${encodeURIComponent(cfg.fromLang)}&tl=${encodeURIComponent(cfg.toLang)}`;
  const res = await viaProxy(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(texts.map((t) => ["q", t])).toString(),
  });
  const data = (await res.json()) as unknown;
  if (Array.isArray(data)) {
    // sentences mode returns [{trans, orig}, ...]; list mode returns strings
    return data.map((d) => (typeof d === "string" ? d : String((d as { trans?: string }).trans ?? "")));
  }
  throw new Error("unexpected google batch response");
}

async function translateGemini(texts: string[], cfg: TranslationConfig): Promise<string[]> {
  if (!cfg.geminiKey) throw new Error("Gemini API key not configured");
  const joined = texts.map((t, i) => `[${i}] ${t}`).join("\n");
  const prompt =
    `Translate each numbered line to ${cfg.toLang}. Keep the [n] prefixes. ` +
    `Output ONLY the numbered lines.\n\n${joined}`;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${cfg.geminiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0 },
      }),
    },
  );
  if (!res.ok) throw new Error(`gemini error ${res.status}`);
  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const out = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  const byIndex = new Map<number, string>();
  for (const m of out.matchAll(/^\[(\d+)\]\s?(.*)$/gm)) {
    byIndex.set(Number(m[1]), m[2]);
  }
  return texts.map((orig, i) => byIndex.get(i) ?? orig);
}

async function translateOpenAI(texts: string[], cfg: TranslationConfig): Promise<string[]> {
  if (!cfg.openaiEndpoint || !cfg.openaiKey) throw new Error("OpenAI-compatible endpoint not configured");
  const joined = texts.map((t, i) => `[${i}] ${t}`).join("\n");
  const res = await fetch(`${cfg.openaiEndpoint.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.openaiKey}` },
    body: JSON.stringify({
      model: cfg.openaiModel || "gpt-4o-mini",
      temperature: 0,
      messages: [
        {
          role: "system",
          content: `You are a translator. Translate each numbered line to ${cfg.toLang}. Keep the [n] prefixes. Output ONLY the numbered lines.`,
        },
        { role: "user", content: joined },
      ],
    }),
  });
  if (!res.ok) throw new Error(`openai error ${res.status}`);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const out = data.choices?.[0]?.message?.content ?? "";
  const byIndex = new Map<number, string>();
  for (const m of out.matchAll(/^\[(\d+)\]\s?(.*)$/gm)) {
    byIndex.set(Number(m[1]), m[2]);
  }
  return texts.map((orig, i) => byIndex.get(i) ?? orig);
}

/**
 * Translate paragraphs with per-paragraph caching. Returns translations in
 * input order; failed paragraphs fall back to the original text.
 */
export async function translateParagraphs(
  texts: string[],
  cfg: TranslationConfig,
  onProgress?: (done: number, total: number) => void,
): Promise<string[]> {
  const out: string[] = new Array(texts.length).fill("");
  const pending: Array<{ idx: number; text: string; key: string }> = [];

  await Promise.all(
    texts.map(async (text, idx) => {
      const key = await cacheKey(cfg.backend, cfg, text);
      const hit = await db.translationCache.get(key);
      if (hit) out[idx] = hit.text;
      else pending.push({ idx, text, key });
    }),
  );

  let done = texts.length - pending.length;
  onProgress?.(done, texts.length);

  const translateOne = async (text: string): Promise<string> => {
    switch (cfg.backend) {
      case "google-enhanced":
        return (await translateGoogleEnhanced([text], cfg))[0] ?? text;
      case "gemini":
        return (await translateGemini([text], cfg))[0] ?? text;
      case "openai-compatible":
        return (await translateOpenAI([text], cfg))[0] ?? text;
      default:
        return translateGoogleSimple(text, cfg);
    }
  };

  // Small concurrency pool for google-simple; LLM backends would benefit from
  // batching but per-paragraph keeps cache granularity and failure isolation.
  const CONCURRENCY = 4;
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < pending.length) {
      const item = pending[cursor++];
      try {
        const translated = await translateOne(item.text);
        out[item.idx] = translated;
        await db.translationCache.put({ key: item.key, text: translated });
      } catch {
        out[item.idx] = item.text; // graceful fallback
      }
      done++;
      onProgress?.(done, texts.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));

  return out.map((t, i) => t || texts[i]);
}
