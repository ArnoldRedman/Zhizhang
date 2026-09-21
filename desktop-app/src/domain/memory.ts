import type { Chapter, ChapterMemory, MemoryDocument, MemoryDocumentKind, Project } from './project';

/** 记忆中心的聚合文档种类，顺序即界面上的标签顺序 */
export const memoryDocumentKinds: MemoryDocumentKind[] = ['章节快照', '人物状态', '角色认知', '伏笔追踪', '时间线', '设定事实', '冲突'];

export const memoryDocumentId = (kind: MemoryDocumentKind) => `memory-document:${kind}`;
export const asTextList = (value: unknown, limit = 20) => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean).slice(0, limit)
  : [];
export const memoryTextList = (value: string) => value.split(/\r?\n|、/).map(item => item.trim()).filter(Boolean).slice(0, 30);

export const chapterOrder = (memory: ChapterMemory) => memory.sourceChapterNumber ?? memory.chapterId;
export const memoryListMarkdown = (items: string[]) => items.length ? items.map(item => `- ${item}`).join('\n') : '- 暂无';

/** 模型记忆提炼的返回字段（只取记忆相关部分，图谱和卡片变更走别的路） */
export type MemoryExtractionResult = {
  summary?: string;
  keywords?: string[];
  characterStateChanges?: string[];
  knowledgeChanges?: string[];
  foreshadowingChanges?: string[];
  foreshadowingItems?: ChapterMemory['foreshadowingItems'];
  timelineEvents?: string[];
  canonFacts?: string[];
  conflicts?: string[];
  relationshipState?: string[];
  readerKnown?: string[];
  authorTruth?: string[];
  nextChapterPromise?: string;
  newlyIntroduced?: string[];
  endingHook?: string;
};

/**
 * 把模型返回的记忆字段合并成一条章节记忆
 * 单章保存和批量补全共用这一份规则：分开写迟早会漂移，两边的记忆就会不一样
 */
export const buildChapterMemoryPatch = (options: {
  result: MemoryExtractionResult;
  local: ReturnType<typeof buildLocalStructuredMemory>;
  /** 关键词优先用卡片标题，没有才回落本地启发式 */
  keywords: string[];
  existing?: ChapterMemory;
}): Partial<ChapterMemory> => {
  const { result, local, keywords, existing } = options;
  const summary = result.summary?.trim() || local.summary;
  const aiStructuredFieldCount = [
    result.characterStateChanges,
    result.knowledgeChanges,
    result.foreshadowingChanges,
    result.timelineEvents,
    result.canonFacts,
    result.conflicts,
  ].filter(value => asTextList(value).length > 0).length + (result.endingHook?.trim() ? 1 : 0);
  // 模型给出的是一整套成体系的判断，单独掺一两个本地启发式字段反而会让记忆变糊
  const useCoherentAIResult = aiStructuredFieldCount >= 3;
  const preferAIList = (value: unknown, fallback: string[], fallbackExisting: string[] | undefined) => {
    const extracted = asTextList(value);
    if (useCoherentAIResult) return extracted;
    return extracted.length ? extracted : (fallback.length ? fallback : (fallbackExisting || []));
  };
  return {
    summary,
    keywords: Array.isArray(result.keywords) && result.keywords.length ? asTextList(result.keywords, 8) : keywords,
    characterStateChanges: preferAIList(result.characterStateChanges, local.characterStateChanges, existing?.characterStateChanges),
    knowledgeChanges: preferAIList(result.knowledgeChanges, local.knowledgeChanges, existing?.knowledgeChanges),
    foreshadowingChanges: preferAIList(result.foreshadowingChanges, local.foreshadowingChanges, existing?.foreshadowingChanges),
    // 结构化伏笔没返回时保留原值，别把已经记下的伏笔抹掉
    foreshadowingItems: Array.isArray(result.foreshadowingItems) && result.foreshadowingItems.length ? result.foreshadowingItems : (existing?.foreshadowingItems || []),
    timelineEvents: preferAIList(result.timelineEvents, local.timelineEvents, existing?.timelineEvents),
    canonFacts: preferAIList(result.canonFacts, local.canonFacts, existing?.canonFacts),
    conflicts: preferAIList(result.conflicts, local.conflicts, existing?.conflicts),
    // 人物关系只有模型能提炼，本地启发式给不出；没返回时保留原值
    relationshipState: asTextList(result.relationshipState, 8).length ? asTextList(result.relationshipState, 8) : (existing?.relationshipState || []),
    readerKnown: asTextList(result.readerKnown, 10).length ? asTextList(result.readerKnown, 10) : (existing?.readerKnown || []),
    authorTruth: asTextList(result.authorTruth, 6).length ? asTextList(result.authorTruth, 6) : (existing?.authorTruth || []),
    nextChapterPromise: typeof result.nextChapterPromise === 'string' && result.nextChapterPromise.trim() ? result.nextChapterPromise.trim() : (existing?.nextChapterPromise || ''),
    newlyIntroduced: asTextList(result.newlyIntroduced, 12).length ? asTextList(result.newlyIntroduced, 12) : (existing?.newlyIntroduced || []),
    endingHook: typeof result.endingHook === 'string' && result.endingHook.trim() ? result.endingHook.trim() : (local.endingHook || existing?.endingHook || ''),
    // 这份补丁只在模型返回之后才会构造，合并时间就是提炼时间
    refinedAt: new Date().toISOString(),
  };
};

/** 有没有模型提炼出的结构化字段：本地兜底只有摘要和关键词，结构化列表全空 */
export const hasStructuredMemory = (memory: ChapterMemory) => Boolean((memory.summary || '').trim())
  && [memory.characterStateChanges, memory.knowledgeChanges, memory.foreshadowingChanges, memory.timelineEvents, memory.canonFacts, memory.conflicts]
    .some(list => (list || []).length > 0);

/** 记忆最近一次模型提炼的时间；2026-09-21 之前的记忆没有 refinedAt，带结构化字段的就按 updatedAt 当作提炼过 */
export const memoryRefinedAt = (memory: ChapterMemory) => memory.refinedAt || (hasStructuredMemory(memory) ? memory.updatedAt : '');

/**
 * 这一章的记忆是不是落后于正文：没有记忆、只有本地兜底、或正文在提炼之后又改过
 * 空章不算，删空正文时记忆本来就会被移除
 */
export const chapterMemoryStale = (memory: ChapterMemory | undefined, chapter: Chapter) => {
  if (!chapter.content.trim()) return false;
  const refinedAt = memory ? memoryRefinedAt(memory) : '';
  return !refinedAt || refinedAt < chapter.updatedAt;
};

/** 记忆落后于正文的章，按目录顺序带章号；补全记忆和记忆中心的提示都用它 */
export const staleMemoryChapters = (project: Pick<Project, 'chapters' | 'memories'>) => project.chapters
  .map((chapter, index) => ({ chapter, number: index + 1, memory: project.memories.find(memory => memory.chapterId === chapter.id) }))
  .filter(({ chapter, memory }) => chapterMemoryStale(memory, chapter));

export const buildMemoryDocuments = (memories: ChapterMemory[], existingDocuments: MemoryDocument[] = [], force = false): MemoryDocument[] => {
  const ordered = [...memories].sort((left, right) => chapterOrder(left) - chapterOrder(right));
  const sections = (title: string, entries: Array<{ memory: ChapterMemory; items: string[] }>) => `# ${title}\n\n${entries.length
    ? entries.map(({ memory, items }) => `## ${memory.chapterTitle}\n${memoryListMarkdown(items)}`).join('\n\n')
    : '暂无已保存章节记忆。'}\n`;
  const documentContent: Record<MemoryDocumentKind, string> = {
    '章节快照': `# 章节快照\n\n${ordered.length ? ordered.map(memory => `## ${memory.chapterTitle}\n${memory.summary || '暂无摘要'}\n\n关键词：${memory.keywords.join('、') || '暂无'}\n\n人物状态：${memory.characterStateChanges.join('；') || '暂无'}\n认知变化：${memory.knowledgeChanges.join('；') || '暂无'}\n伏笔：${memory.foreshadowingChanges.join('；') || '暂无'}\n时间线：${memory.timelineEvents.join('；') || '暂无'}\n设定事实：${memory.canonFacts.join('；') || '暂无'}\n冲突：${memory.conflicts.join('；') || '暂无'}\n章末钩子：${memory.endingHook || '暂无'}`).join('\n\n---\n\n') : '暂无已保存章节记忆。'}\n`,
    '人物状态': sections('人物状态', ordered.map(memory => ({ memory, items: [...memory.characterStateChanges, ...(memory.relationshipState || []).map(item => `关系与情绪：${item}`)] }))),
    '角色认知': sections('角色认知', ordered.map(memory => ({ memory, items: memory.knowledgeChanges }))),
    '伏笔追踪': sections('伏笔追踪', ordered.map(memory => ({ memory, items: memory.foreshadowingChanges }))),
    '时间线': sections('时间线', ordered.map(memory => ({ memory, items: memory.timelineEvents }))),
    '设定事实': sections('设定事实', ordered.map(memory => ({ memory, items: memory.canonFacts }))),
    '冲突': sections('冲突', ordered.map(memory => ({ memory, items: memory.conflicts }))),
  };
  const now = new Date().toISOString();
  return memoryDocumentKinds.map(kind => {
    const existing = existingDocuments.find(document => document.kind === kind);
    const preserveManual = Boolean(existing?.manuallyEdited) && !force;
    return {
      id: memoryDocumentId(kind),
      kind,
      title: kind,
      content: preserveManual ? existing?.content ?? documentContent[kind] : documentContent[kind],
      updatedAt: preserveManual ? existing?.updatedAt ?? now : now,
      manuallyEdited: preserveManual,
    };
  });
};

export const hydrateMemoryDocuments = (documents: unknown, memories: ChapterMemory[]): MemoryDocument[] => {
  const generated = buildMemoryDocuments(memories);
  if (!Array.isArray(documents) || documents.length === 0) return generated;
  return generated.map(template => {
    const saved = documents.find(item => item && typeof item === 'object' && (item as MemoryDocument).kind === template.kind) as Partial<MemoryDocument> | undefined;
    if (!saved) return template;
    const content = typeof saved.content === 'string' ? saved.content : template.content;
    return {
      ...template,
      ...saved,
      id: memoryDocumentId(template.kind),
      kind: template.kind,
      title: template.kind,
      content,
      manuallyEdited: Boolean(saved.manuallyEdited) || content !== template.content,
    };
  });
};

export const normalizeChapterMemory = (memory: Partial<ChapterMemory>, fallbackChapter?: Chapter): ChapterMemory => {
  const now = new Date().toISOString();
  return {
    id: typeof memory.id === 'number' ? memory.id : Date.now(),
    chapterId: typeof memory.chapterId === 'number' ? memory.chapterId : (fallbackChapter?.id ?? 0),
    chapterTitle: typeof memory.chapterTitle === 'string' ? memory.chapterTitle : (fallbackChapter?.title ?? '未命名章节'),
    summary: typeof memory.summary === 'string' ? memory.summary : '',
    keywords: asTextList(memory.keywords, 8),
    characterStateChanges: asTextList(memory.characterStateChanges),
    knowledgeChanges: asTextList(memory.knowledgeChanges),
    foreshadowingChanges: asTextList(memory.foreshadowingChanges),
    foreshadowingItems: Array.isArray(memory.foreshadowingItems) ? memory.foreshadowingItems.filter(item => item && typeof item.text === 'string').map(item => ({ ...item, status: item.status || 'active', priority: item.priority || 'normal' })) : [],
    timelineEvents: asTextList(memory.timelineEvents),
    canonFacts: asTextList(memory.canonFacts),
    conflicts: asTextList(memory.conflicts),
    relationshipState: asTextList(memory.relationshipState, 8),
    readerKnown: asTextList(memory.readerKnown, 10),
    authorTruth: asTextList(memory.authorTruth, 6),
    nextChapterPromise: typeof memory.nextChapterPromise === 'string' ? memory.nextChapterPromise : '',
    newlyIntroduced: asTextList(memory.newlyIntroduced, 12),
    endingHook: typeof memory.endingHook === 'string' ? memory.endingHook : '',
    sourceChapterNumber: typeof memory.sourceChapterNumber === 'number' ? memory.sourceChapterNumber : undefined,
    createdAt: typeof memory.createdAt === 'string' ? memory.createdAt : now,
    updatedAt: typeof memory.updatedAt === 'string' ? memory.updatedAt : (typeof memory.createdAt === 'string' ? memory.createdAt : now),
    refinedAt: typeof memory.refinedAt === 'string' ? memory.refinedAt : undefined,
  };
};

export const buildLocalChapterSummary = (content: string) => {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 220) return normalized;
  const sentences = normalized.match(/[^。！？.!?]+[。！？.!?]?/g) ?? [];
  const summary = sentences.slice(0, 3).join('').trim();
  return summary.length > 220 ? `${summary.slice(0, 220)}...` : summary;
};

export const extractLocalKeywords = (content: string) => {
  const ignored = new Set(['这一章', '故事', '小说', '主角', '他们', '自己', '已经', '没有', '一个', '什么']);
  const matches = content.match(/[\u4e00-\u9fff]{2,6}/g) ?? [];
  return Array.from(new Set(matches.filter(word => !ignored.has(word)))).slice(0, 8);
};

export const chapterSentences = (content: string) => content
  .replace(/\s+/gu, ' ')
  .split(/(?<=[。！？!?])/u)
  .map(sentence => sentence.trim())
  .filter(sentence => sentence.length >= 8);

// This is intentionally conservative: it gives a saved chapter a useful local
// memory immediately, while the model can later refine it. It also prevents an
// iOS network/SSE failure from replacing all structured fields with empty lists.
export const buildLocalStructuredMemory = (chapter: Chapter, project: Project) => {
  const sentences = chapterSentences(chapter.content);
  const namedCharacters = Array.from(new Set([
    project.protagonist1,
    project.protagonist2,
    ...project.cards.filter(card => card.type === '角色卡').flatMap(card => {
      const aliases = card.content.match(/(?:姓名|名称|本名|别名|称号|代号)\s*[：:]\s*([^\n；;，,]+)/gu) ?? [];
      return [card.title, ...aliases.map(alias => alias.replace(/^.*?[：:]/u, '').trim())];
    }),
  ].map(name => (name || '').trim()).filter(name => name.length >= 2 && name.length <= 24)));
  const quote = (sentence: string, limit = 110) => sentence.length > limit ? `${sentence.slice(0, limit)}...` : sentence;
  const sentencesFor = (name: string) => sentences.filter(sentence => sentence.includes(name));
  const stateSignals = /(?:受伤|恢复|突破|晋升|获得|失去|决定|答应|拒绝|愤怒|紧张|恐惧|欣喜|冷静|昏迷|逃离|抵达|离开|出现|死亡|复活|怀疑|对峙|交手|战胜|失败)/u;
  const knowledgeSignals = /(?:得知|发现|意识到|明白|知晓|看出|听说|告知|透露|隐瞒|秘密|真相|怀疑|认出|记起|见到|听到|收到|面对|接触|阅读|察觉)/u;
  const characterStateChanges = namedCharacters.flatMap(name => {
    const evidence = sentencesFor(name).find(sentence => stateSignals.test(sentence)) || sentencesFor(name)[0];
    return evidence ? [`${name}：${quote(evidence)}`] : [];
  }).slice(0, 12);
  const knowledgeChanges = namedCharacters.flatMap(name => {
    const evidence = sentencesFor(name).find(sentence => knowledgeSignals.test(sentence));
    return evidence ? [`${name}：${quote(evidence)}`] : [];
  }).slice(0, 12);
  const explicitForeshadowing = sentences.filter(sentence => /(?:伏笔|秘密|异常|似乎|预感|未知|线索|暗中|背后|等待|不对劲|尚未|还没|未曾|将要|明天|计划|任务|目标|约定)/u.test(sentence)).slice(-4).map(sentence => quote(sentence));
  const timelineEvents = sentences.filter(sentence => /(?:此时|随后|当晚|次日|清晨|傍晚|终于|之后|不久|刚刚|同时)/u.test(sentence)).slice(0, 6).map(sentence => quote(sentence));
  const canonFacts = sentences.filter(sentence => /(?:规则|能力|境界|系统|必须|不能|限制|代价|身份|设定)/u.test(sentence)).slice(0, 6).map(sentence => quote(sentence));
  const endingHook = [...sentences].reverse().find(sentence => /(?:？|!|！|却|竟|突然|危机|秘密|声音|身影|下一刻|门外)/u.test(sentence)) || '';
  const foreshadowingChanges = explicitForeshadowing.length
    ? explicitForeshadowing
    : (endingHook ? [`待承接线索：${quote(endingHook)}`] : []);
  const explicitConflicts = sentences.filter(sentence => /(?:冲突|争执|嘲讽|威胁|攻击|反击|对峙|战斗|追杀|阻拦|拒绝|质问|逼迫|挑衅|敌人|杀意|不满|冷笑|喝道|争夺|谈判)/u.test(sentence)).slice(0, 6).map(sentence => quote(sentence));
  const conflicts = explicitConflicts;
  return {
    summary: buildLocalChapterSummary(chapter.content),
    keywords: extractLocalKeywords(chapter.content),
    characterStateChanges,
    knowledgeChanges,
    foreshadowingChanges,
    timelineEvents,
    canonFacts,
    conflicts,
    endingHook: quote(endingHook),
  };
};

/**
 * 目标章之前的最近几章记忆，按章序排好并带上章号
 * 故事账本靠它列出"已发生事件"；重写中间章时不能把后面章的记忆当前文
 * 带多少由运行时的上下文预算决定，这里只给一个足够长的候选串
 */
export const recentChapterMemories = (project: Project, beforeChapterNumber: number, limit = 24) => {
  const ordinal = (memory: ChapterMemory) => {
    const index = project.chapters.findIndex(chapter => chapter.id === memory.chapterId);
    return index >= 0 ? index + 1 : (memory.sourceChapterNumber ?? 0);
  };
  return project.memories
    .map(memory => ({ ...memory, chapterNumber: ordinal(memory) }))
    .filter(memory => memory.chapterNumber > 0 && memory.chapterNumber < beforeChapterNumber)
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
    .slice(-limit);
};
