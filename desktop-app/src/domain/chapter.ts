import type { AIDetectionSegment, Chapter, DeletedChapter, Project } from './project';

/** 覆盖正文前保留的历史版本数量 */
export const chapterSnapshotLimit = 3;

/**
 * 覆盖章节正文前压入一条历史版本
 * ponytail: 快照存在 metadata.json 里，上限 3 条/章；若长篇导致元数据过大，再改为 章节/.history/ 独立文件
 */
export const pushChapterSnapshot = (chapter: Chapter, reason: string): Chapter => {
  if (!chapter.content.trim()) return chapter;
  const existing = chapter.snapshots || [];
  // 同一毫秒内连续覆盖会拿到相同时间戳，savedAt 同时是回滚与 React key 的标识，必须唯一
  let stamp = Date.now();
  const newest = existing[0] ? Date.parse(existing[0].savedAt) : 0;
  if (stamp <= newest) stamp = newest + 1;
  const snapshots = [
    { content: chapter.content, wordCount: chapter.wordCount, savedAt: new Date(stamp).toISOString(), reason },
    ...existing,
  ].slice(0, chapterSnapshotLimit);
  return { ...chapter, snapshots };
};

/** 用某条历史版本替换正文，当前正文本身再入栈，回滚可以再回滚 */
export const restoreChapterSnapshot = (chapter: Chapter, savedAt: string, countWords: (content: string) => number): Chapter => {
  const target = chapter.snapshots?.find(snapshot => snapshot.savedAt === savedAt);
  if (!target) return chapter;
  const withCurrent = pushChapterSnapshot(chapter, '回滚前');
  return {
    ...withCurrent,
    content: target.content,
    wordCount: countWords(target.content),
    updatedAt: new Date().toISOString(),
    snapshots: (withCurrent.snapshots || []).filter(snapshot => snapshot.savedAt !== savedAt),
  };
};

/** 在项目里替换一章，并同步全书字数 */
export const replaceChapterInProject = (project: Project, chapter: Chapter): Project => {
  const chapters = project.chapters.map(item => item.id === chapter.id ? chapter : item);
  return {
    ...project,
    chapters,
    wordCount: chapters.reduce((sum, item) => sum + item.wordCount, 0),
    updatedAt: new Date().toISOString(),
  };
};

/** 章节移动：delta 为 -1 上移、+1 下移，越界时原样返回 */
export const moveChapterInProject = (project: Project, chapterId: number, delta: number): Project => {
  const index = project.chapters.findIndex(chapter => chapter.id === chapterId);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= project.chapters.length) return project;
  const chapters = [...project.chapters];
  [chapters[index], chapters[target]] = [chapters[target], chapters[index]];
  return { ...project, chapters, updatedAt: new Date().toISOString() };
};

/** 把章节移动到目标下标，供拖拽排序使用 */
export const reorderChapterInProject = (project: Project, chapterId: number, toIndex: number): Project => {
  const index = project.chapters.findIndex(chapter => chapter.id === chapterId);
  if (index < 0 || toIndex < 0 || toIndex >= project.chapters.length || index === toIndex) return project;
  const chapters = [...project.chapters];
  const [moved] = chapters.splice(index, 1);
  chapters.splice(toIndex, 0, moved);
  return { ...project, chapters, updatedAt: new Date().toISOString() };
};

/** 在指定章节后插入空白章节；afterChapterId 为 null 时插到最前 */
export const insertChapterAfter = (project: Project, afterChapterId: number | null, title: string): { project: Project; chapter: Chapter } => {
  const now = new Date().toISOString();
  const chapter: Chapter = { id: Date.now(), title, content: '', wordCount: 0, createdAt: now, updatedAt: now };
  const chapters = [...project.chapters];
  const index = afterChapterId === null ? -1 : chapters.findIndex(item => item.id === afterChapterId);
  chapters.splice(index + 1, 0, chapter);
  return { project: { ...project, chapters, updatedAt: now }, chapter };
};

/** 回收站上限：只保留最近删除的若干章 */
export const deletedChapterLimit = 20;

/**
 * 删除章节并清理所有引用它的派生数据
 * UI 手动删除和项目 Agent 的 chapter.delete 共用这一份级联，避免两条路径清理不一致
 * 正文本身进回收站，派生数据（记忆、图谱、检测）不回滚，恢复后重新生成
 */
export const removeChapterFromProject = (project: Project, chapterId: number): Project => {
  const index = project.chapters.findIndex(chapter => chapter.id === chapterId);
  if (index < 0) return project;
  const removed = project.chapters[index];
  const chapters = project.chapters.filter(chapter => chapter.id !== chapterId);
  const chapterNodeId = `chapter:${chapterId}`;
  return {
    ...project,
    chapters,
    deletedChapters: [
      { chapter: removed, index, deletedAt: new Date().toISOString() },
      ...(project.deletedChapters || []),
    ].slice(0, deletedChapterLimit),
    // 章纲是可复用的写作计划，只解除绑定；正文派生的章节记忆随正文一起删除
    outlines: project.outlines.map(outline => outline.chapterId === chapterId ? { ...outline, chapterId: undefined } : outline),
    memories: project.memories.filter(memory => memory.chapterId !== chapterId),
    cards: project.cards.map(card => card.stateHistory?.some(entry => entry.chapterId === chapterId)
      ? { ...card, stateHistory: card.stateHistory.filter(entry => entry.chapterId !== chapterId) }
      : card),
    graphNodes: project.graphNodes.filter(node => node.id !== chapterNodeId),
    graphEdges: project.graphEdges.filter(edge => edge.source !== chapterNodeId && edge.target !== chapterNodeId),
    // 检测报告按章存放，删除后对应条目不再有可跳转的目标
    aiDetection: project.aiDetection
      ? { ...project.aiDetection, chapters: project.aiDetection.chapters.filter(item => item.chapterId !== chapterId) }
      : undefined,
    wordCount: chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0),
    updatedAt: new Date().toISOString(),
  };
};

/** 从回收站恢复一章，尽量插回原位置 */
export const restoreDeletedChapter = (project: Project, chapterId: number): { project: Project; chapter: Chapter | null } => {
  const entry = project.deletedChapters?.find((item: DeletedChapter) => item.chapter.id === chapterId);
  if (!entry) return { project, chapter: null };
  const chapters = [...project.chapters];
  chapters.splice(Math.min(entry.index, chapters.length), 0, entry.chapter);
  return {
    project: {
      ...project,
      chapters,
      deletedChapters: (project.deletedChapters || []).filter(item => item.chapter.id !== chapterId),
      wordCount: chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0),
      updatedAt: new Date().toISOString(),
    },
    chapter: entry.chapter,
  };
};

/** 检测统计用的正文：去掉章节头和（本章完）再去空白，只影响句长、逻辑词这些指标 */
export const aiDetectionSource = (content: string) => content
  .replace(/^【第\d+章[^】]*】\s*/u, '')
  .replace(/（本章完）\s*$/u, '')
  .trim();

/**
 * 检测报告里的分段是否还对应当前正文。
 * 编辑器的高亮层铺的是分段文字、上面那层透明 textarea 铺的是真正文；正文改过之后旧分段就废了，
 * 不判定的话屏幕会停在旧正文，滚动条却按新正文的长度走——看起来就是"改了但没刷新"。
 * 分段是按原文切的（含章节头和首尾空白），所以必须逐字比原文；曾经拿它和 aiDetectionSource 的结果比，
 * 正文只要末尾多一个换行就永远对不上，高亮从来显示不出来
 */
export const aiDetectionSegmentsMatch = (segments: AIDetectionSegment[] | undefined, content: string) =>
  !!segments?.length && segments.map(segment => segment.text).join('') === content;
