import JSZip from "jszip";
import { db } from "../db/db";

/**
 * Local book imports stored as pseudo-source "local_epub": book row in Dexie,
 * one chapter per spine section, chapter text pre-extracted into chapterCache
 * so the reader needs no source plugin.
 */
export const LOCAL_SOURCE_ID = "local_epub";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

function textOf(el: Element | null | undefined): string {
  return el?.textContent?.trim() ?? "";
}

/** Extract readable paragraph text from an XHTML/HTML document string. */
export function htmlToParagraphs(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style,nav,header,footer").forEach((n) => n.remove());
  const blocks = doc.querySelectorAll("p, h1, h2, h3, h4, h5, h6, blockquote, li");
  const out: string[] = [];
  if (blocks.length > 0) {
    blocks.forEach((b) => {
      const t = b.textContent?.replace(/\s+/g, " ").trim() ?? "";
      if (t) out.push(t);
    });
  } else {
    const t = doc.body?.textContent?.trim() ?? "";
    if (t) out.push(t);
  }
  return out;
}

async function importEpub(file: File): Promise<string> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());

  // container.xml → OPF path
  const container = await zip.file("META-INF/container.xml")?.async("string");
  const opfPath =
    container?.match(/full-path="([^"]+)"/)?.[1] ?? Object.keys(zip.files).find((f) => f.endsWith(".opf"));
  if (!opfPath) throw new Error("not a valid EPUB (no OPF found)");
  const opfText = (await zip.file(opfPath)?.async("string")) ?? "";
  const doc = new DOMParser().parseFromString(opfText, "application/xml");

  const baseDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const resolve = (href: string): string => baseDir + href;

  const title = textOf(doc.querySelector("title")) || file.name.replace(/\.epub$/i, "");
  const manifest = new Map<string, string>();
  doc.querySelectorAll("manifest > item").forEach((it) => {
    const id = it.getAttribute("id");
    const href = it.getAttribute("href");
    const mt = it.getAttribute("media-type") ?? "";
    if (id && href && (mt.includes("xhtml") || mt.includes("html"))) manifest.set(id, href);
  });

  const spineHrefs: string[] = [];
  doc.querySelectorAll("spine > itemref").forEach((ref) => {
    const idref = ref.getAttribute("idref");
    const href = idref ? manifest.get(idref) : undefined;
    if (href) spineHrefs.push(resolve(href));
  });
  if (spineHrefs.length === 0) throw new Error("EPUB has no readable spine items");

  const uuid = crypto.randomUUID();
  const bookUrl = `local:${uuid}`;
  const now = Date.now();

  await db.books.put({
    url: bookUrl,
    sourceId: LOCAL_SOURCE_ID,
    title,
    cover: "",
    description: `Imported ${file.name}`,
    inLibrary: true,
    contentType: "",
    addedAt: now,
  });

  for (let i = 0; i < spineHrefs.length; i++) {
    const raw = (await zip.file(spineHrefs[i])?.async("string")) ?? "";
    const paras = htmlToParagraphs(raw);
    const chUrl = `${bookUrl}#${i}`;
    await db.chapters.put({
      bookUrl,
      url: chUrl,
      title: paras[0]?.slice(0, 80) ?? `Section ${i + 1}`,
      position: i,
      read: false,
    });
    await db.chapterCache.put({ url: chUrl, text: paras.join("\n\n"), fetchedAt: now });
  }
  return bookUrl;
}

async function importFb2(file: File): Promise<string> {
  const xml = new DOMParser().parseFromString(await file.text(), "application/xml");
  if (xml.querySelector("parsererror")) throw new Error("invalid FB2 XML");
  const title =
    textOf(xml.querySelector("title-info book-title")) || file.name.replace(/\.fb2$/i, "");

  const sections = Array.from(xml.getElementsByTagName("section"));
  const bodies: string[][] = [];
  if (sections.length > 0) {
    for (const s of sections) {
      const paras = Array.from(s.getElementsByTagName("p"))
        .map((p) => p.textContent?.replace(/\s+/g, " ").trim() ?? "")
        .filter(Boolean);
      if (paras.length > 0) bodies.push(paras);
    }
  } else {
    const paras = Array.from(xml.getElementsByTagName("p"))
      .map((p) => p.textContent?.replace(/\s+/g, " ").trim() ?? "")
      .filter(Boolean);
    if (paras.length === 0) throw new Error("no text content found in FB2");
    bodies.push(paras);
  }

  const uuid = crypto.randomUUID();
  const bookUrl = `local:${uuid}`;
  const now = Date.now();

  await db.books.put({
    url: bookUrl,
    sourceId: LOCAL_SOURCE_ID,
    title,
    cover: "",
    description: `Imported ${file.name}`,
    inLibrary: true,
    contentType: "",
    addedAt: now,
  });

  for (let i = 0; i < bodies.length; i++) {
    const chUrl = `${bookUrl}#${i}`;
    await db.chapters.put({
      bookUrl,
      url: chUrl,
      title: bodies[i][0]?.slice(0, 80) ?? `Section ${i + 1}`,
      position: i,
      read: false,
    });
    await db.chapterCache.put({ url: chUrl, text: bodies[i].join("\n\n"), fetchedAt: now });
  }
  return bookUrl;
}

/** Import a local .epub or .fb2 file; resolves to the pseudo-book URL. */
export async function importLocalFile(file: File): Promise<string> {
  if (/\.epub$/i.test(file.name)) return importEpub(file);
  if (/\.fb2$/i.test(file.name)) return importFb2(file);
  throw new Error(`unsupported file type: ${esc(file.name)} (.epub or .fb2 expected)`);
}
