import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { db } from "../db/db";
import { importLocalFile } from "../lib/localImport";

export default function Settings() {
  const [msg, setMsg] = useState("");
  const navigate = useNavigate();

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
