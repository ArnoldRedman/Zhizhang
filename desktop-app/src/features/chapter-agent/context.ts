import type { Chapter, KnowledgeCard, OutlineDocument, Project } from '../../domain/project';
import type { Skill } from '../../domain/skill';
import type { DismantleAggregate, WritingStyle } from '../../domain/library';
import { firstSentence, isPlaceholderOutline, isWorkLogDocumentTitle, lastSentence, omitFutureChapterFacts, writingGuideFacts } from '@zhizhang/contracts';
import { buildMemoryDocuments, recentChapterMemories } from '../../domain/memory.ts';
import { answeredAuthorQuestions, pendingAuthorQuestions } from '../../domain/outline.ts';
import { duePromises } from '../../domain/promises.ts';
import { chapterBoundToOutline } from '../outline/model.ts';

/**
 * 章节智能体的入参组装
 * 从 App.tsx 的 runChapterAgent 里搬出来的纯函数：只看项目数据和作者的选择，不碰界面状态、会话 id 和模型配置。
 * 章节智能体到底能看到哪些资料，全部在这一处决定：
 * - 世界观、总纲与全书前文摘要固定带入，由运行时按窗口分配空间
 * - 当前章绑定有效章纲，作者勾选的其他章纲只做参考
 * - 卡片未指定时全部提供，近期正文优先整章保留
 * - 文风参考由作者指定，不依赖任何一本书的固定章号
 */

/** 进入运行时检索库的聚合文档：角色认知/冲突/章节快照靠逐章记忆覆盖，任务书只带这四份 */
const contextDocumentKinds = new Set(['章节快照', '人物状态', '伏笔追踪', '时间线', '设定事实']);

/** 默认创作指令只说要写什么：以前那句塞满"承接后离开场景、时间位移、不埋新线"，模型照着写出来的就是流水账 */
export const defaultChapterInstruction = '按总纲和前文写这一章该发生的事，人物按各自的性格行动。';

const chapterRangePattern = /第\s*(\d{1,4})\s*[～~\-—–至到]\s*(\d{1,4})\s*章/gu;

/**
 * 总纲里有没有给这一章单独写条目（"#### 第204章 《西北来的日程表》"这种标题）
 * 有就不必再生成阶段节拍表：作者已经逐章规划过了，再让模型按八章一段重新拆一遍只会和总纲打架
 */
export const masterOutlineHasChapterEntry = (project: Project, chapterNumber: number): boolean => project.outlines
  .filter(outline => outline.kind === '总纲')
  .some(outline => new RegExp(`^#{1,6}\\s*(?:第\\s*)?${chapterNumber}\\s*章(?!\\s*[～~\\-—–至到])`, 'mu').test(outline.content));

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
 * 本次入场卡片：常驻卡每章必带；其余勾了就用勾的，没勾自己挑——懒人化就是这一条，不选也不会缺人物素材
 * 章纲生成与正文写作共用同一套规矩，免得一边自动一边空手
 */
export const effectiveCards = (project: Project, selectedCardIds: number[], _haystack: string): KnowledgeCard[] => {
  const pinned = project.cards.filter(card => card.pinned);
  const rest = selectedCardIds.length
    ? project.cards.filter(card => selectedCardIds.includes(card.id) && !card.pinned)
    : project.cards.filter(card => !card.pinned);
  return [...pinned, ...rest];
};

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
  /** 项目绑定的对标拆书的全书聚合：构思看情绪模块与节奏表，正文只带一段同基调锚点；没绑或没聚合就不传 */
  benchmark?: DismantleAggregate;
}

export interface ChapterWriteContext {
  /** 绑定到当前章的章纲；没有时智能体只能依据总纲与故事账本推进 */
  boundOutline: OutlineDocument | undefined;
  /** chapter.write 的资料部分，调用方再补 runId、会话与模型配置 */
  params: Record<string, unknown>;
}

/** 当前章的章纲：先认 chapterId，再认标题或章纲开头里的章号 */
export const boundChapterOutlineFor = (project: Project, chapter: Chapter, includePlaceholder = false): OutlineDocument | undefined =>
  project.outlines.find(outline => outline.kind === '章纲' && (includePlaceholder || !isPlaceholderOutline(outline.content))
    && (String(outline.chapterId ?? '') === String(chapter.id) || chapterBoundToOutline(project, outline)?.id === chapter.id));

/**
 * 重写历史章时把卡片状态回退到本章之前：当前状态与状态历史都是按全书最新写的，重写第 130 章却带着"第 194 章登门受茶"，
 * 模型就会把后面的事提前写出来。取状态历史里最后一条落在本章之前的记录当"当前状态"，更晚的历史全部去掉；
 * 一条都没有就清空，宁可没有状态也不给未来
 */
export const rollbackCardState = (card: KnowledgeCard, project: Project, chapterNumber: number): KnowledgeCard => {
  const numberOf = (chapterId: number) => project.chapters.findIndex(item => item.id === chapterId) + 1;
  const earlier = (card.stateHistory || []).filter(entry => {
    const number = numberOf(entry.chapterId);
    return number > 0 && number < chapterNumber;
  });
  const latest = earlier[earlier.length - 1];
  return { ...card, currentState: latest?.changes || '', stateHistory: earlier };
};

/** 章纲上填了才用；隐瞒空着时用上一章的作者真相，不因为没填就停笔 */
export const compileChapterBrief = (project: Project, chapter: Chapter, chapterNumber: number) => {
  const outline = boundChapterOutlineFor(project, chapter);
  const previous = chapterNumber > 1 ? project.chapters[chapterNumber - 2] : undefined;
  const truth = previous ? project.memories.find(memory => memory.chapterId === previous.id)?.authorTruth?.map(item => item.trim()).filter(Boolean) : undefined;
  const readerKnows = outline?.readerKnows?.trim() || '';
  const protagonistKnows = outline?.protagonistKnows?.trim() || '';
  const hintOnly = outline?.hintOnly?.trim() || '';
  const mustHide = outline?.mustHide?.trim() || (truth?.length ? truth.slice(0, 6).join('；') : '');
  if (!readerKnows && !protagonistKnows && !mustHide && !hintOnly) return undefined;
  return {
    ...(readerKnows ? { readerKnows } : {}),
    ...(protagonistKnows ? { protagonistKnows } : {}),
    ...(mustHide ? { mustHide } : {}),
    ...(hintOnly ? { hintOnly } : {}),
  };
};

export const buildChapterWriteContext = (input: ChapterWriteContextInput): ChapterWriteContext => {
  const { project, chapter } = input;
  const chapterIndex = project.chapters.findIndex(item => item.id === chapter.id);
  const chapterNumber = chapterIndex + 1;
  const previousChapter = chapterIndex > 0 ? project.chapters[chapterIndex - 1] : undefined;
  // 重写或审查历史章时，聚合文档只能到本章之前：它们按全书累计，尾部是最新几章，带进去等于把"未来"喂给模型
  const historical = chapterIndex >= 0 && chapterIndex < project.chapters.length - 1;
  const priorMemories = recentChapterMemories(project, chapterNumber);
  const memoryDocuments = historical ? buildMemoryDocuments(priorMemories) : project.memoryDocuments;
  const boundOutline = boundChapterOutlineFor(project, chapter);
  // 阶段节拍表不当普通章纲带：它单独走 stageBeats，运行时只取本章那一行
  // 工作台账不带；混合文风文档只取硬事实与考据，其他世界设定照常带
  const scrub = (text: string) => historical ? omitFutureChapterFacts(text, chapterNumber) : text;
  const outlines = project.outlines.filter(outline => !outline.title.startsWith('阶段节拍｜') && !(outline.kind === '世界观与作品设定' && isWorkLogDocumentTitle(outline.title)) && (outline.kind === '世界观与作品设定' || outline.kind === '总纲'
    || outline.id === boundOutline?.id || input.extraOutlineIds.includes(outline.id)))
    .map(outline => {
      const content = outline.kind === '世界观与作品设定' ? writingGuideFacts(outline.title, outline.content) : outline.content;
      // 章纲是本章要写什么，里面提到后面的章号是禁止项，不能当未来事实删掉
      const scrubbed = historical && (outline.kind === '世界观与作品设定' || outline.kind === '总纲') ? scrub(content) : content;
      return { ...outline, content: scrubbed };
    })
    .filter(outline => outline.content.trim());
  const cards = effectiveCards(project, input.selectedCardIds, `${boundOutline?.content || ''}\n${(previousChapter?.content || '').slice(-8000)}\n${input.instruction}`)
    .map(card => {
      const rolled = historical ? rollbackCardState(card, project, chapterNumber) : card;
      if (!historical) return rolled;
      return {
        ...rolled,
        content: scrub(rolled.content),
        currentState: scrub(rolled.currentState || ''),
        stateHistory: (rolled.stateHistory || []).map(entry => ({ ...entry, changes: scrub(entry.changes) })),
      };
    });
  const skills = input.skills.map(skill => ({ name: skill.name, displayName: skill.displayName, category: skill.category, description: skill.description, tags: skill.tags, content: skill.content }));
  return {
    boundOutline,
    params: {
      projectId: String(project.id),
      projectTitle: project.title,
      // 作品定位进稳定资料：写正文的模型得知道这本书是"慢热高甜"还是"权谋清算"，只看章纲会把言情写成工作日志
      projectProfile: {
        genre: project.genre,
        subgenre: project.subgenre,
        tags: Object.values(project.tags || {}).flat().filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0),
        synopsis: project.synopsis,
        protagonists: [project.protagonist1, project.protagonist2].filter((name): name is string => Boolean(name?.trim())),
      },
      chapterId: String(chapter.id),
      chapterNumber,
      totalChapters: project.chapters.length,
      targetWords: Number(project.chapterTargetWords) || 3000,
      instruction: input.instruction,
      outlines: outlines.map(outline => ({ id: outline.id, kind: outline.kind, title: outline.title, chapterId: outline.chapterId, content: outline.content })),
      activeOutlineId: boundOutline?.id,
      outline: boundOutline?.content || '',
      cards,
      knowledgeGraph: { nodes: project.graphNodes, edges: project.graphEdges },
      stageBeats: stageBeatsFor(project, chapterNumber)?.content,
      skills,
      writingStyle: input.writingStyle ? { name: input.writingStyle.name, content: input.writingStyle.content } : undefined,
      preferredSkillNames: input.preferredSkillNames.filter(name => input.skills.some(skill => skill.name === name)),
      defaultSkillNames: (project.defaultSkillNames || []).filter(name => input.skills.some(skill => skill.name === name)),
      previousChapters: project.chapters.slice(0, Math.max(0, chapterIndex)).filter(item => item.content.trim()).map(item => ({ id: item.id, title: item.title, content: item.content })),
      followingChapters: project.chapters.slice(chapterIndex + 1).filter(item => item.content.trim()).map(item => ({ id: item.id, title: item.title, content: item.content })),
      referenceChapters: project.chapters
        .map((item, index) => ({ item, number: index + 1 }))
        .filter(entry => entry.number !== chapterNumber && project.referenceChapterIds?.includes(entry.item.id) && entry.item.content.trim())
        .map(entry => ({ id: entry.item.id, number: entry.number, title: entry.item.title, content: entry.item.content })),
      memories: priorMemories.map(memory => ({
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
        relationshipState: memory.relationshipState || [],
        readerKnown: memory.readerKnown || [],
        authorTruth: memory.authorTruth || [],
        nextChapterPromise: memory.nextChapterPromise || '',
        newlyIntroduced: memory.newlyIntroduced || [],
        endingHook: memory.endingHook,
      })),
      memoryDocuments: memoryDocuments
        .filter(document => contextDocumentKinds.has(document.kind))
        .map(document => ({ kind: document.kind, title: document.title, content: scrub(document.content) })),
      // 验证门与三档审查：档位、引号风格、作者允许的句式来自项目设置；最近几章的开头结尾与上一章承诺从正文和记忆里取
      reviewMode: project.reviewMode || 'lean',
      quoteStyle: project.quoteStyle,
      allowedPhrases: project.allowedPhrases || [],
      ...recentChapterEcho(project, chapterNumber),
      previousPromise: previousChapter ? project.memories.find(memory => memory.chapterId === previousChapter.id)?.nextChapterPromise || undefined : undefined,
      chapterBrief: compileChapterBrief(project, chapter, chapterNumber),
      duePromises: duePromises(project.promises, chapterNumber).map(item => ({ text: item.text, dueChapter: item.dueChapter, everyChapters: item.everyChapters })),
      openQuestions: pendingAuthorQuestions(project).map(item => item.question).slice(0, 8),
      // 作者对模型提问的答复：之后每章按答复写，模型不再重复问
      authorAnswers: answeredAuthorQuestions(project),
      // 对标资料只传写作要用的三样，文风档案已经作为 WritingStyle 单独绑定，不重复带
      benchmark: input.benchmark ? { anchors: input.benchmark.anchors, emotionModules: input.benchmark.emotionModules, rhythm: input.benchmark.rhythm } : undefined,
    },
  };
};

/**
 * 最近五章的开头句与结尾句
 * 写作时让模型看见前面几章怎么开怎么收，验证门拿它查同型；只取有正文的章，按时间顺序，最后一项是紧邻上一章
 */
export const recentChapterEcho = (project: Project, beforeChapterNumber: number, limit = 5): { recentOpenings: string[]; recentEndings: string[] } => {
  const previous = project.chapters.slice(Math.max(0, beforeChapterNumber - 1 - limit), Math.max(0, beforeChapterNumber - 1)).filter(chapter => chapter.content.trim());
  return {
    recentOpenings: previous.map(chapter => firstSentence(chapter.content)).filter(Boolean),
    recentEndings: previous.map(chapter => lastSentence(chapter.content)).filter(Boolean),
  };
};
