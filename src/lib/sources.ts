import { getEnabledSources, getSourceRuntime, listSources, type SourceEntry } from "../engine/registry";
import { rawImageUrl } from "./api";

export { getSourceRuntime };

/**
 * Sources available to Browse.
 *
 * Bundled Lua extensions are part of the web application and must never be
 * hidden by an old/stale localStorage `enabledSources` list from a previous
 * build. Custom/user-installed sources still respect the explicit enabled set.
 */
export async function getEnabledEntries(): Promise<SourceEntry[]> {
  const all = await listSources();
  const enabled = getEnabledSources();
  if (enabled === null) return all;

  return all.filter((s) => s.bundled || enabled.has(s.id));
}

export async function findEntry(id: string): Promise<SourceEntry | undefined> {
  const all = await listSources();
  return all.find((s) => s.id === id);
}

/** Route images through the raw proxy: avoids hotlink blocks and CORS noise. */
export function rawImg(url: string): string {
  if (!url) return "";
  return rawImageUrl(url);
}
