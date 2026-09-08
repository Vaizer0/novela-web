import { rawImg } from "../lib/sources";
import type { BookResult } from "../engine/types";

export function BookCard({ book, sourceId }: { book: BookResult; sourceId: string }) {
  return (
    <a
      className="book-card"
      href={`/novel?source=${encodeURIComponent(sourceId)}&url=${encodeURIComponent(book.url)}`}
    >
      <div className="book-cover-wrap">
        <img src={rawImg(book.cover)} alt="" loading="lazy" />
        <span className="book-badge">{book.contentType === "manga" ? "Manga" : "Novel"}</span>
      </div>
      <div className="book-card-meta">
        <span className="book-title">{book.title}</span>
        <span className="book-subtitle">{book.contentType === "manga" ? "Image reader" : "Web novel"}</span>
      </div>
    </a>
  );
}

export function BookGrid({ items, sourceId }: { items: BookResult[]; sourceId: string }) {
  return (
    <div className="book-grid">
      {items.map((b) => (
        <BookCard key={b.url} book={b} sourceId={sourceId} />
      ))}
    </div>
  );
}
