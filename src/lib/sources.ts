import { getEnabledSources, getSourceRuntime, listSources, type SourceEntry } from "../engine/registry";
import { rawImageUrl } from "./api";

export { getSourceRuntime };
/** Enabled registry entries (all bundled+custom when no explicit set stored). */
export async function getEnabledEntries(): Promise<SourceEntry[]> {
  const all = await listSources();
  const enabled = getEnabledSources();
  if (enabled === null) return all;
  return all.filter((s) => enabled.has(s.id));
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
