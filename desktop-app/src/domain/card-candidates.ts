import type { CardType, Project } from './project.ts';
import { cardAliasTerms } from './cards.ts';
import { isGenericEntityLabel } from './entity-terms.ts';

/**
 * 待建卡候选：从图谱里推导，不再靠记忆提炼说"本章新出现"
 * 以前的标准是"模型觉得这一章第一次出现的具名东西"，等于没有标准：定胜糕、针插盒、送函的年轻人全被列成候选，
 * 一本书攒了 127 条没人动。现在只认反复出现：一个东西在好几章里被提到、图谱里有节点、却没有卡，才值得建卡。
 * 出现的章数就是标准，界面上把章号列出来，作者一眼能判断
 */
export interface DerivedCardCandidate {
  /** 用来忽略和去重的键：实体名去掉括号说明 */
  key: string;
  label: string;
  category: string;
  type: CardType;
  /** 提到它的章号，升序 */
  chapterNumbers: number[];
}

/** 人物三章就算反复出现；地点、势力、物件要四章，名字还得三个字以上（"江城""西廊"这种两个字的不建） */
export const cardCandidateThresholds = { 人物: 3, 其他: 4 } as const;

const typeFor = (category: string): CardType => /人物|角色/u.test(category) ? '角色卡' : /地点|场景/u.test(category) ? '地点卡' : /势力|组织/u.test(category) ? '势力卡' : '物品卡';

export const cardCandidateKey = (label: string) => label.replace(/[（(][^）)]*[）)]/gu, '').split(/[：:]/u)[0].trim();

export const deriveCardCandidates = (project: Project): DerivedCardCandidate[] => {
  const chapterNumberById = new Map(project.chapters.map((chapter, index) => [`chapter:${chapter.id}`, index + 1]));
  const mentions = new Map<string, Set<number>>();
  for (const edge of project.graphEdges) {
    const [chapterId, entityId] = edge.source.startsWith('chapter:') ? [edge.source, edge.target] : [edge.target, edge.source];
    if (!chapterId.startsWith('chapter:') || !entityId.startsWith('entity:')) continue;
    const number = chapterNumberById.get(chapterId);
    if (!number) continue;
    mentions.set(entityId, (mentions.get(entityId) || new Set<number>()).add(number));
  }
  const cardNames = new Set(project.cards.flatMap(card => cardAliasTerms(card)));
  const ignored = new Set(project.ignoredCardCandidates || []);
  return project.graphNodes
    .filter(node => node.type === 'entity')
    .flatMap(node => {
      const key = cardCandidateKey(node.label);
      const category = node.category || '实体';
      const person = /人物|角色/u.test(category);
      if (!key || ignored.has(key) || cardNames.has(key) || cardNames.has(node.label) || isGenericEntityLabel(node.label, category)) return [];
      if (!person && key.length < 3) return [];
      const chapters = [...(mentions.get(node.id) || [])].sort((left, right) => left - right);
      if (chapters.length < (person ? cardCandidateThresholds.人物 : cardCandidateThresholds.其他)) return [];
      return [{ key, label: node.label, category, type: typeFor(category), chapterNumbers: chapters }];
    })
    .sort((left, right) => right.chapterNumbers.length - left.chapterNumbers.length || left.label.localeCompare(right.label, 'zh-CN'));
};

/** 作者点"忽略"：记下键，之后再反复出现也不提 */
export const ignoreCardCandidate = (project: Project, key: string): Project => ({
  ...project,
  ignoredCardCandidates: Array.from(new Set([...(project.ignoredCardCandidates || []), key])).slice(-300),
  updatedAt: new Date().toISOString(),
});

/**
 * 给卡片智能体的正文依据：提到它的最近几章里，围绕它出现位置各截一段
 * 只送尾八千字的话，一个第 3 章出场、第 30 章再出现的人，模型只能看见第 30 章那一句
 */
export const candidateExcerpts = (project: Project, candidate: DerivedCardCandidate, limit = 3, radius = 700): string => candidate.chapterNumbers
  .slice(-limit)
  .flatMap(number => {
    const chapter = project.chapters[number - 1];
    if (!chapter) return [];
    const position = chapter.content.indexOf(candidate.key);
    const start = position < 0 ? 0 : Math.max(0, position - radius);
    const excerpt = chapter.content.slice(start, position < 0 ? radius * 2 : position + candidate.key.length + radius).trim();
    return excerpt ? [`### ${chapter.title}\n${excerpt}`] : [];
  })
  .join('\n\n');
