import { useEffect, useState } from "react";
import { db } from "../db/db";
import { rawImg } from "../lib/sources";
import type { Book } from "../db/db";

export default function Library() {
  const [books, setBooks] = useState<Book[] | null>(null);
  const [progress, setProgress] = useState<Map<string, { chapterUrl: string; position: number }>>(new Map());

  useEffect(() => {
    void (async () => {
      const [libs, prog] = await Promise.all([
        db.books.where("inLibrary").equals(1).toArray().catch(() => db.books.toArray()),
        db.progress.toArray(),
      ]);
      // Dexie can't index boolean; filter in JS.
      const inLib = libs.filter((b) => b.inLibrary);
      setBooks(inLib);
      setProgress(new Map(prog.map((p) => [p.bookUrl, p])));
    })();
  }, []);

  if (!books) return <p className="page">Loading…</p>;

  return (
    <div className="page">
      <h1>Library</h1>
      {books.length === 0 && (
        <p className="muted">
          Nothing saved yet. Browse a source and tap “Add to library”.
        </p>
      )}
      <div className="book-grid">
        {books.map((b) => {
          const p = progress.get(b.url);
          return (
            <a
              key={b.url}
              className="book-card"
              href={`/novel?source=${encodeURIComponent(b.sourceId)}&url=${encodeURIComponent(b.url)}`}
            >
              <img src={rawImg(b.cover)} alt="" loading="lazy" />
              <span className="book-title">{b.title}</span>
              {p && p.position > 0 && (
                <span className="badge">{Math.round(p.position * 100)}%</span>
              )}
            </a>
          );
        })}
      </div>
    </div>
  );
}
