import type { KnowledgeGraphEdge, KnowledgeGraphNode } from './project';

/** 关系权重表示正文证据强度，不是模型猜测的重要程度 */
export const defaultKnowledgeGraphWeight = (label: string): number => {
  if (label === '本章引用') return 1;
  if (label === '状态更新') return 0.95;
  if (label === '章节主角') return 0.92;
  if (label === '状态引用') return 0.88;
  if (label === '正文提及') return 0.75;
  if (label === '章节提及') return 0.7;
  return 0.65;
};

export const normalizeKnowledgeGraphWeight = (value: unknown, label: string): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  const weight = Number.isFinite(parsed) ? parsed : defaultKnowledgeGraphWeight(label);
  return Math.round(Math.max(0.1, Math.min(1, weight)) * 100) / 100;
};

export const normalizeKnowledgeGraphEdges = (value: unknown): KnowledgeGraphEdge[] => Array.isArray(value)
  ? value.filter((edge): edge is Partial<KnowledgeGraphEdge> => Boolean(edge && typeof edge === 'object'))
    .map(edge => ({
      id: String(edge.id || `${edge.source || 'unknown'}->${edge.target || 'unknown'}:${edge.label || '关联'}`),
      source: String(edge.source || ''),
      target: String(edge.target || ''),
      label: String(edge.label || '关联'),
      weight: normalizeKnowledgeGraphWeight(edge.weight, String(edge.label || '关联')),
      sourceChapterId: edge.sourceChapterId,
      updatedAt: edge.updatedAt,
    })).filter(edge => edge.source && edge.target)
  : [];

export const upsertKnowledgeGraphEdge = (edges: KnowledgeGraphEdge[], next: KnowledgeGraphEdge) => {
  const nextWeight = normalizeKnowledgeGraphWeight(next.weight, next.label);
  const index = edges.findIndex(edge => edge.id === next.id);
  if (index < 0) {
    edges.push({ ...next, weight: nextWeight });
    return;
  }
  const existing = edges[index];
  edges[index] = {
    ...existing,
    ...next,
    weight: Math.max(normalizeKnowledgeGraphWeight(existing.weight, existing.label), nextWeight),
    updatedAt: next.updatedAt || existing.updatedAt,
  };
};

export const graphNodeTypeLabel = (node: KnowledgeGraphNode) => {
  if (node.type === 'chapter') return '章节';
  if (node.type === 'outline') return '大纲';
  if (node.type === 'card') return node.category || '知识卡';
  return node.category || '实体';
};

export const graphNodeGroup = (node: KnowledgeGraphNode) => {
  const type = graphNodeTypeLabel(node);
  if (/角色|人物/u.test(type)) return '重要角色';
  if (/地点|场景/u.test(type)) return '地点与场景';
  if (/势力|组织/u.test(type)) return '组织与势力';
  if (/物品|金手指/u.test(type)) return '物品与设定';
  if (node.type === 'chapter') return '章节事件';
  if (node.type === 'outline') return '大纲设定';
  return '其他实体';
};

export const graphNodeRelativePath = (node: KnowledgeGraphNode) => node.sourcePath || `图谱/${graphNodeGroup(node)}/${node.label}.md`;
export const graphNodeProfile = (node: KnowledgeGraphNode) => node.content?.trim() || `## 基础信息\n- 节点类型：${graphNodeTypeLabel(node)}\n- 当前状态：${node.status || '待补充'}\n\n## 档案\n待补充。`;
export const createGraphNodeProfile = (type: KnowledgeGraphNode['type'], category?: string) => `## 基础信息\n- 节点类型：${type === 'entity' ? category || '实体' : type === 'card' ? category || '知识卡' : type === 'chapter' ? '章节' : '大纲'}\n- 当前状态：待补充\n\n## 档案\n待补充。`;

/** 档案是不是还是建节点时那份模板：只有"待补充"，没有任何人写过内容 */
export const graphNodeProfileIsEmpty = (node: KnowledgeGraphNode) => {
  const text = (node.content || '').replace(/^#+\s*[^\n]*$/gmu, '').replace(/^-\s*(?:节点类型|当前状态|来源路径)\s*[：:][^\n]*$/gmu, '').replace(/待补充[。.]?/gu, '').replace(/暂无/gu, '').trim();
  return text.length < 8;
};

/** 没有打开小说时用的空数组：引用稳定，图谱页的缓存才不会因为每次渲染新建一个 [] 而失效 */
export const noGraphNodes: KnowledgeGraphNode[] = Object.freeze([]) as unknown as KnowledgeGraphNode[];
export const noGraphEdges: KnowledgeGraphEdge[] = Object.freeze([]) as unknown as KnowledgeGraphEdge[];

export interface GraphRelationSummary {
  /** 与该节点相连的关系，按权重从高到低 */
  edges: KnowledgeGraphEdge[];
  /** 权重之和，图谱文档视图按它排序 */
  strength: number;
}

/**
 * 每个节点的关系索引
 * 图谱页的排序、计数、孤立节点判断和详情都从这一份读；一本书近三千条关系时，
 * 对每个节点各扫一遍全部关系再排序，一次渲染要三百毫秒，而且以前每敲一个字都会重算
 */
export const buildGraphRelationIndex = (edges: KnowledgeGraphEdge[]): Map<string, GraphRelationSummary> => {
  const index = new Map<string, GraphRelationSummary>();
  const attach = (id: string, edge: KnowledgeGraphEdge) => {
    const entry = index.get(id) ?? { edges: [], strength: 0 };
    entry.edges.push(edge);
    entry.strength += normalizeKnowledgeGraphWeight(edge.weight, edge.label);
    index.set(id, entry);
  };
  for (const edge of edges) {
    attach(edge.source, edge);
    if (edge.target !== edge.source) attach(edge.target, edge);
  }
  for (const entry of index.values()) {
    entry.edges.sort((left, right) => normalizeKnowledgeGraphWeight(right.weight, right.label) - normalizeKnowledgeGraphWeight(left.weight, left.label));
  }
  return index;
};

export interface GraphLayoutPosition {
  id: string;
  /** 画布内的百分比坐标 */
  x: number;
  y: number;
}

/**
 * 关系视图的力导向布局
 * 黄金角螺旋起步，再跑 65 轮斥力与引力；节点两两计算，近千个节点一次要七八百毫秒，
 * 只能在图谱页打开、节点或关系变化时算一次，绝不能写在渲染函数体里
 */
export const computeGraphLayout = (nodes: KnowledgeGraphNode[], edges: KnowledgeGraphEdge[]): GraphLayoutPosition[] => {
  if (!nodes.length) return [];
  const positions = nodes.map((node, index) => {
    const angle = index * 2.399963229728653;
    const radius = 0.18 + 0.27 * Math.sqrt(index / Math.max(nodes.length - 1, 1));
    return { id: node.id, x: 0.5 + Math.cos(angle) * radius, y: 0.5 + Math.sin(angle) * radius };
  });
  const byId = new Map(positions.map(position => [position.id, position]));
  for (let iteration = 0; iteration < 65; iteration += 1) {
    for (let left = 0; left < positions.length; left += 1) {
      for (let right = left + 1; right < positions.length; right += 1) {
        const first = positions[left]; const second = positions[right];
        const dx = first.x - second.x; const dy = first.y - second.y;
        const distance = Math.max(0.025, Math.hypot(dx, dy));
        const force = Math.min(0.018, 0.0019 / (distance * distance));
        first.x += dx / distance * force; first.y += dy / distance * force;
        second.x -= dx / distance * force; second.y -= dy / distance * force;
      }
    }
    for (const edge of edges) {
      const source = byId.get(edge.source); const target = byId.get(edge.target);
      if (!source || !target) continue;
      const dx = target.x - source.x; const dy = target.y - source.y;
      const distance = Math.max(0.025, Math.hypot(dx, dy));
      const weight = normalizeKnowledgeGraphWeight(edge.weight, edge.label);
      const preferredDistance = 0.27 - weight * 0.11;
      const force = (distance - preferredDistance) * (0.018 + weight * 0.035);
      source.x += dx / distance * force; source.y += dy / distance * force;
      target.x -= dx / distance * force; target.y -= dy / distance * force;
    }
    positions.forEach(position => {
      position.x = Math.max(0.05, Math.min(0.95, position.x + (0.5 - position.x) * 0.004));
      position.y = Math.max(0.07, Math.min(0.93, position.y + (0.5 - position.y) * 0.004));
    });
  }
  return positions.map(position => ({ id: position.id, x: 5 + position.x * 90, y: 6 + position.y * 88 }));
};
