import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aiDetectionLabel, analyzeAIChapter, buildAIDetectionReport, splitAIDetectionSegments } from './ai-detection.ts';
import { aiDetectionSegmentsMatch } from './chapter.ts';
import type { Chapter, Project } from './project.ts';

const now = '2026-01-01T00:00:00.000Z';
const chapter = (id: number, content: string): Chapter => ({ id, title: `第 ${id} 章`, content, wordCount: content.length, createdAt: now, updatedAt: now });
const project = (chapters: Chapter[]): Project => ({
  id: 1, title: '城南夜雨', genre: '悬疑', status: 'writing', chapters, outline: [], outlines: [], cards: [], memories: [], memoryDocuments: [], graphNodes: [], graphEdges: [], createdAt: now, updatedAt: now, wordCount: 0,
});

const humanText = '沈砚咋回事啊？他琢磨着门外那三声敲门。\n\n屋里冷得很。他没开灯，寻思着要不要出声。\n\n“谁？”他终于喊了一句。';
const templatedText = '首先，我们需要注意的是这个问题。其次，值得注意的是这个方案。最后，综上所述，通过这种方式可以解决。总之，首先要明确目标。';

test('aiDetectionLabel 按置信度分三档', () => {
  assert.equal(aiDetectionLabel(0.2), '人工');
  assert.equal(aiDetectionLabel(0.5), '疑似 AI');
  assert.equal(aiDetectionLabel(0.99), 'AI 特征');
});

test('splitAIDetectionSegments 保留段落分隔符，拼回去与原文逐字一致', () => {
  const segments = splitAIDetectionSegments(humanText, 0.3);
  assert.equal(segments.map(segment => segment.text).join(''), humanText);
  assert.deepEqual(segments.map(segment => segment.order), [1, 2, 3]);
  assert.ok(segments.every(segment => segment.confidence >= 0 && segment.confidence <= 0.99));
  const templated = splitAIDetectionSegments(templatedText, 0.9);
  assert.equal(templated[0]?.label, 'AI 特征');
});

test('analyzeAIChapter 给出 0 到 100 的比率，人工率与 AI 率互补，分段覆盖整篇原文', () => {
  const raw = `【第1章 归乡】\n${humanText}\n（本章完）`;
  const result = analyzeAIChapter(chapter(1, raw));
  assert.ok(result.aiRate >= 0 && result.aiRate <= 100);
  assert.equal(Number((result.aiRate + result.humanRate).toFixed(1)), 100);
  assert.equal(result.wordCount > 0, true);
  // 分段是按原文切的：高亮层铺的就是编辑器里的原文，拼回去必须逐字相同
  assert.equal(result.segments.map(segment => segment.text).join(''), raw);
  assert.equal(aiDetectionSegmentsMatch(analyzeAIChapter(chapter(2, humanText)).segments, humanText), true);
  assert.ok(analyzeAIChapter(chapter(3, templatedText)).aiRate > result.aiRate);
});

test('buildAIDetectionReport 按范围取章、跳过空章，并给出等级与建议', () => {
  const chapters = [chapter(1, humanText), chapter(2, ''), chapter(3, templatedText)];
  const book = buildAIDetectionReport(project(chapters), 'book');
  assert.equal(book.scope, 'book');
  assert.deepEqual(book.chapters.map(item => item.chapterId), [1, 3]);
  assert.equal(book.provider, '本地启发式');
  assert.ok(['极低', '低', '中等', '高'].includes(book.level));
  assert.ok(book.suggestion.length > 0);
  const single = buildAIDetectionReport(project(chapters), 'chapter', chapters[0]);
  assert.deepEqual(single.chapters.map(item => item.chapterId), [1]);
  assert.equal(single.averageAIRate, single.chapters[0]?.aiRate);
});
