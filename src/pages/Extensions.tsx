import { useCallback, useEffect, useState } from "react";
import {
  listSources,
  getEnabledSources,
  setEnabledSources,
  installCustomPlugin,
  installCustomPluginFromUrl,
  removeCustomPlugin,
  type SourceEntry,
} from "../engine/registry";

export default function Extensions() {
  const [sources, setSources] = useState<SourceEntry[] | null>(null);
  const [enabled, setEnabled] = useState<Set<string> | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteName, setPasteName] = useState("");
  const [pasteCode, setPasteCode] = useState("");
  const [urlInput, setUrlInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const [list, en] = await Promise.all([listSources(), Promise.resolve(getEnabledSources())]);
    setSources(list);
    setEnabled(en);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function isEnabled(id: string): boolean {
    return enabled === null || enabled.has(id);
  }

  function toggle(id: string): void {
    // Materialize the explicit set on first toggle: current state minus id.
    const base = enabled ?? new Set((sources ?? []).map((s) => s.id));
    if (base.has(id)) base.delete(id);
    else base.add(id);
    setEnabled(new Set(base));
    setEnabledSources(base);
  }

  async function handleInstall(fn: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError("");
    try {
      await fn();
      setPasteCode("");
      setPasteName("");
      setUrlInput("");
      setPasteOpen(false);
      await refresh();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  if (!sources) return <p className="page">Loading sources…</p>;

  return (
    <div className="page">
      <h1>Extensions</h1>
      <p className="muted">
        {sources.length} sources · {sources.filter((s) => isEnabled(s.id)).length} enabled
      </p>

      <div className="row">
        <button onClick={() => setPasteOpen((v) => !v)}>Paste Lua</button>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (urlInput.trim()) void handleInstall(() => installCustomPluginFromUrl(urlInput.trim()));
          }}
        >
          <input
            type="url"
            placeholder="https://…/plugin.lua"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
          />
          <button type="submit" disabled={busy || !urlInput.trim()}>
            Add from URL
          </button>
        </form>
      </div>

      {pasteOpen && (
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            if (pasteCode.trim()) void handleInstall(() => installCustomPlugin(pasteName.trim() || "custom.lua", pasteCode));
          }}
        >
          <input
            placeholder="file name (optional)"
            value={pasteName}
            onChange={(e) => setPasteName(e.target.value)}
          />
          <textarea
            rows={10}
            placeholder="-- paste plugin Lua here"
            value={pasteCode}
            onChange={(e) => setPasteCode(e.target.value)}
          />
          <button type="submit" disabled={busy || !pasteCode.trim()}>
            Install
          </button>
        </form>
      )}

      {error && <p className="error">{error}</p>}

      <ul className="source-list">
        {sources.map((s) => (
          <li key={s.id} className="card">
            <img src={s.icon} alt="" width={32} height={32} loading="lazy" onError={(e) => (e.currentTarget.style.visibility = "hidden")} />
            <div className="grow">
              <strong>{s.name}</strong>{" "}
              <span className="muted">
                {s.language}
                {s.version ? ` · v${s.version}` : ""}
                {s.contentType ? ` · ${s.contentType}` : ""}
              </span>
              <div className="muted small">{s.baseUrl || s.id}</div>
            </div>
            {!s.bundled && (
              <button onClick={() => void handleInstall(() => removeCustomPlugin(s.id))}>
                Remove
              </button>
            )}
            <label className="toggle">
              <input type="checkbox" checked={isEnabled(s.id)} onChange={() => toggle(s.id)} />
              {isEnabled(s.id) ? "On" : "Off"}
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}
