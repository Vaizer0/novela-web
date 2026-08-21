-- ── Metadata ────────────────────────────────────────────────────────────────
id       = "openlibrary"
name     = "Open Library"
version = "1.1.3"
baseUrl  = "https://openlibrary.org"
language = "en"
icon     = "https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://openlibrary.org&size=256"

-- ── Helpers ───────────────────────────────────────────────────────────────────

local SEARCH_FIELDS = "key,title,cover_i,ebook_access,ia"
local PAGE_LIMIT    = 24

local _pageCache = {}

-- In-memory book cache keyed by archive.org identifier. Fetching and cleaning
-- the OCR text is expensive (multi-megabyte downloads parsed by LuaJ), and the
-- reader loads chapters lazily — without this, getChapterList and every
-- getChapterText call would re-download and re-parse the whole book.
local _fullTextCache = {}
local _bookChaptersCache = {}

local function fetchPage(url)
  if _pageCache[url] then return _pageCache[url] end
  local r = http_get(url)
  if r.success then
    _pageCache[url] = r.body
    return r.body
  end
  return nil
end

local function absUrl(href)
  if not href or href == "" then return "" end
  if string_starts_with(href, "http") then return href end
  if string_starts_with(href, "//") then return "https:" .. href end
  return url_resolve(baseUrl, href)
end

local function applyStandardContentTransforms(text)
  if not text or text == "" then return "" end
  text = string_normalize(text)
  text = regex_replace(text, "(?i)openlibrary%.org.*?\\n", "")
  text = regex_replace(text, "(?i)\\A[\\s\\p{Z}\\uFEFF]*((Chapter\\s+\\d+)[^\\n\\r]*[\\n\\r\\s]*)+", "")
  text = regex_replace(text, "(?im)^\\s*(Translator|Editor|Proofreader|Read\\s+(at|on|latest))[:\\s][^\\n\\r]{0,70}(\\r?\\n|$)", "")
  text = string_trim(text)
  return text
end

-- OCR books wrap every line at the scan edge ("justified" page text). The
-- reader shows each paragraph as one TextView, so join those hard line breaks
-- into a single flowing paragraph; blank lines keep separating paragraphs.
local function flowParagraphs(text)
  if not text or text == "" then return "" end
  local parts = string_split(text, "\n\n")
  local flowed = {}
  for _, p in ipairs(parts) do
    p = string_trim(regex_replace(p, "\\s*\\n\\s*", " "))
    if p ~= "" then table.insert(flowed, p) end
  end
  return table.concat(flowed, "\n\n")
end

-- ── Devanagari (Hindi) full text ─────────────────────────────────────────────
-- Some scans ship no _djvu.txt; their OCR lives in _djvu.xml. The text is
-- Devanagari, so English "CHAPTER N" detection finds nothing — chapters are
-- rebuilt from the book's table of contents (page ranges) plus its running
-- page headers: short lines like "द्वितीय अध्याय २७" that repeat at the top
-- of every page.

-- Devanagari digits ०-९, UTF-8 bytes E0 A5 A6 .. E0 A5 AF.
local DEV_DIGITS = {
  "\224\165\166", "\224\165\167", "\224\165\168", "\224\165\169", "\224\165\170",
  "\224\165\171", "\224\165\172", "\224\165\173", "\224\165\174", "\224\165\175",
}

local function isDevanagari(text)
  return text ~= nil
    and (text:find("\224\164[\128-\191]") or text:find("\224\165[\128-\191]"))
end

local function devToAscii(s)
  for i = 1, 10 do
    s = s:gsub(DEV_DIGITS[i], tostring(i - 1))
  end
  return s
end

-- Pull the hidden OCR text out of a _djvu.xml file: pages hold <PARAGRAPH>s
-- of <LINE>s of <WORD>s. Lines join with \n, paragraphs with \n\n, mirroring
-- the plain-text layout the rest of the plugin expects.
local function extractDjvuXmlText(xml)
  if not xml or xml == "" then return nil end
  local paras = {}
  for p in xml:gmatch("<PARAGRAPH>(.-)</PARAGRAPH>") do
    local plines = {}
    for l in p:gmatch("<LINE[^>]*>(.-)</LINE>") do
      local ws = {}
      for w in l:gmatch("<WORD[^>]*>([^<]*)</WORD>") do
        if w ~= "" then table.insert(ws, w) end
      end
      if #ws > 0 then table.insert(plines, table.concat(ws, " ")) end
    end
    if #plines > 0 then table.insert(paras, table.concat(plines, "\n")) end
  end
  if #paras == 0 then return nil end
  local text = table.concat(paras, "\n\n")
  text = text:gsub("&lt;", "<"):gsub("&gt;", ">"):gsub("&quot;", '"')
             :gsub("&nbsp;", " "):gsub("&amp;", "&")
  return text
end

-- Leading "gutter" lines of a chapter segment: the previous chapter's
-- colophon tail, closing marks ("।। हरि: … तत्सत् ।।"), and OCR-mangled
-- "अथ …अध्याय…" opener markers. Only ever applied at segment starts (max 8
-- lines), so real opening sentences are not at risk.
local function isGutterLine(line)
  local t = string_trim(line)
  if t == "" then return true end
  if t:find("पूर्ण होता") then return true end
  if t:find("तत्सत्") then return true end
  if t:match("^।") then return true end
  if t:find("ध्याय") and t:find("।।") and #t <= 40 then return true end
  if t:find("शिष्य") and t:find("कृत") then return true end
  if t:find("भाष्य") then return true end
  if #t <= 60 and t:find("अथ")
    and (t:find("ध्याय") or t:find("॥") or t:find("||") or t:find("$")) then
    return true
  end
  return false
end

-- Paren title of a TOC line: "नवम अध्याय. (राजविद्या-जागृति) … १९०-२१४"
local function tocParenTitle(rawLine)
  local t = rawLine:match("%((.-)%)")
  if not t then return nil end
  t = t:gsub("^%(", "")
  t = t:gsub("&lt;", "<"):gsub("&gt;", ">"):gsub("&amp;", "&")
  t = t:gsub("\226\128\141", "") -- zero-width joiner from the OCR
  -- Leading OCR junk: "&lt;“" decodes to a literal "<" plus a left quote
  -- (U+201C). Strip them as literal byte sequences — never as a character
  -- class, whose byte set would collide with Devanagari bytes.
  t = t:gsub("^<+", "")
  t = t:gsub("^\226\128\156+", "")
  t = string_trim(t)
  if t == "" then return nil end
  return t
end

-- Rebuild chapters of a Devanagari book from its TOC page ranges and running
-- page headers. Returns a chapters table in the same shape buildChapters
-- produces ({ title, start, finish } line indices), or nil when the text has
-- no usable TOC/headers (the caller then falls back to the English logic).
local function buildHindiChapters(lines)
  local pagemap, pageOrder = {}, {}
  local prevClaim, prevKept = nil, nil

  -- Running page headers: short lines "द्वितीय अध्याय २७" (sometimes with a
  -- Latin digit: "अथम अध्याय 3"). OCR glitches like "श्२७" are rejected by
  -- requiring a space before the trailing number. Claims must be monotonic
  -- and must not jump more than 8 pages per header (real ones step by 2).
  for i, line in ipairs(lines) do
    local t = string_trim(line)
    if #t > 0 and #t <= 60 and t:find("अध्याय")
      and not (t:find("[(),]") or t:find("होता") or t:find("श्लोक")) then
      local page = tonumber(devToAscii(t):match("%s([%d]+)$"))
      if page and page >= 1 and page <= 400 then
        if prevClaim and page - prevClaim > 8 then
          prevClaim = page -- forward jump: false page, drop it but keep trend
        elseif prevKept and page < prevKept then
          -- backwards outlier: ignore entirely
        else
          if not pagemap[page] then
            pagemap[page] = i
            table.insert(pageOrder, page)
          end
          prevClaim, prevKept = page, page
        end
      end
    end
  end
  if #pageOrder == 0 then return nil end

    -- Table of contents: long lines "नवम अध्याय. (…title…) … १९०-२१४" with a
    -- trailing page range. Contents pages cluster 3+ of them within 30 lines.
    -- Threshold is BYTES (Devanagari = 3 B/char): shortest real entries are
    -- ~116 B, so 100 keeps them while still excluding short running-text lines.
    local tocCands = {}
    for i, line in ipairs(lines) do
      local t = string_trim(line)
      if #t >= 100 and t:find("अध्याय") and not t:find("/") then
      local a = devToAscii(t)
      local lastRange = nil
      for x, y in a:gmatch("(%d+)-(%d+)") do
        lastRange = { startPage = tonumber(x), finishPage = tonumber(y) }
      end
      if lastRange then
        table.insert(tocCands, {
          lineNo = i, raw = t,
          startPage = lastRange.startPage, finishPage = lastRange.finishPage,
        })
      end
    end
  end
  local toc = {}
  for _, c in ipairs(tocCands) do
    local n = 0
    for _, d in ipairs(tocCands) do
      if math.abs(d.lineNo - c.lineNo) <= 30 then n = n + 1 end
    end
    if n >= 3 then table.insert(toc, c) end
  end
  if #toc == 0 then return nil end
  table.sort(toc, function(x, y) return x.lineNo < y.lineNo end)
  local prevEnd = 0
  for _, c in ipairs(toc) do
    if c.startPage < prevEnd + 1 then c.startPage = prevEnd + 1 end
    if c.finishPage < c.startPage then c.finishPage = c.startPage end
    if c.finishPage > prevEnd then prevEnd = c.finishPage end
  end

  -- Page number -> line: exact header hit, else interpolate between the
  -- nearest claimed pages, else extrapolate at ~55 lines per page.
  local function pageLine(page)
    if pagemap[page] then return pagemap[page] end
    local below, above = nil, nil
    for _, p in ipairs(pageOrder) do
      if p < page then below = p else break end
    end
    for _, p in ipairs(pageOrder) do
      if p > page then above = p break end
    end
    if not below then
      return above and pagemap[above] - (above - page) * 55 or nil
    end
    if not above then
      return pagemap[below] + (page - below) * 55
    end
    return math.floor(pagemap[below]
      + (page - below) * (pagemap[above] - pagemap[below]) / (above - below) + 0.5)
  end

  local chapters = {}
  local firstBoundary = pageLine(toc[1].startPage)
  if firstBoundary and firstBoundary > 1 then
    local front = table.concat(lines, "\n", 1, firstBoundary - 1)
    if #front >= 300 then
      table.insert(chapters, { title = "Front Matter", start = 1, finish = firstBoundary - 1 })
    end
  end
  for k, c in ipairs(toc) do
    local bl = pageLine(c.startPage)
    if not bl then return nil end
    local nxt = (toc[k + 1] and pageLine(toc[k + 1].startPage)) or (#lines + 1)
    local finish = nxt - 1
    if finish < bl then finish = bl end
    local start = bl + 1
    for g = 1, 8 do
      if start >= finish then break end
      if isGutterLine(lines[start]) then start = start + 1 else break end
    end
    local title = "अध्याय " .. tostring(k)
    local paren = tocParenTitle(c.raw)
    if paren then title = title .. " — " .. paren end
    table.insert(chapters, { title = title, start = start, finish = finish })
  end
  if #chapters < 2 then return nil end
  return chapters
end

-- ── Search JSON API ───────────────────────────────────────────────────────────

local function parseSearchResponse(body)
  local data = json_parse(body)
  if not data or type(data.docs) ~= "table" then
    return { items = {}, hasNext = false }
  end

  local items = {}
  for _, doc in ipairs(data.docs) do
    local title = doc.title
    local key   = doc.key
    -- Only surface books that actually have public-domain full text
    if title and key and doc.ebook_access == "public" and type(doc.ia) == "table" and #doc.ia > 0 then
      local cover = ""
      if doc.cover_i and doc.cover_i > 0 then
        cover = "https://covers.openlibrary.org/b/id/" .. tostring(doc.cover_i) .. "-M.jpg"
      end
      table.insert(items, {
        title = string_clean(title),
        url   = baseUrl .. key,
        cover = cover
      })
    end
  end

  local hasNext = (data.start or 0) + #data.docs < (data.numFound or 0)
  return { items = items, hasNext = hasNext }
end

-- ── Catalog ───────────────────────────────────────────────────────────────────

function getCatalogList(index)
  local page = index + 1
  local url = baseUrl .. "/search.json?q=ebook_access:public"
              .. "&page=" .. page .. "&limit=" .. PAGE_LIMIT
              .. "&fields=" .. SEARCH_FIELDS
  local r = http_get(url)
  if not r.success then return { items = {}, hasNext = false } end
  return parseSearchResponse(r.body)
end

-- ── Search ─────────────────────────────────────────────────────────────────────

function getCatalogSearch(index, query)
  if not query or query == "" then
    return getCatalogList(index)
  end
  local page = index + 1
  local url = baseUrl .. "/search.json?q=" .. url_encode(query)
              .. "%20AND%20ebook_access:public"
              .. "&page=" .. page .. "&limit=" .. PAGE_LIMIT
              .. "&fields=" .. SEARCH_FIELDS
  local r = http_get(url)
  if not r.success then return { items = {}, hasNext = false } end
  return parseSearchResponse(r.body)
end

-- ── Book details ──────────────────────────────────────────────────────────────

local function bookJsonUrl(bookUrl)
  local key = bookUrl:match("(/works/OL%d+W)")
    or bookUrl:match("(/books/OL%d+M)")
  if not key then return nil end
  return baseUrl .. key .. ".json"
end

local function fetchBookData(bookUrl)
  local url = bookJsonUrl(bookUrl)
  if not url then return nil end
  local body = fetchPage(url)
  if not body then return nil end
  local data = json_parse(body)
  if type(data) ~= "table" then return nil end
  return data
end

function getBookTitle(bookUrl)
  local d = fetchBookData(bookUrl)
  if not d or not d.title then return nil end
  return string_clean(d.title)
end

function getBookCoverImageUrl(bookUrl)
  local d = fetchBookData(bookUrl)
  if not d or type(d.covers) ~= "table" or #d.covers == 0 then return nil end
  return "https://covers.openlibrary.org/b/id/" .. tostring(d.covers[1]) .. "-L.jpg"
end

function getBookDescription(bookUrl)
  local d = fetchBookData(bookUrl)
  if not d or not d.description then return nil end
  local desc = d.description
  if type(desc) == "table" then desc = desc.value end
  if type(desc) ~= "string" or desc == "" then return nil end
  return string_trim(desc)
end

function getBookGenres(bookUrl)
  local d = fetchBookData(bookUrl)
  if not d or type(d.subjects) ~= "table" then return {} end
  local genres = {}
  for _, s in ipairs(d.subjects) do
    local label = string_clean(s)
    if label ~= "" then table.insert(genres, label) end
    if #genres >= 12 then break end
  end
  return genres
end

-- ── Full text / chapters ──────────────────────────────────────────────────────

-- Resolve the /works/ key from any book URL (works or edition pages).
local function getWorkKey(bookUrl)
  local key = bookUrl:match("(/works/OL%d+W)")
  if key then return key end
  local d = fetchBookData(bookUrl)
  if d and type(d.works) == "table" and #d.works > 0 and d.works[1].key then
    return d.works[1].key
  end
  return nil
end

-- Archive.org identifiers with full text for a work, via the search API.
local function getArchiveIds(workKey)
  if not workKey then return {} end
  local q = "key:" .. url_encode('"' .. workKey .. '"')
  local r = http_get(baseUrl .. "/search.json?q=" .. q
                     .. "&fields=key,ia,ebook_access&limit=1")
  if not r.success then return {} end
  local data = json_parse(r.body)
  if not data or type(data.docs) ~= "table" or #data.docs == 0 then return {} end
  local ia = data.docs[1].ia
  if type(ia) ~= "table" then return {} end
  return ia
end

-- Download the OCR full text of a scan; some identifiers are lending-restricted
-- (HTTP 403), so try several candidates in order.
--
-- IMPORTANT: the archive.org/download/... URL 302-redirects to a CDN, and the
-- app's http_get does not follow redirects — so instead we resolve the CDN host
-- up front via the metadata API (200, no redirect) and request the text file
-- straight from that host.
-- One text fetch with a single retry: archive.org CDNs fail transiently
-- (5xx, slow reads), and OkHttp's read timeout in the app is 30 s.
local function fetchBody(url)
  local r = http_get(url)
  if r.success and r.code == 200 and #r.body > 500 then return r.body end
  r = http_get(url)
  if r.success and r.code == 200 and #r.body > 500 then return r.body end
  return nil
end

local function fetchFullText(ids)
  local maxTries = math.min(#ids, 4)
  for i = 1, maxTries do
    local id = ids[i]
    if _fullTextCache[id] then return _fullTextCache[id] end
    local r = http_get("https://archive.org/metadata/" .. id)
    if not (r.success and r.code == 200) then
      log_error("openlibrary: metadata failed for " .. tostring(id)
                .. " code=" .. tostring(r.code))
    else
      local data = json_parse(r.body)
      local server = (type(data) == "table") and data.server or nil
      local dir    = (type(data) == "table") and data.dir    or nil
      if server and dir then
        local url = "https://" .. server .. dir .. "/" .. id .. "_djvu.txt"
        local body = fetchBody(url)
        if body then
          _fullTextCache[id] = body
          return body
        end
        log_error("openlibrary: djvu.txt failed for " .. tostring(id))
        -- No _djvu.txt OCR (some scans ship an empty one): fall back to the
        -- larger _djvu.xml, which carries the same text as hidden OCR.
        local urlXml = "https://" .. server .. dir .. "/" .. id .. "_djvu.xml"
        local xml = fetchBody(urlXml)
        if xml then
          local extracted = extractDjvuXmlText(xml)
          if extracted and #extracted > 500 then
            _fullTextCache[id] = extracted
            return extracted
          end
        end
        log_error("openlibrary: djvu.xml failed for " .. tostring(id))
      else
        log_error("openlibrary: metadata missing server/dir for " .. tostring(id))
      end
    end
  end
  return nil
end

-- Remove OCR junk: ornament lines, page numbers, scanner boilerplate.
-- Blank lines are KEPT: the reader renders paragraphs split on blank lines,
-- so dropping them would turn every scan line into its own paragraph.
local function cleanFullText(raw)
  if not raw or raw == "" then return "" end
  raw = raw:gsub("\r\n", "\n"):gsub("\r", "\n"):gsub("\f", "\n")
  -- join words split across lines by a soft hyphen (OCR artifact "con¬\n")
  raw = raw:gsub("\194\172[ \t]*\n[ \t]*", "")

  local lines = string_split(raw, "\n")
  local out = {}
  for _, line in ipairs(lines) do
    local t = string_trim(line)
    if t == "" or not (string.find(t, "[A-Za-z]") or t:find("[\128-\255]")) then
      -- blank line or page number: keep as paragraph separator
      out[#out + 1] = ""
    else
      -- Drop ornament/OCR-garbage lines: too few letters, letters are a
      -- minority of the line's characters, or exotic symbols (■ € § ²)
      -- that never appear in real book text. Non-ASCII bytes (Devanagari
      -- and other scripts) count as letters. NOTE: the exotic symbols must
      -- be matched as literal byte sequences — putting them in a character
      -- class would turn them into a byte set that collides with common
      -- Devanagari bytes (e.g. 0xA7 is ध, 0xAC is ब) and drop real lines.
      local letters, chars = 0, 0
      for ch in t:gmatch(".") do
        if ch:match("[A-Za-z]") or ch:find("[\128-\255]") then letters = letters + 1 end
        if ch ~= " " then chars = chars + 1 end
      end
      local exotic = t:find("\226\150\160") or t:find("\226\130\172")
        or t:find("\194\167") or t:find("\194\178")
      local keep = (letters >= 4) and (chars == 0 or letters / chars >= 0.5)
        and not exotic
      -- Running page headers like "6 PRIDE AND PREJUDICE." (page number +
      -- book title, repeated on every page): digits followed by ALL-CAPS
      -- text and no lowercase letters anywhere.
      local headerNoise = t:match("^%d+[%s%.%-,:;]+[A-Z]") and not t:find("[a-z]") and #t <= 40
      -- ...or the mirror form with the number trailing: "PRIDE AND PREJUDICE. 15".
      -- Never applies to real headings like "CHAPTER 12." / "LETTER IV." —
      -- nor to Devanagari page headers ("द्वितीय अध्याय २७"), which the
      -- Hindi chapter builder needs.
      local isHeadingPrefix = t:match("^[Cc][Hh][Aa][Pp][Tt][Ee][Rr]") or t:match("^[Cc][Hh][Aa][Pp]%.")
        or t:match("^[Ll][Ee][Tt][Tt][Ee][Rr]")
      local headerNoise2 = not t:find("[a-z]") and #t <= 40 and not isHeadingPrefix
        and not t:find("अध्याय")
        and (t:match("%d") or t:match("%s[IVXLCDM]+%.?$"))
      local low = t:lower()
      local spam = low:find("digitized by") or low:find("scanned by")
        or low:find("internet archive") or low:find("project gutenberg")
        or low:find("google") or low:find("archive%.org")
        or low:find("ocr page") or low:find("पूर्ण होता")
      if keep and not spam and not headerNoise and not headerNoise2 then
        table.insert(out, t)
      else
        out[#out + 1] = ""
      end
    end
  end

  -- Pass 2: book-level noise that only reveals itself by frequency. All rules
  -- are restricted to non-Devanagari lines — Devanagari running headers like
  -- "द्वितीय अध्याय २७" are needed by the Hindi chapter builder.
  local freq, tailFreq = {}, {}
  local susp = {}
  local headingShape = {}
  for i, t in ipairs(out) do
    if t ~= "" and not isDevanagari(t) then
      -- A repeated line that is typographically isolated (blank above and
      -- below) is a real heading that shares its text with the running
      -- headers ("THE ADVENTURE OF THE BLUE CARBUNCLE" heads both the chapter
      -- and every page of it) — such lines must survive the frequency drop.
      -- The line above may also be the OCR-mangled chapter-prefix
      -- ("Moventure WITT" for "ADVENTURE VII.") whose stable core is
      -- "enture", instead of a blank.
      if (i == 1 or out[i - 1] == ""
          or (#out[i - 1] <= 20 and out[i - 1]:upper():find("ENTURE", 1, true)))
         and out[i + 1] == "" and not t:find("%d") then
        headingShape[i] = true
      end
      -- (c) garbage-band marking: lines whose letter-tokens are mostly short
      -- (< 35% of length >= 4) are typical OCR of illustration pages. A single
      -- such line can be real dialogue ("Did you say pig, or fig?"), so lines
      -- are only dropped when 3+ of them cluster in a +/-3-line window.
      local ntok, nlong = 0, 0
      for w in t:gmatch("[A-Za-z]+") do
        ntok = ntok + 1
        if #w >= 4 then nlong = nlong + 1 end
      end
      if ntok >= 4 and ntok <= 14 and nlong / ntok < 0.35 then
        susp[i] = true
      end
      -- (a) exact all-caps lines ("ALICE'S ADVENTURES" running headers,
      --     "DOWN THE RABBIT-HOLE" divider titles) and (b) the same text with
      --     a mangled page-number prefix/suffix ("4z ADVENTURES OF SHERLOCK
      --     HOLMES", "THE ADVENTURE OF THE ENGINEER'S THUMB 2064").
      -- Leading/trailing punctuation is normalized so "' DOWN THE RABBIT-HOLE"
      -- and "DOWN THE RABBIT-HOLE" share one bucket. Devanagari page headers
      -- are excluded — the Hindi chapter builder needs them.
      local key = t:gsub("^[%p%s]+", ""):gsub("[%p%s]+$", "")
      if key ~= "" and not key:find("[a-z]") and #key >= 3 and #key <= 44 then
        freq[key] = (freq[key] or 0) + 1
        local tail = key:gsub("^[^A-Z]*", ""):gsub("[^A-Z]+$", "")
        if #tail >= 4 and #tail <= 44 then
          tailFreq[tail] = (tailFreq[tail] or 0) + 1
        end
      end
    end
  end
  for i, t in ipairs(out) do
    if t ~= "" and not isDevanagari(t) then
      local key = t:gsub("^[%p%s]+", ""):gsub("[%p%s]+$", "")
      local dropped = false
      -- Frequency drops run on EVERY non-Devanagari line, including
      -- short-token "susp" lines: "THE ADVENTURE OF THE SPECKLED BAND" is
      -- 2/6 long tokens (0.33) and must still be caught by (a).
      if key ~= "" and not key:find("[a-z]") and #key >= 3 and #key <= 44
         and not headingShape[i] then
        if (freq[key] or 0) >= 3 then
          out[i] = ""
          dropped = true
        else
          local tail = key:gsub("^[^A-Z]*", ""):gsub("[^A-Z]+$", "")
          if #tail >= 4 and #tail <= 44
             and (tailFreq[tail] or 0) >= 3
             and (key:find("%d") or not tail:find("ADVENTURE OF")) then
            out[i] = ""
            dropped = true
          end
        end
      end
      if not dropped and susp[i] then
        local band = 0
        for j = math.max(1, i - 3), math.min(#out, i + 3) do
          if susp[j] then band = band + 1 end
        end
        if band >= 3 then out[i] = "" end
      end
    end
  end

  -- Rebuild the text AFTER the frequency drops above, so out[] changes stick.
  local text = table.concat(out, "\n")

  text = regex_replace(text, "\\n{3,}", "\n\n")
  text = regex_replace(text, "[ \\t]{2,}", " ")
  return text
end

-- Accept "CHAPTER  I." / "CHAP. III" / "LETTER  IV." / "Chapter 12" plus
-- OCR-mangled numerals ("CHAPTER I1—DOWN THE", "CHAP. IL", "CHAPTER V.").
local WORD_NUM = {}
for _, w in ipairs({ "ONE","TWO","THREE","FOUR","FIVE","SIX","SEVEN","EIGHT",
  "NINE","TEN","ELEVEN","TWELVE","THIRTEEN","FOURTEEN","FIFTEEN","SIXTEEN",
  "SEVENTEEN","EIGHTEEN","NINETEEN","TWENTY","FIRST","SECOND","THIRD","FOURTH",
  "FIFTH","SIXTH","SEVENTH","EIGHTH","NINTH","TENTH","ELEVENTH","TWELFTH",
  "THIRTEENTH","FOURTEENTH","FIFTEENTH","SIXTEENTH","SEVENTEENTH","EIGHTEENTH",
  "NINETEENTH","TWENTIETH" }) do
  WORD_NUM[w] = true
end

local function isChapterHeading(line)
  local t = string_trim(line)
  if t == "" then return false end
  local upper = string.upper(t)

  -- Sherlock-style collections: the heading is the whole line, ALL-CAPS,
  -- contains "ADVENTURE OF" and carries no page number: "ADVENTURE VII. THE
  -- ADVENTURE OF THE BLUE CARBUNCLE." Running headers use the bare adventure
  -- title ("THE ADVENTURE OF THE BLUE CARBUNCLE", or OCR-mangled "YHE ..."),
  -- so require a trailing period and a sane leading word.
  if not t:find("[a-z]") and not t:find("%d") and #t <= 60
     and t:match("%.%s*$")
     and upper:find("ADVENTURE OF", 1, true)
     and (t:match("^THE%s+") or t:match("^ADVENTURE")) then
    return true
  end

  local rest = upper:match("^CHAPTER%s+(.-)$")
    or upper:match("^CHAP%.?%s*(.-)$")
    or upper:match("^LETTER%s+(.-)$")
  if not rest or rest == "" then return false end
  if rest == "PAGE" then return false end -- "CHAPTER PAGE" TOC column header

  -- Footnote cross-references masquerade as headings in scholarly scans
  -- ("chap. 99, fol. 13.] Chang Yii tells..."). A real heading is a short
  -- standalone line, so reject long lines and anything with a closing bracket.
  if rest:find("]", 1, true) or #rest > 56 then return false end

  -- Roman-numeral + punctuation + ALL-CAPS title with no trailing page
  -- number: some scans omit "CHAP." entirely and head chapters like
  -- "I.    LAYING  PLANS." (Giles's Art of War). TOC entries end with a page
  -- number ("II. Waging War 9") and running headers are "numeral + space +
  -- section" with no punctuation ("XIV INTRODUCTION", "xn INTRODUCTION") or
  -- lowercase, so all of those are excluded.
  local rnum, rtitle = upper:match("^([IVXLCDM]+)[%.%,%:][%s_]+(.+)$")
  if rnum and rtitle and not t:find("[a-z]") then
    if #rtitle <= 48 and not rtitle:find("[a-z]")
       and not rtitle:find("]", 1, true)
       and not rtitle:match("[%dIVXLCDM]+$") then
      return true
    end
  end

  -- OCR runs the number into the title: "CHAPTER I1—DOWN THE". Break on any
  -- separator (space, punctuation, em-dash) and only inspect the first token.
  local token = rest:gsub("\226\128\148", " "):match("^([^%s%.%-%:%;%,%?%!]+)")
  if not token then return false end
  token = token:gsub("1", "I"):gsub("l", "I"):gsub("L", "I"):gsub("O", "0")
  if token:match("^%d+$") then
    -- Footnote cross-references start like headings: "Chapter 36, "The
    -- Quarter Deck," contains the bril-". A comma+quote right after the
    -- number is never a real heading.
    if rest:match("^%d+[%,%s]*[\"'%[]") then return false end
    return true
  end
  if token:match("^[IVXLCDM]+$") and #token >= 1 and #token <= 10 then return true end
  local wnum = rest:gsub("[%p%s]+", ""):gsub("^THE", "")
  if WORD_NUM[wnum] then return true end -- "CHAPTER ONE." / "CHAPTER THE FIRST"
  return false
end

-- Standalone all-caps section headings: "PREFACE", "INTRODUCTION", "INDEX".
-- Must be short, carry no page number, and be followed by body text (a line
-- with lowercase letters). Repeated all-caps lines (running headers, divider
-- titles) were already dropped by cleanFullText's frequency rules, so what
-- survives here is a real section start. nextLine is optional; when nil the
-- line is still accepted (the strict context of the caller decides).
local function isSectionHeading(line, nextLine)
  local t = string_trim(line)
  if t == "" then return false end
  local upper = string.upper(t)
  -- Sherlock-style collection titles run long ("THE ADVENTURE OF THE
  -- ENGINEER'S THUMB" = 39 bytes); page-numbered running headers are already
  -- rejected by the digit rule below, so the cap only guards against junk.
  -- The engine's Lua is Unicode-aware: `%l`/`%u` match Latin-1 letters, so a
  -- UTF-8 curly apostrophe (U+2019 = bytes E2 80 99) triggers `find("%l")` on
  -- its first byte (U+00E2 = "â"). Raw OCR text must be classified with ASCII
  -- classes only — [a-z]/[A-Z] — or headings with apostrophes are rejected.
  if #upper < 3 or #upper > 44 or t:find("[a-z]")
     or upper:find("%d") or upper:find("]") then
    return false
  end
  -- Pull quotes and page ornaments wrap all-caps text in curly quotes or
  -- em-dashes ("THE DOOR WAS SHUT AND LOCKED", "—_—_—"), and title-page
  -- stamps end in ®/©. A real heading starts and ends with an ASCII letter;
  -- an optional trailing period covers Art of War's "III. ATTACK BY
  -- STRATAGEM." (its period follows the final letter).
  if not t:match("^[A-Z]") or not t:match("[A-Z]%.?$") then
    return false
  end
  -- A page-break split running header can end in a possessive ("THE MODERN
  -- PROM ETHEL'S" = "PROMETHEUS" torn across the gutter). Real headings end
  -- in a noun, a numeral or a period — never an apostrophe-S.
  if t:find("['\226\128\153]S$") then
    return false
  end
  -- Running page headers paste a page number before or after the section
  -- name ("XIV INTRODUCTION", "X PREFACE", "INTRODUCTION XLIIT") — a real
  -- heading's last word is a title word, not a page number, and its page
  -- number never sits in front. Also reject lines that start with a numeral
  -- or bracket and OCR junk carrying guillemets ("A A«").
  if upper:match("^[IVXLCDM%d]+[%s_]") or upper:find("%[")
     or upper:find("\194\171") or upper:find("\194\187") then
    return false
  end
  -- OCR page numbers are (mangled) roman numerals: "INTRODUCTION XLIIT".
  -- If the final word is mostly roman-numeral letters it is a running header.
  -- Real last words stay above 1/3 non-roman ("LIP" in "THE MAN WITH THE
  -- TWISTED LIP" is 1/3, "BACHELOR" 3/8); page numerals are ~1/5 or less.
  local lastw = upper:match("([A-Z']+)$")
  if lastw and #lastw >= 3 then
    local nonRoman = lastw:gsub("[IVXLCDM]", "")
    if #nonRoman / #lastw < 0.3 then return false end
  end
  -- Single-word fragments of a title page ("CARL", "EARS", "NCEE") are too
  -- short to be sections; real ones ("INDEX", "NOTES", "PREFACE") are not.
  -- Repeated-letter runs ("SSSESE") are OCR noise, never words.
  if not upper:find("%s") then
    if #upper < 5 then return false end
    if t:match("([A-Z])%1%1") then return false end
  end
  -- Title/copyright lines carry commas, ampersands or semicolons
  -- ("LIONEL GILES, M. A.", "LUZAC & C°.", "FINO;") and interior dots
  -- ("UTHO IN U.S.A.") — headings never do. "@" (title-page stamps) and "?"
  -- (mangled "ADVENTURE III.") never occur in a heading. Running headers that
  -- repeat an adventure title carry a trailing page number ("THE ADVENTURE OF
  -- THE BLUE CARBUNCLE 155") and are already rejected by the digit rule above;
  -- the bare title line ("THE ADVENTURE OF THE BLUE CARBUNCLE") is the real
  -- heading.
  if upper:find("[,&;@%?]") or t:match("%.%S") then return false end
  if nextLine then
    local n = string_trim(nextLine)
    return n ~= "" and n:find("[a-z]") ~= nil
  end
  return true
end

-- Chapter title, joining a wrapped all-caps continuation line: OCR scans of
-- Alice have "CHAPTER I1—DOWN THE" followed by "RABBIT-HOLE" on the next line.
-- Returns (title, skipCount) where skipCount is the number of body lines the
-- title occupies (1 = heading only), so the reader never sees them twice.
local function headingTitle(lines, i)
  local title = string_clean(lines[i])
  if not (title:find("\226\128\148") or title:find("%-")) then return title, 1 end
  local nxt = i + 1
  while nxt <= #lines and string_trim(lines[nxt]) == "" do nxt = nxt + 1 end
  if nxt <= #lines then
    local cont = string_trim(lines[nxt])
    if cont ~= "" and #cont <= 44 and not cont:find("[a-z]")
       and not cont:find("%d") and not isChapterHeading(cont) then
      return title .. " " .. string_clean(cont), nxt - i
    end
  end
  return title, 1
end

-- Split the full text into chapters. Returns (chapters, lines) where each
-- chapter is { title, start, finish } — line indices into `lines`.
-- The same algorithm runs in getChapterList and getChapterText, so the
-- chapter indexes always match.
local function buildChapters(rawText, id)
  if id and _bookChaptersCache[id] then
    local hit = _bookChaptersCache[id]
    return hit.chapters, hit.lines
  end
  local lines = string_split(cleanFullText(rawText), "\n")

  -- Devanagari books have no English chapter headings: rebuild chapters from
  -- the table of contents and the running page headers instead.
  if isDevanagari(rawText) then
    local hindi = buildHindiChapters(lines)
    if hindi then return hindi, lines end
  end

  -- Drop table-of-contents pages: runs of >= 3 consecutive lines shaped like
  -- "I. Laying Plans i" / "„ III. Attack by Stratagem 17" / "VI._Weak Points
  -- and Strong 42" — a numeral followed by a short title and a trailing page
  -- number. TOC entries would otherwise become bogus chapters. Works across
  -- scans because it only uses the shape of the line, never book-specific
  -- words: a body paragraph starts with a numeral only once in a while, but
  -- never 3+ times in a row, and body text has no trailing page numbers.
  local isTocLine = {}
  for i, line in ipairs(lines) do
    local t = string_trim(line)
    if t ~= "" then
      local bare = t:gsub("^[\226\128\158\226\128\156\"'%s]+", "")
      -- A contents entry is "numeral + title + page number" ("II. Waging
      -- War 9") or, when OCR ate the numeral, "title + page number"
      -- ("Terrain 100", "Chap. I. Laying Plans i"). Requiring the trailing
      -- page number on the first form and mixed case on the second keeps body
      -- headings ("I. LAYING PLANS.") out.
      if #bare <= 64
         and ((bare:match("^[IVXLCDM]+[%.%,%:%s_]")
               and (bare:match("%d+$") or bare:match("%s+[IVXLCDM]+$")))
              or (bare:match("[%s%.][IVXLCDM%d]+$") and not bare:match("^%u+[%.%,%:]"))) then
        isTocLine[i] = true
      end
    end
  end
  local runStart, runLen, run = nil, 0, nil
  local lastToc = nil
  for i = 1, #lines do
    if isTocLine[i] then
      -- Entries 1-2 lines apart (a blank line between them) belong to the
      -- same contents page; anything further starts a new run.
      if runStart and i - lastToc <= 2 then
        runLen = runLen + 1
      else
        if runLen >= 3 then
          run = run or {}
          run[#run + 1] = { runStart, runLen }
        end
        runStart, runLen = i, 1
      end
      lastToc = i
    end
  end
  if runLen >= 3 then
    run = run or {}
    run[#run + 1] = { runStart, runLen }
  end
  if run then
    for i = 1, #lines do
      if isTocLine[i] then
        for _, r in ipairs(run) do
          if i >= r[1] and i < r[1] + r[2] then
            lines[i] = ""
            break
          end
        end
      end
    end
  end

  local candidates = {}
  for i, line in ipairs(lines) do
    if isChapterHeading(line) then
      local title, skip = headingTitle(lines, i)
      table.insert(candidates, { lineNo = i, title = title, titleSkip = skip })
    else
      local nxt = i + 1
      while nxt <= #lines and string_trim(lines[nxt]) == "" do nxt = nxt + 1 end
      if nxt <= #lines and isSectionHeading(line, lines[nxt]) then
        table.insert(candidates, { lineNo = i, title = string_clean(line), titleSkip = 1 })
      end
    end
  end

  -- Drop table-of-contents clusters: 3+ heading lines within 10 lines are a
  -- contents page, not real chapter starts. The window is tight so a real
  -- section that merely follows the TOC (Art of War's PREFACE sits ~26 lines
  -- after the last TOC entry) is never swept into the cluster; leftover TOC
  -- stragglers are later absorbed by the 300-char segment rule.
  local toDrop = {}
  local i = 1
  while i <= #candidates do
    local j = i
    while j + 1 <= #candidates and candidates[j + 1].lineNo - candidates[j].lineNo < 10 do
      j = j + 1
    end
    if j - i + 1 >= 3 then
      for k = i, j do toDrop[k] = true end
    end
    i = j + 1
  end

  -- A title that repeats (TOC "INTRODUCTION" + real "INTRODUCTION") is real at
  -- its LAST occurrence — the TOC straggler's tiny segment is discarded below,
  -- while a first-wins rule would silently delete the real section.
  local best = {}
  for k, c in ipairs(candidates) do
    if not toDrop[k] then best[c.title] = k end
  end
  local headings = {}
  for k, c in ipairs(candidates) do
    if best[c.title] == k then
      table.insert(headings, c)
    end
  end

  -- Build segments; tiny ones (scanner leftovers) are absorbed into the
  -- previous chapter.
  local final = {}
  for k, h in ipairs(headings) do
    local nextLine = (headings[k + 1] and headings[k + 1].lineNo - 1) or #lines
    if nextLine < h.lineNo then nextLine = h.lineNo end
    local seg = table.concat(lines, "\n", h.lineNo, nextLine)
    if #seg >= 300 then
      table.insert(final, { title = h.title, start = h.lineNo, finish = nextLine, titleSkip = h.titleSkip or 1 })
    elseif #final > 0 then
      final[#final].finish = nextLine
    end
  end

  local chapters = {}
  if #final > 0 then
    -- Front matter (introduction, letters, title page) before the first heading
    if final[1].start > 1 then
      local front = table.concat(lines, "\n", 1, final[1].start - 1)
      if #front >= 300 then
        table.insert(chapters, { title = "Front Matter", start = 1, finish = final[1].start - 1, titleSkip = 0 })
      end
    end
    for _, c in ipairs(final) do table.insert(chapters, c) end
  elseif #lines > 0 then
    -- No headings detected at all: offer the whole book as one chapter
    table.insert(chapters, { title = "Full Text", start = 1, finish = #lines })
  end

  if id then
    _bookChaptersCache[id] = { chapters = chapters, lines = lines }
  end
  return chapters, lines
end

-- ── Chapter list ───────────────────────────────────────────────────────────────

function getChapterList(bookUrl)
  local workKey = getWorkKey(bookUrl)
  if not workKey then
    log_error("openlibrary: cannot resolve work key from " .. tostring(bookUrl))
    return {}
  end

  local ids = getArchiveIds(workKey)
  local raw = fetchFullText(ids)
  if not raw then
    log_error("openlibrary: no readable full text for " .. workKey)
    return {}
  end

  local chapters, _ = buildChapters(raw, ids[1])
  local result = {}
  for i, ch in ipairs(chapters) do
    table.insert(result, {
      title = ch.title,
      url   = baseUrl .. workKey .. ".json?c=" .. tostring(i - 1)
    })
  end
  return result
end

function getChapterListHash(bookUrl)
  -- Direct, uncached request — must reflect the current state.
  local workKey = getWorkKey(bookUrl)
  local ids = getArchiveIds(workKey)
  return (ids and #ids > 0) and ids[1] or nil
end

-- ── Chapter text ───────────────────────────────────────────────────────────────

function getChapterText(html, url)
  local workKey = (url and url:match("(/works/OL%d+W)")) or nil
  local idx = (url and tonumber(url:match("[?&]c=(%d+)"))) or 0
  if not workKey then return "" end

  local ids = getArchiveIds(workKey)
  local raw = fetchFullText(ids)
  if not raw then return "" end

  local chapters, lines = buildChapters(raw, ids[1])
  local ch = chapters[idx + 1]
  if not ch then return "" end

  -- The reader renders the chapter title from the list; don't repeat it (or
  -- its wrapped continuation) as the first line of the body.
  local startLine = ch.start
  if ch.titleSkip ~= nil then
    startLine = ch.start + ch.titleSkip
  elseif isChapterHeading(lines[ch.start]) then
    startLine = ch.start + 1
  end

  local text = table.concat(lines, "\n", startLine, ch.finish)
  return flowParagraphs(applyStandardContentTransforms(text))
end

-- ── Filters ───────────────────────────────────────────────────────────────────

function getFilterList()
  return {
    {
      type         = "select",
      key          = "sort",
      label        = "Sort By",
      defaultValue = "relevance",
      options = {
        { value = "relevance", label = "Relevance" },
        { value = "old",       label = "Oldest"     },
        { value = "new",       label = "Newest"     },
        { value = "random",    label = "Random"     },
        { value = "key",       label = "Alphabetical" },
      }
    },
    {
      type         = "switch",
      key          = "readable_only",
      label        = "Public Domain Only",
      defaultValue = true,
    },
  }
end

function getCatalogFiltered(index, filters)
  local readable = (filters and filters["readable_only"]) or "true"
  local sort     = (filters and filters["sort"]) or "relevance"
  local page     = index + 1

  local q = (readable == "true") and "ebook_access:public" or "book"
  local url = baseUrl .. "/search.json?q=" .. q
              .. "&page=" .. page .. "&limit=" .. PAGE_LIMIT
              .. "&fields=" .. SEARCH_FIELDS
  if sort ~= "relevance" then
    url = url .. "&sort=" .. sort
  end

  local r = http_get(url)
  if not r.success then return { items = {}, hasNext = false } end
  return parseSearchResponse(r.body)
end
