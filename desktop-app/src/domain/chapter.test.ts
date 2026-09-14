import assert from 'node:assert/strict';
import { test } from 'node:test';
import { removeChapterFromProject, restoreDeletedChapter, pushChapterSnapshot, restoreChapterSnapshot, moveChapterInProject, reorderChapterInProject, insertChapterAfter, chapterSnapshotLimit, aiDetectionSegmentsMatch } from './chapter.ts';
import { buildProjectExport, buildChapterExport, exportFileName, defaultExportOptions } from './export.ts';
import type { Chapter, Project } from './project.ts';

const now = '2026-01-01T00:00:00.000Z';

const project = {
  id: 1,
  title: '城南夜雨',
  genre: '悬疑',
  synopsis: '一场雨引出的旧案。',
  status: 'writing',
  chapters: [
    { id: 10, title: '第一章', content: '入城。', wordCount: 3, createdAt: now, updatedAt: now },
    { id: 20, title: '第二章', content: '夜雨。', wordCount: 3, createdAt: now, updatedAt: now },
  ],
  outline: [],
  outlines: [
    { id: 100, kind: '章纲', chapterId: 20, title: '章纲｜第二章', content: '夜雨中的核对。', createdAt: now, updatedAt: now },
    { id: 101, kind: '总纲', title: '总纲', content: '全书主线。', createdAt: now, updatedAt: now },
  ],
  cards: [{
    id: 200, type: '角色卡', title: '林舟', content: '谨慎。', createdAt: now, updatedAt: now,
    stateHistory: [
      { chapterId: 10, chapterTitle: '第一章', status: '出现', changes: 'a', updatedAt: now },
      { chapterId: 20, chapterTitle: '第二章', status: '出现', changes: 'b', updatedAt: now },
    ],
  }],
  memories: [
    { id: 300, chapterId: 10, chapterTitle: '第一章', summary: 's1', keywords: [], characterStateChanges: [], knowledgeChanges: [], foreshadowingChanges: [], timelineEvents: [], canonFacts: [], conflicts: [], endingHook: '', createdAt: now, updatedAt: now },
    { id: 301, chapterId: 20, chapterTitle: '第二章', summary: 's2', keywords: [], characterStateChanges: [], knowledgeChanges: [], foreshadowingChanges: [], timelineEvents: [], canonFacts: [], conflicts: [], endingHook: '', createdAt: now, updatedAt: now },
  ],
  memoryDocuments: [],
  graphNodes: [
    { id: 'chapter:10', label: '第一章', type: 'chapter' },
    { id: 'chapter:20', label: '第二章', type: 'chapter' },
    { id: 'card:200', label: '林舟', type: 'card' },
  ],
  graphEdges: [
    { id: 'chapter:20->card:200:状态引用', source: 'chapter:20', target: 'card:200', label: '状态引用' },
    { id: 'chapter:10->card:200:状态引用', source: 'chapter:10', target: 'card:200', label: '状态引用' },
  ],
  aiDetection: {
    updatedAt: now, scope: 'book', averageAIRate: 40, level: '低', suggestion: '', provider: '本地启发式',
    chapters: [
      { chapterId: 10, chapterTitle: '第一章', wordCount: 3, sentenceUniformity: 0, logicFrequency: 0, colloquialFrequency: 0, psychologicalFrequency: 0, paragraphUniformity: 0, aiRate: 30, humanRate: 70, segments: [], label: '人工' },
      { chapterId: 20, chapterTitle: '第二章', wordCount: 3, sentenceUniformity: 0, logicFrequency: 0, colloquialFrequency: 0, psychologicalFrequency: 0, paragraphUniformity: 0, aiRate: 50, humanRate: 50, segments: [], label: '疑似 AI' },
    ],
  },
  createdAt: now,
  updatedAt: now,
  wordCount: 6,
} as unknown as Project;

const countWords = (content: string) => content.replace(/\s/gu, '').length;

test('删除章节会级联清理记忆、图谱、状态历史和检测报告', () => {
  const next = removeChapterFromProject(project, 20);

  assert.deepEqual(next.chapters.map(chapter => chapter.id), [10]);
  assert.equal(next.wordCount, 3);
  // 章纲是可复用的写作计划，保留但解除绑定
  assert.equal(next.outlines.length, 2);
  assert.equal(next.outlines.find(outline => outline.id === 100)?.chapterId, undefined);
  assert.deepEqual(next.memories.map(memory => memory.id), [300]);
  assert.deepEqual(next.cards[0].stateHistory?.map(entry => entry.chapterId), [10]);
  assert.deepEqual(next.graphNodes.map(node => node.id), ['chapter:10', 'card:200']);
  assert.deepEqual(next.graphEdges.map(edge => edge.id), ['chapter:10->card:200:状态引用']);
  assert.deepEqual(next.aiDetection?.chapters.map(item => item.chapterId), [10]);
});

test('删除不存在的章节时原样返回，不产生空写入', () => {
  assert.equal(removeChapterFromProject(project, 999), project);
});

test('删除的章节进回收站，可以恢复到原位置', () => {
  const deleted = removeChapterFromProject(project, 10);
  assert.deepEqual(deleted.deletedChapters?.map(entry => entry.chapter.id), [10]);

  const { project: restored, chapter } = restoreDeletedChapter(deleted, 10);
  assert.equal(chapter?.id, 10);
  // 原下标 0，恢复后仍在最前
  assert.deepEqual(restored.chapters.map(item => item.id), [10, 20]);
  assert.equal(restored.deletedChapters?.length, 0);
  assert.equal(restored.wordCount, 6);
});

test('快照上限固定，最新的在前', () => {
  let chapter = project.chapters[0];
  for (const reason of ['第一次', '第二次', '第三次', '第四次']) {
    chapter = { ...pushChapterSnapshot(chapter, reason), content: `${chapter.content}+`, wordCount: chapter.wordCount + 1 };
  }
  assert.equal(chapter.snapshots?.length, chapterSnapshotLimit);
  assert.deepEqual(chapter.snapshots?.map(snapshot => snapshot.reason), ['第四次', '第三次', '第二次']);
});

test('空正文不产生快照', () => {
  const empty: Chapter = { id: 1, title: '新章节', content: '   ', wordCount: 0, createdAt: now, updatedAt: now };
  assert.equal(pushChapterSnapshot(empty, 'AI 润色').snapshots, undefined);
});

test('回滚会把当前正文存为新快照，因此可以再回滚', () => {
  const original = project.chapters[0];
  const overwritten = { ...pushChapterSnapshot(original, 'AI 润色'), content: 'AI 改写后的内容。', wordCount: 8 };
  const savedAt = overwritten.snapshots![0].savedAt;

  const rolledBack = restoreChapterSnapshot(overwritten, savedAt, countWords);
  assert.equal(rolledBack.content, original.content);
  assert.equal(rolledBack.wordCount, countWords(original.content));
  // 被取用的那条移出栈，AI 版本入栈，回滚可逆
  assert.deepEqual(rolledBack.snapshots?.map(snapshot => snapshot.content), ['AI 改写后的内容。']);
});

test('回滚不存在的快照时原样返回', () => {
  assert.equal(restoreChapterSnapshot(project.chapters[0], '不存在', countWords), project.chapters[0]);
});

test('章节上移下移与越界保护', () => {
  assert.deepEqual(moveChapterInProject(project, 20, -1).chapters.map(chapter => chapter.id), [20, 10]);
  assert.equal(moveChapterInProject(project, 10, -1), project);
  assert.equal(moveChapterInProject(project, 20, 1), project);
});

test('拖拽排序把章节移动到目标下标', () => {
  assert.deepEqual(reorderChapterInProject(project, 20, 0).chapters.map(chapter => chapter.id), [20, 10]);
  assert.equal(reorderChapterInProject(project, 20, 1), project);
});

test('可以在中间插入新章节', () => {
  const { project: next, chapter } = insertChapterAfter(project, 10, '插入章');
  assert.deepEqual(next.chapters.map(item => item.title), ['第一章', '插入章', '第二章']);
  assert.equal(chapter.content, '');

  const { project: first } = insertChapterAfter(project, null, '楔子');
  assert.equal(first.chapters[0].title, '楔子');
});

test('全书导出包含每一章正文，并按当前顺序排列', () => {
  const text = buildProjectExport(project, defaultExportOptions);
  assert.match(text, /城南夜雨/u);
  assert.match(text, /一场雨引出的旧案。/u);
  assert.ok(text.indexOf('入城。') < text.indexOf('夜雨。'));
  // 默认不带大纲和卡片
  assert.doesNotMatch(text, /全书主线。/u);
  assert.doesNotMatch(text, /谨慎。/u);
});

test('导出可以附带大纲与卡片，Markdown 用标题层级', () => {
  const text = buildProjectExport(project, { format: 'md', includeOutlines: true, includeCards: true });
  assert.match(text, /^# 城南夜雨/u);
  assert.match(text, /### 总纲｜总纲/u);
  assert.match(text, /### 角色卡｜林舟/u);
});

test('单章导出只含该章，文件名去掉非法字符', () => {
  const text = buildChapterExport(project, 20, 'txt');
  assert.match(text, /夜雨。/u);
  assert.doesNotMatch(text, /入城。/u);
  assert.equal(buildChapterExport(project, 999, 'txt'), '');

  const risky = { ...project, title: '城南/夜雨:一' } as Project;
  assert.equal(exportFileName(risky, defaultExportOptions), '城南_夜雨_一.txt');
  assert.equal(exportFileName(project, { ...defaultExportOptions, format: 'md' }), '城南夜雨.md');
});

test('AI 检测分段：正文没变时逐字对得上，章节头和末尾换行也是原文的一部分', () => {
  const segments = [
    { order: 1, text: '上半段。\n\n', confidence: 0, label: '人工' as const },
    { order: 2, text: '下半段。', confidence: 0, label: '人工' as const },
  ];
  assert.equal(aiDetectionSegmentsMatch(segments, '上半段。\n\n下半段。'), true);
  // 分段是按原文切的：原文带章节头或末尾换行时，分段里也带着，去掉再比就永远对不上
  assert.equal(aiDetectionSegmentsMatch(segments, '【第1章 起】上半段。\n\n下半段。（本章完）\n'), false);
  const withHeader = [{ order: 1, text: '【第1章 起】上半段。\n\n', confidence: 0, label: '人工' as const }, { order: 2, text: '下半段。（本章完）\n', confidence: 0, label: '人工' as const }];
  assert.equal(aiDetectionSegmentsMatch(withHeader, '【第1章 起】上半段。\n\n下半段。（本章完）\n'), true);
});

test('AI 检测分段：正文改过之后判定为失配，高亮层退回纯文本', () => {
  const segments = [{ order: 1, text: '旧正文。', confidence: 0, label: '人工' as const }];
  assert.equal(aiDetectionSegmentsMatch(segments, '旧正文。AI 续写补上的一段。'), false);
  assert.equal(aiDetectionSegmentsMatch([], '任何正文'), false);
  assert.equal(aiDetectionSegmentsMatch(undefined, '任何正文'), false);
});
