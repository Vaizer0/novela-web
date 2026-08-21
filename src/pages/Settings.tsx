import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { db } from "../db/db";
import { importLocalFile } from "../lib/localImport";
import {
  getTranslationConfig,
  setTranslationConfig,
  type TranslationConfig,
} from "../lib/translate";
import { getBypassProxyUrl, setBypassProxyUrl } from "../lib/bypass";

export default function Settings() {
  const [msg, setMsg] = useState("");
  const navigate = useNavigate();
  const [trCfg, setTrCfg] = useState<TranslationConfig>(getTranslationConfig);
  const [bypassUrl, setBypassUrl] = useState(getBypassProxyUrl);
  const [bypassStatus, setBypassStatus] = useState("");

  function updateTrCfg(patch: Partial<TranslationConfig>): void {
    setTrCfg((c) => {
      const next = { ...c, ...patch };
      setTranslationConfig(next);
      return next;
    });
  }

  async function testBypass(): Promise<void> {
    if (!bypassUrl.trim()) {
      setBypassStatus("Enter a FlareSolverr URL first (e.g. http://localhost:8191)");
      return;
    }
    setBypassProxyUrl(bypassUrl);
    setBypassStatus("Testing against freewebnovel.com…");
    try {
      const res = await fetch(`${bypassUrl.trim().replace(/\/$/, "")}/v1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cmd: "request.get", url: "https://freewebnovel.com/", maxTimeout: 60000 }),
      });
      const data = (await res.json()) as { status?: string; solution?: { response?: string } };
      const html = data.solution?.response ?? "";
      if (data.status === "ok" && /<html/i.test(html) && !/just a moment/i.test(html)) {
        setBypassStatus("✓ Working — Cloudflare-protected sources are now available.");
      } else {
        setBypassStatus("✗ Proxy reachable but the site is still blocked.");
      }
    } catch {
      setBypassStatus("✗ Could not reach the bypass proxy. Is it running?");
    }
  }

  function importBook(file: File): void {
    void (async () => {
      try {
        const bookUrl = await importLocalFile(file);
        navigate(`/novel?source=local_epub&url=${encodeURIComponent(bookUrl)}`);
      } catch (e) {
        setMsg(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  }

  async function exportBackup(): Promise<void> {
    const [books, chapters, progress, customPlugins, translationSettings] = await Promise.all([
      db.books.toArray(),
      db.chapters.toArray(),
      db.progress.toArray(),
      db.customPlugins.toArray(),
      db.translationSettings.toArray(),
    ]);
    const blob = new Blob(
      [JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), books, chapters, progress, customPlugins, translationSettings }, null, 2)],
      { type: "application/json" },
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `novela-web-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function importBackup(file: File): void {
    void (async () => {
      try {
        const data = JSON.parse(await file.text()) as {
          version: number;
          books?: unknown[];
          chapters?: unknown[];
          progress?: unknown[];
          customPlugins?: unknown[];
          translationSettings?: unknown[];
        };
        if (data.version !== 1) throw new Error(`unsupported backup version ${data.version}`);
        await db.transaction("rw", [db.books, db.chapters, db.progress, db.customPlugins, db.translationSettings], async () => {
          if (data.books) await db.books.bulkPut(data.books as never[]);
          if (data.chapters) await db.chapters.bulkPut(data.chapters as never[]);
          if (data.progress) await db.progress.bulkPut(data.progress as never[]);
          if (data.customPlugins) await db.customPlugins.bulkPut(data.customPlugins as never[]);
          if (data.translationSettings)
            await db.translationSettings.bulkPut(data.translationSettings as never[]);
        });
        setMsg("Backup restored. Reload to see changes.");
      } catch (e) {
        setMsg(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  }

  return (
    <div className="page">
      <h1>Settings</h1>
      <div className="row">
        <button onClick={() => void exportBackup()}>Export backup</button>
        <label>
          <input
            type="file"
            accept="application/json"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importBackup(f);
              e.target.value = "";
            }}
          />
        </label>
      </div>

      <h2>Translation</h2>
      <div className="card">
        <label>
          Backend
          <select
            value={trCfg.backend}
            onChange={(e) => updateTrCfg({ backend: e.target.value as TranslationConfig["backend"] })}
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
              size={6}
              placeholder="auto"
              value={trCfg.fromLang}
              onChange={(e) => updateTrCfg({ fromLang: e.target.value })}
            />
          </label>
          <label className="inline">
            to
            <input
              type="text"
              size={6}
              value={trCfg.toLang}
              onChange={(e) => updateTrCfg({ toLang: e.target.value })}
            />
          </label>
        </div>
        {trCfg.backend === "gemini" && (
          <label>
            Gemini API key
            <input
              type="password"
              value={trCfg.geminiKey ?? ""}
              onChange={(e) => updateTrCfg({ geminiKey: e.target.value })}
            />
          </label>
        )}
        {trCfg.backend === "openai-compatible" && (
          <>
            <label>
              Endpoint (e.g. https://api.openai.com/v1)
              <input
                type="text"
                value={trCfg.openaiEndpoint ?? ""}
                onChange={(e) => updateTrCfg({ openaiEndpoint: e.target.value })}
              />
            </label>
            <label>
              API key
              <input
                type="password"
                value={trCfg.openaiKey ?? ""}
                onChange={(e) => updateTrCfg({ openaiKey: e.target.value })}
              />
            </label>
            <label>
              Model
              <input
                type="text"
                placeholder="gpt-4o-mini"
                value={trCfg.openaiModel ?? ""}
                onChange={(e) => updateTrCfg({ openaiModel: e.target.value })}
              />
            </label>
          </>
        )}
        <p className="muted small">
          Google backends run through the server proxy; Gemini/OpenAI are called
          directly from your browser. Keys stay in this browser only.
        </p>
      </div>

      <h2>Cloudflare bypass</h2>
      <div className="card">
        <p className="muted small">
          Some sources (freewebnovel, novelfire, novelphoenix, …) block
          server-side fetchers via Cloudflare. Running a{" "}
          <a href="https://github.com/FlareSolverr/FlareSolverr" target="_blank" rel="noreferrer">
            FlareSolverr
          </a>{" "}
          instance (free, Docker: <code>ghcr.io/flaresolverr/flaresolverr</code>)
          and entering its URL here makes them work.
        </p>
        <label>
          FlareSolverr URL
          <input
            type="text"
            placeholder="http://localhost:8191"
            value={bypassUrl}
            onChange={(e) => setBypassUrl(e.target.value)}
            onBlur={() => setBypassProxyUrl(bypassUrl)}
          />
        </label>
        <div className="row">
          <button onClick={() => void testBypass()}>Save &amp; test</button>
        </div>
        {bypassStatus && <p className="muted small">{bypassStatus}</p>}
      </div>

      <h2>Local books</h2>
      <div className="row">
        <label>
          Import .epub / .fb2
          <input
            type="file"
            accept=".epub,.fb2,application/epub+zip,text/xml"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importBook(f);
              e.target.value = "";
            }}
          />
        </label>
      </div>

      {msg && <p className="muted">{msg}</p>}
      <p className="muted small">
        Reader appearance settings live on the reader screen (Aa button).
      </p>
    </div>
  );
}
