import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cardSearchTerms, findCardRecentMentions, refreshCardStatesForProject } from './cards.ts';
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

test('refreshCardStatesForProject 写入当前状态与状态历史，并把章节节点连上', () => {
  const chapters = [chapter(1, '沈妄推开门。'), chapter(2, '沈妄在书肆修补古籍。')];
  const refreshed = refreshCardStatesForProject(project({ chapters, cards: [card(1, '沈妄'), card(2, '查无此人')] }));
  const shen = refreshed.cards.find(item => item.id === 1)!;
  const ghost = refreshed.cards.find(item => item.id === 2)!;
  assert.match(shen.currentState || '', /第 2 章《第 2 章》出现“沈妄”/);
  assert.equal(shen.stateHistory?.length, 1);
  assert.match(ghost.currentState || '', /未检索到可定位/);
  assert.ok(refreshed.graphEdges.some(edge => edge.label === '状态引用'));
  // 同一个正文重复刷新不该无限堆积状态历史
  const again = refreshCardStatesForProject(refreshed);
  assert.equal(again.cards.find(item => item.id === 1)!.stateHistory?.length, 1);
});
