import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addCardCandidates, answerAuthorQuestion, answeredAuthorQuestions, groupOutlines, mergeGeneratedOutline, migrateCardCandidatesFromNotes, pendingAuthorQuestions, pushOutlineSnapshot, recordAuthorQuestions, removeCardCandidate, removeReviewReportsForChapter, restoreOutlineSnapshot } from './outline.ts';
import type { OutlineDocument, Project } from './project.ts';

const now = '2026-01-01T00:00:00.000Z';
const outline = (id: number, kind: OutlineDocument['kind'], title: string, content: string): OutlineDocument => ({ id, kind, title, content, createdAt: now, updatedAt: now });
const project = (patch: Partial<Project> = {}): Project => ({
  id: 1, title: '城南夜雨', genre: '悬疑', status: 'writing', chapters: [], outline: [], outlines: [], cards: [], memories: [], memoryDocuments: [], graphNodes: [], graphEdges: [], createdAt: now, updatedAt: now, wordCount: 0,
  ...patch,
});

test('总纲被模型标成追加件时接在末尾并留底，整份替换时也先留历史版本；章纲直接替换', () => {
  const master = outline(1, '总纲', '全书总纲', '# 全书总纲\n\n## 一、分卷\n第一卷……');
  const appended = mergeGeneratedOutline(master, '# 全书总纲（追加件）\n\n> 以下自原总纲第七部分之后另行追加，原有部分全部保留不动。\n\n## 八、第199～208章', '大纲智能体生成');
  assert.ok(appended.content.startsWith('# 全书总纲\n\n## 一、分卷'));
  assert.ok(appended.content.includes('## 追加（'));
  assert.ok(appended.content.includes('## 八、第199～208章'));
  assert.ok(!appended.content.includes('# 全书总纲（追加件）'));
  assert.equal(appended.snapshots?.length, 1);
  assert.equal(appended.snapshots?.[0].reason, '大纲智能体生成');

  const replaced = mergeGeneratedOutline(master, '# 全书总纲 v2\n\n全新的分卷', '项目 Agent 更新');
  assert.equal(replaced.content, '# 全书总纲 v2\n\n全新的分卷');
  assert.equal(replaced.snapshots?.[0].content, master.content);

  const chapterOutline = outline(2, '章纲', '章纲｜第 3 章', '旧章纲');
  const chapterReplaced = mergeGeneratedOutline(chapterOutline, '新章纲', '大纲智能体生成');
  assert.equal(chapterReplaced.content, '新章纲');
  assert.equal(chapterReplaced.snapshots, undefined);
});

test('大纲历史最多三条，回滚后当前版本入栈可再回滚', () => {
  let master = outline(1, '总纲', '全书总纲', 'v1');
  for (const version of ['v2', 'v3', 'v4']) master = { ...pushOutlineSnapshot(master, '测试'), content: version };
  assert.equal(master.content, 'v4');
  assert.deepEqual(master.snapshots?.map(item => item.content), ['v3', 'v2', 'v1']);
  const restored = restoreOutlineSnapshot(master, master.snapshots![2].savedAt);
  assert.equal(restored.content, 'v1');
  assert.deepEqual(restored.snapshots?.map(item => item.content), ['v4', 'v3', 'v2']);
});

test('大纲分组：阶段节拍从章纲里分出来，章纲与审查报告按章号倒序，空组不出现', () => {
  const groups = groupOutlines([
    outline(1, '章纲', '章纲｜第 3 章', ''),
    outline(2, '审查报告', '审查报告｜第 130 章 后海', ''),
    outline(3, '总纲', '全书总纲', ''),
    outline(4, '章纲', '阶段节拍｜第174～177章', ''),
    outline(5, '章纲', '章纲｜第 12 章', ''),
    outline(6, '审查报告', '给作者｜待答', ''),
  ]);
  assert.deepEqual(groups.map(entry => entry.group), ['总纲', '阶段节拍', '章纲', '审查报告']);
  assert.deepEqual(groups.find(entry => entry.group === '章纲')?.items.map(item => item.id), [5, 1]);
});

test('重写一章后删掉那章的旧审查报告，别的章和待答文档不动', () => {
  const book = project({
    outlines: [outline(1, '审查报告', '审查报告｜第 130 章 后海', ''), outline(2, '审查报告', '审查报告｜第 131 章 当庭', ''), outline(3, '审查报告', '给作者｜待答', '')],
    graphNodes: [{ id: 'outline:1', label: '审查报告｜第 130 章 后海', type: 'outline' }],
  });
  const cleaned = removeReviewReportsForChapter(book, 130);
  assert.deepEqual(cleaned.outlines.map(item => item.id), [2, 3]);
  assert.equal(cleaned.graphNodes.length, 0);
  assert.equal(removeReviewReportsForChapter(book, 999), book);
});

test('作者问答：同一问题不重复登记，答复后进提示词，未答的单独列', () => {
  let book = recordAuthorQuestions(project(), 5, '第 5 章', ['沈砚的母亲是否还在世？', '']);
  book = recordAuthorQuestions(book, 6, '第 6 章', ['沈砚的母亲是否还在世？', '电台频率要不要固定？']);
  assert.equal(book.authorQuestions?.length, 2);
  assert.equal(pendingAuthorQuestions(book).length, 2);
  book = answerAuthorQuestion(book, book.authorQuestions![0].id, '在世，住在灯塔。');
  assert.equal(pendingAuthorQuestions(book).length, 1);
  assert.deepEqual(answeredAuthorQuestions(book), [{ question: '沈砚的母亲是否还在世？', answer: '在世，住在灯塔。' }]);
});

test('建卡候选：已有卡、忽略过、已在候选里的不再登记；忽略后同名再出现也不提', () => {
  const book = project({ cards: [{ id: 1, type: '角色卡', title: '沈砚', content: '', createdAt: now, updatedAt: now }] });
  let next = addCardCandidates(book, 7, '第 7 章', ['沈砚', '小何：书肆伙计', '老孟（司机）']);
  assert.deepEqual(next.cardCandidates?.map(item => item.name), ['小何：书肆伙计', '老孟（司机）']);
  next = addCardCandidates(next, 8, '第 8 章', ['小何：又出现了']);
  assert.equal(next.cardCandidates?.length, 2);
  next = removeCardCandidate(next, next.cardCandidates![1].id, true);
  assert.deepEqual(next.ignoredCardCandidates, ['老孟']);
  next = addCardCandidates(next, 9, '第 9 章', ['老孟：再来']);
  assert.equal(next.cardCandidates?.length, 1);
});

test('旧版待答文档里的建卡条目搬进待建卡列表，文档只留审查意见', () => {
  const doc = outline(9, '审查报告', '给作者｜待答', '# 给作者｜待答\n\n说明。\n\n## 第 140 章 雪后\n- 本章新出现，要不要建卡：韩正律师\n- 审查指出：时间线矛盾\n\n## 第 147 章 昭雪\n- 本章新出现，要不要建卡：金石印谱手札\n- 本章新出现，要不要建卡：韩正律师\n');
  const migrated = migrateCardCandidatesFromNotes(project({ outlines: [doc] }));
  assert.deepEqual(migrated.cardCandidates?.map(item => [item.name, item.chapterNumber]), [['韩正律师', 140], ['金石印谱手札', 147]]);
  const content = migrated.outlines[0].content;
  assert.ok(content.includes('- 审查指出：时间线矛盾'));
  assert.ok(!content.includes('要不要建卡'));
  assert.ok(!content.includes('## 第 147 章'));
  // 没有这类行的文档原样返回
  const plain = project({ outlines: [outline(1, '审查报告', '给作者｜待答', '# 给作者｜待答\n\n## 第 3 章\n- 审查指出：x\n')] });
  assert.equal(migrateCardCandidatesFromNotes(plain), plain);
});
