import { useCallback, useEffect, useRef, useState } from "react";
import { getEnabledEntries } from "../lib/sources";
import { rawImageUrl } from "../lib/api";
import { getSourceRuntime, type SourceEntry } from "../engine/registry";
import type { ActiveFilters, BookResult, LuaFilter } from "../engine/types";
import { BookGrid } from "../components/BookGrid";

type Mode =
  | { kind: "catalog" }
  | { kind: "filtered"; filters: ActiveFilters }
  | { kind: "search"; query: string };

interface SearchGroup {
  source: SourceEntry;
  items: BookResult[];
  error?: string;
}

function defaultFilterState(filters: LuaFilter[]): ActiveFilters {
  const st: Required<Omit<ActiveFilters, never>> = {
    sortValues: {},
    sortAscending: {},
    selectValues: {},
    checkboxIncluded: {},
    triIncluded: {},
    triExcluded: {},
    switchValues: {},
    textValues: {},
  };
  for (const f of filters) {
    if (f.kind === "select") st.selectValues[f.key] = f.defaultValue ?? "";
    else if (f.kind === "sort") {
      st.sortValues[f.key] = f.defaultValue ?? "";
      st.sortAscending[f.key] = f.defaultAscending ?? true;
    } else if (f.kind === "switch") st.switchValues[f.key] = f.defaultValue ?? false;
    else if (f.kind === "text") st.textValues[f.key] = f.defaultValue ?? "";
  }
  return st;
}

export default function Browse() {
  const [sources, setSources] = useState<SourceEntry[] | null>(null);
  const [activeId, setActiveId] = useState<string>("");
  const [items, setItems] = useState<BookResult[]>([]);
  const [hasNext, setHasNext] = useState(false);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<Mode>({ kind: "catalog" });
  const [query, setQuery] = useState("");
  const [searchGroups, setSearchGroups] = useState<SearchGroup[] | null>(null);
  const [filters, setFilters] = useState<LuaFilter[]>([]);
  const [filterState, setFilterState] = useState<ActiveFilters>({});
  const [panelOpen, setPanelOpen] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void getEnabledEntries().then((list) => {
      setSources(list);
      if (list.length > 0) setActiveId(list[0].id);
    });
  }, []);

  // Load filter schema when the active source changes.
  useEffect(() => {
    if (!activeId) return;
    const entry = sources?.find((s) => s.id === activeId);
    if (!entry) return;
    let cancelled = false;
    void getSourceRuntime(entry)
      .then((src) => src.filters())
      .then((fs) => {
        if (cancelled) return;
        setFilters(fs);
        setFilterState(defaultFilterState(fs));
      })
      .catch(() => {
        if (!cancelled) setFilters([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeId, sources]);

  const loadPage = useCallback(
    async (src: SourceEntry, pageIndex: number, m: Mode, replace: boolean) => {
      setLoading(true);
      setError("");
      try {
        const runtime = await getSourceRuntime(src);
        const page =
          m.kind === "search"
            ? await runtime.catalogSearch(pageIndex, m.query)
            : m.kind === "filtered"
              ? await runtime.catalogFiltered(pageIndex, m.filters)
              : await runtime.catalogList(pageIndex);
        setItems((prev) => (replace ? page.items : [...prev, ...page.items]));
        setHasNext(page.hasNext);
        setIndex(pageIndex);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        if (replace) setItems([]);
        setHasNext(false);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // Reload when source or mode changes.
  useEffect(() => {
    const entry = sources?.find((s) => s.id === activeId);
    if (!entry) return;
    setSearchGroups(null);
    void loadPage(entry, 0, mode, true);
  }, [activeId, mode, sources, loadPage]);

  // Infinite scroll.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || searchGroups) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !loading && hasNext) {
          const entry = sources?.find((s) => s.id === activeId);
          if (entry) void loadPage(entry, index + 1, mode, false);
        }
      },
      { rootMargin: "400px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loading, hasNext, index, activeId, mode, sources, searchGroups, loadPage]);

  async function runSearch(q: string): Promise<void> {
    if (!q.trim() || !sources) return;
    setLoading(true);
    setError("");
    try {
      const groups = await Promise.all(
        sources.map(async (s): Promise<SearchGroup> => {
          try {
            const runtime = await getSourceRuntime(s);
            const page = await runtime.catalogSearch(0, q);
            return { source: s, items: page.items };
          } catch (e) {
            return { source: s, items: [], error: e instanceof Error ? e.message : String(e) };
          }
        }),
      );
      setSearchGroups(groups.filter((g) => g.items.length > 0 || g.error));
    } finally {
      setLoading(false);
    }
  }

  function applyFilters(): void {
    setPanelOpen(false);
    setSearchGroups(null);
    setMode({ kind: "filtered", filters: filterState });
  }

  if (!sources) return <p className="page">Loading…</p>;
  if (sources.length === 0)
    return (
      <div className="page">
        <h1>Browse</h1>
        <p className="muted">
          No enabled sources. Enable some on the <a href="/extensions">Extensions</a> page.
        </p>
      </div>
    );

  const activeEntry = sources.find((s) => s.id === activeId);

  return (
    <div className="page">
      <h1>Browse</h1>

      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void runSearch(query);
        }}
      >
        <input
          type="text"
          placeholder={`Search all ${sources.length} sources…`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit" disabled={loading || !query.trim()}>
          Search
        </button>
        {searchGroups && (
          <button
            type="button"
            onClick={() => {
              setSearchGroups(null);
              setQuery("");
            }}
          >
            Clear
          </button>
        )}
        {filters.length > 0 && !searchGroups && (
          <button type="button" onClick={() => setPanelOpen((v) => !v)}>
            Filters{mode.kind === "filtered" ? " •" : ""}
          </button>
        )}
      </form>

      {/* Source strip */}
      <div className="source-strip">
        {sources.map((s) => (
          <button
            key={s.id}
            className={s.id === activeId ? "strip-item active" : "strip-item"}
            onClick={() => setActiveId(s.id)}
            title={s.name}
          >
            <img src={rawImageUrl(s.icon)} alt="" loading="lazy" />
            <span>{s.name}</span>
          </button>
        ))}
      </div>

      {/* Filter panel */}
      {panelOpen && activeEntry && (
        <div className="card">
          {filters.map((f) => {
            switch (f.kind) {
              case "select":
                return (
                  <label key={f.key} className="filter-row">
                    {f.label}
                    <select
                      value={filterState.selectValues?.[f.key] ?? ""}
                      onChange={(e) =>
                        setFilterState((st) => ({
                          ...st,
                          selectValues: { ...st.selectValues, [f.key]: e.target.value },
                        }))
                      }
                    >
                      <option value="">—</option>
                      {f.options.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                );
              case "checkbox":
                return (
                  <fieldset key={f.key}>
                    <legend>{f.label}</legend>
                    {f.options.map((o) => {
                      const cur = filterState.checkboxIncluded?.[f.key] ?? [];
                      const checked = cur.includes(o.value);
                      return (
                        <label key={o.value} className="inline">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() =>
                              setFilterState((st) => {
                                const next = checked
                                  ? cur.filter((v) => v !== o.value)
                                  : [...cur, o.value];
                                return {
                                  ...st,
                                  checkboxIncluded: { ...st.checkboxIncluded, [f.key]: next },
                                };
                              })
                            }
                          />
                          {o.label}
                        </label>
                      );
                    })}
                  </fieldset>
                );
              case "tristate":
                return (
                  <fieldset key={f.key}>
                    <legend>{f.label}</legend>
                    {f.options.map((o) => {
                      const inc = filterState.triIncluded?.[f.key] ?? [];
                      const exc = filterState.triExcluded?.[f.key] ?? [];
                      const state = inc.includes(o.value) ? 1 : exc.includes(o.value) ? -1 : 0;
                      const cycle = () =>
                        setFilterState((st) => {
                          const nextInc = (st.triIncluded?.[f.key] ?? []).filter((v) => v !== o.value);
                          const nextExc = (st.triExcluded?.[f.key] ?? []).filter((v) => v !== o.value);
                          if (state === 0) nextInc.push(o.value);
                          else if (state === 1) nextExc.push(o.value);
                          return {
                            ...st,
                            triIncluded: { ...st.triIncluded, [f.key]: nextInc },
                            triExcluded: { ...st.triExcluded, [f.key]: nextExc },
                          };
                        });
                      return (
                        <button key={o.value} type="button" className="tri" onClick={cycle}>
                          {state === 0 ? "○" : state === 1 ? "✓" : "✗"} {o.label}
                        </button>
                      );
                    })}
                  </fieldset>
                );
              case "switch":
                return (
                  <label key={f.key} className="filter-row">
                    {f.label}
                    <input
                      type="checkbox"
                      checked={filterState.switchValues?.[f.key] ?? false}
                      onChange={(e) =>
                        setFilterState((st) => ({
                          ...st,
                          switchValues: { ...st.switchValues, [f.key]: e.target.checked },
                        }))
                      }
                    />
                  </label>
                );
              case "text":
                return (
                  <label key={f.key} className="filter-row">
                    {f.label}
                    <input
                      type="text"
                      value={filterState.textValues?.[f.key] ?? ""}
                      onChange={(e) =>
                        setFilterState((st) => ({
                          ...st,
                          textValues: { ...st.textValues, [f.key]: e.target.value },
                        }))
                      }
                    />
                  </label>
                );
              case "sort":
                return (
                  <label key={f.key} className="filter-row">
                    {f.label}
                    <select
                      value={filterState.sortValues?.[f.key] ?? ""}
                      onChange={(e) =>
                        setFilterState((st) => ({
                          ...st,
                          sortValues: { ...st.sortValues, [f.key]: e.target.value },
                        }))
                      }
                    >
                      <option value="">—</option>
                      {f.options.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                    <input
                      type="checkbox"
                      checked={filterState.sortAscending?.[f.key] ?? true}
                      onChange={(e) =>
                        setFilterState((st) => ({
                          ...st,
                          sortAscending: { ...st.sortAscending, [f.key]: e.target.checked },
                        }))
                      }
                    />
                    asc
                  </label>
                );
            }
          })}
          <div className="row">
            <button type="button" onClick={applyFilters}>
              Apply
            </button>
            <button
              type="button"
              onClick={() => {
                setFilterState(defaultFilterState(filters));
                setMode({ kind: "catalog" });
                setPanelOpen(false);
              }}
            >
              Reset
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="error">
          {error}
          {/cloudflare-blocked/i.test(error) && (
            <span className="muted small">
              {" "}
              This site blocks server-side fetchers. Run a FlareSolverr proxy and
              add its URL in Settings → Cloudflare bypass.
            </span>
          )}
        </p>
      )}
      {activeEntry && <p className="muted small">Source: {activeEntry.name}</p>}

      {searchGroups ? (
        <div>
          {searchGroups.map((g) => (
            <section key={g.source.id}>
              <h2>
                {g.source.name}{" "}
                <span className="muted small">
                  {g.error ? `error: ${g.error}` : `${g.items.length} results`}
                </span>
              </h2>
              <BookGrid items={g.items} sourceId={g.source.id} />
            </section>
          ))}
        </div>
      ) : (
        <>
          <BookGrid items={items} sourceId={activeId} />
          <div ref={sentinel} style={{ height: 1 }} />
          {loading && <p className="muted">Loading…</p>}
          {!loading && items.length === 0 && !error && <p className="muted">No results.</p>}
        </>
      )}
    </div>
  );
}
