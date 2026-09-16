import type { Chapter, OutlineDocument, Project } from '../../domain/project';
import { parseChapterNumber } from '../../utils/text.ts';

/**
 * 章纲与章节的对应关系，以及“根据第 N 章正文生成第 M 章章纲”这类指令的解析
 * 从 App.tsx 搬出来的纯函数：不碰界面状态，只看项目数据和作者指令
 */

/** 从任意文本里找“第 N 章”并解析章号；章节标题和章纲开头都可能写章号
 * “第178～185章”这种区间是阶段节拍表的标题，不是某一章 */
export const chapterNumberFromText = (value: string) => {
  const match = value.match(/第\s*(\d+|[零〇一二三四五六七八九十百千]+)\s*章/u);
  if (!match || /^阶段节拍｜/u.test(value.trim())) return undefined;
  return parseChapterNumber(match[1]) ?? undefined;
};

/**
 * 已备章纲写到第几章：显示给作者看“还能连写到哪”，也只认作者看得见、改得动的章纲
 * 只认标题里的章号，不看正文：章纲正文里常常提到“承接第 173 章”这类句子，拿正文当依据会把终点算高
 * 阶段节拍表的标题是区间（阶段节拍｜第174～177章），chapterNumberFromText 会对它返回 undefined
 */
export const plannedThroughChapterNumber = (project: Project): number | undefined => {
  let planned: number | undefined;
  for (const outline of project.outlines) {
    if (outline.kind !== '章纲') continue;
    const number = chapterNumberFromText(outline.title);
    if (number !== undefined && (planned === undefined || number > planned)) planned = number;
  }
  return planned;
};

/**
 * 总纲里按卷写明的章号上限（“### 第四卷：…（156～205章）”“| 第一卷 | 1～67章 |”），也就是全书的计划末章
 * 只认带“卷”的那一行里的区间：总纲正文里到处都有“须在第X～Y章完成”这种句子，拿全部区间取最大值会把边界算错，
 * 连续创作写到这里就停，作者改总纲卷区间就是改全书的结局边界
 */
export const plannedVolumeEndChapter = (project: Project): number | undefined => {
  let end: number | undefined;
  for (const outline of project.outlines) {
    if (outline.kind !== '总纲') continue;
    for (const line of outline.content.split('\n')) {
      const match = /(?:第\s*)?(\d{1,4})\s*[～~\-—–至到]\s*(\d{1,4})\s*章/u.exec(line);
      if (!line.includes('卷') || !match) continue;
      const to = Number(match[2]);
      if (Number.isFinite(to) && (end === undefined || to > end)) end = to;
    }
  }
  return end;
};

/** Old chapter outlines may not have a chapterId. Recover it from their title
 * before an agent run, rather than letting the model infer a chapter from
 * unrelated outline history. */
export const chapterBoundToOutline = (project: Project, outline: OutlineDocument): Chapter | undefined => {
  const byId = typeof outline.chapterId === 'number'
    ? project.chapters.find(chapter => chapter.id === outline.chapterId)
    : undefined;
  if (byId) return byId;
  const chapterNumber = chapterNumberFromText(`${outline.title}\n${outline.content.slice(0, 500)}`);
  if (!chapterNumber) return undefined;
  return project.chapters.find(chapter => chapterNumberFromText(chapter.title) === chapterNumber)
    || project.chapters[chapterNumber - 1];
};

export const chapterByNumber = (project: Project, number: number | undefined): Chapter | undefined => {
  if (!number || number < 1) return undefined;
  return project.chapters.find(chapter => chapterNumberFromText(chapter.title) === number)
    || project.chapters[number - 1];
};

export const outlineByChapterNumber = (project: Project, number: number | undefined): OutlineDocument | undefined => {
  if (!number || number < 1) return undefined;
  return project.outlines.find(outline => outline.kind === '章纲'
    && chapterNumberFromText(`${outline.title}\n${outline.content.slice(0, 500)}`) === number)
    || project.outlines.find(outline => outline.kind === '章纲'
      && String(outline.chapterId ?? '') === String(project.chapters[number - 1]?.id ?? ''));
};

export const instructionChapterNumber = (instruction: string, pattern: RegExp): number | undefined => {
  const matched = instruction.match(pattern)?.slice(1).find(Boolean);
  return matched ? (parseChapterNumber(matched) ?? undefined) : undefined;
};

export const resolveOutlineGenerationIntent = (project: Project, activeOutline: OutlineDocument, instruction: string) => {
  const sourcePattern = /(?:根据|基于|参考|按|以)\s*第?\s*(\d+|[零〇一二三四五六七八九十百千]+)\s*章(?:的)?(?:正文|内容)|第?\s*(\d+|[零〇一二三四五六七八九十百千]+)\s*章(?:的)?(?:正文|内容)\s*(?:生成|编写|补全|整理|反推|制作)/u;
  const sourceMatched = instruction.match(sourcePattern);
  const explicitSourceNumber = sourceMatched
    ? (parseChapterNumber(sourceMatched[1] || sourceMatched[2]) ?? undefined)
    : undefined;
  const targetNumber = chapterNumberFromText(`${activeOutline.title}\n${activeOutline.content.slice(0, 500)}`);
  const explicitTargetNumber = instructionChapterNumber(instruction, /(?:生成|编写|补全|制作|整理|反推)\s*第?\s*(\d+|[零〇一二三四五六七八九十百千]+)\s*章(?:的)?(?:章纲|大纲)|(?:为|给)\s*第?\s*(\d+|[零〇一二三四五六七八九十百千]+)\s*章(?:的)?(?:章纲|大纲)/u)
    || instructionChapterNumber(instruction, /第?\s*(\d+|[零〇一二三四五六七八九十百千]+)\s*章(?:的)?(?:章纲|大纲)\s*(?:生成|编写|补全|制作|整理|反推)/u);
  const redirectedOutline = explicitTargetNumber && explicitTargetNumber !== targetNumber
    ? project.outlines.find(outline => outline.kind === '章纲' && chapterNumberFromText(`${outline.title}\n${outline.content.slice(0, 500)}`) === explicitTargetNumber)
    : undefined;
  const targetOutline = redirectedOutline || activeOutline;
  const targetChapter = chapterBoundToOutline(project, targetOutline);
  const targetIndex = targetChapter ? project.chapters.findIndex(chapter => chapter.id === targetChapter.id) : -1;
  const explicitFormatNumber = instructionChapterNumber(instruction, /(?:参考|按照|依照|沿用|模仿)\s*第?\s*(\d+|[零〇一二三四五六七八九十百千]+)\s*章(?:的)?(?:章纲|大纲)(?:格式|结构|模板)/u);
  const formatOutline = explicitFormatNumber
    ? outlineByChapterNumber(project, explicitFormatNumber)
    : targetIndex > 0 ? outlineByChapterNumber(project, targetIndex) : undefined;
  const formatMode = explicitFormatNumber
    ? (formatOutline ? `作者指定参考第 ${explicitFormatNumber} 章章纲格式` : `未找到第 ${explicitFormatNumber} 章章纲格式`)
    : formatOutline ? '默认参考上一章章纲格式' : '无可用格式参考';
  const useCurrent = /(?:本章|当前章)(?:的)?(?:正文|内容)/u.test(instruction);
  const usePrevious = /(?:上一章|前一章)(?:的)?(?:正文|内容)/u.test(instruction);
  const sourceChapter = explicitSourceNumber ? chapterByNumber(project, explicitSourceNumber)
    : useCurrent ? targetChapter
      : (usePrevious || targetIndex > 0) ? project.chapters[targetIndex - 1]
        : undefined;
  const isFirstChapter = !explicitSourceNumber && !useCurrent && !usePrevious
    && (targetNumber === 1 || targetIndex === 0);
  const sourceMode = explicitSourceNumber
    ? `作者指定第 ${explicitSourceNumber} 章正文`
    : useCurrent ? '作者指定本章正文'
      : sourceChapter ? '默认上一章正文'
        : isFirstChapter ? '首章：根据世界观、作品简介与作者指令生成'
        : '未找到可用正文';
  return { targetOutline, targetChapter, sourceChapter, sourceMode, isFirstChapter, formatOutline, formatMode, explicitTargetNumber, targetRedirectFound: Boolean(redirectedOutline) };
};
