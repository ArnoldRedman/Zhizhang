import type { Chapter, KnowledgeCard, KnowledgeGraphEdge, KnowledgeGraphNode, Project } from './project.ts';
import { cardSearchTerms } from './cards.ts';
import { createGraphNodeProfile, normalizeKnowledgeGraphEdges, normalizeKnowledgeGraphWeight, upsertKnowledgeGraphEdge } from './knowledge-graph.ts';

/**
 * 把一次章节记忆提炼的结果合并进知识图谱与卡片状态
 * 原来是内联在 App.tsx 的保存流程里；补历史记忆时同样需要这套合并规则，
 * 两处各写一份必然漂移，所以抽成纯函数
 */
export type MemoryGraphInput = {
  entities?: Array<{ name?: string; type?: string }>;
  relations?: Array<{ source?: string; target?: string; label?: string; weight?: number }>;
  cardUpdates?: Array<{ cardId?: number | string; cardTitle?: string; status?: string; changes?: string }>;
};

export const mergeKnowledgeGraph = (
  project: Project,
  chapter: Chapter,
  result: MemoryGraphInput,
  options: { cardUpdates?: boolean } = {},
): Project => {
  const chapterNodeId = `chapter:${chapter.id}`;
  const nodes: KnowledgeGraphNode[] = [...project.graphNodes];
  const edges: KnowledgeGraphEdge[] = normalizeKnowledgeGraphEdges(project.graphEdges);
  const now = new Date().toISOString();
  let cards: KnowledgeCard[] = project.cards;
  const findNodeId = (label: string) => nodes.find(node => node.label === label)?.id
    || project.cards.find(card => cardSearchTerms(card).includes(label))?.id.toString().replace(/^/, 'card:');
  const ensureEntity = (label: string, category = '实体') => {
    const normalized = label.trim().slice(0, 80);
    if (!normalized) return null;
    const existingId = findNodeId(normalized);
    if (existingId) return existingId;
    const id = `entity:${normalized}`;
    nodes.push({ id, label: normalized, type: 'entity', category, content: createGraphNodeProfile('entity', category), updatedAt: now });
    return id;
  };
  if (!nodes.some(node => node.id === chapterNodeId) && chapter.content.trim()) {
    nodes.push({ id: chapterNodeId, label: chapter.title, type: 'chapter', content: createGraphNodeProfile('chapter'), updatedAt: now });
  }
  project.cards.forEach(card => {
    if (!nodes.some(node => node.id === `card:${card.id}`)) nodes.push({ id: `card:${card.id}`, label: card.title, type: 'card', category: card.type, content: createGraphNodeProfile('card', card.type), updatedAt: now });
  });
  project.outlines.forEach(outline => {
    if (!nodes.some(node => node.id === `outline:${outline.id}`)) nodes.push({ id: `outline:${outline.id}`, label: outline.title, type: 'outline', category: outline.kind, content: createGraphNodeProfile('outline', outline.kind), updatedAt: now });
  });
  for (const entity of result.entities || []) {
    const id = ensureEntity(String(entity.name || ''), String(entity.type || '实体'));
    if (!id) continue;
    upsertKnowledgeGraphEdge(edges, { id: `${chapterNodeId}->${id}`, source: chapterNodeId, target: id, label: '章节提及', weight: 0.7, sourceChapterId: chapter.id, updatedAt: now });
  }
  for (const relation of result.relations || []) {
    const sourceLabel = String(relation.source || '').trim();
    const targetLabel = String(relation.target || '').trim();
    if (!sourceLabel || !targetLabel) continue;
    const source = findNodeId(sourceLabel) || ensureEntity(sourceLabel);
    const target = findNodeId(targetLabel) || ensureEntity(targetLabel);
    if (!source || !target || source === target) continue;
    const label = String(relation.label || '关联').trim().slice(0, 40) || '关联';
    upsertKnowledgeGraphEdge(edges, { id: `${source}->${target}:${label}`, source, target, label, weight: normalizeKnowledgeGraphWeight(relation.weight, label), sourceChapterId: chapter.id, updatedAt: now });
  }
  // 补历史时关掉：那批卡片状态要统一用“按正文定位”的结果，不能让模型正文各写一半
  if (options.cardUpdates !== false) {
    for (const update of result.cardUpdates || []) {
      const card = cards.find(item => (update.cardId !== undefined && String(item.id) === String(update.cardId)) || (update.cardTitle && item.title === update.cardTitle));
      const changes = String(update.changes || '').trim();
      if (!card || !changes) continue;
      const status = String(update.status || 'updated').trim();
      const lastEntry = card.stateHistory?.[card.stateHistory.length - 1];
      const stateHistory = lastEntry?.changes === changes ? (card.stateHistory || []) : [...(card.stateHistory || []), { chapterId: chapter.id, chapterTitle: chapter.title, status, changes, updatedAt: now }].slice(-30);
      cards = cards.map(item => item.id === card.id ? { ...item, currentState: changes, stateHistory, updatedAt: now } : item);
      upsertKnowledgeGraphEdge(edges, { id: `${chapterNodeId}->card:${card.id}:状态更新`, source: chapterNodeId, target: `card:${card.id}`, label: '状态更新', weight: 0.95, sourceChapterId: chapter.id, updatedAt: now });
    }
  }
  return { ...project, cards, graphNodes: nodes, graphEdges: edges, updatedAt: now };
};
