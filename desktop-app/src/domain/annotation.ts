import type { Chapter } from './project';

/**
 * 正文批注：作者在某一段旁写一句要求，模型只改这一段
 * 批注按原文片段定位，不存偏移：作者改过正文后偏移会漂，原文片段还能在正文里找回来；找不回来的批注标为失效，作者自己删
 */
export interface ChapterAnnotation {
  id: string;
  /** 作者选中的原文片段 */
  quote: string;
  /** 作者的要求，例如"沈妄这里不会这么说，他会先把账本合上" */
  note: string;
  createdAt: string;
}

/** 批注对应的段落：整段作为修订单位，只改一句会让模型在半句里打转 */
export interface AnnotationTarget {
  annotation: ChapterAnnotation;
  /** 段落在正文里的起止（字符偏移），end 不含 */
  start: number;
  end: number;
  paragraph: string;
}

const paragraphBoundaries = (content: string): Array<{ start: number; end: number }> => {
  const bounds: Array<{ start: number; end: number }> = [];
  const pattern = /[^\n]+/gu;
  for (const match of content.matchAll(pattern))
    bounds.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
  return bounds;
};

/**
 * 把批注定位到段落：选中片段落在哪一段就改哪一段，跨段的选中按首尾段合并成一个区间
 * 同一段上有多条批注时合并成一个目标，一次改完；找不到原文片段的批注不进结果
 */
export const resolveAnnotationTargets = (content: string, annotations: ChapterAnnotation[]): { targets: Array<AnnotationTarget & { annotations: ChapterAnnotation[] }>; stale: ChapterAnnotation[] } => {
  const bounds = paragraphBoundaries(content);
  const stale: ChapterAnnotation[] = [];
  const located: AnnotationTarget[] = [];
  for (const annotation of annotations) {
    const quote = annotation.quote.trim();
    const index = quote ? content.indexOf(quote) : -1;
    if (index < 0) {
      stale.push(annotation);
      continue;
    }
    const first = bounds.find(bound => index >= bound.start && index < bound.end);
    const last = bounds.find(bound => index + quote.length - 1 >= bound.start && index + quote.length - 1 < bound.end) || first;
    if (!first || !last) {
      stale.push(annotation);
      continue;
    }
    located.push({ annotation, start: first.start, end: last.end, paragraph: content.slice(first.start, last.end) });
  }
  // 按位置排序后合并重叠区间：两条批注落在同一段或相邻跨段时合成一个目标
  located.sort((left, right) => left.start - right.start);
  const targets: Array<AnnotationTarget & { annotations: ChapterAnnotation[] }> = [];
  for (const item of located) {
    const previous = targets[targets.length - 1];
    if (previous && item.start < previous.end) {
      previous.end = Math.max(previous.end, item.end);
      previous.paragraph = content.slice(previous.start, previous.end);
      previous.annotations.push(item.annotation);
      continue;
    }
    targets.push({ ...item, annotations: [item.annotation] });
  }
  return { targets, stale };
};

/** 用改后的段落替换原段落；原段落已不在正文里（作者刚改过）就不动，返回 null */
export const applyParagraphRevision = (content: string, target: { start: number; end: number; paragraph: string }, revised: string): string | null => {
  const text = revised.trim();
  if (!text) return null;
  if (content.slice(target.start, target.end) === target.paragraph)
    return `${content.slice(0, target.start)}${text}${content.slice(target.end)}`;
  const index = content.indexOf(target.paragraph);
  if (index < 0) return null;
  return `${content.slice(0, index)}${text}${content.slice(index + target.paragraph.length)}`;
};

/** 段落前后各带一段作上下文：模型得知道这段接的是什么、后面要接什么，才不会改出断口 */
export const paragraphNeighbors = (content: string, target: { start: number; end: number }, limit = 400): { before: string; after: string } => ({
  before: content.slice(Math.max(0, target.start - limit), target.start).trim(),
  after: content.slice(target.end, target.end + limit).trim(),
});

export const addChapterAnnotation = (chapter: Chapter, quote: string, note: string): Chapter => ({
  ...chapter,
  annotations: [...(chapter.annotations || []), { id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, quote: quote.trim(), note: note.trim(), createdAt: new Date().toISOString() }],
  updatedAt: new Date().toISOString(),
});

export const removeChapterAnnotations = (chapter: Chapter, ids: string[]): Chapter => ({
  ...chapter,
  annotations: (chapter.annotations || []).filter(item => !ids.includes(item.id)),
  updatedAt: new Date().toISOString(),
});
