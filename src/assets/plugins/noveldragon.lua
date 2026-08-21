-- Noveldragon Lua Plugin
-- Base: https://noveldragon.net
-- API : https://api.noveldragon.net

id       = "noveldragon"
name     = "Noveldragon"
version  = "1.0.0"
baseUrl  = "https://noveldragon.net"
language = "en"
icon = "https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://noveldragon.net&size=256"

local apiBase = "https://api.noveldragon.net"
local browserFinger = "01a5b94832ea915be83ed321fb2338a6"

local BOOK_FIELDS = "id,name,canonicalName,genres,cover,subTitle,synopsis,translatorId,ratingNum,markedUp,releasedChapterCount,enSerial"
local PAGE_SIZE = 8

local _pageCache = {}
local _bookInfoCache = {}
local _chapterListCache = {}

local function absUrl(href)
    if not href or href == "" then return "" end
    if string_starts_with(href, "http") then return href end
    if string_starts_with(href, "//") then return "https:" .. href end
    return url_resolve(baseUrl, href)
end

local function apiHeaders()
    return {
        ["Accept"] = "application/json",
        ["x-browser-finger"] = browserFinger,
        ["x-bn-language-code"] = "en",
        ["accept-language"] = "en",
    }
end

local function fetchPage(url)
    if _pageCache[url] then return _pageCache[url] end
    local r = http_get(url)
    if r.success then
        _pageCache[url] = r.body
        return r.body
    end
    return nil
end

local function apiGet(url)
    local r = http_get(url, { headers = apiHeaders() })
    if not r.success then
        log_error("noveldragon apiGet failed: " .. tostring(r.code) .. " url=" .. url)
        return nil
    end
    local data = json_parse(r.body)
    if not data then
        log_error("noveldragon json_parse failed: " .. url)
    end
    return data
end

local function buildListUrl(query, page)
    local url = apiBase .. "/v1/books?fields=" .. BOOK_FIELDS
    url = url .. "&query=" .. url_encode(query or "")
    url = url .. "&page=" .. tostring(page or 1)
    url = url .. "&ignoreStatus=false"
    url = url .. "&pageSize=" .. tostring(PAGE_SIZE)
    return url
end

local function bookArrayFromPayload(payload)
    if not payload then return {} end
    if type(payload.data) == "table" and payload.data.books and type(payload.data.books) == "table" then
        return payload.data.books
    end
    if type(payload.data) == "table" then
        return payload.data
    end
    if type(payload.books) == "table" then
        return payload.books
    end
    return {}
end

local function makeBookItem(book)
    local slug = book.canonicalName or ""
    local title = book.name or ""
    if slug == "" or title == "" then return nil end

    return {
        title = string_clean(title),
        url   = baseUrl .. "/books/" .. slug,
        cover = book.cover and book.cover ~= "" and absUrl(book.cover) or nil
    }
end

local function listBooks(query, index)
    local page = index + 1
    local payload = apiGet(buildListUrl(query, page))
    local items = {}

    for _, book in ipairs(bookArrayFromPayload(payload)) do
        local item = makeBookItem(book)
        if item then
            table.insert(items, item)
        end
    end

    return {
        items = items,
        hasNext = #items >= PAGE_SIZE
    }
end

local function slugFromBookUrl(bookUrl)
    if not bookUrl then return nil end
    return bookUrl:match("/books/([^/?#]+)")
end

local function chapterInfoFromUrl(chapterUrl)
    if not chapterUrl then return nil, nil end
    local slug, chapter = chapterUrl:match("/books/([^/]+)/chapters/([^/?#]+)")
    return slug, chapter
end

local function normalizeText(text)
    if not text or text == "" then return "" end
    text = string_normalize(text)
    text = text:gsub("\r\n", "\n"):gsub("\r", "\n")
    text = regex_replace(text, "[ \t]+\n", "\n")
    text = regex_replace(text, "\n[ \t]+", "\n")
    text = regex_replace(text, "\n{3,}", "\n\n")
    return string_trim(text)
end

local function applyStandardContentTransforms(text)
    if not text or text == "" then return "" end
    text = normalizeText(text)

    local domain = baseUrl:gsub("https?://", ""):gsub("^www%.", ""):gsub("/$", "")
    text = regex_replace(text, "(?i)" .. domain .. ".*?\n", "")
    text = regex_replace(text, "(?i)\\A[\\s\\p{Z}\\uFEFF]*((Chapter\\s+\\d+|C\\d+)[^\\n\\r]*[\\n\\r\\s]*)+", "")
    text = regex_replace(text, "(?im)^\\s*(Translator|Editor|Proofreader|Read\\s+(at|on|latest))[:\\s][^\\n\\r]{0,70}(\\r?\\n|$)", "")
    text = regex_replace(text, "(?im)^\\s*(Перевод|Переводчик|Редакция|Редактор|Аннотация|Сайт|Источник)[:\\s][^\\n\\r]{0,70}(\\r?\\n|$)", "")
    return string_trim(text)
end

local function fetchBookInfo(bookUrl)
    if _bookInfoCache[bookUrl] then return _bookInfoCache[bookUrl] end

    local slug = slugFromBookUrl(bookUrl)
    local candidates = {}

    if slug and slug ~= "" then
        table.insert(candidates, slug)
        table.insert(candidates, slug:gsub("%-", " "))
    end

    local info = nil
    for _, q in ipairs(candidates) do
        local payload = apiGet(buildListUrl(q, 1))
        local books = bookArrayFromPayload(payload)
        for _, book in ipairs(books) do
            if book.canonicalName == slug or string.lower(book.name or "") == string.lower((slug or ""):gsub("%-", " ")) then
                info = book
                break
            end
        end
        if not info and #books > 0 and q == candidates[1] then
            info = books[1]
        end
        if info then break end
    end

    if not info then
        local body = fetchPage(bookUrl)
        if body then
            local title = html_attr(body, "meta[property='og:title']", "content")
            local desc  = html_attr(body, "meta[property='og:description']", "content")
            local cover = html_attr(body, "meta[property='og:image']", "content")
            info = {
                name = title or "",
                synopsis = desc or "",
                cover = cover or "",
                canonicalName = slug or ""
            }
        end
    end

    if info then
        _bookInfoCache[bookUrl] = info
    end

    return info
end

local function fetchChapterSitemap(slug)
    if not slug or slug == "" then return nil end
    if _chapterListCache[slug] then return _chapterListCache[slug] end

    local url = apiBase .. "/v1/books/" .. slug .. "/chapter-sitemaps"
    local payload = apiGet(url)
    local list = {}

    if payload and type(payload.data) == "table" then
        for _, ch in ipairs(payload.data) do
            local canonical = ch.canonicalName or ""
            local name = ch.name or ""
            if canonical ~= "" and name ~= "" then
                table.insert(list, {
                    title = string_clean(name),
                    url = baseUrl .. "/books/" .. slug .. "/chapters/" .. canonical,
                    canonicalName = canonical,
                    id = ch.id
                })
            end
        end
    end

    _chapterListCache[slug] = list
    return list
end

local function fetchChapterContent(slug, chapterCanonical)
    if not slug or slug == "" or not chapterCanonical or chapterCanonical == "" then
        return nil
    end

    local url = apiBase .. "/v1/books/" .. slug .. "/chapters/" .. chapterCanonical .. "/content"
    local payload = apiGet(url)
    if not payload or type(payload.data) ~= "table" then return nil end
    return payload.data
end

function getCatalogList(index)
    return listBooks("", index)
end

function getCatalogSearch(index, query)
    if index > 0 then
        return { items = {}, hasNext = false }
    end

    local items = {}

    local payload = apiGet(apiBase .. "/v1/books/search?keyword=" .. url_encode(query or ""))
    if payload and type(payload.data) == "table" and type(payload.data.books) == "table" then
        for _, book in ipairs(payload.data.books) do
            local item = makeBookItem(book)
            if item then table.insert(items, item) end
        end
    end

    if #items == 0 then
        return listBooks(query, index)
    end

    return {
        items = items,
        hasNext = false
    }
end

function getBookTitle(bookUrl)
    local info = fetchBookInfo(bookUrl)
    if info and info.name and info.name ~= "" then
        return string_clean(info.name)
    end

    local body = fetchPage(bookUrl)
    if not body then return nil end
    local title = html_attr(body, "meta[property='og:title']", "content")
    if title == "" then
        title = html_attr(body, "meta[name='title']", "content")
    end
    return title ~= "" and string_clean(title) or nil
end

function getBookCoverImageUrl(bookUrl)
    local info = fetchBookInfo(bookUrl)
    if info and info.cover and info.cover ~= "" then
        return absUrl(info.cover)
    end

    local body = fetchPage(bookUrl)
    if not body then return nil end
    local cover = html_attr(body, "meta[property='og:image']", "content")
    return cover ~= "" and absUrl(cover) or nil
end

function getBookDescription(bookUrl)
    local info = fetchBookInfo(bookUrl)
    if info then
        local desc = info.synopsis or info.subTitle or ""
        if desc ~= "" then return string_trim(desc) end
    end

    local body = fetchPage(bookUrl)
    if not body then return nil end
    local desc = html_attr(body, "meta[property='og:description']", "content")
    if desc == "" then
        desc = html_attr(body, "meta[name='description']", "content")
    end
    return desc ~= "" and string_trim(desc) or nil
end

function getBookGenres(bookUrl)
    local info = fetchBookInfo(bookUrl)
    local genres = {}

    if info and type(info.genres) == "table" then
        for _, g in ipairs(info.genres) do
            local label = g.engName or g.name or ""
            if label ~= "" then table.insert(genres, string_clean(label)) end
        end
    end

    return genres
end

function getChapterList(bookUrl)
    local slug = slugFromBookUrl(bookUrl)
    if not slug or slug == "" then return {} end

    local list = fetchChapterSitemap(slug)
    if not list then return {} end

    local chapters = {}
    for _, ch in ipairs(list) do
        table.insert(chapters, {
            title = ch.title,
            url = ch.url
        })
    end
    return chapters
end

function getChapterListHash(bookUrl)
    local slug = slugFromBookUrl(bookUrl)
    if not slug or slug == "" then return nil end

    local list = fetchChapterSitemap(slug)
    if not list or #list == 0 then return nil end

    local last = list[#list]
    return last.canonicalName or last.url or nil
end

function getChapterText(html, url)
    local slug, chapterCanonical = chapterInfoFromUrl(url)
    local data = fetchChapterContent(slug, chapterCanonical)
    if not data then return "" end

    local content = data.content or ""
    if type(content) == "table" then
        local paragraphs = {}
        for _, para in ipairs(content) do
            local p = string_trim(tostring(para))
            if p ~= "" then table.insert(paragraphs, p) end
        end
        content = table.concat(paragraphs, "\n\n")
    else
        content = tostring(content)
    end

    return applyStandardContentTransforms(content)
end