/** Per-book ordered cleanup rules applied to chapter text after extraction. */

export interface CleanupRule {
  find: string;
  replace: string;
  caseInsensitive: boolean;
}

function storageKey(bookUrl: string): string {
  return `cleanupRules:${bookUrl}`;
}

export function getRules(bookUrl: string): CleanupRule[] {
  try {
    const raw = localStorage.getItem(storageKey(bookUrl));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as CleanupRule[];
    return Array.isArray(parsed) ? parsed.filter((r) => r.find) : [];
  } catch {
    return [];
  }
}

export function setRules(bookUrl: string, rules: CleanupRule[]): void {
  localStorage.setItem(storageKey(bookUrl), JSON.stringify(rules));
}

/** Apply rules in order. Invalid regex patterns are skipped silently. */
export function applyRules(text: string, rules: CleanupRule[]): string {
  let out = text;
  for (const r of rules) {
    try {
      const re = new RegExp(r.find, r.caseInsensitive ? "gi" : "g");
      out = out.replace(re, r.replace);
    } catch {
      // invalid pattern — skip this rule
    }
  }
  return out;
}
