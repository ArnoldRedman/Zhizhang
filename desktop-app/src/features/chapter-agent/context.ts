import type { Chapter, KnowledgeCard, OutlineDocument, Project } from '../../domain/project';
import type { Skill } from '../../domain/skill';
import type { WritingStyle } from '../../domain/library';
import { recentChapterMemories } from '../../domain/memory.ts';
import { cardSearchTermGroups } from '../../domain/cards.ts';
import { chapterBoundToOutline } from '../outline/model.ts';

/**
 * 章节智能体的入参组装
 * 从 App.tsx 的 runChapterAgent 里搬出来的纯函数：只看项目数据和作者的选择，不碰界面状态、会话 id 和模型配置。
 * 章节智能体到底能看到哪些资料，全部在这一处决定：
 * - 世界观与总纲固定带入，总纲由运行时压成骨架加当前阶段段落
 * - 当前章的章纲按绑定关系自动带入，作者勾选的其他章纲只做参考
 * - 卡片作者没勾时按章纲与上一章里出现的卡自动挑
 * - 前文只传紧邻上一章正文；更早的章节通过最近章节记忆和聚合文档进入
 */

/** 进入运行时检索库的聚合文档：角色认知/冲突/章节快照靠逐章记忆覆盖，任务书只带这四份 */
const contextDocumentKinds = new Set(['章节快照', '人物状态', '伏笔追踪', '时间线', '设定事实']);

/** 默认创作指令写的是“推进”而不是“悬念”：旧默认“在结尾留下自然的悬念”会让模型每章都在同一场景里再埋一个小钩子 */
export const defaultChapterInstruction = '按总纲的“本章位置”把主线推进到本阶段的下一步：开头一到三段承接上一章后就离开那个场景，本章相对上一章要有明确的时间或地点位移；结尾停在能继续发展的行动、发现或风险上，不为制造悬念另埋新线。';

const chapterRangePattern = /第\s*(\d{1,4})\s*[～~\-—–至到]\s*(\d{1,4})\s*章/gu;

/** 总纲里写的全部章号区间（卷与阶段都算） */
const outlineChapterRanges = (project: Project): Array<{ from: number; to: number }> => project.outlines
  .filter(outline => outline.kind === '总纲')
  .flatMap(outline => [...outline.content.matchAll(chapterRangePattern)].map(match => ({ from: Number(match[1]), to: Number(match[2]) })))
  .filter(range => Number.isFinite(range.from) && Number.isFinite(range.to) && range.to >= range.from);

/**
 * 阶段节拍表要规划到哪几章：总纲里有覆盖本章的区间就用它（阶段比卷小）
 * 只有卷级区间、跨度太大时，只规划从本章起的八章；总纲根本没写 178 章以后的区间时同样往后规划八章，
 * 否则作者得为了写下一章先在总纲里塞一段“第X～Y章”
 */
export const stageRangeFor = (project: Project, chapterNumber: number): { from: number; to: number } => {
  const containing = outlineChapterRanges(project)
    .filter(range => chapterNumber >= range.from && chapterNumber <= range.to)
    .sort((left, right) => (left.to - left.from) - (right.to - right.from))[0];
  if (!containing) return { from: chapterNumber, to: chapterNumber + 7 };
  if (containing.to - containing.from + 1 <= 12) return containing;
  return { from: chapterNumber, to: Math.min(containing.to, chapterNumber + 7) };
};

export const stageBeatsTitle = (range: { from: number; to: number }) => `阶段节拍｜第${range.from}～${range.to}章`;

/** 已存在的、覆盖本章的阶段节拍表（存在大纲页里，kind 为章纲、标题以“阶段节拍｜”开头，作者可改） */
export const stageBeatsFor = (project: Project, chapterNumber: number): OutlineDocument | undefined => project.outlines.find(outline => {
  if (outline.kind !== '章纲') return false;
  const match = /^阶段节拍｜第\s*(\d{1,4})\s*[～~\-—–至到]\s*(\d{1,4})\s*章/u.exec(outline.title);
  return Boolean(match) && chapterNumber >= Number(match![1]) && chapterNumber <= Number(match![2]) && outline.content.trim().length > 0;
});

/**
 * 作者没勾卡片时自动挑：金手指卡固定带入，其余按在章纲、上一章正文和指令里出现的次数排
 * 只用主词（卡名/别名/能力名），次词会把“中心”“法庭”这类到处都有的词当成命中
 */
const autoSelectCards = (project: Project, haystack: string, limit = 8): KnowledgeCard[] => project.cards
  .map(card => ({
    card,
    score: (card.type === '金手指卡' ? 100 : 0) + cardSearchTermGroups(card).primary.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0),
  }))
  .filter(entry => entry.score > 0)
  .sort((left, right) => right.score - left.score)
  .slice(0, limit)
  .map(entry => entry.card);

/**
 * 本次入场卡片：勾了就用勾的，没勾自己挑——懒人化就是这一条，不选也不会缺人物素材
 * 章纲生成与正文写作共用同一套规矩，免得一边自动一边空手
 */
export const effectiveCards = (project: Project, selectedCardIds: number[], haystack: string): KnowledgeCard[] => (selectedCardIds.length
  ? project.cards.filter(card => selectedCardIds.includes(card.id))
  : autoSelectCards(project, haystack));

export interface ChapterWriteContextInput {
  project: Project;
  chapter: Chapter;
  instruction: string;
  /** 全部可用技能（内置加自定义）；文风会作为一条额外技能追加 */
  skills: Skill[];
  preferredSkillNames: string[];
  /** 作者在面板里额外勾选的章纲 id，不含自动绑定的那份 */
  extraOutlineIds: number[];
  selectedCardIds: number[];
  writingStyle?: WritingStyle;
}

export interface ChapterWriteContext {
  /** 绑定到当前章的章纲；没有时智能体只能依据总纲与故事账本推进 */
  boundOutline: OutlineDocument | undefined;
  /** chapter.write 的资料部分，调用方再补 runId、会话与模型配置 */
  params: Record<string, unknown>;
}

/** 当前章的章纲：先认 chapterId，再认标题或章纲开头里的章号 */
export const boundChapterOutlineFor = (project: Project, chapter: Chapter): OutlineDocument | undefined =>
  project.outlines.find(outline => outline.kind === '章纲'
    && (String(outline.chapterId ?? '') === String(chapter.id) || chapterBoundToOutline(project, outline)?.id === chapter.id));

export const buildChapterWriteContext = (input: ChapterWriteContextInput): ChapterWriteContext => {
  const { project, chapter, writingStyle } = input;
  const chapterIndex = project.chapters.findIndex(item => item.id === chapter.id);
  const chapterNumber = chapterIndex + 1;
  const previousChapter = chapterIndex > 0 ? project.chapters[chapterIndex - 1] : undefined;
  const boundOutline = boundChapterOutlineFor(project, chapter);
  // 阶段节拍表不当普通章纲带：它单独走 stageBeats，运行时只取本章那一行
  const outlines = project.outlines.filter(outline => !outline.title.startsWith('阶段节拍｜') && (outline.kind === '世界观与作品设定' || outline.kind === '总纲'
    || outline.id === boundOutline?.id || input.extraOutlineIds.includes(outline.id)));
  const cards = effectiveCards(project, input.selectedCardIds, `${boundOutline?.content || ''}\n${(previousChapter?.content || '').slice(-8000)}\n${input.instruction}`);
  const skills = [
    ...input.skills,
    ...(writingStyle ? [{ name: `style-${writingStyle.id}`, category: 'write', description: writingStyle.description, tags: [...writingStyle.tags, '文风'], content: writingStyle.content }] : []),
  ].map(skill => ({ name: skill.name, displayName: 'displayName' in skill ? skill.displayName : undefined, category: skill.category, description: skill.description, tags: skill.tags, content: skill.content }));
  return {
    boundOutline,
    params: {
      projectId: String(project.id),
      projectTitle: project.title,
      chapterId: String(chapter.id),
      chapterNumber,
      totalChapters: project.chapters.length,
      targetWords: Number(project.chapterTargetWords) || 3000,
      instruction: writingStyle ? `${input.instruction}\n采用绑定文风 Skill「${writingStyle.name}」，只遵循抽象写作约束。` : input.instruction,
      outlines: outlines.map(outline => ({ id: outline.id, kind: outline.kind, title: outline.title, chapterId: outline.chapterId, content: outline.content })),
      activeOutlineId: boundOutline?.id,
      outline: boundOutline?.content || '',
      cards,
      knowledgeGraph: { nodes: project.graphNodes, edges: project.graphEdges },
      stageBeats: stageBeatsFor(project, chapterNumber)?.content,
      skills,
      preferredSkillNames: input.preferredSkillNames.filter(name => input.skills.some(skill => skill.name === name)),
      previousChapters: previousChapter ? [{ id: previousChapter.id, title: previousChapter.title, content: previousChapter.content }] : [],
      memories: recentChapterMemories(project, chapterNumber).map(memory => ({
        id: memory.id,
        chapterNumber: memory.chapterNumber,
        title: memory.chapterTitle,
        summary: memory.summary,
        keywords: memory.keywords,
        characterStateChanges: memory.characterStateChanges,
        knowledgeChanges: memory.knowledgeChanges,
        foreshadowingChanges: memory.foreshadowingChanges,
        foreshadowingItems: memory.foreshadowingItems || [],
        timelineEvents: memory.timelineEvents,
        canonFacts: memory.canonFacts,
        conflicts: memory.conflicts,
        endingHook: memory.endingHook,
      })),
      memoryDocuments: project.memoryDocuments
        .filter(document => contextDocumentKinds.has(document.kind))
        .map(document => ({ kind: document.kind, title: document.title, content: document.content })),
    },
  };
};
