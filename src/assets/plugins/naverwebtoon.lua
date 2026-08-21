id       = "naverwebtoon"
name     = "Naver Webtoon"
version  = "1.0.0"
baseUrl  = "https://m.comic.naver.com"
language = "ko"
icon     = "https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://comic.naver.com&size=256"

-- Naver Webtoon (네이버 웹툰). Webtoons are image chapters: every episode is
-- a vertical strip of images from image-comic.pstatic.net, served as
-- https://image-comic.pstatic.net/mobilewebimg/{titleId}/{no}/{hash}_NNN.jpg
-- in reading order. The reader engine (shared with asurascans.lua) renders
-- page images natively: getPageList returns the ordered CDN URLs and
-- getChapterText stays as the legacy fallback emitting <img src="..."> tags.
--
-- Site structure (verified live 2026-08-10):
--   * m.comic.naver.com is a JS SPA shell, BUT the webtoon/list (book page),
--     webtoon/detail (episode page) and webtoon/genre (catalog) routes are
--     server-rendered HTML — no JS needed for anything this plugin parses.
--   * Catalog:  /webtoon/genre?tab=webtoon&sort=HIT&page=N  (30 cards/page)
--   * Search:   https://comic.naver.com/api/search/webtoon?keyword=..&page=..
--               JSON API on the DESKTOP host (mobile host 404s it); needs
--               Accept + X-Requested-With headers and the /search Referer.
--   * Book:     /webtoon/list?titleId={id} — title, og:image cover, summary,
--               genre tags, and the episode list (30 episodes/page, ASC).
--   * Episode:  /webtoon/detail?titleId={id}&no={no} — server-rendered strip:
--               <img class="fx2 lazy toon_image" data-src="https://image-comic...">
--               (src is a placeholder; the real URL lives in data-src).
--   * Invalid `no` values are 302-corrected by the server to a valid episode.
--
-- Engine gotchas respected: no string.find with '-' patterns (LuaJ parses
-- '-' as a lazy quantifier); url_encode is java.net.URLEncoder (encodes
-- ?, &, = fully) so it is only used for the query value itself.

local function absUrl(href)
    if not href or href == "" then return "" end
    if string_starts_with(href, "http") then return href end
    if string_starts_with(href, "//") then return "https:" .. href end
    return url_resolve(baseUrl, href)
end

-- Search API lives on the desktop host.
local API_BASE = "https://comic.naver.com"

-- The engine calls getBookTitle / getBookCoverImageUrl / getBookDescription /
-- getBookGenres in parallel, all on the same book page — cache it per URL
-- (fetchPage pattern from the guide). getChapterList intentionally bypasses
-- this cache so library updates always see fresh episode data.
local _pageCache = {}

local function fetchPage(url)
    if _pageCache[url] then return _pageCache[url] end
    local r = http_get(url)
    if not r.success then return nil end
    _pageCache[url] = r.body
    return r.body
end

local function fetch(url)
    local r = http_get(url)
    if not r.success then return nil end
    return r.body
end

-- Catalog: server-rendered genre page, "조회순" (most-viewed) sort, 30 cards
-- per page. Card: <li><div class="lst"><a href="/webtoon/list?titleId=N">
-- <span class="im_br"><img src="cover">…<span class="toon_name"><strong>title
-- </strong>…<p class="sub_info">author</p>
function getCatalogList(index)
    local page = index + 1
    local url = baseUrl .. "/webtoon/genre?tab=webtoon&sort=HIT&page=" .. page
    local body = fetch(url)
    if not body then return { items = {}, hasNext = false } end
    local items = {}
    local seen = {}
    for _, card in ipairs(html_select(body, "div.lst")) do
        local a = html_select_first(card.html, "a[href*='/webtoon/list?titleId=']")
        if a then
            local url = absUrl(a.href)
            if url ~= "" and not seen[url] then
                seen[url] = true
                local img = html_select_first(card.html, "span.im_br img")
                local cover = img and absUrl(img.src) or ""
                local t = html_select_first(card.html, "span.toon_name strong")
                local title = t and string_clean(t.text) or ""
                if title ~= "" then
                    local item = { title = title, url = url, cover = cover }
                    local author = html_select_first(card.html, "p.sub_info")
                    if author then
                        local at = string_clean(author.text)
                        if at ~= "" then item.author = at end
                    end
                    table.insert(items, item)
                end
            end
        end
    end
    -- Past the last page the grid is empty — stop paginating.
    return { items = items, hasNext = #items > 0 }
end

-- JSON search API. Response: { searchList: [{titleId, titleName,
-- thumbnailUrl, displayAuthor, …}], pageInfo: { page, nextPage, … } }.
function getCatalogSearch(index, query)
    local page = index + 1
    local url = API_BASE .. "/api/search/webtoon?keyword=" .. url_encode(query) .. "&page=" .. page
    local r = http_get(url, {
        headers = {
            ["Accept"] = "application/json",
            ["X-Requested-With"] = "XMLHttpRequest",
            ["Referer"] = API_BASE .. "/search",
        }
    })
    if not r.success then return { items = {}, hasNext = false } end
    local data = json_parse(r.body)
    if not data or not data.searchList then return { items = {}, hasNext = false } end
    local items = {}
    for _, hit in ipairs(data.searchList) do
        local title = string_clean(tostring(hit.titleName or ""))
        if title ~= "" then
            local item = {
                title = title,
                url = baseUrl .. "/webtoon/list?titleId=" .. tostring(hit.titleId),
                cover = tostring(hit.thumbnailUrl or "")
            }
            local author = tostring(hit.displayAuthor or "")
            if author ~= "" then item.author = author end
            table.insert(items, item)
        end
    end
    local hasNext = false
    if data.pageInfo then
        local nextPage = tonumber(data.pageInfo.nextPage) or 0
        local curPage = tonumber(data.pageInfo.page) or 0
        hasNext = nextPage > curPage
    end
    return { items = items, hasNext = hasNext }
end

function getBookTitle(bookUrl)
    local body = fetchPage(bookUrl)
    if not body then return nil end
    local el = html_select_first(body, ".area_info strong.title")
    if el then
        local t = string_clean(el.text)
        if t ~= "" then return t end
    end
    local meta = html_attr(body, "meta[property='og:title']", "content")
    return meta ~= "" and string_trim(meta) or nil
end

function getBookCoverImageUrl(bookUrl)
    local body = fetchPage(bookUrl)
    if not body then return nil end
    local src = html_attr(body, "meta[property='og:image']", "content")
    if src == "" then
        local img = html_select_first(body, ".area_thumbnail img")
        if img then src = img.src end
    end
    return src ~= "" and absUrl(src) or nil
end

function getBookDescription(bookUrl)
    local body = fetchPage(bookUrl)
    if not body then return nil end
    local el = html_select_first(body, "div.summary p")
    if el then
        local t = string_trim(html_text(el.html))
        if t ~= "" then return t end
    end
    local meta = html_attr(body, "meta[property='og:description']", "content")
    return meta ~= "" and string_trim(meta) or nil
end

function getBookGenres(bookUrl)
    local body = fetchPage(bookUrl)
    if not body then return {} end
    local genres = {}
    for _, li in ipairs(html_select(body, ".genre .property.list_detail li")) do
        local t = string_clean(li.text)
        if t ~= "" then table.insert(genres, t) end
    end
    return genres
end

-- Episode list: 30 episodes per page, ascending (chronological). Naver gates
-- episodes behind its daily-pass system: anonymous readers get a free window
-- (the first ~10 episodes of finished series, the latest ~10 of ongoing
-- ones); the rest render as <li class="item lock"> with href="#" and no
-- chapter URL. get_cookies is a no-op in this engine, so locked episodes can
-- never be read and are skipped here. To avoid scanning dozens of locked
-- pages, probe page 1 and the last page first (they hold the free windows of
-- finished / ongoing series), then scan the middle only while new chapters
-- keep appearing; the result is sorted chronologically by episode number.
function getChapterList(bookUrl)
    local titleId = string.match(bookUrl, "titleId=(%d+)")
    if not titleId then return {} end

    local function listUrl(page)
        return baseUrl .. "/webtoon/list?titleId=" .. titleId .. "&sortOrder=ASC&page=" .. page
    end

    local function fetchList(page)
        local r = http_get(listUrl(page))
        if not r.success then return nil end
        return r.body
    end

    local first = fetchList(1)
    if not first then return {} end

    local total = nil
    local cntEl = html_select_first(first, ".title_count .count_num")
    if cntEl then
        -- gsub returns (string, count); the count must not leak into tonumber's base arg.
        local t = string_trim(cntEl.text):gsub(",", "")
        local n = tonumber(t)
        if n and n > 0 then total = n end
    end
    local maxPages = 200
    if total then maxPages = math.ceil(total / 30) end

    local chapters = {}
    local seen = {}

    -- Episode row: <li class="item" data-no="N"><a href="/webtoon/detail?
    -- titleId=..&no=..&week=.."><span class="name"><strong>{title}</strong>
    -- Locked rows (href="#") yield no URL and are skipped. Returns the number
    -- of rows on the page so the caller can tell "empty page" from "page full
    -- of locked episodes".
    local function collectEpisodes(body)
        local rows = 0
        for _, li in ipairs(html_select(body, "ul.section_episode_list li.item")) do
            rows = rows + 1
            local a = html_select_first(li.html, "a[href*='/webtoon/detail?titleId=']")
            if a then
                local no = string.match(a.href, "no=(%d+)")
                local url = no and (baseUrl .. "/webtoon/detail?titleId=" .. titleId .. "&no=" .. no) or ""
                if url ~= "" and not seen[url] then
                    seen[url] = true
                    local t = html_select_first(li.html, "span.name strong")
                    local title = t and string_clean(t.text) or ""
                    if title ~= "" then
                        table.insert(chapters, { title = title, url = url })
                    end
                end
            end
        end
        return rows
    end

    local rowsFirst = collectEpisodes(first)
    if rowsFirst == 0 then return {} end  -- page 1 empty: no readable list

    -- Last page: holds the free window of ongoing series.
    if maxPages > 1 then
        local last = fetchList(maxPages)
        if last then collectEpisodes(last) end
    end

    -- Both ends locked ⇒ whole series is daily-pass locked.
    if maxPages > 1 and #chapters == 0 then return {} end

    -- Middle pages (newest → oldest): keep going while new chapters appear.
    for p = maxPages - 1, 2, -1 do
        local body = fetchList(p)
        if not body then break end
        local before = #chapters
        local rows = collectEpisodes(body)
        if rows == 0 then break end           -- truly empty page: count mismatch
        if #chapters == before then break end -- this page added nothing: past the free window
    end

    -- Chronological order (collection probes newest pages first).
    local function episodeNo(u)
        local n = string.match(u, "no=(%d+)")
        return tonumber(n) or 0
    end
    table.sort(chapters, function(a, b) return episodeNo(a.url) < episodeNo(b.url) end)
    return chapters
end
-- Episode strip: server-rendered <img class="fx2 lazy toon_image"
-- data-src="https://image-comic.pstatic.net/mobilewebimg/{titleId}/{no}/...">.
-- Lazy images carry the real URL in data-src (src is a transparent
-- placeholder). Returns the ordered unique CDN URLs, or nil.
local function parseChapterImages(body)
    if not body or body == "" then return nil end
    local pages = {}
    local seen = {}
    -- el:attr()/el:select() receive only the self arg in this engine (LuaJ
    -- OneArgFunction) and jsoup's compound :eq() is unreliable here, so the
    -- lazy-image URLs are extracted with regex_match over the raw HTML. The
    -- episode strip imgs come first in document order; anything else from the
    -- CDN (related-content thumbnails) is filtered out by the mobilewebimg
    -- path, which only the strip uses. Plain string.find (no '-' in pattern).
    local matches = regex_match(body, 'data-src="https://[^"]+"')
    for _, v in ipairs(matches) do
        local src = regex_replace(v, 'data-src="([^"]+)"', "$1")
        src = absUrl(src)
        if src ~= "" and string.find(src, "mobilewebimg", 1, true) and not seen[src] then
            seen[src] = true
            table.insert(pages, src)
        end
    end
    if #pages == 0 then return nil end
    return pages
end

-- Primary reader path: ordered page URLs. The app renders these natively
-- (SSIV tiled decode, aspect ratio from the decoded file) — same convention
-- as asurascans.lua. Engine passes the fetched chapter HTML; a bare URL or
-- empty html means "fetch it" (CLI ergonomics).
function getPageList(html, url)
    local body = html
    if not body or body == "" or string_starts_with(body, "http") then
        local r = http_get(url)
        if not r.success then return {} end
        body = r.body
    end
    local pages = parseChapterImages(body)
    if not pages then return {} end
    return pages
end

-- Legacy fallback for app builds without page-list support: <img> tags in
-- reading order. Output stays far above the 100-char chapter minimum.
function getChapterText(html, url)
    local body = html
    if not body or body == "" or string_starts_with(body, "http") then
        local r = http_get(url)
        if not r.success then return "" end
        body = r.body
    end
    local pages = parseChapterImages(body)
    if not pages then return "" end
    local tags = {}
    for _, src in ipairs(pages) do
        -- & → &amp;: jsoup decodes attributes in extractImgTag.
        table.insert(tags, '<img src="' .. src:gsub("&", "&amp;") .. '">')
    end
    return table.concat(tags, "\n")
end
