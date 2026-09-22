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
test('mergeKnowledgeGraph 第一次见的实体先进待升级表，第二次在别的章出现才建节点并补上前一章的提及边', () => {
  const first = chapter(7, '第 7 章');
  const base = project({ chapters: [first], cards: [card(1, '沈妄')] });
  const once = mergeKnowledgeGraph(base, first, {
    entities: [{ name: '桑皮纸', type: '物品' }, { name: '沈妄', type: '人物' }],
    relations: [{ source: '沈妄', target: '桑皮纸', label: '试制' }],
  });
  // 一次性名词不建节点，也不连关系；卡片已有同名节点时不重复建 entity
  assert.ok(!once.graphNodes.some(node => node.label === '桑皮纸'));
  assert.deepEqual(once.graphPendingEntities, [{ label: '桑皮纸', category: '物品', chapterIds: [7] }]);
  assert.ok(once.graphNodes.some(node => node.id === 'chapter:7'));
  assert.ok(once.graphNodes.some(node => node.label === '沈妄' && node.type === 'card'));
  assert.ok(!once.graphEdges.some(edge => edge.label === '试制'));
  // 同一章重跑不算第二次
  const again = mergeKnowledgeGraph({ ...once, chapters: [first] }, first, { entities: [{ name: '桑皮纸', type: '物品' }] });
  assert.ok(!again.graphNodes.some(node => node.label === '桑皮纸'));
  // 第二章再出现：升为节点，第 7 章的提及边补上，关系也连上
  const second = chapter(8, '第 8 章');
  const twice = mergeKnowledgeGraph({ ...again, chapters: [first, second] }, second, {
    entities: [{ name: '桑皮纸样本', type: '物品' }],
    relations: [{ source: '沈妄', target: '桑皮纸', label: '试制' }],
  });
  const entityNode = twice.graphNodes.find(node => node.label === '桑皮纸');
  assert.ok(entityNode && entityNode.type === 'entity', '核心名相同（"桑皮纸样本"剥掉版本后缀）就是同一个东西');
  assert.ok(twice.graphEdges.some(edge => edge.source === 'chapter:7' && edge.target === 'entity:桑皮纸' && edge.label === '章节提及'));
  assert.ok(twice.graphEdges.some(edge => edge.source === 'chapter:8' && edge.target === 'entity:桑皮纸'));
  assert.ok(twice.graphEdges.some(edge => edge.label === '试制' && edge.source === 'card:1' && edge.target === 'entity:桑皮纸'));
  assert.deepEqual(twice.graphPendingEntities, []);
});

test('mergeKnowledgeGraph 事件不建节点，势力变体与地点卡片段落到已有节点', () => {
  const target = chapter(9, '第 9 章');
  const place: KnowledgeCard = { ...card(5, '江城梧桐路58号老洋房顶楼601'), type: '地点卡' };
  const base = project({
    chapters: [target],
    cards: [place],
    graphNodes: [{ id: 'entity:天宇法务', label: '天宇法务', type: 'entity', category: '势力' }],
  });
  const merged = mergeKnowledgeGraph(base, target, {
    entities: [{ name: '天宇法务天团', type: '势力' }, { name: '梧桐路601', type: '地点' }, { name: '冬至家宴', type: '事件' }],
  });
  assert.ok(!merged.graphNodes.some(node => node.label === '天宇法务天团'));
  assert.ok(merged.graphEdges.some(edge => edge.target === 'entity:天宇法务' && edge.source === 'chapter:9'));
  assert.ok(merged.graphEdges.some(edge => edge.target === 'card:5' && edge.source === 'chapter:9'));
  assert.ok(!merged.graphNodes.some(node => node.label === '冬至家宴'));
  assert.ok(!(merged.graphPendingEntities || []).some(item => item.label === '冬至家宴'));
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
  // 韩正第一次出现，先进待升级表；别名与后缀都指向卡片节点，章节到卡片只有一条提及边
  assert.deepEqual(merged.graphNodes.filter(node => node.type === 'entity').map(node => node.label), []);
  assert.deepEqual(merged.graphPendingEntities?.map(item => item.label), ['韩正']);
  assert.equal(merged.graphEdges.filter(edge => edge.target === 'card:3' && edge.label === '章节提及').length, 1);
  // 泛称之间的关系整条丢掉，连到待升级实体的关系也先不连
  assert.ok(!merged.graphEdges.some(edge => edge.label === '委托'));
});
