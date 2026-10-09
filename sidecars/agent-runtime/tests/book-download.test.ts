import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadQianyueSource, downloadQianyueChapter, downloadConfiguredBookChapter, downloadFanqieChapter, searchQianyueSource, webBookSources } from '../src/sources/library-service.js';

const source = {
  id: 'fixture', name: '测试书源', baseUrl: 'https://books.test', searchUrl: '/search',
  ruleSearch: { bookList: '.book', name: 'a@text', bookUrl: 'a@href', author: '.author@text' },
  ruleBookInfo: { tocUrl: 'text.目录@href' },
  ruleToc: { chapterList: '.chapters a', chapterName: 'text', chapterUrl: 'href', nextTocUrl: 'option@value' },
  ruleContent: { content: '#content p@text', nextContentUrl: 'text.下一页@href' },
};
const paragraph = '这是完整测试正文。'.repeat(70);
const mockPages = (pages: Record<string, string | number>) => {
  const mock = vi.fn(async (url: string | URL | Request) => {
    const key = String(url);
    const page = pages[key];
    if (page === undefined) throw new Error(`未预期的请求 ${key}`);
    return typeof page === 'number' ? new Response('error', { status: page }) : new Response(page);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
};
afterEach(() => vi.unstubAllGlobals());

describe('下载目录与正文完整性', () => {
  it('HTML 搜索逐项匹配标题、作者和链接，不串书', async () => {
    mockPages({ 'https://books.test/search': '<div class="book"><a href="/a">甲书</a><span class="author">甲作者</span></div><div class="book"><a href="/b">乙书</a><span class="author">乙作者</span></div>' });
    const books = await searchQianyueSource(source, '书');
    expect(books.map(book => [book.title, book.author, book.url])).toEqual([['甲书', '甲作者', 'https://books.test/a'], ['乙书', '乙作者', 'https://books.test/b']]);
  });

  it('翻完目录、保留标题链接、去重，并记录单章失败而不丢目录', async () => {
    const fetchMock = mockPages({
      'https://books.test/book': '<a href="/toc1">章节目录</a>',
      'https://books.test/toc1': '<div class="chapters"><a href="/c1">第一章 起点</a></div><select><option value="/toc1">1</option><option value="/toc2">2</option></select>',
      'https://books.test/toc2': '<div class="chapters"><a href="/c1">第一章 起点</a><a href="/c2">第二章 风雨</a></div><select><option value="/toc1">1</option><option value="/toc2">2</option></select>',
      'https://books.test/c1': `<div id="content"><p>${paragraph}</p><p>第二段不能丢失</p></div>`,
      'https://books.test/c2': 404,
    });
    const chapters = await downloadQianyueSource(source, 'https://books.test/book');
    expect(chapters).toHaveLength(2);
    expect(chapters[0]).toMatchObject({ title: '第一章 起点', number: 1, downloaded: true });
    expect(chapters[0].content).toContain('第二段不能丢失');
    expect(chapters[1]).toMatchObject({ title: '第二章 风雨', number: 2, downloaded: false });
    expect(chapters[1].unavailableReason).toContain('404');
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('拼接正文分页，但不把下一章拼进当前章', async () => {
    const fetchMock = mockPages({
      'https://books.test/c1': `<div id="content"><p>${paragraph}</p><p>第一页末尾</p></div><a href="/c1_2">下一页</a>`,
      'https://books.test/c1_2': '<div id="content"><p>第二页正文</p></div><a href="/c2">下一章</a>',
    });
    const chapter = await downloadQianyueChapter(source, { url: 'https://books.test/c1' });
    expect(chapter.downloaded).toBe(true);
    expect(chapter.content).toContain('第一页末尾\n\n第二页正文');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('后续目录失败直接报错，不把首页当完整目录', async () => {
    mockPages({
      'https://books.test/book': '<a href="/toc1">章节目录</a>',
      'https://books.test/toc1': '<div class="chapters"><a href="/c1">第一章</a></div><option value="/toc2">2</option>',
      'https://books.test/toc2': '<div>目录不可用</div>',
    });
    await expect(downloadQianyueSource(source, 'https://books.test/book')).rejects.toThrow('目录第 2 页没有章节');
  });

  it('分页循环和缺失的后页都不能标记完整', async () => {
    mockPages({
      'https://books.test/c1': `<div id="content"><p>${paragraph}</p></div><a href="/c1_2">下一页</a>`,
      'https://books.test/c1_2': '<div id="content"><p>第二页</p></div><a href="/c1">下一页</a>',
    });
    await expect(downloadQianyueChapter(source, { url: 'https://books.test/c1' })).rejects.toThrow('分页循环');
    mockPages({ 'https://books.test/c1': `<div id="content"><p>${paragraph}本章未完，请点击下一页继续阅读</p></div>` });
    await expect(downloadQianyueChapter(source, { url: 'https://books.test/c1' })).rejects.toThrow('还有分页');
  });

  it('番茄 3000 字章节的 600 字预览不能被当作完整章', async () => {
    mockPages({ 'https://fanqienovel.com/reader/123': `<div class="muye-reader-subtitle">本章字数：3000</div><div class="muye-reader-content"><p>${'文'.repeat(600)}</p></div>` });
    const chapter = await downloadFanqieChapter({ id: '123', title: '第一章', url: 'https://fanqienovel.com/reader/123', locked: true }, 1, '1');
    expect(chapter.downloaded).toBe(false);
    expect(chapter.content).toHaveLength(600);
  });

  it('网页书源的补下载保留多段与后页，并排除下一章', async () => {
    const fetchMock = mockPages({
      'https://books.test/config1': `<div id="content"><p>${paragraph}</p><p>第一页面末尾</p></div><a href="/config1_2">下一页</a>`,
      'https://books.test/config1_2': '<div id="content"><p>第二页面</p></div><a href="/config2">下一章</a>',
    });
    const chapter = await downloadConfiguredBookChapter({ ...webBookSources[0], contentSelector: '#content p' }, { url: 'https://books.test/config1' });
    expect(chapter.downloaded).toBe(true);
    expect(chapter.content).toContain('第一页面末尾\n\n第二页面');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('番茄验证码出现后暂停后续请求，不为每章重复撞验证码', async () => {
    const fetchMock = mockPages({ 'https://fanqienovel.com/reader/999': '<title>安全验证</title>captcha' });
    const chapter = { id: '999', title: '第九章', url: 'https://fanqienovel.com/reader/999', locked: true };
    await expect(downloadFanqieChapter(chapter, 9, '1')).rejects.toThrow('验证码');
    await expect(downloadFanqieChapter({ ...chapter, url: 'https://fanqienovel.com/reader/1000' }, 10, '1')).rejects.toThrow('验证码');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('JSON 目录兼容现有插值规则，补下载与整书使用同一提取器', async () => {
    const api = { ...source, ruleBookInfo: { init: 'data', tocUrl: '{{baseUrl}}/chapters?paging=0' }, ruleToc: { chapterList: 'data', chapterName: 'chapter_title', chapterUrl: "{{baseUrl.replace('?paging=0','')}}/{{$.chapter_id}}" }, ruleContent: { content: 'data.content' } };
    mockPages({
      'https://books.test/book': '{"data":{}}',
      'https://books.test/book/chapters?paging=0': '{"data":[{"chapter_id":"7","chapter_title":"第一章"}]}',
      'https://books.test/book/chapters/7': JSON.stringify({ data: { content: paragraph } }),
    });
    const chapters = await downloadQianyueSource(api, 'https://books.test/book');
    expect(chapters[0]).toMatchObject({ title: '第一章', downloaded: true, content: paragraph });
  });
});
