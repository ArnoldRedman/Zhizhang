import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildGraphRelationIndex, computeGraphLayout } from './knowledge-graph.ts';
import type { KnowledgeGraphEdge, KnowledgeGraphNode } from './project.ts';

const node = (id: string): KnowledgeGraphNode => ({ id, label: id, type: 'entity' });
const edge = (source: string, target: string, weight: number): KnowledgeGraphEdge => ({ id: `${source}->${target}`, source, target, label: '关联', weight });

test('关系索引按节点归并，权重从高到低，没有关系的节点不在索引里', () => {
  const index = buildGraphRelationIndex([edge('a', 'b', 0.3), edge('c', 'a', 0.9)]);
  assert.deepEqual(index.get('a')?.edges.map(item => item.id), ['c->a', 'a->b']);
  assert.ok(Math.abs((index.get('a')?.strength ?? 0) - 1.2) < 1e-9);
  assert.equal(index.get('b')?.edges.length, 1);
  assert.equal(index.has('d'), false);
});

test('自环关系只记一次', () => {
  const index = buildGraphRelationIndex([edge('a', 'a', 0.5)]);
  assert.equal(index.get('a')?.edges.length, 1);
});

test('布局给每个节点一个画布内的百分比坐标，同样的输入结果一致，空图返回空', () => {
  const nodes = ['a', 'b', 'c', 'd'].map(node);
  const edges = [edge('a', 'b', 0.9), edge('b', 'c', 0.5)];
  const layout = computeGraphLayout(nodes, edges);
  assert.equal(layout.length, 4);
  for (const position of layout) {
    assert.ok(position.x >= 0 && position.x <= 100);
    assert.ok(position.y >= 0 && position.y <= 100);
  }
  assert.deepEqual(computeGraphLayout(nodes, edges), layout);
  assert.deepEqual(computeGraphLayout([], []), []);
});
