import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundChapterOutlineFor, buildChapterWriteContext, effectiveCards, recentChapterEcho, stageBeatsFor, stageRangeFor } from './context.ts';
import type { Chapter, ChapterMemory, MemoryDocument, OutlineDocument, Project } from '../../domain/project.ts';
import type { Skill } from '../../domain/skill.ts';

const now = '2026-01-01T00:00:00.000Z';
const chapter = (id: number, content = `第 ${id} 章正文`): Chapter => ({ id, title: `第 ${id} 章`, content, wordCount: content.length, createdAt: now, updatedAt: now });
const outline = (id: number, kind: OutlineDocument['kind'], title: string, chapterId?: number): OutlineDocument => ({ id, kind, chapterId, title, content: `${title} 内容`, createdAt: now, updatedAt: now });
const memory = (chapterId: number): ChapterMemory => ({
  id: chapterId * 10, chapterId, chapterTitle: `第 ${chapterId} 章`, summary: `第 ${chapterId} 章发生的事`, keywords: [], characterStateChanges: [], knowledgeChanges: [], foreshadowingChanges: [],
  foreshadowingItems: [{ text: '钥匙', status: 'active', priority: 'normal' }], timelineEvents: [], canonFacts: [], conflicts: [], endingHook: `第 ${chapterId} 章钩子`, createdAt: now, updatedAt: now,
});
const document = (kind: MemoryDocument['kind']): MemoryDocument => ({ id: `memory-document:${kind}`, kind, title: kind, content: `# ${kind}`, updatedAt: now });
const skill = (name: string): Skill => ({ id: name, name, category: 'write', description: name, tags: [], rating: 5, usageCount: 0, content: `# ${name}` });

const chapters = [1, 2, 3, 4].map(id => chapter(id));
const project = (patch: Partial<Project> = {}): Project => ({
  id: 7, title: '城南夜雨', genre: '悬疑', status: 'writing', chapters, outline: [], cards: [{ id: 1, type: '角色卡', title: '沈砚', content: '', createdAt: now, updatedAt: now }, { id: 2, type: '地点卡', title: '灯塔', content: '', createdAt: now, updatedAt: now }],
  outlines: [
    outline(11, '世界观与作品设定', '世界观'),
    outline(12, '总纲', '总纲'),
    outline(13, '章纲', '章纲｜第 2 章', 2),
    outline(14, '章纲', '章纲｜第 3 章'),
    outline(15, '章纲', '章纲｜第 4 章', 4),
  ],
  memories: [1, 2, 3, 4].map(id => memory(id)), memoryDocuments: (['章节快照', '人物状态', '角色认知', '伏笔追踪', '时间线', '设定事实', '冲突'] as const).map(document),
  graphNodes: [], graphEdges: [], createdAt: now, updatedAt: now, wordCount: 0, chapterTargetWords: 2400, ...patch,
});

test('boundChapterOutlineFor 先按 chapterId，再按标题里的章号绑定当前章', () => {
  const current = project();
  assert.equal(boundChapterOutlineFor(current, chapters[1])?.id, 13);
  assert.equal(boundChapterOutlineFor(current, chapters[2])?.id, 14);
  assert.equal(boundChapterOutlineFor(current, chapters[0]), undefined);
});

test('没勾卡片时按上一章正文与章纲里出现的卡名自动带入，金手指卡固定带入', () => {
  const current = project({
    cards: [...project().cards, { id: 3, type: '金手指卡', title: '修复之眼', content: '', createdAt: now, updatedAt: now }],
    chapters: [chapter(1), chapter(2, '沈砚推开门。'), chapter(3), chapter(4)],
  });
  const context = buildChapterWriteContext({ project: current, chapter: current.chapters[2], instruction: '继续写', skills: [], preferredSkillNames: [], extraOutlineIds: [], selectedCardIds: [] });
  assert.deepEqual((context.params.cards as Array<{ id: number }>).map(item => item.id), [3, 1]);
});

test('effectiveCards 没勾卡片时自动挑（金手指卡固定带入），勾了只用勾的', () => {
  const current = project({
    chapters: [chapter(1, '沈砚在温室里试制桑皮纸。'), chapter(2)],
    cards: [...project().cards, { id: 3, type: '金手指卡', title: '修复之眼', content: '', createdAt: now, updatedAt: now }],
  });
  const auto = effectiveCards(current, [], '沈砚把纸样压在窗台上').map(card => card.title);
  assert.ok(auto.includes('沈砚'));
  assert.ok(auto.includes('修复之眼'));
  assert.ok(!auto.includes('灯塔'));
  assert.deepEqual(effectiveCards(current, [2], '沈砚把纸样压在窗台上').map(card => card.title), ['灯塔']);
});

test('stageRangeFor 取包含本章、跨度最小的区间；大卷与没写进总纲的章都只规划往后八章', () => {
  const master = { ...outline(12, '总纲', '总纲'), content: '## 第五卷（第156～205章）\n- **第171～177章**\n- **第178～185章：研究沉淀**' };
  const current = project({ outlines: [master] });
  assert.deepEqual(stageRangeFor(current, 180), { from: 178, to: 185 });
  assert.deepEqual(stageRangeFor(current, 190), { from: 190, to: 197 });
  // 总纲没写 178 章以后的区间也要能规划，否则作者得为了下一章先去总纲里塞一段“第X～Y章”
  assert.deepEqual(stageRangeFor(project(), 179), { from: 179, to: 186 });
  assert.deepEqual(stageRangeFor(current, 300), { from: 300, to: 307 });
});

test('阶段节拍表按标题区间匹配本章，进 stageBeats 而不进普通章纲列表', () => {
  const beats: OutlineDocument = { ...outline(99, '章纲', '阶段节拍｜第1～4章'), content: '| 第 3 章 | 出城 |' };
  const current = project({ outlines: [...project().outlines, beats] });
  assert.equal(stageBeatsFor(current, 3)?.id, 99);
  assert.equal(stageBeatsFor(current, 9), undefined);
  const context = buildChapterWriteContext({ project: current, chapter: chapters[2], instruction: '继续写', skills: [], preferredSkillNames: [], extraOutlineIds: [], selectedCardIds: [] });
  assert.equal(context.params.stageBeats, '| 第 3 章 | 出城 |');
  assert.ok(!(context.params.outlines as Array<{ id: number }>).some(item => item.id === 99));
  assert.equal(boundChapterOutlineFor(current, chapters[0]), undefined);
});

test('章纲、总纲、世界观自动带入，其他章纲只在作者勾选时进入', () => {
  const context = buildChapterWriteContext({ project: project(), chapter: chapters[2], instruction: '继续写', skills: [skill('story-long-write')], preferredSkillNames: [], extraOutlineIds: [15], selectedCardIds: [1] });
  const outlineIds = (context.params.outlines as Array<{ id: number }>).map(item => item.id);
  assert.deepEqual(outlineIds, [11, 12, 14, 15]);
  assert.equal(context.boundOutline?.id, 14);
  assert.equal(context.params.activeOutlineId, 14);
  assert.equal(context.params.outline, '章纲｜第 3 章 内容');
  assert.equal(context.params.chapterNumber, 3);
  assert.equal(context.params.totalChapters, 4);
  assert.equal(context.params.targetWords, 2400);
  assert.deepEqual((context.params.cards as Array<{ id: number }>).map(item => item.id), [1]);
});

test('前文只传紧邻上一章，记忆只取本章之前的章并带章号，文档带进度基准与四份聚合文档', () => {
  const context = buildChapterWriteContext({ project: project(), chapter: chapters[2], instruction: '继续写', skills: [], preferredSkillNames: [], extraOutlineIds: [], selectedCardIds: [] });
  assert.deepEqual((context.params.previousChapters as Array<{ id: number }>).map(item => item.id), [2]);
  assert.deepEqual((context.params.memories as Array<{ chapterNumber: number }>).map(item => item.chapterNumber), [1, 2]);
  assert.deepEqual((context.params.memories as Array<{ foreshadowingItems: unknown[] }>)[0].foreshadowingItems.length, 1);
  // 章节快照是作者手写的“进度基准”，逐章记忆缺失时它是唯一能说明全书走到哪儿的东西
  assert.deepEqual((context.params.memoryDocuments as Array<{ kind: string }>).map(item => item.kind), ['章节快照', '人物状态', '伏笔追踪', '时间线', '设定事实']);
  const first = buildChapterWriteContext({ project: project(), chapter: chapters[0], instruction: '开书', skills: [], preferredSkillNames: [], extraOutlineIds: [], selectedCardIds: [] });
  assert.deepEqual(first.params.previousChapters, []);
  assert.deepEqual(first.params.memories, []);
  assert.equal(first.boundOutline, undefined);
  assert.equal(first.params.outline, '');
});

test('绑定文风时追加成一条技能并写进指令；优先技能只保留目录里真有的', () => {
  const style = { id: 's1', name: '冷峻', description: '短句', tags: ['冷峻'], content: '# 冷峻', createdAt: now, updatedAt: now };
  const context = buildChapterWriteContext({ project: project({ chapterTargetWords: undefined }), chapter: chapters[3], instruction: '继续写', skills: [skill('story-long-write')], preferredSkillNames: ['story-long-write', 'missing'], extraOutlineIds: [], selectedCardIds: [], writingStyle: style });
  const skillNames = (context.params.skills as Array<{ name: string; tags: string[] }>);
  assert.deepEqual(skillNames.map(item => item.name), ['story-long-write', 'style-s1']);
  assert.ok(skillNames[1].tags.includes('文风'));
  assert.ok(String(context.params.instruction).includes('冷峻'));
  assert.deepEqual(context.params.preferredSkillNames, ['story-long-write']);
  assert.equal(context.params.targetWords, 3000);
});

test('验证门与审查的输入：档位、引号风格、允许句式来自项目设置，上一章承诺来自记忆，最近几章开头结尾来自正文', () => {
  const withSettings = project({ reviewMode: 'full', quoteStyle: 'corner', allowedPhrases: ['声音不大，却'] });
  withSettings.memories[1] = { ...withSettings.memories[1], nextChapterPromise: '天亮前灯塔见' };
  const context = buildChapterWriteContext({ project: withSettings, chapter: chapters[2], instruction: '继续写', skills: [], preferredSkillNames: [], extraOutlineIds: [], selectedCardIds: [] });
  assert.equal(context.params.reviewMode, 'full');
  assert.equal(context.params.quoteStyle, 'corner');
  assert.deepEqual(context.params.allowedPhrases, ['声音不大，却']);
  assert.equal(context.params.previousPromise, '天亮前灯塔见');
  assert.deepEqual(context.params.recentOpenings, ['第 1 章正文', '第 2 章正文']);
  assert.deepEqual(context.params.recentEndings, ['第 1 章正文', '第 2 章正文']);
  assert.equal(context.params.benchmark, undefined);
  // 没设置时缺省 lean，承诺缺省不传
  const plain = buildChapterWriteContext({ project: project(), chapter: chapters[2], instruction: '继续写', skills: [], preferredSkillNames: [], extraOutlineIds: [], selectedCardIds: [] });
  assert.equal(plain.params.reviewMode, 'lean');
  assert.equal(plain.params.previousPromise, undefined);
  // 最近五章只取有正文的章，紧邻上一章排最后
  assert.deepEqual(recentChapterEcho(project({ chapters: [chapter(1), chapter(2, ''), chapter(3), chapter(4)] }), 4).recentOpenings, ['第 1 章正文', '第 3 章正文']);
  assert.deepEqual(recentChapterEcho(project(), 1), { recentOpenings: [], recentEndings: [] });
});

test('对标资料只传锚点、模块、节奏表三样；文风档案走 WritingStyle 不重复带', () => {
  const benchmark = { styleProfile: '# 文风', anchors: [{ tone: '热血', source: '第 3 章', point: '', excerpt: '原文段落' }], emotionModules: [], rhythm: '| 信息 |', chapterNumbers: [1, 2, 3], updatedAt: now };
  const context = buildChapterWriteContext({ project: project(), chapter: chapters[3], instruction: '继续写', skills: [], preferredSkillNames: [], extraOutlineIds: [], selectedCardIds: [], benchmark });
  assert.deepEqual(context.params.benchmark, { anchors: benchmark.anchors, emotionModules: [], rhythm: '| 信息 |' });
});

// 症状：重写第 140 章时聚合文档尾部是第 200 多章的内容，模型把"未来"当前文写；聚合文档按全书累计，历史章只能看到本章之前的
test('重写历史章时聚合文档只到本章之前，最后一章照旧用项目里的文档', () => {
  const documents = (context: ReturnType<typeof buildChapterWriteContext>) => context.params.memoryDocuments as Array<{ kind: string; content: string }>;
  const historical = buildChapterWriteContext({ project: project(), chapter: chapters[2], instruction: '重写', skills: [], preferredSkillNames: [], extraOutlineIds: [], selectedCardIds: [] });
  const snapshot = documents(historical).find(document => document.kind === '章节快照')!;
  assert.ok(snapshot.content.includes('## 第 2 章'));
  assert.ok(!snapshot.content.includes('## 第 3 章'));
  assert.ok(!snapshot.content.includes('## 第 4 章'));
  const latest = buildChapterWriteContext({ project: project(), chapter: chapters[3], instruction: '继续写', skills: [], preferredSkillNames: [], extraOutlineIds: [], selectedCardIds: [] });
  assert.equal(documents(latest).find(document => document.kind === '章节快照')!.content, '# 章节快照');
});

test('常驻卡片每章必带：自动挑时排最前且不占名额，作者勾了别的卡时也照带', () => {
  const current = project({
    chapters: [chapter(1, '什么都没提到。'), chapter(2)],
    cards: [...project().cards, { id: 3, type: '势力卡', title: '书肆', content: '', pinned: true, createdAt: now, updatedAt: now }],
  });
  assert.deepEqual(effectiveCards(current, [], '无关的正文').map(card => card.title), ['书肆']);
  assert.deepEqual(effectiveCards(current, [], '沈砚推门').map(card => card.title), ['书肆', '沈砚']);
  assert.deepEqual(effectiveCards(current, [2], '沈砚推门').map(card => card.title), ['书肆', '灯塔']);
  // 勾选里包含常驻卡时不重复
  assert.deepEqual(effectiveCards(current, [2, 3], '沈砚推门').map(card => card.title), ['书肆', '灯塔']);
});

test('作品默认技能只传技能目录里真有的名字', () => {
  const context = buildChapterWriteContext({ project: project({ defaultSkillNames: ['story-long-write', 'missing'] }), chapter: chapters[3], instruction: '继续写', skills: [skill('story-long-write')], preferredSkillNames: [], extraOutlineIds: [], selectedCardIds: [] });
  assert.deepEqual(context.params.defaultSkillNames, ['story-long-write']);
  assert.deepEqual(buildChapterWriteContext({ project: project(), chapter: chapters[3], instruction: '继续写', skills: [], preferredSkillNames: [], extraOutlineIds: [], selectedCardIds: [] }).params.defaultSkillNames, []);
});

test('重写历史章时卡片状态回退到本章之前，最后一章照旧用最新状态', () => {
  const history = [
    { chapterId: 1, chapterTitle: '第 1 章', status: 'updated', changes: '刚搬进阁楼', updatedAt: now },
    { chapterId: 2, chapterTitle: '第 2 章', status: 'updated', changes: '发现旧电台', updatedAt: now },
    { chapterId: 4, chapterTitle: '第 4 章', status: 'updated', changes: '和守夜人结盟', updatedAt: now },
  ];
  const current = project({ cards: [{ id: 1, type: '角色卡', title: '沈砚', content: '', currentState: '和守夜人结盟', stateHistory: history, pinned: true, createdAt: now, updatedAt: now }] });
  const cardsOf = (context: ReturnType<typeof buildChapterWriteContext>) => context.params.cards as Array<{ title: string; currentState?: string; stateHistory?: Array<{ chapterId: number }> }>;
  // 重写第 3 章：只看得见第 1、2 章的状态，第 4 章的"结盟"不能出现
  const rewrite = buildChapterWriteContext({ project: current, chapter: chapters[2], instruction: '重写', skills: [], preferredSkillNames: [], extraOutlineIds: [], selectedCardIds: [] });
  const rolled = cardsOf(rewrite).find(card => card.title === '沈砚')!;
  assert.equal(rolled.currentState, '发现旧电台');
  assert.deepEqual(rolled.stateHistory?.map(entry => entry.chapterId), [1, 2]);
  // 重写第 1 章：之前没有任何状态，清空
  const first = buildChapterWriteContext({ project: current, chapter: chapters[0], instruction: '重写', skills: [], preferredSkillNames: [], extraOutlineIds: [], selectedCardIds: [] });
  assert.equal(cardsOf(first).find(card => card.title === '沈砚')!.currentState, '');
  // 最后一章：最新状态原样
  const latest = buildChapterWriteContext({ project: current, chapter: chapters[3], instruction: '继续写', skills: [], preferredSkillNames: [], extraOutlineIds: [], selectedCardIds: [] });
  assert.equal(cardsOf(latest).find(card => card.title === '沈砚')!.currentState, '和守夜人结盟');
});
