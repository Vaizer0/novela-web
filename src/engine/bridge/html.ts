import { extractText, jsoupText } from "../textExtractor";

/**
 * Element wrapper handed to Lua. Wasmoon exposes JS class instances to Lua with
 * working property access and method calls (both `.` and `:`), so this mirrors
 * the Android elementToTable() surface: text/html/href/src/title/class/id props,
 * get_text/get_html/attr/remove/select methods.
 */
export class LuaElement {
  readonly node: Element;
  readonly baseURI: string;

  constructor(node: Element, baseURI = "") {
    this.node = node;
    // Do NOT inherit DOMParser's document.baseURI. In a web app that value is
    // the app's GitHub Pages origin, not the novel source. NoveLA's Jsoup
    // adapter intentionally leaves relative href/src values relative so each
    // Lua plugin can resolve them against its own baseUrl via url_resolve().
    this.baseURI = baseURI;
  }

  private abs(attr: string): string {
    const raw = this.node.getAttribute(attr) ?? "";
    if (raw === "") return "";
    if (!this.baseURI) return raw;
    try {
      return new URL(raw, this.baseURI).toString();
    } catch {
      return raw;
    }
  }

  get text(): string {
    return jsoupText(this.node);
  }

  get html(): string {
    return this.node.innerHTML;
  }

  get href(): string {
    return this.abs("href");
  }

  get src(): string {
    return this.abs("src");
  }

  get title(): string {
    return this.node.getAttribute("title") ?? "";
  }

  get class(): string {
    return this.node.getAttribute("class") ?? "";
  }

  get id(): string {
    return this.node.getAttribute("id") ?? "";
  }

  get_text(): string {
    return jsoupText(this.node);
  }

  get_html(): string {
    return this.node.innerHTML;
  }

  attr(name: string): string {
    return this.node.getAttribute(name) ?? "";
  }

  remove(): void {
    this.node.parentNode?.removeChild(this.node);
  }

  select(css: string): LuaElement[] {
    try {
      return selectJsoupCompatible(this.node, css).map((n) => new LuaElement(n, this.baseURI));
    } catch {
      return [];
    }
  }
}

export function parseHtml(html: string): Document {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return doc;
}

export function isLuaElement(v: unknown): v is LuaElement {
  return v instanceof LuaElement;
}

/** Accept either an HTML string or a LuaElement, like the Android bridges. */
export function rootFrom(v: unknown): { root: ParentNode; baseURI: string } | null {
  if (isLuaElement(v)) return { root: v.node, baseURI: v.baseURI };
  if (typeof v === "string") {
    const doc = parseHtml(v);
    return { root: doc, baseURI: "" };
  }
  return null;
}

/**
 * Browser CSS selectors cover almost all selectors used by the NoveLA sources,
 * but Jsoup also supports :contains(text), which is not part of native CSS.
 * Strip that pseudo-class for the browser query, then filter candidates by
 * their visible text. This also makes selectors like div:has(p:contains(x))
 * usable because modern browsers natively implement :has().
 */
function selectJsoupCompatible(root: ParentNode, css: string): Element[] {
  const containsValues: string[] = [];
  const withoutContains = css.replace(/:contains\(\s*(["']?)(.*?)\1\s*\)/g, (_all, _quote, value) => {
    containsValues.push(String(value));
    return "";
  });

  const candidates = Array.from(root.querySelectorAll(withoutContains || "*"));
  if (containsValues.length === 0) return candidates;

  return candidates.filter((el) => {
    const text = el.textContent ?? "";
    return containsValues.every((value) => text.includes(value));
  });
}

export function htmlSelect(v: unknown, css: string): LuaElement[] {
  const ctx = rootFrom(v);
  if (!ctx) return [];
  try {
    return selectJsoupCompatible(ctx.root, css).map((n) => new LuaElement(n, ctx.baseURI));
  } catch {
    return [];
  }
}

export function htmlSelectFirst(v: unknown, css: string): LuaElement | null {
  return htmlSelect(v, css)[0] ?? null;
}

/** html_text: TextExtractor semantics over an element or an HTML fragment. */
export function htmlText(v: unknown): string | null {
  if (isLuaElement(v)) return extractText(v.node);
  if (typeof v === "string") {
    const doc = parseHtml(v);
    return extractText(doc.body);
  }
  return null;
}

/** html_remove(html_or_element, sel1, ...) → cleaned html string. */
export function htmlRemove(v: unknown, ...selectors: string[]): string {
  if (isLuaElement(v)) {
    for (const sel of selectors) {
      if (!sel || sel.trim() === "") continue;
      try {
        for (const n of selectJsoupCompatible(v.node, sel)) n.remove();
      } catch {
        /* invalid selector → skip like Android catches */
      }
    }
    return v.html;
  }
  const doc = parseHtml(typeof v === "string" ? v : "");
  for (const sel of selectors) {
    if (!sel || sel.trim() === "") continue;
    try {
      for (const n of selectJsoupCompatible(doc, sel)) n.remove();
    } catch {
      /* skip */
    }
  }
  return doc.body.innerHTML;
}
