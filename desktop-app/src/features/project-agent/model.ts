import type { ProjectAgentChange as ProjectAgentRawChange } from '@zhizhang/contracts';
import type { Project, OutlineKind, CardType, MemoryDocumentKind, KnowledgeGraphNode } from '../../domain/project';

export type ProjectAgentMode = 'discuss' | 'plan' | 'execute';
export type ProjectAgentChangeStatus = 'pending' | 'applied' | 'dismissed';
export type { ProjectAgentRawChange };
export type ProjectAgentChange = ProjectAgentRawChange & { id: string; status: ProjectAgentChangeStatus; baseUpdatedAt?: string; baseFields?: Record<string, unknown> };
export interface ProjectAgentToolEvent { tool: string; status: 'complete' | 'error'; message: string }
export interface ProjectAgentMessage { id: string; role: 'user' | 'assistant'; content: string; createdAt: string; toolEvents?: ProjectAgentToolEvent[]; changeIds?: string[]; error?: boolean }
export interface ProjectAgentSession {
  version: 1;
  projectId: number;
  sessionId: string;
  mode: ProjectAgentMode;
  messages: ProjectAgentMessage[];
  changes: ProjectAgentChange[];
  updatedAt: string;
}
export interface ProjectAgentResponse { message: string; changes?: unknown[]; toolEvents?: ProjectAgentToolEvent[] }

/** 第208章算单章；第206～215章这种区间不算 */
export const chapterOutlineNumber = (title: unknown, content?: unknown) => {
  const match = /第\s*(\d{1,4})\s*章(?!\s*[～~\-—–至到])/u.exec(`${String(title ?? '')}\n${String(content ?? '').slice(0, 400)}`);
  return match ? Number(match[1]) : undefined;
};

export const projectAgentSessionId = () => `project-agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const projectAgentRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const projectAgentString = (value: unknown, max: number) => typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : '';
const projectAgentNumber = (value: unknown) => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : undefined;

export const createProjectAgentSession = (projectId: number, sessionId = projectAgentSessionId()): ProjectAgentSession => ({
  version: 1,
  projectId,
  sessionId,
  mode: 'discuss',
  messages: [],
  changes: [],
  updatedAt: new Date().toISOString(),
});

export const normalizeProjectAgentChange = (value: unknown, project: Project, index = 0): ProjectAgentChange | null => {
  if (!projectAgentRecord(value)) return null;
  const type = projectAgentString(value.type, 80);
  const summary = projectAgentString(value.summary, 200);
  if (!summary) return null;
  const id = projectAgentString(value.id, 160) || `change-${Date.now().toString(36)}-${index}-${Math.random().toString(36).slice(2, 7)}`;
  const status: ProjectAgentChangeStatus = ['applied', 'dismissed'].includes(String(value.status)) ? value.status as ProjectAgentChangeStatus : 'pending';
  const storedBase = typeof value.baseUpdatedAt === 'string' ? value.baseUpdatedAt : undefined;
  if (type === 'project.update' && projectAgentRecord(value.patch)) {
    const patch: Record<string, unknown> = {};
    for (const key of ['title', 'synopsis', 'genre', 'subgenre', 'protagonist1', 'protagonist2'] as const) {
      if (typeof value.patch[key] === 'string') patch[key] = value.patch[key];
    }
    if (value.patch.status === 'writing' || value.patch.status === 'completed') patch.status = value.patch.status;
    if (Array.isArray(value.patch.authorPreferences)) patch.authorPreferences = value.patch.authorPreferences.filter(item => typeof item === 'string' && Boolean(item.trim())).slice(0, 20);
    if (!Object.keys(patch).length) return null;
    // 只快照本次要改的字段：project.updatedAt 会被任意一次章节保存刷新，不能当作冲突依据
    const source = project as unknown as Record<string, unknown>;
    const baseFields = projectAgentRecord(value.baseFields) ? value.baseFields : Object.fromEntries(Object.keys(patch).map(key => [key, source[key]]));
    return { type, id, status, summary, patch, baseFields } as ProjectAgentChange;
  }
  if (type === 'outline.upsert') {
    const targetId = projectAgentNumber(value.targetId);
    const target = targetId ? project.outlines.find(item => item.id === targetId) : undefined;
    const kind = ['总纲', '章纲', '世界观与作品设定'].includes(String(value.kind)) ? value.kind as OutlineKind : null;
    const title = projectAgentString(value.title, 160);
    const content = projectAgentString(value.content, 60_000);
    if (!kind || !title || !content || (targetId && !target)) return null;
    return { type, id, status, summary, targetId, kind, title, content, chapterId: projectAgentNumber(value.chapterId), baseUpdatedAt: storedBase || target?.updatedAt };
  }
  if (type === 'card.upsert') {
    const targetId = projectAgentNumber(value.targetId);
    const target = targetId ? project.cards.find(item => item.id === targetId) : undefined;
    const cardType = ['角色卡', '物品卡', '地点卡', '势力卡', '金手指卡'].includes(String(value.cardType)) ? value.cardType as CardType : null;
    const title = projectAgentString(value.title, 120);
    const content = projectAgentString(value.content, 40_000);
    if (!cardType || !title || !content || (targetId && !target)) return null;
    return { type, id, status, summary, targetId, cardType, title, content, currentState: typeof value.currentState === 'string' ? value.currentState.slice(0, 6000) : undefined, baseUpdatedAt: storedBase || target?.updatedAt };
  }
  if (type === 'memory.document.upsert') {
    const kind = ['章节快照', '人物状态', '角色认知', '伏笔追踪', '时间线', '设定事实', '冲突'].includes(String(value.kind)) ? value.kind as MemoryDocumentKind : null;
    const title = projectAgentString(value.title, 120);
    const content = projectAgentString(value.content, 60_000);
    const target = kind ? project.memoryDocuments.find(item => item.kind === kind) : undefined;
    if (!kind || !title || !content) return null;
    return { type, id, status, summary, kind, title, content, baseUpdatedAt: storedBase || target?.updatedAt };
  }
  if (type === 'graph.node.upsert') {
    const targetId = projectAgentString(value.targetId, 160);
    const label = projectAgentString(value.label, 120);
    const nodeType = ['chapter', 'card', 'outline', 'entity'].includes(String(value.nodeType)) ? value.nodeType as KnowledgeGraphNode['type'] : null;
    const target = project.graphNodes.find(item => item.id === targetId);
    if (!targetId || !label || !nodeType) return null;
    return { type, id, status, summary, targetId, label, nodeType, category: projectAgentString(value.category, 80) || undefined, content: typeof value.content === 'string' ? value.content.slice(0, 30_000) : undefined, nodeStatus: projectAgentString(value.nodeStatus, 1000) || undefined, baseUpdatedAt: storedBase || target?.updatedAt };
  }
  if (type === 'graph.edge.upsert') {
    const targetId = projectAgentString(value.targetId, 240);
    const source = projectAgentString(value.source, 160);
    const target = projectAgentString(value.target, 160);
    const label = projectAgentString(value.label, 80);
    const existing = project.graphEdges.find(item => item.id === targetId);
    const weight = typeof value.weight === 'number' && value.weight >= 0.1 && value.weight <= 1 ? value.weight : undefined;
    if (!targetId || !source || !target || source === target || !label) return null;
    return { type, id, status, summary, targetId, source, target, label, weight, baseUpdatedAt: storedBase || existing?.updatedAt };
  }
  if (type === 'chapter.create') {
    const title = projectAgentString(value.title, 160);
    const content = projectAgentString(value.content, 120_000);
    if (!title || !content) return null;
    return { type, id, status, summary, title, content, chapterPlan: typeof value.chapterPlan === 'string' ? value.chapterPlan.slice(0, 30_000) : undefined, chapterSummary: typeof value.chapterSummary === 'string' ? value.chapterSummary.slice(0, 3000) : undefined };
  }
  if (type === 'chapter.update') {
    const targetId = projectAgentNumber(value.targetId);
    const target = targetId ? project.chapters.find(item => item.id === targetId) : undefined;
    const content = projectAgentString(value.content, 120_000);
    // 修订必须命中一个真存在的章节，否则丢弃，不能退化成新建
    if (!targetId || !target || !content) return null;
    return { type, id, status, summary, targetId, title: projectAgentString(value.title, 160) || undefined, content, baseUpdatedAt: storedBase || target.updatedAt };
  }
  if (type === 'chapter.titles') {
    // 批量标题只保留真存在的章节；一次几百章，逐条做冲突快照没有意义，
    // 应用时按章重新取当前标题和正文，落地阶段自然拿到最新状态
    const titles = Array.isArray(value.titles) ? value.titles.filter(projectAgentRecord).flatMap(item => {
      const targetId = projectAgentNumber(item.targetId);
      const title = projectAgentString(item.title, 160);
      if (!targetId || !title || !project.chapters.some(chapter => chapter.id === targetId)) return [];
      return [{ targetId, title, stripHeading: item.stripHeading === true }];
    }).slice(0, 400) : [];
    if (!titles.length) return null;
    return { type, id, status, summary, titles } as ProjectAgentChange;
  }
  if (type === 'chapter.parts') {
    // 拆章只带切点，不带正文：落地时按段落序号就地切开。规划时的段落数记在这里，
    // 落地前对不上就说明这章的正文已经被改过，那一章跳过，其余照常
    const splits = Array.isArray(value.splits) ? value.splits.filter(projectAgentRecord).flatMap(item => {
      const targetId = projectAgentNumber(item.targetId);
      const paragraphCount = projectAgentNumber(item.paragraphCount);
      const breakAfter = Array.isArray(item.breakAfter)
        ? [...new Set(item.breakAfter.map(projectAgentNumber).filter((entry): entry is number => Boolean(entry)))].sort((a, b) => a - b)
        : [];
      const titles = Array.isArray(item.titles) ? item.titles.map(entry => projectAgentString(entry, 160)) : [];
      if (!targetId || !paragraphCount || !breakAfter.length || !project.chapters.some(chapter => chapter.id === targetId)) return [];
      // 标题数必须正好覆盖切出来的每一段，缺一个就没法给新章命名
      if (titles.length !== breakAfter.length + 1 || titles.some(entry => !entry)) return [];
      if (breakAfter.some(entry => entry >= paragraphCount)) return [];
      return [{ targetId, paragraphCount, breakAfter, titles }];
    }).slice(0, 40) : [];
    if (!splits.length) return null;
    return { type, id, status, summary, splits } as ProjectAgentChange;
  }
  if (type === 'chapter.delete') {
    const targetId = projectAgentNumber(value.targetId);
    const target = targetId ? project.chapters.find(item => item.id === targetId) : undefined;
    if (!targetId || !target) return null;
    return { type, id, status, summary, targetId, title: target.title };
  }
  if (type === 'outline.delete') {
    const targetId = projectAgentNumber(value.targetId);
    const target = targetId ? project.outlines.find(item => item.id === targetId && item.kind === '章纲') : undefined;
    if (!targetId || !target) return null;
    return { type, id, status, summary, targetId, title: target.title };
  }
  if (type === 'text.replace') {
    const targetId = projectAgentNumber(value.targetId);
    const targetKind = value.target === 'chapter' || value.target === 'outline' ? value.target : undefined;
    const exists = targetKind === 'chapter'
      ? project.chapters.some(item => item.id === targetId)
      : targetKind === 'outline' ? project.outlines.some(item => item.id === targetId) : false;
    const replacements = Array.isArray(value.replacements) ? value.replacements.flatMap(item => {
      if (!projectAgentRecord(item)) return [];
      const find = projectAgentString(item.find, 2000);
      const replace = projectAgentString(item.replace, 8000);
      return find ? [{ find, replace }] : [];
    }).slice(0, 12) : [];
    if (!targetId || !targetKind || !exists || !replacements.length) return null;
    return { type, id, status, summary, target: targetKind, targetId, replacements };
  }
  return null;
};

export const normalizeProjectAgentSession = (value: unknown, project: Project, sessionId: string): ProjectAgentSession => {
  if (!projectAgentRecord(value)) return createProjectAgentSession(project.id, sessionId);
  const messages = Array.isArray(value.messages) ? value.messages.slice(-200).flatMap((item, index): ProjectAgentMessage[] => {
    if (!projectAgentRecord(item) || (item.role !== 'user' && item.role !== 'assistant') || typeof item.content !== 'string') return [];
    return [{
      id: projectAgentString(item.id, 160) || `message-${index}`,
      role: item.role,
      content: item.content.slice(0, 30_000),
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
      toolEvents: Array.isArray(item.toolEvents) ? item.toolEvents.filter(projectAgentRecord).flatMap((event): ProjectAgentToolEvent[] => {
        const tool = projectAgentString(event.tool, 120); const message = projectAgentString(event.message, 1000);
        const status = event.status;
        return tool && message && (status === 'complete' || status === 'error') ? [{ tool, message, status }] : [];
      }).slice(0, 30) : undefined,
      changeIds: Array.isArray(item.changeIds) ? item.changeIds.filter(id => typeof id === 'string').slice(0, 20) : undefined,
      error: item.error === true,
    }];
  }) : [];
  const changes = Array.isArray(value.changes) ? value.changes.filter((item, index, items) => (projectAgentRecord(item) && item.status === 'pending') || index >= items.length - 80).map((item, index) => normalizeProjectAgentChange(item, project, index)).filter((item): item is ProjectAgentChange => Boolean(item)) : [];
  return {
    version: 1,
    projectId: project.id,
    sessionId,
    mode: value.mode === 'execute' || value.mode === 'plan' ? value.mode : 'discuss',
    messages,
    changes,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
  };
};

