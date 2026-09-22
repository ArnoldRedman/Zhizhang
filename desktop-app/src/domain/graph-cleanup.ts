import type { KnowledgeGraphEdge, KnowledgeGraphNode, Project } from './project.ts';
import { cardAliasTerms } from './cards.ts';
import { isGenericEntityLabel, isSurnamedHonorific, stripEntityTypeSuffix } from './entity-terms.ts';
import { graphNodeProfileIsEmpty, normalizeKnowledgeGraphEdges, upsertKnowledgeGraphEdge } from './knowledge-graph.ts';

/**
 * 知识图谱清理
 * 一本 204 章的书攒了 1264 个实体节点，全部是建节点时的空模板，470 个只连着一条"章节提及"；
 * 同一个人裂成"姜正霖""姜正林""姜老太爷""老太爷""爷爷""姜正林（人物）"六个节点。
 * 这里是不调模型的那一半：并同名、并别名、并类型后缀、删泛称、删长尾；拿不准的错别字与尊称交给模型那一半
 */

/** 只表示"这一章提到了它"的边：长尾判断时不算真正的关系 */
const mentionLabels = new Set(['章节提及', '正文提及', '状态引用', '本章引用']);

export interface GraphCleanupReport {
  merged: Array<{ from: string; to: string; reason: string }>;
  removed: Array<{ label: string; reason: string }>;
}

const edgeIdFor = (edge: KnowledgeGraphEdge, source: string, target: string) => {
  // 章节到实体的边 id 沿用 `${chapter}->${entity}`，关系边沿用 `${source}->${target}:${label}`，和 graph-merge 里的写法一致，否则同一条关系会存两遍
  if (/^chapter:/u.test(source) && mentionLabels.has(edge.label)) return `${source}->${target}`;
  return `${source}->${target}:${edge.label}`;
};

/**
 * 把一个节点并进另一个：边全部改指向目标，自环丢掉，同 id 的边取权重高的；被并节点的档案若有人写过内容，接到目标档案末尾
 */
export const mergeGraphNodes = (project: Project, fromId: string, toId: string): Project => {
  if (fromId === toId) return project;
  const from = project.graphNodes.find(node => node.id === fromId);
  const to = project.graphNodes.find(node => node.id === toId);
  if (!from || !to) return project;
  const now = new Date().toISOString();
  const edges: KnowledgeGraphEdge[] = [];
  for (const edge of normalizeKnowledgeGraphEdges(project.graphEdges)) {
    if (edge.source !== fromId && edge.target !== fromId) {
      upsertKnowledgeGraphEdge(edges, edge);
      continue;
    }
    const source = edge.source === fromId ? toId : edge.source;
    const target = edge.target === fromId ? toId : edge.target;
    if (source === target) continue;
    upsertKnowledgeGraphEdge(edges, { ...edge, id: edgeIdFor(edge, source, target), source, target, updatedAt: now });
  }
  const fromProfile = graphNodeProfileIsEmpty(from) ? '' : (from.content || '').trim();
  const mergedTo: KnowledgeGraphNode = fromProfile
    ? { ...to, content: `${(to.content || '').trim()}\n\n## 并入自「${from.label}」\n${fromProfile}`, updatedAt: now }
    : to;
  return {
    ...project,
    graphNodes: project.graphNodes.filter(node => node.id !== fromId).map(node => node.id === toId ? mergedTo : node),
    graphEdges: edges,
    updatedAt: now,
  };
};

export const removeGraphNode = (project: Project, id: string): Project => {
  if (!project.graphNodes.some(node => node.id === id)) return project;
  return {
    ...project,
    graphNodes: project.graphNodes.filter(node => node.id !== id),
    graphEdges: project.graphEdges.filter(edge => edge.source !== id && edge.target !== id),
    updatedAt: new Date().toISOString(),
  };
};

/** 卡片正名与全部称呼 → 卡片节点 id；图谱合并、记忆提炼的正名表都用它 */
export const cardAliasIndex = (project: Project): Map<string, string> => {
  const index = new Map<string, string>();
  for (const card of project.cards) {
    for (const term of cardAliasTerms(card)) {
      if (term.length >= 2 && !index.has(term)) index.set(term, `card:${card.id}`);
    }
  }
  return index;
};

/**
 * 同姓、等长、只差一个字的三字以上人名：几乎都是模型的错别字（"姜正林"对"姜正霖"）
 * 只在目标是卡片正名时才认，两个都不是卡片的不猜；两个字的名字差一个字就是另一个人，不算
 */
const looksLikeTypoOf = (label: string, canonical: string) => {
  if (label.length !== canonical.length || label.length < 3 || label[0] !== canonical[0]) return false;
  let diff = 0;
  for (let index = 0; index < label.length; index += 1) {
    if (label[index] !== canonical[index]) diff += 1;
  }
  return diff === 1;
};

/**
 * 不调模型的清理：按顺序做五件事，每一步都基于上一步的结果
 * 1. 实体名等于卡片正名或别名（含类型后缀剥掉后）→ 并进卡片节点
 * 2. 同一标签的实体（剥掉后缀后相同）→ 并进边最多的那个
 * 3. 三字以上人名和某张卡只差一个字 → 并进卡片（错别字）
 * 4. 泛称（爷爷、韩律师、四名年轻学徒）→ 删
 * 5. 长尾：只连着"提及"边且不超过一条、档案是空模板 → 删
 */
export const cleanupKnowledgeGraph = (project: Project, options: { deferHonorifics?: boolean } = {}): { project: Project; report: GraphCleanupReport } => {
  const report: GraphCleanupReport = { merged: [], removed: [] };
  let next = project;
  const aliasIndex = cardAliasIndex(project);
  const entityNodes = () => next.graphNodes.filter(node => node.type === 'entity');
  const degree = () => {
    const counts = new Map<string, number>();
    for (const edge of next.graphEdges) {
      counts.set(edge.source, (counts.get(edge.source) || 0) + 1);
      counts.set(edge.target, (counts.get(edge.target) || 0) + 1);
    }
    return counts;
  };

  // 1. 别名与后缀并进卡片
  for (const node of entityNodes()) {
    const label = stripEntityTypeSuffix(node.label);
    const target = aliasIndex.get(label) || aliasIndex.get(node.label);
    if (!target || !next.graphNodes.some(item => item.id === target)) continue;
    report.merged.push({ from: node.label, to: next.graphNodes.find(item => item.id === target)?.label || target, reason: label === node.label ? '卡片别名' : '类型后缀' });
    next = mergeGraphNodes(next, node.id, target);
  }

  // 2. 同名实体互并：剥掉后缀后标签相同，留边最多的那个
  const byLabel = new Map<string, KnowledgeGraphNode[]>();
  for (const node of entityNodes()) {
    const label = stripEntityTypeSuffix(node.label);
    byLabel.set(label, [...(byLabel.get(label) || []), node]);
  }
  for (const [label, group] of byLabel) {
    if (group.length < 2) continue;
    const counts = degree();
    const keep = [...group].sort((left, right) => (counts.get(right.id) || 0) - (counts.get(left.id) || 0) || (right.label === label ? 1 : 0) - (left.label === label ? 1 : 0))[0];
    for (const node of group) {
      if (node.id === keep.id) continue;
      report.merged.push({ from: node.label, to: keep.label, reason: '同名' });
      next = mergeGraphNodes(next, node.id, keep.id);
    }
    if (keep.label !== label) next = { ...next, graphNodes: next.graphNodes.map(node => node.id === keep.id ? { ...node, label } : node) };
  }

  // 3. 错别字并进卡片
  const cardTitles = project.cards.map(card => ({ id: `card:${card.id}`, title: card.title.trim() })).filter(item => item.title.length >= 3);
  for (const node of entityNodes()) {
    if (!/人物|角色/u.test(node.category || '')) continue;
    const hit = cardTitles.find(card => looksLikeTypoOf(node.label, card.title));
    if (!hit || !next.graphNodes.some(item => item.id === hit.id)) continue;
    report.merged.push({ from: node.label, to: hit.title, reason: '疑似错别字' });
    next = mergeGraphNodes(next, node.id, hit.id);
  }

  // 3b. 两个字的昵称并进三个字的同尾人名："晓宇"是"宋晓宇"、"冷月"是"姜冷月"；先看卡片，再看图里的人物实体，都只认唯一命中
  for (const node of entityNodes()) {
    if (!/人物|角色/u.test(node.category || '') || node.label.length !== 2) continue;
    const cardHits = project.cards.filter(card => card.title.trim().length === 3 && card.title.trim().endsWith(node.label)).map(card => ({ id: `card:${card.id}`, label: card.title.trim() }));
    const entityHits = entityNodes().filter(item => item.id !== node.id && /人物|角色/u.test(item.category || '') && item.label.length === 3 && item.label.endsWith(node.label)).map(item => ({ id: item.id, label: item.label }));
    const hits = cardHits.length ? cardHits : entityHits;
    if (hits.length !== 1 || !next.graphNodes.some(item => item.id === hits[0].id)) continue;
    report.merged.push({ from: node.label, to: hits[0].label, reason: '昵称' });
    next = mergeGraphNodes(next, node.id, hits[0].id);
  }

  // 4. 泛称删掉；带姓的尊称（"姜老太爷""夏老"）被提过两次以上的先留着，等模型判它是谁再并进正主，模型不跑时才删
  const degreesBeforeRemoval = degree();
  for (const node of entityNodes()) {
    if (!isGenericEntityLabel(node.label)) continue;
    if (options.deferHonorifics && isSurnamedHonorific(node.label) && (degreesBeforeRemoval.get(node.id) || 0) >= 2) continue;
    report.removed.push({ label: node.label, reason: '称谓或泛称，不是具名实体' });
    next = removeGraphNode(next, node.id);
  }

  // 5. 长尾删掉：只有一条提及边、没人写过档案
  const counts = degree();
  for (const node of entityNodes()) {
    if (!graphNodeProfileIsEmpty(node)) continue;
    const edges = next.graphEdges.filter(edge => edge.source === node.id || edge.target === node.id);
    if ((counts.get(node.id) || 0) > 1 || edges.some(edge => !mentionLabels.has(edge.label))) continue;
    report.removed.push({ label: node.label, reason: '只在一章被提到过，没有任何关系与档案' });
    next = removeGraphNode(next, node.id);
  }
  return { project: next, report };
};

/** 规则清理时留给模型判的带姓尊称：模型那步过后仍在图里的，说明模型也不知道是谁，按泛称删 */
export const deferredHonorifics = (project: Project): KnowledgeGraphNode[] => project.graphNodes
  .filter(node => node.type === 'entity' && isGenericEntityLabel(node.label) && isSurnamedHonorific(node.label));

/** 模型那一半返回的合并与删除建议 */
export interface GraphDedupeSuggestion {
  merges: Array<{ from: string; to: string; reason?: string }>;
  removes: Array<{ name: string; reason?: string }>;
}

/**
 * 把模型给的建议落到图上：from 必须是现有实体名，to 是卡片称呼或另一个实体名；对不上的建议跳过
 * 模型有时把 to 写成 from 自己、或两个方向各给一次，这里只认第一次
 */
export const applyGraphDedupeSuggestion = (project: Project, suggestion: GraphDedupeSuggestion): { project: Project; report: GraphCleanupReport } => {
  const report: GraphCleanupReport = { merged: [], removed: [] };
  let next = project;
  const aliasIndex = cardAliasIndex(project);
  const entityByLabel = (label: string) => next.graphNodes.find(node => node.type === 'entity' && stripEntityTypeSuffix(node.label) === stripEntityTypeSuffix(label));
  const resolveTarget = (label: string) => {
    const cardId = aliasIndex.get(stripEntityTypeSuffix(label));
    if (cardId && next.graphNodes.some(node => node.id === cardId)) return next.graphNodes.find(node => node.id === cardId);
    return entityByLabel(label);
  };
  for (const merge of suggestion.merges) {
    const from = entityByLabel(String(merge.from || ''));
    const to = resolveTarget(String(merge.to || ''));
    if (!from || !to || from.id === to.id) continue;
    report.merged.push({ from: from.label, to: to.label, reason: String(merge.reason || '模型判定同一实体') });
    next = mergeGraphNodes(next, from.id, to.id);
  }
  for (const remove of suggestion.removes) {
    const node = entityByLabel(String(remove.name || ''));
    if (!node) continue;
    report.removed.push({ label: node.label, reason: String(remove.reason || '模型判定不是具名实体') });
    next = removeGraphNode(next, node.id);
  }
  return { project: next, report };
};
