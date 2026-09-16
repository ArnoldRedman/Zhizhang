import { parseChapterNumber } from "./chapter-titles.js";

/**
 * 项目 Agent 委托大纲智能体写章纲时，把“这次写的是第几章”一起带过去
 * 界面路径靠 desktop-app 的 resolveOutlineGenerationIntent 算这三份资料，这里是运行时侧的同一件事。
 * 不带的话 handleLegacyRequest 收到的是空 targetChapter 与空 sourceChapter：账本位置永远按“全书章数 + 1”算，
 * 正文依据提示“本次没有提供可用正文”。实测一次委托里分别要写第 179、180、181 章的三份章纲，
 * 正文全写成“第179章”，三份都在同一件事上打转
 */

/** 章纲标题里的章号：“章纲｜第 189 章”“第179章 章纲”“章纲｜第一百七十九章”都能认
 * “阶段节拍｜第174～177章”是区间不是某一章，不算章号 */
export const chapterNumberFromOutlineTitle = (title: unknown): number | undefined => {
  const value = String(title ?? "").trim();
  if (!value || value.startsWith("阶段节拍｜")) return undefined;
  const match = /第\s*(\d{1,4}|[零〇一二两三四五六七八九十百千]+)\s*章/u.exec(value);
  if (!match) return undefined;
  return parseChapterNumber(match[1]) ?? undefined;
};

/**
 * 覆盖某一章的阶段节拍表正文：委托路径也要带上它
 * 节拍表里本章那一行是章纲的硬目标，委托路径不带就变成“同一本书，两条生成路径一个按节拍、一个不按”
 */
export const stageBeatContentFor = (outlines: OutlineRecord[], number: number | undefined): string | undefined => {
  if (!number) return undefined;
  const beat = outlines.find(outline => {
    if (String(outline.kind ?? "") !== "章纲") return false;
    const range = /^阶段节拍｜第\s*(\d{1,4})\s*[～~\-—–至到]\s*(\d{1,4})\s*章/u.exec(String(outline.title ?? "").trim());
    return Boolean(range) && number >= Number(range![1]) && number <= Number(range![2]) && String(outline.content ?? "").trim();
  });
  return beat ? String(beat.content ?? "") : undefined;
};

type OutlineRecord = Record<string, unknown>;

export interface OutlineWriteTargetContext {
  targetChapter?: { id: number; number: number; title: string };
  sourceChapter?: { id: number; number: number; title: string; content: string; mode: string };
  formatOutline?: { id: number; title: string; content: string; mode: string };
}

/**
 * 章号从标题里来：章纲文档还没有绑定 chapterId，标题里的“第 N 章”是唯一的定位依据
 * 目标章可能还没建（提前规划后几章），这时只给出章号与占位标题，运行时仍能按它定位总纲阶段与账本
 */
export const outlineWriteTargetContext = (title: unknown, chapters: OutlineRecord[], outlines: OutlineRecord[]): OutlineWriteTargetContext => {
  const number = chapterNumberFromOutlineTitle(title);
  if (!number) return {};
  const target = chapters[number - 1];
  // 承接锚点是上一章真正的结尾；刚新建还没正文的空章不给，免得模型去承接一段不存在的结尾
  const written = chapters.filter(chapter => String(chapter.content ?? "").trim());
  // 提前规划时（要写第 190 章而正文只到第 178 章）上一章还不存在，改拿全书最后一章已写正文：
  // 运行时会把这种“不是紧邻上一章”的依据当成指定正文分析，不会误标成承接
  const immediatePrevious = number > 1 ? chapters[number - 2] : undefined;
  const previous = String(immediatePrevious?.content ?? "").trim() ? immediatePrevious : (number > 1 ? written.at(-1) : undefined);
  const previousIsImmediate = previous === immediatePrevious;
  // 格式参考取上一章章纲，没有就取章号最接近的已写章纲：只借它的栏目密度，事件与人物仍以本章依据为准
  const nearestOutline = outlines
    .filter(outline => String(outline.kind ?? "") === "章纲")
    .map(outline => ({ outline, number: chapterNumberFromOutlineTitle(outline.title) }))
    .filter(entry => entry.number !== undefined && entry.number < number)
    .sort((left, right) => (right.number ?? 0) - (left.number ?? 0))[0]?.outline;
  const format = nearestOutline;
  return {
    targetChapter: {
      id: Number(target?.id ?? 0),
      number,
      title: String(target?.title ?? `第 ${number} 章`),
    },
    sourceChapter: previous
      ? {
        id: Number(previous.id ?? 0),
        number: previousIsImmediate ? number - 1 : (chapterNumberFromOutlineTitle(previous.title) ?? chapters.indexOf(previous) + 1),
        title: String(previous.title ?? `第 ${number - 1} 章`),
        content: String(previous.content ?? ""),
        mode: previousIsImmediate ? "默认上一章正文" : "全书最后一章已写正文",
      }
      : undefined,
    formatOutline: format
      ? { id: Number(format.id ?? 0), title: String(format.title ?? "参考章纲"), content: String(format.content ?? ""), mode: "默认参考上一章章纲格式" }
      : undefined,
  };
};
