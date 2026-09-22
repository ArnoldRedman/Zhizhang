import type { AuthorQuestion, CardCandidate, OutlineDocument, OutlineKind, Project } from './project';

/** 同一毫秒内连续登记会拿到相同时间戳，id 是答复与忽略的定位键，必须唯一 */
const uniqueSuffix = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** 覆盖前保留的历史版本数量：总纲一次几千字，三份够回退，再多 metadata 就胖了 */
export const outlineSnapshotLimit = 3;

/** 总纲与世界观类文档是作者的长期资料，被模型覆盖前必须留底；章纲每次重来本来就该整份换 */
export const outlineKeepsHistory = (kind: OutlineKind) => kind === '总纲' || kind === '世界观与作品设定';

/** 覆盖大纲正文前压入一条历史版本；只对总纲与世界观类生效 */
export const pushOutlineSnapshot = (outline: OutlineDocument, reason: string): OutlineDocument => {
  if (!outlineKeepsHistory(outline.kind) || !outline.content.trim()) return outline;
  const existing = outline.snapshots || [];
  let stamp = Date.now();
  const newest = existing[0] ? Date.parse(existing[0].savedAt) : 0;
  if (stamp <= newest) stamp = newest + 1;
  return { ...outline, snapshots: [{ content: outline.content, savedAt: new Date(stamp).toISOString(), reason }, ...existing].slice(0, outlineSnapshotLimit) };
};

/** 用某条历史版本换回正文，当前正文再入栈，回滚可以再回滚 */
export const restoreOutlineSnapshot = (outline: OutlineDocument, savedAt: string): OutlineDocument => {
  const target = outline.snapshots?.find(snapshot => snapshot.savedAt === savedAt);
  if (!target) return outline;
  const withCurrent = pushOutlineSnapshot(outline, '回滚前');
  return {
    ...withCurrent,
    content: target.content,
    updatedAt: new Date().toISOString(),
    snapshots: (withCurrent.snapshots || []).filter(snapshot => snapshot.savedAt !== savedAt),
  };
};

/** 模型明说自己写的是"追加件""补充"：标题或开头几行带这些词，就不该拿它覆盖整份文档 */
const appendixPattern = /(?:追加件|追加部分|补充件|续写部分|以下.{0,12}(?:追加|补充|续写)|原有.{0,20}(?:保留|不动))/u;

/**
 * 把模型生成的内容合并进已有的总纲或世界观文档
 * 2026-09-18 大纲智能体返回一份"总纲（追加件）"，开头写着"原有部分全部保留不动"，应用照样整份覆盖，
 * 六千字的分卷总纲就此丢失，靠 GitHub 备份才找回来。总纲和世界观类文档只做两种事：
 * 模型标明是追加的就接在末尾；否则整份替换但先留历史版本。章纲照旧整份替换
 */
export const mergeGeneratedOutline = (outline: OutlineDocument, generated: string, reason: string): OutlineDocument => {
  const content = generated.trim();
  if (!content) return outline;
  const now = new Date().toISOString();
  if (!outlineKeepsHistory(outline.kind) || !outline.content.trim()) return { ...outline, content, updatedAt: now };
  const head = content.split('\n').slice(0, 6).join('\n');
  if (appendixPattern.test(head)) {
    // 追加件自带一个一级标题，接在原文后面会出现两个"# 总纲"，把它降成二级
    const body = content.replace(/^#\s+[^\n]*\n+/u, '').trim();
    return { ...pushOutlineSnapshot(outline, reason), content: `${outline.content.trimEnd()}\n\n---\n\n## 追加（${now.slice(0, 10)}）\n\n${body}\n`, updatedAt: now };
  }
  return { ...pushOutlineSnapshot(outline, reason), content, updatedAt: now };
};

/** 大纲页的分组顺序：长期资料在前，逐章产物在后，报告最后 */
export type OutlineGroup = '总纲' | '世界观与作品设定' | '阶段节拍' | '章纲' | '审查报告';
export const outlineGroupOrder: OutlineGroup[] = ['总纲', '世界观与作品设定', '阶段节拍', '章纲', '审查报告'];

export const outlineGroupOf = (outline: OutlineDocument): OutlineGroup => {
  if (outline.kind === '章纲' && /^阶段节拍｜/u.test(outline.title)) return '阶段节拍';
  if (outline.kind === '审查报告' || outline.kind === '总纲' || outline.kind === '世界观与作品设定') return outline.kind;
  return '章纲';
};

/** 分组后的大纲列表；章纲与审查报告按章号倒序（最近写的在上面），其余按原顺序 */
export const groupOutlines = (outlines: OutlineDocument[]): Array<{ group: OutlineGroup; items: OutlineDocument[] }> => {
  const chapterNumber = (outline: OutlineDocument) => Number(/第\s*(\d{1,4})\s*章/u.exec(outline.title)?.[1] || 0);
  return outlineGroupOrder
    .map(group => {
      const items = outlines.filter(outline => outlineGroupOf(outline) === group);
      if (group === '章纲' || group === '审查报告') items.sort((left, right) => chapterNumber(right) - chapterNumber(left));
      return { group, items };
    })
    .filter(entry => entry.items.length > 0);
};

/** 某一章的审查报告标题前缀；重写或修订这一章后旧报告说的是被换掉的稿子，要删 */
export const reviewReportTitleFor = (chapterNumber: number) => `审查报告｜第 ${chapterNumber} 章`;

export const removeReviewReportsForChapter = (project: Project, chapterNumber: number): Project => {
  const prefix = reviewReportTitleFor(chapterNumber);
  const stale = project.outlines.filter(outline => outline.kind === '审查报告' && (outline.title === prefix || outline.title.startsWith(`${prefix} `)));
  if (!stale.length) return project;
  const ids = new Set(stale.map(outline => outline.id));
  return {
    ...project,
    outlines: project.outlines.filter(outline => !ids.has(outline.id)),
    graphNodes: project.graphNodes.filter(node => !ids.has(Number(node.id.replace(/^outline:/u, '')))),
    updatedAt: new Date().toISOString(),
  };
};

/**
 * 记下模型这一章向作者提的问题
 * 同一章重跑会再问一遍：问题原文相同就沿用旧条目（连答复一起留着），不重复登记
 */
export const recordAuthorQuestions = (project: Project, chapterNumber: number, chapterTitle: string, questions: string[]): Project => {
  const cleaned = questions.map(item => item.trim()).filter(Boolean);
  if (!cleaned.length) return project;
  const existing = project.authorQuestions || [];
  const now = new Date().toISOString();
  const fresh = cleaned
    .filter(question => !existing.some(item => item.question === question))
    .map(question => ({ id: `q-${uniqueSuffix()}`, chapterNumber, chapterTitle, question, answer: '', askedAt: now }));
  if (!fresh.length) return project;
  return { ...project, authorQuestions: [...existing, ...fresh], updatedAt: now };
};

export const answerAuthorQuestion = (project: Project, id: string, answer: string): Project => {
  const now = new Date().toISOString();
  const trimmed = answer.trim();
  return {
    ...project,
    authorQuestions: (project.authorQuestions || []).map(item => item.id === id ? { ...item, answer: trimmed, answeredAt: trimmed ? now : undefined } : item),
    updatedAt: now,
  };
};

export const dismissAuthorQuestion = (project: Project, id: string): Project => ({
  ...project,
  authorQuestions: (project.authorQuestions || []).filter(item => item.id !== id),
  updatedAt: new Date().toISOString(),
});

export const pendingAuthorQuestions = (project: Project): AuthorQuestion[] => (project.authorQuestions || []).filter(item => !item.answer.trim());

/**
 * 进提示词的"作者已答复"：最近二十条，一问一答；模型问过的事作者已经拍板，之后每章都得照着写
 * 只带最近的：一本书写两百章会攒下很多问答，早期的多半已经写进卡片或总纲
 */
export const answeredAuthorQuestions = (project: Project, limit = 20): Array<{ question: string; answer: string }> => (project.authorQuestions || [])
  .filter(item => item.answer.trim())
  .slice(-limit)
  .map(item => ({ question: item.question, answer: item.answer }));

/**
 * 登记记忆提炼发现的"本章新出现"为待建卡候选
 * 已有同名卡、已在候选里、作者忽略过的都不再提；一条候选只登记一次
 */
export const addCardCandidates = (project: Project, chapterNumber: number, chapterTitle: string, names: string[]): Project => {
  const cleaned = names.map(item => item.trim()).filter(Boolean);
  if (!cleaned.length) return project;
  const existing = project.cardCandidates || [];
  const ignored = new Set(project.ignoredCardCandidates || []);
  const cardTitles = new Set(project.cards.map(card => card.title.trim()));
  // 候选名常带说明："小何：栖迟书肆后间伙计……"，比对时只看冒号前的名字
  const key = (name: string) => name.split(/[：:（(]/u)[0].trim();
  const now = new Date().toISOString();
  const fresh: CardCandidate[] = cleaned
    .filter(name => !cardTitles.has(key(name)) && !ignored.has(key(name)) && !existing.some(item => key(item.name) === key(name)))
    .map(name => ({ id: `cc-${uniqueSuffix()}`, name, chapterNumber, chapterTitle, createdAt: now }));
  if (!fresh.length) return project;
  return { ...project, cardCandidates: [...existing, ...fresh], updatedAt: now };
};

export const removeCardCandidate = (project: Project, id: string, ignore: boolean): Project => {
  const target = (project.cardCandidates || []).find(item => item.id === id);
  if (!target) return project;
  const name = target.name.split(/[：:（(]/u)[0].trim();
  return {
    ...project,
    cardCandidates: (project.cardCandidates || []).filter(item => item.id !== id),
    ignoredCardCandidates: ignore ? Array.from(new Set([...(project.ignoredCardCandidates || []), name])).slice(-200) : project.ignoredCardCandidates,
    updatedAt: new Date().toISOString(),
  };
};

const candidateLinePattern = /^- 本章新出现，要不要建卡：(.+)$/u;

/**
 * 把旧版"给作者｜待答"文档里堆着的"本章新出现，要不要建卡"条目搬进待建卡列表
 * 2026-09-22 之前这些条目只能在文档里看，没有任何按钮能建卡；实测一本书攒了 127 条没人动。
 * 搬完把这些行从文档里删掉，只剩审查意见的章节段落照旧；文档没有这类行时原样返回，不制造无关差异
 */
export const migrateCardCandidatesFromNotes = (project: Project): Project => {
  const document = project.outlines.find(outline => outline.kind === '审查报告' && outline.title === '给作者｜待答');
  if (!document || !candidateLinePattern.test(document.content.split('\n').find(line => candidateLinePattern.test(line)) || '')) return project;
  let next = project;
  let chapterNumber = 0;
  let chapterTitle = '';
  const kept: string[] = [];
  for (const line of document.content.split('\n')) {
    const heading = /^## 第\s*(\d+)\s*章\s*(.*)$/u.exec(line);
    if (heading) {
      chapterNumber = Number(heading[1]);
      chapterTitle = `第 ${heading[1]} 章 ${heading[2]}`.trim();
    }
    const candidate = candidateLinePattern.exec(line);
    if (candidate) {
      next = addCardCandidates(next, chapterNumber, chapterTitle, [candidate[1]]);
      continue;
    }
    kept.push(line);
  }
  // 条目搬走后只剩标题的章节段落一并去掉
  const sections = kept.join('\n').split(/\n(?=## )/u).filter(section => !/^## /u.test(section) || section.split('\n').slice(1).some(line => line.trim()));
  const content = sections.join('\n').replace(/\n{3,}/gu, '\n\n').trimEnd() + '\n';
  return {
    ...next,
    outlines: next.outlines.map(outline => outline.id === document.id ? { ...outline, content, updatedAt: new Date().toISOString() } : outline),
  };
};
