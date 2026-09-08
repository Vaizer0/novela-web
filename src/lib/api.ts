/**
 * API origins used by the static GitHub Pages frontend.
 *
 * VITE_API_BASE can point at the deployment that hosts the fetch/image proxy.
 * VITE_TRANSLATION_API_BASE can independently point at the deployment that
 * hosts the NoveLA-compatible Google translation engine.
 */
function configuredBase(name: "VITE_API_BASE" | "VITE_TRANSLATION_API_BASE"): string | null {
  try {
    const value = import.meta.env[name];
    if (typeof value === "string" && value.trim()) return value.trim().replace(/\/$/, "");
  } catch {
    // import.meta.env is available in Vite builds; keep a safe fallback for tests.
  }
  return null;
}

function computeApiBase(): string {
  const configured = configuredBase("VITE_API_BASE");
  if (configured) return configured;
  if (typeof location === "undefined") return "https://novela-web.netlify.app";
  const host = location.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".netlify.app")) return "";
  return "https://novela-web.netlify.app";
}

function computeTranslationApiBase(): string {
  const configured = configuredBase("VITE_TRANSLATION_API_BASE");
  if (configured) return configured;
  if (typeof location !== "undefined") {
    const host = location.hostname;
    if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".netlify.app")) return "";
  }
  return "https://novela-web.netlify.app";
}

export const API_BASE = computeApiBase();
export const TRANSLATION_API_BASE = computeTranslationApiBase();

/** Direct function URL for source fetching, covers, images and icons. */
export const FETCH_ENDPOINT = `${API_BASE}/.netlify/functions/fetch`;

/** Dedicated NoveLA-style Google translation server endpoint. */
export const TRANSLATE_ENDPOINT = `${TRANSLATION_API_BASE}/.netlify/functions/google-translate`;

/** Raw byte passthrough for images (manga pages, covers, icons). */
export function rawImageUrl(url: string): string {
  return `${FETCH_ENDPOINT}?mode=raw&url=${encodeURIComponent(url)}`;
}
