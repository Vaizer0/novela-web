import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { findEntry, rawImg } from "../lib/sources";
import { getSourceRuntime } from "../engine/registry";
import type { BookDetails } from "../engine/types";
import { db, bookFromResult, chapterFromResult } from "../db/db";
import { getRules, setRules, type CleanupRule } from "../lib/cleanup";
import { exportEpub } from "../lib/epubExport";

export default function Novel() {
  const [params] = useSearchParams();
  const bookUrl = params.get("url") ?? "";
  const sourceId = params.get("source") ?? "";
  const [details, setDetails] = useState<BookDetails | null>(null);
  const [chapters, setChapters] = useState<{ title: string; url: string }[]>([]);
  const [error, setError] = useState("");
  const [inLibrary, setInLibrary] = useState(false);
  const [reversed, setReversed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [rules, setRulesState] = useState<CleanupRule[]>([]);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [exporting, setExporting] = useState<{ done: number; total: number } | null>(null);
  const [exportError, setExportError] = useState("");

  useEffect(() => {
    setRulesState(getRules(bookUrl));
  }, [bookUrl]);

  function updateRules(next: CleanupRule[]): void {
    setRulesState(next);
    setRules(bookUrl, next);
  }

  useEffect(() => {
    if (!sourceId || !bookUrl) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    void (async () => {
      try {
        const entry = await findEntry(sourceId);
        if (!entry) throw new Error(`unknown source: ${sourceId}`);
        const src = await getSourceRuntime(entry);
        const [d, chs] = await Promise.all([src.bookDetails(bookUrl), src.chapters(bookUrl)]);
        if (cancelled) return;
        setDetails(d);
        setChapters(chs.map((c) => ({ title: c.title, url: c.url })));

        // Persist book + chapter list so the library/reader work offline.
        const prev = await db.books.get(bookUrl);
        await db.books.put({ ...bookFromResult(sourceId, d), inLibrary: prev?.inLibrary ?? false });
        const stored = chs.map((c, i) => ({ ...chapterFromResult(bookUrl, c), position: i }));
        await db.chapters.where("bookUrl").equals(bookUrl).delete();
        await db.chapters.bulkPut(stored);
        setInLibrary(prev?.inLibrary ?? false);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceId, bookUrl]);

  async function toggleLibrary(): Promise<void> {
    const book = await db.books.get(bookUrl);
    if (!book) return;
    const next = !book.inLibrary;
    await db.books.put({ ...book, inLibrary: next, addedAt: next ? Date.now() : book.addedAt });
    setInLibrary(next);
  }

  async function handleExport(): Promise<void> {
    const entry = await findEntry(sourceId);
    if (!entry) return;
    setExportError("");
    setExporting({ done: 0, total: 0 });
    try {
      await exportEpub(entry, bookUrl, (done, total) => setExporting({ done, total }));
    } catch (e) {
      setExportError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(null);
    }
  }

  const shown = useMemo(() => (reversed ? [...chapters].reverse() : chapters), [chapters, reversed]);

  const readerHref = useCallback(
    (chapterUrl: string) =>
      `/reader?source=${encodeURIComponent(sourceId)}&bookUrl=${encodeURIComponent(bookUrl)}&chapterUrl=${encodeURIComponent(chapterUrl)}`,
    [sourceId, bookUrl],
  );

  if (!sourceId || !bookUrl) return <div className="page">Missing source or url parameter.</div>;
  if (loading) return <p className="page">Loading…</p>;
  if (error)
    return (
      <div className="page">
        <p className="error">{error}</p>
        <p className="muted">
          If this source is behind Cloudflare it cannot work from a web server.
        </p>
      </div>
    );
  if (!details) return null;

  return (
    <div className="page novel">
      <div className="novel-head">
        <img className="novel-cover" src={rawImg(details.cover)} alt="" />
        <div>
          <h1>{details.title}</h1>
          {details.rating && <p className="muted">Rating: {details.rating}</p>}
          {details.status && <p className="muted">Status: {details.status}</p>}
          {details.lastUpdate && <p className="muted">Updated: {details.lastUpdate}</p>}
          {details.genres.length > 0 && <p className="muted small">{details.genres.join(", ")}</p>}
          <button onClick={() => void toggleLibrary()}>
            {inLibrary ? "✓ In library" : "+ Add to library"}
          </button>
        </div>
          <button onClick={() => void handleExport()} disabled={exporting !== null}>
            {exporting ? `Exporting ${exporting.done}/${exporting.total}…` : "Export EPUB"}
          </button>
          {exportError && <p className="error">{exportError}</p>}
      </div>

      <div className="row">
        <button onClick={() => setRulesOpen((v) => !v)}>
          Cleanup rules{rules.length > 0 ? ` (${rules.length})` : ""}
        </button>
      </div>
      {rulesOpen && (
        <div className="card">
          {rules.map((r, i) => (
            <div key={i} className="row">
              <input
                type="text"
                placeholder="find (regex)"
                value={r.find}
                onChange={(e) => {
                  const next = [...rules];
                  next[i] = { ...r, find: e.target.value };
                  updateRules(next);
                }}
              />
              <input
                type="text"
                placeholder="replace with"
                value={r.replace}
                onChange={(e) => {
                  const next = [...rules];
                  next[i] = { ...r, replace: e.target.value };
                  updateRules(next);
                }}
              />
              <label className="inline">
                <input
                  type="checkbox"
                  checked={r.caseInsensitive}
                  onChange={(e) => {
                    const next = [...rules];
                    next[i] = { ...r, caseInsensitive: e.target.checked };
                    updateRules(next);
                  }}
                />
                aA
              </label>
              <button onClick={() => updateRules(rules.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <button
            onClick={() => updateRules([...rules, { find: "", replace: "", caseInsensitive: false }])}
          >
            + Add rule
          </button>
        </div>
      )}
      {details.description && <p className="novel-desc">{details.description}</p>}

      <div className="row">
        <h2 style={{ margin: 0 }}>Chapters ({chapters.length})</h2>
        <button onClick={() => setReversed((v) => !v)}>
          {reversed ? "↑ Newest first" : "↓ Oldest first"}
        </button>
      </div>
      <ol className="chapter-list">
        {shown.map((c) => (
          <li key={c.url}>
            <a href={readerHref(c.url)}>{c.title}</a>
          </li>
        ))}
      </ol>
    </div>
  );
}
