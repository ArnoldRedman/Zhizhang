import { compactText } from "../context/context-optimizer.js";

/**
 * 对标拆书的全书聚合（book.aggregate 的产物）在写作链里的用法
 * 构思阶段看情绪模块与节奏表，挑这一章的情绪链；正文阶段只带一段与构思基调相同的原文锚点和一张同基调模块。
 * 只借情绪链、功能位与写法，不借人物、场景、道具、专名和句子：帖子里"和拆文基本一样，套个壳子"就是没守这条
 */

export interface BenchmarkAnchor {
  tone: string;
  source: string;
  point: string;
  excerpt: string;
}

export interface BenchmarkEmotionModule {
  id: string;
  name: string;
  readerNeed: string;
  trigger: string;
  arc: string;
  replaceable: string;
  antiCopy: string;
  tone: string;
}

export interface ChapterBenchmark {
  anchors: BenchmarkAnchor[];
  emotionModules: BenchmarkEmotionModule[];
  rhythm: string;
}

const text = (value: unknown, limit: number): string => compactText(typeof value === "string" ? value : "", limit);

/** 桌面端传来的聚合结果按形状收口；没有锚点也没有模块就当没绑对标 */
export function normalizeBenchmark(value: unknown): ChapterBenchmark | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const anchors = (Array.isArray(record.anchors) ? record.anchors : []).flatMap(item => {
    const entry = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const excerpt = text(entry.excerpt, 1200);
    if (!excerpt) return [];
    return [{ tone: text(entry.tone, 20), source: text(entry.source, 40), point: text(entry.point, 200), excerpt }];
  }).slice(0, 6);
  const emotionModules = (Array.isArray(record.emotionModules) ? record.emotionModules : []).flatMap(item => {
    const entry = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const name = text(entry.name, 40);
    if (!name) return [];
    return [{
      id: text(entry.id, 20), name, readerNeed: text(entry.readerNeed, 200), trigger: text(entry.trigger, 200), arc: text(entry.arc, 300),
      replaceable: text(entry.replaceable, 200), antiCopy: text(entry.antiCopy, 200), tone: text(entry.tone, 20),
    }];
  }).slice(0, 8);
  const rhythm = text(record.rhythm, 2000);
  if (!anchors.length && !emotionModules.length) return undefined;
  return { anchors, emotionModules, rhythm };
}

/** 构思阶段的对标资料：模块只列一行一张，节奏表整段；让模型挑情绪链，不替它挑 */
export function benchmarkPlanSection(benchmark: ChapterBenchmark | undefined): string {
  if (!benchmark) return "";
  const modules = benchmark.emotionModules.map(module => `- ${module.id ? `${module.id} ` : ""}${module.name}（${module.tone || "基调未标"}）：读者要${module.readerNeed}；${module.arc}`).join("\n");
  const rhythm = benchmark.rhythm ? `\n对标作品的节奏表（关键信息怎么铺、在哪爆发或冷却）：\n${benchmark.rhythm}` : "";
  return `\n## 对标作品的情绪模块（可借它的情绪链，人物、场景、道具、触发条件全换）\n${modules || "（无）"}${rhythm}\n`;
}

/** 构思里出现了哪种基调就挑哪一段：没对上就一段都不带，宁缺毋滥 */
function pickByTone<T extends { tone: string }>(items: T[], chapterPlan: string | undefined): T | undefined {
  if (!chapterPlan) return undefined;
  return items.find(item => item.tone && chapterPlan.includes(item.tone));
}

/** 正文阶段的对标资料：一段同基调锚点加一张同基调模块，都对不上就不带 */
export function benchmarkDraftSection(benchmark: ChapterBenchmark | undefined, chapterPlan: string | undefined): { section: string; anchorTone?: string } {
  if (!benchmark) return { section: "" };
  const anchor = pickByTone(benchmark.anchors, chapterPlan);
  const module = pickByTone(benchmark.emotionModules, chapterPlan);
  if (!anchor && !module) return { section: "" };
  const anchorBlock = anchor
    ? `### 同基调的原文锚点（${anchor.tone}${anchor.source ? `｜${anchor.source}` : ""}）\n${anchor.point ? `${anchor.point}\n` : ""}${anchor.excerpt}\n`
    : "";
  const moduleBlock = module
    ? `### 情绪模块 ${module.id ? `${module.id} ` : ""}${module.name}\n读者要：${module.readerNeed}\n触发：${module.trigger}\n戏剧单元：${module.arc}\n可换的要素：${module.replaceable}\n复现时必须换掉：${module.antiCopy}\n`
    : "";
  return { section: `\n## 对标参考（学它的手法和情绪推进，不抄字句；人物、场景、道具、触发条件全换）\n${anchorBlock}${moduleBlock}`, anchorTone: anchor?.tone };
}
