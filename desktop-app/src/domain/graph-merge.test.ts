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

test('mergeKnowledgeGraph 把别名、类型后缀落到已有卡片上，泛称不建节点', () => {
  const target = chapter(9, '第 9 章', '姜老董事长坐在轮椅上，爷爷笑了。韩律师递来文件。');
  const jiang: KnowledgeCard = { ...card(3, '姜正霖'), content: '- **name**：姜正霖\n- **aliases**：\n  - 姜老董事长\n  - 父亲' };
  const base = project({ chapters: [target], cards: [jiang] });
  const merged = mergeKnowledgeGraph(base, target, {
    entities: [{ name: '姜老董事长', type: '人物' }, { name: '姜正霖（人物）', type: '人物' }, { name: '爷爷', type: '人物' }, { name: '韩律师', type: '人物' }, { name: '韩正', type: '人物' }],
    relations: [{ source: '爷爷', target: '韩律师', label: '委托' }, { source: '姜老董事长', target: '韩正', label: '委托' }],
  });
  const entityLabels = merged.graphNodes.filter(node => node.type === 'entity').map(node => node.label);
  assert.deepEqual(entityLabels, ['韩正']);
  // 别名与后缀都指向卡片节点，章节到卡片只有一条提及边
  assert.equal(merged.graphEdges.filter(edge => edge.target === 'card:3' && edge.label === '章节提及').length, 1);
  assert.ok(merged.graphEdges.some(edge => edge.source === 'card:3' && edge.target === 'entity:韩正' && edge.label === '委托'));
  // 泛称之间的关系整条丢掉
  assert.ok(!merged.graphEdges.some(edge => edge.label === '委托' && edge.source !== 'card:3'));
});
