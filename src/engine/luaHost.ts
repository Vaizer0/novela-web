import { LuaEngine, LuaFactory } from "wasmoon";
import { makeHttpBridge, type PageFetcher } from "./bridge/http";
import { htmlRemove, htmlSelect, htmlSelectFirst, htmlText, parseHtml, LuaElement } from "./bridge/html";
import {
  aesDecrypt,
  base64Decode,
  base64Encode,
  regexMatch,
  regexReplace,
  stringClean,
  unescapeUnicode,
  urlEncode,
  urlEncodeCharset,
  urlResolve,
} from "./bridge/str";
import { getPreference, setPreference } from "./bridge/storage";
import { getCookiesFor, setCookiesFor } from "./bridge/storage";
import { detectPagination, logError, logInfo, osTime, sleep } from "./bridge/misc";

/**
 * One sandboxed Lua runtime per source instance. Calls are serialized by the
 * adapter's mutex (mirrors Android's per-source Mutex — LuaJ/wasmoon states
 * are not thread-safe).
 */
export interface SourceRuntime {
  lua: LuaEngine;
}

/** Strip dangerous globals inside the VM (wasmoon can't push JS null as nil). */
const SANDBOX_CHUNK = `
luajava = nil
io = nil
load = nil
loadfile = nil
loadstring = nil
dofile = nil
require = nil
package = nil
debug = nil
`;

/**
 * LuaJ-era compat shims + os hardening + async-bridge sync wrappers.
 *
 * Async bridge functions are registered as __impl_* globals; __make_sync wraps
 * them so plugin code can call them synchronously (Android semantics): the
 * promise's :await() suspends the thread until resolved. This only works while
 * execution is driven by wasmoon (doString / thread.run), which the adapter
 * guarantees for every entry-point invocation.
 */
const COMPAT_CHUNK = `
-- os hardening (keep time/date/clock/difftime)
os.execute = function() error("sandbox: os.execute blocked", 2) end
os.exit = function() error("sandbox: os.exit blocked", 2) end
os.getenv = function() return nil end
os.rename = function() error("sandbox: os.rename blocked", 2) end
os.remove = function() error("sandbox: os.remove blocked", 2) end
os.tmpname = function() error("sandbox: os.tmpname blocked", 2) end

-- LuaJ-era shims
if not unpack then unpack = table.unpack end
if not bit then bit = setmetatable({}, { __index = function() return function() return 0 end end }) end

-- async bridge -> synchronous wrapper
function __make_sync(jsfn)
  return function(...)
    local args = table.pack(...)
    local p = jsfn(table.unpack(args, 1, args.n))
    if type(p) == "userdata" and p.await then
      return p:await()
    end
    return p
  end
end

http_get       = __make_sync(__impl_http_get)
http_post      = __make_sync(__impl_http_post)
http_get_batch = __make_sync(__impl_http_get_batch)
aes_decrypt    = __make_sync(__impl_aes_decrypt)
sleep          = __make_sync(__impl_sleep)

-- Pure-Lua JSON decoder. JS objects returned from bridge functions arrive as
-- userdata proxies (pairs()/type()=="table" fail on them), so JSON must be
-- decoded inside the VM into genuine tables.
__json_decode = (function()
  local function skip_ws(s, i)
    local c = string.sub(s, i, i)
    while c == " " or c == "\\t" or c == "\\n" or c == "\\r" do
      i = i + 1
      c = string.sub(s, i, i)
    end
    return i
  end
  local escapes = { ['"'] = '"', ["\\\\"] = "\\\\", ["/"] = "/", b = "\\b", f = "\\f", n = "\\n", r = "\\r", t = "\\t" }

  local parse_value

  local function parse_string(s, i)
    i = i + 1 -- opening quote
    local buf = {}
    while true do
      local c = string.sub(s, i, i)
      if c == "" then error("unterminated string") end
      if c == '"' then return table.concat(buf), i + 1 end
      if c == "\\\\" then
        local e = string.sub(s, i + 1, i + 1)
        if e == "u" then
          local code = tonumber(string.sub(s, i + 2, i + 5), 16)
          if not code then error("bad unicode escape") end
          i = i + 6
          if code >= 0xD800 and code <= 0xDBFF and string.sub(s, i, i + 1) == "\\\\u" then
            local lo = tonumber(string.sub(s, i + 2, i + 5), 16)
            if lo and lo >= 0xDC00 and lo <= 0xDFFF then
              code = 0x10000 + (code - 0xD800) * 0x400 + (lo - 0xDC00)
              i = i + 6
            end
          end
          buf[#buf + 1] = utf8.char(code)
        else
          local mapped = escapes[e]
          if not mapped then error("bad escape \\\\" .. e) end
          buf[#buf + 1] = mapped
          i = i + 2
        end
      else
        buf[#buf + 1] = c
        i = i + 1
      end
    end
  end

  local function parse_number(s, i)
    local j = i
    while j <= #s and string.find("+-0123456789.eE", string.sub(s, j, j), 1, true) do
      j = j + 1
    end
    local n = tonumber(string.sub(s, i, j - 1))
    if not n then error("bad number") end
    return n, j
  end

  parse_value = function(s, i)
    i = skip_ws(s, i)
    local c = string.sub(s, i, i)
    if c == '"' then return parse_string(s, i) end
    if c == "{" then
      local obj = {}
      i = skip_ws(s, i + 1)
      if string.sub(s, i, i) == "}" then return obj, i + 1 end
      while true do
        local k
        k, i = parse_string(s, skip_ws(s, i))
        i = skip_ws(s, i)
        if string.sub(s, i, i) ~= ":" then error("expected :") end
        local v
        v, i = parse_value(s, i + 1)
        obj[k] = v
        i = skip_ws(s, i)
        local d = string.sub(s, i, i)
        if d == "," then i = i + 1
        elseif d == "}" then return obj, i + 1
        else error("expected , or }") end
      end
    end
    if c == "[" then
      local arr = {}
      i = skip_ws(s, i + 1)
      if string.sub(s, i, i) == "]" then return arr, i + 1 end
      local n = 0
      while true do
        local v
        v, i = parse_value(s, i)
        n = n + 1
        arr[n] = v
        i = skip_ws(s, i)
        local d = string.sub(s, i, i)
        if d == "," then i = i + 1
        elseif d == "]" then return arr, i + 1
        else error("expected , or ]") end
      end
    end
    if string.sub(s, i, i + 3) == "true" then return true, i + 4 end
    if string.sub(s, i, i + 4) == "false" then return false, i + 5 end
    if string.sub(s, i, i + 3) == "null" then return nil, i + 4 end
    return parse_number(s, i)
  end

  return function(s)
    if type(s) ~= "string" or s == "" then return nil end
    local v, i = parse_value(s, 1)
    i = skip_ws(s, i)
    if string.sub(s, i) ~= "" then error("trailing garbage") end
    return v
  end
end)()

json_parse = function(s)
  if s == nil or s == "" then return nil end
  local ok, v = pcall(__json_decode, s)
  if ok then return v end
  return nil
end
json_stringify = function(v) return __impl_json_stringify(v) end
`;
export async function createSourceRuntime(
  sourceId: string,
  fetcher: PageFetcher,
  wasmUri?: string,
): Promise<SourceRuntime> {
  const factory = new LuaFactory(wasmUri);
  const lua = await factory.createEngine();
  await lua.doString(SANDBOX_CHUNK);

  const http = makeHttpBridge(fetcher, sourceId);
  // Async bridges are registered under __impl_* names; COMPAT_CHUNK wraps them
  // into synchronous-at-call-site globals via promise:await().
  lua.global.set("__impl_http_get", http.http_get);
  lua.global.set("__impl_http_post", http.http_post);
  lua.global.set("__impl_http_get_batch", http.http_get_batch);

  // Cookies & preferences
  lua.global.set("get_cookies", (url: string) => getCookiesFor(url));
  lua.global.set("set_cookies", (url: string, cookies: Record<string, string>) => {
    setCookiesFor(url, cookies ?? {});
  });
  lua.global.set("get_preference", (key: string) => getPreference(key));
  lua.global.set("set_preference", (key: string, value: unknown) => {
    setPreference(key, value == null ? "" : String(value));
  });

  // Crypto / encoding (aes_decrypt is async → impl name)
  lua.global.set("__impl_aes_decrypt", aesDecrypt);
  lua.global.set("base64_decode", base64Decode);
  lua.global.set("base64_encode", base64Encode);

  // HTML
  lua.global.set("html_parse", (html: string) => {
    try {
      const doc = parseHtml(html);
      return {
        text: doc.body.textContent?.replace(/\s+/g, " ").trim() ?? "",
        html: doc.documentElement.outerHTML,
        title: doc.title ?? "",
        body: new LuaElement(doc.body),
      };
    } catch {
      return null;
    }
  });
  lua.global.set("html_select", htmlSelect);
  lua.global.set("html_select_first", htmlSelectFirst);
  lua.global.set("html_attr", (v: unknown, css: string, attr: string) =>
    htmlSelectFirst(v, css)?.attr(attr) ?? "");
  lua.global.set("html_text", htmlText);
  lua.global.set("html_remove", htmlRemove);

  // URL
  lua.global.set("url_encode", urlEncode);
  lua.global.set("url_encode_charset", urlEncodeCharset);
  lua.global.set("url_resolve", urlResolve);

  // Strings
  lua.global.set("regex_match", regexMatch);
  lua.global.set("regex_replace", regexReplace);
  lua.global.set("string_normalize", (s: string) => (s ?? "").normalize("NFKC"));
  lua.global.set("string_split", (s: string, sep: string) => (s ?? "").split(sep ?? ""));
  lua.global.set("string_trim", (s: string) => (s ?? "").trim());
  lua.global.set("string_starts_with", (s: string, prefix: string) => (s ?? "").startsWith(prefix));
  lua.global.set("string_ends_with", (s: string, suffix: string) => (s ?? "").endsWith(suffix));
  lua.global.set("string_clean", stringClean);
  lua.global.set("unescape_unicode", unescapeUnicode);

  // JSON decoding happens in pure Lua (__json_decode in COMPAT_CHUNK) because
  // JS-returned objects arrive as userdata proxies; stringify stays in JS.
  lua.global.set("__impl_json_stringify", (v: unknown): string | null => {
    try {
      return JSON.stringify(v ?? null);
    } catch {
      return null;
    }
  });
  lua.global.set("detect_pagination", detectPagination);
  lua.global.set("__impl_sleep", sleep);
  lua.global.set("log_info", logInfo);
  lua.global.set("log_error", logError);
  lua.global.set("os_time", osTime);

  // Wrap async bridges into sync globals — must run after all __impl_* registrations.
  await lua.doString(COMPAT_CHUNK);

  return { lua };
}
