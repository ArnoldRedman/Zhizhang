import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asTextList, buildChapterMemoryPatch, buildLocalStructuredMemory, buildMemoryDocuments, chapterMemoryStale, hydrateMemoryDocuments, memoryDocumentKinds, memoryTextList, normalizeChapterMemory, recentChapterMemories, staleMemoryChapters } from './memory.ts';
import type { Chapter, ChapterMemory, Project } from './project.ts';

const now = '2026-01-01T00:00:00.000Z';

const chapter = (id: number, content = ''): Chapter => ({ id, title: `第 ${id} 章`, content, wordCount: content.length, createdAt: now, updatedAt: now });

const memory = (chapterId: number, patch: Partial<ChapterMemory> = {}): ChapterMemory => ({
  id: chapterId * 10,
  chapterId,
  chapterTitle: `第 ${chapterId} 章`,
  summary: `第 ${chapterId} 章的事`,
  keywords: [],
  characterStateChanges: [],
  knowledgeChanges: [],
  foreshadowingChanges: [],
  timelineEvents: [],
  canonFacts: [],
  conflicts: [],
  endingHook: '',
  createdAt: now,
  updatedAt: now,
  ...patch,
});

const project = (patch: Partial<Project> = {}): Project => ({
  id: 1,
  title: '城南夜雨',
  genre: '悬疑',
  status: 'writing',
  chapters: [],
  outline: [],
  outlines: [],
  cards: [],
  memories: [],
  memoryDocuments: [],
  graphNodes: [],
  graphEdges: [],
  createdAt: now,
  updatedAt: now,
  wordCount: 0,
  protagonist1: '沈砚',
  ...patch,
});

test('normalizeChapterMemory 用章节兜底缺失字段，并给伏笔条目补默认状态', () => {
  const result = normalizeChapterMemory({
    summary: '阁楼电台亮起',
    foreshadowingItems: [{ text: '钥匙能开地下室', status: 'active', priority: 'high' }, { text: '摩斯码' } as NonNullable<ChapterMemory['foreshadowingItems']>[number]],
  }, chapter(7));
  assert.equal(result.chapterId, 7);
  assert.equal(result.chapterTitle, '第 7 章');
  assert.equal(result.summary, '阁楼电台亮起');
  assert.deepEqual(result.foreshadowingItems?.map(item => [item.text, item.status, item.priority]), [['钥匙能开地下室', 'active', 'high'], ['摩斯码', 'active', 'normal']]);
  assert.deepEqual(result.keywords, []);
});

test('asTextList 与 memoryTextList 只保留非空文本并按上限截断', () => {
  assert.deepEqual(asTextList(['a', ' b ', '', 3, null], 2), ['a', 'b']);
  assert.deepEqual(asTextList('not a list'), []);
  assert.deepEqual(memoryTextList('钥匙、电台\n守夜人\n\n'), ['钥匙', '电台', '守夜人']);
});

test('buildMemoryDocuments 按章序聚合，手改过的文档不被自动覆盖，force 时才重建', () => {
  const memories = [
    memory(2, { sourceChapterNumber: 2, characterStateChanges: ['沈砚：受伤'] }),
    memory(1, { sourceChapterNumber: 1, characterStateChanges: ['沈砚：回到老家'] }),
  ];
  const documents = buildMemoryDocuments(memories);
  assert.deepEqual(documents.map(document => document.kind), memoryDocumentKinds);
  const states = documents.find(document => document.kind === '人物状态')!;
  assert.ok(states.content.indexOf('回到老家') < states.content.indexOf('受伤'));
  const edited = documents.map(document => document.kind === '时间线' ? { ...document, content: '# 作者手写的时间线', manuallyEdited: true } : document);
  assert.equal(buildMemoryDocuments(memories, edited).find(document => document.kind === '时间线')?.content, '# 作者手写的时间线');
  assert.notEqual(buildMemoryDocuments(memories, edited, true).find(document => document.kind === '时间线')?.content, '# 作者手写的时间线');
});

test('hydrateMemoryDocuments 补齐全部种类，保存内容与自动生成不同时视为手改', () => {
  const memories = [memory(1, { sourceChapterNumber: 1 })];
  const hydrated = hydrateMemoryDocuments([{ kind: '冲突', title: '冲突', content: '# 我的冲突表' }], memories);
  assert.equal(hydrated.length, memoryDocumentKinds.length);
  const conflicts = hydrated.find(document => document.kind === '冲突')!;
  assert.equal(conflicts.content, '# 我的冲突表');
  assert.equal(conflicts.manuallyEdited, true);
  assert.equal(hydrated.find(document => document.kind === '时间线')?.manuallyEdited, false);
});

test('buildLocalStructuredMemory 从正文里按人物名提取状态，并把最后的悬念当章末钩子', () => {
  const content = '沈砚回到海边老家，决定今晚守在阁楼。随后电台突然亮起。沈砚得知母亲留下过一段录音。门外却传来三声敲门？';
  const result = buildLocalStructuredMemory(chapter(1, content), project());
  assert.ok(result.characterStateChanges.some(item => item.startsWith('沈砚：')));
  assert.ok(result.knowledgeChanges.some(item => item.includes('得知')));
  assert.ok(result.endingHook.includes('三声敲门'));
  assert.ok(result.summary.length > 0);
});

// 单章保存与批量补全共用这一份合并规则：分开写就会两边不一样
// （规则本身是从 App.tsx 的保存流程里抽出来的，行为必须一致）
test('buildChapterMemoryPatch 用成体系的模型结果覆盖启发式，不完整时回落到启发式与原值', () => {
  const local = buildLocalStructuredMemory(chapter(1, '沈砚守在阁楼。随后电台亮起。沈砚得知母亲留下过录音。'), project());
  // 模型给出三个以上字段：整份当成一套判断采用，宁可空着也不用启发式凑
  const coherent = buildChapterMemoryPatch({
    result: { characterStateChanges: ['沈砚：戒备'], knowledgeChanges: ['沈砚：得知录音'], timelineEvents: ['当晚电台亮起'] },
    local,
    keywords: ['旧电台'],
    existing: memory(1),
  });
  assert.deepEqual(coherent.foreshadowingChanges, []);
  assert.deepEqual(coherent.conflicts, []);
  assert.equal(coherent.summary, local.summary);
  assert.deepEqual(coherent.keywords, ['旧电台']);
  // 模型只给一两个字段（或整个失败）：逐字段回落启发式，再回落已有值
  const partial = buildChapterMemoryPatch({ result: {}, local, keywords: [], existing: memory(1) });
  assert.ok((partial.characterStateChanges || []).length > 0);
  assert.equal(partial.endingHook, local.endingHook);
  // 结构化伏笔没返回时保留已有的，不能抹掉
  const kept = buildChapterMemoryPatch({
    result: { summary: '新摘要' },
    local,
    keywords: [],
    existing: { ...memory(1), foreshadowingItems: [{ text: '钥匙能开地下室', status: 'active', priority: 'normal' }] },
  });
  assert.equal(kept.foreshadowingItems?.length, 1);
  assert.equal(kept.summary, '新摘要');
  // 人物关系只有模型能给：返回了就用，没返回保留已有的
  const related = buildChapterMemoryPatch({ result: { relationshipState: ['沈砚对母亲：从戒备转为想念'] }, local, keywords: [], existing: memory(1) });
  assert.deepEqual(related.relationshipState, ['沈砚对母亲：从戒备转为想念']);
  const inherited = buildChapterMemoryPatch({ result: {}, local, keywords: [], existing: { ...memory(1), relationshipState: ['旧关系'] } });
  assert.deepEqual(inherited.relationshipState, ['旧关系']);
});

test('recentChapterMemories 只取目标章之前的记忆，按目录顺序排并限制条数', () => {
  const chapters = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(id => chapter(id));
  const memories = [9, 3, 7, 1, 8, 5, 2, 6, 4].map(id => memory(id));
  const result = recentChapterMemories(project({ chapters, memories }), 8, 6);
  assert.deepEqual(result.map(item => item.chapterNumber), [2, 3, 4, 5, 6, 7]);
  // 默认不再卡 6 章：候选给足够长，能带几章由运行时的上下文预算决定
  const wide = recentChapterMemories(project({ chapters, memories }), 8);
  assert.deepEqual(wide.map(item => item.chapterNumber), [1, 2, 3, 4, 5, 6, 7]);
  // 章节已不在目录里时退回记忆自带的章号；没有任何章号的记忆不进账本
  const orphan = recentChapterMemories(project({ chapters: [], memories: [memory(99, { sourceChapterNumber: 2 }), memory(98)] }), 5);
  assert.deepEqual(orphan.map(item => item.chapterNumber), [2]);
});

test('chapterMemoryStale 按提炼时间对比正文改动时间，旧记忆按结构化字段判定', () => {
  const written = chapter(1, '沈砚守在阁楼。随后电台亮起。');
  const later = '2026-01-02T00:00:00.000Z';
  // 没有记忆、只有本地兜底（结构化全空且没有 refinedAt）都算落后
  assert.equal(chapterMemoryStale(undefined, written), true);
  assert.equal(chapterMemoryStale(memory(1), written), true);
  // 提炼过之后正文没再改：不落后
  assert.equal(chapterMemoryStale(memory(1, { refinedAt: later }), written), false);
  // 正文在提炼之后又改过：落后
  assert.equal(chapterMemoryStale(memory(1, { refinedAt: later }), { ...written, updatedAt: '2026-01-03T00:00:00.000Z' }), true);
  // 2026-09-21 之前的记忆没有 refinedAt：带结构化字段就按 updatedAt 当作提炼过
  assert.equal(chapterMemoryStale(memory(1, { timelineEvents: ['当晚电台亮起'] }), written), false);
  assert.equal(chapterMemoryStale(memory(1, { timelineEvents: ['当晚电台亮起'] }), { ...written, updatedAt: later }), true);
  // 空章不算落后：正文删空时记忆本来就会被移除
  assert.equal(chapterMemoryStale(undefined, chapter(2)), false);
});

test('staleMemoryChapters 按目录顺序列出记忆落后的章并带章号', () => {
  const later = '2026-01-02T00:00:00.000Z';
  const book = project({
    chapters: [chapter(1, '正文一'), chapter(2, '正文二'), chapter(3, '正文三'), chapter(4)],
    memories: [memory(1, { refinedAt: later }), memory(3)],
  });
  assert.deepEqual(staleMemoryChapters(book).map(item => item.number), [2, 3]);
});

test('buildChapterMemoryPatch 合并模型结果时记下提炼时间', () => {
  const local = buildLocalStructuredMemory(chapter(1, '沈砚守在阁楼。'), project());
  const patch = buildChapterMemoryPatch({ result: { summary: '新摘要' }, local, keywords: [] });
  assert.ok(patch.refinedAt && patch.refinedAt >= now);
  assert.equal(normalizeChapterMemory({ ...memory(1), refinedAt: patch.refinedAt }).refinedAt, patch.refinedAt);
});
