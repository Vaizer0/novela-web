import iconv from "iconv-lite";
import { compileJavaRegex } from "../javaRegex";
import { getPreference, setPreference } from "./storage";

// ── String utils ────────────────────────────────────────────────────────────

export function stringClean(s: string): string {
  return (s ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function regexMatch(s: string, pattern: string): string[] {
  const re = compileJavaRegex(pattern);
  if (!re) return [];
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out.push(m[0]);
    if (m.index === re.lastIndex) re.lastIndex++; // zero-width safety
  }
  return out;
}

export function regexReplace(s: string, pattern: string, replacement: string): string {
  const re = compileJavaRegex(pattern);
  if (!re) return s;
  try {
    return s.replace(re, replacement);
  } catch {
    return s;
  }
}

export function unescapeUnicode(s: string): string {
  return (s ?? "").replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

// ── URL ─────────────────────────────────────────────────────────────────────

/** Java URLEncoder semantics: space → '+'. */
export function urlEncode(s: string): string {
  return encodeURIComponent(s ?? "").replace(/%20/g, "+");
}

/** Percent-encode using a non-UTF-8 charset (GBK search queries). */
export function urlEncodeCharset(s: string, charset?: string): string {
  const cs = (charset || "UTF-8").toUpperCase();
  if (cs === "UTF-8" || cs === "UTF8") return urlEncode(s);
  try {
    const bytes = iconv.encode(s ?? "", cs);
    let out = "";
    for (const b of bytes) {
      const safe = (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || (b >= 0x30 && b <= 0x39) ||
        b === 0x2d || b === 0x5f || b === 0x2e || b === 0x7e;
      if (safe) out += String.fromCharCode(b);
      else if (b === 0x20) out += "+";
      else out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
    }
    return out;
  } catch {
    return urlEncode(s);
  }
}

export function urlResolve(base: string, rel: string): string {
  try {
    return new URL(rel, base).toString();
  } catch {
    return rel;
  }
}

// ── Crypto ──────────────────────────────────────────────────────────────────

function base64ToBytes(b64: string): Uint8Array | null {
  try {
    let s = (b64 ?? "").replace(/-/g, "+").replace(/_/g, "/").trim();
    while (s.length % 4 !== 0) s += "=";
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function base64Decode(s: string): string | null {
  const bytes = base64ToBytes(s);
  if (!bytes) return null;
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

export function base64Encode(s: string): string | null {
  try {
    const bytes = new TextEncoder().encode(s ?? "");
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  } catch {
    return null;
  }
}

/**
 * aes_decrypt(b64_data, key, iv) — AES-CBC/PKCS7, key & iv as raw UTF-8 string
 * bytes (mirrors Android SecretKeySpec(string.toByteArray())). Returns plaintext
 * or nil on failure.
 */
export async function aesDecrypt(dataB64: string, keyStr: string, ivStr: string): Promise<string | null> {
  try {
    const data = base64ToBytes(dataB64);
    const key = new TextEncoder().encode(keyStr);
    const iv = new TextEncoder().encode(ivStr);
    if (!data || key.length !== 16 || iv.length !== 16) return null;
    const cryptoKey = await crypto.subtle.importKey("raw", key as unknown as BufferSource, "AES-CBC", false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv: iv as unknown as BufferSource }, cryptoKey, data as unknown as BufferSource);
    return new TextDecoder("utf-8", { fatal: false }).decode(plain);
  } catch {
    return null;
  }
}

// ── Misc ────────────────────────────────────────────────────────────────────

export { getPreference, setPreference };
