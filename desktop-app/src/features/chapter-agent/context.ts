import type { Chapter, OutlineDocument, Project } from '../../domain/project';
import type { Skill } from '../../domain/skill';
import type { WritingStyle } from '../../domain/library';
import { recentChapterMemories } from '../../domain/memory.ts';
import { chapterBoundToOutline } from '../outline/model.ts';

/**
 * 章节智能体的入参组装
 * 从 App.tsx 的 runChapterAgent 里搬出来的纯函数：只看项目数据和作者的选择，不碰界面状态、会话 id 和模型配置。
 * 章节智能体到底能看到哪些资料，全部在这一处决定：
 * - 世界观与总纲固定带入，总纲由运行时压成骨架加当前阶段段落
 * - 当前章的章纲按绑定关系自动带入，作者勾选的其他章纲只做参考
 * - 前文只传紧邻上一章正文；更早的章节通过最近六章记忆和四份聚合文档进入
 */

/** 进入运行时检索库的聚合文档：章节快照和角色认知/冲突由逐章记忆覆盖，不再重复传 */
const contextDocumentKinds = new Set(['人物状态', '伏笔追踪', '时间线', '设定事实']);

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
  const outlines = project.outlines.filter(outline => outline.kind === '世界观与作品设定' || outline.kind === '总纲'
    || outline.id === boundOutline?.id || input.extraOutlineIds.includes(outline.id));
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
      cards: project.cards.filter(card => input.selectedCardIds.includes(card.id)),
      knowledgeGraph: { nodes: project.graphNodes, edges: project.graphEdges },
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
