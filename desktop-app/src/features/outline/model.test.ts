import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chapterBoundToOutline, chapterByNumber, chapterNumberFromText, outlineByChapterNumber, resolveOutlineGenerationIntent } from './model.ts';
import type { Chapter, OutlineDocument, Project } from '../../domain/project.ts';

const now = '2026-01-01T00:00:00.000Z';
const chapter = (id: number, title = `第 ${id} 章`): Chapter => ({ id, title, content: `第 ${id} 章正文`, wordCount: 6, createdAt: now, updatedAt: now });
const outline = (id: number, title: string, chapterId?: number): OutlineDocument => ({ id, kind: '章纲', chapterId, title, content: `# 章纲｜${title}\n\n场景一`, createdAt: now, updatedAt: now });
const project = (chapters: Chapter[], outlines: OutlineDocument[]): Project => ({
  id: 1, title: '城南夜雨', genre: '悬疑', status: 'writing', chapters, outline: [], outlines, cards: [], memories: [], memoryDocuments: [], graphNodes: [], graphEdges: [], createdAt: now, updatedAt: now, wordCount: 0,
});

test('chapterNumberFromText 认阿拉伯数字与中文数字，找不到“第 N 章”时返回 undefined', () => {
  assert.equal(chapterNumberFromText('章纲｜第 12 章 夜访'), 12);
  assert.equal(chapterNumberFromText('第一百二十三章 归乡'), 123);
  assert.equal(chapterNumberFromText('# 章纲｜第十章\n\n场景'), 10);
  assert.equal(chapterNumberFromText('没有章号的标题'), undefined);
});

test('chapterBoundToOutline 先按 chapterId，再按标题章号，最后按目录位置', () => {
  const chapters = [chapter(101, '第 1 章 归乡'), chapter(102, '第 2 章 阁楼'), chapter(103, '无章号标题')];
  const bound = project(chapters, []);
  assert.equal(chapterBoundToOutline(bound, outline(1, '章纲｜第 2 章', 101))?.id, 101);
  assert.equal(chapterBoundToOutline(bound, outline(2, '章纲｜第 2 章'))?.id, 102);
  assert.equal(chapterBoundToOutline(bound, outline(3, '章纲｜第 3 章'))?.id, 103);
  assert.equal(chapterBoundToOutline(bound, outline(4, '章纲｜无章号')), undefined);
  assert.equal(chapterByNumber(bound, 3)?.id, 103);
  assert.equal(outlineByChapterNumber(project(chapters, [outline(9, '章纲｜第 1 章')]), 1)?.id, 9);
});

test('resolveOutlineGenerationIntent 默认以上一章正文为依据、上一章章纲为格式', () => {
  const chapters = [chapter(1), chapter(2), chapter(3)];
  const outlines = [outline(11, '章纲｜第 1 章', 1), outline(12, '章纲｜第 2 章', 2), outline(13, '章纲｜第 3 章', 3)];
  const intent = resolveOutlineGenerationIntent(project(chapters, outlines), outlines[2], '补全结构并强化可执行性');
  assert.equal(intent.targetChapter?.id, 3);
  assert.equal(intent.sourceChapter?.id, 2);
  assert.equal(intent.sourceMode, '默认上一章正文');
  assert.equal(intent.formatOutline?.id, 12);
  assert.equal(intent.isFirstChapter, false);
  assert.equal(intent.targetRedirectFound, false);
});

test('resolveOutlineGenerationIntent 首章没有上一章时按首章模式，不报缺正文', () => {
  const intent = resolveOutlineGenerationIntent(project([chapter(1)], [outline(11, '章纲｜第 1 章', 1)]), outline(11, '章纲｜第 1 章', 1), '开书');
  assert.equal(intent.isFirstChapter, true);
  assert.equal(intent.sourceChapter, undefined);
  assert.ok(intent.sourceMode.startsWith('首章'));
});

test('resolveOutlineGenerationIntent 读懂指令里的正文依据、目标章与格式参考', () => {
  const chapters = [chapter(1), chapter(2), chapter(3), chapter(4)];
  const outlines = [outline(11, '章纲｜第 1 章', 1), outline(12, '章纲｜第 2 章', 2), outline(14, '章纲｜第 4 章', 4)];
  const explicitSource = resolveOutlineGenerationIntent(project(chapters, outlines), outlines[2], '根据第 1 章正文生成，参考第 2 章章纲格式');
  assert.equal(explicitSource.sourceChapter?.id, 1);
  assert.equal(explicitSource.sourceMode, '作者指定第 1 章正文');
  assert.equal(explicitSource.formatOutline?.id, 12);
  const useCurrent = resolveOutlineGenerationIntent(project(chapters, outlines), outlines[2], '根据本章正文反推章纲');
  assert.equal(useCurrent.sourceChapter?.id, 4);
  assert.equal(useCurrent.sourceMode, '作者指定本章正文');
  const redirected = resolveOutlineGenerationIntent(project(chapters, outlines), outlines[2], '生成第 2 章的章纲');
  assert.equal(redirected.targetOutline.id, 12);
  assert.equal(redirected.targetRedirectFound, true);
  assert.equal(redirected.explicitTargetNumber, 2);
  const missing = resolveOutlineGenerationIntent(project(chapters, outlines), outlines[2], '生成第 3 章的章纲');
  assert.equal(missing.targetRedirectFound, false);
  assert.equal(missing.explicitTargetNumber, 3);
});
