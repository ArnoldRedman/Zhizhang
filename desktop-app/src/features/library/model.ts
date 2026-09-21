import { countNovelCharacters } from '../../utils/text';
import type { DismantleChapter, DismantleBook, LibraryBookChapter, LibraryBook, RankingBook, WritingStyle } from '../../domain/library';

const asTextList = (value: unknown, limit = 20) => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean).slice(0, limit)
  : [];

export const localResourceId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export const splitTxtIntoDismantleChapters = (text: string): Array<{ title: string; sourceContent: string }> => {
  const cleaned = text.replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n').trim();
  if (!cleaned) return [];
  // 兼容网文 TXT 常见的标题行：第X章、Chapter X、1、标题、1. 标题、1 标题。
  // 仅识别独立行，避免正文中的普通数字被错误切分。
  const heading = new RegExp('^[\\t 　]*(?:第[\\t 　]*[0-9０-９一二三四五六七八九十百千万零〇两]+[\\t 　]*[章节卷回部篇集].*|(?:chapter|chap\\.?)\\s*[0-9０-９]+(?:[\\t 　]*[-—:：、.．][\\t 　]*.*)?|(?:[0-9０-９]{1,5}|[一二三四五六七八九十百千万零〇两]{1,8})[\\t 　]*[、.．:：\\-—][\\t 　]*(?:\\S.*)?|(?:[0-9０-９]{1,5}|[一二三四五六七八九十百千万零〇两]{1,8})[\\t 　]*$|[0-9０-９]{1,5}[\\t 　]+\\S.*)$', 'gimu');
  const matches = Array.from(cleaned.matchAll(heading));
  if (!matches.length) return [{ title: '第1章', sourceContent: cleaned }];
  const chapters: Array<{ title: string; sourceContent: string }> = [];
  const preface = cleaned.slice(0, matches[0].index).trim();
  if (preface) chapters.push({ title: '序章', sourceContent: preface });
  matches.forEach((match, index) => {
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? cleaned.length;
    const sourceContent = cleaned.slice(start, end).trim();
    const firstBreak = sourceContent.indexOf('\n');
    const title = (firstBreak >= 0 ? sourceContent.slice(0, firstBreak) : sourceContent).trim().slice(0, 100) || `第${chapters.length + 1}章`;
    const body = (firstBreak >= 0 ? sourceContent.slice(firstBreak + 1) : '').trim();
    chapters.push({ title, sourceContent: body || sourceContent });
  });
  return chapters.filter(chapter => chapter.sourceContent.trim());
};

export const readLocalTxtFile = async (file: File): Promise<string> => {
  const bytes = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try { return new TextDecoder('gb18030').decode(bytes); }
    catch { return new TextDecoder().decode(bytes); }
  }
};

export const normalizeDismantleChapter = (chapter: Partial<DismantleChapter>, index: number): DismantleChapter => ({
  id: typeof chapter.id === 'string' ? chapter.id : localResourceId('dismantle-chapter'),
  number: Number(chapter.number) || index + 1,
  title: typeof chapter.title === 'string' && chapter.title.trim() ? chapter.title.trim() : `第${index + 1}章`,
  sourceContent: typeof chapter.sourceContent === 'string' ? chapter.sourceContent : '',
  wordCount: countNovelCharacters(typeof chapter.sourceContent === 'string' ? chapter.sourceContent : ''),
  summary: typeof chapter.summary === 'string' ? chapter.summary : '',
  detailedOutline: typeof chapter.detailedOutline === 'string' ? chapter.detailedOutline : '',
  plotBeats: asTextList(chapter.plotBeats, 10),
  characterDynamics: asTextList(chapter.characterDynamics, 10),
  setupPayoff: asTextList(chapter.setupPayoff, 10),
  pacing: typeof chapter.pacing === 'string' ? chapter.pacing : '',
  rewriteContent: typeof chapter.rewriteContent === 'string' ? chapter.rewriteContent : '',
  status: chapter.status === 'analyzing' || chapter.status === 'analyzed' || chapter.status === 'rewritten' ? chapter.status : 'pending',
  sourcePath: typeof chapter.sourcePath === 'string' ? chapter.sourcePath : undefined,
  outlinePath: typeof chapter.outlinePath === 'string' ? chapter.outlinePath : undefined,
  rewritePath: typeof chapter.rewritePath === 'string' ? chapter.rewritePath : undefined,
  updatedAt: typeof chapter.updatedAt === 'string' ? chapter.updatedAt : new Date().toISOString(),
});

export const normalizeDismantleBook = (book: Partial<DismantleBook>): DismantleBook => {
  const now = new Date().toISOString();
  return {
    id: typeof book.id === 'string' ? book.id : localResourceId('dismantle'),
    title: typeof book.title === 'string' && book.title.trim() ? book.title.trim() : '未命名拆书',
    sourceFileName: typeof book.sourceFileName === 'string' ? book.sourceFileName : '',
    chapters: Array.isArray(book.chapters) ? book.chapters.map((chapter, index) => normalizeDismantleChapter(chapter, index)) : [],
    boundProjectId: typeof book.boundProjectId === 'number' ? book.boundProjectId : undefined,
    sourceLibraryBookId: typeof book.sourceLibraryBookId === 'string' ? book.sourceLibraryBookId : undefined,
    aggregate: book.aggregate && typeof book.aggregate === 'object' && typeof book.aggregate.styleProfile === 'string' ? {
      styleProfile: book.aggregate.styleProfile,
      anchors: Array.isArray(book.aggregate.anchors) ? book.aggregate.anchors.filter(item => item && typeof item.excerpt === 'string') : [],
      emotionModules: Array.isArray(book.aggregate.emotionModules) ? book.aggregate.emotionModules.filter(item => item && typeof item.name === 'string') : [],
      rhythm: typeof book.aggregate.rhythm === 'string' ? book.aggregate.rhythm : '',
      chapterNumbers: Array.isArray(book.aggregate.chapterNumbers) ? book.aggregate.chapterNumbers.filter((item): item is number => typeof item === 'number') : [],
      updatedAt: typeof book.aggregate.updatedAt === 'string' ? book.aggregate.updatedAt : now,
    } : undefined,
    createdAt: typeof book.createdAt === 'string' ? book.createdAt : now,
    updatedAt: typeof book.updatedAt === 'string' ? book.updatedAt : now,
  };
};

export const normalizeLibraryBookChapter = (chapter: Partial<LibraryBookChapter>, index: number): LibraryBookChapter => ({
  id: typeof chapter.id === 'string' ? chapter.id : localResourceId('book-chapter'),
  number: Number(chapter.number) || index + 1,
  title: typeof chapter.title === 'string' && chapter.title.trim() ? chapter.title.trim() : `第${index + 1}章`,
  url: typeof chapter.url === 'string' ? chapter.url : '',
  content: typeof chapter.content === 'string' ? chapter.content : '',
  wordCount: countNovelCharacters(typeof chapter.content === 'string' ? chapter.content : ''),
  downloaded: chapter.downloaded === true && Boolean(chapter.content?.trim()),
  unavailableReason: typeof chapter.unavailableReason === 'string' ? chapter.unavailableReason : undefined,
  outline: typeof chapter.outline === 'string' ? chapter.outline : undefined,
});

export const normalizeLibraryBook = (book: Partial<LibraryBook>): LibraryBook => {
  const now = new Date().toISOString();
  return {
    id: typeof book.id === 'string' ? book.id : localResourceId('book'),
    title: typeof book.title === 'string' && book.title.trim() ? book.title.trim() : '未命名书籍',
    author: typeof book.author === 'string' ? book.author : '未知作者',
    source: typeof book.source === 'string' ? book.source : '番茄小说',
    sourceId: typeof book.sourceId === 'string' ? book.sourceId : undefined,
    sourceBookId: typeof book.sourceBookId === 'string' ? book.sourceBookId : undefined,
    url: typeof book.url === 'string' ? book.url : '',
    intro: typeof book.intro === 'string' ? book.intro : '',
    cover: typeof book.cover === 'string' ? book.cover : undefined,
    category: typeof book.category === 'string' ? book.category : undefined,
    wordCount: Number(book.wordCount) || undefined,
    chapters: Array.isArray(book.chapters) ? book.chapters.map((chapter, index) => normalizeLibraryBookChapter(chapter, index)) : [],
    downloadedAt: typeof book.downloadedAt === 'string' ? book.downloadedAt : undefined,
    createdAt: typeof book.createdAt === 'string' ? book.createdAt : now,
    updatedAt: typeof book.updatedAt === 'string' ? book.updatedAt : now,
    localPath: typeof book.localPath === 'string' ? book.localPath : undefined,
    fontCss: typeof book.fontCss === 'string' ? book.fontCss : undefined,
  };
};

export const normalizeRankingBook = (book: Partial<RankingBook>, index: number): RankingBook => ({
  id: typeof book.id === 'string' ? book.id : localResourceId('ranking-book'),
  sourceId: typeof book.sourceId === 'string' ? book.sourceId : undefined,
  title: typeof book.title === 'string' ? book.title : '未命名书籍',
  author: typeof book.author === 'string' ? book.author : '未知作者',
  intro: typeof book.intro === 'string' ? book.intro : '',
  cover: typeof book.cover === 'string' ? book.cover.replace(/^http:/iu, 'https:') : undefined,
  category: typeof book.category === 'string' ? book.category : undefined,
  rank: Number(book.rank) || index + 1,
  rankType: book.rankType === 'new' || book.rankType === 'hot' || book.rankType === 'completed' || book.rankType === 'collect' ? book.rankType : 'read',
  gender: book.gender === 'male' || book.gender === 'female' ? book.gender : 'all',
  platform: book.platform === 'qidian' || book.platform === 'faloo' ? book.platform : 'fanqie',
  sourceBookId: typeof book.sourceBookId === 'string' ? book.sourceBookId : undefined,
  url: typeof book.url === 'string' ? book.url : '',
  wordCount: Number(book.wordCount) || undefined,
  readCount: Number(book.readCount) || undefined,
  fetchedAt: typeof book.fetchedAt === 'string' ? book.fetchedAt : new Date().toISOString(),
  sourceName: typeof book.sourceName === 'string' ? book.sourceName : undefined,
});

export const trustedRankingCache = (book: RankingBook) => book.platform !== 'fanqie' || book.sourceName === '番茄小说网';

export const normalizeWritingStyle = (style: Partial<WritingStyle>): WritingStyle => {
  const now = new Date().toISOString();
  return {
    id: typeof style.id === 'string' ? style.id : localResourceId('style'),
    name: typeof style.name === 'string' && style.name.trim() ? style.name.trim() : '未命名文风',
    description: typeof style.description === 'string' ? style.description : '',
    tags: asTextList(style.tags, 12),
    content: typeof style.content === 'string' ? style.content : '',
    sourceBookId: typeof style.sourceBookId === 'string' ? style.sourceBookId : undefined,
    createdAt: typeof style.createdAt === 'string' ? style.createdAt : now,
    updatedAt: typeof style.updatedAt === 'string' ? style.updatedAt : now,
    sourcePath: typeof style.sourcePath === 'string' ? style.sourcePath : undefined,
  };
};

