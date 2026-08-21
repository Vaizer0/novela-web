import { htmlSelect, isLuaElement } from "./html";

/** detect_pagination(html_or_element) → {hasNext, next_url} (Jsoup :contains semantics). */
export function detectPagination(v: unknown): { hasNext: boolean; next_url?: string } {
  try {
    const anchors = isLuaElement(v) ? v.select("a[href]") : htmlSelect(v as string, "a[href]");
    const markers = ["next", "›", "»"];
    for (const a of anchors) {
      const text = a.text;
      const href = a.attr("href");
      if (markers.some((m) => text.includes(m) || href.includes(m))) {
        return { hasNext: true, next_url: a.href || undefined };
      }
    }
    return { hasNext: false };
  } catch {
    return { hasNext: false };
  }
}


export const logInfo = (msg?: string): void => console.info("[lua]", msg ?? "");
export const logError = (msg?: string): void => console.error("[lua]", msg ?? "");
export const osTime = (): number => Date.now();
export const sleep = (ms?: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms ?? 500);
  return promise;
};
