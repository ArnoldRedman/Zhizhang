import { prepareChapterInput } from "../context/context-optimizer.js";

/** 关联修订复用写章资料预算，后文作为可修改的旧稿参考，不能当作本章已发生的事实 */
export function buildProjectRevisionContext(project: Record<string, unknown>, targetId: number, contextWindowKTokens?: number): string {
  const list = (key: string) => Array.isArray(project[key]) ? project[key] as Array<Record<string, unknown>> : [];
  const chapters = list("chapters");
  const index = chapters.findIndex(chapter => Number(chapter.id) === targetId);
  const prepared = prepareChapterInput({
    instruction: "关联修订章节，核对人物、事件与前后衔接",
    outlines: list("outlines").filter(outline => outline.kind !== "章纲" || Number(outline.chapterId) === targetId),
    cards: list("cards"),
    previousChapters: chapters.slice(0, index),
    followingChapters: chapters.slice(index + 1),
    memories: list("memories").map(memory => ({ ...memory, chapterNumber: chapters.findIndex(chapter => String(chapter.id) === String(memory.chapterId)) + 1 }))
      .filter(memory => memory.chapterNumber > 0 && memory.chapterNumber <= index),
    chapterPosition: { number: index + 1, total: chapters.length },
    contextWindowKTokens,
  });
  return [
    `正在修订第 ${index + 1} 章。前文可能已经按本轮要求修改，以下为当前临时稿；后文用于发现关联影响。`,
    prepared.worldSetting,
    prepared.masterOutline,
    prepared.storyLedger,
    prepared.outline,
    ...prepared.cards.map(card => `## ${card.title}\n${card.content}`),
    "## 前文当前稿",
    ...prepared.previousChapters.map(chapter => `### ${chapter.title}\n${chapter.content}`),
    "## 后文待核对稿（并非本章人物已知事实）",
    ...prepared.followingChapters.map(chapter => `### ${chapter.title}\n${chapter.content}`),
  ].filter(Boolean).join("\n\n");
}
