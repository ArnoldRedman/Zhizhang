import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cardSearchTerms, findCardRecentMentions, refreshCardStatesForProject, stripHeuristicCardStates } from './cards.ts';
import type { Chapter, KnowledgeCard, Project } from './project.ts';

const now = '2026-01-01T00:00:00.000Z';

const chapter = (id: number, content: string): Chapter => ({ id, title: `第 ${id} 章`, content, wordCount: content.length, createdAt: now, updatedAt: now });

const card = (id: number, title: string, patch: Partial<KnowledgeCard> = {}): KnowledgeCard => ({
  id,
  type: '角色卡',
  title,
  content: `- **姓名**：${title}\n\n## 身份\n旧宅继承人`,
  createdAt: now,
  updatedAt: now,
  ...patch,
});

const project = (patch: Partial<Project> = {}): Project => ({
  id: 1,
  title: '梧桐旧雨',
  genre: '都市',
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
  ...patch,
} as Project);

// 卡片状态是进提示词的（“当前状态/近期变化”），长期空着模型就只知道卡片标题
test('cardSearchTerms 过滤通用词，保留卡片名与别名', () => {
  const terms = cardSearchTerms(card(1, '沈妄'));
  assert.ok(terms.includes('沈妄'));
  assert.ok(!terms.includes('身份'), '通用小标题不该当检索词');
});

test('findCardRecentMentions 从最后一章往前找，带出原文片段', () => {
  const chapters = [chapter(1, '沈妄推开门，屋内一片死寂。'), chapter(2, '清晨，沈妄在书肆修补古籍。'), chapter(3, '姜冷月独自整理清单。')];
  const mentions = findCardRecentMentions(project({ chapters }), card(1, '沈妄'), 3);
  assert.equal(mentions.length, 2);
  assert.equal(mentions[0].chapter.id, 2, '最新的章节排在最前');
  assert.ok(mentions[0].snippet.includes('沈妄'));
});

test('refreshCardStatesForProject 只维护章节到卡片的引用边，不再把正文片段写进卡片状态', () => {
  const chapters = [chapter(1, '沈妄推开门。'), chapter(2, '沈妄在书肆修补古籍。')];
  const refreshed = refreshCardStatesForProject(project({ chapters, cards: [card(1, '沈妄', { currentState: '体检正常，决定明日去书肆' }), card(2, '查无此人')] }));
  const shen = refreshed.cards.find(item => item.id === 1)!;
  // 记忆提炼写进去的真状态必须原样留着：以前这里会被"第 2 章出现"沈妄"：……"的随机摘录盖掉
  assert.equal(shen.currentState, '体检正常，决定明日去书肆');
  assert.equal(shen.stateHistory, undefined);
  assert.ok(refreshed.graphEdges.some(edge => edge.label === '状态引用' && edge.target === 'card:1'));
  assert.ok(!refreshed.graphEdges.some(edge => edge.target === 'card:2'), '正文里没出现的卡不连边');
});

test('stripHeuristicCardStates 清掉旧版按正文片段写进去的状态，真状态与真历史保留', () => {
  const heuristic = '第 204 章《第 204 章 越过书房门槛》出现“沈妄”：起眼。医生已经在写下一份病历';
  const cards = [
    card(1, '沈妄', { currentState: heuristic, stateHistory: [
      { chapterId: 203, chapterTitle: '第 203 章', status: 'updated', changes: '决定不回应法务处截图', updatedAt: now },
      { chapterId: 204, chapterTitle: '第 204 章', status: '本章出现', changes: heuristic, updatedAt: now },
    ] }),
    card(2, '姜冷月', { currentState: '追问拆信时间', stateHistory: [] }),
  ];
  const cleaned = stripHeuristicCardStates(cards);
  assert.equal(cleaned[0].currentState, '决定不回应法务处截图', '状态退回最近一条真实变化');
  assert.equal(cleaned[0].stateHistory?.length, 1);
  assert.equal(cleaned[1], cards[1], '没有残留的卡原样返回');
  const untouched = [cards[1]];
  assert.equal(stripHeuristicCardStates(untouched), untouched, '没有残留时返回同一个数组');
});
