import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const page = `
<a href="/rank/1_2_1141">西方奇幻</a><a href="/rank/1_1_1141">西方奇幻</a>
<a href="/rank/0_2_1139">古风世情</a><a href="/rank/0_1_1139">古风世情</a>
<div class="rank-book-item"><div class="book-item-index"><h1>01</h1></div>
<img class="book-cover-img" src="//example.com/cover.jpg">
<div class="title"><a href="/page/123">测试书籍</a></div><div class="author">作者</div>
<div class="abstract">简介</div><span class="book-item-count">在读：22.5万</span></div>
<script>(function(){window.__INITIAL_STATE__={"rank":{"book_list":[{"bookId":"123","thumbUri":"https://example.com/cover.jpg","wordNumber":"100000"}]}};})()</script>`;
const maleUrl = "https://fanqienovel.com/rank/1_2_1141";
const femaleUrl = "https://fanqienovel.com/rank/0_2_1139";

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-08T08:00:00Z"));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("榜单限流与官方来源", () => {
  it.each(["60", "Thu, 08 Oct 2026 08:01:00 GMT", "invalid", null])("尊重 Retry-After %s，分类失败后榜单也暂停，冷却后可恢复", async retryAfter => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("limited", { status: 429, headers: retryAfter ? { "Retry-After": retryAfter } : {} }))
      .mockImplementation(async () => new Response(page));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchFanqieRankingCategories, fetchFanqieRanking } = await import("../src/sources/library-service.js");
    await expect(fetchFanqieRankingCategories()).rejects.toThrow("fanqienovel.com 请求受限（HTTP 429），请在 60 秒后重试");
    await expect(fetchFanqieRanking("read", "female", femaleUrl)).rejects.toThrow("60 秒后重试");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000);
    await expect(fetchFanqieRanking("read", "male", maleUrl)).rejects.toThrow("30 秒后重试");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000);
    expect(await fetchFanqieRankingCategories()).toHaveLength(4);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("一次读取四组官方分类，合并同页请求并在缓存过期后重新获取", async () => {
    const fetchMock = vi.fn(async () => new Response(page));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchFanqieRankingCategories, fetchFanqieRanking } = await import("../src/sources/library-service.js");
    const [first, second] = await Promise.all([fetchFanqieRankingCategories(), fetchFanqieRankingCategories()]);
    expect(first).toEqual(second);
    expect(first.map(section => section.categories[0].url)).toEqual([maleUrl, maleUrl.replace("1_2", "1_1"), femaleUrl, femaleUrl.replace("0_2", "0_1")]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [books] = await Promise.all([fetchFanqieRanking("read", "male", maleUrl), fetchFanqieRanking("read", "male", maleUrl)]);
    expect(books[0]).toMatchObject({ title: "测试书籍", author: "作者", rank: 1, readCount: 225000, url: "https://fanqienovel.com/page/123", cover: "https://example.com/cover.jpg" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(60_000);
    await fetchFanqieRanking("read", "male", maleUrl);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("默认总榜汇总当前频道分类首页，按在读排序并去重", async () => {
    const categories = page + '<a href="/rank/1_2_1140">东方仙侠</a><a href="/rank/1_2_8">科幻末世</a>';
    const fetchMock = vi.fn(async (url: string) => new Response(
      url.endsWith('/rank') ? categories : url.endsWith('_1140') ? page.replaceAll('123', '456').replace('22.5万', '30万') : page
    ));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchFanqieRanking } = await import("../src/sources/library-service.js");
    const books = await fetchFanqieRanking("read", "male", undefined);
    expect(books.map(book => ({ id: book.id, rank: book.rank, readCount: book.readCount }))).toEqual([
      { id: 'fanqie:456', rank: 1, readCount: 300000 },
      { id: 'fanqie:123', rank: 2, readCount: 225000 },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.every(([url]) => !url.includes('/rank/0_') && !url.includes('/rank/1_1_'))).toBe(true);
    await fetchFanqieRanking("read", "male", undefined);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("汇总中遇到限流不返回残缺榜单", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(page)).mockResolvedValueOnce(new Response('limited', { status: 429, headers: { 'Retry-After': '60' } }));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchFanqieRanking } = await import("../src/sources/library-service.js");
    await expect(fetchFanqieRanking("read", "male", undefined)).rejects.toThrow('60 秒后重试');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("拒绝频道错配或外部 URL", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { fetchFanqieRanking } = await import("../src/sources/library-service.js");
    for (const url of [femaleUrl, "https://novelcatch.com/rank?category=all", "https://fanqienovelXcom/rank/1_2_1141"]) {
      await expect(fetchFanqieRanking("read", "male", url)).rejects.toThrow("请先选择");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("普通临时错误仍保留已有重试", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("connection reset")).mockImplementation(async () => new Response(page));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchFanqieRanking } = await import("../src/sources/library-service.js");
    const result = fetchFanqieRanking("read", "male", maleUrl);
    await vi.runAllTimersAsync();
    expect((await result)[0].title).toBe("测试书籍");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([["vote", "yuepiao"], ["read", "readindex"], ["new", "sign"]])("起点 %s 使用官方移动页面，保留书名、排名和真实封面", async (type, path) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`<div class="y-list__item" data-index="0"><a href="//m.qidian.com/book/123/"><img src="placeholder.png" data-src="//bookcover.yuewen.com/123/180"><h2 title="月票榜第1位">测试书</h2><p class="_bookDesc_x">简介</p><p class="_subTitle_x">作者 · 玄幻 · 10万字</p></a></div><script src="yw_risk_verify.js"></script>`)));
    const { fetchQidianRanking } = await import("../src/sources/library-service.js");
    expect((await fetchQidianRanking(type, "all"))[0]).toMatchObject({ title: "测试书", author: "作者", rank: 1, wordCount: 100000, cover: "https://bookcover.yuewen.com/123/180", url: "https://www.qidian.com/book/123/" });
    expect(fetch).toHaveBeenCalledWith(`https://m.qidian.com/rank/${path}/`, expect.anything());
  });

  it("起点校验页明确报错，不重复探测或绕开用户代理", async () => {
    const fetchMock = vi.fn(async () => new Response('<script src="/C2WF946J0/probe.js"></script>'));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchQidianRanking } = await import("../src/sources/library-service.js");
    await expect(fetchQidianRanking("vote", "all", { proxyEnabled: true, proxyURL: "http://127.0.0.1:1234" })).rejects.toThrow("返回了校验页");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
