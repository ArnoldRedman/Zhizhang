import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeKnowledgeGraph } from './graph-merge.ts';
import type { Chapter, KnowledgeCard, Project } from './project.ts';

const now = '2026-01-01T00:00:00.000Z';
const chapter = (id: number, title: string, content = '沈妄把三张试抄并排放在桌上。'): Chapter => ({ id, title, content, wordCount: content.length, createdAt: now, updatedAt: now });
const card = (id: number, title: string): KnowledgeCard => ({ id, type: '角色卡', title, content: `- **姓名**：${title}`, createdAt: now, updatedAt: now });
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

// 补历史记忆时要复用保存章节时的同一套合并规则，否则图谱和卡片状态会两套数据
test('mergeKnowledgeGraph 建实体节点并把章节连上去', () => {
  const target = chapter(7, '第 7 章');
  const base = project({ chapters: [target], cards: [card(1, '沈妄')] });
  const merged = mergeKnowledgeGraph(base, target, {
    entities: [{ name: '桑皮纸', type: '物品' }, { name: '沈妄', type: '人物' }],
    relations: [{ source: '沈妄', target: '桑皮纸', label: '试制' }],
  });
  const entityNode = merged.graphNodes.find(node => node.label === '桑皮纸');
  assert.ok(entityNode && entityNode.type === 'entity');
  assert.ok(merged.graphNodes.some(node => node.id === 'chapter:7'));
  // 卡片已有同名节点时不重复建 entity
  assert.ok(merged.graphNodes.some(node => node.label === '沈妄' && node.type === 'card'));
  assert.ok(merged.graphEdges.some(edge => edge.label === '章节提及'));
  assert.ok(merged.graphEdges.some(edge => edge.label === '试制' && edge.source === 'card:1'));
});

test('mergeKnowledgeGraph 的卡片状态更新可以关掉（补历史时统一用按正文定位的结果）', () => {
  const target = chapter(7, '第 7 章');
  const base = project({ chapters: [target], cards: [card(1, '沈妄')] });
  const result = { cardUpdates: [{ cardId: 1, status: 'updated', changes: '本章确立了试讲安排。' }] };
  const withUpdates = mergeKnowledgeGraph(base, target, result);
  const withoutUpdates = mergeKnowledgeGraph(base, target, result, { cardUpdates: false });
  assert.equal(withUpdates.cards[0].currentState, '本章确立了试讲安排。');
  assert.equal(withoutUpdates.cards[0].currentState, undefined);
});
