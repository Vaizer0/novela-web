import type { FetchEnvelope } from "../engine/bridge/http";

/**
 * Cloudflare bypass support.
 *
 * Sites like freewebnovel/novelfire sit behind Cloudflare bot protection that
 * rejects datacenter IPs (Netlify functions) with a JS challenge. A real
 * browser passes because it executes the challenge — so blocked sources can
 * be routed through a user-hosted FlareSolverr instance (headless browser,
 * https://github.com/FlareSolverr/FlareSolverr), which returns rendered HTML.
 */

const BYPASS_KEY = "bypassProxyUrl";

export function getBypassProxyUrl(): string {
  if (typeof localStorage === "undefined") return "";
  return localStorage.getItem(BYPASS_KEY) ?? "";
}

export function setBypassProxyUrl(url: string): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(BYPASS_KEY, url.trim());
}

const CF_MARKERS = [
  /just a moment/i,
  /attention required/i,
  /cf-browser-verification/i,
  /challenge-platform/i,
  /_cf_chl_opt/i,
  /cf-chl(?:-\w+)?\s*=/i,
];

/** True when an envelope looks like a Cloudflare challenge page instead of real content. */
export function isCfBlocked(env: FetchEnvelope): boolean {
  if (!env.success && [403, 503].includes(env.code)) return true;
  const sample = env.body.slice(0, 4000);
  return env.body.length > 0 && CF_MARKERS.some((re) => re.test(sample));
}

interface FlareSolverrResponse {
  status?: string;
  message?: string;
  solution?: {
    url?: string;
    status?: number;
    response?: string;
    cookies?: Array<{ name: string; value: string; domain?: string }>;
  };
}

/**
 * Fetch through a FlareSolverr instance. GET semantics (it renders pages in a
 * real browser; POST bodies are not reliably supported).
 */
export async function fetchViaBypass(
  base: string,
  url: string,
): Promise<FetchEnvelope> {
  const endpoint = `${base.replace(/\/$/, "")}/v1`;
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cmd: "request.get", url, maxTimeout: 60000 }),
    });
    const data = (await res.json()) as FlareSolverrResponse;
    if (data.status !== "ok" || !data.solution) {
      return {
        success: false,
        body: "",
        code: -1,
        headers: {},
        error: `bypass proxy: ${data.message ?? res.statusText}`,
      };
    }
    const setCookie: Record<string, string[]> = {};
    for (const c of data.solution.cookies ?? []) {
      (setCookie[c.name] ??= []).push(`${c.name}=${c.value}`);
    }
    return {
      success: true,
      body: data.solution.response ?? "",
      code: data.solution.status ?? 200,
      headers: { "set-cookie": Object.values(setCookie).flat() },
    };
  } catch (e) {
    return {
      success: false,
      body: "",
      code: -1,
      headers: {},
      error: `bypass proxy unreachable: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
