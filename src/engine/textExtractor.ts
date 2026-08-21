/**
 * Port of NoveLA TextExtractor.kt: paragraph text extraction from a DOM node.
 * <p> → trimmed paragraph + "\n\n"; <br> → "\n"; <hr> → "\n\n";
 * top-level text nodes → trimmed + "\n\n".
 */

function imgEntry(el: Element): string {
  const src = el.getAttribute("src") ?? "";
  return `\n\n${src}\n\n`;
}

function pTraverse(node: Node): string {
  let out = "";
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeName === "br") out += "\n";
    else if (child.nodeName === "img") out += imgEntry(child as Element);
    else if (child.nodeType === Node.TEXT_NODE) out += child.textContent ?? "";
    else out += pTraverse(child);
  }
  return out.trim() + "\n\n";
}

function nodeTextTraverse(node: Node): string {
  let out = "";
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeName === "p") out += pTraverse(child);
    else if (child.nodeName === "br") out += "\n";
    else if (child.nodeName === "hr") out += "\n\n";
    else if (child.nodeName === "img") out += imgEntry(child as Element);
    else if (child.nodeType === Node.TEXT_NODE) {
      const t = (child.textContent ?? "").trim();
      if (t !== "") out += t + "\n\n";
    } else out += nodeTextTraverse(child);
  }
  return out;
}

export function extractText(node: Node | null): string {
  if (!node) return "";
  let out = "";
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeName === "p") out += pTraverse(child);
    else if (child.nodeName === "br") out += "\n";
    else if (child.nodeName === "hr") out += "\n\n";
    else if (child.nodeName === "img") out += imgEntry(child as Element);
    else if (child.nodeType === Node.TEXT_NODE) out += (child.textContent ?? "").trim();
    else out += nodeTextTraverse(child);
  }
  return out;
}

/** Jsoup Element.text() equivalent: normalized single-line text of the subtree. */
export function jsoupText(el: Element): string {
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}
