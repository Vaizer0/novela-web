import Dexie, { type EntityTable, type Table } from "dexie";
import type { BookResult, ChapterResult } from "../engine/types";

/** Library book (plan §19). url is the source-unique book URL. */
export interface Book {
  url: string;
  sourceId: string;
  title: string;
  cover: string;
  description: string;
  inLibrary: boolean;
  contentType: string; // "" | "novel" | "manga"
  addedAt: number;
}

export interface StoredChapter {
  /** compound key [bookUrl+url] */
  bookUrl: string;
  url: string;
  title: string;
  position: number;
  read: boolean;
  uploaded?: number | null;
}

export interface ChapterCacheEntry {
  url: string;
  text: string;
  fetchedAt: number;
}
export interface CustomPlugin {
  id: string;
  name: string;
  code: string;
  addedAt: number;
}

export interface TranslationSettings {
  bookUrl: string;
  enabled: boolean;
  backend: "google-simple" | "google-enhanced" | "gemini" | "openai-compatible";
  fromLang: string;
  toLang: string;
}

export interface ReadingProgress {
  bookUrl: string;
  chapterUrl: string;
  /** scroll fraction 0..1 within the chapter */
  position: number;
  updatedAt: number;
}

export interface TranslationCacheEntry {
  /** backend|from|to|sha256(text) */
  key: string;
  text: string;
}

export const db = new Dexie("novela-web") as Dexie & {
  books: EntityTable<Book, "url">;
  chapters: Table<StoredChapter, [string, string]>;
  chapterCache: EntityTable<ChapterCacheEntry, "url">;
  customPlugins: EntityTable<CustomPlugin, "id">;
  translationSettings: EntityTable<TranslationSettings, "bookUrl">;
  progress: EntityTable<ReadingProgress, "bookUrl">;
  translationCache: EntityTable<TranslationCacheEntry, "key">;
};

db.version(1).stores({
  books: "url",
  chapters: "[bookUrl+url], bookUrl",
  chapterCache: "url",
  customPlugins: "id",
  translationSettings: "bookUrl",
  progress: "bookUrl",
});

db.version(2).stores({
  translationCache: "key",
});

export function bookFromResult(sourceId: string, r: BookResult): Book {
  return {
    url: r.url,
    sourceId,
    title: r.title,
    cover: r.cover,
    description: r.description ?? "",
    inLibrary: false,
    contentType: r.contentType,
    addedAt: Date.now(),
  };
}

export function chapterFromResult(bookUrl: string, c: ChapterResult): StoredChapter {
  return {
    bookUrl,
    url: c.url,
    title: c.title,
    position: 0,
    read: false,
    uploaded: c.uploaded,
  };
}
