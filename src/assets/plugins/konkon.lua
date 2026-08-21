id       = "konkon"
name     = "Konkon"
version  = "1.0.0"
baseUrl  = "https://konkon.ink"
language = "en"
icon     = "https://konkon.ink/favicon.ico"

local apiBase = "https://api-k.konkon.ink"
local PAGE_SIZE = 20

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

local function coverUrl(novel)
    local key = novel.featured_image_thumb_medium_key
        or novel.featured_image_key
        or novel.featured_image_thumb_small_key
        or novel.featured_image
    if not key or key == "" then return "" end
    return apiBase .. "/api/media/k/" .. base64_encode(key)
end

local function toNovelItem(novel)
    return {
        title = string_clean(novel.title or "Untitled"),
        url   = baseUrl .. "/read/" .. (novel.slug or ""),
        cover = coverUrl(novel)
    }
end

local function mapStatus(status)
    if not status then return "Unknown" end
    local s = string.lower(status)
    if s == "ongoing" then return "Ongoing"
    elseif s == "completed" or s == "complete" then return "Completed"
    elseif s == "cancelled" or s == "canceled" then return "Cancelled"
    elseif s == "hiatus" or s == "on hiatus" then return "On Hiatus"
    end
    return "Unknown"
end

local function summaryText(html)
    if not html or html == "" then return "" end
    local cleaned = html_remove(html, "script", "style")
    local parts = {}
    for _, p in ipairs(html_select(cleaned, "p")) do
        local t = string_trim(p.text)
        if t ~= "" then table.insert(parts, t) end
    end
    return #parts > 0 and table.concat(parts, "\n\n") or string_trim(html_text(cleaned))
end

local function readerHtml(html)
    if not html or html == "" then return "" end
    local cleaned = html_remove(html, "script", "style")
    return applyStandardContentTransforms(html_text(cleaned))
end

function getCatalogList(index)
    local page = index + 1
    local r = http_get(apiBase .. "/api/public/latest-updates?per_page=" .. PAGE_SIZE .. "&page=" .. page, {
        headers = { ["Accept"] = "application/json", ["Referer"] = baseUrl .. "/" }
    })
    if not r.success then return { items = {}, hasNext = false } end
    local data = json_parse(r.body)
    if not data or not data.data then return { items = {}, hasNext = false } end

    local items = {}
    for _, novel in ipairs(data.data) do
        table.insert(items, toNovelItem(novel))
    end
    return { items = items, hasNext = #items >= PAGE_SIZE }
end

function getCatalogSearch(index, query)
    if index > 0 then return { items = {}, hasNext = false } end
    local r = http_get(apiBase .. "/api/public/search?q=" .. url_encode(query), {
        headers = { ["Accept"] = "application/json", ["Referer"] = baseUrl .. "/" }
    })
    if not r.success then return { items = {}, hasNext = false } end
    local data = json_parse(r.body)
    if not data or not data.results then return { items = {}, hasNext = false } end

    local items = {}
    for _, novel in ipairs(data.results) do
        table.insert(items, toNovelItem(novel))
    end
    return { items = items, hasNext = false }
end

local function fetchNovelDetails(slug)
    local r = http_get(apiBase .. "/api/public/novels/" .. url_encode(slug) .. "?page=1&per_page=100", {
        headers = { ["Accept"] = "application/json", ["Referer"] = baseUrl .. "/" }
    })
    if not r.success then return nil end
    local data = json_parse(r.body)
    return data and data.data or nil
end

function getBookTitle(bookUrl)
    local slug = bookUrl:match("/read/([^/?#]+)")
    if not slug then return nil end
    local novel = fetchNovelDetails(slug)
    return novel and string_clean(novel.title) or nil
end

function getBookCoverImageUrl(bookUrl)
    local slug = bookUrl:match("/read/([^/?#]+)")
    if not slug then return nil end
    local novel = fetchNovelDetails(slug)
    return novel and coverUrl(novel) or nil
end

function getBookDescription(bookUrl)
    local slug = bookUrl:match("/read/([^/?#]+)")
    if not slug then return nil end
    local novel = fetchNovelDetails(slug)
    if novel and novel.description then
        return summaryText(novel.description)
    end
    return nil
end

function getBookGenres(bookUrl)
    local slug = bookUrl:match("/read/([^/?#]+)")
    if not slug then return {} end
    local novel = fetchNovelDetails(slug)
    if not novel then return {} end

    local seen = {}
    local genres = {}
    for _, list in ipairs({novel.genres or {}, novel.tags or {}}) do
        for _, item in ipairs(list) do
            if item.name and not seen[item.name] then
                seen[item.name] = true
                table.insert(genres, item.name)
            end
        end
    end
    return genres
end

function getChapterList(bookUrl)
    local slug = bookUrl:match("/read/([^/?#]+)")
    if not slug then return {} end

    local firstPage = fetchNovelDetails(slug)
    if not firstPage then return {} end

    local lastPage = 1
    if firstPage.chapters_pagination and firstPage.chapters_pagination.last_page then
        lastPage = math.max(1, tonumber(firstPage.chapters_pagination.last_page) or 1)
    end

    local allVolumes = {}
    for _, v in ipairs(firstPage.volumes or {}) do
        table.insert(allVolumes, v)
    end

    for pageNo = 2, lastPage do
        local r = http_get(apiBase .. "/api/public/novels/" .. url_encode(slug) .. "?page=" .. pageNo .. "&per_page=100", {
            headers = { ["Accept"] = "application/json", ["Referer"] = baseUrl .. "/" }
        })
        if r.success then
            local data = json_parse(r.body)
            if data and data.data then
                for _, v in ipairs(data.data.volumes or {}) do
                    table.insert(allVolumes, v)
                end
            end
        end
    end

    table.sort(allVolumes, function(a, b) return (a.order or 0) < (b.order or 0) end)

    local chapters = {}
    for _, volume in ipairs(allVolumes) do
        local chs = volume.chapters or {}
        table.sort(chs, function(a, b) return (a.sort_order or 0) < (b.sort_order or 0) end)
        for _, ch in ipairs(chs) do
            if ch.status == "published" then
                local locked = ch.is_locked and not ch.user_has_access
                local title = (locked and "🔒 " or "") .. (ch.title or "")
                table.insert(chapters, {
                    title = string_clean(title),
                    url   = baseUrl .. "/read/chapter/" .. ch.id .. "/" .. ch.slug
                })
            end
        end
    end

    return chapters
end

function getChapterListHash(bookUrl)
    local slug = bookUrl:match("/read/([^/?#]+)")
    if not slug then return nil end
    local r = http_get(apiBase .. "/api/public/novels/" .. url_encode(slug) .. "?page=1&per_page=100", {
        headers = { ["Accept"] = "application/json", ["Referer"] = baseUrl .. "/" }
    })
    if not r.success then return nil end
    local data = json_parse(r.body)
    if data and data.data and data.data.volumes then
        local lastVol = data.data.volumes[#data.data.volumes]
        if lastVol and lastVol.chapters then
            local lastCh = lastVol.chapters[#lastVol.chapters]
            return lastCh and tostring(lastCh.id) or nil
        end
    end
    return nil
end

function getChapterText(html, url)
    local chapterId = url:match("/read/chapter/(%d+)")
    if not chapterId then return "" end

    local r = http_get(apiBase .. "/api/public/chapters/" .. chapterId, {
        headers = { ["Accept"] = "application/json", ["Referer"] = baseUrl .. "/" }
    })
    if not r.success then return "" end
    local data = json_parse(r.body)
    if not data or not data.data or not data.data.content then return "" end

    return readerHtml(data.data.content)
end
