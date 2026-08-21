// Shared engine types — mirror Kotlin BookResult / ChapterResult / LuaFilter models.

export interface BookResult {
  title: string;
  url: string;
  cover: string;
  description?: string;
  rating?: string | null;
  contentType: "" | "novel" | "manga";
}

export interface ChapterResult {
  title: string;
  url: string;
  volume?: string | null;
  uploaded?: number | null;
}

export interface BookDetails extends BookResult {
  genres: string[];
  status?: string | null;
  lastUpdate?: string | null;
}

export interface CatalogPage {
  items: BookResult[];
  hasNext: boolean;
}

export interface PagedChapters {
  chapters: ChapterResult[];
  totalPages: number;
}

export interface LuaFilterOption {
  value: string;
  label: string;
}

export type LuaFilter =
  | { kind: "select"; key: string; label: string; options: LuaFilterOption[]; defaultValue: string }
  | { kind: "checkbox"; key: string; label: string; options: LuaFilterOption[]; multiselect: boolean }
  | { kind: "tristate"; key: string; label: string; options: LuaFilterOption[] }
  | { kind: "switch"; key: string; label: string; defaultValue: boolean }
  | { kind: "text"; key: string; label: string; defaultValue: string }
  | { kind: "sort"; key: string; label: string; options: LuaFilterOption[]; defaultValue: string; defaultAscending: boolean };

/** Active filter state → plain table passed to getCatalogFiltered(index, filters). */
export interface ActiveFilters {
  sortValues?: Record<string, string>;
  sortAscending?: Record<string, boolean>;
  selectValues?: Record<string, string>;
  checkboxIncluded?: Record<string, string[]>;
  triIncluded?: Record<string, string[]>;
  triExcluded?: Record<string, string[]>;
  switchValues?: Record<string, boolean>;
  textValues?: Record<string, string>;
}

export function activeFiltersToLuaTable(a: ActiveFilters): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a.sortValues ?? {})) if (v !== "") out[k] = v;
  for (const [k, v] of Object.entries(a.sortAscending ?? {})) out[`${k}_ascending`] = v ? "true" : "false";
  for (const [k, v] of Object.entries(a.selectValues ?? {})) if (v !== "") out[k] = v;
  for (const [k, vals] of Object.entries(a.checkboxIncluded ?? {})) if (vals.length > 0) out[`${k}_included`] = vals;
  for (const [k, vals] of Object.entries(a.triIncluded ?? {})) if (vals.length > 0) out[`${k}_included`] = vals;
  for (const [k, vals] of Object.entries(a.triExcluded ?? {})) if (vals.length > 0) out[`${k}_excluded`] = vals;
  for (const [k, v] of Object.entries(a.switchValues ?? {})) out[k] = v ? "true" : "false";
  for (const [k, v] of Object.entries(a.textValues ?? {})) if (v !== "") out[k] = v;
  return out;
}
