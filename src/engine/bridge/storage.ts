/**
 * Cookie + preference persistence for the Lua bridge.
 * Browser: localStorage; tests/node: in-memory fallback.
 */

const memStore = new Map<string, string>();

function get(key: string): string | null {
  try {
    if (typeof localStorage !== "undefined") return localStorage.getItem(key);
  } catch {
    /* private mode */
  }
  return memStore.get(key) ?? null;
}

function set(key: string, value: string): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(key, value);
      return;
    }
  } catch {
    /* fall through */
  }
  memStore.set(key, value);
}

// ── Preferences (single global store, like Android lua_preferences) ─────────

export function getPreference(key: string): string {
  return get(`luaPref:${key}`) ?? "";
}

export function setPreference(key: string, value: string): void {
  set(`luaPref:${key}`, value);
}

// ── Cookies: host → {name → value} ──────────────────────────────────────────

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function cookieKey(host: string): string {
  return `luaCookies:${host}`;
}

function loadCookies(host: string): Record<string, string> {
  const raw = get(cookieKey(host));
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

function saveCookies(host: string, cookies: Record<string, string>): void {
  set(cookieKey(host), JSON.stringify(cookies));
}

export function getCookiesFor(url: string): Record<string, string> {
  const host = hostOf(url);
  if (!host) return {};
  // exact host first, then parent domains (a.b.c.com also sees b.c.com / c.com)
  const parts = host.split(".");
  let out: Record<string, string> = {};
  for (let i = 0; i < parts.length - 1; i++) {
    const domain = parts.slice(i).join(".");
    out = { ...loadCookies(domain), ...out };
  }
  out = { ...out, ...loadCookies(host) };
  return out;
}

export function setCookiesFor(url: string, cookies: Record<string, string>): void {
  const host = hostOf(url);
  if (!host) return;
  saveCookies(host, { ...loadCookies(host), ...cookies });
}

/** Persist set-cookie values captured from a proxy response. */
export function storeSetCookies(url: string, setCookieValues: string[] | undefined): void {
  if (!setCookieValues || setCookieValues.length === 0) return;
  const host = hostOf(url);
  if (!host) return;
  const jar = loadCookies(host);
  for (const raw of setCookieValues) {
    const eq = raw.indexOf("=");
    const semi = raw.indexOf(";");
    if (eq < 1) continue;
    const name = raw.slice(0, eq).trim();
    const valueEnd = semi === -1 ? raw.length : semi;
    const value = raw.slice(eq + 1, valueEnd).trim();
    if (name !== "") jar[name] = value;
  }
  saveCookies(host, jar);
}
