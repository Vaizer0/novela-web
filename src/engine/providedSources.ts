export interface ProvidedLuaSource {
  id: string;
  name: string;
  version: string;
  language: string;
  url: string;
}

// These are the 56 non-local extensions from the supplied ZIP whose Git blob
// hashes match HnDK0/external-sources at the pinned snapshot used by the ZIP.
// Keeping the upstream sources pinned makes them built-in without requiring
// the user to import the ZIP into IndexedDB on every browser/device.
export const PROVIDED_LUA_SOURCES: ProvidedLuaSource[] = [
  ["NovelArrow", "Novel Arrow", "1.0.4", "en", "en/NovelArrow.lua"],
  ["asurascans", "Asura Scans", "1.7.1", "en", "en/asurascans.lua"],
  ["baca_lightnovel", "Baca Lightnovel", "1.1.1", "id", "id/baca_lightnovel.lua"],
  ["biquge_company", "BiqugeCompany", "1.0.2", "zh", "zh/biquge_company.lua"],
  ["bookhamster", "Bookhamster", "1.2.0", "ru", "ru/bookhamster.lua"],
  ["chikari", "Chikari", "1.0.9", "en", "en/chikari.lua"],
  ["chrysanthemumgarden", "Chrysanthemum Garden", "1.0.0", "en", "en/chrysanthemumgarden.lua"],
  ["desu", "Desu", "1.1.3", "ru", "ru/desu.lua"],
  ["empirenovel", "Empire Novel", "2.4.1", "en", "en/empirenovel.lua"],
  ["faqwiki", "FAQ Wiki", "1.6.6", "en", "en/faqwiki.lua"],
  ["fictionzone", "Fiction Zone", "1.1.0", "en", "en/fictionzone.lua"],
  ["freewebnovel", "FreeWebNovel", "1.0.5", "en", "en/freewebnovel.lua"],
  ["galaxynovels", "Galaxy Novels", "1.0.0", "ar", "ar/galaxynovels.lua"],
  ["hiraethtranslation", "Hiraeth Translation", "1.0.0", "en", "en/hiraethtranslation.lua"],
  ["ifreedom", "iFreedom", "1.1.6", "ru", "ru/ifreedom.lua"],
  ["indowebnovel", "Indowebnovel", "1.1.1", "id", "id/indowebnovel.lua"],
  ["ixdzs8", "iXdzs8", "1.0.2", "zh", "zh/ixdzs8.lua"],
  ["jaomix", "Jaomix", "1.0.5", "ru", "ru/jaomix.lua"],
  ["konkon", "Konkon", "1.0.0", "en", "en/konkon.lua"],
  ["lightnovelpub", "LightNovelPub", "1.0.1", "en", "en/lightnovelpub.lua"],
  ["meionovels", "MeioNovels", "1.1.0", "id", "id/meionovels.lua"],
  ["nobadnovel", "NoBadNovel", "1.0.1", "en", "en/nobadnovel.lua"],
  ["novel543", "Novel543", "1.0.4", "zh", "zh/novel543.lua"],
  ["novelbuddy", "NovelBuddy", "3.0.3", "en", "en/novelbuddy_io.lua"],
  ["noveldragon", "Noveldragon", "1.0.0", "en", "en/noveldragon.lua"],
  ["novelfire", "NovelFire", "1.0.8", "en", "en/novelfire.lua"],
  ["novelfrance", "NovelFrance", "1.0.9", "fr", "fr/novelfrance.lua"],
  ["novelfull", "NovelFull", "1.0.7", "en", "en/novelfull.lua"],
  ["novelhall", "NovelHall", "1.0.3", "en", "en/novelhall.lua"],
  ["novelhi", "NovelHi", "1.0.9", "en", "en/novelhi.lua"],
  ["novelight", "Novelight", "1.0.9", "en", "en/novelight.lua"],
  ["novellive", "Novel Live", "1.0.2", "en", "en/novellive.lua"],
  ["novelnice", "NovelNice", "1.4.4", "en", "en/novelnice.lua"],
  ["novelphoenix", "Novel Phoenix", "1.0.8", "en", "en/novelphoenix.lua"],
  ["novelyra", "NovelYra", "2.0.0", "en", "en/novelyra.lua"],
  ["piaotia", "PiaoTia", "1.0.1", "zh", "zh/piaotia.lua"],
  ["quanben5", "Quanben5", "1.0.5", "zh", "zh/quanben5.lua"],
  ["ranobehub", "Ranobehub", "1.1.4", "ru", "ru/ranobehub.lua"],
  ["ranobelib", "RanobeLib", "1.0.8", "ru", "ru/ranobelib.lua"],
  ["ranobespace", "Ranobe.space", "1.1.3", "ru", "ru/ranobespace.lua"],
  ["read_novel_full", "ReadNovelFull", "1.1.1", "en", "en/readnovelfull.lua"],
  ["readfrom", "Read From Net", "1.5.1", "en", "en/readfrom.lua"],
  ["rewayatclub", "Rewayat Club", "1.0.0", "ar", "ar/rewayatclub.lua"],
  ["royal_road", "Royal Road", "1.1.6", "en", "en/royal_road.lua"],
  ["scribblehub", "ScribbleHub", "1.0.5", "en", "en/scribblehub.lua"],
  ["shuba69", "69shuba", "1.0.3", "zh", "zh/shuba69.lua"],
  ["sonicmtl", "Sonic MTL", "1.8.1", "mtl", "mtl/sonicmtl.lua"],
  ["sto9", "Sto9", "1.0.5", "zh", "zh/sto9.lua"],
  ["syosetu", "Syosetu", "1.1.0", "ja", "ja/syosetu.lua"],
  ["truthnovel", "Truth Novel", "1.1.1", "ar", "ar/truthnovel.lua"],
  ["ttkan", "TTKan", "1.1.1", "zh", "zh/ttkan.lua"],
  ["twkan", "TWKan", "1.0.1", "zh", "zh/twkan.lua"],
  ["webnovel", "WebNovel", "1.1.0", "en", "en/webnovel.lua"],
  ["wuxia_world_site", "WuxiaWorld.site", "1.1.1", "en", "en/wuxiaworld_site.lua"],
  ["wuxiabox", "WuxiaBox", "1.0.1", "en", "en/wuxiabox.lua"],
  ["xbiquge", "XBiquge", "1.0.3", "zh", "zh/xbiquge.lua"],
].map(([id, name, version, language, path]) => ({
  id,
  name,
  version,
  language,
  url: `https://raw.githubusercontent.com/HnDK0/external-sources/4b291650db35a16d3efd1565522ed5408815137b/${path}`,
}));

const codeCache = new Map<string, string>();

export function providedSourceEntry(source: ProvidedLuaSource) {
  return {
    id: source.id,
    name: source.name,
    version: source.version,
    baseUrl: "",
    icon: "",
    language: source.language,
    contentType: "",
    bundled: true,
    getCode: async () => {
      const cached = codeCache.get(source.id);
      if (cached) return cached;
      const res = await fetch(source.url, { cache: "force-cache" });
      if (!res.ok) throw new Error(`Failed to load built-in Lua source ${source.name} (HTTP ${res.status})`);
      const code = await res.text();
      if (!code.trim()) throw new Error(`Built-in Lua source ${source.name} returned empty code`);
      codeCache.set(source.id, code);
      return code;
    },
  };
}
