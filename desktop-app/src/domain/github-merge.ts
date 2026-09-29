import type { Chapter, Project } from './project';
import { chapterSnapshotLimit } from './chapter.ts';

export interface GithubMergeResult {
  project: Project;
  /** 远端有、本地没有，直接补回来的章节 */
  addedChapters: string[];
  /** 直接采用远端版本的章节 */
  updatedChapters: string[];
  /** 两边都改过、程序不替作者定夺的章节；落选的那版已经进了该章历史版本 */
  conflictChapters: string[];
  /** 从远端补回的大纲、卡片、记忆、图谱条数 */
  otherUpdates: number;
}

export const githubMergeChanged = (result: GithubMergeResult) => result.addedChapters.length > 0
  || result.updatedChapters.length > 0
  || result.conflictChapters.length > 0
  || result.otherUpdates > 0;

/** Windows 上检出的正文会带 \r\n，不归一化会把整本书都算成改动 */
const normalizeText = (value: string) => (value || '').replace(/\r\n?/g, '\n');

const timeOf = (value?: string) => {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
};

/** 覆盖正文前把落选的那一版压进快照，合并永远不真正删字；savedAt 同时是回滚标识和 React key，必须唯一 */
const withSnapshot = (winner: Chapter, loser: Chapter, reason: string): Chapter => ({
  ...winner,
  content: normalizeText(winner.content),
  snapshots: [
    { content: normalizeText(loser.content), wordCount: loser.wordCount, savedAt: loser.updatedAt, reason },
    ...(winner.snapshots || []),
  ].filter((item, index, list) => list.findIndex(other => other.savedAt === item.savedAt) === index).slice(0, chapterSnapshotLimit),
});

interface Timestamped { id: string | number; updatedAt?: string }

/** 大纲、卡片、记忆、图谱这类带 id 和 updatedAt 的资料：远端独有的补进来，两边都有的取更新的那条 */
const mergeCollection = <T extends Timestamped>(local: T[], remote: T[]): [T[], number] => {
  const merged = [...local];
  const index = new Map(merged.map((item, position) => [String(item.id), position]));
  let changed = 0;
  for (const incoming of remote) {
    const position = index.get(String(incoming.id));
    if (position === undefined) {
      merged.push(incoming);
      changed += 1;
      continue;
    }
    const current = merged[position];
    const currentText = JSON.stringify(current);
    const incomingText = JSON.stringify(incoming);
    if (currentText === incomingText) continue;
    // ponytail: 时间戳一样时按序列化长度取信息更多的一条；本地记忆文档常是空壳，靠这条才能被远端补全。
    // 需要更细的判断就得给每类资料单独写合并规则
    const gap = timeOf(incoming.updatedAt) - timeOf(current.updatedAt);
    if (gap > 0 || (gap === 0 && incomingText.length > currentText.length)) {
      merged[position] = incoming;
      changed += 1;
    }
  }
  return [merged, changed];
};

const mergeChapters = (local: Project, remote: Chapter[], result: GithubMergeResult): Chapter[] => {
  const buried = new Set((local.deletedChapters || []).map(item => item.chapter.id));
  const merged = [...local.chapters];
  const index = new Map(merged.map((chapter, position) => [chapter.id, position]));
  for (const incoming of remote) {
    const position = index.get(incoming.id);
    if (position === undefined) {
      // 本地已经把这章丢进回收站，远端留着的旧副本不再复活
      if (buried.has(incoming.id)) continue;
      // ponytail: 远端独有的章节一律追加到末尾；另一端在中间插章时顺序要作者自己拖，消息里会列出章名
      merged.push({ ...incoming, content: normalizeText(incoming.content) });
      result.addedChapters.push(incoming.title);
      continue;
    }
    const current = merged[position];
    const currentText = normalizeText(current.content);
    const incomingText = normalizeText(incoming.content);
    if (currentText === incomingText) continue;
    // 一方正文完整包含另一方，说明是在另一台电脑上接着往下写，取长的那版即可，不算冲突
    if (currentText.includes(incomingText)) continue;
    if (incomingText.includes(currentText)) {
      merged[position] = { ...incoming, content: incomingText, snapshots: current.snapshots };
      result.updatedChapters.push(incoming.title);
      continue;
    }
    // ponytail: 时间戳不可靠（批量导入会把整本书刷成同一时刻），所以"远端更新"还要求正文没有明显变短；
    // 想更准就得逐段 diff 或让作者逐章确认，这里只保证落选的那版留在历史版本里
    const remoteWins = timeOf(incoming.updatedAt) > timeOf(current.updatedAt) && incomingText.length >= currentText.length * 0.9;
    if (remoteWins) {
      merged[position] = withSnapshot({ ...incoming, snapshots: current.snapshots }, current, 'GitHub 合并前的本地版本');
      result.updatedChapters.push(incoming.title);
      continue;
    }
    merged[position] = withSnapshot(current, incoming, 'GitHub 远端版本');
    result.conflictChapters.push(incoming.title);
  }
  return merged;
};

/**
 * 把 GitHub 上的版本合并进本地小说：远端独有的内容一律补回，两边都改过的章节保留双份（落选的那版进历史版本）。
 * 书名、简介等整本级字段保留本地的——项目 updatedAt 任何改动都会刷新，用它选边会让远端的一次改章覆盖本地的简介。
 * 只在两边确实是同一本书时调用，判定由调用方负责。
 */
export const mergeGithubProject = (local: Project, remote: Project): GithubMergeResult => {
  const result: GithubMergeResult = { project: local, addedChapters: [], updatedChapters: [], conflictChapters: [], otherUpdates: 0 };
  const chapters = mergeChapters(local, remote.chapters || [], result);
  const [outlines, outlineCount] = mergeCollection(local.outlines || [], remote.outlines || []);
  const [cards, cardCount] = mergeCollection(local.cards || [], remote.cards || []);
  const [memories, memoryCount] = mergeCollection(local.memories || [], remote.memories || []);
  const [memoryDocuments, documentCount] = mergeCollection(local.memoryDocuments || [], remote.memoryDocuments || []);
  const [graphNodes, nodeCount] = mergeCollection(local.graphNodes || [], remote.graphNodes || []);
  const [graphEdges, edgeCount] = mergeCollection(local.graphEdges || [], remote.graphEdges || []);
  const [promises, promiseCount] = mergeCollection(local.promises || [], remote.promises || []);
  result.otherUpdates = outlineCount + cardCount + memoryCount + documentCount + nodeCount + edgeCount + promiseCount;
  // 每日码字量两边各记各的，同一天取大的那个，相加会重复统计
  const dailyWords: Record<string, number> = { ...remote.dailyWords, ...local.dailyWords };
  for (const [day, words] of Object.entries(remote.dailyWords || {})) dailyWords[day] = Math.max(words, dailyWords[day] || 0);
  result.project = {
    ...local,
    chapters,
    // 大纲树没有时间戳可比，本地为空时才用远端的
    outline: local.outline?.length ? local.outline : (remote.outline || []),
    outlines,
    cards,
    memories,
    memoryDocuments,
    graphNodes,
    graphEdges,
    ...(local.promises?.length || remote.promises?.length ? { promises } : {}),
    dailyWords,
    wordCount: chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0),
  };
  return result;
};
