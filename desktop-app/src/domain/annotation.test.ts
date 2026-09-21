import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addChapterAnnotation, applyParagraphRevision, paragraphNeighbors, removeChapterAnnotations, resolveAnnotationTargets } from './annotation.ts';
import type { Chapter } from './project.ts';

const now = '2026-01-01T00:00:00.000Z';
const content = '第一段：姜冷月把笔放下。\n\n第二段：沈妄淡淡地说：“随你。”他没再说话。\n\n第三段：窗外的灯亮了一夜。';
const note = (id: string, quote: string) => ({ id, quote, note: `改 ${id}`, createdAt: now });

test('批注按原文片段定位到整段；同一段多条批注合并成一个目标；找不到片段的标为失效', () => {
  const { targets, stale } = resolveAnnotationTargets(content, [note('a', '他没再说话'), note('b', '淡淡地说'), note('c', '这句不在正文里'), note('d', '灯亮了一夜')]);
  assert.deepEqual(stale.map(item => item.id), ['c']);
  assert.deepEqual(targets.map(item => item.annotations.map(entry => entry.id)), [['a', 'b'], ['d']]);
  assert.equal(targets[0].paragraph, '第二段：沈妄淡淡地说：“随你。”他没再说话。');
  assert.equal(content.slice(targets[0].start, targets[0].end), targets[0].paragraph);
});

test('跨段选中按首尾段合并成一个区间', () => {
  const { targets } = resolveAnnotationTargets(content, [note('x', '他没再说话。\n\n第三段')]);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].paragraph, '第二段：沈妄淡淡地说：“随你。”他没再说话。\n\n第三段：窗外的灯亮了一夜。');
});

test('替换段落：偏移仍对得上直接替换；作者改过前文时按原段落文本找回；找不到返回 null', () => {
  const { targets } = resolveAnnotationTargets(content, [note('a', '他没再说话')]);
  const revised = applyParagraphRevision(content, targets[0], '第二段：沈妄把账本合上。\n');
  assert.equal(revised, '第一段：姜冷月把笔放下。\n\n第二段：沈妄把账本合上。\n\n第三段：窗外的灯亮了一夜。');
  const shifted = `开头加了一句。\n\n${content}`;
  assert.equal(applyParagraphRevision(shifted, targets[0], '新段'), `开头加了一句。\n\n第一段：姜冷月把笔放下。\n\n新段\n\n第三段：窗外的灯亮了一夜。`);
  assert.equal(applyParagraphRevision('已经完全不同的正文', targets[0], '新段'), null);
  assert.equal(applyParagraphRevision(content, targets[0], '   '), null);
});

test('前后文各取一段作衔接', () => {
  const { targets } = resolveAnnotationTargets(content, [note('a', '他没再说话')]);
  assert.deepEqual(paragraphNeighbors(content, targets[0]), { before: '第一段：姜冷月把笔放下。', after: '第三段：窗外的灯亮了一夜。' });
});

test('增删批注', () => {
  const chapter: Chapter = { id: 1, title: '第 1 章', content, wordCount: 10, createdAt: now, updatedAt: now };
  const added = addChapterAnnotation(addChapterAnnotation(chapter, ' 他没再说话 ', ' 别沉默 '), '灯亮了一夜', '换个收法');
  assert.equal(added.annotations?.length, 2);
  assert.equal(added.annotations?.[0].quote, '他没再说话');
  assert.equal(added.annotations?.[0].note, '别沉默');
  const removed = removeChapterAnnotations(added, [added.annotations![0].id]);
  assert.deepEqual(removed.annotations?.map(item => item.note), ['换个收法']);
});
