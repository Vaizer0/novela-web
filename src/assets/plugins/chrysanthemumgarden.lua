id       = "chrysanthemumgarden"
name     = "Chrysanthemum Garden"
version  = "1.0.0"
baseUrl  = "https://chrysanthemumgarden.com"
language = "en"
icon     = "https://chrysanthemumgarden.com/favicon.ico"

local _pageCache = {}

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
    local domain = baseUrl:gsub("https?://", ""):gsub("^www%.", ""):gsub("/$", "")
    text = regex_replace(text, "(?i)" .. domain .. ".*?\\n", "")
    text = regex_replace(text, "(?i)\\A[\\s\\p{Z}\\uFEFF]*((Chapter\\s+\\d+)[^\\n\\r]*[\\n\\r\\s]*)+", "")
    text = regex_replace(text, "(?im)^\\s*(Translator|Editor|Proofreader|Read\\s+(at|on|latest))[:\\s][^\\n\\r]{0,70}(\\r?\\n|$)", "")
    text = string_trim(text)
    return text
end

function getCatalogList(index)
    local page = index + 1
    local url = baseUrl .. "/books/" .. (page > 1 and "page/" .. page .. "/" or "")
    local r = http_get(url)
    if not r.success then return { items = {}, hasNext = false } end

    local items = {}
    for _, article in ipairs(html_select(r.body, "article")) do
        local genres = html_text(html_select_first(article.html, "div.series-genres"))
        if genres and not string.find(genres, "Manhua") then
            local titleEl = html_select_first(article.html, "h2.novel-title > a")
            if titleEl then
                local cover = html_attr(article.html, "div.novel-cover > img", "data-breeze")
                if cover == "" then cover = html_attr(article.html, "div.novel-cover > img", "src") end
                table.insert(items, {
                    title = string_clean(titleEl.text),
                    url   = absUrl(titleEl.href),
                    cover = absUrl(cover)
                })
            end
        end
    end
    return { items = items, hasNext = #items > 0 }
end

function getCatalogSearch(index, query)
    if index > 0 then return { items = {}, hasNext = false } end
    local r = http_get(baseUrl .. "/wp-json/cg/novels")
    if not r.success then return { items = {}, hasNext = false } end

    local data = json_parse(r.body)
    if not data then return { items = {}, hasNext = false } end

    local items = {}
    local q = string.lower(query)
    for _, novel in ipairs(data) do
        if novel.name and string.find(string.lower(novel.name), q, 1, true) then
            local novelPath = novel.link
                :gsub(baseUrl, "")
                :gsub("^/", "")
                :gsub("/$", "")
            table.insert(items, {
                title = string_clean(novel.name),
                url   = baseUrl .. "/" .. novelPath .. "/"
            })
        end
    end
    return { items = items, hasNext = false }
end

function getBookTitle(bookUrl)
    local body = fetchPage(bookUrl)
    if not body then return nil end
    local el = html_select_first(body, "h1.novel-title")
    if el then
        local rawEl = html_select_first(el.html, "span.novel-raw-title")
        if rawEl then rawEl:remove() end
        return string_clean(el.text)
    end
    return nil
end

function getBookCoverImageUrl(bookUrl)
    local body = fetchPage(bookUrl)
    if not body then return nil end
    local cover = html_attr(body, "div.novel-cover > img", "data-breeze")
    if cover == "" then cover = html_attr(body, "div.novel-cover > img", "src") end
    return cover ~= "" and absUrl(cover) or nil
end

function getBookDescription(bookUrl)
    local body = fetchPage(bookUrl)
    if not body then return nil end
    local parts = {}
    for _, p in ipairs(html_select(body, "div.entry-content > p")) do
        local t = string_trim(p.text)
        if t ~= "" then table.insert(parts, t) end
    end
    return #parts > 0 and table.concat(parts, "\n\n") or nil
end

function getBookGenres(bookUrl)
    local body = fetchPage(bookUrl)
    if not body then return {} end

    local genres = {}
    for _, a in ipairs(html_select(body, "div.series-genres > a")) do
        local label = string_trim(a.text)
        if label ~= "" then table.insert(genres, label) end
    end
    for _, a in ipairs(html_select(body, "a.series-tag")) do
        local label = string_trim(a.text:match("([^(]+)") or a.text)
        if label ~= "" then table.insert(genres, label) end
    end
    return genres
end

function getChapterList(bookUrl)
    local body = fetchPage(bookUrl)
    if not body then return {} end

    local chapters = {}
    for _, a in ipairs(html_select(body, "div.chapter-item > a")) do
        if a.href and a.href ~= "" then
            table.insert(chapters, {
                title = string_clean(a.text),
                url   = absUrl(a.href)
            })
        end
    end
    return chapters
end

function getChapterListHash(bookUrl)
    local r = http_get(bookUrl)
    if not r.success then return nil end
    local lastCh = html_select_first(r.body, "div.chapter-item > a:last-child")
    return lastCh and lastCh.href or nil
end

function getChapterText(html, url)
    local cleaned = html_remove(html, "script", "style", ".ads", ".advertisement", ".chapter-nav", ".nav-links")
    local el = html_select_first(cleaned, "div#novel-content")
    if not el then return "" end
    return applyStandardContentTransforms(html_text(el.html))
end
