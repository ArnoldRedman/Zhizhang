import type { Chapter, KnowledgeCard, KnowledgeGraphEdge, KnowledgeGraphNode, Project } from './project.ts';
import { cardAliasTerms } from './cards.ts';
import { entityCoreLabel, isGenericEntityLabel, matchesCardTitleFragment, stripEntityTypeSuffix } from './entity-terms.ts';
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

/** 待升级实体最多留这么多条：一本长书一次性名词几千个，超出就丢最早的 */
const pendingEntityLimit = 3000;

/** 同一类家族：势力与组织、地点与场景互相算同类，人物与物品不算 */
const sameCategoryFamily = (left: string | undefined, right: string | undefined) => {
  const family = (value: string | undefined) => /人物|角色/u.test(value || '') ? '人物' : /势力|组织/u.test(value || '') ? '势力' : /地点|场景/u.test(value || '') ? '地点' : /物品|金手指/u.test(value || '') ? '物品' : value || '实体';
  return family(left) === family(right);
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
  let pending = [...(project.graphPendingEntities || [])];
  // 称呼 → 卡片节点：模型抽出"姜老董事长""大伯""沈妄（人物）"时都该落到已有的卡上，而不是各自成一个空节点
  const aliasIndex = new Map<string, string>();
  for (const card of project.cards) {
    for (const term of cardAliasTerms(card)) {
      if (term.length >= 2 && !aliasIndex.has(term)) aliasIndex.set(term, `card:${card.id}`);
    }
  }
  const findNodeId = (raw: string, category?: string) => {
    const label = stripEntityTypeSuffix(raw);
    const byAlias = aliasIndex.get(label) || aliasIndex.get(raw);
    if (byAlias) return byAlias;
    const byLabel = nodes.find(node => node.label === label || node.label === raw)?.id;
    if (byLabel) return byLabel;
    const core = entityCoreLabel(raw, category);
    // 核心名相同的实体（"天宇法务部"对"天宇法务"）、或是某张地点/势力卡标题的一段（"梧桐路601"对"江城梧桐路58号老洋房顶楼601"）
    const byCore = nodes.find(node => node.type === 'entity' && sameCategoryFamily(node.category, category) && entityCoreLabel(node.label, node.category) === core)?.id;
    if (byCore) return byCore;
    if (!/人物|角色/u.test(category || '')) {
      const card = project.cards.find(item => sameCategoryFamily(item.type, category) && matchesCardTitleFragment(raw, item.title));
      if (card) return `card:${card.id}`;
    }
    return undefined;
  };
  /**
   * 拿到实体的节点 id；对不上任何已有节点的：第一次见先记进待升级表，同一个东西第二次在别的章出现才建节点
   * 事件不建节点：章节本身就是事件，记忆的时间线也记着；泛称（"爷爷""韩律师"）对不上卡就不要
   */
  const ensureEntity = (raw: string, category = '实体') => {
    const normalized = stripEntityTypeSuffix(raw).slice(0, 80);
    if (!normalized) return null;
    const existingId = findNodeId(normalized, category);
    if (existingId) return existingId;
    if (isGenericEntityLabel(normalized, category) || /事件/u.test(category)) return null;
    const core = entityCoreLabel(normalized, category);
    const seen = pending.find(item => sameCategoryFamily(item.category, category) && entityCoreLabel(item.label, item.category) === core);
    if (!seen) {
      pending.push({ label: normalized, category, chapterIds: [chapter.id] });
      return null;
    }
    if (seen.chapterIds.includes(chapter.id)) return null;
    // 第二次出现：升为节点，节点名用两次里较短的那个（"桑皮纸"而不是"桑皮纸样本"），把之前那几章的提及边一起补上
    const label = normalized.length < seen.label.length ? normalized : seen.label;
    const id = `entity:${label}`;
    nodes.push({ id, label, type: 'entity', category, content: createGraphNodeProfile('entity', category), updatedAt: now });
    for (const chapterId of seen.chapterIds) {
      upsertKnowledgeGraphEdge(edges, { id: `chapter:${chapterId}->${id}`, source: `chapter:${chapterId}`, target: id, label: '章节提及', weight: 0.7, sourceChapterId: chapterId, updatedAt: now });
    }
    pending = pending.filter(item => item !== seen);
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
    // 关系只连已有节点：一端还在待升级表里的关系，等它升级后由后面的章重新给；关系里的名字不登记待升级，类别不明
    const source = findNodeId(sourceLabel);
    const target = findNodeId(targetLabel);
    if (!source || !target || source === target) continue;
    const label = String(relation.label || '关联').trim().slice(0, 40) || '关联';
    upsertKnowledgeGraphEdge(edges, { id: `${source}->${target}:${label}`, source, target, label, weight: normalizeKnowledgeGraphWeight(relation.weight, label), sourceChapterId: chapter.id, updatedAt: now });
  }
  // 补历史时关掉：那批卡片状态要统一用"按正文定位"的结果，不能让模型正文各写一半
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
  return { ...project, cards, graphNodes: nodes, graphEdges: edges, graphPendingEntities: pending.slice(-pendingEntityLimit), updatedAt: now };
};
