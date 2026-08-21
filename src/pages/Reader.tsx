import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { findEntry, getSourceRuntime, rawImg } from "../lib/sources";
import { db } from "../db/db";
import { applyRules, getRules } from "../lib/cleanup";
import { LOCAL_SOURCE_ID } from "../lib/localImport";
import { TtsPlayer } from "../components/TtsPlayer";
import {
  getTranslationConfig,
  getBookTranslationSettings,
  setBookTranslationSettings,
  getBookTranslateEnabled,
  setBookTranslateEnabled,
  translateParagraphs,
  type TranslationConfig,
} from "../lib/translate";
import type { TtsWordPos } from "../components/TtsPlayer";

interface ReaderSettings {
  fontSize: number;
  lineHeight: number;
  theme: "light" | "dark";
}

const SETTINGS_KEY = "readerSettings";

function loadSettings(): ReaderSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { fontSize: 18, lineHeight: 1.7, theme: "light", ...JSON.parse(raw) };
  } catch {
    /* fall through */
  }
  return { fontSize: 18, lineHeight: 1.7, theme: "light" };
}

export default function Reader() {
  const [params] = useSearchParams();
  const sourceId = params.get("source") ?? "";
  const bookUrl = params.get("bookUrl") ?? "";
  const chapterUrl = params.get("chapterUrl") ?? "";

  const [text, setText] = useState<string | null>(null);
  const [pages, setPages] = useState<string[] | null>(null); // manga mode
  const [error, setError] = useState("");
  const [settings, setSettings] = useState<ReaderSettings>(loadSettings);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [translateOn, setTranslateOn] = useState(false);
  const [translated, setTranslated] = useState<string[] | null>(null);
  const [translating, setTranslating] = useState(false);
  const [trProgress, setTrProgress] = useState({ done: 0, total: 0 });
  const [trConfig, setTrConfig] = useState<TranslationConfig>(() => getTranslationConfig());
  const [ttsWord, setTtsWord] = useState<TtsWordPos | null>(null);
  const [nav, setNav] = useState<{ prev: string | null; next: string | null; title: string }>({
    prev: null,
    next: null,
    title: "",
  });
  const saveTimer = useRef<number>(0);

  useEffect(() => {
    if (!bookUrl) return;
    void db.chapters
      .where("bookUrl")
      .equals(bookUrl)
      .sortBy("position")
      .then((chs) => {
        const i = chs.findIndex((c) => c.url === chapterUrl);
        setNav({
          prev: i > 0 ? chs[i - 1].url : null,
          next: i >= 0 && i < chs.length - 1 ? chs[i + 1].url : null,
          title: chs[i]?.title ?? "",
        });
      });
  }, [bookUrl, chapterUrl]);

  // Load per-book translation settings (falls back to global config).
  useEffect(() => {
    if (!bookUrl) return;
    void (async () => {
      setTrConfig(await getBookTranslationSettings(bookUrl));
      setTranslateOn(await getBookTranslateEnabled(bookUrl));
    })();
  }, [bookUrl]);

  // Fetch chapter content.
  useEffect(() => {
    if (!sourceId || !chapterUrl) return;
    let cancelled = false;
    setError("");
    setText(null);
    setPages(null);
    void (async () => {
      try {
        // Local imports: text is pre-extracted into the chapter cache.
        if (sourceId === LOCAL_SOURCE_ID) {
          const local = await db.chapterCache.get(chapterUrl);
          if (!cancelled) setText(local?.text ?? "(missing content)");
          return;
        }
        // Cached text first (novel mode).
        const cached = await db.chapterCache.get(chapterUrl);
        const entry = await findEntry(sourceId);
        if (!entry) throw new Error(`unknown source: ${sourceId}`);
        const src = await getSourceRuntime(entry);
        if (src.hasGetPageList) {
          let html = cached?.text ?? "";
          if (!html) {
            const res = await src.fetchPage(chapterUrl);
            html = res.body;
            await db.chapterCache.put({ url: chapterUrl, text: html, fetchedAt: Date.now() });
          }
          const list = await src.pageList(html, chapterUrl);
          if (!cancelled && list) setPages(list);
          else if (!cancelled) throw new Error("no pages returned");
        } else {
          if (cached) {
            if (!cancelled) setText(cached.text);
            return;
          }
          const res = await src.fetchPage(chapterUrl);
          const t = await src.chapterText(res.body, chapterUrl);
          if (t !== null) {
            await db.chapterCache.put({ url: chapterUrl, text: t, fetchedAt: Date.now() });
          }
          if (!cancelled) setText(t ?? "(empty chapter)");
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceId, chapterUrl]);

  // Debounced progress persistence.
  const onScroll = useCallback(() => {
    if (!bookUrl || !chapterUrl) return;
    const doc = document.documentElement;
    const max = doc.scrollHeight - window.innerHeight;
    const pos = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void db.progress.put({
        bookUrl,
        chapterUrl,
        position: pos,
        updatedAt: Date.now(),
      });
    }, 500);
  }, [bookUrl, chapterUrl]);

  useEffect(() => {
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [onScroll]);

  // Restore saved scroll position once content renders.
  const restored = useRef(false);
  useEffect(() => {
    if ((text === null && pages === null) || restored.current) return;
    restored.current = true;
    void db.progress.get(bookUrl).then((p) => {
      if (p && p.chapterUrl === chapterUrl && p.position > 0) {
        requestAnimationFrame(() => {
          const doc = document.documentElement;
          window.scrollTo(0, p.position * (doc.scrollHeight - window.innerHeight));
        });
      } else {
        window.scrollTo(0, 0);
      }
    });
  }, [text, pages, bookUrl, chapterUrl]);
  /** Wrap the currently spoken word in a <mark>. */
  function highlight(text: string, pos: TtsWordPos | null, para: number, isSpoken: boolean): ReactNode {
    if (!pos || pos.para !== para) return text;
    // when translation is shown, only the translated column is spoken
    if (translated && !isSpoken) return text;
    const { start, end } = pos;
    if (start < 0 || end > text.length || start >= end) return text;
    return (
      <>
        {text.slice(0, start)}
        <mark className="tts-word">{text.slice(start, end)}</mark>
        {text.slice(end)}
      </>
    );
  }

  function chapterHref(url: string | null): string {
    if (!url) return "";
    return `/reader?source=${encodeURIComponent(sourceId)}&bookUrl=${encodeURIComponent(bookUrl)}&chapterUrl=${encodeURIComponent(url)}`;
  }
  const rules = useMemo(() => getRules(bookUrl), [bookUrl]);
  const paragraphs = useMemo(() => {
    if (!text) return [];
    return applyRules(text, rules)
      .split(/\n{2,}/)
      .filter((p) => p.trim());
  }, [text, rules]);
  useEffect(() => {
    if (!translateOn || paragraphs.length === 0) {
      setTranslated(null);
      return;
    }
    let cancelled = false;
    setTranslating(true);
    setTranslated(null);
    void (async () => {
      const result = await translateParagraphs(paragraphs, trConfig, (done, total) =>
        setTrProgress({ done, total }),
      );
      if (!cancelled) {
        setTranslated(result);
        setTranslating(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [translateOn, paragraphs, trConfig]);

  if (!sourceId || !chapterUrl) return <div className="page">Missing parameters.</div>;

  const dark = settings.theme === "dark";

  return (
    <div className="reader" style={{ background: dark ? "#111" : "#fff", color: dark ? "#eee" : "#222", minHeight: "100vh" }}>
      <div className="reader-bar">
        {nav.prev ? (
          <a href={chapterHref(nav.prev)}>← Prev</a>
        ) : (
          <span className="muted">← Prev</span>
        )}
        <button onClick={() => setDrawerOpen((v) => !v)}>Aa</button>
        <a href={`/novel?source=${encodeURIComponent(sourceId)}&url=${encodeURIComponent(bookUrl)}`}>
          Contents
        </a>
        {nav.next ? (
          <a href={chapterHref(nav.next)}>Next →</a>
        ) : (
          <span className="muted">Next →</span>
        )}
      </div>

      {drawerOpen && (
        <div className="card reader-drawer">
          <label>
            Font size
            <input
              type="range"
              min={12}
              max={32}
              value={settings.fontSize}
              onChange={(e) =>
                setSettings((s) => {
                  const next = { ...s, fontSize: Number(e.target.value) };
                  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
                  return next;
                })
              }
            />
          </label>
          <label>
            Line height
            <input
              type="range"
              min={1}
              max={2.4}
              step={0.1}
              value={settings.lineHeight}
              onChange={(e) =>
                setSettings((s) => {
                  const next = { ...s, lineHeight: Number(e.target.value) };
                  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
                  return next;
                })
              }
            />
          </label>
          <label>
            Theme
            <select
              value={settings.theme}
              onChange={(e) =>
                setSettings((s) => {
                  const next = { ...s, theme: e.target.value as ReaderSettings["theme"] };
                  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
                  return next;
                })
              }
            >
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>

          <hr />
          <label className="inline">
            <input
              type="checkbox"
              checked={translateOn}
              onChange={(e) => {
                setTranslateOn(e.target.checked);
                void setBookTranslateEnabled(bookUrl, e.target.checked);
              }}
            />
            Translate
          </label>
          <label>
            Backend
            <select
              value={trConfig.backend}
              onChange={(e) => {
                const cfg = { ...trConfig, backend: e.target.value as TranslationConfig["backend"] };
                setTrConfig(cfg);
                void setBookTranslationSettings(bookUrl, cfg);
              }}
            >
              <option value="google-simple">Google (simple)</option>
              <option value="google-enhanced">Google (batch)</option>
              <option value="gemini">Gemini</option>
              <option value="openai-compatible">OpenAI-compatible</option>
            </select>
          </label>
          <div className="row">
            <label className="inline">
              from
              <input
                type="text"
                size={4}
                value={trConfig.fromLang}
                onChange={(e) => {
                  const cfg = { ...trConfig, fromLang: e.target.value };
                  setTrConfig(cfg);
                  void setBookTranslationSettings(bookUrl, cfg);
                }}
              />
            </label>
            <label className="inline">
              to
              <input
                type="text"
                size={4}
                value={trConfig.toLang}
                onChange={(e) => {
                  const cfg = { ...trConfig, toLang: e.target.value };
                  setTrConfig(cfg);
                  void setBookTranslationSettings(bookUrl, cfg);
                }}
              />
            </label>
          </div>
          {(trConfig.backend === "gemini" || trConfig.backend === "openai-compatible") && (
            <p className="muted small">API keys are configured in Settings → Translation.</p>
          )}
          {translating && (
            <span className="muted small">
              Translating {trProgress.done}/{trProgress.total}…
            </span>
          )}
        </div>
      )}

      {paragraphs.length > 0 && (
        <TtsPlayer
          paragraphs={paragraphs}
          speakTexts={translated ?? paragraphs}
          lang={translated ? trConfig.toLang : ""}
          onWord={setTtsWord}
          onAdvance={() => {
            if (nav.next) window.location.href = chapterHref(nav.next);
          }}
        />
      )}

      <div className="reader-content" style={{ fontSize: settings.fontSize, lineHeight: settings.lineHeight }}>
        <h2>{nav.title}</h2>
        {error && <p className="error">{error}</p>}
        {!error && text === null && pages === null && <p className="muted">Loading…</p>}
        {paragraphs.length > 0 && translated && (
          <div className="bilingual">
            {paragraphs.map((p, i) => (
              <div key={i} className="bi-row">
                <p id={`para-${i}`} className={ttsWord?.para === i ? "tts-active" : undefined}>
                  {highlight(p, ttsWord, i, false)}
                </p>
                <p className={ttsWord?.para === i ? "tts-active" : undefined}>
                  {highlight(translated[i] ?? "", ttsWord, i, true)}
                </p>
              </div>
            ))}
          </div>
        )}
        {paragraphs.length > 0 && !translated && (
          <div>
            {paragraphs.map((p, i) => (
              <p
                key={i}
                id={`para-${i}`}
                className={ttsWord?.para === i ? "tts-active" : undefined}
              >
                {highlight(p, ttsWord, i, false)}
              </p>
            ))}
          </div>
        )}
        {pages && (
          <div className="manga-pages">
            {pages.map((u) => (
              <img key={u} src={rawImg(u)} alt="" loading="lazy" />
            ))}
          </div>
        )}
      </div>

      {/* Tap zones */}
      <div className="tap-zones">
        <div onClick={() => nav.prev && (window.location.href = chapterHref(nav.prev))} />
        <div onClick={() => setDrawerOpen((v) => !v)} />
        <div onClick={() => nav.next && (window.location.href = chapterHref(nav.next))} />
      </div>
    </div>
  );
}
