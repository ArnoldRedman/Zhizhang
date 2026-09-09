import { allocateChapterParts, chapterCharacterCount, partsFromBreaks, planChapterBreaks, splitParagraphs } from "@zhizhang/contracts";
import type { ModelApiClient } from "../models/model-api.js";
import { generateChapterTitles } from "./chapter-titles.js";
import { mapWithConcurrency } from "./concurrency.js";

// 分段与切点规则在契约层，桌面、移动端和落地共用一份，避免同一个 breakAfter 在两边切出不同结果
export { partsFromBreaks, planBalancedBreaks, planChapterBreaks, splitParagraphs } from "@zhizhang/contracts";

/** 同时给几章命名：拆章本身不花调用，只有新段落的标题要问模型 */
const SPLIT_CONCURRENCY = 3;

export interface ChapterSplitSource {
  targetId: number;
  title: string;
  content: string;
}

export interface ChapterSplitPlan {
  targetId: number;
  paragraphCount: number;
  breakAfter: number[];
  titles: string[];
}

export interface ChapterSplitResult {
  splits: ChapterSplitPlan[];
  failures: string[];
}

/** 原章标题里的“第 N 章”前缀，拆出来的后续段落继续沿用它的编号体系由应用决定，这里只取标题名 */
function titleName(title: string): string {
  return title.replace(/^\s*第\s*[0-9０-９一二三四五六七八九十百千零两]+\s*[章节回卷]\s*[：:、.．·\-—]?\s*/u, "").trim();
}

/**
 * 规划整批拆章
 * 切点是纯文本算的，只有新段落的标题需要模型；命名失败不影响拆分本身，退回“原标题（二）”这种序号名，
 * 作者要更好的名字随时可以再用批量补标题重拟一遍。
 * targetParts 是作者直接给的整批总章数（“这两章拆成 6 章”），给了就按字数分到各章，不再拿目标字数反推。
 */
export async function planChapterSplits(
  client: ModelApiClient,
  sources: ChapterSplitSource[],
  options: { targetWords: number; targetParts?: number; instruction?: string; projectTitle?: string; onProgress?: (done: number, total: number) => void } = { targetWords: 2400 },
): Promise<ChapterSplitResult> {
  const failures: string[] = [];
  const planned: Array<{ source: ChapterSplitSource; paragraphs: string[]; breakAfter: number[]; parts: string[] }> = [];
  // 作者说“两章拆成 6 章”时给的是整批总数，要按各章字数分回到每一章。
  // 总章数不比现有章数多时它不可能是总数（很可能模型把“每章拆几章”填到了这里），
  // 这时退回每章目标字数，而不是把整批章节全部跳过。
  const asTotal = options.targetParts && options.targetParts > sources.length ? options.targetParts : 0;
  if (options.targetParts && !asTotal) {
    failures.push(`要的 ${options.targetParts} 章不比这 ${sources.length} 章多，没法当成拆完后的总章数，本次按每章 ${options.targetWords} 字拆`);
  }
  const partsByChapter = asTotal
    ? allocateChapterParts(sources.map(item => ({ targetId: item.targetId, characters: chapterCharacterCount(item.content || "") })), asTotal)
    : new Map<number, number>();

  for (const source of sources) {
    const paragraphs = splitParagraphs(source.content || "");
    const characters = paragraphs.reduce((sum, item) => sum + chapterCharacterCount(item), 0);
    if (paragraphs.length < 2) {
      failures.push(`《${source.title || source.targetId}》整章没有分段，无法在段落边界上拆分`);
      continue;
    }
    const wanted = partsByChapter.get(source.targetId);
    // 报了总章数而这一章只分到 1 章（例如两章只拆成三章）：它就该原样留着，再拆就超出作者要的章数
    if (partsByChapter.size && (!wanted || wanted < 2)) {
      failures.push(`《${source.title || source.targetId}》只有 ${characters} 字，是这几章里最短的，为凑足你要的章数它保持原样`);
      continue;
    }
    const breakAfter = planChapterBreaks(paragraphs, options.targetWords, wanted);
    if (!breakAfter.length) {
      failures.push(wanted && wanted >= 2
        ? `《${source.title || source.targetId}》只有 ${characters} 字、${paragraphs.length} 个段落，切不出 ${wanted} 段那么多`
        : `《${source.title || source.targetId}》只有 ${characters} 字，没到需要拆分的长度`);
      continue;
    }
    planned.push({ source, paragraphs, breakAfter, parts: partsFromBreaks(paragraphs, breakAfter) });
  }

  let done = 0;
  const splits = await mapWithConcurrency(planned, SPLIT_CONCURRENCY, async entry => {
    const base = titleName(entry.source.title) || "";
    // 只给切出来的段落命名，第一段沿用原章标题，作者的章号编排不会被打乱
    const named = await generateChapterTitles(client, entry.parts.slice(1).map((content, index) => ({
      targetId: index + 1,
      currentTitle: "",
      content,
    })), {
      instruction: options.instruction,
      projectTitle: options.projectTitle,
    }).catch(() => ({ entries: [] as Array<{ targetId: number; title: string }>, failures: [], recovered: 0, named: 0, unchanged: 0 }));
    const byIndex = new Map(named.entries.map(item => [item.targetId, item.title]));
    const titles = [
      entry.source.title || base || "第一段",
      ...entry.parts.slice(1).map((_, index) => byIndex.get(index + 1) || `${base || entry.source.title || "续"}（${index + 2}）`),
    ];
    done += 1;
    options.onProgress?.(done, planned.length);
    return { targetId: entry.source.targetId, paragraphCount: entry.paragraphs.length, breakAfter: entry.breakAfter, titles };
  });

  return { splits, failures };
}
