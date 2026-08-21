/**
 * Single network egress point resolution.
 *
 * The serverless proxy (fetch + raw image modes) only exists on the Netlify
 * deployment. When the app is hosted elsewhere (GitHub Pages), API calls are
 * pointed at the Netlify origin.
 */
function computeApiBase(): string {
  if (typeof location === "undefined") return "";
  const host = location.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".netlify.app")) {
    return ""; // same-origin
  }
  return "https://novela-web.netlify.app";
}

export const API_BASE = computeApiBase();

/** Direct function URL — bypasses the /api/fetch pretty redirect, which
 *  drops the mode=raw query param on the way through. */
export const FETCH_ENDPOINT = `${API_BASE}/.netlify/functions/fetch`;

/** Raw byte passthrough for images (manga pages, covers, icons). */
export function rawImageUrl(url: string): string {
  return `${FETCH_ENDPOINT}?mode=raw&url=${encodeURIComponent(url)}`;
}
