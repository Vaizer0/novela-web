-- ── Metadata ────────────────────────────────────────────────────────────────
id       = "novellive"
name     = "Novel Live"
version  = "1.0.2"
baseUrl  = "https://novellive.app"
language = "en"
icon = "https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://novellive.app&size=256"

-- ── Helpers ────────────────────────────────────────────────────────────────

local _pageCache = {}

local function absUrl(href)
    if not href or href == "" then return "" end
    if string_starts_with(href, "http") then return href end
    if string_starts_with(href, "//") then return "https:" .. href end
    return url_resolve(baseUrl, href)
end

local function fetchPage(url)
    if _pageCache[url] then
        return _pageCache[url]
    end
    local r = http_get(url)
    if r.success then
        _pageCache[url] = r.body
        return r.body
    end
    return nil
end

local function applyStandardContentTransforms(text)
    if not text or text == "" then return "" end

    text = string_normalize(text)

    local domain = baseUrl:gsub("https?://", ""):gsub("^www%.", ""):gsub("/$", "")
    text = regex_replace(text, "(?i)" .. domain .. ".*?\\n", "")
    text = regex_replace(text, "(?i)\\A[\\s\\p{Z}\\uFEFF]*((Chapter\\s+\\d+)[^\\n\\r]*[\\n\\r\\s]*)+", "")
    text = regex_replace(text, "(?im)^\\s*(Translator|Editor|Proofreader|Read\\s+(at|on|latest))[:\\s][^\\n\\r]{0,70}(\\r?\\n|$)", "")
    text = regex_replace(text, "(?i)Visit and read more novel to help us update chapter quickly.*?Thank you so much!", "")
    text = string_trim(text)
    return text
end

local function getNovelSlug(bookUrl)
    return bookUrl:match("/book/([^/?#]+)") or ""
end

local function getFirstChapterId(bookUrl)
    local body = fetchPage(bookUrl)
    if not body then return "" end

    local chapterUrl =
        body:match('<meta%s+property="og:novel:read_url"%s+content="([^"]+)"')
        or body:match('<meta%s+name="og:novel:read_url"%s+content="([^"]+)"')
        or body:match('<link%s+rel="canonical"%s+href="([^"]+)"')

    if chapterUrl and chapterUrl ~= "" then
        return chapterUrl:match("/book/[^/]+/([^/?#]+)") or ""
    end

    return ""
end

-- ── Catalog ────────────────────────────────────────────────────────────────

function getCatalogList(index)
    local page = index + 1
    local url = baseUrl .. "/list/latest-release-novels/"
    if page > 1 then
        url = url .. tostring(page) .. "/"
    end

    local r = http_get(url)
    if not r.success then
        return { items = {}, hasNext = false }
    end

    local items = {}
    for _, li in ipairs(html_select(r.body, ".ul-list1 .li")) do
        local a = html_select_first(li.html, ".txt h3.tit a")
        local img = html_select_first(li.html, ".pic img")
        if a then
            table.insert(items, {
                title = string_clean(a.text),
                url   = absUrl(a.href),
                cover = img and absUrl(img.src) or ""
            })
        end
    end

    return { items = items, hasNext = #items >= 15 }
end

-- ── Search ─────────────────────────────────────────────────────────────────

function getCatalogSearch(index, query)
    if index > 0 then
        return { items = {}, hasNext = false }
    end

    local r = http_post(baseUrl .. "/search/", "searchkey=" .. url_encode(query), {
        headers = {
            ["Content-Type"] = "application/x-www-form-urlencoded"
        }
    })

    if not r.success then
        return { items = {}, hasNext = false }
    end

    local items = {}
    for _, li in ipairs(html_select(r.body, ".ul-list1 .li")) do
        local a = html_select_first(li.html, ".txt h3.tit a")
        local img = html_select_first(li.html, ".pic img")
        if a then
            table.insert(items, {
                title = string_clean(a.text),
                url   = absUrl(a.href),
                cover = img and absUrl(img.src) or ""
            })
        end
    end

    return { items = items, hasNext = false }
end

-- ── Book details ───────────────────────────────────────────────────────────

function getBookTitle(bookUrl)
    local body = fetchPage(bookUrl)
    if not body then return nil end
    local el = html_select_first(body, ".m-desc h1.tit, h1.tit, h1")
    return el and string_clean(el.text) or nil
end

function getBookCoverImageUrl(bookUrl)
    local body = fetchPage(bookUrl)
    if not body then return nil end
    local el = html_select_first(body, ".m-imgtxt .pic img, .pic img")
    return el and absUrl(el.src) or nil
end

function getBookDescription(bookUrl)
    local body = fetchPage(bookUrl)
    if not body then return nil end
    local el = html_select_first(body, ".m-desc .txt .inner, .m-desc .txt, .desc")
    return el and string_trim(el.text) or nil
end

function getBookGenres(bookUrl)
    local body = fetchPage(bookUrl)
    if not body then return {} end

    local genres = {}
    for _, item in ipairs(html_select(body, ".m-imgtxt .item, .m-imgtxt .desc .item")) do
        local icon = html_select_first(item.html, ".glyphicon-th-list")
        if icon then
            for _, a in ipairs(html_select(item.html, ".right a")) do
                local g = string_clean(a.text)
                if g ~= "" then
                    table.insert(genres, g)
                end
            end
            break
        end
    end
    return genres
end

-- ── Chapter list: load ALL chapters via AJAX ────────────────────────────────

function parsePage(bookUrl, page)
    if page > 1 then
        return { chapters = {}, totalPages = 1 }
    end

    local novelSlug = getNovelSlug(bookUrl)
    if novelSlug == "" then
        return { chapters = {}, totalPages = 1 }
    end

    local firstChapterId = getFirstChapterId(bookUrl)
    if firstChapterId == "" then
        return { chapters = {}, totalPages = 1 }
    end

    local apiUrl = baseUrl .. "/ajax/get-list-chapter?novel_id=" .. url_encode(novelSlug) .. "&chapter_id=" .. url_encode(firstChapterId)
    local r = http_get(apiUrl, {
        headers = {
            ["Accept"] = "application/json, text/javascript, */*; q=0.01",
            ["X-Requested-With"] = "XMLHttpRequest"
        }
    })

    if not r.success then
        return { chapters = {}, totalPages = 1 }
    end

    local data = json_parse(r.body)
    if not data or not data.success or type(data.chapters) ~= "table" then
        return { chapters = {}, totalPages = 1 }
    end

    local chapters = {}
    for _, ch in ipairs(data.chapters) do
        local chId = ch.chapter_id or ""
        local chTitle = ch.chapter_name or ""
        if chId ~= "" and chTitle ~= "" then
            table.insert(chapters, {
                title = string_clean(chTitle),
                url   = baseUrl .. "/book/" .. novelSlug .. "/" .. chId
            })
        end
    end

    return { chapters = chapters, totalPages = 1 }
end

-- ── Chapter text ───────────────────────────────────────────────────────────

function getChapterText(html, url)
    local cleaned = html_remove(html, "script", "style", "div[id^='pf-']", ".chapter-start", ".chapter-end", ".error", ".tips")
    local el = html_select_first(cleaned, ".m-read .txt, .chapter-content, .content, article")
    if not el then return "" end

    local text = html_text(el.html)
    return applyStandardContentTransforms(text)
end