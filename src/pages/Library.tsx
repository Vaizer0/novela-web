import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
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
      const inLib = libs.filter((b) => b.inLibrary);
      setBooks(inLib);
      setProgress(new Map(prog.map((p) => [p.bookUrl, p])));
    })();
  }, []);

  if (!books) return <div className="page loading-state"><div className="skeleton-line skeleton-title" /><div className="skeleton-grid">{Array.from({ length: 6 }).map((_, i) => <div className="skeleton-cover" key={i} />)}</div></div>;

  const continueBook = books
    .map((book) => ({ book, progress: progress.get(book.url) }))
    .filter((x) => x.progress && x.progress.position > 0 && x.progress.position < 1)
    .sort((a, b) => (b.progress?.updatedAt ?? 0) - (a.progress?.updatedAt ?? 0))[0];

  return (
    <div className="page page-library">
      <div className="page-heading">
        <div>
          <span className="eyebrow">YOUR READING SPACE</span>
          <h1>Library</h1>
          <p className="muted">{books.length} saved {books.length === 1 ? "book" : "books"}</p>
        </div>
        <NavLink className="button button-primary" to="/browse">⌕ Discover</NavLink>
      </div>

      {continueBook && (
        <section className="continue-card">
          <div className="continue-cover"><img src={rawImg(continueBook.book.cover)} alt="" /></div>
          <div className="continue-copy">
            <span className="eyebrow">CONTINUE READING</span>
            <h2>{continueBook.book.title}</h2>
            <p className="muted">{continueBook.progress?.chapterUrl || "Resume where you left off"}</p>
            <div className="progress-track"><span style={{ width: `${Math.round((continueBook.progress?.position ?? 0) * 100)}%` }} /></div>
            <div className="continue-meta"><span>{Math.round((continueBook.progress?.position ?? 0) * 100)}% complete</span><span>›</span></div>
            <a className="button button-primary button-small" href={`/reader?source=${encodeURIComponent(continueBook.book.sourceId)}&bookUrl=${encodeURIComponent(continueBook.book.url)}&chapterUrl=${encodeURIComponent(continueBook.progress?.chapterUrl ?? "")}`}>Continue reading</a>
          </div>
        </section>
      )}

      <section className="library-section">
        <div className="section-heading"><h2>Your books</h2><span className="muted small">{books.length}</span></div>
        {books.length === 0 ? (
          <div className="empty-state card-surface">
            <div className="empty-icon">▦</div>
            <h2>Your library is empty</h2>
            <p className="muted">Find something worth reading and save it here.</p>
            <NavLink className="button button-primary" to="/browse">Browse novels</NavLink>
          </div>
        ) : (
          <div className="book-grid library-grid">
            {books.map((b) => {
              const p = progress.get(b.url);
              const percent = p ? Math.round(p.position * 100) : 0;
              return (
                <a key={b.url} className="book-card" href={`/novel?source=${encodeURIComponent(b.sourceId)}&url=${encodeURIComponent(b.url)}`}>
                  <div className="book-cover-wrap">
                    <img src={rawImg(b.cover)} alt="" loading="lazy" />
                    {percent > 0 && <span className="progress-badge">{percent}%</span>}
                  </div>
                  <div className="book-card-meta">
                    <span className="book-title">{b.title}</span>
                    <span className="book-subtitle">{b.contentType === "manga" ? "Manga" : "Web novel"}</span>
                    {percent > 0 && <div className="mini-progress"><span style={{ width: `${percent}%` }} /></div>}
                  </div>
                </a>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
