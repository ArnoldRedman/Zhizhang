import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeDownloadedChapters, matchDownloadBook } from './download.ts';
import type { LibraryBook, LibraryBookChapter } from '../../domain/library';
const chapter = (id: string, content: string, downloaded: boolean): LibraryBookChapter => ({ id, number: Number(id), title: `第${id}章`, url: `https://books.test/${id}`, content, downloaded, wordCount: content.length });

test('失败重下不清掉正文和章纲，同时纳入新目录章节', () => {
  const old = { ...chapter('1', '原正文', true), outline: '人工章纲' };
  const result = mergeDownloadedChapters([old, chapter('3', '保留目录之外的旧内容', true)], [chapter('1', '', false), chapter('2', '新增', true)]);
  assert.equal(result[0].content, '原正文');
  assert.equal(result[0].outline, '人工章纲');
  assert.equal(result[1].content, '新增');
  assert.equal(result[2].id, '3');
});

test('失败重试保留原片段并更新原因，成功则替换片段保留 ID', () => {
  const old = chapter('1', '旧片段', false);
  assert.equal(mergeDownloadedChapters([old], [{ ...old, content: '', unavailableReason: '限流' }])[0].unavailableReason, '限流');
  const updated = mergeDownloadedChapters([old], [{ ...old, id: 'new', content: '新完整正文', downloaded: true }])[0];
  assert.equal(updated.id, '1');
  assert.equal(updated.content, '新完整正文');
});

test('跨书源下载只接受同名同作者，不拿搜索第一条冒充目标书', () => {
  const books = [{ title: '甲书', author: '同名作者' }, { title: '目标书', author: '另一作者' }, { title: '目标书', author: '正确作者' }] as LibraryBook[];
  assert.equal(matchDownloadBook(books, '目标书', '正确作者'), books[2]);
  assert.equal(matchDownloadBook(books, '未收录', '正确作者'), undefined);
  assert.equal(matchDownloadBook(books, '目标书', '未知作者'), undefined);
});
