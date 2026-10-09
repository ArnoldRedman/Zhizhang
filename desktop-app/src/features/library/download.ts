import type { LibraryBook, LibraryBookChapter } from '../../domain/library';

// 仅在同一书源的同一本书内合并，失败重下不能清掉已有正文和人工章纲
export const mergeDownloadedChapters = (previous: LibraryBookChapter[], incoming: LibraryBookChapter[]): LibraryBookChapter[] => {
  const key = (chapter: LibraryBookChapter) => chapter.url || chapter.id;
  const old = new Map(previous.map(chapter => [key(chapter), chapter]));
  const seen = new Set<string>();
  const chapters = incoming.map(chapter => {
    seen.add(key(chapter));
    const existing = old.get(key(chapter));
    if (!existing) return chapter;
    if (!chapter.downloaded && existing.content.trim()) return { ...existing, number: chapter.number, unavailableReason: existing.downloaded ? undefined : chapter.unavailableReason };
    return { ...chapter, id: existing.id, outline: existing.outline };
  });
  return [...chapters, ...previous.filter(chapter => !seen.has(key(chapter)))];
};

export const matchDownloadBook = (books: LibraryBook[], title: string, author: string): LibraryBook | undefined => {
  const normalize = (text: string) => text.replace(/\s/gu, '').trim();
  const matches = books.filter(book => normalize(book.title) === normalize(title));
  const knownAuthor = author.trim() && author !== '未知作者';
  return knownAuthor ? matches.find(book => normalize(book.author) === normalize(author)) : matches.length === 1 ? matches[0] : undefined;
};
