import type { Project, StoryPromise } from './project';

/**
 * 这一章要写进提示词的承诺
 * 到期或逾期的一直提醒，直到作者标成已收或放弃
 * 节奏从埋设章起算，本章本身不提醒；没填期限也没填节奏的不进，作者没要求本章处理
 */
export const duePromises = (promises: StoryPromise[] | undefined, chapterNumber: number): StoryPromise[] => {
  if (!chapterNumber || chapterNumber < 1) return [];
  return (promises || []).filter(item => {
    if (item.status !== 'open' || !item.text.trim()) return false;
    if (item.dueChapter && chapterNumber >= item.dueChapter) return true;
    const every = item.everyChapters || 0;
    if (every >= 2) {
      const since = chapterNumber - (item.plantedChapter || 0);
      return since > 0 && since % every === 0;
    }
    return false;
  }).slice(0, 8);
};

export const replacePromises = (project: Project, promises: StoryPromise[]): Project => ({
  ...project,
  promises,
  updatedAt: new Date().toISOString(),
});
