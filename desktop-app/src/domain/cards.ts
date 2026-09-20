import type { Chapter, KnowledgeCard, KnowledgeGraphEdge, KnowledgeGraphNode, Project } from './project.ts';
import { upsertKnowledgeGraphEdge } from './knowledge-graph.ts';

/**
 * 卡片状态回填
 * 这里原来整段内联在 App.tsx 里，只有作者在那张卡的点选状态下手动触发；批量补全记忆时
 * 同样需要按正文重新定位每张卡最近出现在哪几章，所以抽成纯函数供两边共用
 */

/** 卡片名称容易被拆出这些没有检索价值的通用词 */
const genericCardTerms = new Set([
  '角色', '角色卡', '人物', '人物卡', '物品', '物品卡', '地点', '地点卡', '势力', '势力卡',
  '金手指', '金手指卡', '手指', '身份', '性格', '目标', '能力', '天赋', '关系', '当前状态',
  '详细信息', '暂无', '设定', '限制', '代价', '升级路径', '触发条件', '核心能力',
]);

/**
 * 从卡片标题和正文里抽出用于在正文中定位这张卡的检索词
 * 主词 = 卡名、别名、能力名这类能唯一定位的词；次词 = 正文里的汉字片段
 * 分开返回是因为次词误命中率很高（“卷一”“殿堂”这类），调用方要能只信主词
 */
export const cardSearchTermGroups = (card: KnowledgeCard): { primary: string[]; secondary: string[] } => {
  const primaryTerms: string[] = [];
  const secondaryTerms = new Set<string>();
  const addPrimary = (value: string) => {
    const normalized = value.replace(/^[#*\-\s]+|[#*\-\s]+$/gu, '').replace(/[“”"']/gu, '').trim();
    if (normalized.length >= 2 && normalized.length <= 24 && !genericCardTerms.has(normalized) && !primaryTerms.includes(normalized)) primaryTerms.push(normalized);
  };
  const addSecondary = (value: string) => {
    const normalized = value.replace(/^[#*\-\s]+|[#*\-\s]+$/gu, '').trim();
    if (normalized.length >= 2 && normalized.length <= 12 && !genericCardTerms.has(normalized) && !primaryTerms.includes(normalized)) secondaryTerms.add(normalized);
  };
  const content = card.content || '';
  if (!genericCardTerms.has(card.title.trim())) addPrimary(card.title);
  const canonicalTitle = card.title.replace(/^(主角|角色|人物|本命|关键|核心)/u, '').trim();
  if (!genericCardTerms.has(canonicalTitle)) addPrimary(canonicalTitle);
  // 只对“人名”长度的标题取尾字（“主角沈妄” → “沈妄”“妄”）：
  // 地点卡那种长描述标题取尾字只会得到“中心”“法庭”这种到处都有的词，反而制造假命中
  if (!genericCardTerms.has(canonicalTitle) && /^[\u3400-\u9fff]{3,6}$/u.test(canonicalTitle)) {
    addPrimary(canonicalTitle.slice(-2));
    if (canonicalTitle.length > 3) addPrimary(canonicalTitle.slice(-3));
  }
  const identityPattern = /^\s*(?:[-*]\s*)?(?:姓名|名称|本名|别名|称号|代号|简称|天赋名称|能力名称)\s*[：:]\s*(.+)$/gmu;
  for (const match of content.matchAll(identityPattern)) {
    for (const value of match[1].split(/[、,，;；/]/u)) addPrimary(value.replace(/[（(].*$/u, '').trim());
  }
  const abilityHeadingPattern = /^\s*#{2,6}\s*(?:[^\n：:]{0,24}[：:])\s*([^\n]+)$/gmu;
  for (const match of content.matchAll(abilityHeadingPattern)) {
    for (const value of match[1].split(/[、,，;；/]/u)) addPrimary(value.replace(/[（(].*$/u, '').trim());
  }
  for (const segment of `${card.title}\n${content}`.match(/[\u3400-\u9fff]{2,10}|[A-Za-z][A-Za-z0-9_-]{1,24}/g) || []) {
    addSecondary(segment);
  }
  return {
    primary: primaryTerms.slice(0, 24),
    secondary: [...secondaryTerms].sort((left, right) => right.length - left.length).slice(0, 40),
  };
};

/** 扁平检索词列表：主词在前，次词在后 */
export const cardSearchTerms = (card: KnowledgeCard): string[] => {
  const groups = cardSearchTermGroups(card);
  return [...groups.primary, ...groups.secondary];
};

/**
 * 从最后一章往前找这张卡出现的章节与原文片段
 * 只用主词（卡名/别名/能力名）：次词会命中“卷一”“殿堂”这类片段，写进状态就是假信息，
 * 地点卡这种长描述标题宁可什么都不写（状态就是“未在正文中定位”）
 */
export const findCardRecentMentions = (project: Project, card: KnowledgeCard, limit = 3) =>
  collectCardMentions(project, cardSearchTermGroups(card).primary, limit);

const collectCardMentions = (project: Project, terms: string[], limit: number) => {
  const mentions: Array<{ chapter: Chapter; matchedTerm: string; snippet: string; position: number }> = [];
  for (const chapter of [...project.chapters].reverse()) {
    const content = chapter.content || '';
    const positions = terms.flatMap(term => {
      const found: Array<{ term: string; position: number }> = [];
      let position = content.indexOf(term);
      while (position >= 0 && found.length < 8) {
        found.push({ term, position });
        position = content.indexOf(term, position + term.length);
      }
      return found;
    }).sort((left, right) => right.position - left.position);
    for (const match of positions.slice(0, limit)) {
      const { position, term: matchedTerm } = match;
      const start = Math.max(0, position - 70);
      const end = Math.min(content.length, position + matchedTerm.length + 150);
      mentions.push({ chapter, matchedTerm, position, snippet: content.slice(start, end).replace(/\s+/gu, ' ').trim() });
    }
  }
  return mentions.slice(0, limit);
};

/**
 * 按正文重新关联卡片与章节；只处理 cardIds 指定的卡（不传就是全部）
 * 以前这里还把卡名最后一次出现处前后二百字塞进"当前状态"和"状态历史"，写的是"第 N 章《…》出现"沈妄"：起眼。医生已经在写……"
 * 这种随机片段：它既不是状态也不是性格，还会把记忆提炼写进去的真状态覆盖掉，模型看到的主角就只剩这段废话。
 * 现在只维护图谱里"章节 → 卡片"的引用边，卡片状态一律由记忆提炼（cardUpdates）和作者手改
 */
export const refreshCardStatesForProject = (project: Project, cardIds?: Set<number>): Project => {
  const now = new Date().toISOString();
  const targetCards = cardIds ? project.cards.filter(card => cardIds.has(card.id)) : project.cards;
  if (!targetCards.length) return project;
  const graphNodes: KnowledgeGraphNode[] = [...project.graphNodes];
  const graphEdges: KnowledgeGraphEdge[] = [...project.graphEdges];
  project.cards.forEach(card => {
    if (!graphNodes.some(node => node.id === `card:${card.id}`)) {
      graphNodes.push({ id: `card:${card.id}`, label: card.title, type: 'card', category: card.type });
    }
  });
  for (const card of targetCards) {
    for (const item of findCardRecentMentions(project, card, 3)) {
      const chapterNodeId = `chapter:${item.chapter.id}`;
      if (!graphNodes.some(node => node.id === chapterNodeId)) graphNodes.push({ id: chapterNodeId, label: item.chapter.title, type: 'chapter' });
      const edgeId = `${chapterNodeId}->card:${card.id}:状态引用`;
      upsertKnowledgeGraphEdge(graphEdges, { id: edgeId, source: chapterNodeId, target: `card:${card.id}`, label: '状态引用', weight: 0.88, updatedAt: now });
    }
  }
  return { ...project, graphNodes, graphEdges, updatedAt: now };
};

/** 旧版按正文片段写进去的卡片状态：形状固定，读档时按它认出来清掉，别让这些废话继续占着"当前状态" */
const heuristicCardState = /出现“[^”]*”：|当前全文未检索到可定位/u;

/** 清掉旧版启发式写进卡片的状态与历史；没有这种残留时原样返回，不制造无关差异 */
export const stripHeuristicCardStates = (cards: KnowledgeCard[]): KnowledgeCard[] => {
  let changed = false;
  const cleaned = cards.map(card => {
    const stateIsHeuristic = heuristicCardState.test(card.currentState || '');
    const history = (card.stateHistory || []).filter(item => !heuristicCardState.test(item.changes || ''));
    if (!stateIsHeuristic && history.length === (card.stateHistory || []).length) return card;
    changed = true;
    // 状态被清空后退回最近一条真实变化，卡片面板上不至于一片空白
    const currentState = stateIsHeuristic ? (history[history.length - 1]?.changes || '') : card.currentState;
    return { ...card, currentState, stateHistory: history };
  });
  return changed ? cleaned : cards;
};
