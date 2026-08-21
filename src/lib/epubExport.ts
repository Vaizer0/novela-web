import JSZip from "jszip";
import type { SourceEntry } from "../engine/registry";
import type { LuaSource } from "../engine/sourceAdapter";
import { getSourceRuntime } from "../engine/registry";
import { db } from "../db/db";
import { rawImageUrl } from "./api";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function chapterXhtml(title: string, paragraphs: string[]): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en">
<head><title>${esc(title)}</title><link rel="stylesheet" href="style.css"/></head>
<body>
<h2>${esc(title)}</h2>
${paragraphs.map((p) => `<p>${esc(p)}</p>`).join("\n")}
</body>
</html>`;
}

async function fetchBinary(url: string): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch(rawImageUrl(url));
    if (!res.ok) return null;
    return await res.arrayBuffer();
  } catch {
    return null;
  }
}

/**
 * Build and download an EPUB 3 for the given book. Chapter texts come from
 * the Dexie cache when present, otherwise they are fetched through the
 * source's adapter (and cached).
 */
export async function buildEpubZip(
  entry: SourceEntry,
  bookUrl: string,
  onProgress?: (done: number, total: number) => void,
  /** test hook: use this adapter instead of the registry runtime */
  srcOverride?: LuaSource,
): Promise<JSZip> {
  const src = srcOverride ?? (await getSourceRuntime(entry));
  const details = await src.bookDetails(bookUrl);
  const chapters = await src.chapters(bookUrl);

  const zip = new JSZip();
  // mimetype must be the first entry and uncompressed (ODF/EPUB requirement).
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
  );
  zip.file(
    "OEBPS/style.css",
    `body { font-family: serif; line-height: 1.6; margin: 1em; }
img { max-width: 100%; }`,
  );

  // Cover image (best effort).
  let coverProps = "";
  if (details.cover) {
    const buf = await fetchBinary(details.cover);
    if (buf && buf.byteLength > 0) {
      zip.file("OEBPS/cover.jpg", buf);
      coverProps = `<meta name="cover" content="cover-img"/>`;
      zip.file(
        "OEBPS/cover.xhtml",
        `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Cover</title></head>
<body style="margin:0;text-align:center"><img src="cover.jpg" alt="${esc(details.title)}"/></body></html>`,
      );
    }
  }

  const items: Array<{ id: string; href: string; title: string }> = [];
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    let text: string | null = null;
    const cached = await db.chapterCache.get(ch.url);
    if (cached) {
      text = cached.text;
    } else {
      try {
        const res = await src.fetchPage(ch.url);
        if (res.success) {
          text = await src.chapterText(res.body, ch.url);
          if (text !== null) {
            await db.chapterCache.put({ url: ch.url, text, fetchedAt: Date.now() });
          }
        }
      } catch {
        // skip failed chapters
      }
    }
    const paragraphs = (text ?? "")
      .split(/\n{2,}/)
      .map((s) => s.trim())
      .filter(Boolean);
    const id = `ch${i + 1}`;
    const href = `ch${i + 1}.xhtml`;
    zip.file(`OEBPS/${href}`, chapterXhtml(ch.title, paragraphs));
    items.push({ id, href, title: ch.title });
    onProgress?.(i + 1, chapters.length);
  }

  const uuid = crypto.randomUUID();
  const modified = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">urn:uuid:${uuid}</dc:identifier>
<dc:title>${esc(details.title)}</dc:title>
<dc:language>${entry.language || "en"}</dc:language>
<dc:creator>${esc(entry.name)}</dc:creator>
<meta property="dcterms:modified">${modified}</meta>
${coverProps}
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="css" href="style.css" media-type="text/css"/>
${details.cover ? '<item id="cover-img" href="cover.jpg" media-type="image/jpeg"/><item id="cover-page" href="cover.xhtml" media-type="application/xhtml+xml"/>' : ""}
${items.map((it) => `<item id="${it.id}" href="${it.href}" media-type="application/xhtml+xml"/>`).join("\n")}
</manifest>
<spine>
${details.cover ? '<itemref idref="cover-page"/>' : ""}
${items.map((it) => `<itemref idref="${it.id}"/>`).join("\n")}
</spine>
</package>`,
  );

  zip.file(
    "OEBPS/nav.xhtml",
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head>
<body>
<nav epub:type="toc"><h1>Contents</h1><ol>
${items.map((it) => `<li><a href="${it.href}">${esc(it.title)}</a></li>`).join("\n")}
</ol></nav>
</html>`,
  );

  return zip;
}

/** Build the EPUB and trigger a browser download. */
export async function exportEpub(
  entry: SourceEntry,
  bookUrl: string,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const zip = await buildEpubZip(entry, bookUrl, onProgress);
  const blob = await zip.generateAsync({ type: "blob", mimeType: "application/epub+zip" });
  const safeTitle = (entry.name || "book").replace(/[^\w\s-]/g, "").trim() || "book";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${safeTitle}.epub`;
  a.click();
  URL.revokeObjectURL(a.href);
}
