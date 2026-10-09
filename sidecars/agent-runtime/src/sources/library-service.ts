import { ProxyAgent } from "undici";
import { load as loadHtml } from "cheerio";
import iconv from "iconv-lite";
import { createDecipheriv } from "node:crypto";
import qianyueSourceData from "../data/qianyue-novel-sources.json" with { type: "json" };
import fanqiePuaMaps from "../data/fanqie-pua-map.json" with { type: "json" };

const webProxyAgents = new Map<string, ProxyAgent>();
const webRateLimits = new Map<string, number>();
type WebFetchOptions = {
  headers?: Record<string, string>;
  retries?: number;
  method?: 'GET' | 'POST';
  body?: string;
  encoding?: string;
};

const fetchWebText = async (url: string, params?: Record<string, unknown>, options: WebFetchOptions = {}): Promise<string> => {
  const proxyEnabled = params?.proxyEnabled === true;
  const proxyURL = typeof params?.proxyURL === "string" ? params.proxyURL.trim() : "";
  let dispatcher: ProxyAgent | undefined;
  if (proxyEnabled && proxyURL) {
    dispatcher = webProxyAgents.get(proxyURL);
    if (!dispatcher) {
      dispatcher = new ProxyAgent(proxyURL);
      webProxyAgents.set(proxyURL, dispatcher);
    }
  }
  const origin = new URL(url).origin;
  const rateLimitKey = `${origin}|${proxyEnabled ? proxyURL : ""}`;
  const checkRateLimit = () => {
    const remaining = (webRateLimits.get(rateLimitKey) || 0) - Date.now();
    if (remaining > 0) throw new Error(`书籍服务 ${new URL(url).hostname} 请求受限（HTTP 429），请在 ${Math.ceil(remaining / 1000)} 秒后重试`);
    webRateLimits.delete(rateLimitKey);
  };
  let lastError: unknown;
  const retries = Math.max(1, Math.min(4, options.retries ?? 3));
  for (let attempt = 0; attempt < retries; attempt += 1) {
    checkRateLimit();
    let retryable = true;
    try {
      const response = await fetch(url, {
        method: options.method || 'GET',
        ...(options.body ? { body: options.body } : {}),
        signal: AbortSignal.timeout(15_000),
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36",
          Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
          Referer: "https://fanqienovel.com/",
          ...options.headers,
        },
        ...(dispatcher ? { dispatcher } : {}),
      } as RequestInit);
      if (response.status === 429) {
        const retryAfter = response.headers.get("retry-after")?.trim();
        const seconds = retryAfter && /^\d+$/u.test(retryAfter) ? Number(retryAfter) : NaN;
        const retryAt = Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Date.parse(retryAfter || "");
        // 尊重服务端冷却时间，同一出口下的分类和榜单请求一起暂停，避免快速重试加重限流
        webRateLimits.set(rateLimitKey, Math.max(webRateLimits.get(rateLimitKey) || 0, Number.isFinite(retryAt) && retryAt > Date.now() ? retryAt : Date.now() + 60_000));
        await response.body?.cancel();
        checkRateLimit();
      }
      retryable = response.ok || response.status >= 500 || response.status === 408;
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`书籍服务 ${new URL(url).hostname} 返回 HTTP ${response.status}`);
      }
      if (options.encoding && !/^utf-?8$/iu.test(options.encoding)) return iconv.decode(Buffer.from(await response.arrayBuffer()), options.encoding);
      return await response.text();
    } catch (error) {
      checkRateLimit();
      if (!retryable) throw error;
      lastError = error;
      if (attempt < retries - 1) await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

const decodeWebText = (value: string): string => value
  .replace(/<br\s*\/?>/giu, "\n")
  .replace(/<\/(?:p|div|li|h[1-6])>/giu, "\n")
  .replace(/<[^>]+>/gu, "")
  .replace(/&nbsp;/giu, " ")
  .replace(/&amp;/giu, "&")
  .replace(/&quot;/giu, '"')
  .replace(/&#39;/giu, "'")
  .replace(/&#(\d+);/gu, (_, code: string) => String.fromCodePoint(Number(code)))
  .replace(/\n{3,}/gu, "\n\n")
  .trim();

// Normal reader pages also load the CAPTCHA script. Only the dedicated challenge
// page title identifies a completed redirect to verification.
const isFanqieVerificationPage = (html: string): boolean => /<title>\s*(?:验证码中间页|安全验证|访问验证)\s*<\/title>/iu.test(html);

const fanqiePuaStarts = [58344, 58345] as const;
const decodeFanqiePuaText = (content: string, mode = 0): string => {
  const table = fanqiePuaMaps[mode] || fanqiePuaMaps[0];
  const start = fanqiePuaStarts[mode] ?? fanqiePuaStarts[0];
  return Array.from(content, character => {
    const index = character.codePointAt(0)! - start;
    const decoded = index >= 0 && index < table.length ? table[index] : undefined;
    return decoded && decoded !== "?" ? decoded : character;
  }).join("");
};

const fanqiePrivateUseCount = (content: string): number => Array.from(content).filter(character => {
  const codePoint = character.codePointAt(0)!;
  return codePoint >= 58344 && codePoint <= 58715;
}).length;

const decodeFanqieContent = (content: string): string => {
  const primary = decodeFanqiePuaText(content);
  if (fanqiePrivateUseCount(primary) === 0 || fanqiePrivateUseCount(content) === 0) return primary;
  const fallback = decodeFanqiePuaText(content, 1);
  return fanqiePrivateUseCount(fallback) < fanqiePrivateUseCount(primary) ? fallback : primary;
};

const extractFanqieReaderContent = (html: string): string => {
  const $ = loadHtml(html);
  const paragraphs = $('.muye-reader-content p').toArray().map(element => $(element).text().trim()).filter(Boolean).join("\n");
  if (paragraphs) return decodeFanqieContent(paragraphs);
  const jsonContentMatch = html.match(/["']content["']\s*:\s*"((?:\\.|[^"\\])*)"/u);
  if (jsonContentMatch) {
    try {
      const decoded = JSON.parse(`"${jsonContentMatch[1]}"`) as string;
      const content = decodeFanqieContent(decodeWebText(decoded));
      if (content) return content;
    } catch { /* Fall through to the rendered chapter body. */ }
  }
  return decodeFanqieContent(decodeWebText($('.muye-reader-content').first().html() || ''));
};

const fanqieBookFromHtml = (html: string, query: string): Array<Record<string, unknown>> => {
  const results: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const pattern = /<a[^>]+href=["'](?:https?:\/\/fanqienovel\.com)?\/page\/(\d+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/giu;
  for (const match of html.matchAll(pattern)) {
    const sourceBookId = match[1];
    if (seen.has(sourceBookId)) continue;
    seen.add(sourceBookId);
    const title = decodeWebText(match[2]).slice(0, 100);
    // 搜索页同时覆盖书名和作者；不要在这里只按标题二次过滤，保证作者关键词也能保留结果。
    if (!title) continue;
    results.push({ id: `fanqie:${sourceBookId}`, sourceBookId, title, author: "未知作者", source: "番茄小说", url: `https://fanqienovel.com/page/${sourceBookId}`, intro: "" });
    if (results.length >= 30) break;
  }
  return results;
};

const fanqiePrivateFontCss = (html: string): string => Array.from(html.matchAll(/@font-face\{[^}]+\}/gu))
  .map(match => match[0]
    .replace(/font-family:[^;]+;/u, "font-family:ZhizhangFanqie;")
    .replace(/}$/, "unicode-range:U+E000-F8FF;}"))
  .join("\n");

const fanqieBooksFromSearchPayload = (payload: unknown): Array<Record<string, unknown>> => {
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const data = root.data && typeof root.data === "object" ? root.data as Record<string, unknown> : root;
  const books = Array.isArray(data.search_book_data_list) ? data.search_book_data_list : [];
  const seen = new Set<string>();
  return books.flatMap(item => {
    const book = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const sourceBookId = String(book.book_id || book.bookId || book.id || "").trim();
    const title = String(book.book_name || book.bookName || book.title || "").trim();
    if (!sourceBookId || !title || seen.has(sourceBookId)) return [];
    seen.add(sourceBookId);
    return [{
      id: `fanqie:${sourceBookId}`,
      sourceBookId,
      title,
      author: String(book.author || book.author_name || "未知作者"),
      source: "番茄小说",
      url: `https://fanqienovel.com/page/${sourceBookId}`,
      intro: String(book.abstract || book.introduction || book.description || "").replace(/\\n/gu, "\n").slice(0, 320),
      cover: String(book.thumb_url || book.thumbUri || book.cover || "") || undefined,
      category: String(book.category || book.category_v2 || "") || undefined,
      wordCount: Number(book.word_count || book.wordCount) || undefined,
    }];
  });
};

// The public search endpoint sometimes returns an empty body after an anti-bot
// challenge. Search-engine results provide a read-only discovery fallback while
// preserving the canonical Fanqie page URL used by the rest of the workflow.
const fanqieBooksFromBing = (html: string): Array<Record<string, unknown>> => {
  const results: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const pattern = /<li[^>]+class=["'][^"']*b_algo[^"']*["'][^>]*>[\s\S]*?<a[^>]+href=["']https?:\/\/fanqienovel\.com\/page\/(\d+)[^"']*["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<p[^>]*>([\s\S]*?)<\/p>)?/giu;
  for (const match of html.matchAll(pattern)) {
    const sourceBookId = match[1];
    if (seen.has(sourceBookId)) continue;
    seen.add(sourceBookId);
    const title = decodeWebText(match[2]).replace(/[？?].*$/u, "").trim().slice(0, 100);
    if (!title) continue;
    results.push({
      id: `fanqie:${sourceBookId}`,
      sourceBookId,
      title,
      author: "未知作者",
      source: "番茄小说",
      url: `https://fanqienovel.com/page/${sourceBookId}`,
      intro: decodeWebText(match[3] || "").slice(0, 320),
    });
    if (results.length >= 20) break;
  }
  return results;
};

const searchFanqieSource = async (query: string, params?: Record<string, unknown>): Promise<{ books: Array<Record<string, unknown>>; fontCss: string }> => {
  const pageUrl = `https://fanqienovel.com/search/${encodeURIComponent(query)}`;
  const pageHtml = await fetchWebText(pageUrl, params);
  const fontCss = fanqiePrivateFontCss(pageHtml);
  let books: Array<Record<string, unknown>> = [];
  try {
    const endpoint = `https://fanqienovel.com/api/author/search/search_book/v1?filter=127%2C127%2C127%2C127&page_count=10&page_index=0&query_type=0&query_word=${encodeURIComponent(query)}`;
    const response = await fetchWebText(endpoint, params);
    if (response.trim()) books = fanqieBooksFromSearchPayload(JSON.parse(response) as unknown);
  } catch { /* The source may issue a challenge; use the discovery fallbacks below. */ }
  if (!books.length) books = fanqieBookFromHtml(pageHtml, query);
  if (!books.length) {
    try {
      const bingQuery = encodeURIComponent(`site:fanqienovel.com/page/ ${query}`);
      books = fanqieBooksFromBing(await fetchWebText(`https://www.bing.com/search?q=${bingQuery}&setlang=zh-Hans`, params));
    } catch { /* Keep the successful Fanqie response as an empty result. */ }
  }
  return { books, fontCss };
};

type FanqieChapterLink = {
  id: string;
  title: string;
  url: string;
  locked: boolean;
};

const fanqieSessionCookies = new Map<string, string>();
const fanqieSessionKey = (params?: Record<string, unknown>): string => `${params?.proxyEnabled === true ? "proxy" : "direct"}:${typeof params?.proxyURL === "string" ? params.proxyURL.trim() : ""}`;
const createFanqieSessionCookie = (): string => {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1_000_000_000).toString().padStart(9, "0")}`.slice(-18);
  return `novel_web_id=7${suffix}`;
};
const getFanqieSessionCookie = (params?: Record<string, unknown>): string => {
  const key = fanqieSessionKey(params);
  const existing = fanqieSessionCookies.get(key);
  if (existing) return existing;
  const created = createFanqieSessionCookie();
  fanqieSessionCookies.set(key, created);
  return created;
};
const fanqieVerificationUntil = new Map<string, number>();

const isFanqieBlockedReaderPage = (html: string): boolean => {
  if (isFanqieVerificationPage(html)) return true;
  const title = html.match(/<title>\s*([^<]*)<\/title>/iu)?.[1] || "";
  return /小说,番茄小说网/u.test(title) && !/muye-reader-title/u.test(html);
};

const fetchFanqieReaderHtml = async (chapter: FanqieChapterLink, bookId: string, params?: Record<string, unknown>): Promise<string> => {
  const key = fanqieSessionKey(params);
  const blockedMessage = '番茄返回验证码页，已暂停该出口的正文请求一分钟；请在官方页面确认访问状态，或使用可用书源/本地 TXT';
  if ((fanqieVerificationUntil.get(key) || 0) > Date.now()) throw new Error(blockedMessage);
  const html = await fetchWebText(chapter.url, params, {
    retries: 1,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
      Referer: `https://fanqienovel.com/page/${bookId}`,
      Cookie: getFanqieSessionCookie(params),
    },
  });
  if (isFanqieBlockedReaderPage(html)) {
    fanqieVerificationUntil.set(key, Date.now() + 60_000);
    throw new Error(blockedMessage);
  }
  return html;
};

const fanqieChapterLinksFromPage = (html: string, maxChapters: number): FanqieChapterLink[] => {
  const $ = loadHtml(html);
  const chapterLinks: FanqieChapterLink[] = [];
  const seen = new Set<string>();
  $('.chapter-item').each((_index, element) => {
    if (chapterLinks.length >= maxChapters) return;
    const anchor = $(element).find('a[href*="/reader/"]').first();
    const href = anchor.attr('href') || "";
    const id = href.match(/\/reader\/(\d+)/u)?.[1];
    if (!id || seen.has(id)) return;
    seen.add(id);
    chapterLinks.push({
      id,
      title: anchor.text().trim().slice(0, 120) || `第${chapterLinks.length + 1}章`,
      url: `https://fanqienovel.com/reader/${id}`,
      locked: $(element).find('.chapter-item-lock').length > 0,
    });
  });
  return chapterLinks;
};

const fanqieExpectedWordCount = (html: string): number => {
  const $ = loadHtml(html);
  const match = $('.muye-reader-subtitle').text().replace(/\s/gu, "").match(/本章字数：(\d+)/u);
  return match ? Number(match[1]) : 0;
};

const concurrentMap = async <T, Result>(items: T[], concurrency: number, run: (item: T, index: number) => Promise<Result>): Promise<Result[]> => {
  const results = new Array<Result>(items.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await run(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => worker()));
  return results;
};

const downloadFanqieChapter = async (chapter: FanqieChapterLink, number: number, bookId: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const html = await fetchFanqieReaderHtml(chapter, bookId, params);
  const content = extractFanqieReaderContent(html);
  const expectedWords = fanqieExpectedWordCount(html);
  const complete = isCompleteChapterContent(content, expectedWords);
  return {
    id: `fanqie-chapter:${chapter.id}`,
    number,
    title: chapter.title,
    url: chapter.url,
    content,
    wordCount: content.length,
    expectedWords,
    downloaded: complete,
    ...(complete ? {} : { unavailableReason: chapter.locked ? "该章节仅返回可读片段" : "该章节未返回完整正文" }),
  };
};

const downloadFanqieBook = async (bookUrl: string, sourceBookId: string, params?: Record<string, unknown>, maxChapters = Number.MAX_SAFE_INTEGER): Promise<Array<Record<string, unknown>>> => {
  const bookId = sourceBookId || bookUrl.match(/\/page\/(\d+)/u)?.[1] || "";
  if (!bookId) throw new Error("无法识别番茄书籍 ID");
  const pageHtml = await fetchWebText(bookUrl, params);
  const chapterLinks = fanqieChapterLinksFromPage(pageHtml, Math.max(1, Math.floor(maxChapters)));
  if (!chapterLinks.length) throw new Error("未找到章节目录，书籍页面可能已变更");
  return concurrentMap(chapterLinks, 2, async (chapter, index) => {
    try {
      return await downloadFanqieChapter(chapter, index + 1, bookId, params);
    } catch (error) {
      return {
        id: `fanqie-chapter:${chapter.id}`,
        number: index + 1,
        title: chapter.title,
        url: chapter.url,
        content: "",
        wordCount: 0,
        downloaded: false,
        unavailableReason: error instanceof Error ? error.message : "章节下载失败",
      };
    }
  });
};

type BookSourceDefinition = {
  id: string;
  name: string;
  encoding?: string;
  search: { method: "GET" | "POST"; url: string; bodyTemplate?: string; contentType?: string };
  searchItemSelector: string;
  searchTitleSelector: string;
  searchAuthorSelector: string;
  directorySelector: string;
  contentSelector: string;
  directoryUrlTemplate?: string;
  filterPatterns?: string[];
};

// A compact, configuration-driven source adapter modeled after so-novel. Each
// source describes only request and DOM shape; search, catalog, and chapter
// extraction below use the same shared flow.
const webBookSources: BookSourceDefinition[] = [
  {
    id: "shuhaige", name: "书海阁", encoding: "utf-8",
    search: { method: "POST", url: "https://www.shuhaige.net/search.html", bodyTemplate: "searchkey=%q&searchtype=all", contentType: "application/x-www-form-urlencoded; charset=utf-8" },
    searchItemSelector: "#sitembox > dl", searchTitleSelector: "dd > h3 > a", searchAuthorSelector: "dd:nth-child(3) > span:first-child",
    directorySelector: "dl > dt:nth-of-type(2) ~ dd > a", contentSelector: "#content",
    filterPatterns: ["本小章还未完，请点击下一页继续阅读后面精彩内容！", "小主，这个章节后面还有哦，请点击下一页继续阅读，后面更精彩！", "这章没有结束，请点击下一页继续阅读！", "\\(本章完\\)"],
  },
  {
    id: "biquge365", name: "笔趣阁 365", encoding: "utf-8",
    search: { method: "POST", url: "https://www.biquge365.net/s.php", bodyTemplate: '{"type":"articlename","s":"%s"}', contentType: "application/json; charset=utf-8" },
    searchItemSelector: "body > div.menu > div > ul > li", searchTitleSelector: "span.name > a", searchAuthorSelector: "span.zuo > a",
    directorySelector: "body > div.menu > div.border > ul > li > a", contentSelector: "#txt",
    directoryUrlTemplate: "https://www.biquge365.net/newbook/%s/",
    filterPatterns: ["\\(本章完\\)"],
  },
  {
    id: "xbiquge", name: "新笔趣阁", encoding: "utf-8",
    search: { method: "GET", url: "https://www.xbiquge.la/search.php?q=%s" },
    searchItemSelector: "table tbody tr", searchTitleSelector: "td a", searchAuthorSelector: "td:nth-child(3)",
    directorySelector: "#list dd a", contentSelector: "#content",
    filterPatterns: ["\\(本章完\\)"],
  },
];

type QianyueRules = Record<string, unknown>;
type QianyueSource = {
  id: string;
  name: string;
  baseUrl: string;
  searchUrl: string;
  header?: string;
  encoding?: string;
  ruleSearch: QianyueRules;
  ruleBookInfo: QianyueRules;
  ruleToc: QianyueRules;
  ruleContent: QianyueRules;
};

const qianyueSources: QianyueSource[] = (qianyueSourceData as Array<Record<string, unknown>>).map((source, index) => ({
  id: source.bookSourceName === "酷我小说[api]" ? "qianyue-kuwo" : `qianyue-${index}`,
  name: String(source.bookSourceName || `千阅书源 ${index + 1}`),
  baseUrl: String(source.bookSourceUrl || "").split("##")[0].trim(),
  searchUrl: String(source.searchUrl || ""),
  header: typeof source.header === "string" ? source.header : undefined,
  encoding: typeof source.header === "string" && /gbk/iu.test(source.header) ? "gbk" : "utf-8",
  ruleSearch: source.ruleSearch && typeof source.ruleSearch === "object" ? source.ruleSearch as QianyueRules : {},
  ruleBookInfo: source.ruleBookInfo && typeof source.ruleBookInfo === "object" ? source.ruleBookInfo as QianyueRules : {},
  ruleToc: source.ruleToc && typeof source.ruleToc === "object" ? source.ruleToc as QianyueRules : {},
  ruleContent: source.ruleContent && typeof source.ruleContent === "object" ? source.ruleContent as QianyueRules : {},
}));

const parseQianyueHeaders = (raw?: string): Record<string, string> => {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw.replace(/'/gu, '"')) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    const headers: Record<string, string> = {};
    for (const match of raw.matchAll(/["']?([^"'{}:,]+)["']?\s*:\s*["']([^"']*)["']/gu)) headers[match[1].trim()] = match[2];
    return headers;
  }
};

const qianyuePathValues = (input: unknown, rawRule: unknown): unknown[] => {
  let rule = String(rawRule || "").trim().replace(/^@JSON:/iu, "").replace(/^@JSon:/iu, "");
  if (!rule || rule === "null") return [];
  rule = rule.split("##")[0].split("@js:")[0].trim();
  const alternatives = rule.split(/\|\||&&/u).map(value => value.trim()).filter(Boolean);
  for (const alternative of alternatives) {
    const normalized = alternative.replace(/^\$\.?/u, "").replace(/^\.\./u, "").replace(/\[\*\]/gu, ".*");
    if (!normalized) return [input];
    let values: unknown[] = [input];
    for (const segment of normalized.split(".").filter(Boolean)) {
      if (segment === "*") {
        values = values.flatMap(value => Array.isArray(value) ? value : value && typeof value === "object" ? Object.values(value as Record<string, unknown>) : []);
        continue;
      }
      const key = segment.replace(/\[.*$/u, "");
      values = values.flatMap(value => {
        if (Array.isArray(value)) return value.flatMap(item => item && typeof item === "object" ? [(item as Record<string, unknown>)[key]] : []);
        return value && typeof value === "object" ? [(value as Record<string, unknown>)[key]] : [];
      }).filter(value => value !== undefined && value !== null);
    }
    if (values.length) return values.flatMap(value => Array.isArray(value) ? value : [value]);
  }
  return [];
};

const applyQianyueReplacement = (value: unknown, rawRule: unknown): string => {
  let text = String(value ?? "").trim();
  const parts = String(rawRule || "").split("##");
  if (parts.length > 1 && parts[1]) {
    try { text = text.replace(new RegExp(parts[1], "gu"), parts[2] || ""); } catch { /* Keep the extracted value when a source regex is invalid. */ }
  }
  return text.trim();
};

const qianyueValue = (input: unknown, rule: unknown): string => applyQianyueReplacement(qianyuePathValues(input, rule)[0], rule);

const qianyueInterpolate = (template: string, item: unknown, variables: Record<string, string>): string => {
  let output = template
    .replace(/\{\{key\}\}/gu, encodeURIComponent(variables.key || ""))
    .replace(/\{\{page(?:-1)?\}\}/gu, match => match.includes("-1") ? "0" : variables.page || "1")
    .replace(/\{\{baseUrl\.replace\(['"]([^'"]*)['"],['"]([^'"]*)['"]\)\}\}/gu, (_match, from: string, to: string) => (variables.baseUrl || "").replace(from, to))
    .replace(/\{\{baseUrl\}\}/gu, variables.baseUrl || "");
  output = output.replace(/\{\{?\$\.([^}]+)\}\}?/gu, (_match, path: string) => qianyueValue(item, path));
  return output.trim();
};

const parseQianyueRequest = (raw: string, source: QianyueSource, item: unknown, variables: Record<string, string>): { url: string; method: "GET" | "POST"; body?: string; encoding: string; headers: Record<string, string> } => {
  const interpolated = qianyueInterpolate(raw, item, variables).replace(/^\{\{cookie[^}]+\}\}\s*/u, "").trim();
  if (/^(?:@js:|<js>)/iu.test(interpolated)) throw new Error("该书源使用脚本规则，当前版本暂不支持");
  const descriptorIndex = interpolated.search(/,\s*\{/u);
  const urlPart = descriptorIndex >= 0 ? interpolated.slice(0, descriptorIndex) : interpolated;
  const descriptorText = descriptorIndex >= 0 ? interpolated.slice(descriptorIndex + 1) : "";
  let descriptor: Record<string, unknown> = {};
  if (descriptorText) {
    try { descriptor = JSON.parse(descriptorText.replace(/'/gu, '"')) as Record<string, unknown>; } catch { descriptor = {}; }
  }
  const baseHeaders = parseQianyueHeaders(source.header);
  const extraHeaders = descriptor.headers && typeof descriptor.headers === "object" ? descriptor.headers as Record<string, string> : {};
  const charset = String(descriptor.charset || source.encoding || "utf-8");
  const body = typeof descriptor.body === "string" ? qianyueInterpolate(descriptor.body, item, variables) : undefined;
  const url = resolveBookUrl(variables.baseUrl || source.baseUrl, urlPart.replace(/\n/gu, "").trim());
  if (!url) throw new Error("书源地址规则无效");
  return { url, method: String(descriptor.method || (body ? "POST" : "GET")).toUpperCase() === "POST" ? "POST" : "GET", body, encoding: charset, headers: { ...baseHeaders, ...extraHeaders } };
};

const isExpiredBearerToken = (value: string): boolean => {
  const token = value.replace(/^Bearer\s+/iu, "").trim();
  const parts = token.split(".");
  if (parts.length < 2) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/gu, "+").replace(/_/gu, "/"), "base64").toString("utf8")) as Record<string, unknown>;
    const exp = Number(payload.exp);
    return Number.isFinite(exp) && exp > 0 && exp <= Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
};

const withoutExpiredAuthorization = (headers: Record<string, string>): Record<string, string> => Object.fromEntries(
  Object.entries(headers).filter(([key, value]) => key.toLowerCase() !== "authorization" || !isExpiredBearerToken(String(value))),
);

const fetchQianyueResource = async (request: ReturnType<typeof parseQianyueRequest>, params?: Record<string, unknown>): Promise<string> => {
  const headers = withoutExpiredAuthorization(request.headers);
  const execute = (requestHeaders: Record<string, string>) => fetchWebText(request.url, params, {
    method: request.method, body: request.body, encoding: request.encoding, retries: 2,
    headers: { ...(request.body ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' } : {}), ...requestHeaders },
  });
  try {
    return await execute(headers);
  } catch (error) {
    if (/HTTP (?:401|403)\b/u.test(String(error)) && Object.keys(headers).some(key => key.toLowerCase() === 'authorization')) {
      return execute(Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== 'authorization')));
    }
    throw error;
  }
};

const qianyueHtmlSelector = (rule: string): { selector: string; attribute: string } => {
  const normalized = rule.split("##")[0].replace(/^@css:/iu, "").replace(/^@(?=href$|text$|html$)/u, "");
  const segments = normalized.split("@");
  const attribute = ["text", "html", "href", "src", "content", "value", "textNodes"].includes(segments.at(-1) || "") ? segments.pop() || "text" : "text";
  const selector = segments.join(" ")
    .replace(/\bclass\.([\w-]+(?:\s+[\w-]+)*)/gu, (_match, names: string) => `.${names.trim().replace(/\s+/gu, ".")}`)
    .replace(/\bid\.([\w-]+)/gu, "#$1")
    .replace(/\btag\./gu, "")
    .replace(/\.(-?\d+)\b/gu, (_match, index: string) => `:eq(${index})`)
    .replace(/!(-?\d+(?::-?\d+)*)/gu, (_match, indexes: string) => indexes.split(':').map(index => `:not(:eq(${index}))`).join(''))
    .replace(/\btext\.([^@\s]+)/gu, (_match, text: string) => `${attribute === 'href' ? 'a' : '*'}:contains(${JSON.stringify(text)})`)
    .trim();
  return { selector, attribute };
};

const qianyueHtmlValues = (html: string, rule: unknown, context?: ReturnType<typeof loadHtml>, elements = false): string[] => {
  const $ = context || loadHtml(html, undefined, false);
  for (const alternative of String(rule || "").split("||")) {
    if (/^(?:@js:|<js>)/iu.test(alternative.trim())) continue;
    const { selector, attribute } = qianyueHtmlSelector(alternative.trim());
    if (!alternative.trim()) continue;
    const nodes = selector ? $(selector) : $.root().children();
    const values = nodes.toArray().map(element => {
      const node = $(element);
      if (elements) return $.html(element);
      const value = attribute === "html" ? node.html() || "" : attribute === "text" || attribute === "textNodes" ? node.text() : node.attr(attribute) || "";
      return applyQianyueReplacement(value, alternative);
    }).filter(Boolean);
    if (values.length) return values;
  }
  return [];
};

const parseMaybeJson = (text: string): unknown | null => {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try { return JSON.parse(trimmed) as unknown; } catch { return null; }
};

const qianyueRuleValues = (payload: string, rule: unknown): unknown[] => {
  const json = parseMaybeJson(payload);
  if (json !== null && !String(rule || "").includes("@html") && !String(rule || "").includes("@href")) return qianyuePathValues(json, rule);
  return qianyueHtmlValues(payload, rule, undefined, true);
};

const qianyueScalar = (payload: string, item: unknown, rule: unknown): string => {
  const json = parseMaybeJson(payload);
  return json !== null ? qianyueValue(item, rule) : qianyueHtmlValues(typeof item === "string" ? item : payload, rule)[0] || "";
};

const qianyueChapterUrl = (rule: string, item: unknown, tocUrl: string): string => {
  if (rule.includes("aesBase64DecodeToString")) {
    const pathRule = rule.split("@js:")[0];
    const encoded = qianyueValue(item, pathRule) || (item && typeof item === "object" ? String((item as Record<string, unknown>).path || "") : "");
    const args = rule.match(/aesBase64DecodeToString\(result,\s*["']([^"']+)["']\s*,\s*["'][^"']+["']\s*,\s*["']([^"']+)["']\s*\)/u);
    if (!encoded || !args) return "";
    try {
      const decipher = createDecipheriv("aes-128-cbc", Buffer.from(args[1], "utf8"), Buffer.from(args[2], "utf8"));
      return Buffer.concat([decipher.update(Buffer.from(encoded, "base64")), decipher.final()]).toString("utf8").trim();
    } catch {
      return "";
    }
  }
  const rawUrl = typeof item === 'string' && item.trim().startsWith('<')
    ? qianyueScalar(item, item, rule)
    : qianyueInterpolate(rule, item, { baseUrl: tocUrl, key: "", page: "1" });
  return rawUrl ? resolveBookUrl(tocUrl, rawUrl) : "";
};

const searchQianyueSource = async (source: QianyueSource, query: string, params?: Record<string, unknown>): Promise<Array<Record<string, unknown>>> => {
  const request = parseQianyueRequest(source.searchUrl, source, {}, { key: query, page: "1", baseUrl: source.baseUrl });
  const payload = await fetchQianyueResource(request, params);
  const items = qianyueRuleValues(payload, source.ruleSearch.bookList);
  const json = parseMaybeJson(payload);
  return items.slice(0, 30).map((item, index) => {
    const value = (rule: unknown) => qianyueScalar(payload, item, rule);
    const title = value(source.ruleSearch.name);
    const rawUrl = json !== null ? qianyueInterpolate(String(source.ruleSearch.bookUrl || ""), item, { key: query, page: "1", baseUrl: request.url }) : value(source.ruleSearch.bookUrl);
    const url = resolveBookUrl(request.url, rawUrl || value(source.ruleSearch.bookUrl));
    return {
      id: `${source.id}:${Buffer.from(url || `${title}-${index}`).toString("base64url")}`,
      sourceId: source.id,
      sourceBookId: url,
      source: source.name,
      title,
      author: value(source.ruleSearch.author) || "未知作者",
      intro: value(source.ruleSearch.intro).slice(0, 500),
      cover: resolveBookUrl(request.url, value(source.ruleSearch.coverUrl)) || undefined,
      category: value(source.ruleSearch.kind) || undefined,
      wordCount: Number(value(source.ruleSearch.wordCount).replace(/[^0-9]/gu, "")) || undefined,
      url,
    };
  }).filter(book => book.title && book.url);
};

type QianyueChapterLink = {
  number: number;
  title: string;
  url: string;
};

const qianyueChapterLinks = async (source: QianyueSource, bookUrl: string, params?: Record<string, unknown>, maxChapters = Number.MAX_SAFE_INTEGER): Promise<QianyueChapterLink[]> => {
  const infoRequest = parseQianyueRequest(bookUrl, source, {}, { key: "", page: "1", baseUrl: bookUrl });
  const infoPayload = await fetchQianyueResource(infoRequest, params);
  const infoJson = parseMaybeJson(infoPayload);
  const info = infoJson !== null && source.ruleBookInfo.init ? qianyuePathValues(infoJson, source.ruleBookInfo.init)[0] || infoJson : infoJson;
  const tocRule = String(source.ruleBookInfo.tocUrl || '').trim();
  const tocUrl = !tocRule ? infoRequest.url : infoJson !== null || /^(?:https?:|\/|\{\{)/u.test(tocRule)
    ? qianyueInterpolate(tocRule, info, { key: '', page: '1', baseUrl: infoRequest.url })
    : qianyueScalar(infoPayload, infoPayload, tocRule);
  if (!tocUrl) throw new Error('书源目录地址规则未返回链接，当前规则可能需要脚本支持');
  const firstRequest = parseQianyueRequest(tocUrl, source, info, { key: '', page: '1', baseUrl: infoRequest.url });
  const pending = [firstRequest.url];
  const visited = new Set<string>();
  const seen = new Set<string>();
  const chapters: QianyueChapterLink[] = [];
  while (pending.length && chapters.length < maxChapters) {
    const url = pending.shift()!;
    if (visited.has(url)) continue;
    if (visited.size >= 1000) throw new Error('目录分页超过 1000 页，请检查书源规则，未保存残缺目录');
    visited.add(url);
    const request = url === firstRequest.url ? firstRequest : parseQianyueRequest(url, source, {}, { key: '', page: '1', baseUrl: url });
    const payload = url === infoRequest.url ? infoPayload : await fetchQianyueResource(request, params);
    const items = qianyueRuleValues(payload, source.ruleToc.chapterList);
    if (!items.length) throw new Error(`书源目录第 ${visited.size} 页没有章节，未保存残缺目录`);
    for (const item of items) {
      const chapterUrl = qianyueChapterUrl(String(source.ruleToc.chapterUrl || ''), item, url);
      const title = qianyueScalar(payload, item, source.ruleToc.chapterName);
      if (!chapterUrl) throw new Error('书源章节链接解析失败，未保存残缺目录');
      if (seen.has(chapterUrl)) continue;
      seen.add(chapterUrl);
      chapters.push({ number: chapters.length + 1, title: title || `第 ${chapters.length + 1} 章`, url: chapterUrl });
      if (chapters.length >= maxChapters) break;
    }
    const nextRule = String(source.ruleToc.nextTocUrl || '').trim();
    if (nextRule) {
      if (/@js:|<js>/iu.test(nextRule)) throw new Error('目录分页规则需要脚本支持，当前无法确认完整目录');
      const values = parseMaybeJson(payload) !== null ? qianyuePathValues(parseMaybeJson(payload), nextRule).map(String) : qianyueHtmlValues(payload, nextRule);
      for (const value of values) {
        const next = resolveBookUrl(url, value);
        if (next && new URL(next).origin === new URL(firstRequest.url).origin && !visited.has(next) && !pending.includes(next)) pending.push(next);
      }
    }
  }
  return chapters;
};

const downloadQianyueSource = async (source: QianyueSource, bookUrl: string, params?: Record<string, unknown>, maxChapters = Number.MAX_SAFE_INTEGER): Promise<Array<Record<string, unknown>>> => {
  const links = await qianyueChapterLinks(source, bookUrl, params, maxChapters);
  return concurrentMap(links, 2, async (chapter, index) => {
    const entry = { ...chapter, id: `${source.id}:chapter:${Buffer.from(chapter.url || String(index)).toString('base64url')}` };
    try {
      return await downloadQianyueChapter(source, entry, params);
    } catch (error) {
      return { ...entry, content: '', wordCount: 0, downloaded: false, unavailableReason: error instanceof Error ? error.message : '章节下载失败' };
    }
  });
};

const resolveBookUrl = (baseUrl: string, value: string): string => {
  try { return new URL(value.trim(), baseUrl).toString(); } catch { return ""; }
};

const sourceSearchBody = (template: string, query: string): string => template
  .replace(/%q/gu, encodeURIComponent(query))
  .replace(/%s/gu, () => JSON.stringify(query).slice(1, -1));

const fetchBookSourceHtml = async (url: string, params: Record<string, unknown> | undefined, options: { method?: "GET" | "POST"; body?: string; contentType?: string; encoding?: string } = {}): Promise<string> => fetchWebText(url, params, {
  method: options.method, body: options.body, encoding: options.encoding, retries: 2,
  headers: {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    ...(options.body ? { 'Content-Type': options.contentType || 'application/json; charset=utf-8' } : {}),
  },
});

const cleanBookSourceContent = (content: string, patterns: string[] = []): string => {
  let cleaned = decodeWebText(content);
  for (const pattern of patterns) {
    try { cleaned = cleaned.replace(new RegExp(pattern, "gu"), ""); } catch { /* Ignore an invalid source rule. */ }
  }
  return cleaned.replace(/\n{3,}/gu, "\n\n").trim();
};

const searchConfiguredBookSource = async (source: BookSourceDefinition, query: string, params?: Record<string, unknown>): Promise<Array<Record<string, unknown>>> => {
  const searchUrl = source.search.url.replace(/%s/gu, encodeURIComponent(query));
  const html = await fetchBookSourceHtml(searchUrl, params, source.search.method === "POST" ? {
    method: "POST", body: sourceSearchBody(source.search.bodyTemplate || "{}", query), contentType: source.search.contentType, encoding: source.encoding,
  } : { encoding: source.encoding });
  const $ = loadHtml(html);
  const results: Array<Record<string, unknown>> = [];
  $(source.searchItemSelector).each((_index, element) => {
    const item = $(element);
    const titleNode = item.find(source.searchTitleSelector).first();
    const title = titleNode.text().trim();
    const url = resolveBookUrl(searchUrl, titleNode.attr("href") || "");
    if (!title || !url) return;
    results.push({
      id: `${source.id}:${Buffer.from(url).toString("base64url")}`,
      sourceId: source.id,
      sourceBookId: url,
      source: source.name,
      title,
      author: item.find(source.searchAuthorSelector).first().text().trim() || "未知作者",
      url,
      intro: "",
    });
  });
  return results.slice(0, 30);
};

type BookSearchTask = {
  sourceId: string;
  sourceName: string;
  run: () => Promise<{ books: Array<Record<string, unknown>>; fontCss?: string }>;
};

const isSearchableQianyueSource = (source: QianyueSource): boolean => {
  const searchUrl = source.searchUrl.trim();
  return Boolean(searchUrl) && !/^(?:@js:|<js>)/iu.test(searchUrl);
};

const searchResultScore = (query: string, book: Record<string, unknown>): number => {
  const normalize = (value: unknown): string => String(value || "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const needle = normalize(query);
  const title = normalize(book.title);
  const author = normalize(book.author);
  if (title === needle) return 1_000;
  if (title.includes(needle)) return 800 - Math.min(240, title.length - needle.length);
  if (needle.includes(title)) return 620 - Math.min(240, needle.length - title.length);
  if (author.includes(needle)) return 560;
  return 0;
};

const searchAllBookSources = async (query: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const tasks: BookSearchTask[] = [
    {
      sourceId: "fanqie",
      sourceName: "番茄小说",
      run: async () => searchFanqieSource(query, params),
    },
    ...qianyueSources.filter(isSearchableQianyueSource).map(source => ({
      sourceId: source.id,
      sourceName: source.name,
      run: async () => ({ books: await searchQianyueSource(source, query, params) }),
    })),
    ...webBookSources.map(source => ({
      sourceId: source.id,
      sourceName: source.name,
      run: async () => ({ books: await searchConfiguredBookSource(source, query, params) }),
    })),
  ];
  const responses = await concurrentMap(tasks, 12, async task => {
    try {
      const result = await task.run();
      return { ...task, ...result, succeeded: true };
    } catch {
      return { ...task, books: [] as Array<Record<string, unknown>>, succeeded: false };
    }
  });
  const seen = new Set<string>();
  const rankedBooks: Array<Record<string, unknown> & { id: string; sourceId: string; source: string; searchScore: number }> = responses.flatMap(response => response.books.map((book, index) => ({
    ...book,
    id: String(book.id || `${response.sourceId}:${index}`),
    sourceId: String(book.sourceId || response.sourceId),
    source: String(book.source || response.sourceName),
    searchScore: searchResultScore(query, book),
  }))) as Array<Record<string, unknown> & { id: string; sourceId: string; source: string; searchScore: number }>;
  const books = rankedBooks.filter(book => {
    if (seen.has(book.id)) return false;
    seen.add(book.id);
    const url = String(book.url || "");
    return Boolean(book.title && /^https?:\/\//iu.test(url) && !/[{}@]/u.test(url));
  }).sort((left, right) => Number(right.searchScore) - Number(left.searchScore)).slice(0, 150).map(({ searchScore: _searchScore, ...book }) => book);
  return {
    books,
    fontCss: responses.find(response => response.fontCss)?.fontCss || "",
    searchedSourceCount: tasks.length,
    responsiveSourceCount: responses.filter(response => response.succeeded).length,
    failedSourceCount: responses.filter(response => !response.succeeded).length,
  };
};

const downloadConfiguredBookSource = async (source: BookSourceDefinition, bookUrl: string, params?: Record<string, unknown>, maxChapters = Number.MAX_SAFE_INTEGER): Promise<Array<Record<string, unknown>>> => {
  let directoryUrl = bookUrl;
  if (source.directoryUrlTemplate) {
    const match = new URL(bookUrl).pathname.match(/\/([^/]+)\/?$/u);
    const bookId = match?.[1]?.replace(/\.html?$/iu, "") || "";
    if (bookId) directoryUrl = source.directoryUrlTemplate.replace(/%s/gu, bookId);
  }
  const links: Array<{ title: string; url: string }> = [];
  const seen = new Set<string>();
  const visited = new Set<string>();
  let pageUrl: string | undefined = directoryUrl;
  while (pageUrl && links.length < maxChapters) {
    if (visited.has(pageUrl) || visited.size >= 1000) throw new Error('目录分页循环或超过 1000 页，未保存残缺目录');
    visited.add(pageUrl);
    const html = await fetchBookSourceHtml(pageUrl, params, { encoding: source.encoding });
    const $ = loadHtml(html);
    const items = $(source.directorySelector).toArray();
    if (!items.length) throw new Error(`书源目录第 ${visited.size} 页为空，未保存残缺目录`);
    for (const element of items) {
      const anchor = $(element);
      const title = anchor.text().trim();
      const href = anchor.attr('href');
      const url = href ? resolveBookUrl(pageUrl, href) : '';
      if (!title || !url || seen.has(url)) continue;
      seen.add(url);
      links.push({ title, url });
    }
    pageUrl = nextContentPage(html, 'text.下一页@href||text.下页@href', pageUrl);
  }
  const targets = links.slice(0, Math.max(1, Math.floor(maxChapters)));
  if (!targets.length) throw new Error("书源没有返回章节目录");
  const chapters: Array<Record<string, unknown>> = [];
  for (let index = 0; index < targets.length; index += 1) {
    const chapter = targets[index];
    const entry = { ...chapter, id: `${source.id}:chapter:${Buffer.from(chapter.url).toString('base64url')}`, number: index + 1 };
    try {
      chapters.push(await downloadConfiguredBookChapter(source, entry, params));
    } catch (error) {
      chapters.push({ ...entry, content: '', wordCount: 0, downloaded: false, unavailableReason: error instanceof Error ? error.message : '章节下载失败' });
    }
  }
  return chapters;
};

// 只跟进明确的章内分页，绝不把“下一章”拼进当前章节
const nextContentPage = (html: string, rule: string, currentUrl: string): string | undefined => {
  if (!rule) return undefined;
  if (/@js:|<js>/iu.test(rule)) throw new Error('正文分页规则需要脚本支持，当前无法确认本章完整性');
  const $ = loadHtml(html);
  const values = qianyueHtmlValues(html, rule);
  for (const value of values) {
    const url = resolveBookUrl(currentUrl, value);
    if (!url || url === currentUrl || new URL(url).origin !== new URL(currentUrl).origin) continue;
    const label = $('a').filter((_index, element) => resolveBookUrl(currentUrl, $(element).attr('href') || '') === url).first().text().trim();
    if (/下一章|下章|上一章|目录/u.test(label)) continue;
    if (/下一页|下页|下一頁/u.test(label)) return url;
  }
  return undefined;
};

const checkedChapterContent = (content: string, chapter: Record<string, unknown>): Record<string, unknown> => {
  if (!content) throw new Error('书源没有返回本章正文');
  const complete = isCompleteChapterContent(content, Number(chapter.expectedWords) || 0);
  return { ...chapter, content, wordCount: content.replace(/\s/gu, '').length, downloaded: complete,
    unavailableReason: complete ? undefined : '正文过短，疑似预览或不完整内容，请核对后重试' };
};

const downloadQianyueChapter = async (source: QianyueSource, chapter: Record<string, unknown>, params?: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const chapterUrl = String(chapter.url || "").trim();
  if (!chapterUrl) throw new Error("该章节缺少可下载地址");
  const parts: string[] = [];
  const visited = new Set<string>();
  let url: string | undefined = chapterUrl;
  while (url) {
    if (visited.has(url) || visited.size >= 100) throw new Error('正文分页循环或超过 100 页，未将片段标记为完整');
    visited.add(url);
    const request = parseQianyueRequest(url, source, {}, { key: '', page: '1', baseUrl: url });
    const payload = await fetchQianyueResource(request, params);
    const json = parseMaybeJson(payload);
    // 一条正文规则可能命中多个段落，必须全部保留
    const raw = json !== null ? qianyueValue(json, source.ruleContent.content) : qianyueHtmlValues(payload, source.ruleContent.content).join('\n');
    const content = cleanBookSourceContent(raw, []);
    if (!content) throw new Error(`书源正文第 ${visited.size} 页为空，未将片段标记为完整`);
    parts.push(content);
    const next: string | undefined = json === null ? nextContentPage(payload, String(source.ruleContent.nextContentUrl || ''), url) : undefined;
    if (!next && /本章未完.*(?:下一页|下页)|点击下一页继续/u.test(content)) throw new Error('本章还有分页，但书源未提供可用的下一页链接');
    url = next;
  }
  return checkedChapterContent(parts.join('\n\n'), chapter);
};

const normalizedBookMatchText = (value: unknown): string => String(value || "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const isCompleteChapterContent = (content: string, expectedWords = 0): boolean => {
  const characters = content.replace(/\s/gu, "").length;
  return characters >= Math.max(500, expectedWords > 0 ? Math.floor(expectedWords * 0.65) : 0);
};

// Fanqie can intentionally return a short web preview for a chapter. The
// configured sources are queried by exact book title, then the matching chapter
// title is fetched. A replacement is only accepted once it passes the same
// completeness threshold as a native Fanqie response.
const downloadFallbackChapter = async (title: string, chapterNumber: number, chapterTitle: string, expectedWords: number, params?: Record<string, unknown>): Promise<Record<string, unknown> | undefined> => {
  const normalizedTitle = normalizedBookMatchText(title);
  const normalizedChapterTitle = normalizedBookMatchText(chapterTitle);
  const preferredSources = [
    qianyueSources.find(source => source.id === "qianyue-4"),
    qianyueSources.find(source => source.id === "qianyue-0"),
    qianyueSources.find(source => source.id === "qianyue-kuwo"),
  ].filter((source): source is QianyueSource => Boolean(source));

  for (const source of preferredSources) {
    try {
      const candidates = await searchQianyueSource(source, title, params);
      const candidate = candidates.find(item => normalizedBookMatchText(item.title) === normalizedTitle);
      if (!candidate?.url) continue;
      const links = await qianyueChapterLinks(source, String(candidate.url), params, Math.max(chapterNumber + 2, 50));
      const link = links.find(item => normalizedBookMatchText(item.title) === normalizedChapterTitle);
      if (!link?.url) continue;
      const downloaded = await downloadQianyueChapter(source, { number: chapterNumber, title: chapterTitle, url: link.url }, params);
      const content = String(downloaded.content || "");
      if (!isCompleteChapterContent(content, expectedWords)) continue;
      return { ...downloaded, sourceId: source.id, sourceName: source.name, fallbackSourceName: source.name };
    } catch {
      // A configured source can expire independently. Continue to the next one.
    }
  }
  return undefined;
};

const downloadConfiguredBookChapter = async (source: BookSourceDefinition, chapter: Record<string, unknown>, params?: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const chapterUrl = String(chapter.url || "").trim();
  if (!chapterUrl) throw new Error("该章节缺少可下载地址");
  const parts: string[] = [];
  const visited = new Set<string>();
  let url: string | undefined = chapterUrl;
  while (url) {
    if (visited.has(url) || visited.size >= 100) throw new Error('正文分页循环或超过 100 页，未将片段标记为完整');
    visited.add(url);
    const html = await fetchBookSourceHtml(url, params, { encoding: source.encoding });
    const $ = loadHtml(html);
    const raw = $(source.contentSelector).toArray().map(element => $(element).html() || '').join('\n');
    const content = cleanBookSourceContent(raw, source.filterPatterns);
    if (!content) throw new Error(`书源正文第 ${visited.size} 页为空，未将片段标记为完整`);
    parts.push(content);
    const next: string | undefined = nextContentPage(html, 'text.下一页@href||text.下页@href', url);
    if (!next && /本章未完.*(?:下一页|下页)|点击下一页继续/u.test(decodeWebText(raw))) throw new Error('本章还有分页，但书源未提供可用的下一页链接');
    url = next;
  }
  return checkedChapterContent(parts.join('\n\n'), chapter);
};

const parseChineseNumber = (value: string): number | undefined => {
  const match = value.replace(/,/gu, "").match(/([\d.]+)\s*(万|亿)?/u);
  if (!match) return undefined;
  const multiplier = match[2] === "亿" ? 100_000_000 : match[2] === "万" ? 10_000 : 1;
  const number = Number(match[1]) * multiplier;
  return Number.isFinite(number) ? Math.round(number) : undefined;
};

const fanqieRankingSections = [
  { key: 'male-read', label: '男频阅读', gender: 'male', list: 'read', prefix: '1_2_' },
  { key: 'male-new', label: '男频新书', gender: 'male', list: 'new', prefix: '1_1_' },
  { key: 'female-read', label: '女频阅读', gender: 'female', list: 'read', prefix: '0_2_' },
  { key: 'female-new', label: '女频新书', gender: 'female', list: 'new', prefix: '0_1_' },
] as const;

// 分类加载和榜单刷新复用一分钟内的页面，并合并尚未完成的同页请求
const rankingPages = new Map<string, { pending: Promise<string>; expiresAt: number }>();
const fetchRankingPage = (url: string, params?: Record<string, unknown>): Promise<string> => {
  const key = `${fanqieSessionKey(params)}|${url}`;
  const cached = rankingPages.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.pending;
  const entry = { pending: fetchWebText(url, params, { headers: {
    Referer: `${new URL(url).origin}/rank/`,
    // 起点移动站需要移动端标识，桌面标识会被导向另一套页面
    ...(new URL(url).hostname === 'm.qidian.com' ? { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36' } : {}),
  } }), expiresAt: Infinity };
  rankingPages.set(key, entry);
  entry.pending = entry.pending.then(html => {
    entry.expiresAt = Date.now() + 60_000;
    return html;
  }, error => {
    rankingPages.delete(key);
    throw error;
  });
  return entry.pending;
};

const fetchFanqieRankingCategories = async (params?: Record<string, unknown>) => {
  const $ = loadHtml(await fetchRankingPage('https://fanqienovel.com/rank', params));
  const sections = fanqieRankingSections.map(section => {
    const seen = new Set<string>();
    const categories = $(`a[href^="/rank/${section.prefix}"]`).toArray().flatMap(element => {
      const href = $(element).attr('href') || '';
      const id = href.match(/^\/rank\/[01]_[12]_(\d+)$/u)?.[1];
      const label = $(element).text().trim();
      if (!id || !label || seen.has(id)) return [];
      seen.add(id);
      return [{ id, label, url: `https://fanqienovel.com${href}`, gender: section.gender, list: section.list }];
    });
    return { key: section.key, label: section.label, categories };
  });
  if (sections.some(section => !section.categories.length)) throw new Error('番茄官网未返回完整的榜单分类，请稍后重试');
  return sections;
};

const fetchFanqieRanking = async (rankType: string, gender: string, rankUrl: string | undefined, params?: Record<string, unknown>): Promise<Array<Record<string, unknown>>> => {
  // 默认总榜汇总各分类首页的样本，不冒充官网独立总榜；任一分类失败就保留前端旧数据
  if (!rankUrl) {
    const sections = await fetchFanqieRankingCategories(params);
    const section = sections.find(item => item.key === `${gender === 'female' ? 'female' : 'male'}-${rankType === 'new' ? 'new' : 'read'}`)!;
    const books = new Map<string, Record<string, unknown>>();
    for (const category of section.categories) {
      const rows = await fetchFanqieRanking(rankType, gender, category.url, params);
      for (const row of rows) {
        const id = String(row.id);
        const existing = books.get(id);
        if (!existing || Number(row.readCount) > Number(existing.readCount)) books.set(id, { ...row, category: category.label });
      }
    }
    return [...books.values()].sort((a, b) => Number(b.readCount) - Number(a.readCount) || String(a.id).localeCompare(String(b.id)))
      .slice(0, 60).map((book, index) => ({ ...book, rank: index + 1 }));
  }
  const prefix = `${gender === 'female' ? 0 : 1}_${rankType === 'new' ? 1 : 2}_`;
  // 指定分类时必须匹配当前频道与榜型，不接受外部网址
  if (!new RegExp(`^https://fanqienovel\\.com/rank/${prefix}\\d+$`, 'u').test(rankUrl)) {
    throw new Error('请先选择番茄官网的题材分类，再刷新榜单');
  }
  const $ = loadHtml(await fetchRankingPage(rankUrl, params));
  // SSR 的图片是占位图，真实封面和字数来自同页 JSON；只解析数据，不执行网页脚本
  const script = $('script').toArray().map(element => $(element).text()).find(text => text.includes('window.__INITIAL_STATE__='));
  const serialized = script?.match(/window\.__INITIAL_STATE__=(\{[\s\S]*\});\s*\}/u)?.[1];
  let metadata: Array<Record<string, unknown>> = [];
  if (serialized) {
    try {
      const state = JSON.parse(serialized);
      if (Array.isArray(state?.rank?.book_list)) metadata = state.rank.book_list.filter((item: unknown) => item && typeof item === 'object');
    } catch { /* 页面数据格式变化时仍保留可读榜单，不采用占位封面 */ }
  }
  const rows = $('.rank-book-item').toArray().flatMap(element => {
    const item = $(element);
    const link = item.find('.title a[href^="/page/"]').first();
    const id = link.attr('href')?.match(/^\/page\/(\d+)$/u)?.[1];
    const title = decodeFanqieContent(link.text().trim());
    if (!id || !title) return [];
    const data = metadata.find(book => String(book.bookId) === id);
    return [{
      id: `fanqie:${id}`, sourceBookId: id, title,
      author: decodeFanqieContent(item.find('.author').text().trim()),
      intro: decodeFanqieContent(item.find('.abstract').text().trim()),
      cover: typeof data?.thumbUri === 'string' ? resolveBookUrl(rankUrl, data.thumbUri) : undefined,
      wordCount: Number(data?.wordNumber) || undefined,
      rank: Number(item.find('.book-item-index h1').text()) || 0,
      readCount: data?.read_count != null && Number.isFinite(Number(data.read_count)) ? Number(data.read_count) : parseChineseNumber(item.find('.book-item-count').text().replace(/^在读[：:]/u, '').trim()),
      rankType, gender, platform: 'fanqie', url: `https://fanqienovel.com/page/${id}`,
    }];
  });
  if (!rows.length) throw new Error('番茄官网未返回榜单书籍，页面可能需要验证或结构已变化');
  return rows;
};

const fetchQidianRanking = async (rankType: string, gender: string, params?: Record<string, unknown>): Promise<Array<Record<string, unknown>>> => {
  const basePath = rankType === "new" ? "sign" : rankType === "read" ? "readindex" : "yuepiao";
  // 起点榜单统一使用官网默认榜单，不再区分男频/女频频道。
  const pageUrl = `https://m.qidian.com/rank/${basePath}/`;
  const parseRankingPage = (html: string) => {
    const $ = loadHtml(html);
    const mobileBooks = $('.y-list__item').toArray().flatMap(element => {
      const item = $(element);
      const link = item.find('a[href*="/book/"]').first();
      const id = link.attr('href')?.match(/\/book\/(\d+)/u)?.[1];
      const titleNode = link.find('h2');
      const title = titleNode.text().trim();
      if (!id || !title) return [];
      const metadata = link.find('p[class*="_subTitle_"]').text().split('·').map(value => value.trim());
      return [{
        id: `qidian:${id}`, sourceBookId: id, title, author: metadata[0] || '未知作者',
        category: metadata[1] || undefined, wordCount: parseChineseNumber(metadata[2] || ''),
        intro: link.find('p[class*="_bookDesc_"]').text().trim(),
        cover: resolveBookUrl(pageUrl, link.find('img').attr('data-src') || link.find('img').attr('src') || '') || undefined,
        rank: Number(titleNode.attr('title')?.match(/第(\d+)位/u)?.[1]) || Number(item.attr('data-index')) + 1,
        rankType, gender: 'all', platform: 'qidian', url: `https://www.qidian.com/book/${id}/`,
      }];
    });
    if (mobileBooks.length) return mobileBooks;
    // 页面顶部也可能带 data-rid 的导航项；先筛出真实书籍行再截取，避免
    // 前置无关元素占满 slice 后造成“返回 0 本书”。
    const rankRows = $('[data-rid], li.rank-list-item, .rank-list .book-mid-info').toArray().filter(element => {
      const titleNode = $(element).find('.book-mid-info h2 a').first();
      return Boolean((titleNode.text().trim() && titleNode.attr('href')) || $(element).is('.book-mid-info'));
    }).slice(0, 60);
    const parsed = rankRows.map((element, index) => {
      const item = $(element);
      const scope = item.is('.book-mid-info') ? item : item;
      const titleNode = scope.find('.book-mid-info h2 a, h2 a, a[href*="/book/"]').filter((_i, node) => Boolean($(node).text().trim())).first();
      const href = resolveBookUrl(pageUrl, titleNode.attr('href') || '');
      const bookId = titleNode.attr('data-bid') || href.match(/\/book\/(\d+)/u)?.[1] || String(index);
      const categories = item.find('.book-mid-info .author a').toArray().slice(1).map(node => $(node).text().trim()).filter(Boolean);
      return {
        id: `qidian:${bookId}`, sourceBookId: bookId, title: titleNode.text().trim(),
        author: item.find('.book-mid-info .author a.name').first().text().trim() || '未知作者',
        intro: scope.find('.book-mid-info .intro, .intro, [class*="intro"]').first().text().trim(), cover: resolveBookUrl(pageUrl, scope.find('.book-img-box img, img').first().attr('src') || '') || undefined,
        category: categories.join(' · ') || undefined, rank: Number(item.attr('data-rid')) || index + 1,
        rankType, gender: 'all', platform: 'qidian', url: href,
      };
    }).filter(book => book.title && book.url);
    if (parsed.length) return parsed;
    // Fallback for markup changes: locate every canonical /book/<id> link and
    // walk to its nearest card for author, intro and cover metadata.
    const seen = new Set<string>();
    return $('a[href*="/book/"]').toArray().flatMap((node, index) => {
      const link = $(node);
      const href = resolveBookUrl(pageUrl, link.attr('href') || '');
      const id = href.match(/\/book\/(\d+)/u)?.[1] || '';
      const title = link.text().replace(/\s+/gu, ' ').trim();
      if (!id || !title || seen.has(id)) return [];
      seen.add(id);
      let card = link;
      for (let depth = 0; depth < 5 && card.length; depth += 1) {
        const text = card.text().trim();
        if (text.length > title.length + 10) break;
        card = card.parent();
      }
      return [{ id: `qidian:${id}`, sourceBookId: id, title, author: card.find('.author a.name, .author a').first().text().trim() || '未知作者', intro: card.find('.intro, [class*="intro"]').first().text().trim(), cover: resolveBookUrl(pageUrl, card.find('img').first().attr('src') || '') || undefined, category: undefined, rank: index + 1, rankType, gender: 'all', platform: 'qidian', url: href }];
    }).slice(0, 60);
  };
  const html = await fetchRankingPage(pageUrl, params);
  const books = parseRankingPage(html);
  if (!books.length) {
    if (/C2WF946J0\/probe\.js|var\s+buid\s*=|<title>[^<]*(?:验证|校验)/iu.test(html)) throw new Error(`起点中文网${basePath}返回了校验页，请在浏览器中打开官方榜单确认访问状态`);
    throw new Error(`起点中文网${basePath}未找到书籍条目，官网结构可能已变化`);
  }
  return books;
};

const fetchFalooRanking = async (rankType: string, gender: string, params?: Record<string, unknown>): Promise<Array<Record<string, unknown>>> => {
  const pageUrl = "https://b.faloo.com/SR_1.html";
  const request = { url: pageUrl, method: "GET" as const, encoding: "gbk", headers: {} };
  const html = await fetchQianyueResource(request, params);
  const $ = loadHtml(html);
  const books = $('.c_td_d_data').toArray().slice(0, 60).map((element, index) => {
    const item = $(element);
    const titleNode = item.find('.c_td_d_d_title a').first();
    const href = resolveBookUrl(pageUrl, titleNode.attr('href') || '');
    const bookId = href.match(/\/(\d+)\.html/u)?.[1] || String(index);
    const metadata = item.find('.c_td_d_d_count').first().text().replace(/\s+/gu, ' ').trim();
    return {
      id: `faloo:${bookId}`, sourceBookId: bookId, title: titleNode.text().trim(),
      author: item.find('.c_td_d_d_author').first().text().trim() || '未知作者',
      intro: '', cover: (resolveBookUrl(pageUrl, item.find('.c_td_d_d_img img').attr('src') || '') || '').replace(/^http:/iu, 'https:') || undefined,
      category: item.find('.c_td_d_d_class').first().text().trim() || undefined,
      rank: Number(item.find('[class^="c_td_d_d_number"]').first().text().trim()) || index + 1,
      rankType: 'read', gender: 'all', platform: 'faloo', url: href,
      readCount: parseChineseNumber(metadata),
    };
  }).filter(book => book.title && book.url);
  if (!books.length) throw new Error('飞卢24小时畅销榜没有返回可用书籍，请稍后刷新');
  return books;
};

export {
  qianyueSources, webBookSources, searchQianyueSource, searchConfiguredBookSource, searchFanqieSource,
  searchAllBookSources, fetchFanqieRankingCategories, fetchQidianRanking, fetchFalooRanking,
  fetchFanqieRanking, downloadFanqieChapter, downloadFallbackChapter, downloadQianyueChapter,
  downloadConfiguredBookChapter, downloadQianyueSource, downloadConfiguredBookSource, downloadFanqieBook,
};
