import type { Project } from './project';

export type ExportFormat = 'txt' | 'md';

/** 导出范围：全书或单章 */
export interface ExportOptions {
  format: ExportFormat;
  /** 附上世界观、总纲、章纲等大纲文档 */
  includeOutlines: boolean;
  /** 附上角色卡等设定卡片 */
  includeCards: boolean;
}

export const defaultExportOptions: ExportOptions = { format: 'txt', includeOutlines: false, includeCards: false };

const separator = (format: ExportFormat) => format === 'md' ? '\n\n' : '\n\n\n';

const heading = (format: ExportFormat, level: number, text: string) =>
  format === 'md' ? `${'#'.repeat(level)} ${text}` : text;

export function buildChapterExport(project: Project, chapterId: number, format: ExportFormat): string {
  const chapter = project.chapters.find(item => item.id === chapterId);
  if (!chapter) return '';
  const note = chapter.authorNote?.trim() ? `\n\n【作家的话】\n${chapter.authorNote.trim()}` : '';
  return `${heading(format, 2, chapter.title)}\n\n${chapter.content.trim()}${note}\n`;
}

/** 全书导出：书名、简介、可选设定，然后按当前章节顺序拼接正文 */
export function buildProjectExport(project: Project, options: ExportOptions): string {
  const { format } = options;
  const blocks: string[] = [heading(format, 1, project.title)];

  const meta = [
    project.genre && `类型：${project.genre}${project.subgenre ? ` · ${project.subgenre}` : ''}`,
    `共 ${project.chapters.length} 章 · ${project.wordCount.toLocaleString()} 字`,
    `导出时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
  ].filter(Boolean);
  blocks.push(meta.join('\n'));

  if (project.synopsis?.trim()) blocks.push(`${heading(format, 2, '简介')}\n\n${project.synopsis.trim()}`);

  if (options.includeOutlines && project.outlines.length) {
    blocks.push(heading(format, 2, '大纲与设定'));
    for (const outline of project.outlines) {
      blocks.push(`${heading(format, 3, `${outline.kind}｜${outline.title}`)}\n\n${outline.content.trim()}`);
    }
  }

  if (options.includeCards && project.cards.length) {
    blocks.push(heading(format, 2, '设定卡片'));
    for (const card of project.cards) {
      const state = card.currentState?.trim() ? `\n\n当前状态：${card.currentState.trim()}` : '';
      blocks.push(`${heading(format, 3, `${card.type}｜${card.title}`)}\n\n${card.content.trim()}${state}`);
    }
  }

  blocks.push(heading(format, 2, '正文'));
  for (const chapter of project.chapters) {
    const note = chapter.authorNote?.trim() ? `\n\n【作家的话】\n${chapter.authorNote.trim()}` : '';
    blocks.push(`${heading(format, 3, chapter.title)}\n\n${chapter.content.trim()}${note}`);
  }

  return `${blocks.join(separator(format))}\n`;
}

/** 去掉文件名里系统不接受的字符，与 Rust 端 safe_folder_name 保持一致 */
export function safeExportFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/gu, '_').replace(/^[.\s]+|[.\s]+$/gu, '').trim();
  return cleaned || '未命名';
}

export function exportFileName(project: Project, options: ExportOptions, chapterTitle?: string): string {
  const base = chapterTitle ? `${project.title}-${chapterTitle}` : project.title;
  return `${safeExportFileName(base)}.${options.format}`;
}
