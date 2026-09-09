import { useState, useEffect, useLayoutEffect, useRef, type ChangeEvent } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke, isDirectBaiduRuntime, isMobileRuntime } from './platform';
import { agentRpc } from './services/agent-client';
import { partsFromBreaks, splitParagraphs, type AgentProgressEvent, type RuntimeUsageSummary } from '@zhizhang/contracts';
import { nativeClient } from './services/native-client';
import type { Skill } from './domain/skill';
import type { Chapter, OutlineKind, OutlineDocument, CardType, KnowledgeCard, ChapterMemory, AIDetectionChapter, AIDetectionLabel, AIDetectionSegment, AIDetectionReport, MemoryDocumentKind, MemoryDocument, KnowledgeGraphNode, KnowledgeGraphEdge, Project, TagTab, Channel } from './domain/project';
import { defaultKnowledgeGraphWeight, normalizeKnowledgeGraphWeight, normalizeKnowledgeGraphEdges, upsertKnowledgeGraphEdge, graphNodeTypeLabel, graphNodeGroup, graphNodeRelativePath, graphNodeProfile, createGraphNodeProfile } from './domain/knowledge-graph';
import { removeChapterFromProject, restoreDeletedChapter, pushChapterSnapshot, restoreChapterSnapshot, replaceChapterInProject, moveChapterInProject, reorderChapterInProject, insertChapterAfter, chapterSnapshotLimit, aiDetectionSource, aiDetectionSegmentsMatch } from './domain/chapter';
import { buildProjectExport, buildChapterExport, exportFileName, defaultExportOptions, type ExportOptions } from './domain/export';
import { mergeGithubProject, githubMergeChanged, type GithubMergeResult } from './domain/github-merge';
import type { DismantleChapter, DismantleBook, LibraryBookChapter, LibraryBook, RankingPlatform, RankingType, FanqieSection, RankingCategoryOption, RankingBook, WritingStyle } from './domain/library';
import { localResourceId, splitTxtIntoDismantleChapters, readLocalTxtFile, normalizeDismantleChapter, normalizeDismantleBook, normalizeLibraryBookChapter, normalizeLibraryBook, normalizeRankingBook, trustedRankingCache, normalizeWritingStyle } from './features/library/model';
import { projectAgentSessionId, createProjectAgentSession, normalizeProjectAgentChange, normalizeProjectAgentSession, type ProjectAgentRawChange, type ProjectAgentChange, type ProjectAgentMessage, type ProjectAgentSession, type ProjectAgentResponse } from './features/project-agent/model';
import { defaultBaseURLFor, apiModes, apiModeLabel, normalizeBaseURL, resolvedEndpoint, supportsGatewayUsage, contextWindowPresets, maxContextWindowKTokens, formatContextWindow, clampContextWindow, reasoningModes, fallbackModels, normalizeAgentConfig, profilesStorageKey, activeProfileStorageKey, newProfileId, normalizeAgentProfile, loadAgentProfiles, profilePresets, diagnosticStatusIcon, agentNetworkParams, type AgentConfig, type AgentProfile, type DiagnosticReport } from './features/settings/model-config';
import { readerFonts, themes, appearanceStorageKey, loadAppearance, applyAppearance, type Appearance } from './features/settings/appearance';
import { usePaneSizes } from './features/editor/use-pane-sizes';
import { PaneResizer } from './features/editor/pane-resizer';
import { PlumBranch } from './features/editor/plum-branch';
import { Icon } from './components/icon';
import './App.css';
import { builtinSkills } from './data/builtin-skills';
import {
  countNovelCharacters,
  splitChapterTitleHeading,
  applyDraftChapterTitle,
  formatNovelForPlatform,
  combineContentAndAuthorNote,
  platformFormatPresetLabels,
  type PlatformFormatPreset,
} from './utils/text';





interface CloudBackupFile {
  name: string;
  path: string;
  fsId?: string;
  size: number;
  modifiedAt: string;
  isBundle: boolean;
  source: 'bundle';
}

interface GitHubProjectResult {
  repositoryUrl: string;
  branch: string;
  commit: string;
  project: unknown;
}

interface GitHubRestoreConflict {
  project: Project;
  localProject: Project;
  repositoryUrl: string;
  commit: string;
}

const fanqieSectionOptions: Array<{ value: FanqieSection; label: string; gender: 'male' | 'female'; list: 'read' | 'new' }> = [
  { value: 'male-read', label: '男频阅读', gender: 'male', list: 'read' },
  { value: 'male-new', label: '男频新书', gender: 'male', list: 'new' },
  { value: 'female-read', label: '女频阅读', gender: 'female', list: 'read' },
  { value: 'female-new', label: '女频新书', gender: 'female', list: 'new' },
];

const rankingTypeOptions = (platform: RankingPlatform): Array<{ value: RankingType; label: string }> => {
  if (platform === 'fanqie') return [{ value: 'read', label: '阅读榜' }, { value: 'new', label: '新书榜' }];
  if (platform === 'qidian') return [{ value: 'hot', label: '月票榜' }, { value: 'new', label: '签约作者新书榜' }, { value: 'read', label: '阅读指数榜' }];
  if (platform === 'faloo') return [{ value: 'read', label: '24小时畅销榜' }];
  return [{ value: 'read', label: '阅读榜' }];
};

const rankingTypeLabel = (platform: RankingPlatform, type: RankingType) => rankingTypeOptions(platform).find(item => item.value === type)?.label || '榜单';

interface AIToolResult {
  mode: 'polish' | 'de-ai' | 'continue';
  content: string;
  projectId: number;
  chapterId: number;
  scope: 'chapter' | 'selection';
  source?: string;
  start?: number;
  end?: number;
  maxWords?: number;
}

interface AgentReviewResult {
  consistent: boolean;
  issues: string[];
  suggestions: string[];
}

interface AgentDraftResult {
  draftContent?: string;
  /** 运行时从正文开头剥下来的章节标题，用于补全标题栏里的占位章号 */
  chapterTitle?: string;
  summary?: string;
  chapterPlan?: string;
  prewriteCheck?: { blockers: string[]; warnings: string[]; summary: string };
  reviewResult?: AgentReviewResult;
  retrievedContext?: string[];
  recognizedIntent?: string;
  selectedSkills?: string[];
  contextReport?: {
    cache?: 'hit' | 'miss';
    sourceBytes?: number;
    packedBytes?: number;
    prunedBytes?: number;
    budgetBytes?: number;
    retrievedBytes?: number;
    draftInputBytes?: number;
    reviewInputBytes?: number;
    contextProfile?: '剧情' | '战斗' | '情感' | '转场';
    sections?: Record<string, number>;
    upstreamUsage?: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      cachedInputTokens: number;
      cacheWriteTokens: number;
      reasoningTokens: number;
      requests: number;
    };
  };
}

/**
 * Chapter writing uses a JSON envelope so the runtime can retain a compact
 * chapter summary. During SSE that envelope arrives a few characters at a
 * time. Keep the JSON transport out of the writer-facing preview while still
 * allowing ordinary (non-JSON) provider fallbacks to render immediately.
 */
const chapterDraftFromStream = (raw: string, depth = 0): string => {
  if (depth > 4) return raw.trim();
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('```')) return raw;
  const withoutFence = trimmed.replace(/^```(?:json|markdown|text)?\s*/iu, '').replace(/\s*```$/u, '').trim();
  try {
    const parsed = JSON.parse(withoutFence) as Record<string, unknown>;
    const nested = typeof parsed.draftContent === 'string' ? parsed.draftContent : typeof parsed.content === 'string' ? parsed.content : '';
    if (nested) return chapterDraftFromStream(nested, depth + 1);
  } catch {
    // SSE commonly arrives mid-JSON; decode the visible content field below.
  }
  const field = /"(?:draftContent|content)"\s*:\s*"/u.exec(raw);
  if (!field) return '';

  let value = '';
  for (let index = (field.index || 0) + field[0].length; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === '"') break;
    if (character !== '\\') {
      value += character;
      continue;
    }
    const escape = raw[index + 1];
    if (!escape) break;
    if (escape === 'u') {
      const hex = raw.slice(index + 2, index + 6);
      if (!/^[0-9a-f]{4}$/iu.test(hex)) break;
      value += String.fromCharCode(Number.parseInt(hex, 16));
      index += 5;
      continue;
    }
    const escaped: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
    value += escaped[escape] ?? escape;
    index += 1;
  }
  return value.trimStart().startsWith('{') || value.trimStart().startsWith('```')
    ? chapterDraftFromStream(value, depth + 1)
    : value;
};

interface UsageDay extends RuntimeUsageSummary { date: string }
interface GatewayUsageAccount {
  keyIndex: number;
  keyHint: string;
  usage?: Record<string, unknown>;
  logs: Array<Record<string, unknown>>;
  pricing?: Array<Record<string, unknown>>;
  group?: string;
  groupRatios?: Record<string, number>;
  usableGroups?: Record<string, unknown>;
  error?: string;
}
interface GatewayUsageSnapshot {
  fetchedAt: string;
  status?: Record<string, unknown>;
  pricing?: Array<Record<string, unknown>>;
  accounts: GatewayUsageAccount[];
  errors: string[];
}
interface GatewayPricingEntry extends Record<string, unknown> {
  __account: GatewayUsageAccount;
  __group?: string;
  __groupRatio?: number;
  __groupKnown: boolean;
}
interface AgentChatMessage { role: 'user' | 'assistant'; content: string; createdAt: string }

interface AgentMemoryResult {
  summary?: string;
  keywords?: string[];
  characterStateChanges?: string[];
  knowledgeChanges?: string[];
  foreshadowingChanges?: string[];
  foreshadowingItems?: ChapterMemory['foreshadowingItems'];
  timelineEvents?: string[];
  canonFacts?: string[];
  conflicts?: string[];
  endingHook?: string;
  entities?: Array<{ name?: string; type?: string }>;
  relations?: Array<{ source?: string; target?: string; label?: string; weight?: number }>;
  cardUpdates?: Array<{ cardId?: number | string; cardTitle?: string; status?: string; changes?: string }>;
  authorPreferences?: string[];
  contextReport?: AgentDraftResult['contextReport'];
}

type AgentStage = 'idle' | 'starting' | 'intent' | 'retrieve' | 'plan' | 'draft' | 'review' | 'done' | 'error';
type AgentProgressStatus = 'pending' | 'active' | 'complete' | 'error';

const skillCategoryLabels: Record<string, string> = {
  setup: '项目设置', write: '写作', review: '审查', polish: '润色',
  import: '导入', analyze: '分析', tool: '工具', creator: '创建器',
};

const agentStageLabel: Record<AgentStage, string> = {
  idle: '待命',
  starting: '启动智能体',
  intent: '识别创作意图',
  retrieve: '检索上下文',
  plan: '制定下一章计划',
  draft: '生成正文',
  review: '审查一致性',
  done: '草稿完成',
  error: '运行失败',
};

const agentWorkflowSteps = [
  { id: 'starting', label: '准备运行环境', description: '整理章节、卡片和已选记忆' },
  { id: 'intent', label: '识别创作意图', description: '选择适用的写作技能' },
  { id: 'retrieve', label: '检索故事记忆', description: '读取相关人物、设定和时间线' },
  { id: 'plan', label: '制定下一章计划', description: '梳理承接、事件链、节奏、伏笔和章末钩子' },
  { id: 'draft', label: '生成章节草稿', description: '组织上下文并调用模型写作' },
  { id: 'review', label: '审查一致性', description: '检查人物、逻辑与时间线' },
] as const;

type AgentWorkflowStepId = typeof agentWorkflowSteps[number]['id'];

interface AgentProgressItem {
  id: AgentWorkflowStepId;
  label: string;
  description: string;
  status: AgentProgressStatus;
  message: string;
  progress: number;
}

interface ContextTraceEvent {
  id: string;
  step: string;
  action: string;
  source?: string;
  status?: 'searching' | 'selected' | 'pruned' | 'loaded' | 'cached';
  bytes?: number;
  items?: number;
  timestamp: number;
}

const createAgentProgressItems = (): AgentProgressItem[] => agentWorkflowSteps.map(step => ({
  ...step,
  status: 'pending',
  message: '',
  progress: 0,
}));

const isAgentWorkflowStep = (value: string | undefined): value is AgentWorkflowStepId => Boolean(value && agentWorkflowSteps.some(step => step.id === value));
const agentRunning = (stage: AgentStage) => !['idle', 'done', 'error'].includes(stage);

const memoryQuotaCooldownMs = 5 * 60 * 1000;
let memoryQuotaRetryAt = 0;
const isQuotaExceededError = (value: unknown) => /quota\s+(?:has\s+been\s+)?exceeded|insufficient[\s_-]*quota|billing[\s_-]*(?:limit|quota)|额度(?:已)?用尽|余额不足/iu.test(String(value));
// These records can contain complete novels and downloaded books. Tauri writes
// them to the iOS app-data directory; keeping a second WebView copy exhausts
// the WKWebView quota and is only needed by the plain-browser development mode.
const deviceBackedStateKeys = new Set([
  'projects',
  'writer-library-books',
  'writer-ranking-books',
  'writer-dismantle-books',
  'writer-writing-styles',
]);
const outlineKinds: OutlineKind[] = ['总纲', '章纲', '世界观与作品设定'];
const memoryDocumentKinds: MemoryDocumentKind[] = ['章节快照', '人物状态', '角色认知', '伏笔追踪', '时间线', '设定事实', '冲突'];

const memoryDocumentId = (kind: MemoryDocumentKind) => `memory-document:${kind}`;
const asTextList = (value: unknown, limit = 20) => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean).slice(0, limit)
  : [];
const memoryTextList = (value: string) => value.split(/\r?\n|、/).map(item => item.trim()).filter(Boolean).slice(0, 30);

const chapterOrder = (memory: ChapterMemory) => memory.sourceChapterNumber ?? memory.chapterId;
const memoryListMarkdown = (items: string[]) => items.length ? items.map(item => `- ${item}`).join('\n') : '- 暂无';

const readableChapterPlan = (value?: string): string => {
  const text = String(value || '').trim().replace(/^```(?:json|markdown|text)?\s*/iu, '').replace(/\s*```$/u, '').trim();
  if (!text) return '';
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const plan = parsed.plan ?? parsed.content ?? parsed;
    if (typeof plan === 'string') return readableChapterPlan(plan);
    if (plan && typeof plan === 'object' && !Array.isArray(plan)) {
      const labels: Record<string, string> = { opening: '开篇承接', openingAnchor: '开篇承接', handoff: '下一章交接', continuity: '承接锚点', story: '这章的故事', plot: '核心事件链', events: '核心事件链', characters: '这章的人物', characterGoals: '人物目标与动机', conflict: '冲突升级', pacing: '节奏安排', rhythm: '节奏安排', newInformation: '本章新增信息', foreshadowing: '伏笔推进', ending: '章末钩子', hook: '章末钩子', style: '写法与禁区' };
      return Object.entries(plan as Record<string, unknown>).map(([key, entry]) => {
        const label = labels[key] || key;
        const detail = Array.isArray(entry) ? entry.map(item => `- ${String(item)}`).join('\n') : typeof entry === 'object' && entry ? Object.entries(entry as Record<string, unknown>).map(([subKey, subValue]) => `- ${subKey}：${String(subValue)}`).join('\n') : String(entry ?? '');
        return detail ? `## ${label}\n${detail}` : '';
      }).filter(Boolean).join('\n\n');
    }
  } catch { /* Plain Markdown plans are already suitable for display. */ }
  return text;
};

const buildMemoryDocuments = (memories: ChapterMemory[], existingDocuments: MemoryDocument[] = [], force = false): MemoryDocument[] => {
  const ordered = [...memories].sort((left, right) => chapterOrder(left) - chapterOrder(right));
  const sections = (title: string, entries: Array<{ memory: ChapterMemory; items: string[] }>) => `# ${title}\n\n${entries.length
    ? entries.map(({ memory, items }) => `## ${memory.chapterTitle}\n${memoryListMarkdown(items)}`).join('\n\n')
    : '暂无已保存章节记忆。'}\n`;
  const documentContent: Record<MemoryDocumentKind, string> = {
    '章节快照': `# 章节快照\n\n${ordered.length ? ordered.map(memory => `## ${memory.chapterTitle}\n${memory.summary || '暂无摘要'}\n\n关键词：${memory.keywords.join('、') || '暂无'}\n\n人物状态：${memory.characterStateChanges.join('；') || '暂无'}\n认知变化：${memory.knowledgeChanges.join('；') || '暂无'}\n伏笔：${memory.foreshadowingChanges.join('；') || '暂无'}\n时间线：${memory.timelineEvents.join('；') || '暂无'}\n设定事实：${memory.canonFacts.join('；') || '暂无'}\n冲突：${memory.conflicts.join('；') || '暂无'}\n章末钩子：${memory.endingHook || '暂无'}`).join('\n\n---\n\n') : '暂无已保存章节记忆。'}\n`,
    '人物状态': sections('人物状态', ordered.map(memory => ({ memory, items: memory.characterStateChanges }))),
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

const hydrateMemoryDocuments = (documents: unknown, memories: ChapterMemory[]): MemoryDocument[] => {
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

const normalizeChapterMemory = (memory: Partial<ChapterMemory>, fallbackChapter?: Chapter): ChapterMemory => {
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
    endingHook: typeof memory.endingHook === 'string' ? memory.endingHook : '',
    sourceChapterNumber: typeof memory.sourceChapterNumber === 'number' ? memory.sourceChapterNumber : undefined,
    createdAt: typeof memory.createdAt === 'string' ? memory.createdAt : now,
    updatedAt: typeof memory.updatedAt === 'string' ? memory.updatedAt : (typeof memory.createdAt === 'string' ? memory.createdAt : now),
  };
};

const buildLocalChapterSummary = (content: string) => {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 220) return normalized;
  const sentences = normalized.match(/[^。！？.!?]+[。！？.!?]?/g) ?? [];
  const summary = sentences.slice(0, 3).join('').trim();
  return summary.length > 220 ? `${summary.slice(0, 220)}...` : summary;
};

const extractLocalKeywords = (content: string) => {
  const ignored = new Set(['这一章', '故事', '小说', '主角', '他们', '自己', '已经', '没有', '一个', '什么']);
  const matches = content.match(/[\u4e00-\u9fff]{2,6}/g) ?? [];
  return Array.from(new Set(matches.filter(word => !ignored.has(word)))).slice(0, 8);
};

const chapterSentences = (content: string) => content
  .replace(/\s+/gu, ' ')
  .split(/(?<=[。！？!?])/u)
  .map(sentence => sentence.trim())
  .filter(sentence => sentence.length >= 8);

// This is intentionally conservative: it gives a saved chapter a useful local
// memory immediately, while the model can later refine it. It also prevents an
// iOS network/SSE failure from replacing all structured fields with empty lists.
const buildLocalStructuredMemory = (chapter: Chapter, project: Project) => {
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

const aiDetectionLabel = (confidence: number): AIDetectionLabel => {
  if (confidence >= 0.99) return 'AI 特征';
  if (confidence >= 0.5) return '疑似 AI';
  return '人工';
};

const splitAIDetectionSegments = (text: string, chapterScore: number): AIDetectionSegment[] => {
  // Keep paragraph separators in the segment so stored offsets remain aligned
  // with the editor content when the result is rendered as an overlay.
  const parts = text.match(/[\s\S]*?(?:\n{2,}|$)/gu) ?? [text];
  let order = 0;
  return parts.filter(part => part.length > 0).map(part => {
    const sentences = part.split(/[。！？!?\n]/u).map(item => item.trim()).filter(Boolean);
    const lengths = sentences.map(item => item.length);
    const average = lengths.length ? lengths.reduce((sum, length) => sum + length, 0) / lengths.length : 0;
    const variance = lengths.length ? lengths.reduce((sum, length) => sum + (length - average) ** 2, 0) / lengths.length : 0;
    const uniformity = lengths.length ? Math.max(0, 100 - Math.sqrt(variance) * 2) : 50;
    const logicCount = ['但是', '不过', '然而', '因此', '所以', '首先', '其次', '最后', '总之'].reduce((sum, word) => sum + part.split(word).length - 1, 0);
    const colloquialCount = ['咋', '啥', '呗', '嘛', '呢', '啊', '呀', '咯', '喽', '琢磨', '寻思'].reduce((sum, word) => sum + part.split(word).length - 1, 0);
    const templateCount = ['首先', '其次', '最后', '总之', '综上所述', '值得注意的是', '需要注意的是', '通过这种方式'].reduce((sum, word) => sum + part.split(word).length - 1, 0);
    const normalizedLength = Math.max(1, part.replace(/\s+/gu, '').length);
    const localSignal = 0.08 + uniformity / 100 * 0.2 + Math.min(1, logicCount / Math.max(1, sentences.length)) * 0.18 + (1 - Math.min(1, colloquialCount / Math.max(1, sentences.length))) * 0.14 + chapterScore * 0.16;
    const stronglyTemplated = sentences.length >= 4 && uniformity >= 88 && (templateCount >= 3 || logicCount >= 5);
    const confidence = stronglyTemplated ? 0.99 : Math.max(0, Math.min(0.98, Number((localSignal + (normalizedLength < 30 ? 0.03 : 0)).toFixed(3))));
    return { order: ++order, text: part, confidence, label: aiDetectionLabel(confidence) };
  });
};

const analyzeAIChapter = (chapter: Chapter): AIDetectionChapter => {
  const text = aiDetectionSource(chapter.content);
  const sentences = text.split(/[。！？\n]/u).map(item => item.trim()).filter(Boolean);
  const lengths = sentences.map(item => item.length);
  const average = lengths.length ? lengths.reduce((sum, length) => sum + length, 0) / lengths.length : 0;
  const variance = lengths.length ? lengths.reduce((sum, length) => sum + (length - average) ** 2, 0) / lengths.length : 0;
  const sentenceUniformity = lengths.length ? Math.max(0, 100 - Math.sqrt(variance) * 2) : 50;
  const logicWords = ['但是', '不过', '然而', '因此', '所以', '首先', '其次', '最后', '总之', '综上所述'];
  const colloquialWords = ['咋', '啥', '呗', '嘛', '呢', '啊', '呀', '咯', '喽', '琢磨', '寻思', '要得'];
  const psychologicalPatterns = ['心里一', '心里头', '心里有', '心里明白', '心里盘算'];
  const perHundred = (count: number) => text.length ? count / (text.length / 100) : 0;
  const logicFrequency = perHundred(logicWords.reduce((sum, word) => sum + text.split(word).length - 1, 0));
  const colloquialFrequency = perHundred(colloquialWords.reduce((sum, word) => sum + text.split(word).length - 1, 0));
  const psychologicalFrequency = perHundred(psychologicalPatterns.reduce((sum, word) => sum + text.split(word).length - 1, 0));
  const paragraphs = text.split(/\n\n/u).map(item => item.trim()).filter(Boolean);
  const paragraphLengths = paragraphs.map(item => item.length);
  const paragraphAverage = paragraphLengths.length ? paragraphLengths.reduce((sum, length) => sum + length, 0) / paragraphLengths.length : 0;
  const paragraphVariance = paragraphLengths.length ? paragraphLengths.reduce((sum, length) => sum + (length - paragraphAverage) ** 2, 0) / paragraphLengths.length : 0;
  const paragraphUniformity = paragraphs.length > 1 ? Math.max(0, 100 - Math.sqrt(paragraphVariance)) : 50;
  const logicScore = Math.min(1, logicFrequency * 10 / 100);
  const colloquialScore = Math.min(1, colloquialFrequency * 20 / 100);
  const aiRate = Math.min(100, Math.max(0, sentenceUniformity / 100 * 25 + logicScore * 25 + (1 - colloquialScore) * 25 + Math.min(1, psychologicalFrequency * 5) * 15 + paragraphUniformity / 100 * 10));
  const segments = splitAIDetectionSegments(chapter.content, aiRate / 100);
  return {
    chapterId: chapter.id,
    chapterTitle: chapter.title,
    wordCount: countNovelCharacters(chapter.content),
    sentenceUniformity: Number(sentenceUniformity.toFixed(1)),
    logicFrequency: Number(logicFrequency.toFixed(2)),
    colloquialFrequency: Number(colloquialFrequency.toFixed(2)),
    psychologicalFrequency: Number(psychologicalFrequency.toFixed(2)),
    paragraphUniformity: Number(paragraphUniformity.toFixed(1)),
    aiRate: Number(aiRate.toFixed(1)),
    humanRate: Number((100 - aiRate).toFixed(1)),
    segments,
    label: aiDetectionLabel(aiRate / 100),
  };
};

const buildAIDetectionReport = (project: Project, scope: 'chapter' | 'book', chapter?: Chapter): AIDetectionReport => {
  const chapters = (scope === 'chapter' && chapter ? [chapter] : project.chapters).filter(item => item.content.trim()).map(analyzeAIChapter);
  const averageAIRate = chapters.length ? chapters.reduce((sum, item) => sum + item.aiRate, 0) / chapters.length : 0;
  const level = averageAIRate < 30 ? '极低' : averageAIRate < 45 ? '低' : averageAIRate < 60 ? '中等' : '高';
  const suggestion = averageAIRate < 30 ? '文本具有较强的人类写作特征。' : averageAIRate < 45 ? '文本具有人类写作特征，可保持具体动作和口语表达。' : averageAIRate < 60 ? '文本存在混合特征，建议增加句式变化和个性化细节。' : '文本具有较多模板化特征，建议使用去 AI 味技能复写后再检测。';
  return { updatedAt: new Date().toISOString(), scope, chapters, averageAIRate: Number(averageAIRate.toFixed(1)), level, suggestion, provider: '本地启发式' };
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const countOccurrences = (content: string, query: string) => {
  if (!query) return 0;
  let count = 0;
  let cursor = 0;
  while (cursor < content.length) {
    const index = content.indexOf(query, cursor);
    if (index < 0) break;
    count += 1;
    cursor = index + Math.max(1, query.length);
  }
  return count;
};

const findTextMatches = (content: string, query: string): number[] => {
  if (!query) return [];
  const matches: number[] = [];
  let cursor = 0;
  while (cursor < content.length) {
    const index = content.indexOf(query, cursor);
    if (index < 0) break;
    matches.push(index);
    cursor = index + Math.max(1, query.length);
  }
  return matches;
};

const searchSnippet = (content: string, position: number, query: string): string => {
  const start = Math.max(0, position - 54);
  const end = Math.min(content.length, position + query.length + 110);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < content.length ? '…' : '';
  return `${prefix}${content.slice(start, end).replace(/\s+/gu, ' ').trim()}${suffix}`;
};

const formatNovelChapterContent = (content: string) => content
  .replace(/^\uFEFF/u, '')
  .replace(/\r\n?/gu, '\n')
  .replace(/[\u00A0\u2007\u202F]/gu, ' ')
  .split('\n')
  .map(line => line.trim())
  .join('\n')
  .replace(/\n{3,}/gu, '\n\n')
  .trim();

/** 本地日期键，日更统计用 */
const todayKey = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

const dayKeyOffset = (days: number) => {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

/** 连续更新天数：从今天（或昨天）往前数，遇到空白天停下 */
const writingStreak = (dailyWords: Record<string, number> = {}): number => {
  if (!(dailyWords[todayKey()] || dailyWords[dayKeyOffset(1)])) return 0;
  let streak = 0;
  for (let offset = dailyWords[todayKey()] ? 0 : 1; offset < 3650; offset += 1) {
    if (!dailyWords[dayKeyOffset(offset)]) break;
    streak += 1;
  }
  return streak;
};

/** 网页调试环境的导出回退，Tauri 下走原生命令 */
const downloadInBrowser = (fileName: string, content: string) => {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
};

type TabType = 'projects' | 'books' | 'dismantles' | 'rankings' | 'skills' | 'styles';

interface GenreTag {
  name: string;
  description?: string;
  icon: string;
  tone: string;
}

const compactTags = (items: Array<[string, string, string]>): GenreTag[] =>
  items.map(([name, icon, tone]) => ({ name, icon, tone }));

const simpleTags = (names: string[], icon = '✦', tone = 'gold'): GenreTag[] =>
  names.map(name => ({ name, icon, tone }));

const defaultProjectTags = (channel: Channel = '男频'): Record<TagTab, string[]> => ({
  主分类: [channel === '男频' ? '东方玄幻' : '女频悬疑'],
  主题: [],
  角色: [],
  情节: [],
});

const cloneProjectTags = (tags: Record<TagTab, string[]>): Record<TagTab, string[]> => ({
  主分类: [...tags.主分类],
  主题: [...tags.主题],
  角色: [...tags.角色],
  情节: [...tags.情节],
});

const maleTagCatalog: Record<TagTab, GenreTag[]> = {
  主分类: [
    { name: '东方玄幻', description: '偏东方世界观，包含玄法、奇术、神话传说', icon: '☯', tone: 'gold' },
    { name: '西方奇幻', description: '偏西方世界背景，包含魔法、骑士、精灵等', icon: '♜', tone: 'gold' },
    { name: '科幻末世', description: '末世、废土、星际、机甲、未来科技', icon: '◉', tone: 'blue' },
    { name: '男频衍生', description: '影视剧、动漫、网文世界的男频同人小说', icon: '✦', tone: 'gold' },
    { name: '都市高武', description: '都市架空，全民拥有修炼体系或超凡力量', icon: '⚡', tone: 'gold' },
    { name: '悬疑灵异', description: '男频探案、悬疑、恐怖、灵异和风水奇术', icon: '☠', tone: 'teal' },
    { name: '悬疑脑洞', description: '脑洞向的悬疑灵异、破案探险和未知谜团', icon: '⌕', tone: 'brown' },
    { name: '抗战谍战', description: '抗战时期的军事战争和间谍情报故事', icon: '◆', tone: 'green' },
    { name: '历史古代', description: '以种田、朝堂、智谋、争霸、科举等为主', icon: '▱', tone: 'green' },
    { name: '历史脑洞', description: '脑洞向历史，一般有金手指或特殊设定', icon: '◌', tone: 'teal' },
    { name: '都市种田', description: '重生年代文、职场商战、种田建设等题材', icon: '❋', tone: 'olive' },
    { name: '都市脑洞', description: '拥有金手指系统的男频都市脑洞奇想', icon: '▣', tone: 'navy' },
    { name: '都市日常', description: '都市情感、现实生活和轻日常故事', icon: '◆', tone: 'blue' },
    { name: '玄幻脑洞', description: '脑洞向玄幻，强调新奇设定和世界规则', icon: '♨', tone: 'orange' },
    { name: '战神赘婿', description: '都市向战神、兵王、赘婿逆袭文', icon: '⌁', tone: 'brown' },
    { name: '动漫衍生', description: '游戏、动漫专项同人或二次元衍生作品', icon: '✧', tone: 'peach' },
    { name: '游戏体育', description: '网游、竞技、体育及穿入游戏或世界', icon: '◎', tone: 'peach' },
    { name: '传统玄幻', description: '废柴逆袭、强者重生等传统玄幻题材', icon: '△', tone: 'teal' },
    { name: '都市修真', description: '以修真为力量体系的都市故事', icon: '◐', tone: 'olive' },
  ],
  主题: compactTags([
    ['衍生', '◫', 'gold'], ['仕途', '♟', 'gray'], ['综影视', '▰', 'gold'], ['天灾', '⚠', 'gold'],
    ['第一人称', 'Ⅰ', 'gold'], ['赛博朋克', '◉', 'navy'], ['第四天灾', 'Ⅳ', 'gold'], ['规则怪谈', '?', 'teal'],
    ['搞笑轻松', '☺', 'peach'], ['古代', '◒', 'gray'], ['悬疑', '●', 'red'], ['克苏鲁', '〰', 'navy'],
    ['都市异能', '⚡', 'purple'], ['末日求生', '☠', 'red'], ['灵气复苏', '✦', 'green'], ['高武世界', '拳', 'green'],
    ['异世大陆', '✣', 'blue'], ['东方玄幻', '龙', 'peach'], ['谍战', '➤', 'blue'], ['清朝', '帽', 'orange'],
    ['宋朝', '宋', 'coral'], ['断层', '山', 'brown'], ['武将', '将', 'teal'], ['国运', '鼎', 'red'],
    ['综漫', '漫', 'yellow'], ['开局', '剑', 'navy'], ['架空', '◉', 'blue'], ['奇幻仙侠', '剑', 'navy'],
    ['都市', '城', 'gold'], ['玄幻', '山', 'teal'], ['历史', '卷', 'green'], ['体育', '🏋', 'purple'], ['武侠', '鹤', 'gray'],
  ]),
  角色: compactTags([
    ['多女主', '女', 'peach'], ['赘婿', '婿', 'yellow'], ['全能', '◫', 'gold'], ['大佬', '鞋', 'purple'],
    ['大小姐', '花', 'coral'], ['特工', '人', 'teal'], ['游戏主播', '游', 'green'], ['神探', '探', 'brown'],
    ['宫廷侯爵', '宫', 'gold'], ['皇帝', '帝', 'brown'], ['单女主', '女', 'coral'], ['校花', '校', 'peach'],
    ['无女主', '无', 'teal'], ['女帝', '后', 'brown'], ['特种兵', '枪', 'teal'], ['反派', '影', 'navy'],
    ['神医', '诊', 'green'], ['奶爸', '奶', 'orange'], ['学霸', '100', 'brown'], ['天才', '脑', 'teal'],
    ['腹黑', '黑', 'purple'], ['扮猪吃虎', '猪', 'orange'],
  ]),
  情节: compactTags([
    ['都市江湖', '◫', 'gold'], ['风水秘术', '卦', 'gold'], ['斩神衍生', '◫', 'gold'], ['十日衍生', '◫', 'gold'],
    ['西游衍生', '游', 'brown'], ['公版衍生', '◫', 'gold'], ['红楼衍生', '◫', 'gold'], ['甄嬛衍生', '◫', 'gold'],
    ['如懿衍生', '◫', 'gold'], ['惊悚游戏', '惊', 'gold'], ['卡牌', '牌', 'gold'], ['山海经', '山', 'gold'],
    ['捉鬼', '鬼', 'gold'], ['剑修', '剑', 'gold'], ['废土', '土', 'gold'], ['副本', '本', 'gold'],
    ['黑科技', '科', 'gold'], ['无脑爽', '爽', 'gold'], ['魂穿', '魂', 'gold'], ['高手下山', '山', 'gold'],
    ['黑化', '黑', 'gold'], ['迪化', '迪', 'gold'], ['发家致富', '富', 'gold'], ['无后宫', '无', 'gold'],
    ['争霸', '争', 'gold'], ['1v1', '1', 'gold'], ['升级流', '↑', 'gold'], ['灵魂互换', '换', 'teal'],
    ['科举', '卷', 'gold'], ['封神', '神', 'gold'], ['四合院', '院', 'orange'], ['电竞', '竞', 'teal'],
    ['双重生', '双', 'blue'], ['乡村', '田', 'yellow'], ['同人', '同', 'yellow'], ['打脸', '掌', 'brown'],
    ['破案', '案', 'green'], ['囤物资', '箱', 'coral'], ['钓鱼', '鱼', 'olive'], ['网游', '剑', 'navy'],
    ['奥特同人', '奥', 'blue'], ['求生', '帐', 'green'], ['无敌', '拳', 'yellow'], ['九叔', '符', 'red'],
    ['穿书', '书', 'purple'], ['聊天群', '群', 'green'], ['大秦', '秦', 'red'], ['龙珠', '珠', 'green'],
    ['漫威', '盾', 'navy'], ['神奇宝贝', '球', 'blue'], ['海贼', '帽', 'blue'], ['火影', '忍', 'navy'],
    ['职场', '包', 'brown'], ['明朝', '明', 'gold'], ['家庭', '家', 'blue'], ['三国', '马', 'gold'],
    ['末世', '火', 'orange'], ['直播', '播', 'blue'], ['无限流', '∞', 'teal'], ['诸天万界', '界', 'olive'],
    ['大唐', '唐', 'brown'], ['宠物', '宠', 'brown'], ['外卖', '送', 'olive'], ['星际', '星', 'navy'],
    ['美食', '食', 'coral'], ['剑道', '刀', 'purple'], ['盗墓', '墓', 'gray'], ['灵异', '灵', 'green'],
    ['鉴宝', '镜', 'teal'], ['系统', '图', 'gold'], ['神豪', '钱', 'olive'], ['重生', '蝶', 'orange'],
    ['穿越', '穿', 'teal'], ['二次元', '笔', 'olive'], ['海岛', '岛', 'blue'], ['娱乐圈', '娱', 'gray'],
    ['空间', '空', 'coral'], ['推理', '帽', 'brown'], ['洪荒', '荒', 'orange'],
  ]),
};

const femaleTagCatalog: Record<TagTab, GenreTag[]> = {
  主分类: [
    { name: '女频悬疑', description: '以女性视角为主，讲述悬疑、探案和灵异故事', icon: '⌕', tone: 'red' },
    { name: '古风世情', description: '女频历史、权谋以及原生土著的古风故事', icon: '卷', tone: 'gold' },
    { name: '科幻末世', description: '末世、丧尸、星际、机甲与未来科技', icon: '◉', tone: 'blue' },
    { name: '女频衍生', description: '影视剧或古籍女频同人小说', icon: '✦', tone: 'gold' },
    { name: '青春甜宠', description: '校园题材，可甜可酸，青春成长', icon: '花', tone: 'coral' },
    { name: '双男主', description: '讲述两位男性主角之间的故事', icon: '双', tone: 'blue' },
    { name: '古言脑洞', description: '含金手指、系统或特殊设定的古言故事', icon: '古', tone: 'blue' },
    { name: '现言脑洞', description: '含系统、读心术等非现实元素的现言故事', icon: '今', tone: 'purple' },
    { name: '玄幻言情', description: '玄幻、修真、御兽等幻想言情故事', icon: '幻', tone: 'olive' },
    { name: '宫斗宅斗', description: '古代后宫、宅院与家族斗争', icon: '宫', tone: 'brown' },
    { name: '豪门总裁', description: '豪门、总裁、先婚后爱等都市情感故事', icon: '楼', tone: 'teal' },
    { name: '动漫衍生', description: '游戏、动漫等二次元方向的同人作品', icon: '漫', tone: 'peach' },
    { name: '星光璀璨', description: '娱乐圈、明星、综艺、恋综与直播故事', icon: '◆', tone: 'blue' },
    { name: '游戏体育', description: '网游、竞技、体育及穿入游戏世界', icon: '◎', tone: 'orange' },
    { name: '职场婚恋', description: '职场、婚姻生活与现实情感故事', icon: '职', tone: 'coral' },
    { name: '双女主', description: '讲述两位女性主角之间的故事', icon: '双', tone: 'navy' },
    { name: '年代', description: '穿越年代、重生年代与时代生活', icon: '年', tone: 'purple' },
    { name: '种田', description: '种田、空间、灵泉、逃荒与经营建设', icon: '田', tone: 'orange' },
    { name: '快穿', description: '主角穿越多个小世界完成任务', icon: '⌛', tone: 'teal' },
  ],
  主题: simpleTags([
    '古言权谋', '悬疑恋爱', '纯爱', '衍生', '仕途', '综影视', '天灾', '第一人称', '赛博朋克', '规则怪谈',
    '搞笑轻松', '古代', '悬疑', '谍战', '职场商战', '虐恋情深', '日久生情', '豪门世家', '综漫', '异世穿越',
    '独宠', '现代言情', '古代言情', '幻想言情', '武侠',
  ], '✦', 'coral'),
  角色: simpleTags([
    '位尊权重', '总裁', '忠犬', '全能', '白切黑', '双学霸', '作精', '大佬', '大小姐', '游戏主播',
    '神探', '将军', '毒医', '厨娘', '律师', '医生', '明星', '替身', '双面', '冰山', '古灵精怪',
    '天作之合', '可盐可甜', '无CP', '病娇', '反派', '萌宝', '宠妻', '学霸', '公主', '皇后', '王妃',
    '女强', '皇叔', '嫡女', '精灵', '天才', '腹黑', '扮猪吃虎', '团宠',
  ], '角', 'purple'),
  情节: simpleTags([
    '男二上位', '代嫁代娶', '攻略反派', '风水秘术', '斩神衍生', '十日衍生', '西游衍生', '公版衍生',
    '红楼衍生', '甄嬛衍生', '如懿衍生', '惊悚游戏', '追夫', '山海经', '胎穿', '捉鬼', '剑修',
    '相互救赎', '宠夫', '无脑爽', '魂穿', '黑化', '养崽', '年龄差', '真假千金', '久别重逢',
    '发家致富', '养成', '互宠', '1v1', '灵魂互换', '科举', '年下', '婚恋', '封神', '四合院', '电竞',
    '双重生', '前世今生', '双洁', '追妻火葬场', '乡村', '逃荒', '同人', '打脸', '破案', '囤物资',
    '钓鱼', 'HE', '相爱相杀', '暗恋', '逃婚', '带球跑', '强强', '一见钟情', '双向奔赴', '破镜重圆',
    '契约婚姻', '隐婚', '闪婚', '今穿古', '古穿今', '群穿', '护短', '虐渣', '情有独钟', '马甲',
    '先婚后爱', '医术', '女扮男装', '青梅竹马', '无敌', '民国', '穿书', '职场', '家庭', '末世',
    '直播', '无限流', '兽世', '清穿', '星际', '美食', '盗墓', '虐文', '甜宠', '灵异', '校园', '系统',
    '重生', '穿越', '二次元', '娱乐圈', '空间', '推理',
  ], '情', 'gold'),
};

const channelTagCatalog: Record<Channel, Record<TagTab, GenreTag[]>> = {
  男频: maleTagCatalog,
  女频: femaleTagCatalog,
};

const normalizeStoredProject = (value: unknown): Project => {
  const project = value && typeof value === 'object' ? value as Partial<Project> : {};
  const now = new Date().toISOString();
  const chapters = Array.isArray(project.chapters) ? project.chapters.map((chapter, index) => ({
    ...chapter,
    id: Number(chapter.id) || Date.now() + index,
    title: typeof chapter.title === 'string' ? chapter.title : '未命名章节',
    content: typeof chapter.content === 'string' ? chapter.content : '',
    wordCount: countNovelCharacters(typeof chapter.content === 'string' ? chapter.content : ''),
    createdAt: typeof chapter.createdAt === 'string' ? chapter.createdAt : now,
    updatedAt: typeof chapter.updatedAt === 'string' ? chapter.updatedAt : now,
  })) : [];
  const memories = Array.isArray(project.memories) ? project.memories.map(memory => normalizeChapterMemory(memory)) : [];
  return {
    ...project,
    id: Number(project.id) || Date.now(),
    title: typeof project.title === 'string' && project.title.trim() ? project.title.trim() : '未命名小说',
    genre: typeof project.genre === 'string' ? project.genre : '玄幻',
    subgenre: typeof project.subgenre === 'string' ? project.subgenre : project.genre || '东方玄幻',
    tags: project.tags && typeof project.tags === 'object' ? project.tags : {},
    protagonist1: typeof project.protagonist1 === 'string' ? project.protagonist1 : '',
    protagonist2: typeof project.protagonist2 === 'string' ? project.protagonist2 : '',
    synopsis: typeof project.synopsis === 'string' ? project.synopsis : '',
    status: project.status === 'completed' ? 'completed' : 'writing',
    chapters,
    outline: Array.isArray(project.outline) ? project.outline : [],
    outlines: Array.isArray(project.outlines) ? project.outlines : [],
    cards: Array.isArray(project.cards) ? project.cards : [],
    memories,
    memoryDocuments: hydrateMemoryDocuments(project.memoryDocuments, memories),
    graphNodes: Array.isArray(project.graphNodes) ? project.graphNodes : [],
    graphEdges: normalizeKnowledgeGraphEdges(project.graphEdges),
    createdAt: typeof project.createdAt === 'string' ? project.createdAt : now,
    updatedAt: typeof project.updatedAt === 'string' ? project.updatedAt : now,
    wordCount: chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0),
    chapterTargetWords: Number(project.chapterTargetWords) > 0 ? Number(project.chapterTargetWords) : 3000,
    githubRepositoryUrl: typeof project.githubRepositoryUrl === 'string' ? project.githubRepositoryUrl : undefined,
  };
};

const projectAgentChangeTargetKey = (change: ProjectAgentChange) => {
  if (change.type === 'project.update') return 'project';
  if (change.type === 'outline.upsert') return `outline:${change.targetId ?? `new:${change.kind}:${change.title}`}`;
  if (change.type === 'card.upsert') return `card:${change.targetId ?? `new:${change.cardType}:${change.title}`}`;
  if (change.type === 'memory.document.upsert') return `memory:${change.kind}`;
  if (change.type === 'graph.node.upsert') return `graph-node:${change.targetId}`;
  if (change.type === 'graph.edge.upsert') return `graph-edge:${change.targetId}`;
  // 修订和删除指向同一章时互斥：先应用的那条会让另一条失效
  if (change.type === 'chapter.update' || change.type === 'chapter.delete') return `chapter:${change.targetId}`;
  // 批量标题只改标题栏，和逐章修订不冲突；同一批里再来一条批量标题才算互斥
  if (change.type === 'chapter.titles') return 'chapter-titles';
  if (change.type === 'chapter.parts') return 'chapter-parts';
  return `chapter:new:${change.title}`;
};

const projectAgentRebase = (change: ProjectAgentChange, project: Project): ProjectAgentChange => {
  if (change.type === 'project.update') {
    const source = project as unknown as Record<string, unknown>;
    return { ...change, baseFields: Object.fromEntries(Object.keys(change.patch).map(key => [key, source[key]])) };
  }
  if (change.type === 'outline.upsert') return { ...change, baseUpdatedAt: project.outlines.find(item => item.id === change.targetId)?.updatedAt };
  if (change.type === 'card.upsert') return { ...change, baseUpdatedAt: project.cards.find(item => item.id === change.targetId)?.updatedAt };
  if (change.type === 'memory.document.upsert') return { ...change, baseUpdatedAt: project.memoryDocuments.find(item => item.kind === change.kind)?.updatedAt };
  if (change.type === 'graph.node.upsert') return { ...change, baseUpdatedAt: project.graphNodes.find(item => item.id === change.targetId)?.updatedAt };
  if (change.type === 'graph.edge.upsert') return { ...change, baseUpdatedAt: project.graphEdges.find(item => item.id === change.targetId)?.updatedAt };
  if (change.type === 'chapter.update') return { ...change, baseUpdatedAt: project.chapters.find(item => item.id === change.targetId)?.updatedAt };
  return change;
};

const applyProjectAgentChangeBatch = (project: Project, changes: ProjectAgentChange[]): { project: Project; createdChapterId?: number; deletedChapterIds: number[] } => {
  const order: Record<ProjectAgentRawChange['type'], number> = {
    'project.update': 0,
    'outline.upsert': 1,
    'card.upsert': 2,
    'memory.document.upsert': 3,
    'graph.node.upsert': 4,
    'graph.edge.upsert': 5,
    'chapter.create': 6,
    'chapter.update': 7,
    // 标题在正文之后：同一章既被修订又被补标题时，标题要落在修订后的正文上
    'chapter.titles': 8,
    // 拆章在标题之后：先把标题落定，再按段落切开，新章直接插在原章后面
    'chapter.parts': 9,
    // 删除最后执行：否则同批次里针对该章的其他变更会找不到目标
    'chapter.delete': 10,
  };
  const pending = changes.filter(change => change.status === 'pending').sort((left, right) => order[left.type] - order[right.type]);
  if (!pending.length) throw new Error('没有待应用的变更');
  const now = new Date().toISOString();
  const stale = (expected: string | undefined, actual: string | undefined, label: string) => {
    if (expected && expected !== actual) throw new Error(`${label}已在提案生成后发生修改，请重新让项目 Agent 处理`);
  };
  for (const change of pending) {
    if (change.type === 'project.update' && change.baseFields) {
      const source = project as unknown as Record<string, unknown>;
      const conflicts = Object.keys(change.baseFields).filter(key => JSON.stringify(source[key]) !== JSON.stringify(change.baseFields?.[key]));
      if (conflicts.length) throw new Error(`小说资料的 ${conflicts.join('、')} 已在提案生成后被修改，请重新让项目 Agent 处理`);
    }
    if (change.type === 'outline.upsert') {
      const target = change.targetId ? project.outlines.find(item => item.id === change.targetId) : undefined;
      if (change.targetId && !target) throw new Error(`找不到待更新大纲 ID ${change.targetId}`);
      if (target) stale(change.baseUpdatedAt, target.updatedAt, `大纲《${target.title}》`);
    }
    if (change.type === 'card.upsert') {
      const target = change.targetId ? project.cards.find(item => item.id === change.targetId) : undefined;
      if (change.targetId && !target) throw new Error(`找不到待更新卡片 ID ${change.targetId}`);
      if (target) stale(change.baseUpdatedAt, target.updatedAt, `卡片《${target.title}》`);
    }
    if (change.type === 'memory.document.upsert') {
      const target = project.memoryDocuments.find(item => item.kind === change.kind);
      if (target) stale(change.baseUpdatedAt, target.updatedAt, `记忆文档《${change.title}》`);
    }
    if (change.type === 'graph.node.upsert') {
      const target = project.graphNodes.find(item => item.id === change.targetId);
      if (target) stale(change.baseUpdatedAt, target.updatedAt, `图谱节点《${change.label}》`);
    }
    if (change.type === 'graph.edge.upsert') {
      const target = project.graphEdges.find(item => item.id === change.targetId);
      if (target) stale(change.baseUpdatedAt, target.updatedAt, `图谱关系《${change.label}》`);
    }
    if (change.type === 'chapter.create') {
      if (project.chapters.some(item => item.title.trim() === change.title.trim())) throw new Error(`章节《${change.title}》已经存在`);
    }
    if (change.type === 'chapter.update' || change.type === 'chapter.delete') {
      const target = project.chapters.find(item => item.id === change.targetId);
      if (!target) throw new Error(`找不到章节 ID ${change.targetId}`);
      if (change.type === 'chapter.update') stale(change.baseUpdatedAt, target.updatedAt, `章节《${target.title}》`);
    }
  }

  let next: Project = { ...project };
  let serial = Date.now();
  let createdChapterId: number | undefined;
  const deletedChapterIds: number[] = [];
  for (const change of pending) {
    if (change.type === 'project.update') {
      next = { ...next, ...change.patch };
      continue;
    }
    if (change.type === 'outline.upsert') {
      const outline: OutlineDocument = {
        id: change.targetId ?? ++serial,
        kind: change.kind,
        chapterId: change.chapterId,
        title: change.title,
        content: change.content,
        createdAt: change.targetId ? next.outlines.find(item => item.id === change.targetId)?.createdAt || now : now,
        updatedAt: now,
      };
      next = {
        ...next,
        outlines: change.targetId ? next.outlines.map(item => item.id === change.targetId ? outline : item) : [...next.outlines, outline],
        graphNodes: next.graphNodes.some(node => node.id === `outline:${outline.id}`)
          ? next.graphNodes.map(node => node.id === `outline:${outline.id}` ? { ...node, label: outline.title, category: outline.kind, updatedAt: now } : node)
          : [...next.graphNodes, { id: `outline:${outline.id}`, label: outline.title, type: 'outline', category: outline.kind, content: createGraphNodeProfile('outline', outline.kind), updatedAt: now }],
      };
      continue;
    }
    if (change.type === 'card.upsert') {
      const previous = change.targetId ? next.cards.find(item => item.id === change.targetId) : undefined;
      const card: KnowledgeCard = {
        id: change.targetId ?? ++serial,
        type: change.cardType,
        title: change.title,
        content: change.content,
        currentState: change.currentState ?? previous?.currentState,
        stateHistory: previous?.stateHistory,
        createdAt: previous?.createdAt || now,
        updatedAt: now,
      };
      next = {
        ...next,
        cards: change.targetId ? next.cards.map(item => item.id === change.targetId ? card : item) : [...next.cards, card],
        graphNodes: next.graphNodes.some(node => node.id === `card:${card.id}`)
          ? next.graphNodes.map(node => node.id === `card:${card.id}` ? { ...node, label: card.title, category: card.type, updatedAt: now } : node)
          : [...next.graphNodes, { id: `card:${card.id}`, label: card.title, type: 'card', category: card.type, content: createGraphNodeProfile('card', card.type), updatedAt: now }],
      };
      continue;
    }
    if (change.type === 'memory.document.upsert') {
      const existing = next.memoryDocuments.find(item => item.kind === change.kind);
      const document: MemoryDocument = {
        id: existing?.id || memoryDocumentId(change.kind),
        kind: change.kind,
        title: change.title,
        content: change.content,
        updatedAt: now,
        manuallyEdited: true,
      };
      next = { ...next, memoryDocuments: existing ? next.memoryDocuments.map(item => item.id === existing.id ? document : item) : [...next.memoryDocuments, document] };
      continue;
    }
    if (change.type === 'graph.node.upsert') {
      const existing = next.graphNodes.find(item => item.id === change.targetId);
      const node: KnowledgeGraphNode = {
        ...existing,
        id: change.targetId,
        label: change.label,
        type: change.nodeType,
        category: change.category ?? existing?.category,
        content: change.content ?? existing?.content ?? createGraphNodeProfile(change.nodeType, change.category),
        status: change.nodeStatus ?? existing?.status,
        updatedAt: now,
      };
      next = { ...next, graphNodes: existing ? next.graphNodes.map(item => item.id === node.id ? node : item) : [...next.graphNodes, node] };
      continue;
    }
    if (change.type === 'graph.edge.upsert') {
      const availableNodeIds = new Set(next.graphNodes.map(node => node.id));
      if (!availableNodeIds.has(change.source) || !availableNodeIds.has(change.target)) {
        throw new Error(`图谱关系《${change.label}》引用了不存在的节点`);
      }
      const existing = next.graphEdges.find(item => item.id === change.targetId);
      const edge: KnowledgeGraphEdge = {
        ...existing,
        id: change.targetId,
        source: change.source,
        target: change.target,
        label: change.label,
        weight: normalizeKnowledgeGraphWeight(change.weight, change.label),
        updatedAt: now,
      };
      next = { ...next, graphEdges: existing ? next.graphEdges.map(item => item.id === edge.id ? edge : item) : [...next.graphEdges, edge] };
      continue;
    }
    if (change.type === 'chapter.update') {
      const target = next.chapters.find(item => item.id === change.targetId);
      if (!target) throw new Error(`找不到章节 ID ${change.targetId}`);
      // Agent 修订也会覆盖正文，先存快照才能回滚
      const updated: Chapter = {
        ...pushChapterSnapshot(target, 'Agent 修订'),
        title: change.title?.trim() || target.title,
        content: change.content,
        wordCount: countNovelCharacters(change.content),
        updatedAt: now,
      };
      next = {
        ...next,
        chapters: next.chapters.map(item => item.id === updated.id ? updated : item),
        // 图谱节点标题跟随章节标题；正文变了但章节记忆仍是旧的，由作者重新保存时刷新
        graphNodes: next.graphNodes.map(node => node.id === `chapter:${updated.id}` ? { ...node, label: updated.title, updatedAt: now } : node),
      };
      continue;
    }
    if (change.type === 'chapter.titles') {
      // 一条变更带几百章标题，逐章落地：只改标题栏，正文只在标题原本写在开头时才动
      const byId = new Map(change.titles.map(item => [item.targetId, item]));
      let touched = 0;
      const chapters = next.chapters.map(chapter => {
        const entry = byId.get(chapter.id);
        if (!entry) return chapter;
        touched += 1;
        if (!entry.stripHeading) return { ...chapter, title: entry.title, updatedAt: now };
        // 标题原本是正文开头的 # 标题行（旧版本遗留）：这里重新拆一遍当前正文，
        // 而不是让运行时把几百章改写后的正文回传，那会把请求体和会话存档撑爆
        const draft = splitChapterTitleHeading(chapter.content);
        if (!draft.title) return { ...chapter, title: entry.title, updatedAt: now };
        return {
          ...pushChapterSnapshot(chapter, 'Agent 补标题'),
          title: entry.title,
          content: draft.content,
          wordCount: countNovelCharacters(draft.content),
          updatedAt: now,
        };
      });
      if (!touched) throw new Error('批量标题里的章节都已经不存在了，请重新让项目 Agent 处理');
      const titleById = new Map(chapters.map(chapter => [chapter.id, chapter.title]));
      next = {
        ...next,
        chapters,
        // 图谱节点标签跟着标题走，否则图谱里还挂着一堆“第 N 章”
        graphNodes: next.graphNodes.map(node => {
          const chapterId = node.id.startsWith('chapter:') ? Number(node.id.slice(8)) : 0;
          const title = chapterId && byId.has(chapterId) ? titleById.get(chapterId) : undefined;
          return title ? { ...node, label: title, updatedAt: now } : node;
        }),
      };
      continue;
    }
    if (change.type === 'chapter.parts') {
      // 拆章只收到切点，正文在本地：按空行分段后就地切开，新章紧跟在原章后面插入，
      // 不能走 chapter.create（那个只会追加到全书末尾，拆出来的下半章会跑到几百章之后）
      const bySource = new Map(change.splits.map(item => [item.targetId, item]));
      const chapters: Chapter[] = [];
      const skipped: string[] = [];
      let split = 0;
      for (const chapter of next.chapters) {
        const plan = bySource.get(chapter.id);
        const paragraphs = plan ? splitParagraphs(chapter.content) : [];
        // 规划之后正文又被改过就跳过这一章：按旧段落序号硬切会把句子拦腰截断
        if (!plan || paragraphs.length !== plan.paragraphCount) {
          if (plan) skipped.push(chapter.title);
          chapters.push(chapter);
          continue;
        }
        split += 1;
        const bodies = partsFromBreaks(paragraphs, plan.breakAfter);
        for (const [index, body] of bodies.entries()) {
          const title = plan.titles[index] || chapter.title;
          // 第一段原地留在本章：保留 id、创建时间和历史版本，作者的书签和引用不会断
          if (index === 0) {
            chapters.push({ ...pushChapterSnapshot(chapter, 'Agent 拆章'), title, content: body, wordCount: countNovelCharacters(body), updatedAt: now });
            continue;
          }
          chapters.push({ id: ++serial, title, content: body, wordCount: countNovelCharacters(body), createdAt: now, updatedAt: now });
        }
      }
      if (!split) throw new Error(`拆章没有落地：${skipped.length ? `《${skipped[0]}》等章节的正文已在提案生成后被修改` : '这些章节都已经不存在了'}，请重新让项目 Agent 处理`);
      const existingNodes = new Set(next.graphNodes.map(node => node.id));
      next = {
        ...next,
        chapters,
        graphNodes: [
          ...next.graphNodes.map(node => {
            const chapterId = node.id.startsWith('chapter:') ? Number(node.id.slice(8)) : 0;
            const renamed = chapterId ? chapters.find(chapter => chapter.id === chapterId) : undefined;
            return renamed && bySource.has(chapterId) ? { ...node, label: renamed.title, updatedAt: now } : node;
          }),
          // 拆出来的新章要各自进图谱，否则它们在关系图里根本不存在
          ...chapters.filter(chapter => !existingNodes.has(`chapter:${chapter.id}`))
            .map(chapter => ({ id: `chapter:${chapter.id}`, label: chapter.title, type: 'chapter' as const, content: createGraphNodeProfile('chapter'), updatedAt: now })),
        ],
      };
      continue;
    }
    if (change.type === 'chapter.delete') {
      deletedChapterIds.push(change.targetId);
      next = removeChapterFromProject(next, change.targetId);
      continue;
    }
    if (change.type === 'chapter.create') {
      const chapter: Chapter = {
        id: ++serial,
        title: change.title,
        content: change.content,
        wordCount: countNovelCharacters(change.content),
        createdAt: now,
        updatedAt: now,
      };
      createdChapterId = chapter.id;
      const memories = change.chapterSummary ? [...next.memories, normalizeChapterMemory({
        id: ++serial,
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        summary: change.chapterSummary,
        keywords: [],
        characterStateChanges: [],
        knowledgeChanges: [],
        foreshadowingChanges: [],
        timelineEvents: [],
        canonFacts: [],
        conflicts: [],
        endingHook: '',
        sourceChapterNumber: next.chapters.length + 1,
        createdAt: now,
        updatedAt: now,
      }, chapter)] : next.memories;
      let outlines = next.outlines;
      let graphNodes = [...next.graphNodes, { id: `chapter:${chapter.id}`, label: chapter.title, type: 'chapter' as const, content: createGraphNodeProfile('chapter'), updatedAt: now }];
      if (change.chapterPlan?.trim()) {
        const outline: OutlineDocument = { id: ++serial, kind: '章纲', chapterId: chapter.id, title: `章纲｜${chapter.title}`, content: change.chapterPlan, createdAt: now, updatedAt: now };
        outlines = [...outlines, outline];
        graphNodes = [...graphNodes, { id: `outline:${outline.id}`, label: outline.title, type: 'outline', category: '章纲', content: createGraphNodeProfile('outline', '章纲'), updatedAt: now }];
      }
      next = {
        ...next,
        chapters: [...next.chapters, chapter],
        outlines,
        memories,
        memoryDocuments: change.chapterSummary ? buildMemoryDocuments(memories, next.memoryDocuments) : next.memoryDocuments,
        graphNodes,
      };
    }
  }
  return {
    project: {
      ...next,
      wordCount: next.chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0),
      updatedAt: now,
    },
    createdChapterId,
    deletedChapterIds,
  };
};

function App() {
  const [activeTab, setActiveTab] = useState<TabType>('projects');
  const [projects, setProjects] = useState<Project[]>(() => {
    const saved = localStorage.getItem('projects');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          // 兼容旧版本项目数据：补齐章节、大纲和时间字段
          return parsed.map((project: Partial<Project>) => {
            const chapters = Array.isArray(project.chapters) ? project.chapters.map((chapter: Partial<Chapter>) => ({
              id: Number(chapter.id) || Date.now(),
              title: chapter.title ?? '未命名章节',
              content: chapter.content ?? '',
              wordCount: countNovelCharacters(chapter.content ?? ''),
              createdAt: chapter.createdAt ?? new Date().toISOString(),
              updatedAt: chapter.updatedAt ?? new Date().toISOString(),
            })) : [];
            const legacyOutlines = Array.isArray(project.outlines) ? project.outlines : [];
            const legacyGoldFingerCards = legacyOutlines.filter((outline: any) => outline?.kind === '金手指' && String(outline.content || '').trim()).map((outline: any) => ({
              id: Number(outline.id) || Date.now(), type: '金手指卡' as CardType, title: outline.title || '金手指设定', content: outline.content,
              currentState: '', stateHistory: [], createdAt: outline.createdAt ?? new Date().toISOString(), updatedAt: outline.updatedAt ?? new Date().toISOString(),
            }));
            const existingCards = Array.isArray(project.cards) ? project.cards : [];
            return {
              id: Number(project.id) || Date.now(),
              title: project.title ?? '未命名小说',
              genre: project.genre ?? '玄幻',
              subgenre: project.subgenre ?? project.genre ?? '东方玄幻',
              tags: project.tags ?? {},
              cover: project.cover,
              protagonist1: project.protagonist1 ?? '',
              protagonist2: project.protagonist2 ?? '',
              synopsis: project.synopsis ?? '',
              status: project.status === 'completed' ? 'completed' : 'writing',
              wordCount: chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0),
              chapters,
              outline: Array.isArray(project.outline) ? project.outline : [],
              outlines: legacyOutlines.filter((outline: any) => outline?.kind !== '金手指').map((outline: any) => ({ ...outline, kind: outline.kind === '细纲' ? '章纲' : outline.kind })),
              cards: [...existingCards, ...legacyGoldFingerCards.filter(card => !existingCards.some((existing: any) => existing.title === card.title && existing.content === card.content))],
              memories: Array.isArray(project.memories) ? project.memories.map(memory => normalizeChapterMemory(memory)) : [],
              memoryDocuments: hydrateMemoryDocuments(project.memoryDocuments, Array.isArray(project.memories) ? project.memories.map(memory => normalizeChapterMemory(memory)) : []),
              graphNodes: Array.isArray(project.graphNodes) ? project.graphNodes : [],
              graphEdges: normalizeKnowledgeGraphEdges(project.graphEdges),
              // Keep legacy publish metadata intact when saving older projects.
              // The automatic publishing feature itself is no longer available.
              publishConfig: project.publishConfig,
              publishRecords: project.publishRecords,
              chapterTargetWords: Number(project.chapterTargetWords) > 0 ? Number(project.chapterTargetWords) : 3000,
              aiDetection: project.aiDetection,
              styleProfileId: typeof project.styleProfileId === 'string' ? project.styleProfileId : undefined,
              sourceDismantleBookId: typeof project.sourceDismantleBookId === 'string' ? project.sourceDismantleBookId : undefined,
              createdAt: project.createdAt ?? project.updatedAt ?? new Date().toISOString(),
              updatedAt: project.updatedAt ?? new Date().toISOString(),
            };
          });
        }
      } catch {
        localStorage.removeItem('projects');
      }
    }
    // 没有本地项目时直接展示居中的新建入口。
    return [];
  });
  const [libraryBooks, setLibraryBooks] = useState<LibraryBook[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('writer-library-books') || '[]');
      return Array.isArray(saved) ? saved.map(book => normalizeLibraryBook(book)) : [];
    } catch { return []; }
  });
  const [rankingBooks, setRankingBooks] = useState<RankingBook[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('writer-ranking-books') || '[]');
      return Array.isArray(saved) ? saved.map((book, index) => normalizeRankingBook(book, index)).filter(trustedRankingCache) : [];
    } catch { return []; }
  });
  const [dismantleBooks, setDismantleBooks] = useState<DismantleBook[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('writer-dismantle-books') || '[]');
      return Array.isArray(saved) ? saved.map(book => normalizeDismantleBook(book)) : [];
    } catch { return []; }
  });
  const [writingStyles, setWritingStyles] = useState<WritingStyle[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('writer-writing-styles') || '[]');
      return Array.isArray(saved) ? saved.map(style => normalizeWritingStyle(style)) : [];
    } catch { return []; }
  });
  const [activeLibraryBookId, setActiveLibraryBookId] = useState<string | null>(null);
  const [activeLibraryChapterId, setActiveLibraryChapterId] = useState<string | null>(null);
  const [libraryChapterDownloadRunningId, setLibraryChapterDownloadRunningId] = useState<string | null>(null);
  const [libraryOutlineRunningId, setLibraryOutlineRunningId] = useState<string | null>(null);
  const [rankingPlatform, setRankingPlatform] = useState<RankingPlatform>('fanqie');
  const [rankingType, setRankingType] = useState<RankingType>('read');
  const [fanqieSection, setFanqieSection] = useState<FanqieSection>('male-read');
  const [fanqieCategories, setFanqieCategories] = useState<Record<FanqieSection, RankingCategoryOption[]>>({ 'male-read': [], 'male-new': [], 'female-read': [], 'female-new': [] });
  const [fanqieCategoryId, setFanqieCategoryId] = useState('all');
  const [fanqieCategoriesLoading, setFanqieCategoriesLoading] = useState(false);
  const [rankingLoading, setRankingLoading] = useState(false);
  const [rankingQuery, setRankingQuery] = useState('');
  const [rankingFontCss, setRankingFontCss] = useState('');

  const [bookSearchQuery, setBookSearchQuery] = useState('');
  const [bookSearchLoading, setBookSearchLoading] = useState(false);
  const [librarySearchResults, setLibrarySearchResults] = useState<LibraryBook[]>([]);
  const [bookDownloadRunningId, setBookDownloadRunningId] = useState<string | null>(null);
  const txtImportInputRef = useRef<HTMLInputElement | null>(null);
  const [activeDismantleBookId, setActiveDismantleBookId] = useState<string | null>(null);
  const [activeDismantleChapterId, setActiveDismantleChapterId] = useState<string | null>(null);
  const [selectedDismantleChapterIds, setSelectedDismantleChapterIds] = useState<string[]>([]);
  const [dismantleRunningIds, setDismantleRunningIds] = useState<string[]>([]);
  const [dismantleRewriteRunning, setDismantleRewriteRunning] = useState(false);
  const [dismantleRewriteInstruction, setDismantleRewriteInstruction] = useState('保留章节的冲突强度和推进节奏，重构为独立原创故事。');
  const [styleDistilling, setStyleDistilling] = useState(false);
  const [styleDraft, setStyleDraft] = useState<WritingStyle | null>(null);
  const [imitationSource, setImitationSource] = useState<{ bookId: string; chapterId?: string } | null>(null);
  const [skills, setSkills] = useState<Skill[]>(() => builtinSkills);
  const [skillCategoryFilter, setSkillCategoryFilter] = useState('');
  const [skillSearch, setSkillSearch] = useState('');
  const [deviceStorageReady, setDeviceStorageReady] = useState(false);
  const [resourceStorageReady, setResourceStorageReady] = useState(false);
  
  // 模态框状态
  const [showNewProjectModal, setShowNewProjectModal] = useState(false);
  const [projectFormMode, setProjectFormMode] = useState<'create' | 'edit'>('create');
  const [projectEditingId, setProjectEditingId] = useState<number | null>(null);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showMobileMore, setShowMobileMore] = useState(false);
  const [showOutlineTypeModal, setShowOutlineTypeModal] = useState(false);
  const [showTagPicker, setShowTagPicker] = useState(false);
  const [activeTagTab, setActiveTagTab] = useState<TagTab>('主分类');
  const [tagDraft, setTagDraft] = useState<Record<TagTab, string[]>>(defaultProjectTags);
  const [projectPendingDeletion, setProjectPendingDeletion] = useState<Project | null>(null);
  const [chapterPendingDeletion, setChapterPendingDeletion] = useState<Chapter | null>(null);
  const [showNewSkillModal, setShowNewSkillModal] = useState(false);
  const [skillEditingId, setSkillEditingId] = useState<number | string | null>(null);
  const [notice, setNotice] = useState<{ title: string; content: string } | null>(null);
  
  // 编辑器状态
  // 项目列表是唯一权威状态，编辑器只保存当前项目 ID，避免长期复制整本小说
  const [editingProjectId, setEditingProjectId] = useState<number | null>(null);
  const editingProject = editingProjectId === null ? null : projects.find(project => project.id === editingProjectId) || null;
  const editingProjectRef = useRef<Project | null>(null);
  const projectsRef = useRef<Project[]>(projects);
  useEffect(() => { editingProjectRef.current = editingProject; }, [editingProject]);
  useEffect(() => { projectsRef.current = projects; }, [projects]);
  const setEditingProject = (value: Project | null | ((project: Project | null) => Project | null)) => {
    const current = editingProjectRef.current;
    const next = typeof value === 'function' ? value(current) : value;
    if (!next) {
      editingProjectRef.current = null;
      setEditingProjectId(null);
      return;
    }
    editingProjectRef.current = next;
    setEditingProjectId(next.id);
    setProjects(projects => {
      const existing = projects.find(project => project.id === next.id);
      if (existing === next) return projects;
      return existing ? projects.map(project => project.id === next.id ? next : project) : [...projects, next];
    });
  };
  const [editorSidebarTab, setEditorSidebarTab] = useState<'chapters' | 'search' | 'outline' | 'knowledge-graph' | 'cards' | 'style' | 'knowledge' | 'ai-detect'>('chapters');
  const [aiDetecting, setAIDetecting] = useState(false);
  const [activeChapter, setActiveChapter] = useState<Chapter | null>(null);
  const [copiedTitle, setCopiedTitle] = useState(false);
  const [copiedContent, setCopiedContent] = useState(false);
  const [copiedAuthorNote, setCopiedAuthorNote] = useState(false);
  const [copiedCombined, setCopiedCombined] = useState(false);
  const [copyPreset, setCopyPreset] = useState<PlatformFormatPreset>(() => {
    const saved = localStorage.getItem('novel_copy_preset');
    return (saved === 'standard' || saved === 'clean' || saved === 'compact' || saved === 'raw') ? saved : 'standard';
  });
  const [showCopyDropdown, setShowCopyDropdown] = useState(false);
  const [authorNoteExpanded, setAuthorNoteExpanded] = useState(false);
  const copyMenuRef = useRef<HTMLDivElement | null>(null);
  const titleCopyTimerRef = useRef<number | null>(null);
  const contentCopyTimerRef = useRef<number | null>(null);
  const authorNoteCopyTimerRef = useRef<number | null>(null);
  const combinedCopyTimerRef = useRef<number | null>(null);
  const [activeOutlineId, setActiveOutlineId] = useState<number | null>(null);
  const [activeCardId, setActiveCardId] = useState<number | null>(null);
  const [activeMemoryDocumentId, setActiveMemoryDocumentId] = useState<string>(memoryDocumentId('章节快照'));
  const [activeChapterMemoryId, setActiveChapterMemoryId] = useState<number | null>(null);
  const [activeGraphNodeId, setActiveGraphNodeId] = useState<string | null>(null);
  const [graphViewMode, setGraphViewMode] = useState<'document' | 'graph'>('document');
  const [graphDocumentGroup, setGraphDocumentGroup] = useState('');
  const [graphDocumentQuery, setGraphDocumentQuery] = useState('');
  const [graphDocumentType, setGraphDocumentType] = useState('全部类型');
  const [graphOnlyIsolated, setGraphOnlyIsolated] = useState(false);
  const [expandedGraphDocumentIds, setExpandedGraphDocumentIds] = useState<string[]>([]);
  const [selectedCardIds, setSelectedCardIds] = useState<number[]>([]);
  const [selectedOutlineCardIds, setSelectedOutlineCardIds] = useState<number[]>([]);
  const [selectedOutlineIds, setSelectedOutlineIds] = useState<number[]>([]);
  const [selectedAgentSkillNames, setSelectedAgentSkillNames] = useState<string[]>([]);
  const [showAgentSkillPicker, setShowAgentSkillPicker] = useState(false);
  const [showChapterOutlinePicker, setShowChapterOutlinePicker] = useState(false);
  const [showChapterCardPicker, setShowChapterCardPicker] = useState(false);
  const [cardTypeFilter, setCardTypeFilter] = useState<CardType | '全部'>('全部');
  const [cardDraft, setCardDraft] = useState<{ type: CardType; title: string; content: string }>({ type: '角色卡', title: '', content: '' });
  const [cardGenerating, setCardGenerating] = useState(false);
  // One state object so a first-run install cannot generate two different
  // profile IDs for the list and for the active pointer.
  const [profileState, setProfileState] = useState(loadAgentProfiles);
  const agentProfiles = profileState.profiles;
  const activeProfileId = profileState.activeId;
  const [agentConfig, setAgentConfig] = useState<AgentConfig>(() => {
    const active = profileState.profiles.find(profile => profile.id === profileState.activeId);
    return normalizeAgentConfig(active ?? {});
  });
  useEffect(() => {
    localStorage.setItem(profilesStorageKey, JSON.stringify(agentProfiles));
    localStorage.setItem(activeProfileStorageKey, activeProfileId);
  }, [agentProfiles, activeProfileId]);

  useEffect(() => {
    if (activeTab !== 'rankings' || rankingPlatform !== 'fanqie' || Object.values(fanqieCategories).some(items => items.length)) return;
    if (!('__TAURI_INTERNALS__' in window)) return;
    setFanqieCategoriesLoading(true);
    void agentRpc<{ sections?: Array<{ key: FanqieSection; categories?: RankingCategoryOption[] }> }>('ranking.categories', { ...agentNetworkParams(agentConfig) })
      .then(result => {
        const next = { 'male-read': [], 'male-new': [], 'female-read': [], 'female-new': [] } as Record<FanqieSection, RankingCategoryOption[]>;
        (result.sections || []).forEach(section => { if (section.key in next) next[section.key as FanqieSection] = Array.isArray(section.categories) ? section.categories : []; });
        setFanqieCategories(next);
        setFanqieCategoryId('all');
      })
      .catch(error => setNotice({ title: '番茄榜单分类加载失败', content: String(error) }))
      .finally(() => setFanqieCategoriesLoading(false));
  }, [activeTab, rankingPlatform, fanqieCategories, agentConfig]);

  const [agentInstruction, setAgentInstruction] = useState('根据当前章节上下文继续创作，保持人物设定和时间线一致，并在结尾留下自然的悬念。');
  const [outlineAgentInstruction, setOutlineAgentInstruction] = useState('根据作品设定和当前大纲内容补全结构，明确章节目标、冲突推进、人物动机和结尾钩子。');
  const [cardAgentInstruction, setCardAgentInstruction] = useState('根据作品设定、当前章节和已有卡片，补全这张知识卡的详细信息，保持设定一致。');
  const [outlineGenerating, setOutlineGenerating] = useState(false);
  const [agentStage, setAgentStage] = useState<AgentStage>('idle');
  const [agentDraft, setAgentDraft] = useState<AgentDraftResult | null>(null);
  const [agentDisplayContent, setAgentDisplayContent] = useState('');
  /** 草稿的章节标题：接受前可改，标题不能只靠模型写得对 */
  const [agentDraftTitle, setAgentDraftTitle] = useState('');
  const [outlineChatMessages, setOutlineChatMessages] = useState<AgentChatMessage[]>([]);
  const [cardChatMessages, setCardChatMessages] = useState<AgentChatMessage[]>([]);
  const [showProjectAgent, setShowProjectAgent] = useState(false);
  const [projectAgentSession, setProjectAgentSession] = useState<ProjectAgentSession | null>(null);
  const projectAgentSessionRef = useRef<ProjectAgentSession | null>(null);
  useEffect(() => { projectAgentSessionRef.current = projectAgentSession; }, [projectAgentSession]);
  const [projectAgentInput, setProjectAgentInput] = useState('');
  const [projectAgentRunning, setProjectAgentRunning] = useState(false);
  const [projectAgentProgress, setProjectAgentProgress] = useState(0);
  const [projectAgentActivity, setProjectAgentActivity] = useState<Array<{ id: string; message: string; status: 'active' | 'complete' | 'error' }>>([]);
  const projectAgentRunRef = useRef('');
  // 对话区自动跟随到底；作者主动往上翻看旧消息时不抢滚动条，回到底部后恢复
  const projectAgentPinnedRef = useRef(true);
  const projectAgentMessageCount = projectAgentSession?.messages.length ?? 0;
  const projectAgentChangeCount = projectAgentSession?.changes.length ?? 0;
  useEffect(() => {
    const container = projectAgentMessagesRef.current;
    if (!container || !projectAgentPinnedRef.current) return;
    // 进度条与变更卡片会连续改变高度，用动画帧提交避开布局未完成时的误算
    const frame = window.requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [showProjectAgent, projectAgentMessageCount, projectAgentChangeCount, projectAgentRunning, projectAgentProgress, projectAgentActivity]);
  const [chapterSessionId, setChapterSessionId] = useState(() => `chapter-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const [outlineSessionId, setOutlineSessionId] = useState(() => `outline-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const [cardSessionId, setCardSessionId] = useState(() => `card-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const [chapterPreviousSessionId, setChapterPreviousSessionId] = useState('');
  const [outlinePreviousSessionId, setOutlinePreviousSessionId] = useState('');
  const [cardPreviousSessionId, setCardPreviousSessionId] = useState('');
  const newAgentSessionId = (kind: string) => `${kind}-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [outlineStreamContent, setOutlineStreamContent] = useState('');
  const [outlineAgentActivity, setOutlineAgentActivity] = useState<Array<{ id: string; step: string; message: string; status: 'active' | 'complete' | 'error'; source?: string }>>([]);
  const [cardStreamContent, setCardStreamContent] = useState('');
  const outlineRunRef = useRef('');
  const cardRunRef = useRef('');
  const outlineStreamRawRef = useRef('');
  const cardStreamRawRef = useRef('');
  const secondaryStreamFrameRef = useRef<number | null>(null);
  const agentTypewriterRef = useRef<number | null>(null);
  const agentStreamRawContentRef = useRef('');
  const agentStreamFrameRef = useRef<number | null>(null);
  const [agentError, setAgentError] = useState('');
  const [agentProgress, setAgentProgress] = useState<AgentProgressItem[]>([]);
  const [agentProgressPercent, setAgentProgressPercent] = useState(0);
  const [agentProgressMessage, setAgentProgressMessage] = useState('');
  const [contextTrace, setContextTrace] = useState<ContextTraceEvent[]>([]);
  const [runtimeUsage, setRuntimeUsage] = useState<RuntimeUsageSummary>(() => {
    try { return JSON.parse(localStorage.getItem('writer-runtime-usage') || '') as RuntimeUsageSummary; } catch { return { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, requests: 0, startedAt: new Date().toISOString() }; }
  });
  const [usageDays, setUsageDays] = useState<UsageDay[]>(() => { try { const value = JSON.parse(localStorage.getItem('writer-runtime-usage-days') || '[]'); return Array.isArray(value) ? value : []; } catch { return []; } });
  const [settingsSection, setSettingsSection] = useState<'model' | 'appearance' | 'network' | 'usage' | 'sync' | 'tutorial'>('model');
  const [appearance, setAppearance] = useState<Appearance>(loadAppearance);
  useEffect(() => {
    applyAppearance(appearance);
    localStorage.setItem(appearanceStorageKey, JSON.stringify(appearance));
    // 跟随系统时，用户在系统里切换浅深主题要立刻反映到界面
    if (appearance.themeId !== 'auto') return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => applyAppearance(appearance);
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, [appearance]);
  const [cloudRemotePath, setCloudRemotePath] = useState(() => {
    // 老版本存过两种旧路径；沿用旧目录才能继续看到已经上传的备份
    const saved = localStorage.getItem('cloud-remote-path');
    if (saved === 'ApiSaverWriter/projects') return 'ApiSaverWriter/backup';
    return saved || 'Zhizhang/backup';
  });
  const [cloudSyncRunning, setCloudSyncRunning] = useState(false);
  const [cloudSyncMessage, setCloudSyncMessage] = useState('');
  const [cloudBackupFiles, setCloudBackupFiles] = useState<CloudBackupFile[]>([]);
  const [selectedCloudBackup, setSelectedCloudBackup] = useState<CloudBackupFile | null>(null);
  const [showCloudBackupPicker, setShowCloudBackupPicker] = useState(false);
  const [baiduAuthURL, setBaiduAuthURL] = useState('');
  const [baiduAuthCode, setBaiduAuthCode] = useState('');
  const [githubProjectId, setGithubProjectId] = useState<number | null>(null);
  const [githubRepositoryUrl, setGithubRepositoryUrl] = useState('');
  const [githubRestoreConflict, setGithubRestoreConflict] = useState<GitHubRestoreConflict | null>(null);
  const [usageDateFilter, setUsageDateFilter] = useState('all');
  const [usageStartDate, setUsageStartDate] = useState('');
  const [usageEndDate, setUsageEndDate] = useState('');
  const [gatewayUsage, setGatewayUsage] = useState<GatewayUsageSnapshot | null>(null);
  const [gatewayUsageLoading, setGatewayUsageLoading] = useState(false);
  const [gatewayUsageError, setGatewayUsageError] = useState('');
  const activeAgentRunRef = useRef('');
  const runtimeUsageSessionRef = useRef<RuntimeUsageSummary | null>(null);
  const runtimeUsageInFlightRef = useRef(false);
  const syncRuntimeUsage = async () => {
    // Runtime 一次只能处理一个 RPC：长任务进行中时用量轮询会堆积排队，必须跳过
    if (runtimeUsageInFlightRef.current) return;
    runtimeUsageInFlightRef.current = true;
    try {
      const latest = await agentRpc<RuntimeUsageSummary>('usage.summary', {});
      const prior = runtimeUsageSessionRef.current;
      runtimeUsageSessionRef.current = latest;
      if (!prior) return;
      const delta = {
        inputTokens: Math.max(0, latest.inputTokens - prior.inputTokens), outputTokens: Math.max(0, latest.outputTokens - prior.outputTokens),
        totalTokens: Math.max(0, latest.totalTokens - prior.totalTokens), cachedInputTokens: Math.max(0, latest.cachedInputTokens - prior.cachedInputTokens),
        cacheWriteTokens: Math.max(0, latest.cacheWriteTokens - prior.cacheWriteTokens), reasoningTokens: Math.max(0, latest.reasoningTokens - prior.reasoningTokens),
        requests: Math.max(0, latest.requests - prior.requests),
      };
      if (!delta.requests) return;
      setRuntimeUsage(current => {
        const next = { ...current, inputTokens: current.inputTokens + delta.inputTokens, outputTokens: current.outputTokens + delta.outputTokens, totalTokens: current.totalTokens + delta.totalTokens, cachedInputTokens: current.cachedInputTokens + delta.cachedInputTokens, cacheWriteTokens: current.cacheWriteTokens + delta.cacheWriteTokens, reasoningTokens: current.reasoningTokens + delta.reasoningTokens, requests: current.requests + delta.requests };
        localStorage.setItem('writer-runtime-usage', JSON.stringify(next));
        const now = new Date();
        const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        setUsageDays(days => {
          const existing = days.find(day => day.date === date);
          const updated = existing ? days.map(day => day.date === date ? { ...day, inputTokens: day.inputTokens + delta.inputTokens, outputTokens: day.outputTokens + delta.outputTokens, totalTokens: day.totalTokens + delta.totalTokens, cachedInputTokens: day.cachedInputTokens + delta.cachedInputTokens, cacheWriteTokens: day.cacheWriteTokens + delta.cacheWriteTokens, reasoningTokens: day.reasoningTokens + delta.reasoningTokens, requests: day.requests + delta.requests } : day) : [...days, { ...delta, date, startedAt: new Date().toISOString() }];
          localStorage.setItem('writer-runtime-usage-days', JSON.stringify(updated));
          return updated;
        });
        return next;
      });
    } catch { /* Runtime may not have started yet. */ } finally {
      runtimeUsageInFlightRef.current = false;
    }
  };
  useEffect(() => { void invoke<string>('start_agent_runtime').then(() => syncRuntimeUsage()); }, []);
  useEffect(() => {
    const timer = window.setInterval(() => { void syncRuntimeUsage(); }, 5000);
    return () => window.clearInterval(timer);
  }, []);
  const refreshGatewayUsage = async () => {
    if (!supportsGatewayUsage(settingsDraft)) {
      setGatewayUsage(null);
      setGatewayUsageError('请先填写 OpenAI 兼容接口地址，再查询中转站用量。');
      return;
    }
    const key = settingsDraft.apiKey.trim() || agentConfig.apiKey.trim();
    if (!key) {
      setGatewayUsageError('请先在 AI 模型配置中填写并保存 API Key。');
      return;
    }
    setGatewayUsageLoading(true);
    setGatewayUsageError('');
    try {
      const result = await agentRpc<GatewayUsageSnapshot>('gateway.usage', {
          apiKey: key,
          ...agentNetworkParams(settingsDraft),
        });
      setGatewayUsage(result);
    } catch (error) {
      setGatewayUsageError(String(error));
    } finally {
      setGatewayUsageLoading(false);
    }
  };
  const [chapterSaving, setChapterSaving] = useState(false);
  const [autoSaveStatus, setAutoSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [showSearchPanel, setShowSearchPanel] = useState(false);
  const [searchScope, setSearchScope] = useState<'chapter' | 'book'>('chapter');
  const [searchQuery, setSearchQuery] = useState('');
  const [replaceQuery, setReplaceQuery] = useState('');
  const [searchMatchIndex, setSearchMatchIndex] = useState(0);
  const [bookSearchMatchIndex, setBookSearchMatchIndex] = useState(0);
  const [showBannedWords, setShowBannedWords] = useState(false);
  const [bannedWords, setBannedWords] = useState<string[]>(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem('writer-banned-words') || '[]');
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map(item => item.trim()) : [];
    } catch { return []; }
  });
  const [bannedWordsDraft, setBannedWordsDraft] = useState('');
  const [writingMarksEnabled, setWritingMarksEnabled] = useState(true);
  const [chapterTargetWordsDraft, setChapterTargetWordsDraft] = useState('3000');
  const [aiToolMode, setAIToolMode] = useState<'polish' | 'de-ai' | 'continue' | null>(null);
  const [aiToolInstruction, setAIToolInstruction] = useState('');
  const [aiToolRunning, setAIToolRunning] = useState(false);
  const [aiToolResult, setAIToolResult] = useState<AIToolResult | null>(null);
  const [selectionSnapshot, setSelectionSnapshot] = useState<{ start: number; end: number; source: string } | null>(null);
  const [chapterJumpQuery, setChapterJumpQuery] = useState('');
  // 导出、历史版本、回收站、写作统计、阅读模式与快捷键面板
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportScope, setExportScope] = useState<'book' | 'chapter'>('book');
  const [exportOptions, setExportOptions] = useState<ExportOptions>(defaultExportOptions);
  const [exportRunning, setExportRunning] = useState(false);
  const [showChapterHistory, setShowChapterHistory] = useState(false);
  const [showRecycleBin, setShowRecycleBin] = useState(false);
  const [showWritingStats, setShowWritingStats] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [readingMode, setReadingMode] = useState(false);
  const [draggingChapterId, setDraggingChapterId] = useState<number | null>(null);
  // 编辑器侧栏宽度与标签区高度：拖动手柄调整，松手写回 localStorage
  // 所有可拖动分栏的尺寸集中在这里，见 features/editor/panes.ts
  const panes = usePaneSizes();
  const [localBackups, setLocalBackups] = useState<{ directory: string; files: Array<{ name: string; size: number; modifiedAt: number }> }>({ directory: '', files: [] });
  const [showLocalBackupPicker, setShowLocalBackupPicker] = useState(false);
  const projectAgentMessagesRef = useRef<HTMLDivElement | null>(null);
  const chaptersListRef = useRef<HTMLDivElement | null>(null);
  const sidebarTabsRef = useRef<HTMLDivElement | null>(null);
  const chapterEditorRef = useRef<HTMLTextAreaElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const highlightLayerRef = useRef<HTMLDivElement | null>(null);
  const readingArticleRef = useRef<HTMLElement | null>(null);
  const goalNoticeChapterRef = useRef<number | null>(null);
  const persistCurrentChapterRef = useRef<() => Promise<void>>(async () => {});
  /**
   * 切章时把编辑器、高亮层和阅读视图的滚动位置归零，并把光标放回开头
   * 这几个 DOM 节点在切章时是复用的（React 只换 value 不换节点），不归零的话滚动位置会留在上一章读到的地方；
   * 只在章节 id 变化时执行：打字、自动保存、Agent 改稿都会替换章节对象但不改 id，不能把正在读的位置拉回开头
   */
  useLayoutEffect(() => {
    if (!activeChapter) return;
    const editor = chapterEditorRef.current;
    if (editor) {
      editor.setSelectionRange(0, 0);
      editor.scrollTop = 0;
    }
    if (highlightLayerRef.current) highlightLayerRef.current.scrollTop = 0;
    if (readingArticleRef.current) readingArticleRef.current.scrollTop = 0;
  }, [activeChapter?.id]);
  /**
   * 目录跟随当前章：当前章滚到列表可见区域
   * 新建/插入/Alt 切章/项目 Agent 产出都会改 activeChapter，与其在每个入口补 scrollIntoView，不如统一在这里跟随；
   * 已在视野内的不再动它，免得点目录时列表抖动
   */
  useLayoutEffect(() => {
    if (!activeChapter || editorSidebarTab !== 'chapters') return;
    const list = chaptersListRef.current;
    const item = list?.querySelector<HTMLElement>(`[data-chapter-id="${activeChapter.id}"]`);
    if (!list || !item) return;
    const listRect = list.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    // 留出列表内边距的余量，避免“刚好在边缘”时抖来抖去
    if (itemRect.top < listRect.top + 8 || itemRect.bottom > listRect.bottom - 8) {
      list.scrollTop = item.offsetTop - list.offsetTop - Math.max(0, (list.clientHeight - item.offsetHeight) / 2);
    }
  }, [activeChapter?.id, editorSidebarTab, editingProject?.chapters.length]);
  const [settingsDraft, setSettingsDraft] = useState(agentConfig);
  const refreshGatewayUsageRef = useRef(refreshGatewayUsage);
  refreshGatewayUsageRef.current = refreshGatewayUsage;
  const gatewayUsageRequestRef = useRef('');
  const gatewayUsageRequestKey = showSettingsModal && settingsSection === 'usage' && supportsGatewayUsage(settingsDraft)
    ? `${settingsDraft.apiMode}:${settingsDraft.baseURL}:${settingsDraft.apiKey}`
    : '';
  useEffect(() => {
    if (!gatewayUsageRequestKey) {
      gatewayUsageRequestRef.current = '';
      return;
    }
    if (gatewayUsageRequestRef.current === gatewayUsageRequestKey) return;
    gatewayUsageRequestRef.current = gatewayUsageRequestKey;
    void refreshGatewayUsageRef.current();
  }, [gatewayUsageRequestKey]);
  const [availableModels, setAvailableModels] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('agent-models');
      const parsed = saved ? JSON.parse(saved) : [];
      return Array.isArray(parsed) && parsed.length > 0 ? parsed.filter((model): model is string => typeof model === 'string') : fallbackModels;
    } catch {
      return fallbackModels;
    }
  });
  const [settingsModels, setSettingsModels] = useState<string[]>(availableModels);
  const [fetchedModels, setFetchedModels] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('agent-fetched-models');
      const parsed = saved ? JSON.parse(saved) : [];
      return Array.isArray(parsed) ? parsed.filter((model): model is string => typeof model === 'string') : [];
    } catch {
      return [];
    }
  });
  const [customModelName, setCustomModelName] = useState('');
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsTesting, setModelsTesting] = useState(false);
  const [modelListMessage, setModelListMessage] = useState('');
  const [settingsDiagnostics, setSettingsDiagnostics] = useState<DiagnosticReport | null>(null);
  const [diagnosticsRunning, setDiagnosticsRunning] = useState(false);
  const [showProfilePresets, setShowProfilePresets] = useState(false);
  const [settingsServiceExpanded, setSettingsServiceExpanded] = useState(true);
  
  // 表单数据
  const [newProject, setNewProject] = useState({
    title: '',
    channel: '男频' as Channel,
    selectedTags: defaultProjectTags(),
    cover: '',
    protagonist1: '',
    protagonist2: '',
    synopsis: '',
  });
  const [projectGenerationSource, setProjectGenerationSource] = useState<'outline' | 'chapters'>('outline');
  const [projectGeneratingField, setProjectGeneratingField] = useState<'title' | 'synopsis' | null>(null);
  const [newSkill, setNewSkill] = useState({
    name: '',
    category: 'write',
    description: '',
    content: '',
    tags: '',
  });
  const [skillGenerating, setSkillGenerating] = useState(false);

  const scheduleSecondaryStreamFlush = () => {
    if (secondaryStreamFrameRef.current !== null) return;
    secondaryStreamFrameRef.current = window.requestAnimationFrame(() => {
      secondaryStreamFrameRef.current = null;
      setOutlineStreamContent(outlineStreamRawRef.current);
      setCardStreamContent(cardStreamRawRef.current);
    });
  };

  const handleAgentProgress = (payload: AgentProgressEvent) => {
    if (!payload) return;
    const data = payload.data ?? {};
    if (payload.runId === projectAgentRunRef.current) {
    if (payload.type === 'chunk') return;
    const message = String(data.message || data.context?.action || data.error || '项目 Agent 正在处理');
    if (payload.type === 'error') {
      setProjectAgentActivity(current => [...current.map(item => item.status === 'active' ? { ...item, status: 'complete' as const } : item), { id: `error-${Date.now()}`, message, status: 'error' as const }].slice(-20));
      return;
    }
    if (payload.type === 'complete') {
      setProjectAgentProgress(100);
      setProjectAgentActivity(current => current.map(item => item.status === 'active' ? { ...item, status: 'complete' as const } : item));
      return;
    }
    const progress = Math.max(1, Math.min(99, Number(data.progress) || 1));
    setProjectAgentProgress(current => Math.max(current, progress));
    setProjectAgentActivity(current => {
      const previous = current.map(item => item.status === 'active' ? { ...item, status: 'complete' as const } : item);
      const id = `${String(data.step || data.context?.source || 'step')}:${message}`;
      return [...previous.filter(item => item.id !== id), { id, message, status: 'active' as const }].slice(-20);
    });
    return;
  }
  if (payload.runId === outlineRunRef.current) {
    if (payload.type === 'chunk' && data.text) {
      outlineStreamRawRef.current += String(data.text);
      scheduleSecondaryStreamFlush();
      return;
    }
    if (payload.type === 'progress' || payload.type === 'context' || payload.type === 'complete' || payload.type === 'error') {
      const step = String(data.step || (payload.type === 'complete' ? 'complete' : payload.type === 'error' ? 'error' : 'progress'));
      const message = String(data.message || data.context?.action || data.error || '正在处理大纲任务');
      const source = data.context?.source;
      setOutlineAgentActivity(current => {
        const id = `${step}:${message}`;
        const status: 'active' | 'complete' | 'error' = payload.type === 'error' ? 'error' : payload.type === 'complete' ? 'complete' : 'active';
        const previous = current.map(item => item.status === 'active' ? { ...item, status: 'complete' as const } : item);
        const existing = previous.findIndex(item => item.id === id);
        if (existing >= 0) return previous.map((item, index) => index === existing ? { ...item, status, source: source || item.source } : item).slice(-12);
        return [...previous, { id, step, message, status, source }].slice(-12);
      });
      return;
    }
  }
  if (payload.type === 'chunk' && payload.runId === outlineRunRef.current && data.text) {
    outlineStreamRawRef.current += String(data.text);
    scheduleSecondaryStreamFlush();
    return;
  }
  if (payload.type === 'chunk' && payload.runId === cardRunRef.current && data.text) {
    cardStreamRawRef.current += String(data.text);
    scheduleSecondaryStreamFlush();
    return;
  }
  if (payload.runId !== activeAgentRunRef.current) return;
  if (payload.type === 'context' && data.context) {
    const trace = {
      id: `${String(data.step || 'context')}:${String(data.context.source || data.context.action)}`,
      step: String(data.step || 'context'),
      action: data.context?.action || data.message || '更新上下文',
      source: data.context?.source,
      status: data.context?.status,
      bytes: data.context?.bytes,
      items: data.context?.items,
      timestamp: Date.now(),
    };
    setContextTrace(current => {
      const existing = current.findIndex(item => item.id === trace.id);
      if (existing < 0) return [...current, trace].slice(-40);
      return current.map((item, index) => index === existing ? { ...item, ...trace } : item);
    });
    return;
  }
  if (payload.type === 'chunk' && data.text) {
    agentStreamRawContentRef.current += String(data.text);
    // SSE 可能按 token 高频触发；每帧最多提交一次 React 状态，降低临时字符串和提交次数
    if (agentStreamFrameRef.current === null) {
      agentStreamFrameRef.current = window.requestAnimationFrame(() => {
        agentStreamFrameRef.current = null;
        const rawContent = agentStreamRawContentRef.current;
        setAgentDisplayContent(chapterDraftFromStream(rawContent));
        const characters = countNovelCharacters(rawContent);
        setAgentProgressMessage(characters ? `正文已返回 ${characters.toLocaleString()} 字，正在整理草稿` : '正在接收模型输出');
        setAgentProgress(items => items.map(item => item.id === 'draft'
          ? { ...item, status: 'active', progress: Math.max(item.progress, 70), message: '正在接收并整理章节草稿' }
          : item));
        setAgentProgressPercent(current => Math.max(current, 70));
      });
    }
    return;
  }
  if (payload.type === 'complete') {
    setAgentProgressMessage(data.message || '章节草稿和一致性审查已完成');
    setAgentProgressPercent(100);
    setAgentProgress(items => items.map(item => ({ ...item, status: 'complete', progress: Math.max(item.progress, 100) })));
    return;
  }
  if (payload.type === 'error') {
    const message = data.error || '智能体运行失败';
    setAgentProgressMessage(message);
    setAgentProgress(items => {
      const activeIndex = Math.max(0, items.findIndex(item => item.status === 'active'));
      return items.map((item, index) => index === activeIndex ? { ...item, status: 'error', message } : item);
    });
    return;
  }
  if (!isAgentWorkflowStep(data.step)) return;
  const stepIndex = agentWorkflowSteps.findIndex(step => step.id === data.step);
  const progress = Math.max(0, Math.min(100, Number(data.progress) || 0));
  setAgentStage(data.step);
  setAgentProgressMessage(data.message || agentStageLabel[data.step]);
  setAgentProgressPercent(current => Math.max(current, progress));
  setAgentProgress(items => {
    const source = items.length ? items : createAgentProgressItems();
    return source.map((item, index) => {
      if (index < stepIndex) return { ...item, status: 'complete', progress: Math.max(item.progress, 100) };
      if (item.id === data.step) return { ...item, status: 'active', progress: Math.max(item.progress, progress), message: data.message || item.description };
      return item;
    });
  });
  };

  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<AgentProgressEvent>('agent-progress', event => handleAgentProgress(event.payload)).then(handler => {
      if (disposed) handler();
      else unlisten = handler;
    });
    return () => {
      disposed = true;
      unlisten?.();
      if (agentStreamFrameRef.current !== null) {
        window.cancelAnimationFrame(agentStreamFrameRef.current);
        agentStreamFrameRef.current = null;
      }
      if (secondaryStreamFrameRef.current !== null) {
        window.cancelAnimationFrame(secondaryStreamFrameRef.current);
        secondaryStreamFrameRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!isMobileRuntime()) return;
    const receive = (event: Event) => {
      const message = (event as CustomEvent<{ message?: string }>).detail?.message;
      if (message) setCloudSyncMessage(message);
    };
    window.addEventListener('cloud-sync-progress', receive);
    return () => window.removeEventListener('cloud-sync-progress', receive);
  }, []);

  // 移动端通过 DOM 事件接收同一套进度协议，复用桌面端处理器避免行为漂移
  useEffect(() => {
    if (!isMobileRuntime()) return;
    const receive = (event: Event) => handleAgentProgress((event as CustomEvent<AgentProgressEvent>).detail);
    window.addEventListener('agent-progress', receive);
    return () => {
      window.removeEventListener('agent-progress', receive);
      if (agentStreamFrameRef.current !== null) {
        window.cancelAnimationFrame(agentStreamFrameRef.current);
        agentStreamFrameRef.current = null;
      }
      if (secondaryStreamFrameRef.current !== null) {
        window.cancelAnimationFrame(secondaryStreamFrameRef.current);
        secondaryStreamFrameRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ message?: string }>('cloud-sync-progress', event => {
      if (!disposed && event.payload?.message) setCloudSyncMessage(event.payload.message);
    }).then(handler => {
      if (disposed) handler();
      else unlisten = handler;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // 拆书和文风是跨作品复用的本地资源，独立于单本小说目录保存。
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) {
      setResourceStorageReady(true);
      return;
    }
    Promise.all([
      nativeClient.loadLibraryBooks<LibraryBook>(),
      nativeClient.loadRankingBooks<RankingBook>(),
      nativeClient.loadDismantleBooks<DismantleBook>(),
      nativeClient.loadWritingStyles<WritingStyle>(),
    ]).then(([library, rankings, books, styles]) => {
      if (Array.isArray(library)) setLibraryBooks(library.map(book => normalizeLibraryBook(book)));
      if (Array.isArray(rankings)) setRankingBooks(rankings.map((book, index) => normalizeRankingBook(book, index)).filter(trustedRankingCache));
      if (Array.isArray(books)) setDismantleBooks(books.map(book => normalizeDismantleBook(book)));
      if (Array.isArray(styles)) setWritingStyles(styles.map(style => normalizeWritingStyle(style)));
    }).catch(error => {
      setNotice({ title: '读取本地书籍资源失败', content: String(error) });
    }).finally(() => setResourceStorageReady(true));
  }, []);

  // 应用启动时预热常驻 Agent Runtime，后续智能体请求复用同一进程。
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    void invoke<string>('start_agent_runtime')
      .catch(error => {
        console.warn('Agent Runtime 或小说书源初始化失败，将在首次请求时重试。', error);
      });
  }, []);

  // App 启动时优先读取设备应用数据目录中的 projects.json。
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) {
      setDeviceStorageReady(true);
      return;
    }

    nativeClient.loadProjects<Project>()
      .then(savedProjects => {
        if (Array.isArray(savedProjects)) {
          setProjects(savedProjects.map(project => {
            const chapters = Array.isArray(project.chapters) ? project.chapters.map(chapter => ({
              ...chapter,
              wordCount: countNovelCharacters(chapter.content ?? ''),
              createdAt: chapter.createdAt ?? new Date().toISOString(),
              updatedAt: chapter.updatedAt ?? new Date().toISOString(),
            })) : [];
            return {
              ...project,
              status: project.status === 'completed' ? 'completed' : 'writing',
              chapters,
              outline: Array.isArray(project.outline) ? project.outline : [],
              outlines: Array.isArray(project.outlines) ? project.outlines : [],
              cards: Array.isArray(project.cards) ? project.cards : [],
              memories: Array.isArray(project.memories) ? project.memories.map(memory => normalizeChapterMemory(memory)) : [],
              graphNodes: Array.isArray(project.graphNodes) ? project.graphNodes : [],
              graphEdges: normalizeKnowledgeGraphEdges(project.graphEdges),
              chapterTargetWords: Number(project.chapterTargetWords) > 0 ? Number(project.chapterTargetWords) : 3000,
              aiDetection: project.aiDetection,
              styleProfileId: typeof project.styleProfileId === 'string' ? project.styleProfileId : undefined,
              sourceDismantleBookId: typeof project.sourceDismantleBookId === 'string' ? project.sourceDismantleBookId : undefined,
              memoryDocuments: hydrateMemoryDocuments(project.memoryDocuments, Array.isArray(project.memories) ? project.memories.map(memory => normalizeChapterMemory(memory)) : []),
              wordCount: chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0),
              createdAt: project.createdAt ?? project.updatedAt ?? new Date().toISOString(),
              updatedAt: project.updatedAt ?? new Date().toISOString(),
            };
          }));
        }
      })
      .catch(error => {
        setNotice({ title: '读取本地小说失败', content: String(error) });
      })
      .finally(() => setDeviceStorageReady(true));
  }, []);

  // 编辑时做短暂防抖，随后原子写入设备本地文件；网页调试环境保留 localStorage 回退。
  useEffect(() => {
    if (!deviceStorageReady) return;
    const timer = window.setTimeout(() => {
      setAutoSaveStatus('saving');
      if ('__TAURI_INTERNALS__' in window) {
        nativeClient.saveProjects(projects)
          .then(() => { localStorage.removeItem('projects'); setAutoSaveStatus('saved'); })
          .catch(error => { setAutoSaveStatus('error'); setNotice({ title: '保存本地小说失败', content: String(error) }); });
      } else {
        localStorage.setItem('projects', JSON.stringify(projects));
        setAutoSaveStatus('saved');
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [projects, deviceStorageReady]);

  useEffect(() => {
    const project = editingProjectRef.current;
    if (!project) {
      setProjectAgentSession(null);
      setShowProjectAgent(false);
      return;
    }
    let disposed = false;
    const storageKey = `project-agent-current-session:${project.id}`;
    const storedId = localStorage.getItem(storageKey) || '';
    const sessionId = /^project-agent-[a-z0-9_-]+$/iu.test(storedId) ? storedId : projectAgentSessionId();
    localStorage.setItem(storageKey, sessionId);
    setProjectAgentSession(null);
    const load = '__TAURI_INTERNALS__' in window
      ? nativeClient.invoke<ProjectAgentSession | null>('load_agent_chat', { projectId: String(project.id), sessionId })
      : Promise.resolve((() => { try { return JSON.parse(localStorage.getItem(`project-agent-chat:${project.id}:${sessionId}`) || 'null') as ProjectAgentSession | null; } catch { return null; } })());
    void load.then(value => {
      if (!disposed) setProjectAgentSession(normalizeProjectAgentSession(value, editingProjectRef.current?.id === project.id ? editingProjectRef.current : project, sessionId));
    }).catch(error => {
      console.warn('读取项目 Agent 会话失败', error);
      if (!disposed) setProjectAgentSession(createProjectAgentSession(project.id, sessionId));
    });
    return () => { disposed = true; };
  }, [editingProject?.id]);

  useEffect(() => {
    if (!projectAgentSession) return;
    const timer = window.setTimeout(() => {
      const session = { ...projectAgentSession, updatedAt: new Date().toISOString() };
      if ('__TAURI_INTERNALS__' in window) {
        void nativeClient.invoke<string>('save_agent_chat', { projectId: String(session.projectId), sessionId: session.sessionId, session })
          .catch(error => console.warn('保存项目 Agent 会话失败', error));
      } else {
        try { localStorage.setItem(`project-agent-chat:${session.projectId}:${session.sessionId}`, JSON.stringify(session)); }
        catch (error) { console.warn('保存项目 Agent 会话失败', error); }
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [projectAgentSession]);

  useEffect(() => {
    if (!resourceStorageReady) return;
    const timer = window.setTimeout(() => {
      if ('__TAURI_INTERNALS__' in window) {
        Promise.all([
          nativeClient.saveLibraryBooks(libraryBooks),
          nativeClient.saveRankingBooks(rankingBooks),
          nativeClient.saveDismantleBooks(dismantleBooks),
        ]).then(() => {
          localStorage.removeItem('writer-library-books');
          localStorage.removeItem('writer-ranking-books');
          localStorage.removeItem('writer-dismantle-books');
        }).catch(error => setNotice({ title: '保存本地书籍资源失败', content: String(error) }));
      } else {
        localStorage.setItem('writer-library-books', JSON.stringify(libraryBooks));
        localStorage.setItem('writer-ranking-books', JSON.stringify(rankingBooks));
        localStorage.setItem('writer-dismantle-books', JSON.stringify(dismantleBooks));
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [libraryBooks, rankingBooks, dismantleBooks, resourceStorageReady]);

  useEffect(() => {
    if (!resourceStorageReady) return;
    const timer = window.setTimeout(() => {
      if ('__TAURI_INTERNALS__' in window) {
        void nativeClient.saveWritingStyles(writingStyles)
          .then(() => localStorage.removeItem('writer-writing-styles'))
          .catch(error => setNotice({ title: '保存文风失败', content: String(error) }));
      } else {
        localStorage.setItem('writer-writing-styles', JSON.stringify(writingStyles));
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [writingStyles, resourceStorageReady]);

  // 番茄以私有区字符保护部分网页内容。榜单与已下载书籍均保存相应字体，正常中文仍走系统字体。
  useEffect(() => {
    const id = 'fanqie-private-font';
    const existing = document.getElementById(id) as HTMLStyleElement | null;
    const defaultFont = '@font-face{font-family:ZhizhangFanqie;font-display:swap;src:url(https://lf6-awef.bytetos.com/obj/awesome-font/c/dc027189e0ba4cd.woff2) format("woff2");unicode-range:U+E000-F8FF;}';
    const fontCss = [defaultFont, rankingFontCss, ...libraryBooks.map(book => book.fontCss || '')].filter(Boolean).join('\n');
    if (!fontCss.trim()) {
      existing?.remove();
      return;
    }
    const style = existing || document.createElement('style');
    style.id = id;
    style.textContent = fontCss;
    if (!existing) document.head.appendChild(style);
  }, [rankingFontCss, libraryBooks]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Esc 退出阅读模式，不需要修饰键
      if (event.key === 'Escape' && readingMode) {
        setReadingMode(false);
        return;
      }
      if (!editingProject) return;
      const modifier = event.metaKey || event.ctrlKey;
      // Alt + 上/下切章，不占用浏览器修饰键组合
      if (event.altKey && !modifier && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        const index = editingProject.chapters.findIndex(chapter => chapter.id === activeChapter?.id);
        const next = editingProject.chapters[index + (event.key === 'ArrowDown' ? 1 : -1)];
        if (next) {
          event.preventDefault();
          setActiveChapter(next);
        }
        return;
      }
      if (!modifier) return;
      const key = event.key.toLowerCase();
      if (key === 's') {
        event.preventDefault();
        void persistCurrentChapterRef.current();
      } else if (key === 'f') {
        event.preventDefault();
        if (editorSidebarTab === 'search') {
          setSearchScope('book');
          setShowSearchPanel(false);
        } else {
          setShowSearchPanel(true);
          setSearchScope('chapter');
        }
        window.setTimeout(() => searchInputRef.current?.focus(), 0);
      } else if (key === 'e') {
        event.preventDefault();
        setShowExportModal(true);
      } else if (key === 'h') {
        event.preventDefault();
        setShowChapterHistory(true);
      } else if (key === 'j') {
        event.preventDefault();
        setShowWritingStats(true);
      } else if (key === 'p') {
        event.preventDefault();
        setReadingMode(current => !current);
      } else if (event.key === '/') {
        event.preventDefault();
        setShowShortcuts(current => !current);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [editingProject, activeChapter, chapterSaving, editorSidebarTab, readingMode]);

  useEffect(() => {
    void loadSkills();
  }, [activeTab, editingProject?.id]);

  useEffect(() => {
    localStorage.setItem('agent-config', JSON.stringify(agentConfig));
  }, [agentConfig]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 7000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const loadSkills = async () => {
    try {
      const saved = localStorage.getItem('writer-skills');
      const stored = saved ? JSON.parse(saved) : [];
      const records = Array.isArray(stored) ? stored.filter((skill): skill is Skill => Boolean(skill && typeof skill.name === 'string')) : [];
      const builtinOverrides = records.filter(skill => skill.builtin).map(skill => ({
        ...skill,
        builtin: true,
        content: typeof skill.content === 'string' ? skill.content : '',
        tags: Array.isArray(skill.tags) ? skill.tags : [],
        rating: Number(skill.rating) || 0,
        usageCount: Number(skill.usageCount) || 0,
      }));
      const customSkills = records.filter(skill => !skill.builtin).map(skill => ({
        ...skill,
        content: typeof skill.content === 'string' ? skill.content : '',
        tags: Array.isArray(skill.tags) ? skill.tags : [],
        rating: Number(skill.rating) || 0,
        usageCount: Number(skill.usageCount) || 0,
      }));
      const mergedBuiltins = builtinSkills.map(skill => {
        const override = builtinOverrides.find(item => String(item.id) === String(skill.id));
        // Built-in routing IDs remain stable, while the canonical Chinese
        // display name always comes from the bundled definition. This also
        // repairs older localStorage records that stored English labels.
        if (!override) return skill;
        const isLegacyWorldSetting = skill.name === 'world-setting-planner'
          && /标记已确认与待揭示内容/u.test(String(override.content || ''));
        const isLegacyChapterOutline = skill.name === '小说章纲生成器'
          && (!/#\s*番茄小说章纲生成器 Skill/u.test(String(override.content || ''))
            || /(?:800\s*[-~到至]\s*1000|章纲总字数控制)/u.test(String(override.content || '')));
        return isLegacyWorldSetting || isLegacyChapterOutline
          ? { ...skill, builtin: true }
          : { ...skill, ...override, displayName: skill.displayName, builtin: true };
      });
      setSkills([...mergedBuiltins, ...customSkills]);
    } finally {
    }
  };

  const handleCreateProject = () => {
    if (!newProject.title.trim()) {
      alert('请输入小说标题');
      return;
    }
    
    const now = new Date().toISOString();
    const existingProject = projectEditingId === null ? undefined : projects.find(project => project.id === projectEditingId);
    if (existingProject) {
      const updatedProject: Project = {
        ...existingProject,
        title: newProject.title.trim(),
        genre: newProject.channel,
        subgenre: newProject.selectedTags.主分类[0] ?? existingProject.subgenre,
        tags: cloneProjectTags(newProject.selectedTags),
        cover: newProject.cover || undefined,
        protagonist1: newProject.protagonist1.trim(),
        protagonist2: newProject.protagonist2.trim(),
        synopsis: newProject.synopsis.trim(),
        updatedAt: now,
      };
      setProjects(current => current.map(project => project.id === updatedProject.id ? updatedProject : project));
      if (editingProject?.id === updatedProject.id) setEditingProject(updatedProject);
      resetProjectForm();
      setShowNewProjectModal(false);
      setNotice({ title: '小说信息已更新', content: `《${updatedProject.title}》的基础信息已保存。` });
      return;
    }

    const sourceChapter = imitationSource?.chapterId
      ? dismantleBooks.find(book => book.id === imitationSource.bookId)?.chapters.find(chapter => chapter.id === imitationSource.chapterId)
      : undefined;
    const sourceOutline = sourceChapter?.detailedOutline.trim()
      ? [{ id: Date.now() + 1, kind: '章纲' as OutlineKind, title: `参考章纲｜${sourceChapter.title}`, content: sourceChapter.detailedOutline, createdAt: now, updatedAt: now }]
      : [];
    const project: Project = {
      id: Date.now(),
      title: newProject.title.trim(),
      genre: newProject.channel,
      subgenre: newProject.selectedTags.主分类[0],
      tags: cloneProjectTags(newProject.selectedTags),
      cover: newProject.cover || undefined,
      protagonist1: newProject.protagonist1.trim(),
      protagonist2: newProject.protagonist2.trim(),
      synopsis: newProject.synopsis.trim(),
      status: 'writing',
      wordCount: 0,
      chapters: [],
      outline: [],
      outlines: sourceOutline,
      cards: [],
      memories: [],
      memoryDocuments: [],
      graphNodes: [],
      graphEdges: [],
      chapterTargetWords: 3000,
      sourceDismantleBookId: imitationSource?.bookId,
      createdAt: now,
      updatedAt: now,
    };
    
    setProjects(current => [...current, project]);
    if (imitationSource) {
      setDismantleBooks(current => current.map(book => book.id === imitationSource.bookId
        ? { ...book, boundProjectId: project.id, updatedAt: now }
        : book));
      setNotice({ title: '仿写项目已创建', content: sourceChapter?.detailedOutline ? '已绑定拆书资料并将当前细纲带入小说大纲。' : '已绑定拆书资料，可在拆书管理中把细纲生成到本书章节。' });
    }
    setImitationSource(null);
    resetProjectForm();
    setShowNewProjectModal(false);
  };

  const resetProjectForm = () => {
    setNewProject({
      title: '',
      channel: '男频' as Channel,
      selectedTags: defaultProjectTags(),
      cover: '',
      protagonist1: '',
      protagonist2: '',
      synopsis: '',
    });
    setProjectGenerationSource('outline');
    setProjectGeneratingField(null);
    setProjectFormMode('create');
    setProjectEditingId(null);
  };

  const openNewProjectModal = () => {
    setImitationSource(null);
    resetProjectForm();
    setShowNewProjectModal(true);
  };

  const openProjectEdit = (project: Project) => {
    const channel: Channel = project.genre === '女频' ? '女频' : '男频';
    const selectedTags: Record<TagTab, string[]> = {
      主分类: [...(project.tags?.主分类?.length ? project.tags.主分类 : [project.subgenre ?? (channel === '男频' ? '东方玄幻' : '女频悬疑')])],
      主题: [...(project.tags?.主题 ?? [])],
      角色: [...(project.tags?.角色 ?? [])],
      情节: [...(project.tags?.情节 ?? [])],
    };
    setProjectFormMode('edit');
    setProjectEditingId(project.id);
    setNewProject({
      title: project.title,
      channel,
      selectedTags,
      cover: project.cover ?? '',
      protagonist1: project.protagonist1 ?? '',
      protagonist2: project.protagonist2 ?? '',
      synopsis: project.synopsis ?? '',
    });
    setTagDraft(selectedTags);
    setActiveTagTab('主分类');
    setProjectGenerationSource(project.outlines.some(outline => outline.content.trim()) ? 'outline' : 'chapters');
    setProjectGeneratingField(null);
    setShowNewProjectModal(true);
  };

  const generateProjectField = async (field: 'title' | 'synopsis') => {
    if (projectGeneratingField) return;
    if (!agentConfig.enabled || !agentConfig.apiKey.trim()) {
      setNotice({ title: '需要 API Key', content: '请先在设置中填写 API Saver Key，再生成书名或作品简介。' });
      return;
    }
    const sourceProject = projectEditingId === null ? undefined : projects.find(project => project.id === projectEditingId);
    const outlines = projectGenerationSource === 'outline'
      ? (sourceProject?.outlines ?? []).filter(outline => outline.content.trim()).map(outline => ({ kind: outline.kind, title: outline.title, content: outline.content.slice(0, 5000) }))
      : [];
    const chapters = projectGenerationSource === 'chapters'
      ? (sourceProject?.chapters ?? []).filter(chapter => chapter.content.trim()).slice(0, 3).map(chapter => ({ title: chapter.title, content: chapter.content.slice(0, 4500) }))
      : [];
    setProjectGeneratingField(field);
    try {
      const result = await agentRpc<{ title?: string; synopsis?: string }>('project.generate', {
          field,
          source: projectGenerationSource,
          title: newProject.title.trim(),
          synopsis: newProject.synopsis.trim(),
          channel: newProject.channel,
          tags: newProject.selectedTags,
          protagonist1: newProject.protagonist1.trim(),
          protagonist2: newProject.protagonist2.trim(),
          outlines,
          chapters,
          apiKey: agentConfig.apiKey.trim(),
          baseURL: agentConfig.baseURL.trim(),
          model: agentConfig.model.trim() || fallbackModels[0],
          apiMode: agentConfig.apiMode,
          reasoningMode: agentConfig.reasoningMode,
          contextWindow: agentConfig.contextWindow,
          ...agentNetworkParams(agentConfig),
        });
      if (field === 'title') {
        const title = Array.from((result.title || '').replace(/[《》“”"'`]/gu, '').trim()).slice(0, 15).join('');
        if (!title) throw new Error('智能体没有返回可用书名');
        setNewProject(current => ({ ...current, title }));
      } else {
        const synopsis = Array.from((result.synopsis || '').trim()).slice(0, 500).join('');
        if (!synopsis) throw new Error('智能体没有返回作品简介');
        setNewProject(current => ({ ...current, synopsis }));
      }
      const sourceLabel = projectGenerationSource === 'outline' ? '作品大纲' : '前 3 章内容';
      setNotice({ title: field === 'title' ? 'AI 书名已生成' : 'AI 作品简介已生成', content: `已根据${sourceLabel}回填草稿，可继续修改后保存。` });
    } catch (error) {
      setNotice({ title: field === 'title' ? '书名生成失败' : '作品简介生成失败', content: String(error) });
    } finally {
      setProjectGeneratingField(null);
    }
  };

  const openProjectTagPicker = () => {
    setTagDraft(cloneProjectTags(newProject.selectedTags));
    setActiveTagTab('主分类');
    setShowTagPicker(true);
  };

  const handleChannelChange = (channel: Channel) => {
    setNewProject(current => ({
      ...current,
      channel,
      selectedTags: defaultProjectTags(channel),
    }));
  };

  const handleCoverChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setNotice({ title: '封面格式不支持', content: '请选择 JPG、PNG 或 WebP 图片。' });
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setNotice({ title: '封面文件过大', content: '请选择小于 10MB 的图片。' });
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        const maxWidth = 480;
        const maxHeight = 640;
        const scale = Math.min(1, maxWidth / image.width, maxHeight / image.height);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext('2d');
        if (!context) return;
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        setNewProject(current => ({ ...current, cover: canvas.toDataURL('image/jpeg', 0.82) }));
      };
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  };

  const updateDismantleBook = (bookId: string, updater: (book: DismantleBook) => DismantleBook) => {
    setDismantleBooks(current => current.map(book => book.id === bookId ? updater(book) : book));
  };

  const createDismantleFromLibrary = (book: LibraryBook) => {
    const chapters = book.chapters.filter(chapter => chapter.content.trim()).map((chapter, index) => normalizeDismantleChapter({
      id: localResourceId('dismantle-chapter'), number: chapter.number || index + 1, title: chapter.title,
      sourceContent: chapter.content, status: 'pending', updatedAt: new Date().toISOString(),
    }, index));
    if (!chapters.length) {
      setNotice({ title: '还没有可拆正文', content: '请先在书籍管理下载至少一章正文。' });
      return;
    }
    const existing = dismantleBooks.find(item => item.sourceLibraryBookId === book.id);
    if (existing) {
      setActiveDismantleBookId(existing.id);
      setActiveDismantleChapterId(existing.chapters[0]?.id || null);
      setActiveTab('dismantles');
      setNotice({ title: '已打开拆书资料', content: `《${book.title}》已经在拆书管理中。` });
      return;
    }
    const now = new Date().toISOString();
    const dismantle: DismantleBook = {
      id: localResourceId('dismantle'), title: book.title, sourceFileName: `${book.title}.txt`,
      sourceLibraryBookId: book.id, chapters, createdAt: now, updatedAt: now,
    };
    setDismantleBooks(current => [...current, dismantle]);
    setActiveDismantleBookId(dismantle.id);
    setActiveDismantleChapterId(chapters[0]?.id || null);
    setSelectedDismantleChapterIds(chapters.slice(0, 1).map(chapter => chapter.id));
    setActiveTab('dismantles');
    setNotice({ title: '已加入拆书管理', content: `《${book.title}》共 ${chapters.length} 章可分析。` });
  };

  const runBookSearch = async () => {
    if (!bookSearchQuery.trim()) return;
    setBookSearchLoading(true);
    try {
      const result = await agentRpc<{ books?: Partial<LibraryBook>[]; fontCss?: string; searchedSourceCount?: number; responsiveSourceCount?: number }>('book.search.all', { query: bookSearchQuery.trim(), ...agentNetworkParams(agentConfig) });
      setLibrarySearchResults((result.books || []).map(book => normalizeLibraryBook({ ...book, fontCss: result.fontCss || book.fontCss })));
      setNotice({ title: '书籍搜索完成', content: `已搜索 ${result.searchedSourceCount || 0} 个书源，其中 ${result.responsiveSourceCount || 0} 个响应，找到 ${(result.books || []).length} 本书。选择结果卡片即可从对应书源下载。` });
    } catch (error) {
      setNotice({ title: '书籍搜索失败', content: String(error) });
    } finally {
      setBookSearchLoading(false);
    }
  };

  const fetchRankingBooks = async () => {
    setRankingLoading(true);
    try {
      const fanqieSectionConfig = fanqieSectionOptions.find(option => option.value === fanqieSection) || fanqieSectionOptions[0];
      const effectiveRankingGender = rankingPlatform === 'fanqie' ? fanqieSectionConfig.gender : 'all';
      const effectiveRankingType = rankingPlatform === 'fanqie' ? fanqieSectionConfig.list : rankingType;
      const selectedCategory = rankingPlatform === 'fanqie' ? fanqieCategories[fanqieSection].find(category => category.id === fanqieCategoryId) : undefined;
      const result = await agentRpc<{ books?: Partial<RankingBook>[]; fontCss?: string; sourceName?: string }>('ranking.fetch', { platform: rankingPlatform, rankType: effectiveRankingType, gender: effectiveRankingGender, rankUrl: selectedCategory?.url || undefined, ...agentNetworkParams(agentConfig) });
      const sourceName = result.sourceName || { fanqie: '番茄小说网', qidian: '起点中文网官网', faloo: '飞卢小说网官网' }[rankingPlatform];
      const fetched = (result.books || []).map((book, index) => normalizeRankingBook({ ...book, platform: rankingPlatform, rankType: effectiveRankingType, gender: effectiveRankingGender, sourceName }, index));
      setRankingBooks(fetched);
      setRankingFontCss(result.fontCss || '');
      const platformName = { fanqie: '番茄小说网', qidian: '起点', faloo: '飞卢中文网' }[rankingPlatform];
      const sectionLabel = rankingPlatform === 'fanqie' ? fanqieSectionConfig.label : rankingTypeLabel(rankingPlatform, rankingType);
      setNotice({ title: '榜单已更新', content: `${sourceName}返回${platformName}${sectionLabel}${selectedCategory ? `·${selectedCategory.label}` : ''} ${fetched.length} 本书。` });
    } catch (error) {
      setNotice({ title: '扫榜失败', content: String(error) });
    } finally {
      setRankingLoading(false);
    }
  };

  const downloadLibraryBook = async (book: LibraryBook | RankingBook): Promise<LibraryBook | null> => {
    const id = String(book.id);
    setBookDownloadRunningId(id);
    try {
      let downloadable: LibraryBook | RankingBook = book;
      if ('platform' in book && book.platform !== 'fanqie') {
        const search = await agentRpc<{ books?: Partial<LibraryBook>[] }>('book.search', { query: book.title, source: 'qianyue-kuwo', ...agentNetworkParams(agentConfig) });
        const candidates = (search.books || []).map(candidate => normalizeLibraryBook(candidate));
        const matched = candidates.find(candidate => candidate.title.trim() === book.title.trim()) || candidates[0];
        if (!matched) throw new Error(`小说书源中没有找到《${book.title}》，可在书籍管理中切换书源搜索。`);
        downloadable = matched;
      }
      const result = await agentRpc<{ chapters?: Partial<LibraryBookChapter>[]; intro?: string; cover?: string; downloadedChapterCount?: number; completedChapterCount?: number }>('book.download', {
          title: downloadable.title, author: downloadable.author, source: downloadable.sourceId || 'fanqie', sourceBookId: downloadable.sourceBookId || downloadable.id, url: downloadable.url,
          // 不设置人为上限，按书源完整目录下载全部章节。
          ...agentNetworkParams(agentConfig),
        });
      const downloadedChapterCount = Number(result.completedChapterCount) || (result.chapters || []).filter(chapter => chapter.downloaded === true && typeof chapter.content === 'string' && chapter.content.trim()).length;
      if (!downloadedChapterCount) throw new Error('没有获取到完整正文，未保存空章节。可稍后重试，或导入本地 TXT。');
      const now = new Date().toISOString();
      const normalized = normalizeLibraryBook({ ...downloadable, id: libraryBooks.find(item => item.sourceBookId === (downloadable.sourceBookId || downloadable.id))?.id || localResourceId('book'), chapters: (result.chapters || []).map((chapter, index) => normalizeLibraryBookChapter(chapter, index)), intro: result.intro || downloadable.intro, cover: result.cover || downloadable.cover, downloadedAt: now, createdAt: now, updatedAt: now });
      setLibraryBooks(current => {
        const existing = current.findIndex(item => item.sourceBookId === (downloadable.sourceBookId || downloadable.id) || item.id === normalized.id);
        if (existing >= 0) return current.map((item, index) => index === existing ? { ...item, ...normalized, id: item.id } : item);
        return [...current, normalized];
      });
      setActiveLibraryBookId(normalized.id);
      setActiveLibraryChapterId(normalized.chapters[0]?.id || null);
      setActiveTab('books');
      setNotice({ title: '小说下载完成', content: `《${normalized.title}》已保存 ${downloadedChapterCount}/${normalized.chapters.length} 章完整正文到书籍管理。` });
      return normalized;
    } catch (error) {
      setNotice({ title: '小说下载失败', content: String(error) });
      return null;
    } finally {
      setBookDownloadRunningId(null);
    }
  };

  const requestLibraryChapterDownload = async (book: LibraryBook, chapter: LibraryBookChapter): Promise<LibraryBookChapter> => {
    const sourceId = book.sourceId || (/番茄/u.test(book.source) ? 'fanqie' : '');
    if (!sourceId) throw new Error('这本书没有保存书源信息，请重新搜索并下载该书。');
    const result = await agentRpc<{ chapter?: Partial<LibraryBookChapter> }>('book.chapter.download', {
        source: sourceId,
        sourceBookId: book.sourceBookId || '',
        bookUrl: book.url,
        bookTitle: book.title,
        chapter,
        ...agentNetworkParams(agentConfig),
      });
    if (!result.chapter) throw new Error('书源没有返回本章结果。');
    return normalizeLibraryBookChapter({ ...result.chapter, id: chapter.id, number: chapter.number, title: chapter.title, url: chapter.url }, chapter.number - 1);
  };

  const retryLibraryChapter = async (book: LibraryBook, chapter: LibraryBookChapter) => {
    setLibraryChapterDownloadRunningId(chapter.id);
    try {
      const refreshed = await requestLibraryChapterDownload(book, chapter);
      if (refreshed.downloaded) {
        setLibraryBooks(current => current.map(item => item.id === book.id ? {
          ...item,
          chapters: item.chapters.map(existing => existing.id === chapter.id ? refreshed : existing),
          updatedAt: new Date().toISOString(),
        } : item));
      }
      setActiveLibraryChapterId(chapter.id);
      setNotice(refreshed.downloaded
        ? { title: '本章下载完成', content: `《${book.title}》${refreshed.title}已保存 ${refreshed.wordCount.toLocaleString()} 字。` }
        : { title: '本章仍未完整下载', content: refreshed.unavailableReason || '书源仅返回片段，可稍后再次重试。' });
    } catch (error) {
      setNotice({ title: '本章下载失败', content: String(error) });
    } finally {
      setLibraryChapterDownloadRunningId(null);
    }
  };

  const retryUnfinishedLibraryChapters = async (book: LibraryBook) => {
    const pending = book.chapters.filter(chapter => !chapter.downloaded);
    if (!pending.length) {
      setNotice({ title: '没有未下载章节', content: '这本书的章节都已经下载完成。' });
      return;
    }
    const runningId = `book:${book.id}`;
    setLibraryChapterDownloadRunningId(runningId);
    const updates = new Map<string, LibraryBookChapter>();
    let completed = 0;
    try {
      for (const chapter of pending) {
        try {
          const refreshed = await requestLibraryChapterDownload(book, chapter);
          if (refreshed.downloaded) {
            updates.set(chapter.id, refreshed);
            completed += 1;
          }
        } catch {
          // Keep the existing preview and continue with the remaining chapters.
        }
      }
      if (updates.size) {
        setLibraryBooks(current => current.map(item => item.id === book.id ? {
          ...item,
          chapters: item.chapters.map(chapter => updates.get(chapter.id) || chapter),
          updatedAt: new Date().toISOString(),
        } : item));
      }
      setNotice({ title: '未下载章节处理完成', content: `《${book.title}》本次完成 ${completed}/${pending.length} 章；已下载章节保持不变。` });
    } finally {
      setLibraryChapterDownloadRunningId(null);
    }
  };

  const importLibraryTxt = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const text = await readLocalTxtFile(file);
      const sourceChapters = splitTxtIntoDismantleChapters(text);
      if (!sourceChapters.length) throw new Error('TXT 文件没有可导入的正文。');
      const now = new Date().toISOString();
      const sourceBookId = `local-txt:${file.name}:${file.size}:${file.lastModified}`;
      const existing = libraryBooks.find(book => book.sourceBookId === sourceBookId);
      const title = file.name.replace(/\.txt$/iu, '').trim() || '未命名本地书籍';
      const normalized = normalizeLibraryBook({
        id: existing?.id || localResourceId('book'), title, author: '本地导入', source: '本地 TXT', sourceId: 'local-txt', sourceBookId, url: '', intro: '',
        chapters: sourceChapters.map((chapter, index) => ({ id: `local-txt:${sourceBookId}:${index + 1}`, number: index + 1, title: chapter.title, url: '', content: chapter.sourceContent, wordCount: countNovelCharacters(chapter.sourceContent), downloaded: true })),
        downloadedAt: now, createdAt: existing?.createdAt || now, updatedAt: now,
      });
      setLibraryBooks(current => {
        const index = current.findIndex(book => book.sourceBookId === sourceBookId || book.id === normalized.id);
        return index >= 0 ? current.map((book, currentIndex) => currentIndex === index ? { ...normalized, id: book.id } : book) : [...current, normalized];
      });
      setActiveLibraryBookId(normalized.id);
      setActiveLibraryChapterId(normalized.chapters[0]?.id || null);
      setNotice({ title: 'TXT 导入完成', content: `《${normalized.title}》已导入 ${normalized.chapters.length} 章，共 ${normalized.chapters.reduce((total, chapter) => total + chapter.wordCount, 0).toLocaleString()} 字。` });
    } catch (error) {
      setNotice({ title: 'TXT 导入失败', content: String(error) });
    }
  };

  const deleteLibraryBook = async (book: LibraryBook) => {
    setLibraryBooks(current => current.filter(item => item.id !== book.id));
    setLibrarySearchResults(current => current.filter(item => item.id !== book.id));
    setActiveLibraryBookId(current => current === book.id ? null : current);
    setActiveLibraryChapterId(null);
    try {
      if ('__TAURI_INTERNALS__' in window) await invoke<string>('delete_library_book', { bookId: book.id, bookTitle: book.title });
      setNotice({ title: '书籍已删除', content: `《${book.title}》的本地书籍文件已清理。` });
    } catch (error) {
      setLibraryBooks(current => current.some(item => item.id === book.id) ? current : [...current, book]);
      setNotice({ title: '删除书籍失败', content: String(error) });
    }
  };

  const deleteDismantleBook = async (book: DismantleBook) => {
    setDismantleBooks(current => current.filter(item => item.id !== book.id));
    setActiveDismantleBookId(current => current === book.id ? null : current);
    setActiveDismantleChapterId(null);
    setSelectedDismantleChapterIds([]);
    try {
      if ('__TAURI_INTERNALS__' in window) await invoke<string>('delete_dismantle_book', { bookId: book.id, bookTitle: book.title });
      setNotice({ title: '拆书资料已删除', content: `《${book.title}》的原文、章纲和改写稿已清理。` });
    } catch (error) {
      setDismantleBooks(current => current.some(item => item.id === book.id) ? current : [...current, book]);
      setNotice({ title: '删除拆书资料失败', content: String(error) });
    }
  };

  const generateLibraryChapterOutline = async (book: LibraryBook, chapter: LibraryBookChapter) => {
    if (!chapter.content.trim()) {
      setNotice({ title: '章节暂无正文', content: '该章节尚未下载正文，无法生成章纲。' });
      return;
    }
    if (!agentConfig.enabled || !agentConfig.apiKey.trim()) {
      setNotice({ title: '需要 API Key', content: '请先在设置中填写模型密钥，再生成章节章纲。' });
      return;
    }
    setLibraryOutlineRunningId(chapter.id);
    try {
      const result = await agentRpc<{ summary?: string; detailedOutline?: string; plotBeats?: string[]; characterDynamics?: string[]; setupPayoff?: string[]; pacing?: string }>('book.dismantle', {
          bookTitle: book.title, chapterTitle: chapter.title, chapterNumber: chapter.number, sourceContent: chapter.content,
          apiKey: agentConfig.apiKey.trim(), baseURL: agentConfig.baseURL.trim(),
          model: agentConfig.model.trim() || fallbackModels[0], apiMode: agentConfig.apiMode, reasoningMode: agentConfig.reasoningMode,
          contextWindow: agentConfig.contextWindow, ...agentNetworkParams(agentConfig),
        });
      const outline = [
        result.summary?.trim() ? `## 剧情摘要\n${result.summary.trim()}` : '',
        result.detailedOutline?.trim() ? `## 章节细纲\n${result.detailedOutline.trim()}` : '',
        result.plotBeats?.length ? `## 情节节点\n${asTextList(result.plotBeats, 10).map(item => `- ${item}`).join('\n')}` : '',
        result.characterDynamics?.length ? `## 人物关系\n${asTextList(result.characterDynamics, 10).map(item => `- ${item}`).join('\n')}` : '',
        result.setupPayoff?.length ? `## 伏笔与回收\n${asTextList(result.setupPayoff, 10).map(item => `- ${item}`).join('\n')}` : '',
        result.pacing?.trim() ? `## 节奏判断\n${result.pacing.trim()}` : '',
      ].filter(Boolean).join('\n\n');
      if (!outline) throw new Error('智能体没有返回可用章纲');
      setLibraryBooks(current => current.map(item => item.id === book.id ? {
        ...item,
        chapters: item.chapters.map(value => value.id === chapter.id ? { ...value, outline } : value),
        updatedAt: new Date().toISOString(),
      } : item));
      setNotice({ title: '章节章纲已生成', content: `《${book.title}》${chapter.title} 的章纲已保存到本地。` });
    } catch (error) {
      setNotice({ title: '生成章节章纲失败', content: String(error) });
    } finally {
      setLibraryOutlineRunningId(null);
    }
  };

  const runDismantleAnalysis = async () => {
    const book = dismantleBooks.find(item => item.id === activeDismantleBookId);
    if (!book) return;
    const targets = book.chapters.filter(chapter => selectedDismantleChapterIds.includes(chapter.id) && chapter.sourceContent.trim());
    if (!targets.length) {
      setNotice({ title: '请选择章节', content: '勾选至少一章正文后再生成章纲。' });
      return;
    }
    if (!agentConfig.enabled || !agentConfig.apiKey.trim()) {
      setNotice({ title: '需要 API Key', content: '请先在设置中填写模型密钥，再运行拆书分析。' });
      return;
    }
    setDismantleRunningIds(targets.map(chapter => chapter.id));
    let completed = 0;
    try {
      for (const chapter of targets) {
        updateDismantleBook(book.id, current => ({ ...current, chapters: current.chapters.map(item => item.id === chapter.id ? { ...item, status: 'analyzing' } : item), updatedAt: new Date().toISOString() }));
        const result = await agentRpc<{ summary?: string; detailedOutline?: string; plotBeats?: string[]; characterDynamics?: string[]; setupPayoff?: string[]; pacing?: string }>('book.dismantle', {
            bookTitle: book.title, chapterTitle: chapter.title, chapterNumber: chapter.number, sourceContent: chapter.sourceContent,
            apiKey: agentConfig.apiKey.trim(), baseURL: agentConfig.baseURL.trim(),
            model: agentConfig.model.trim() || fallbackModels[0], apiMode: agentConfig.apiMode, reasoningMode: agentConfig.reasoningMode,
            contextWindow: agentConfig.contextWindow, ...agentNetworkParams(agentConfig),
          });
        updateDismantleBook(book.id, current => ({ ...current, chapters: current.chapters.map(item => item.id === chapter.id ? {
          ...item, summary: result.summary?.trim() || item.summary, detailedOutline: result.detailedOutline?.trim() || item.detailedOutline,
          plotBeats: asTextList(result.plotBeats, 10), characterDynamics: asTextList(result.characterDynamics, 10), setupPayoff: asTextList(result.setupPayoff, 10),
          pacing: result.pacing?.trim() || item.pacing, status: result.detailedOutline?.trim() ? 'analyzed' : item.status, updatedAt: new Date().toISOString(),
        } : item), updatedAt: new Date().toISOString() }));
        completed += 1;
      }
      setNotice({ title: '拆书章纲已生成', content: `已完成 ${completed} 章，章纲和分析结果会自动保存。` });
    } catch (error) {
      setNotice({ title: '拆书分析失败', content: String(error) });
    } finally {
      setDismantleRunningIds([]);
    }
  };

  const runDismantleRewrite = async () => {
    const book = dismantleBooks.find(item => item.id === activeDismantleBookId);
    const chapter = book?.chapters.find(item => item.id === activeDismantleChapterId);
    if (!book || !chapter?.detailedOutline.trim()) {
      setNotice({ title: '请先生成章纲', content: '确认当前章节的细纲后，再生成原创改写稿。' });
      return;
    }
    if (!agentConfig.enabled || !agentConfig.apiKey.trim()) {
      setNotice({ title: '需要 API Key', content: '请先在设置中填写模型密钥，再生成原创改写稿。' });
      return;
    }
    setDismantleRewriteRunning(true);
    try {
      const result = await agentRpc<{ content?: string }>('book.rewrite', {
          bookTitle: book.title, chapterTitle: chapter.title, detailedOutline: chapter.detailedOutline,
          instruction: dismantleRewriteInstruction, targetWords: 2200,
          apiKey: agentConfig.apiKey.trim(), baseURL: agentConfig.baseURL.trim(),
          model: agentConfig.model.trim() || fallbackModels[0], apiMode: agentConfig.apiMode, reasoningMode: agentConfig.reasoningMode,
          contextWindow: agentConfig.contextWindow, ...agentNetworkParams(agentConfig),
        });
      if (!result.content?.trim()) throw new Error('智能体没有返回原创改写稿');
      updateDismantleBook(book.id, current => ({ ...current, chapters: current.chapters.map(item => item.id === chapter.id ? { ...item, rewriteContent: result.content?.trim() || '', status: 'rewritten', updatedAt: new Date().toISOString() } : item), updatedAt: new Date().toISOString() }));
      setNotice({ title: '原创改写稿已生成', content: '请在右侧编辑并确认，确认后可生成到绑定小说。' });
    } catch (error) {
      setNotice({ title: '原创改写失败', content: String(error) });
    } finally {
      setDismantleRewriteRunning(false);
    }
  };

  const distillDismantleStyle = async () => {
    const book = dismantleBooks.find(item => item.id === activeDismantleBookId);
    if (!book) return;
    const chapters = book.chapters.filter(chapter => selectedDismantleChapterIds.includes(chapter.id) && chapter.sourceContent.trim()).slice(0, 8);
    if (!chapters.length) {
      setNotice({ title: '请选择样本章节', content: '至少选择一章有正文的章节用于文风蒸馏。' });
      return;
    }
    if (!agentConfig.enabled || !agentConfig.apiKey.trim()) {
      setNotice({ title: '需要 API Key', content: '请先在设置中填写模型密钥，再蒸馏文风。' });
      return;
    }
    setStyleDistilling(true);
    try {
      const result = await agentRpc<{ name?: string; description?: string; tags?: string[]; content?: string }>('book.style.distill', {
          bookTitle: book.title, styleName: `${book.title}文风`, samples: chapters.map(chapter => ({ title: chapter.title, content: chapter.sourceContent })),
          apiKey: agentConfig.apiKey.trim(), baseURL: agentConfig.baseURL.trim(),
          model: agentConfig.model.trim() || fallbackModels[0], apiMode: agentConfig.apiMode, reasoningMode: agentConfig.reasoningMode,
          contextWindow: agentConfig.contextWindow, ...agentNetworkParams(agentConfig),
        });
      if (!result.content?.trim()) throw new Error('智能体没有返回文风 Skill');
      const now = new Date().toISOString();
      const style = normalizeWritingStyle({ id: localResourceId('style'), name: result.name || `${book.title}文风`, description: result.description || '', tags: result.tags || [], content: result.content, sourceBookId: book.id, createdAt: now, updatedAt: now });
      setWritingStyles(current => [...current, style]);
      setStyleDraft(style);
      setNotice({ title: '文风蒸馏完成', content: `${style.name} 已保存到全局文风管理，可在任意小说中绑定。` });
    } catch (error) {
      setNotice({ title: '文风蒸馏失败', content: String(error) });
    } finally {
      setStyleDistilling(false);
    }
  };

  const startDismantleImitation = (book: DismantleBook, chapter?: DismantleChapter) => {
    setImitationSource({ bookId: book.id, chapterId: chapter?.id });
    setProjectFormMode('create');
    setProjectEditingId(null);
    setNewProject({ title: '', channel: '男频', selectedTags: defaultProjectTags('男频'), cover: '', protagonist1: '', protagonist2: '', synopsis: '' });
    setShowNewProjectModal(true);
    setActiveTab('projects');
    setNotice({ title: '已带入仿写创建', content: '请补充目标小说的书名、简介和分类后创建。只会带入抽象细纲，不会复制原文。' });
  };

  const bindDismantleToProject = (bookId: string, projectId?: number) => {
    updateDismantleBook(bookId, book => ({ ...book, boundProjectId: projectId, updatedAt: new Date().toISOString() }));
    setProjects(current => current.map(project => project.id === projectId ? { ...project, sourceDismantleBookId: bookId, updatedAt: new Date().toISOString() } : project));
  };

  const generateDismantleChapter = async () => {
    const book = dismantleBooks.find(item => item.id === activeDismantleBookId);
    const chapter = book?.chapters.find(item => item.id === activeDismantleChapterId);
    const target = book?.boundProjectId ? projects.find(project => project.id === book.boundProjectId) : undefined;
    if (!book || !chapter || !target) {
      setNotice({ title: '请先绑定小说', content: '在拆书详情顶部选择目标小说后，才能把原创内容生成到章节。' });
      return;
    }
    if (!chapter.rewriteContent.trim() && !chapter.detailedOutline.trim()) {
      setNotice({ title: '请先准备章节素材', content: '先生成章纲，或完成原创改写稿后再生成章节。' });
      return;
    }
    if (!agentConfig.enabled || !agentConfig.apiKey.trim()) {
      setNotice({ title: '需要 API Key', content: '请先在设置中填写模型密钥。' });
      return;
    }
    try {
      const style = target.styleProfileId ? writingStyles.find(item => item.id === target.styleProfileId) : undefined;
      const result = await agentRpc<{ title?: string; content?: string }>('book.adapt', {
          projectTitle: target.title, projectSynopsis: target.synopsis, projectOutlines: target.outlines.map(outline => `## ${outline.kind}\n${outline.content}`).join('\n\n'),
          chapterTitle: chapter.title, detailedOutline: chapter.detailedOutline, rewriteContent: chapter.rewriteContent, styleProfile: style?.content,
          apiKey: agentConfig.apiKey.trim(), baseURL: agentConfig.baseURL.trim(),
          model: agentConfig.model.trim() || fallbackModels[0], apiMode: agentConfig.apiMode, reasoningMode: agentConfig.reasoningMode,
          contextWindow: agentConfig.contextWindow, ...agentNetworkParams(agentConfig),
        });
      if (!result.content?.trim()) throw new Error('智能体没有返回章节正文');
      const now = new Date().toISOString();
      const newChapter: Chapter = { id: Date.now(), title: result.title?.trim() || `第${target.chapters.length + 1}章`, content: result.content?.trim() || '', wordCount: countNovelCharacters(result.content), createdAt: now, updatedAt: now };
      const updated = { ...target, chapters: [...target.chapters, newChapter], wordCount: target.wordCount + newChapter.wordCount, updatedAt: now };
      setProjects(current => current.map(project => project.id === updated.id ? updated : project));
      setNotice({ title: '原创章节已生成', content: `已写入《${target.title}》的第 ${updated.chapters.length} 章，可进入小说继续编辑。` });
    } catch (error) {
      setNotice({ title: '生成目标章节失败', content: String(error) });
    }
  };

  const openNewWritingStyle = () => {
    const now = new Date().toISOString();
    setStyleDraft(normalizeWritingStyle({ id: localResourceId('style'), name: '', description: '', tags: [], content: '# 文风 Skill\n\n## 写作指令\n\n', createdAt: now, updatedAt: now }));
  };

  const saveWritingStyleDraft = () => {
    if (!styleDraft?.name.trim() || !styleDraft.content.trim()) {
      setNotice({ title: '文风信息不完整', content: '请填写文风名称和 Skill 内容。' });
      return;
    }
    const updated = { ...styleDraft, name: styleDraft.name.trim(), updatedAt: new Date().toISOString() };
    setWritingStyles(current => current.some(style => style.id === updated.id) ? current.map(style => style.id === updated.id ? updated : style) : [...current, updated]);
    setStyleDraft(updated);
    setNotice({ title: '文风已保存', content: `${updated.name} 已更新，可在小说中绑定使用。` });
  };

  const deleteWritingStyle = (styleId: string) => {
    setWritingStyles(current => current.filter(style => style.id !== styleId));
    if (styleDraft?.id === styleId) setStyleDraft(null);
    setProjects(current => current.map(project => project.styleProfileId === styleId ? { ...project, styleProfileId: undefined, updatedAt: new Date().toISOString() } : project));
  };

  const bindStyleToCurrentProject = (styleId: string) => {
    if (!editingProject) return;
    updateEditorProject(project => ({ ...project, styleProfileId: styleId || undefined, updatedAt: new Date().toISOString() }));
    setNotice({ title: '文风绑定已更新', content: styleId ? '章节智能体会在相关创作中加入该文风 Skill。' : '已取消绑定文风。' });
  };

  const handleProjectTagToggle = (tag: string) => {
    const selected = tagDraft[activeTagTab];
    const next = activeTagTab === '主分类'
      ? [tag]
      : selected.includes(tag)
        ? selected.filter(item => item !== tag)
        : selected.length < 2
          ? [...selected, tag]
          : selected;
    setTagDraft({ ...tagDraft, [activeTagTab]: next });
  };

  const confirmProjectTags = () => {
    setNewProject({ ...newProject, selectedTags: cloneProjectTags(tagDraft) });
    setShowTagPicker(false);
  };

  const handleDeleteProject = () => {
    if (!projectPendingDeletion) return;
    const deletedId = projectPendingDeletion.id;
    setProjects(prev => prev.filter(project => project.id !== deletedId));
    if (editingProject?.id === deletedId) {
      setEditingProject(null);
      setActiveChapter(null);
      setEditorSidebarTab('chapters');
    }
    setProjectPendingDeletion(null);
  };

  const handleOpenProjectLocation = async (project: Project) => {
    try {
      await nativeClient.saveProjects(projects);
      const path = await invoke<string>('open_project_location', { projectId: project.id });
      setNotice({ title: '已打开小说目录', content: path });
    } catch (error) {
      setNotice({ title: '打开小说目录失败', content: String(error) });
    }
  };

  const handleOpenChapterLocation = async (chapter: Chapter) => {
    if (!editingProject) return;
    try {
      await nativeClient.saveProjects(projects);
      await invoke<string>('open_chapter_location', { projectId: editingProject.id, chapterTitle: chapter.title });
    } catch (error) {
      setNotice({ title: '打开章节位置失败', content: String(error) });
    }
  };

  const handleOpenOutlineLocation = async () => {
    if (!editingProject) return;
    try {
      await nativeClient.saveProjects(projects);
      await invoke<string>('open_outline_location', { projectId: editingProject.id, outlineTitle: activeOutline?.title ?? '大纲' });
    } catch (error) {
      setNotice({ title: '打开大纲位置失败', content: String(error) });
    }
  };

  const handleOpenCardLocation = async (card: KnowledgeCard) => {
    if (!editingProject) return;
    try {
      await nativeClient.saveProjects(projects);
      await invoke<string>('open_card_location', { projectId: editingProject.id, cardType: card.type, cardTitle: card.title });
    } catch (error) {
      setNotice({ title: '打开卡片位置失败', content: String(error) });
    }
  };

  const handleOpenGraphNodeLocation = async (node: KnowledgeGraphNode) => {
    if (!editingProject) return;
    try {
      await nativeClient.saveProjects(projects);
      await invoke<string>('open_graph_node_location', { projectId: editingProject.id, nodeId: node.id });
    } catch (error) {
      setNotice({ title: '打开图谱档案位置失败', content: String(error) });
    }
  };

  const updateGraphNodeProfile = (nodeId: string, content: string) => {
    updateEditorProject(project => ({
      ...project,
      graphNodes: project.graphNodes.map(node => node.id === nodeId ? { ...node, content, updatedAt: new Date().toISOString() } : node),
      updatedAt: new Date().toISOString(),
    }));
  };

  const persistSkillRecords = (nextSkills: Skill[]) => {
    const records = nextSkills.filter(skill => !skill.builtin || builtinSkills.some(item => String(item.id) === String(skill.id)))
      .map(skill => ({ ...skill, ...(skill.builtin ? { builtin: true } : { builtin: false }) }));
    localStorage.setItem('writer-skills', JSON.stringify(records));
  };

  const openNewSkill = () => {
    setSkillEditingId(null);
    setNewSkill({ name: '', category: 'write', description: '', content: '', tags: '' });
    setShowNewSkillModal(true);
  };

  const openSkillEditor = (skill: Skill) => {
    setSkillEditingId(skill.id);
    setNewSkill({
      name: skill.displayName || skill.name,
      category: skill.category,
      description: skill.description,
      content: skill.content,
      tags: skill.tags.join(', '),
    });
    setShowNewSkillModal(true);
  };

  const handleCreateSkill = () => {
    if (!newSkill.name.trim() || !newSkill.content.trim()) {
      setNotice({ title: '技能信息不完整', content: '请填写技能名称和详细内容。' });
      return;
    }
    const editingSkill = skillEditingId === null ? null : skills.find(item => String(item.id) === String(skillEditingId));
    const skill: Skill = {
      id: editingSkill?.id ?? Date.now(),
      name: editingSkill?.builtin ? editingSkill.name : newSkill.name.trim(),
      displayName: editingSkill?.builtin ? newSkill.name.trim() : undefined,
      category: newSkill.category,
      description: newSkill.description.trim(),
      tags: newSkill.tags.split(',').map(t => t.trim()).filter(Boolean),
      rating: editingSkill?.rating ?? 0,
      usageCount: editingSkill?.usageCount ?? 0,
      content: newSkill.content.trim(),
      builtin: editingSkill?.builtin ?? false,
    };
    const nextSkills = editingSkill
      ? skills.map(item => String(item.id) === String(skillEditingId) ? skill : item)
      : [...skills, skill];
    persistSkillRecords(nextSkills);
    setSkills(nextSkills);
    setNewSkill({
      name: '',
      category: 'write',
      description: '',
      content: '',
      tags: '',
    });
    setSkillEditingId(null);
    setShowNewSkillModal(false);
    setNotice({ title: editingSkill ? '技能已更新' : '技能已创建', content: `${skill.displayName || skill.name} 已保存到本机技能库。` });
  };

  const generateSkillWithAI = async () => {
    if (skillGenerating) return;
    if (!agentConfig.enabled || !agentConfig.apiKey.trim()) {
      setNotice({ title: '需要 API Key', content: '请先在设置中配置可用模型，再生成技能。' });
      return;
    }
    if (!newSkill.name.trim() && !newSkill.description.trim() && !newSkill.content.trim()) {
      setNotice({ title: '需要技能需求', content: '请先填写技能名称、用途或草稿内容。' });
      return;
    }
    setSkillGenerating(true);
    try {
      const result = await agentRpc<{ name?: string; category?: string; description?: string; content?: string; tags?: string[] }>('skill.write', {
          name: newSkill.name.trim(),
          category: newSkill.category,
          description: newSkill.description.trim(),
          content: newSkill.content.trim(),
          tags: newSkill.tags.split(',').map(tag => tag.trim()).filter(Boolean),
          apiKey: agentConfig.apiKey.trim(),
          baseURL: agentConfig.baseURL.trim(),
          model: agentConfig.model.trim() || fallbackModels[0],
          apiMode: agentConfig.apiMode,
          reasoningMode: agentConfig.reasoningMode,
          contextWindow: agentConfig.contextWindow,
          ...agentNetworkParams(agentConfig),
        });
      setNewSkill(current => ({
        ...current,
        name: result.name?.trim() || current.name,
        category: result.category?.trim() || current.category,
        description: result.description?.trim() || current.description,
        content: result.content?.trim() || current.content,
        tags: Array.isArray(result.tags) && result.tags.length ? result.tags.join(', ') : current.tags,
      }));
      setNotice({ title: '技能草稿已生成', content: '请检查技能步骤和输出契约后保存。' });
    } catch (error) {
      setNotice({ title: '技能生成失败', content: String(error) });
    } finally {
      setSkillGenerating(false);
    }
  };

  const deleteSkill = (skill: Skill) => {
    if (skill.builtin) {
      const nextSkills = skills.filter(item => String(item.id) !== String(skill.id));
      const restored = builtinSkills.find(item => String(item.id) === String(skill.id));
      if (!restored) return;
      const next = [...nextSkills, restored].sort((left, right) => (left.builtin ? 0 : 1) - (right.builtin ? 0 : 1));
      persistSkillRecords(next.filter(item => !(item.builtin && String(item.id) === String(skill.id))));
      setSkills(next);
      setNotice({ title: '内置技能已恢复', content: `${restored.name} 已恢复为默认内容。` });
      return;
    }
    const nextSkills = skills.filter(item => String(item.id) !== String(skill.id));
    persistSkillRecords(nextSkills);
    setSkills(nextSkills);
    setNotice({ title: '技能已删除', content: `${skill.displayName || skill.name} 已从本机技能库移除。` });
  };

  const handleEditProject = (projectId: number) => {
    const project = projects.find(p => p.id === projectId);
    if (project) {
      setChapterTargetWordsDraft(String(Number(project.chapterTargetWords) || 3000));
      setSearchQuery('');
      setReplaceQuery('');
      setSearchMatchIndex(0);
      setSelectionSnapshot(null);
      setAIToolResult(null);
      setAIToolMode(null);
      const chapters = Array.isArray(project.chapters) ? project.chapters : [];
      // 如果项目没有章节，自动创建第一章
      if (chapters.length === 0) {
        const firstChapter: Chapter = {
          id: Date.now(),
          title: '第 1 章',
          content: '',
          wordCount: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        const updatedProject = {
          ...project,
          chapters: [firstChapter],
          outline: Array.isArray(project.outline) ? project.outline : [],
          outlines: Array.isArray(project.outlines) ? project.outlines : [],
          cards: Array.isArray(project.cards) ? project.cards : [],
          memories: Array.isArray(project.memories) ? project.memories.map(memory => normalizeChapterMemory(memory)) : [],
          memoryDocuments: hydrateMemoryDocuments(project.memoryDocuments, Array.isArray(project.memories) ? project.memories.map(memory => normalizeChapterMemory(memory)) : []),
          graphNodes: Array.isArray(project.graphNodes) ? project.graphNodes : [],
          graphEdges: normalizeKnowledgeGraphEdges(project.graphEdges),
        };
        setProjects(prev => prev.map(p => p.id === projectId ? updatedProject : p));
        setEditingProject(updatedProject);
        setActiveChapter(firstChapter);
        setActiveOutlineId(updatedProject.outlines[0]?.id ?? null);
        setSelectedCardIds([]);
        setActiveChapterMemoryId(updatedProject.memories[0]?.id ?? null);
      } else {
        const normalizedProject = {
          ...project,
          chapters,
          outline: Array.isArray(project.outline) ? project.outline : [],
          outlines: Array.isArray(project.outlines) ? project.outlines : [],
          cards: Array.isArray(project.cards) ? project.cards : [],
          memories: Array.isArray(project.memories) ? project.memories.map(memory => normalizeChapterMemory(memory)) : [],
          memoryDocuments: hydrateMemoryDocuments(project.memoryDocuments, Array.isArray(project.memories) ? project.memories.map(memory => normalizeChapterMemory(memory)) : []),
          graphNodes: Array.isArray(project.graphNodes) ? project.graphNodes : [],
          graphEdges: normalizeKnowledgeGraphEdges(project.graphEdges),
        };
        setEditingProject(normalizedProject);
        setActiveChapter(chapters[0]);
        setActiveOutlineId(normalizedProject.outlines[0]?.id ?? null);
        setSelectedCardIds([]);
        setActiveChapterMemoryId(normalizedProject.memories[0]?.id ?? null);
      }
    }
  };

  const handleCloseEditor = () => {
    setEditingProject(null);
    setActiveChapter(null);
    setEditorSidebarTab('chapters');
    setActiveOutlineId(null);
    setActiveCardId(null);
    setSelectedCardIds([]);
    setActiveChapterMemoryId(null);
  };

  // 选中章节：目录跟随和滚动归零统一由切章 effect 处理，这里只收尾本章的编辑状态
  const selectChapter = (chapter: Chapter) => {
    setActiveChapter(chapter);
    setSelectionSnapshot(null);
    setSearchMatchIndex(0);
    goalNoticeChapterRef.current = null;
  };

  // 跳转框接受「12」「第 12 章」和标题关键字三种写法
  const jumpToChapterByQuery = () => {
    if (!editingProject) return;
    const query = chapterJumpQuery.trim();
    if (!query) return;
    const chapters = editingProject.chapters;
    const orderMatch = /^第?\s*(\d+)\s*章?$/.exec(query);
    const target = (orderMatch ? chapters[Number(orderMatch[1]) - 1] : undefined)
      || chapters.find(chapter => chapter.title.includes(query));
    if (!target) {
      setNotice({ title: '没有找到章节', content: `当前小说共 ${chapters.length} 章，没有匹配「${query}」的章节序号或标题。` });
      return;
    }
    selectChapter(target);
    setChapterJumpQuery('');
  };

  const jumpToLatestChapter = () => {
    const latest = editingProject?.chapters.at(-1);
    if (!latest) return;
    selectChapter(latest);
  };

  const handleAddChapter = () => {
    if (!editingProject) return;
    const newChapter: Chapter = {
      id: Date.now(),
      title: `第 ${editingProject.chapters.length + 1} 章`,
      content: '',
      wordCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const updated = { ...editingProject, chapters: [...editingProject.chapters, newChapter] };
    setEditingProject(updated);
    setProjects(projects.map(p => p.id === updated.id ? updated : p));
    setActiveChapter(newChapter);
  };

  // 删除章节：级联清理复用 domain/chapter，与项目 Agent 的 chapter.delete 走同一份逻辑
  const handleDeleteChapter = async () => {
    const project = editingProjectRef.current;
    const target = chapterPendingDeletion;
    setChapterPendingDeletion(null);
    if (!project || !target) return;
    const updated = removeChapterFromProject(project, target.id);
    const nextProjects = projectsRef.current.map(item => item.id === updated.id ? updated : item);
    setProjects(nextProjects);
    setEditingProject(updated);
    if (activeChapter?.id === target.id) {
      setActiveChapter(updated.chapters.at(-1) || null);
      setSelectionSnapshot(null);
      setSearchMatchIndex(0);
    }
    try {
      if ('__TAURI_INTERNALS__' in window) await nativeClient.saveProjects(nextProjects);
      else localStorage.setItem('projects', JSON.stringify(nextProjects));
      setNotice({ title: '章节已删除', content: `《${target.title}》已进回收站，可在章节列表上方恢复；章节记忆、图谱关系已清理，绑定的章纲解除关联但保留。` });
    } catch (error) {
      setNotice({ title: '章节已删除但保存失败', content: String(error) });
    }
  };

  const handleUpdateChapterContent = (content: string) => {
    if (!activeChapter || !editingProject) return;
    const wordCount = countNovelCharacters(content);
    const updatedChapter = { ...activeChapter, content, wordCount, updatedAt: new Date().toISOString() };
    const updatedChapters = editingProject.chapters.map(c => c.id === activeChapter.id ? updatedChapter : c);
    const totalWords = updatedChapters.reduce((sum, c) => sum + c.wordCount, 0);
    // 日更统计只累加正增量，删字不从当日成绩里扣回去
    const delta = wordCount - activeChapter.wordCount;
    const dailyWords = delta > 0
      ? { ...editingProject.dailyWords, [todayKey()]: (editingProject.dailyWords?.[todayKey()] || 0) + delta }
      : editingProject.dailyWords;
    const updated = { ...editingProject, chapters: updatedChapters, wordCount: totalWords, dailyWords, updatedAt: new Date().toISOString() };
    setEditingProject(updated);
    setActiveChapter(updatedChapter);
    setProjects(current => current.map(p => p.id === updated.id ? updated : p));
    setAutoSaveStatus('saving');
    const target = Number(editingProject.chapterTargetWords) || 3000;
    if (wordCount >= target && goalNoticeChapterRef.current !== activeChapter.id) {
      goalNoticeChapterRef.current = activeChapter.id;
      setNotice({ title: '已达到本章目标字数', content: `本章已写 ${wordCount} 字，建议保存并创建下一章。` });
    }
  };

  const handleUpdateChapterAuthorNote = (authorNote: string) => {
    if (!activeChapter || !editingProject) return;
    const updatedChapter = { ...activeChapter, authorNote, updatedAt: new Date().toISOString() };
    const updatedChapters = editingProject.chapters.map(c => c.id === activeChapter.id ? updatedChapter : c);
    const updated = { ...editingProject, chapters: updatedChapters, updatedAt: new Date().toISOString() };
    setEditingProject(updated);
    setActiveChapter(updatedChapter);
    setProjects(current => current.map(p => p.id === updated.id ? updated : p));
    setAutoSaveStatus('saving');
  };

  // 保存项目到本地，所有需要立即落盘的操作共用这一条路径
  const persistProjects = async (nextProjects: Project[]) => {
    if ('__TAURI_INTERNALS__' in window) await nativeClient.saveProjects(nextProjects);
    else localStorage.setItem('projects', JSON.stringify(nextProjects));
  };

  const applyProjectChange = async (updated: Project, message?: { title: string; content: string }) => {
    // setEditingProject 同时同步 editingProjectRef 和 projects，不能只写 projects
    setEditingProject(updated);
    const nextProjects = projectsRef.current.map(item => item.id === updated.id ? updated : item);
    try {
      await persistProjects(nextProjects);
      if (message) setNotice(message);
    } catch (error) {
      setNotice({ title: '修改已应用但保存失败', content: String(error) });
    }
  };

  // 回滚到某个历史版本；当前正文会先入栈，回滚可以再回滚
  const rollbackChapterSnapshot = async (savedAt: string) => {
    if (!editingProject || !activeChapter) return;
    const restored = restoreChapterSnapshot(activeChapter, savedAt, countNovelCharacters);
    if (restored === activeChapter) return;
    setActiveChapter(restored);
    setShowChapterHistory(false);
    await applyProjectChange(replaceChapterInProject(editingProject, restored), {
      title: '已恢复历史版本',
      content: `正文已换回 ${new Date(savedAt).toLocaleString('zh-CN', { hour12: false })} 的版本，当前版本已存为新快照。`,
    });
  };

  const restoreChapterFromBin = async (chapterId: number) => {
    if (!editingProject) return;
    const { project, chapter } = restoreDeletedChapter(editingProject, chapterId);
    if (!chapter) return;
    setActiveChapter(chapter);
    await applyProjectChange(project, { title: '章节已恢复', content: `《${chapter.title}》已插回目录；章节记忆与图谱关系需要重新生成。` });
  };

  const purgeChapterFromBin = async (chapterId: number) => {
    if (!editingProject) return;
    await applyProjectChange({
      ...editingProject,
      deletedChapters: (editingProject.deletedChapters || []).filter(item => item.chapter.id !== chapterId),
      updatedAt: new Date().toISOString(),
    });
  };

  const moveActiveChapter = async (chapterId: number, delta: number) => {
    if (!editingProject) return;
    const updated = moveChapterInProject(editingProject, chapterId, delta);
    if (updated === editingProject) return;
    await applyProjectChange(updated);
  };

  const dropChapterOn = async (targetChapterId: number) => {
    const sourceId = draggingChapterId;
    setDraggingChapterId(null);
    if (!editingProject || sourceId === null || sourceId === targetChapterId) return;
    const toIndex = editingProject.chapters.findIndex(chapter => chapter.id === targetChapterId);
    const updated = reorderChapterInProject(editingProject, sourceId, toIndex);
    if (updated === editingProject) return;
    await applyProjectChange(updated);
  };

  const insertChapterBelow = async (afterChapterId: number | null) => {
    if (!editingProject) return;
    const { project, chapter } = insertChapterAfter(editingProject, afterChapterId, '新章节');
    setActiveChapter(chapter);
    await applyProjectChange(project);
  };

  // 全书替换：改角色名不必逐章手工替换，每章覆盖前均存快照
  const replaceAllInBook = async () => {
    if (!editingProject || !searchQuery) return;
    let changedChapters = 0;
    let changedCount = 0;
    const chapters = editingProject.chapters.map(chapter => {
      const count = countOccurrences(chapter.content, searchQuery);
      if (!count) return chapter;
      changedChapters += 1;
      changedCount += count;
      const content = chapter.content.split(searchQuery).join(replaceQuery);
      return { ...pushChapterSnapshot(chapter, '全书替换'), content, wordCount: countNovelCharacters(content), updatedAt: new Date().toISOString() };
    });
    if (!changedCount) {
      setNotice({ title: '没有可替换内容', content: `全书没有“${searchQuery}”。` });
      return;
    }
    const updated = { ...editingProject, chapters, wordCount: chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0), updatedAt: new Date().toISOString() };
    const nextActive = activeChapter ? chapters.find(chapter => chapter.id === activeChapter.id) : null;
    if (nextActive) setActiveChapter(nextActive);
    await applyProjectChange(updated, {
      title: '全书替换完成',
      content: `已在 ${changedChapters} 个章节里替换 ${changedCount} 处；每章保留了替换前的历史版本，可在“历史”里回滚。`,
    });
  };

  const exportCurrentTarget = async () => {
    if (!editingProject || exportRunning) return;
    if (exportScope === 'chapter' && !activeChapter) return;
    setExportRunning(true);
    try {
      // 当前章可能还在编辑缓冲里，先把它合入导出快照
      const snapshot = activeChapter ? replaceChapterInProject(editingProject, activeChapter) : editingProject;
      const content = exportScope === 'chapter' && activeChapter
        ? buildChapterExport(snapshot, activeChapter.id, exportOptions.format)
        : buildProjectExport(snapshot, exportOptions);
      const fileName = exportFileName(snapshot, exportOptions, exportScope === 'chapter' ? activeChapter?.title : undefined);
      if ('__TAURI_INTERNALS__' in window) {
        const path = await invoke<string>('export_text_file', { fileName, content });
        setNotice({ title: '导出完成', content: path });
      } else {
        downloadInBrowser(fileName, content);
        setNotice({ title: '导出完成', content: `${fileName} 已下载。` });
      }
      setShowExportModal(false);
    } catch (error) {
      setNotice({ title: '导出失败', content: String(error) });
    } finally {
      setExportRunning(false);
    }
  };

  const formatActiveChapter = () => {
    if (!activeChapter) return;
    const formatted = formatNovelChapterContent(activeChapter.content);
    if (formatted === activeChapter.content) {
      setNotice({ title: '正文格式已规范', content: '没有发现需要清理的空格、换行或首尾空白。' });
      return;
    }
    handleUpdateChapterContent(formatted);
    setNotice({ title: '正文格式化完成', content: '已统一换行、清理行首尾空格并合并多余空行，内容会自动保存。' });
    window.requestAnimationFrame(() => {
      const editor = chapterEditorRef.current;
      if (!editor) return;
      editor.focus();
      editor.setSelectionRange(formatted.length, formatted.length);
    });
  };

  const captureChapterSelection = () => {
    const element = chapterEditorRef.current;
    if (!element || !activeChapter) return;
    const start = element.selectionStart ?? 0;
    const end = element.selectionEnd ?? 0;
    if (end > start) setSelectionSnapshot({ start, end, source: activeChapter.content.slice(start, end) });
  };

  const focusSearchMatch = (direction: 1 | -1 = 1) => {
    if (!activeChapter || !searchQuery) return;
    const matches: number[] = [];
    let cursor = 0;
    while (cursor < activeChapter.content.length) {
      const index = activeChapter.content.indexOf(searchQuery, cursor);
      if (index < 0) break;
      matches.push(index);
      cursor = index + Math.max(1, searchQuery.length);
    }
    if (!matches.length) {
      setSearchMatchIndex(0);
      setNotice({ title: '没有找到匹配内容', content: `本章没有“${searchQuery}”。` });
      return;
    }
    const element = chapterEditorRef.current;
    const selectedIndex = element
      ? matches.findIndex(start => element.selectionStart === start && element.selectionEnd === start + searchQuery.length)
      : -1;
    const baseIndex = selectedIndex >= 0 ? selectedIndex : (direction === 1 ? -1 : 0);
    const nextIndex = (baseIndex + direction + matches.length) % matches.length;
    setSearchMatchIndex(nextIndex);
    window.requestAnimationFrame(() => {
      const editor = chapterEditorRef.current;
      if (!editor) return;
      const start = matches[nextIndex];
      editor.focus();
      editor.setSelectionRange(start, start + searchQuery.length);
    });
  };

  const replaceCurrentMatch = () => {
    if (!activeChapter || !searchQuery) return;
    const matches: number[] = [];
    let cursor = 0;
    while (cursor < activeChapter.content.length) {
      const index = activeChapter.content.indexOf(searchQuery, cursor);
      if (index < 0) break;
      matches.push(index);
      cursor = index + Math.max(1, searchQuery.length);
    }
    if (!matches.length) {
      setNotice({ title: '没有可替换内容', content: `本章没有“${searchQuery}”。` });
      return;
    }
    const targetStart = matches[Math.min(searchMatchIndex, matches.length - 1)];
    handleUpdateChapterContent(`${activeChapter.content.slice(0, targetStart)}${replaceQuery}${activeChapter.content.slice(targetStart + searchQuery.length)}`);
    setNotice({ title: '已替换一处', content: `已将“${searchQuery}”替换为“${replaceQuery}”。` });
  };

  const replaceAllMatches = () => {
    if (!activeChapter || !searchQuery) return;
    const count = countOccurrences(activeChapter.content, searchQuery);
    if (!count) {
      setNotice({ title: '没有可替换内容', content: `本章没有“${searchQuery}”。` });
      return;
    }
    handleUpdateChapterContent(activeChapter.content.split(searchQuery).join(replaceQuery));
    setSearchMatchIndex(0);
    setNotice({ title: '替换完成', content: `本章已替换 ${count} 处。` });
  };

  const toggleSearchPanel = () => {
    setShowSearchPanel(current => !current);
    window.setTimeout(() => searchInputRef.current?.focus(), 0);
  };

  const openProjectSearch = () => {
    setEditorSidebarTab('search');
    setSearchScope('book');
    setShowSearchPanel(false);
    window.setTimeout(() => searchInputRef.current?.focus(), 0);
  };

  const moveDocumentSearchMatch = (content: string, label: string, direction: 1 | -1) => {
    if (!searchQuery) return;
    const count = countOccurrences(content, searchQuery);
    if (!count) {
      setSearchMatchIndex(0);
      setNotice({ title: '没有找到匹配内容', content: `${label}中没有“${searchQuery}”。` });
      return;
    }
    setSearchMatchIndex(current => (current + direction + count) % count);
  };

  const replaceDocumentCurrentMatch = (content: string, label: string, update: (next: string) => void) => {
    if (!searchQuery) return;
    const matches: number[] = [];
    let cursor = 0;
    while (cursor < content.length) {
      const index = content.indexOf(searchQuery, cursor);
      if (index < 0) break;
      matches.push(index);
      cursor = index + Math.max(1, searchQuery.length);
    }
    if (!matches.length) {
      setNotice({ title: '没有可替换内容', content: `${label}中没有“${searchQuery}”。` });
      return;
    }
    const targetStart = matches[Math.min(searchMatchIndex, matches.length - 1)];
    update(`${content.slice(0, targetStart)}${replaceQuery}${content.slice(targetStart + searchQuery.length)}`);
    setSearchMatchIndex(Math.min(searchMatchIndex, Math.max(0, matches.length - 2)));
    setNotice({ title: '已替换一处', content: `${label}已将“${searchQuery}”替换为“${replaceQuery}”。` });
  };

  const replaceDocumentAllMatches = (content: string, label: string, update: (next: string) => void) => {
    if (!searchQuery) return;
    const count = countOccurrences(content, searchQuery);
    if (!count) {
      setNotice({ title: '没有可替换内容', content: `${label}中没有“${searchQuery}”。` });
      return;
    }
    update(content.split(searchQuery).join(replaceQuery));
    setSearchMatchIndex(0);
    setNotice({ title: '替换完成', content: `${label}已替换 ${count} 处。` });
  };

  const renderDocumentSearchPanel = (label: string, content: string, update: (next: string) => void) => {
    if (!showSearchPanel) return null;
    const matchCount = searchQuery ? countOccurrences(content, searchQuery) : 0;
    return <section className="search-panel document-search-panel" aria-label={`${label}搜索与替换`}>
      <div className="search-panel-row">
        <input ref={searchInputRef} className="input" value={searchQuery} placeholder={`搜索${label}内容`} onChange={event => { setSearchQuery(event.target.value); setSearchMatchIndex(0); setBookSearchMatchIndex(0); }} />
        <button className="editor-tool-button" title="上一处匹配" aria-label="上一处匹配" onClick={() => moveDocumentSearchMatch(content, label, -1)} disabled={!searchQuery}><Icon name="chevron-up" size={13} /></button>
        <button className="editor-tool-button" title="下一处匹配" aria-label="下一处匹配" onClick={() => moveDocumentSearchMatch(content, label, 1)} disabled={!searchQuery}><Icon name="chevron-down" size={13} /></button>
        <button className="icon-delete" title="关闭搜索" onClick={() => setShowSearchPanel(false)}><Icon name="x" size={14} /></button>
      </div>
      <div className="search-panel-row replace-row">
        <input className="input" value={replaceQuery} placeholder="替换为" onChange={event => setReplaceQuery(event.target.value)} />
        <button className="editor-tool-button" onClick={() => replaceDocumentCurrentMatch(content, label, update)} disabled={!searchQuery}>替换</button>
        <button className="editor-tool-button" onClick={() => replaceDocumentAllMatches(content, label, update)} disabled={!searchQuery}>全部替换</button>
        <small>{matchCount ? `${Math.min(searchMatchIndex + 1, matchCount)} / ${matchCount}` : '无匹配'}</small>
      </div>
    </section>;
  };

  const saveBannedWords = () => {
    const words = Array.from(new Set(bannedWordsDraft.split(/[\n,，、]+/u).map(word => word.trim()).filter(Boolean))).slice(0, 300);
    setBannedWords(words);
    localStorage.setItem('writer-banned-words', JSON.stringify(words));
    setShowBannedWords(false);
    setNotice({ title: '禁词列表已保存', content: `当前共 ${words.length} 个禁词，编辑器会实时标记。` });
  };

  const copyText = async (content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      setNotice({ title: '已复制', content: '文本已复制到剪贴板。' });
    } catch {
      setNotice({ title: '复制失败', content: '当前系统未允许访问剪贴板，请手动选择文本复制。' });
    }
  };

  const lastActiveChapterIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (activeChapter?.id !== lastActiveChapterIdRef.current) {
      lastActiveChapterIdRef.current = activeChapter?.id ?? null;
      setCopiedTitle(false);
      setCopiedContent(false);
      setCopiedAuthorNote(false);
      setCopiedCombined(false);
      setShowCopyDropdown(false);
      if (activeChapter?.authorNote?.trim()) {
        setAuthorNoteExpanded(true);
      }
    }
  }, [activeChapter]);

  useEffect(() => {
    return () => {
      if (titleCopyTimerRef.current) window.clearTimeout(titleCopyTimerRef.current);
      if (contentCopyTimerRef.current) window.clearTimeout(contentCopyTimerRef.current);
      if (authorNoteCopyTimerRef.current) window.clearTimeout(authorNoteCopyTimerRef.current);
      if (combinedCopyTimerRef.current) window.clearTimeout(combinedCopyTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!showCopyDropdown) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (copyMenuRef.current && !copyMenuRef.current.contains(event.target as Node)) {
        setShowCopyDropdown(false);
      }
    };
    window.addEventListener('mousedown', handleClickOutside);
    return () => window.removeEventListener('mousedown', handleClickOutside);
  }, [showCopyDropdown]);

  const selectCopyPreset = (preset: PlatformFormatPreset) => {
    setCopyPreset(preset);
    try {
      localStorage.setItem('novel_copy_preset', preset);
    } catch {
      // 忽略本地存储异常
    }
  };

  const copyChapterTitle = async () => {
    if (!activeChapter || !activeChapter.title.trim()) {
      setNotice({ title: '标题为空', content: '当前章节暂无标题可复制。' });
      return;
    }
    try {
      await navigator.clipboard.writeText(activeChapter.title.trim());
      setCopiedTitle(true);
      if (titleCopyTimerRef.current) window.clearTimeout(titleCopyTimerRef.current);
      titleCopyTimerRef.current = window.setTimeout(() => setCopiedTitle(false), 2000);
      setNotice({ title: '标题已复制', content: `《${activeChapter.title.trim()}》已复制到剪贴板，可直接粘贴到发布平台。` });
    } catch {
      setNotice({ title: '复制失败', content: '当前系统未允许访问剪贴板，请手动选择文本复制。' });
    }
  };

  const copyChapterContent = async (presetOverride?: PlatformFormatPreset) => {
    if (!activeChapter || !activeChapter.content.trim()) {
      setNotice({ title: '正文为空', content: '当前章节暂无正文可复制。' });
      return;
    }
    const preset = presetOverride || copyPreset;
    const formatted = formatNovelForPlatform(activeChapter.content, preset);
    try {
      await navigator.clipboard.writeText(formatted);
      setCopiedContent(true);
      setShowCopyDropdown(false);
      if (contentCopyTimerRef.current) window.clearTimeout(contentCopyTimerRef.current);
      contentCopyTimerRef.current = window.setTimeout(() => setCopiedContent(false), 2000);
      const label = platformFormatPresetLabels[preset].split('（')[0];
      setNotice({ title: '正文已复制', content: `当前章节正文（${label}，共 ${activeChapter.wordCount.toLocaleString()} 字）已复制到剪贴板，可直接粘贴到发布平台。` });
    } catch {
      setNotice({ title: '复制失败', content: '当前系统未允许访问剪贴板，请手动选择文本复制。' });
    }
  };

  const copyAuthorNote = async () => {
    if (!activeChapter || !activeChapter.authorNote?.trim()) {
      setNotice({ title: '作家的话为空', content: '当前章节暂无作家的话可复制。' });
      return;
    }
    try {
      await navigator.clipboard.writeText(activeChapter.authorNote.trim());
      setCopiedAuthorNote(true);
      setShowCopyDropdown(false);
      if (authorNoteCopyTimerRef.current) window.clearTimeout(authorNoteCopyTimerRef.current);
      authorNoteCopyTimerRef.current = window.setTimeout(() => setCopiedAuthorNote(false), 2000);
      setNotice({ title: '作家的话已复制', content: `作家的话（共 ${countNovelCharacters(activeChapter.authorNote).toLocaleString()} 字）已复制到剪贴板，可粘贴到发布平台的作者寄语区。` });
    } catch {
      setNotice({ title: '复制失败', content: '当前系统未允许访问剪贴板，请手动选择文本复制。' });
    }
  };

  const copyCombinedContent = async (presetOverride?: PlatformFormatPreset) => {
    if (!activeChapter || (!activeChapter.content.trim() && !activeChapter.authorNote?.trim())) {
      setNotice({ title: '内容为空', content: '当前章节暂无正文或作家的话可复制。' });
      return;
    }
    const preset = presetOverride || copyPreset;
    const combined = combineContentAndAuthorNote(activeChapter.content, activeChapter.authorNote, preset);
    try {
      await navigator.clipboard.writeText(combined);
      setCopiedCombined(true);
      setShowCopyDropdown(false);
      if (combinedCopyTimerRef.current) window.clearTimeout(combinedCopyTimerRef.current);
      combinedCopyTimerRef.current = window.setTimeout(() => setCopiedCombined(false), 2000);
      setNotice({ title: '正文与作话已合并复制', content: '正文及末尾附加的【作家的话】已合并复制到剪贴板。' });
    } catch {
      setNotice({ title: '复制失败', content: '当前系统未允许访问剪贴板，请手动选择文本复制。' });
    }
  };

  const runAITool = async (mode: 'polish' | 'de-ai' | 'continue') => {
    if (!editingProject || !activeChapter || aiToolRunning) return;
    if (!agentConfig.enabled || !agentConfig.apiKey.trim()) {
      setNotice({ title: '需要 API Key', content: '请先在设置中配置可用模型。' });
      return;
    }
    const target = Number(editingProject.chapterTargetWords) || 3000;
    const currentCount = countNovelCharacters(activeChapter.content);
    if (mode === 'continue') {
      const maxWords = Math.max(0, Math.floor(target * 1.2 - currentCount));
      if (!maxWords) {
        setNotice({ title: '已达到续写上限', content: `本章目标 ${target} 字，最多续写到 ${Math.floor(target * 1.2)} 字。` });
        return;
      }
      const chapterIndex = editingProject.chapters.findIndex(chapter => chapter.id === activeChapter.id);
      const previous = editingProject.chapters[chapterIndex - 1];
      if (!previous && currentCount < 200) {
        setNotice({ title: '正文太短', content: '第一章至少写满 200 字后才可以续写。' });
        return;
      }
      setAIToolResult(null);
      setAIToolMode('continue');
      setAIToolRunning(true);
      try {
        const result = await agentRpc<{ content?: string }>('text.transform', {
            mode,
            instruction: aiToolInstruction.trim(),
            content: activeChapter.content,
            previousChapter: previous?.content?.slice(-6000) || '',
            maxWords,
            projectTitle: editingProject.title,
            chapterTitle: activeChapter.title,
            apiKey: agentConfig.apiKey.trim(),
            baseURL: agentConfig.baseURL.trim(), model: agentConfig.model.trim() || fallbackModels[0],
            apiMode: agentConfig.apiMode, reasoningMode: agentConfig.reasoningMode, contextWindow: agentConfig.contextWindow, ...agentNetworkParams(agentConfig),
          });
        const content = result.content?.trim() || '';
        if (!content) throw new Error('模型没有返回续写内容');
        setAIToolResult({ mode, content, projectId: editingProject.id, chapterId: activeChapter.id, scope: 'chapter', maxWords });
      } catch (error) { setNotice({ title: 'AI 续写失败', content: String(error) }); }
      finally { setAIToolRunning(false); }
      return;
    }
    const element = chapterEditorRef.current;
    const liveStart = element?.selectionStart ?? 0;
    const liveEnd = element?.selectionEnd ?? 0;
    const savedSelectionValid = selectionSnapshot
      && selectionSnapshot.end > selectionSnapshot.start
      && activeChapter.content.slice(selectionSnapshot.start, selectionSnapshot.end) === selectionSnapshot.source;
    const start = liveEnd > liveStart ? liveStart : savedSelectionValid ? selectionSnapshot.start : 0;
    const end = liveEnd > liveStart ? liveEnd : savedSelectionValid ? selectionSnapshot.end : 0;
    const source = end > start ? activeChapter.content.slice(start, end) : activeChapter.content;
    if (!source.trim()) {
      setNotice({ title: '没有可润色内容', content: '请在章节中输入内容或选中一段文字。' });
      return;
    }
    setAIToolMode(mode);
    setAIToolRunning(true);
    setAIToolResult(null);
    try {
      const result = await agentRpc<{ content?: string }>('text.transform', {
          mode, instruction: aiToolInstruction.trim(), content: source,
          projectTitle: editingProject.title, chapterTitle: activeChapter.title,
          apiKey: agentConfig.apiKey.trim(),
          baseURL: agentConfig.baseURL.trim(), model: agentConfig.model.trim() || fallbackModels[0],
          apiMode: agentConfig.apiMode, reasoningMode: agentConfig.reasoningMode, contextWindow: agentConfig.contextWindow, ...agentNetworkParams(agentConfig),
        });
      const content = result.content?.trim() || '';
      if (!content) throw new Error(`模型没有返回${mode === 'de-ai' ? '去 AI 味' : '润色'}内容`);
      setAIToolResult({
        mode,
        content,
        projectId: editingProject.id,
        chapterId: activeChapter.id,
        scope: end > start ? 'selection' : 'chapter',
        source,
        start,
        end,
      });
    } catch (error) { setNotice({ title: mode === 'de-ai' ? '去 AI 味失败' : 'AI 润色失败', content: String(error) }); }
    finally { setAIToolRunning(false); }
  };

  const acceptAIToolResult = async () => {
    if (!aiToolResult) return;
    const targetProject = projects.find(project => project.id === aiToolResult.projectId)
      || (editingProject?.id === aiToolResult.projectId ? editingProject : null);
    const targetChapter = targetProject?.chapters.find(chapter => chapter.id === aiToolResult.chapterId);
    if (!targetProject || !targetChapter) {
      setNotice({ title: '无法写入结果', content: '原章节已不存在，未覆盖任何内容。' });
      return;
    }

    let nextContent = targetChapter.content;
    if (aiToolResult.mode === 'continue') {
      nextContent = `${targetChapter.content}${targetChapter.content.trim() ? '\n\n' : ''}${aiToolResult.content}`;
    } else if (aiToolResult.scope === 'chapter') {
      nextContent = aiToolResult.content;
    } else {
      const source = aiToolResult.source || '';
      const matchesOriginalRange = aiToolResult.start !== undefined
        && aiToolResult.end !== undefined
        && targetChapter.content.slice(aiToolResult.start, aiToolResult.end) === source;
      if (matchesOriginalRange) {
        nextContent = `${targetChapter.content.slice(0, aiToolResult.start)}${aiToolResult.content}${targetChapter.content.slice(aiToolResult.end)}`;
      } else {
        const currentIndex = source ? targetChapter.content.indexOf(source) : -1;
        if (currentIndex < 0) {
          setNotice({ title: '原段落已变更', content: '为避免覆盖你在生成期间的编辑，未替换正文。请重新选择该段后再处理。' });
          return;
        }
        nextContent = `${targetChapter.content.slice(0, currentIndex)}${aiToolResult.content}${targetChapter.content.slice(currentIndex + source.length)}`;
      }
    }

    const now = new Date().toISOString();
    // 润色 / 去 AI 味 / 续写都会重写正文，覆盖前先压入一条历史版本
    const toolReason = aiToolResult.mode === 'continue' ? 'AI 续写' : aiToolResult.mode === 'de-ai' ? '去 AI 味' : 'AI 润色';
    const updatedChapter: Chapter = { ...pushChapterSnapshot(targetChapter, toolReason), content: nextContent, wordCount: countNovelCharacters(nextContent), updatedAt: now };
    const updatedChapters = targetProject.chapters.map(chapter => chapter.id === updatedChapter.id ? updatedChapter : chapter);
    const updatedProject: Project = {
      ...targetProject,
      chapters: updatedChapters,
      wordCount: updatedChapters.reduce((sum, chapter) => sum + chapter.wordCount, 0),
      updatedAt: now,
    };
    const nextProjects = projects.some(project => project.id === updatedProject.id)
      ? projects.map(project => project.id === updatedProject.id ? updatedProject : project)
      : [...projects, updatedProject];

    setProjects(nextProjects);
    if (editingProject?.id === updatedProject.id) setEditingProject(updatedProject);
    if (activeChapter?.id === updatedChapter.id) setActiveChapter(updatedChapter);
    setAutoSaveStatus('saving');
    setAIToolResult(null);
    setAIToolMode(null);
    setAIToolInstruction('');

    try {
      if ('__TAURI_INTERNALS__' in window) {
        await nativeClient.saveProjects(nextProjects);
      } else {
        localStorage.setItem('projects', JSON.stringify(nextProjects));
      }
      setAutoSaveStatus('saved');
      setNotice({ title: aiToolResult.mode === 'continue' ? '续写已插入章节' : aiToolResult.mode === 'de-ai' ? '去 AI 味已替换章节内容' : '润色已替换章节内容', content: '正文已写入并保存到本地。' });
    } catch (error) {
      setAutoSaveStatus('error');
      setNotice({ title: '正文已更新但保存失败', content: String(error) });
    }
  };

  const updateChapterTargetWords = () => {
    if (!editingProject) return;
    const target = Math.max(200, Math.min(100000, Number(chapterTargetWordsDraft) || 3000));
    updateEditorProject(project => ({ ...project, chapterTargetWords: target, updatedAt: new Date().toISOString() }));
    setChapterTargetWordsDraft(String(target));
    setNotice({ title: '章节目标已更新', content: `当前章节目标设为 ${target} 字，续写上限为 ${Math.floor(target * 1.2)} 字。` });
  };

  const cardSearchTerms = (card: KnowledgeCard) => {
    const generic = new Set([
      '角色', '角色卡', '人物', '人物卡', '物品', '物品卡', '地点', '地点卡', '势力', '势力卡',
      '金手指', '金手指卡', '手指', '身份', '性格', '目标', '能力', '天赋', '关系', '当前状态',
      '详细信息', '暂无', '设定', '限制', '代价', '升级路径', '触发条件', '核心能力',
    ]);
    const primaryTerms: string[] = [];
    const secondaryTerms = new Set<string>();
    const addPrimary = (value: string) => {
      const normalized = value.replace(/^[#*\-\s]+|[#*\-\s]+$/gu, '').replace(/[“”"']/gu, '').trim();
      if (normalized.length >= 2 && normalized.length <= 24 && !generic.has(normalized) && !primaryTerms.includes(normalized)) primaryTerms.push(normalized);
    };
    const addSecondary = (value: string) => {
      const normalized = value.replace(/^[#*\-\s]+|[#*\-\s]+$/gu, '').trim();
      if (normalized.length >= 2 && normalized.length <= 12 && !generic.has(normalized) && !primaryTerms.includes(normalized)) secondaryTerms.add(normalized);
    };
    if (!generic.has(card.title.trim())) addPrimary(card.title);
    const canonicalTitle = card.title.replace(/^(主角|角色|人物|本命|关键|核心)/u, '').trim();
    if (!generic.has(canonicalTitle)) addPrimary(canonicalTitle);
    if (!generic.has(canonicalTitle) && /^[\u3400-\u9fff]{3,}$/u.test(canonicalTitle)) {
      addPrimary(canonicalTitle.slice(-2));
      if (canonicalTitle.length > 3) addPrimary(canonicalTitle.slice(-3));
    }
    const identityPattern = /^\s*(?:[-*]\s*)?(?:姓名|名称|本名|别名|称号|代号|简称|天赋名称|能力名称)\s*[：:]\s*(.+)$/gmu;
    for (const match of card.content.matchAll(identityPattern)) {
      for (const value of match[1].split(/[、,，;；/]/u)) addPrimary(value.replace(/[（(].*$/u, '').trim());
    }
    const abilityHeadingPattern = /^\s*#{2,6}\s*(?:[^\n：:]{0,24}[：:])\s*([^\n]+)$/gmu;
    for (const match of card.content.matchAll(abilityHeadingPattern)) {
      for (const value of match[1].split(/[、,，;；/]/u)) addPrimary(value.replace(/[（(].*$/u, '').trim());
    }
    for (const segment of `${card.title}\n${card.content}`.match(/[\u3400-\u9fff]{2,10}|[A-Za-z][A-Za-z0-9_-]{1,24}/g) || []) {
      addSecondary(segment);
    }
    return [...primaryTerms, ...[...secondaryTerms].sort((left, right) => right.length - left.length)].slice(0, 40);
  };

  const findCardRecentMentions = (project: Project, card: KnowledgeCard, limit = 3) => {
    const terms = cardSearchTerms(card);
    const mentions: Array<{ chapter: Chapter; matchedTerm: string; snippet: string; position: number }> = [];
    for (const chapter of [...project.chapters].reverse()) {
      const positions = terms.flatMap(term => {
        const found: Array<{ term: string; position: number }> = [];
        let position = chapter.content.indexOf(term);
        while (position >= 0 && found.length < 8) {
          found.push({ term, position });
          position = chapter.content.indexOf(term, position + term.length);
        }
        return found;
      }).sort((left, right) => right.position - left.position);
      for (const match of positions.slice(0, limit)) {
        const { position, term: matchedTerm } = match;
        const start = Math.max(0, position - 70);
        const end = Math.min(chapter.content.length, position + matchedTerm.length + 150);
        mentions.push({ chapter, matchedTerm, position, snippet: chapter.content.slice(start, end).replace(/\s+/gu, ' ').trim() });
      }
    }
    return mentions.slice(0, limit);
  };

  const refreshCardStatesForProject = (project: Project, cardIds?: Set<number>) => {
    const now = new Date().toISOString();
    const targetCards = cardIds ? project.cards.filter(card => cardIds.has(card.id)) : project.cards;
    if (!targetCards.length) return project;
    const graphNodes = [...project.graphNodes];
    const graphEdges = [...project.graphEdges];
    project.cards.forEach(card => {
      if (!graphNodes.some(node => node.id === `card:${card.id}`)) {
        graphNodes.push({ id: `card:${card.id}`, label: card.title, type: 'card', category: card.type });
      }
    });
    const cards = project.cards.map(card => {
      if (!targetCards.some(target => target.id === card.id)) return card;
      const recentMentions = findCardRecentMentions(project, card, 3);
      const mention = recentMentions[0] ?? null;
      const status = mention ? '最近出现' : '未在正文中定位';
      const changes = mention
        ? recentMentions.map(item => `第 ${project.chapters.findIndex(chapter => chapter.id === item.chapter.id) + 1} 章《${item.chapter.title}》出现“${item.matchedTerm}”：${item.snippet}`).join('\n')
        : '当前全文未检索到可定位的卡片名称或关键词。';
      const lastEntry = card.stateHistory?.[card.stateHistory.length - 1];
      const stateHistory = lastEntry?.changes === changes ? (card.stateHistory || []) : [
        ...(card.stateHistory || []),
        { chapterId: mention?.chapter.id ?? 0, chapterTitle: mention?.chapter.title ?? '全文检索', status, changes, updatedAt: now },
      ].slice(-30);
      for (const item of recentMentions) {
        const chapterNodeId = `chapter:${item.chapter.id}`;
        if (!graphNodes.some(node => node.id === chapterNodeId)) graphNodes.push({ id: chapterNodeId, label: item.chapter.title, type: 'chapter' });
        const edgeId = `${chapterNodeId}->card:${card.id}:状态引用`;
        upsertKnowledgeGraphEdge(graphEdges, { id: edgeId, source: chapterNodeId, target: `card:${card.id}`, label: '状态引用', weight: 0.88, updatedAt: now });
      }
      return { ...card, currentState: changes, stateHistory, updatedAt: now };
    });
    return { ...project, cards, graphNodes, graphEdges, updatedAt: now };
  };

  const updateCardStatesFromBook = async (cardId?: number) => {
    if (!editingProject) return;
    let searchProject = editingProject;
    // 章节正文以 Markdown 文件为事实来源；刷新前重新载入一次，避免只扫描启动时的元数据快照。
    if ('__TAURI_INTERNALS__' in window) {
      try {
        const loadedProjects = await nativeClient.loadProjects<Project>();
        const loadedProject = loadedProjects?.find(project => project.id === editingProject.id);
        if (loadedProject) searchProject = { ...editingProject, chapters: loadedProject.chapters };
      } catch (error) {
        setNotice({ title: '读取本地章节失败', content: String(error) });
      }
    }
    if (activeChapter && searchProject.chapters.some(chapter => chapter.id === activeChapter.id)) {
      searchProject = { ...searchProject, chapters: searchProject.chapters.map(chapter => chapter.id === activeChapter.id ? activeChapter : chapter) };
    }
    const targetCards = cardId === undefined ? searchProject.cards : searchProject.cards.filter(card => card.id === cardId);
    if (!targetCards.length) return;
    const refreshedProject = refreshCardStatesForProject(searchProject, new Set(targetCards.map(card => card.id)));
    setEditingProject(refreshedProject);
    setProjects(current => current.map(project => project.id === refreshedProject.id ? refreshedProject : project));
    setNotice({ title: cardId === undefined ? '卡片状态已更新' : '卡片状态已更新', content: `已全文检索并更新 ${targetCards.length} 张卡片的最近出现状态。` });
  };

  const buildProjectWithChapterMemory = (project: Project, chapter: Chapter, memoryPatch: Partial<ChapterMemory>) => {
    const hasContent = chapter.content.trim().length > 0;
    const updatedChapters = project.chapters.map(item => item.id === chapter.id ? chapter : item);
    const chapterNodeId = `chapter:${chapter.id}`;
    const chapterNumber = project.chapters.findIndex(item => item.id === chapter.id) + 1;
    const mentionedCards = project.cards.filter(card => cardSearchTerms(card).some(term => chapter.content.includes(term)));
    const referencedCards = project.cards.filter(card => selectedCardIds.includes(card.id) || mentionedCards.some(item => item.id === card.id));
    const graphNodes = [...project.graphNodes];
    const ensureNode = (id: string, label: string, type: KnowledgeGraphNode['type'], category?: string) => {
      const index = graphNodes.findIndex(node => node.id === id);
      if (index >= 0) graphNodes[index] = { ...graphNodes[index], label, type, category: category || graphNodes[index].category };
      else graphNodes.push({ id, label, type, category, content: createGraphNodeProfile(type, category), updatedAt: new Date().toISOString() });
    };
    project.cards.forEach(card => ensureNode(`card:${card.id}`, card.title, 'card', card.type));
    project.outlines.forEach(outline => ensureNode(`outline:${outline.id}`, outline.title, 'outline', outline.kind));
    [project.protagonist1, project.protagonist2].filter((name): name is string => Boolean(name?.trim())).forEach(name => ensureNode(`entity:${name.trim()}`, name.trim(), 'entity', '人物'));
    if (hasContent) ensureNode(chapterNodeId, chapter.title, 'chapter');
    else {
      const index = graphNodes.findIndex(node => node.id === chapterNodeId);
      if (index >= 0) graphNodes.splice(index, 1);
    }
    const graphEdges = project.graphEdges.filter(edge => edge.source !== chapterNodeId && edge.target !== chapterNodeId);
    if (hasContent) {
      referencedCards.forEach(card => {
        const id = `${chapterNodeId}->card:${card.id}`;
        const label = selectedCardIds.includes(card.id) ? '本章引用' : '正文提及';
        graphEdges.push({ id, source: chapterNodeId, target: `card:${card.id}`, label, weight: defaultKnowledgeGraphWeight(label), sourceChapterId: chapter.id, updatedAt: new Date().toISOString() });
      });
      [project.protagonist1, project.protagonist2].flatMap(name => typeof name === 'string' && name.trim() ? [name.trim()] : []).filter(name => chapter.content.includes(name)).forEach(name => {
        const target = `entity:${name.trim()}`;
        graphEdges.push({ id: `${chapterNodeId}->${target}`, source: chapterNodeId, target, label: '章节主角', weight: 0.92, sourceChapterId: chapter.id, updatedAt: new Date().toISOString() });
      });
    }
    const cards = project.cards.map(card => {
      if (!hasContent || !referencedCards.some(item => item.id === card.id)) return card;
      const matchedTerm = cardSearchTerms(card).find(term => chapter.content.includes(term)) || card.title;
      const position = chapter.content.lastIndexOf(matchedTerm);
      const snippet = position >= 0 ? chapter.content.slice(Math.max(0, position - 70), Math.min(chapter.content.length, position + matchedTerm.length + 150)).replace(/\s+/gu, ' ').trim() : '';
      const changes = `第 ${chapterNumber} 章《${chapter.title}》出现“${matchedTerm}”：${snippet}`;
      const lastEntry = card.stateHistory?.[card.stateHistory.length - 1];
      const stateHistory = lastEntry?.changes === changes ? (card.stateHistory || []) : [...(card.stateHistory || []), { chapterId: chapter.id, chapterTitle: chapter.title, status: '本章出现', changes, updatedAt: new Date().toISOString() }].slice(-30);
      return { ...card, currentState: changes, stateHistory, updatedAt: new Date().toISOString() };
    });
    const existingMemory = project.memories.find(memory => memory.chapterId === chapter.id);
    const memories = hasContent ? [
      ...project.memories.filter(memory => memory.chapterId !== chapter.id),
      normalizeChapterMemory({
        ...existingMemory,
        ...memoryPatch,
        id: existingMemory?.id ?? Date.now(),
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        createdAt: existingMemory?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sourceChapterNumber: project.chapters.findIndex(item => item.id === chapter.id) + 1,
      }, chapter),
    ] : project.memories.filter(memory => memory.chapterId !== chapter.id);
    return {
      ...project,
      chapters: updatedChapters,
      cards,
      wordCount: updatedChapters.reduce((sum, item) => sum + item.wordCount, 0),
      memories,
      memoryDocuments: buildMemoryDocuments(memories, project.memoryDocuments),
      graphNodes,
      graphEdges,
      updatedAt: new Date().toISOString(),
    };
  };

  // 将章节记忆 Agent 抽取的实体和关系增量合并到本地知识图谱。
  const mergeKnowledgeGraph = (project: Project, chapter: Chapter, result: AgentMemoryResult): Project => {
    const chapterNodeId = `chapter:${chapter.id}`;
    const nodes = [...project.graphNodes];
    const edges = normalizeKnowledgeGraphEdges(project.graphEdges);
    const now = new Date().toISOString();
    let cards = project.cards;
    const findNodeId = (label: string) => nodes.find(node => node.label === label)?.id
      || project.cards.find(card => cardSearchTerms(card).includes(label))?.id.toString().replace(/^/, 'card:');
    const ensureEntity = (label: string, category = '实体') => {
      const normalized = label.trim().slice(0, 80);
      if (!normalized) return null;
      const existingId = findNodeId(normalized);
      if (existingId) return existingId;
      const id = `entity:${normalized}`;
      nodes.push({ id, label: normalized, type: 'entity', category, content: createGraphNodeProfile('entity', category), updatedAt: new Date().toISOString() });
      return id;
    };
    const chapterNode = nodes.find(node => node.id === chapterNodeId);
    if (!chapterNode && chapter.content.trim()) nodes.push({ id: chapterNodeId, label: chapter.title, type: 'chapter', content: createGraphNodeProfile('chapter'), updatedAt: now });
    project.cards.forEach(card => {
      if (!nodes.some(node => node.id === `card:${card.id}`)) nodes.push({ id: `card:${card.id}`, label: card.title, type: 'card', category: card.type, content: createGraphNodeProfile('card', card.type), updatedAt: now });
    });
    project.outlines.forEach(outline => {
      if (!nodes.some(node => node.id === `outline:${outline.id}`)) nodes.push({ id: `outline:${outline.id}`, label: outline.title, type: 'outline', category: outline.kind, content: createGraphNodeProfile('outline', outline.kind), updatedAt: now });
    });
    for (const entity of result.entities || []) {
      const id = ensureEntity(String(entity.name || ''), String(entity.type || '实体'));
      if (!id) continue;
      const edgeId = `${chapterNodeId}->${id}`;
      upsertKnowledgeGraphEdge(edges, { id: edgeId, source: chapterNodeId, target: id, label: '章节提及', weight: 0.7, sourceChapterId: chapter.id, updatedAt: now });
    }
    for (const relation of result.relations || []) {
      const sourceLabel = String(relation.source || '').trim();
      const targetLabel = String(relation.target || '').trim();
      if (!sourceLabel || !targetLabel) continue;
      const source = findNodeId(sourceLabel) || ensureEntity(sourceLabel);
      const target = findNodeId(targetLabel) || ensureEntity(targetLabel);
      if (!source || !target || source === target) continue;
      const label = String(relation.label || '关联').trim().slice(0, 40) || '关联';
      const edgeId = `${source}->${target}:${label}`;
      upsertKnowledgeGraphEdge(edges, { id: edgeId, source, target, label, weight: normalizeKnowledgeGraphWeight(relation.weight, label), sourceChapterId: chapter.id, updatedAt: now });
    }
    for (const update of result.cardUpdates || []) {
      const card = cards.find(item => (update.cardId !== undefined && String(item.id) === String(update.cardId)) || (update.cardTitle && item.title === update.cardTitle));
      const changes = String(update.changes || '').trim();
      if (!card || !changes) continue;
      const status = String(update.status || 'updated').trim();
      const lastEntry = card.stateHistory?.[card.stateHistory.length - 1];
      const stateHistory = lastEntry?.changes === changes ? (card.stateHistory || []) : [...(card.stateHistory || []), { chapterId: chapter.id, chapterTitle: chapter.title, status, changes, updatedAt: now }].slice(-30);
      cards = cards.map(item => item.id === card.id ? { ...item, currentState: changes, stateHistory, updatedAt: now } : item);
      const cardNodeId = `card:${card.id}`;
      const edgeId = `${chapterNodeId}->${cardNodeId}:状态更新`;
      upsertKnowledgeGraphEdge(edges, { id: edgeId, source: chapterNodeId, target: cardNodeId, label: '状态更新', weight: 0.95, sourceChapterId: chapter.id, updatedAt: now });
    }
    return { ...project, cards, graphNodes: nodes, graphEdges: edges, updatedAt: now };
  };

  const persistCurrentChapter = async () => {
    if (!editingProject || !activeChapter || chapterSaving) return;
    setChapterSaving(true);
    const now = new Date().toISOString();
    const chapter: Chapter = {
      ...activeChapter,
      content: activeChapter.content,
      wordCount: countNovelCharacters(activeChapter.content),
      updatedAt: now,
    };
    const currentMemory = editingProject.memories.find(memory => memory.chapterId === chapter.id);
    const localStructuredMemory = buildLocalStructuredMemory(chapter, editingProject);
    const selectedKeywords = editingProject.cards.filter(card => selectedCardIds.includes(card.id)).map(card => card.title);
    const keywords = selectedKeywords.length ? selectedKeywords : (currentMemory?.keywords?.length ? currentMemory.keywords : localStructuredMemory.keywords);
    const localProjectWithMemory = buildProjectWithChapterMemory(editingProject, chapter, {
      ...localStructuredMemory,
      keywords,
    });
    const cardsToRefresh = new Set(localProjectWithMemory.cards
      .filter(card => selectedCardIds.includes(card.id) || cardSearchTerms(card).some(term => chapter.content.includes(term)))
      .map(card => card.id));
    const localProject = refreshCardStatesForProject(localProjectWithMemory, cardsToRefresh);
    const saveProject = async (project: Project) => {
      const snapshot = projects.map(item => item.id === project.id ? project : item);
      setProjects(snapshot);
      setEditingProject(project);
      setActiveChapter(chapter);
      if ('__TAURI_INTERNALS__' in window) {
        await nativeClient.saveProjects(snapshot);
      } else {
        localStorage.setItem('projects', JSON.stringify(snapshot));
      }
    };

    try {
      await saveProject(localProject);
    } catch (error) {
      setNotice({ title: '章节保存失败', content: String(error) });
      setChapterSaving(false);
      return;
    }

    if (!chapter.content.trim() || !agentConfig.enabled || !agentConfig.apiKey.trim()) {
      setNotice({ title: '章节已保存', content: chapter.content.trim() ? '章节和本地章节记忆已更新。' : '空章节已保存，并移除了本章记忆。' });
      setChapterSaving(false);
      return;
    }

    if (Date.now() < memoryQuotaRetryAt) {
      const remainingMinutes = Math.max(1, Math.ceil((memoryQuotaRetryAt - Date.now()) / 60_000));
      setNotice({ title: '章节已保存', content: `正文和本地章节记忆已更新；API 中转额度暂不可用，本章智能摘要将在 ${remainingMinutes} 分钟后可再次更新。` });
      setChapterSaving(false);
      return;
    }

    // 本地章节已经保存，AI 记忆只处理当前章节，并在后台增量更新。
    // 这样网络中转变慢或返回 502 时不会阻塞编辑器的保存按钮。
    setChapterSaving(false);
    setNotice({ title: '章节已保存', content: '章节已写入本地，正在后台更新本章记忆。' });
    void (async () => {
      try {
        const result = await agentRpc<AgentMemoryResult>('memory.write', {
            projectTitle: localProject.title,
            chapterTitle: chapter.title,
            content: chapter.content,
            cards: localProject.cards.filter(card => selectedCardIds.includes(card.id) || (card.title.trim() && chapter.content.includes(card.title))).slice(0, 10),
            apiKey: agentConfig.apiKey.trim(),
              baseURL: agentConfig.baseURL.trim(),
            model: agentConfig.model.trim() || fallbackModels[0],
            apiMode: agentConfig.apiMode,
            reasoningMode: agentConfig.reasoningMode,
            contextWindow: agentConfig.contextWindow,
            knowledgeGraph: { nodes: localProject.graphNodes, edges: localProject.graphEdges },
            ...agentNetworkParams(agentConfig),
          });
        const summary = result.summary?.trim() || localStructuredMemory.summary;
        const aiKeywords = Array.isArray(result.keywords) && result.keywords.length ? asTextList(result.keywords, 8) : keywords;
        const aiStructuredFieldCount = [
          result.characterStateChanges,
          result.knowledgeChanges,
          result.foreshadowingChanges,
          result.timelineEvents,
          result.canonFacts,
          result.conflicts,
        ].filter(value => asTextList(value).length > 0).length + (result.endingHook?.trim() ? 1 : 0);
        // A complete model response is used as one coherent classification.
        // Mixing individual local heuristic fields into it made iOS memories
        // noticeably less precise than desktop memories.
        const useCoherentAIResult = aiStructuredFieldCount >= 3;
        const preferAIList = (value: unknown, fallback: string[], existing: string[] | undefined) => {
          const extracted = asTextList(value);
          if (useCoherentAIResult) return extracted;
          return extracted.length ? extracted : (fallback.length ? fallback : (existing || []));
        };
        const memoryPatch = {
          summary,
          keywords: aiKeywords,
          characterStateChanges: preferAIList(result.characterStateChanges, localStructuredMemory.characterStateChanges, currentMemory?.characterStateChanges),
          knowledgeChanges: preferAIList(result.knowledgeChanges, localStructuredMemory.knowledgeChanges, currentMemory?.knowledgeChanges),
          foreshadowingChanges: preferAIList(result.foreshadowingChanges, localStructuredMemory.foreshadowingChanges, currentMemory?.foreshadowingChanges),
          foreshadowingItems: Array.isArray(result.foreshadowingItems) ? result.foreshadowingItems : [],
          timelineEvents: preferAIList(result.timelineEvents, localStructuredMemory.timelineEvents, currentMemory?.timelineEvents),
          canonFacts: preferAIList(result.canonFacts, localStructuredMemory.canonFacts, currentMemory?.canonFacts),
          conflicts: preferAIList(result.conflicts, localStructuredMemory.conflicts, currentMemory?.conflicts),
          endingHook: typeof result.endingHook === 'string' && result.endingHook.trim() ? result.endingHook.trim() : (localStructuredMemory.endingHook || currentMemory?.endingHook || ''),
        };
        // 如果用户在等待期间又编辑了本章，丢弃过期摘要，避免覆盖新正文。
        setProjects(currentProjects => {
          const latestProject = currentProjects.find(project => project.id === localProject.id);
          const latestChapter = latestProject?.chapters.find(item => item.id === chapter.id);
          if (!latestProject || !latestChapter || latestChapter.updatedAt !== chapter.updatedAt) return currentProjects;
          const memoryProject = buildProjectWithChapterMemory(latestProject, latestChapter, memoryPatch);
          const refreshedMemoryProject = refreshCardStatesForProject(memoryProject, new Set(memoryProject.cards
            .filter(card => selectedCardIds.includes(card.id) || cardSearchTerms(card).some(term => latestChapter.content.includes(term)))
            .map(card => card.id)));
          const mergedBase = mergeKnowledgeGraph(refreshedMemoryProject, latestChapter, result);
          const resultCardIds = (result.cardUpdates || [])
            .map(update => mergedBase.cards.find(card => (update.cardId !== undefined && String(card.id) === String(update.cardId)) || (update.cardTitle && card.title === update.cardTitle))?.id)
            .filter((id): id is number => id !== undefined);
          const merged = {
            ...refreshCardStatesForProject(mergedBase, new Set([...resultCardIds, ...selectedCardIds])),
            authorPreferences: Array.from(new Set([...(latestProject.authorPreferences || []), ...asTextList(result.authorPreferences, 8)])).slice(-20),
          };
          setEditingProject(current => current?.id === merged.id ? merged : current);
          setActiveChapter(current => current?.id === latestChapter.id ? latestChapter : current);
          const nextProjects = currentProjects.map(project => project.id === merged.id ? merged : project);
          if ('__TAURI_INTERNALS__' in window) {
            void nativeClient.saveProjects(nextProjects);
          } else {
            localStorage.setItem('projects', JSON.stringify(nextProjects));
          }
          return nextProjects;
        });
        setNotice({ title: '章节记忆更新完成', content: '本章结构化摘要已写入本地；若期间再次编辑，旧摘要会被自动丢弃。' });
      } catch (error) {
        if (isQuotaExceededError(error)) {
          memoryQuotaRetryAt = Date.now() + memoryQuotaCooldownMs;
          setNotice({ title: '章节已保存', content: '正文和本地章节记忆已更新；API 中转额度已用尽，本章智能摘要会在额度恢复后再更新。' });
          return;
        }
        setNotice({ title: '章节已保存', content: `本章记忆暂未更新：${String(error)}。正文和本地快照不受影响。` });
      }
    })();
  };

  persistCurrentChapterRef.current = persistCurrentChapter;

  const updateEditorProject = (updater: (project: Project) => Project) => {
    if (!editingProject) return;
    setEditingProject(updater(editingProject));
  };

  const startNewProjectAgentSession = () => {
    const project = editingProjectRef.current;
    if (!project || projectAgentRunning) return;
    const sessionId = projectAgentSessionId();
    localStorage.setItem(`project-agent-current-session:${project.id}`, sessionId);
    setProjectAgentSession(createProjectAgentSession(project.id, sessionId));
    setProjectAgentInput('');
    setProjectAgentActivity([]);
    setProjectAgentProgress(0);
  };

  const runProjectAgentChat = async () => {
    const project = editingProjectRef.current;
    const session = projectAgentSessionRef.current;
    const instruction = projectAgentInput.trim();
    if (!project || !session || !instruction || projectAgentRunning) return;
    if (!agentConfig.enabled || !agentConfig.apiKey.trim()) {
      setNotice({ title: '需要 API Key', content: '请先在设置中填写模型 API Key，再运行项目 Agent。' });
      return;
    }
    const userMessage: ProjectAgentMessage = { id: `message-${Date.now()}-user`, role: 'user', content: instruction, createdAt: new Date().toISOString() };
    const runId = `project-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    projectAgentRunRef.current = runId;
    // 发送时无条件回到底部：作者刚输入完，一定是在看最新一轮
    projectAgentPinnedRef.current = true;
    setProjectAgentInput('');
    setProjectAgentRunning(true);
    setProjectAgentProgress(1);
    setProjectAgentActivity([{ id: 'starting', message: '正在启动项目 Agent', status: 'active' }]);
    setProjectAgentSession(current => current ? { ...current, messages: [...current.messages, userMessage], updatedAt: new Date().toISOString() } : current);
    try {
      await invoke<string>('start_agent_runtime');
      const activeStyle = project.styleProfileId ? writingStyles.find(style => style.id === project.styleProfileId) : undefined;
      const result = await agentRpc<ProjectAgentResponse>('project.agent.chat', {
          runId,
          sessionId: session.sessionId,
          mode: session.mode,
          instruction,
          project,
          activeChapterId: activeChapter?.id,
          history: session.messages.slice(-12).map(message => ({
            role: message.role,
            // 失败的委派只写在 toolEvents 里。不把它带回历史，作者说“刚刚那章失败了，再试一次”时，
            // 模型手上只有自己那段“已完成修订”的场面话，根本不知道是哪一章没做成，只能回答做不到
            content: [message.content, ...(message.toolEvents || []).filter(event => event.status === 'error').map(event => `[本轮未完成] ${event.message}`)].join('\n'),
          })),
          writingStyle: activeStyle ? { name: activeStyle.name, content: activeStyle.content } : undefined,
          skills: skills.map(skill => ({ name: skill.name, displayName: 'displayName' in skill ? skill.displayName : undefined, category: skill.category, description: skill.description, tags: skill.tags, content: skill.content })),
          apiKey: agentConfig.apiKey.trim(),
          baseURL: agentConfig.baseURL.trim(),
          model: agentConfig.model.trim() || fallbackModels[0],
          apiMode: agentConfig.apiMode,
          reasoningMode: agentConfig.reasoningMode,
          contextWindow: agentConfig.contextWindow,
          ...agentNetworkParams(agentConfig),
        });
      const latestProject = editingProjectRef.current;
      if (!latestProject || latestProject.id !== project.id) throw new Error('当前小说已切换，已丢弃旧项目 Agent 回复');
      const proposed = Array.isArray(result.changes)
        ? result.changes.map((change, index) => normalizeProjectAgentChange(change, latestProject, index)).filter((change): change is ProjectAgentChange => Boolean(change))
        : [];
      const assistantMessage: ProjectAgentMessage = {
        id: `message-${Date.now()}-assistant`,
        role: 'assistant',
        content: typeof result.message === 'string' && result.message.trim() ? result.message.trim() : (proposed.length ? `已生成 ${proposed.length} 项待确认变更。` : '任务已完成。'),
        createdAt: new Date().toISOString(),
        toolEvents: Array.isArray(result.toolEvents) ? result.toolEvents.filter(event => event && typeof event.tool === 'string' && typeof event.message === 'string').slice(0, 30) : [],
        changeIds: proposed.map(change => change.id),
      };
      setProjectAgentSession(current => current ? {
        ...current,
        messages: [...current.messages, assistantMessage].slice(-200),
        changes: [...current.changes, ...proposed].slice(-80),
        updatedAt: new Date().toISOString(),
      } : current);
      setProjectAgentProgress(100);
    } catch (error) {
      const message = String(error);
      setProjectAgentSession(current => current ? {
        ...current,
        messages: [...current.messages, { id: `message-${Date.now()}-error`, role: 'assistant' as const, content: message, createdAt: new Date().toISOString(), error: true }].slice(-200),
        updatedAt: new Date().toISOString(),
      } : current);
      setProjectAgentActivity(current => [...current.map(item => item.status === 'active' ? { ...item, status: 'complete' as const } : item), { id: `error-${Date.now()}`, message, status: 'error' as const }].slice(-20));
    } finally {
      setProjectAgentRunning(false);
    }
  };

  const applyPendingProjectAgentChanges = async (ids?: string[]) => {
    const currentProject = editingProjectRef.current;
    const session = projectAgentSessionRef.current;
    if (!currentProject || !session || projectAgentRunning) return;
    const selected = ids ? new Set(ids) : null;
    const pending = session.changes.filter(change => change.status === 'pending' && (!selected || selected.has(change.id)));
    try {
      const result = applyProjectAgentChangeBatch(currentProject, pending);
      const nextProjects = projectsRef.current.map(project => project.id === result.project.id ? result.project : project);
      if ('__TAURI_INTERNALS__' in window) await nativeClient.saveProjects(nextProjects);
      else localStorage.setItem('projects', JSON.stringify(nextProjects));
      setProjects(nextProjects);
      setEditingProject(result.project);
      if (result.createdChapterId) {
        const chapter = result.project.chapters.find(item => item.id === result.createdChapterId) || null;
        setActiveChapter(chapter);
        setEditorSidebarTab('chapters');
      } else if (activeChapter) {
        // 当前章被删或被修订时都要重新取，否则编辑器还持有旧对象
        setActiveChapter(result.project.chapters.find(item => item.id === activeChapter.id) || result.project.chapters[0] || null);
      }
      const appliedIds = new Set(pending.map(change => change.id));
      const appliedTargets = new Set(pending.map(projectAgentChangeTargetKey));
      setProjectAgentSession(current => current ? {
        ...current,
        changes: current.changes.map(change => {
          if (appliedIds.has(change.id)) return { ...change, status: 'applied' };
          if (change.status !== 'pending' || appliedTargets.has(projectAgentChangeTargetKey(change))) return change;
          return projectAgentRebase(change, result.project);
        }),
        updatedAt: new Date().toISOString(),
      } : current);
      setNotice({ title: '项目 Agent 变更已应用', content: `已写入 ${pending.length} 项变更${result.deletedChapterIds.length ? `，其中删除 ${result.deletedChapterIds.length} 个章节` : ''}。` });
    } catch (error) {
      setNotice({ title: '无法应用项目 Agent 变更', content: String(error) });
    }
  };

  const dismissProjectAgentChanges = (ids?: string[]) => {
    const selected = ids ? new Set(ids) : null;
    setProjectAgentSession(current => current ? {
      ...current,
      changes: current.changes.map(change => change.status === 'pending' && (!selected || selected.has(change.id)) ? { ...change, status: 'dismissed' } : change),
      updatedAt: new Date().toISOString(),
    } : current);
  };

  const parseChineseChapterNumber = (value: string): number | undefined => {
    const normalized = value.replace(/\s+/gu, '');
    if (/^\d+$/u.test(normalized)) return Number(normalized);
    const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    let total = 0;
    let pendingDigit = 0;
    let hasDigit = false;
    for (const char of normalized) {
      if (digits[char] !== undefined) {
        pendingDigit = digits[char];
        hasDigit = true;
        continue;
      }
      const unit = char === '十' ? 10 : char === '百' ? 100 : char === '千' ? 1000 : 0;
      if (!unit) return undefined;
      total += (pendingDigit || 1) * unit;
      pendingDigit = 0;
    }
    return hasDigit || total ? total + pendingDigit : undefined;
  };

  const chapterNumberFromText = (value: string) => {
    const match = value.match(/第\s*(\d+|[零〇一二三四五六七八九十百千]+)\s*章/u);
    return match ? parseChineseChapterNumber(match[1]) : undefined;
  };

  /** Old chapter outlines may not have a chapterId. Recover it from their title
   * before an agent run, rather than letting the model infer a chapter from
   * unrelated outline history. */
  const chapterBoundToOutline = (project: Project, outline: OutlineDocument): Chapter | undefined => {
    const byId = typeof outline.chapterId === 'number'
      ? project.chapters.find(chapter => chapter.id === outline.chapterId)
      : undefined;
    if (byId) return byId;
    const chapterNumber = chapterNumberFromText(`${outline.title}\n${outline.content.slice(0, 500)}`);
    if (!chapterNumber) return undefined;
    return project.chapters.find(chapter => chapterNumberFromText(chapter.title) === chapterNumber)
      || project.chapters[chapterNumber - 1];
  };

  const chapterByNumber = (project: Project, number: number | undefined): Chapter | undefined => {
    if (!number || number < 1) return undefined;
    return project.chapters.find(chapter => chapterNumberFromText(chapter.title) === number)
      || project.chapters[number - 1];
  };

  const outlineByChapterNumber = (project: Project, number: number | undefined): OutlineDocument | undefined => {
    if (!number || number < 1) return undefined;
    return project.outlines.find(outline => outline.kind === '章纲'
      && chapterNumberFromText(`${outline.title}\n${outline.content.slice(0, 500)}`) === number)
      || project.outlines.find(outline => outline.kind === '章纲'
        && String(outline.chapterId ?? '') === String(project.chapters[number - 1]?.id ?? ''));
  };

  const instructionChapterNumber = (instruction: string, pattern: RegExp): number | undefined => {
    const matched = instruction.match(pattern)?.slice(1).find(Boolean);
    return matched ? parseChineseChapterNumber(matched) : undefined;
  };

  const resolveOutlineGenerationIntent = (project: Project, activeOutline: OutlineDocument, instruction: string) => {
    const sourcePattern = /(?:根据|基于|参考|按|以)\s*第?\s*(\d+|[零〇一二三四五六七八九十百千]+)\s*章(?:的)?(?:正文|内容)|第?\s*(\d+|[零〇一二三四五六七八九十百千]+)\s*章(?:的)?(?:正文|内容)\s*(?:生成|编写|补全|整理|反推|制作)/u;
    const sourceMatched = instruction.match(sourcePattern);
    const explicitSourceNumber = sourceMatched
      ? parseChineseChapterNumber(sourceMatched[1] || sourceMatched[2])
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

  const handleCreateOutline = (kind: OutlineKind) => {
    if (!editingProject) return;
    const now = new Date().toISOString();
    // 章纲按项目内已有章节/章纲的最大序号递增，避免新建时重复落在当前选中章节。
    const chapterNumber = (value: string) => chapterNumberFromText(value) || 0;
    const nextChapterNumber = kind === '章纲'
      ? Math.max(
        0,
        ...editingProject.chapters.map(chapter => chapterNumber(chapter.title)),
        ...editingProject.outlines.filter(outline => outline.kind === '章纲').map(outline => chapterNumber(`${outline.title}\n${outline.content}`)),
      ) + 1
      : 0;
    const nextChapter = kind === '章纲'
      ? editingProject.chapters.find(chapter => chapterNumber(chapter.title) === nextChapterNumber)
      : undefined;
    const chapterId = nextChapter?.id;
    const chapterTitle = kind === '章纲' ? (nextChapter?.title || `第 ${nextChapterNumber} 章`) : undefined;
    const outlineTitle = kind === '章纲' ? `章纲｜${chapterTitle}` : kind;
    const outline: OutlineDocument = {
      id: Date.now(),
      kind,
      chapterId,
      title: outlineTitle,
      content: `# ${kind}${chapterTitle ? `｜${chapterTitle}` : ''}\n\n`,
      createdAt: now,
      updatedAt: now,
    };
    updateEditorProject(project => ({
      ...project,
      outlines: [...project.outlines, outline],
      graphNodes: [...project.graphNodes, { id: `outline:${outline.id}`, label: outline.kind, type: 'outline' }],
      updatedAt: now,
    }));
    setActiveOutlineId(outline.id);
  };

  const updateActiveOutline = (patch: Partial<OutlineDocument>) => {
    if (!editingProject || activeOutlineId === null) return;
    const now = new Date().toISOString();
    updateEditorProject(project => ({
      ...project,
      outlines: project.outlines.map(outline => outline.id === activeOutlineId ? { ...outline, ...patch, updatedAt: now } : outline),
      updatedAt: now,
    }));
  };

  const handleDeleteOutline = (id: number) => {
    if (!editingProject) return;
    updateEditorProject(project => ({
      ...project,
      outlines: project.outlines.filter(outline => outline.id !== id),
      graphNodes: project.graphNodes.filter(node => node.id !== `outline:${id}`),
      graphEdges: project.graphEdges.filter(edge => edge.source !== `outline:${id}` && edge.target !== `outline:${id}`),
      updatedAt: new Date().toISOString(),
    }));
    if (activeOutlineId === id) setActiveOutlineId(editingProject.outlines.find(outline => outline.id !== id)?.id ?? null);
  };

  const generateOutline = async () => {
    if (!editingProject || activeOutlineId === null || outlineGenerating) return;
    const outline = editingProject.outlines.find(item => item.id === activeOutlineId);
    if (!outline) return;
    if (!agentConfig.enabled || !agentConfig.apiKey.trim()) {
      setNotice({ title: '需要 API Key', content: '请先在设置中填写 API Saver Key，再生成大纲。' });
      return;
    }
    setAgentError('');
    setOutlineGenerating(true);
    const runId = `outline-${Date.now()}`; outlineRunRef.current = runId; outlineStreamRawRef.current = ''; setOutlineStreamContent('');
    setOutlineAgentActivity([{ id: 'starting', step: 'starting', message: '正在启动大纲智能体', status: 'active' }]);
    setOutlineChatMessages(current => [...current, { role: 'user', content: outlineAgentInstruction.trim(), createdAt: new Date().toISOString() }]);
    try {
      await invoke<string>('start_agent_runtime');
      const activeStyle = editingProject.styleProfileId ? writingStyles.find(style => style.id === editingProject.styleProfileId) : undefined;
      const intent = outline.kind === '章纲' ? resolveOutlineGenerationIntent(editingProject, outline, outlineAgentInstruction) : undefined;
      const targetOutline = intent?.targetOutline || outline;
      const targetChapter = intent?.targetChapter;
      const sourceChapter = intent?.sourceChapter;
      const formatOutline = intent?.formatOutline;
      if (outline.kind === '章纲' && intent?.explicitTargetNumber && !intent.targetRedirectFound && intent.explicitTargetNumber !== chapterNumberFromText(`${outline.title}\n${outline.content.slice(0, 500)}`)) {
        throw new Error(`没有找到第 ${intent.explicitTargetNumber} 章的章纲文档，请先新建或选择该章纲。`);
      }
      if (outline.kind === '章纲' && !sourceChapter && !intent?.isFirstChapter) {
        throw new Error('未找到上一章正文。请先保存上一章正文，或在指令中明确写“根据本章正文”或“根据第 N 章正文”。');
      }
      if (outline.kind === '章纲' && targetChapter && targetOutline.chapterId !== targetChapter.id) {
        updateEditorProject(project => ({
          ...project,
          outlines: project.outlines.map(item => item.id === targetOutline.id ? { ...item, chapterId: targetChapter.id, updatedAt: new Date().toISOString() } : item),
        }));
      }
      const result = await agentRpc<{ content?: string; title?: string }>('outline.write', {
          runId,
          sessionId: outlineSessionId,
          previousSessionId: outlinePreviousSessionId,
          outlineId: targetOutline.id,
          projectId: String(editingProject.id),
          projectTitle: editingProject.title,
          kind: outline.kind,
          existingContent: targetOutline.content,
          targetChapter: targetChapter ? {
            id: targetChapter.id,
            number: chapterNumberFromText(targetChapter.title) || editingProject.chapters.findIndex(chapter => chapter.id === targetChapter.id) + 1,
            title: targetChapter.title,
          } : undefined,
          sourceChapter: sourceChapter ? {
            id: sourceChapter.id,
            number: chapterNumberFromText(sourceChapter.title) || editingProject.chapters.findIndex(chapter => chapter.id === sourceChapter.id) + 1,
            title: sourceChapter.title,
            content: sourceChapter.content,
            mode: intent?.sourceMode,
          } : undefined,
          formatOutline: formatOutline ? {
            id: formatOutline.id,
            title: formatOutline.title,
            content: formatOutline.content,
            mode: intent?.formatMode,
          } : undefined,
          instruction: activeStyle ? `${outlineAgentInstruction.trim()}\n采用绑定文风 Skill「${activeStyle.name}」，只遵循抽象写作约束。` : outlineAgentInstruction.trim(),
          synopsis: editingProject.synopsis,
          cards: editingProject.cards.filter(card => selectedOutlineCardIds.includes(card.id)),
          knowledgeGraph: { nodes: editingProject.graphNodes, edges: editingProject.graphEdges },
          worldSetting: editingProject.outlines
            .filter(item => item.kind === '世界观与作品设定' && item.content.trim())
            .map(item => ({ id: item.id, title: item.title, content: item.content })),
          authorPreferences: editingProject.authorPreferences || [],
          writingStyle: activeStyle ? { name: activeStyle.name, content: activeStyle.content } : undefined,
          skills: [...skills, ...(activeStyle ? [{ name: `style-${activeStyle.id}`, displayName: activeStyle.name, category: 'write', description: activeStyle.description, tags: [...activeStyle.tags, '文风'], content: activeStyle.content }] : [])].map(skill => ({ name: skill.name, displayName: 'displayName' in skill ? skill.displayName : undefined, category: skill.category, description: skill.description, tags: skill.tags, content: skill.content })),
          preferredSkillNames: selectedAgentSkillNames,
          apiKey: agentConfig.apiKey.trim(),
          baseURL: agentConfig.baseURL.trim(),
          model: agentConfig.model.trim() || 'gpt-4o-mini',
          apiMode: agentConfig.apiMode,
          reasoningMode: agentConfig.reasoningMode,
          contextWindow: agentConfig.contextWindow,
          ...agentNetworkParams(agentConfig),
        });
      const generatedContent = result.content || targetOutline.content;
      updateEditorProject(project => ({
        ...project,
        outlines: project.outlines.map(item => item.id === targetOutline.id ? { ...item, content: generatedContent, updatedAt: new Date().toISOString() } : item),
        updatedAt: new Date().toISOString(),
      }));
      setActiveOutlineId(targetOutline.id);
      setOutlineChatMessages(current => [...current, { role: 'assistant', content: generatedContent, createdAt: new Date().toISOString() }]);
      setNotice({ title: '大纲已生成', content: `${targetOutline.title} 已依据${sourceChapter ? `第 ${chapterNumberFromText(sourceChapter.title) || editingProject.chapters.findIndex(chapter => chapter.id === sourceChapter.id) + 1} 章正文` : '作品资料'}生成。` });
    } catch (error) {
      setAgentError(String(error));
      setOutlineAgentActivity(current => [...current.map(item => item.status === 'active' ? { ...item, status: 'complete' as const } : item), { id: `error-${Date.now()}`, step: 'error', message: String(error), status: 'error' as const }].slice(-12));
      setNotice({ title: '大纲生成失败', content: String(error) });
    } finally {
      setOutlineGenerating(false);
    }
  };

  const startNewCard = () => {
    setActiveCardId(null);
    setCardDraft({ type: '角色卡', title: '', content: '' });
  };

  const editCard = (card: KnowledgeCard) => {
    setActiveCardId(card.id);
    setCardDraft({ type: card.type, title: card.title, content: card.content });
  };

  const generateCardWithAI = async () => {
    if (!editingProject || cardGenerating) return;
    if (!agentConfig.enabled || !agentConfig.apiKey.trim()) {
      setNotice({ title: '需要 API Key', content: '请先在设置中填写 API Key，再生成知识卡片。' });
      return;
    }
    setCardGenerating(true);
    const runId = `card-${Date.now()}`; cardRunRef.current = runId; cardStreamRawRef.current = ''; setCardStreamContent('');
    setCardChatMessages(current => [...current, { role: 'user', content: cardAgentInstruction.trim(), createdAt: new Date().toISOString() }]);
    try {
      const result = await agentRpc<{ title?: string; content?: string }>('card.write', {
          runId,
          sessionId: cardSessionId,
          previousSessionId: cardPreviousSessionId,
          projectTitle: editingProject.title,
          synopsis: editingProject.synopsis,
          cardType: cardDraft.type,
          cardTitle: cardDraft.title.trim(),
          existingContent: cardDraft.content,
          instruction: cardAgentInstruction.trim(),
          chapterTitle: activeChapter?.title,
          chapterContent: activeChapter?.content?.slice(-6000),
          outlines: editingProject.outlines.slice(-4).map(outline => ({ kind: outline.kind, content: outline.content })),
          cards: editingProject.cards.filter(card => card.id !== activeCardId).slice(-8),
          apiKey: agentConfig.apiKey.trim(),
          baseURL: agentConfig.baseURL.trim(),
          model: agentConfig.model.trim() || fallbackModels[0],
          apiMode: agentConfig.apiMode,
          reasoningMode: agentConfig.reasoningMode,
          contextWindow: agentConfig.contextWindow,
          ...agentNetworkParams(agentConfig),
        });
      if (!result.content?.trim()) throw new Error('智能体没有返回卡片内容');
      setCardDraft(current => ({
        ...current,
        title: result.title?.trim() || current.title || `${current.type}设定`,
        content: result.content?.trim() || '',
      }));
      setCardChatMessages(current => [...current, { role: 'assistant', content: result.content?.trim() || '', createdAt: new Date().toISOString() }]);
      setNotice({ title: '卡片草稿已生成', content: '内容已填入左侧编辑器，请检查后点击“保存卡片”。' });
    } catch (error) {
      setNotice({ title: '卡片生成失败', content: String(error) });
    } finally {
      setCardGenerating(false);
    }
  };

  const saveCard = () => {
    if (!editingProject || !cardDraft.title.trim() || !cardDraft.content.trim()) {
      setNotice({ title: '卡片信息不完整', content: '请填写卡片名称和详细知识内容。' });
      return;
    }
    const now = new Date().toISOString();
    const card: KnowledgeCard = {
      id: activeCardId ?? Date.now(),
      type: cardDraft.type,
      title: cardDraft.title.trim(),
      content: cardDraft.content.trim(),
      currentState: activeCardId ? editingProject.cards.find(item => item.id === activeCardId)?.currentState : undefined,
      stateHistory: activeCardId ? editingProject.cards.find(item => item.id === activeCardId)?.stateHistory : undefined,
      createdAt: activeCardId ? (editingProject.cards.find(item => item.id === activeCardId)?.createdAt ?? now) : now,
      updatedAt: now,
    };
    updateEditorProject(project => ({
      ...project,
      cards: activeCardId ? project.cards.map(item => item.id === activeCardId ? card : item) : [...project.cards, card],
      graphNodes: project.graphNodes.some(node => node.id === `card:${card.id}`)
        ? project.graphNodes.map(node => node.id === `card:${card.id}` ? { ...node, label: card.title } : node)
        : [...project.graphNodes, { id: `card:${card.id}`, label: card.title, type: 'card' }],
      updatedAt: now,
    }));
    setActiveCardId(card.id);
    setNotice({ title: '卡片已保存', content: `${card.title} 已写入本地知识库。` });
  };

  const deleteCard = (id: number) => {
    if (!editingProject) return;
    updateEditorProject(project => ({
      ...project,
      cards: project.cards.filter(card => card.id !== id),
      graphNodes: project.graphNodes.filter(node => node.id !== `card:${id}`),
      graphEdges: project.graphEdges.filter(edge => edge.source !== `card:${id}` && edge.target !== `card:${id}`),
      updatedAt: new Date().toISOString(),
    }));
    setSelectedCardIds(current => current.filter(cardId => cardId !== id));
    if (activeCardId === id) startNewCard();
  };

  const toggleCardForChapter = (id: number) => {
    setSelectedCardIds(current => current.includes(id) ? current.filter(cardId => cardId !== id) : [...current, id]);
  };

  const runAIDetection = (scope: 'chapter' | 'book') => {
    if (!editingProject) return;
    if (scope === 'chapter' && !activeChapter) {
      setNotice({ title: '请选择章节', content: '选择章节后再运行当前章节 AI 检测。' });
      return;
    }
    setAIDetecting(true);
    const report = buildAIDetectionReport(editingProject, scope, activeChapter || undefined);
    updateEditorProject(project => ({ ...project, aiDetection: report, updatedAt: report.updatedAt }));
    setAIDetecting(false);
    setNotice({ title: 'AI 检测完成', content: `已分析 ${report.chapters.length} 个章节，预估 AI 率 ${report.averageAIRate}%。` });
  };

  const runChapterAgent = async () => {
    if (!editingProject || !activeChapter || agentRunning(agentStage)) return;
    if (!agentConfig.enabled || !agentConfig.apiKey.trim()) {
      setAgentError('请先填写 API Saver Key');
      setAgentStage('error');
      return;
    }
    const runId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    activeAgentRunRef.current = runId;
    setAgentError('');
    setAgentDraft(null);
    setAgentDisplayContent('');
    setAgentDraftTitle('');
    agentStreamRawContentRef.current = '';
    setAgentStage('starting');
    setContextTrace([]);
    setAgentProgress(createAgentProgressItems().map((item, index) => index === 0
      ? { ...item, status: 'active', progress: 1, message: '正在启动 Agent Runtime' }
      : item));
    setAgentProgressPercent(1);
    setAgentProgressMessage('正在启动 Agent Runtime');
    let agentSkills = skills;
    if (!agentSkills.length) {
      try {
        const saved = JSON.parse(localStorage.getItem('writer-skills') || '[]');
        const customSkills = Array.isArray(saved) ? saved.filter((skill): skill is Skill => Boolean(skill && typeof skill.name === 'string' && !skill.builtin)) : [];
        agentSkills = [...builtinSkills, ...customSkills];
      } catch {
        agentSkills = builtinSkills;
      }
    }
    const prioritizedSkillNames = selectedAgentSkillNames.filter(name => agentSkills.some(skill => skill.name === name));
    const activeChapterIndex = editingProject.chapters.findIndex(chapter => chapter.id === activeChapter.id);
    const continuityChapter = activeChapterIndex > 0 ? editingProject.chapters[activeChapterIndex - 1] : null;
    const activeStyle = editingProject.styleProfileId ? writingStyles.find(style => style.id === editingProject.styleProfileId) : undefined;
    // 世界观与作品设定 is fixed canon and always available. 总纲 is never
    // exposed to the chapter writer, preventing future-plot leakage.
    const selectedChapterOutlines = editingProject.outlines.filter(outline => outline.kind === '章纲' && selectedOutlineIds.includes(outline.id));
    const currentChapterOutline = selectedChapterOutlines.find(outline => String(outline.chapterId ?? '') === String(activeChapter.id)) || selectedChapterOutlines[0];
    const selectedOutlines = editingProject.outlines.filter(outline => outline.kind === '世界观与作品设定' || selectedOutlineIds.includes(outline.id));
    const previousMemory = continuityChapter ? editingProject.memories.find(memory => memory.chapterId === continuityChapter.id) : undefined;
    try {
      await invoke<string>('start_agent_runtime');
      setAgentProgress(items => items.map(item => item.id === 'starting'
        ? { ...item, status: 'active', progress: Math.max(item.progress, 2), message: '运行环境已就绪，正在发送创作任务' }
        : item));
      setAgentProgressPercent(current => Math.max(current, 2));
      setAgentProgressMessage('运行环境已就绪，正在发送创作任务');
      const result = await agentRpc<AgentDraftResult>('chapter.write', {
          runId,
          sessionId: chapterSessionId,
          previousSessionId: chapterPreviousSessionId,
          projectId: String(editingProject.id),
          projectTitle: editingProject.title,
          chapterId: String(activeChapter.id),
          instruction: activeStyle ? `${agentInstruction}\n采用绑定文风 Skill「${activeStyle.name}」，只遵循抽象写作约束。` : agentInstruction,
          outlines: selectedOutlines.map(outline => ({ id: outline.id, kind: outline.kind, title: outline.title, chapterId: outline.chapterId, content: outline.content })),
          activeOutlineId: currentChapterOutline?.id,
          outline: selectedOutlineIds.includes(currentChapterOutline?.id ?? -1) ? currentChapterOutline?.content || '' : '',
          cards: editingProject.cards.filter(card => selectedCardIds.includes(card.id)),
          knowledgeGraph: { nodes: editingProject.graphNodes, edges: editingProject.graphEdges },
          skills: [...agentSkills, ...(activeStyle ? [{ name: `style-${activeStyle.id}`, category: 'write', description: activeStyle.description, tags: [...activeStyle.tags, '文风'], content: activeStyle.content }] : [])]
            .map(skill => ({ name: skill.name, displayName: 'displayName' in skill ? skill.displayName : undefined, category: skill.category, description: skill.description, tags: skill.tags, content: skill.content })),
          preferredSkillNames: prioritizedSkillNames,
          // 章节承接只传入紧邻上一章正文；更早章节只通过用户勾选的结构化记忆进入。
          previousChapters: continuityChapter ? [{ id: continuityChapter.id, title: continuityChapter.title, content: continuityChapter.content }] : [],
          memories: (previousMemory ? [previousMemory] : []).map(memory => ({
            id: memory.id,
            title: memory.chapterTitle,
            summary: memory.summary,
            keywords: memory.keywords,
            characterStateChanges: memory.characterStateChanges,
            knowledgeChanges: memory.knowledgeChanges,
            foreshadowingChanges: memory.foreshadowingChanges,
            timelineEvents: memory.timelineEvents,
            canonFacts: memory.canonFacts,
            conflicts: memory.conflicts,
            endingHook: memory.endingHook,
          })),
          memoryDocuments: [],
          apiKey: agentConfig.apiKey.trim(),
          baseURL: agentConfig.baseURL.trim(),
          model: agentConfig.model.trim() || 'gpt-4o-mini',
          apiMode: agentConfig.apiMode,
          reasoningMode: agentConfig.reasoningMode,
          contextWindow: agentConfig.contextWindow,
          ...agentNetworkParams(agentConfig),
        });
      // The completed RPC result is the source of truth. It must replace the
      // streaming buffer because JSON envelopes can be split across SSE frames.
      // 标题行属于标题栏、不属于正文：拆出来单独带走
      // 运行时已经在图里拆过一次，这里再兜一次——非流式回退或模型二次补标题时也能拿到章节名
      const draft = splitChapterTitleHeading(chapterDraftFromStream(result.draftContent || ''));
      const draftContent = draft.content;
      // 运行时的信封 title 优先（它已做过清洗和命名兵底），非流式回退时才用正文开头剥下来的那行
      const normalizedResult = { ...result, draftContent, chapterTitle: result.chapterTitle || draft.title };
      setAgentDraft(normalizedResult);
      setAgentDisplayContent(draftContent);
      // 标题当场算好并展示：作者接受前能看见、能改，不用写入后才发现标题标还是占位章号
      setAgentDraftTitle(applyDraftChapterTitle(activeChapter.title, normalizedResult.chapterTitle || ''));
      agentStreamRawContentRef.current = '';
      // SSE chunks are already rendered by the shared stream listener. The
      // completed result is authoritative when the provider falls back to a
      // non-streaming response.
      if (agentTypewriterRef.current) {
        window.clearInterval(agentTypewriterRef.current);
        agentTypewriterRef.current = null;
      }
      await syncRuntimeUsage();
      setAgentStage('done');
      setAgentProgressPercent(100);
      setAgentProgressMessage('章节草稿和一致性审查已完成');
      setAgentProgress(items => items.map(item => ({ ...item, status: 'complete', progress: Math.max(item.progress, 100) })));
    } catch (error) {
      const message = String(error);
      setAgentError(message);
      setAgentStage('error');
      setAgentProgressMessage(message);
      setAgentProgress(items => {
        const activeIndex = Math.max(0, items.findIndex(item => item.status === 'active'));
        return items.map((item, index) => index === activeIndex ? { ...item, status: 'error', message } : item);
      });
    }
  };

  const acceptAgentDraft = () => {
    if (!agentDraft?.draftContent) return;
    if (editingProject && activeChapter) {
      const now = new Date().toISOString();
      // 写入前再剥一次标题行：预览框可手改，手改后同样不该把 # 标题存进正文
      const draft = splitChapterTitleHeading(agentDraft.draftContent);
      const chapterContent = draft.content;
      // 标题栏里的值是作者看得见也改得动的那一个，优先级最高；
      // 它被清空才回退到正文开头剥下来的标题行与运行时给的章节名，且只补占位标题
      const draftTitle = agentDraftTitle.trim()
        || applyDraftChapterTitle(activeChapter.title, draft.title || agentDraft.chapterTitle || '');
      const updatedChapter: Chapter = {
        // 采用草稿会覆盖现有正文，先存快照
        ...pushChapterSnapshot(activeChapter, 'Agent 草稿'),
        title: draftTitle.slice(0, 160),
        content: chapterContent,
        wordCount: countNovelCharacters(chapterContent),
        updatedAt: now,
      };
      const selectedCards = editingProject.cards.filter(card => selectedCardIds.includes(card.id));
      const updatedWithMemory = buildProjectWithChapterMemory(editingProject, updatedChapter, {
        summary: agentDraft.summary || buildLocalChapterSummary(agentDraft.draftContent),
        keywords: selectedCards.map(card => card.title),
      });
      const updated = refreshCardStatesForProject(updatedWithMemory, new Set(updatedWithMemory.cards
        .filter(card => selectedCardIds.includes(card.id) || cardSearchTerms(card).some(term => updatedChapter.content.includes(term)))
        .map(card => card.id)));
      setEditingProject(updated);
      setActiveChapter(updatedChapter);
      setProjects(current => current.map(project => project.id === updated.id ? updated : project));
      window.setTimeout(() => chapterEditorRef.current?.focus(), 0);
    }
    setAgentDraft(null);
    setAgentDisplayContent('');
    setAgentDraftTitle('');
    setAgentStage('idle');
    setAgentProgress([]);
    setAgentProgressPercent(0);
    setAgentProgressMessage('');
    activeAgentRunRef.current = '';
  };

  const openSettings = () => {
    setSettingsDraft(agentConfig);
    setSettingsModels(availableModels);
    setCustomModelName('');
    setModelListMessage('');
    setSettingsServiceExpanded(true);
    const selectedProject = editingProject || projects.find(project => project.id === githubProjectId) || projects[0];
    if (selectedProject) {
      setGithubProjectId(selectedProject.id);
      setGithubRepositoryUrl(selectedProject.githubRepositoryUrl || '');
    }
    setShowSettingsModal(true);
    setSettingsSection('model');
  };

  const checkCloudSyncStatus = async () => {
    setCloudSyncRunning(true);
    setCloudSyncMessage('正在检查百度网盘登录状态...');
    try {
      const result = await invoke<{ raw?: string; authenticated?: boolean; is_login?: boolean; logged_in?: boolean; username?: string }>('cloud_sync_status');
      const loggedIn = result.authenticated === true || result.is_login === true || result.logged_in === true || /已登录|logged.?in|success/iu.test(result.raw || '');
      setCloudSyncMessage(loggedIn
        ? `百度网盘已登录${result.username ? `：${result.username}` : ''}`
        : isDirectBaiduRuntime() ? '百度网盘当前未登录，请点击“登录百度网盘”完成授权。' : '百度网盘工具已安装，但当前未登录，请先完成百度网盘授权。');
    } catch (error) {
      setCloudSyncMessage(String(error));
    } finally {
      setCloudSyncRunning(false);
    }
  };

  const beginBaiduLogin = async () => {
    setCloudSyncRunning(true);
    setCloudSyncMessage('正在获取百度网盘授权链接...');
    try {
      const url = await invoke<string>('baidu_login_url');
      if (!/^https?:\/\//iu.test(url.trim())) throw new Error('百度网盘没有返回有效授权链接');
      setBaiduAuthURL(url.trim());
      setCloudSyncMessage(isDirectBaiduRuntime()
        ? '请复制链接到浏览器完成授权，再粘贴地址栏中的完整授权结果或 access_token。'
        : '请在浏览器完成授权，然后将页面显示的 32 位授权码粘贴到下方。');
    } catch (error) {
      setCloudSyncMessage(String(error));
    } finally {
      setCloudSyncRunning(false);
    }
  };

  const confirmBaiduLogin = async () => {
    if (!baiduAuthCode.trim()) { setCloudSyncMessage(isDirectBaiduRuntime() ? '请先粘贴授权结果。' : '请先粘贴授权码。'); return; }
    setCloudSyncRunning(true);
    setCloudSyncMessage('正在验证百度网盘授权...');
    try {
      await invoke('complete_baidu_login', { code: baiduAuthCode.trim() });
      setBaiduAuthCode('');
      setBaiduAuthURL('');
      setCloudSyncMessage('百度网盘登录成功，可以开始备份与恢复。');
    } catch (error) {
      setCloudSyncMessage(String(error));
    } finally {
      setCloudSyncRunning(false);
    }
  };

  const selectGithubProject = (projectId: number) => {
    const project = projects.find(item => item.id === projectId);
    setGithubProjectId(project?.id ?? null);
    setGithubRepositoryUrl(project?.githubRepositoryUrl || '');
  };

  const describeGithubMerge = (merge: GithubMergeResult) => {
    const names = (titles: string[]) => `${titles.slice(0, 3).join('、')}${titles.length > 3 ? ' 等' : ''}`;
    return [
      merge.addedChapters.length ? `补回 ${merge.addedChapters.length} 章（${names(merge.addedChapters)}）` : '',
      merge.updatedChapters.length ? `采用远端 ${merge.updatedChapters.length} 章（${names(merge.updatedChapters)}）` : '',
      merge.conflictChapters.length ? `${merge.conflictChapters.length} 章两边都改过，已保留本地正文，远端版本在该章“历史版本”里（${names(merge.conflictChapters)}）` : '',
      merge.otherUpdates ? `补回大纲/卡片/记忆/图谱 ${merge.otherUpdates} 条` : '',
    ].filter(Boolean).join('；');
  };

  /**
   * 备份前先把远端已有内容合并进本地。备份本身是“清空托管目录再拷本地”，
   * 两台电脑写同一本书时不合并就会把另一端的章节和记忆整段覆盖掉。
   * ponytail: 这里会多克隆一次仓库（合并一次、后端备份再一次）；等仓库大到拖慢备份，再把合并挪进 Rust 侧复用同一个 checkout
   */
  const mergeGithubBeforeBackup = async (local: Project, repositoryUrl: string): Promise<GithubMergeResult | null> => {
    let remote: GitHubProjectResult;
    try {
      remote = await invoke<GitHubProjectResult>('load_project_from_github', { repositoryUrl });
    } catch {
      // 空仓库、首次备份、仓库里还不是规范备份都会走到这里；真的连不上时后面的备份同样会失败，不会静默覆盖
      return null;
    }
    const incoming = normalizeStoredProject(remote.project);
    // 仓库里换成了另一本书时不合并，交给后端的绑定校验拦下来
    if (incoming.id !== local.id && incoming.title.trim() !== local.title.trim()) return null;
    const merge = mergeGithubProject(local, incoming);
    // 记忆文档是从 memories 生成的，本地没生成过记忆时是一份"暂无已保存章节记忆"的空壳，
    // 而空壳的时间戳往往比远端真内容还新；合并补回 memories 后按同一套模板重新生成才不会被空壳盖掉
    merge.project = { ...merge.project, memoryDocuments: buildMemoryDocuments(merge.project.memories, merge.project.memoryDocuments) };
    return githubMergeChanged(merge) ? merge : null;
  };

  const backupProjectToGithub = async () => {
    const repositoryUrl = githubRepositoryUrl.trim();
    const selected = projects.find(project => project.id === githubProjectId);
    if (!selected) { setCloudSyncMessage('请先选择要备份的小说。'); return; }
    if (!repositoryUrl) { setCloudSyncMessage('请先指定 GitHub 仓库链接。'); return; }
    if (isMobileRuntime()) { setCloudSyncMessage('GitHub Git 同步目前仅支持安装了 Git 的桌面端。'); return; }
    setCloudSyncRunning(true);
    setCloudSyncMessage(`正在比对 GitHub 上已有的《${selected.title}》...`);
    try {
      const local = editingProject?.id === selected.id ? editingProject : selected;
      const merge = await mergeGithubBeforeBackup(local, repositoryUrl);
      const snapshot = merge ? merge.project : local;
      const currentProjects = projects.map(project => project.id === snapshot.id ? snapshot : project);
      await nativeClient.saveProjects(currentProjects);
      if (merge) {
        // 合并结果要立刻回写界面，否则编辑中的旧副本会在下一次本地保存时把合并覆盖掉
        setProjects(currentProjects);
        if (editingProject?.id === snapshot.id) {
          setEditingProject(snapshot);
          setActiveChapter(current => current ? snapshot.chapters.find(chapter => chapter.id === current.id) || current : current);
        }
      }
      setCloudSyncMessage(`正在保存《${snapshot.title}》并准备 Git 提交...`);
      const result = await invoke<{ repositoryUrl: string; branch: string; commit: string; changed: boolean; commitTitle?: string }>('backup_project_to_github', {
        repositoryUrl,
        project: snapshot,
        agentParams: {
          apiKey: agentConfig.apiKey.trim(),
          baseURL: agentConfig.baseURL.trim(),
          model: agentConfig.model.trim() || fallbackModels[0],
          apiMode: agentConfig.apiMode,
          reasoningMode: agentConfig.reasoningMode,
          contextWindow: agentConfig.contextWindow,
          ...agentNetworkParams(agentConfig),
        },
      });
      const linkedProject = { ...snapshot, githubRepositoryUrl: result.repositoryUrl };
      const linkedProjects = currentProjects.map(project => project.id === linkedProject.id ? linkedProject : project);
      await nativeClient.saveProjects(linkedProjects);
      setProjects(linkedProjects);
      if (editingProject?.id === linkedProject.id) setEditingProject(linkedProject);
      setGithubRepositoryUrl(result.repositoryUrl);
      const mergeNote = merge ? `｜已合并远端：${describeGithubMerge(merge)}` : '';
      setCloudSyncMessage(result.changed
        ? `GitHub 备份完成：${result.branch}@${result.commit}${result.commitTitle ? ` · ${result.commitTitle}` : ''}${mergeNote}`
        : `GitHub 已是最新版本：${result.branch}@${result.commit}${mergeNote}`);
    } catch (error) {
      setCloudSyncMessage(String(error));
    } finally {
      setCloudSyncRunning(false);
    }
  };

  const restoreProjectFromGithub = async () => {
    const repositoryUrl = githubRepositoryUrl.trim();
    if (!repositoryUrl) { setCloudSyncMessage('请先指定要恢复的 GitHub 仓库链接。'); return; }
    if (isMobileRuntime()) { setCloudSyncMessage('GitHub Git 同步目前仅支持安装了 Git 的桌面端。'); return; }
    setCloudSyncRunning(true);
    setCloudSyncMessage('正在从 GitHub 拉取并校验小说仓库...');
    try {
      const result = await invoke<GitHubProjectResult>('load_project_from_github', { repositoryUrl });
      const restored = normalizeStoredProject(result.project);
      restored.githubRepositoryUrl = result.repositoryUrl;
      const localProject = projects.find(project => project.id === restored.id)
        || projects.find(project => project.title.trim() === restored.title.trim());
      if (localProject) {
        setGithubRestoreConflict({ project: restored, localProject, repositoryUrl: result.repositoryUrl, commit: result.commit });
        setCloudSyncMessage(`GitHub 中的《${restored.title}》与本地小说重复，请选择恢复方式。`);
        return;
      }
      const nextProjects = [...projects, restored];
      await nativeClient.saveProjects(nextProjects);
      setProjects(nextProjects);
      setGithubProjectId(restored.id);
      setGithubRepositoryUrl(result.repositoryUrl);
      setCloudSyncMessage(`已从 GitHub 新增《${restored.title}》（${result.branch}@${result.commit}）。`);
    } catch (error) {
      setCloudSyncMessage(String(error));
    } finally {
      setCloudSyncRunning(false);
    }
  };

  const completeGithubRestore = async (mode: 'update' | 'copy') => {
    const conflict = githubRestoreConflict;
    if (!conflict) return;
    setCloudSyncRunning(true);
    try {
      let restored: Project;
      let nextProjects: Project[];
      if (mode === 'update') {
        restored = {
          ...conflict.project,
          id: conflict.localProject.id,
          createdAt: conflict.localProject.createdAt,
          githubRepositoryUrl: conflict.repositoryUrl,
        };
        nextProjects = projects.map(project => project.id === conflict.localProject.id ? restored : project);
      } else {
        const nextId = Math.max(Date.now(), ...projects.map(project => project.id + 1));
        const baseTitle = `${conflict.project.title}（GitHub 恢复）`;
        let title = baseTitle;
        let suffix = 2;
        while (projects.some(project => project.title === title)) title = `${baseTitle} ${suffix++}`;
        restored = { ...conflict.project, id: nextId, title, githubRepositoryUrl: undefined, createdAt: new Date().toISOString() };
        nextProjects = [...projects, restored];
      }
      await nativeClient.saveProjects(nextProjects);
      setProjects(nextProjects);
      if (mode === 'update' && editingProject?.id === conflict.localProject.id) {
        setEditingProject(restored);
        setActiveChapter(restored.chapters[0] || null);
      }
      setGithubProjectId(restored.id);
      setGithubRepositoryUrl(restored.githubRepositoryUrl || '');
      setGithubRestoreConflict(null);
      setCloudSyncMessage(mode === 'update'
        ? `已用 GitHub ${conflict.commit} 更新本地《${restored.title}》。`
        : `已从 GitHub 新建本地副本《${restored.title}》。`);
    } catch (error) {
      setCloudSyncMessage(String(error));
    } finally {
      setCloudSyncRunning(false);
    }
  };

  /** 收集备份需要的全部本机状态；云端备份与本地导出共用这一份，两边备份包内容完全一致 */
  const buildBackupClientState = async (): Promise<Record<string, string | null>> => {
    const snapshot = editingProject ? projects.map(project => project.id === editingProject.id ? editingProject : project) : projects;
    await Promise.all([
      nativeClient.saveProjects(snapshot),
      nativeClient.saveLibraryBooks(libraryBooks),
      nativeClient.saveRankingBooks(rankingBooks),
      nativeClient.saveDismantleBooks(dismantleBooks),
      nativeClient.saveWritingStyles(writingStyles),
    ]);
    const backupManifest = {
      schemaVersion: 2,
      createdAt: new Date().toISOString(),
      counts: {
        projects: snapshot.length,
        libraryBooks: libraryBooks.length,
        rankingBooks: rankingBooks.length,
        dismantleBooks: dismantleBooks.length,
        writingStyles: writingStyles.length,
        skills: skills.length,
        models: availableModels.length,
      },
      apiConfigured: Boolean(agentConfig.apiKey.trim()),
    };
    const clientState = Object.fromEntries([
      'agent-config', 'agent-profiles', 'agent-active-profile', 'agent-models', 'agent-fetched-models', 'writer-skills', 'writer-runtime-usage',
      'writer-runtime-usage-days', 'writer-banned-words', 'cloud-remote-path',
      ...snapshot.map(project => `project-agent-current-session:${project.id}`),
    ].map(key => [key, localStorage.getItem(key)]));
    clientState['agent-config'] = JSON.stringify(agentConfig);
    clientState['agent-profiles'] = JSON.stringify(agentProfiles);
    clientState['agent-active-profile'] = activeProfileId;
    clientState['agent-models'] = JSON.stringify(availableModels);
    clientState['writer-skills'] = JSON.stringify(skills);
    clientState.projects = JSON.stringify(snapshot);
    clientState['writer-library-books'] = JSON.stringify(libraryBooks);
    clientState['writer-ranking-books'] = JSON.stringify(rankingBooks);
    clientState['writer-dismantle-books'] = JSON.stringify(dismantleBooks);
    clientState['writer-writing-styles'] = JSON.stringify(writingStyles);
    clientState['backup-manifest'] = JSON.stringify(backupManifest);
    // 项目 Agent 会话存在 app-data 目录里，备份包只认 clientState，需要单独导出
    try {
      clientState['agent-chats'] = JSON.stringify(await invoke<Record<string, unknown>>('export_agent_chats'));
    } catch (error) {
      console.warn('导出项目 Agent 会话失败，本次备份不含聊天记录', error);
    }
    return clientState;
  };

  const backupToCloud = async () => {
    const remotePath = cloudRemotePath.trim();
    if (!remotePath) { setCloudSyncMessage('请填写云端备份目录。'); return; }
    setCloudSyncRunning(true);
    setCloudSyncMessage('正在保存并核对全部本机数据...');
    try {
      const clientState = await buildBackupClientState();
      clientState['cloud-remote-path'] = remotePath;
      await invoke<{ message?: string; remotePath?: string }>('backup_projects_to_baidu', { remotePath, clientState });
      localStorage.setItem('cloud-remote-path', remotePath);
      setCloudSyncMessage(`完整备份完成：小说 ${projects.length}、书籍 ${libraryBooks.length}、拆书 ${dismantleBooks.length}、榜单 ${rankingBooks.length}、文风 ${writingStyles.length}。`);
    } catch (error) {
      setCloudSyncMessage(String(error));
    } finally {
      setCloudSyncRunning(false);
    }
  };

  const loadCloudBackups = async () => {
    const remotePath = cloudRemotePath.trim();
    if (!remotePath) { setCloudSyncMessage('请填写云端备份目录。'); return; }
    setCloudSyncRunning(true);
    setCloudSyncMessage('正在读取百度网盘备份列表...');
    try {
      const result = await invoke<{ files?: CloudBackupFile[] }>('list_baidu_backups', { remotePath });
      const files = Array.isArray(result.files) ? result.files.filter(file => file && typeof file.path === 'string') : [];
      if (!files.length) {
        setCloudBackupFiles([]);
        setSelectedCloudBackup(null);
        setCloudSyncMessage('当前云端目录没有找到 .aswbackup 完整备份包。');
        return;
      }
      setCloudBackupFiles(files);
      setSelectedCloudBackup(null);
      setShowCloudBackupPicker(true);
      setCloudSyncMessage(`找到 ${files.length} 个完整备份包，请选择要恢复的版本。`);
    } catch (error) {
      setCloudSyncMessage(String(error));
    } finally {
      setCloudSyncRunning(false);
    }
  };

  /** 备份包恢复的公共路径：云端与本地只差一个取包动作，其余校验与写入完全相同 */
  const restoreFromBundle = async (label: string, runRestore: () => Promise<{ clientState?: Record<string, string | null> }>, onSuccess?: () => void) => {
    setCloudSyncRunning(true);
    setCloudSyncMessage(`正在恢复备份：${label}...`);
    try {
      const result = await runRestore();
      const restoredState = result.clientState || {};
      if (typeof restoredState['agent-chats'] === 'string') {
        // 聊天记录恢复失败不应该阻断小说数据恢复
        try {
          await invoke<number>('import_agent_chats', { sessions: JSON.parse(restoredState['agent-chats']) });
        } catch (error) {
          console.warn('恢复项目 Agent 会话失败', error);
        }
      }
      const parseState = (key: string): unknown => {
        try {
          const value = restoredState[key];
          return typeof value === 'string' ? JSON.parse(value) : null;
        } catch {
          return null;
        }
      };
      const restoreArray = async <T,>(key: string, command: string): Promise<T[] | null> => {
        const value = parseState(key);
        if (Array.isArray(value)) return value as T[];
        const stored = await invoke<T[] | null>(command);
        return Array.isArray(stored) ? stored : null;
      };
      const [restoredProjects, restoredLibrary, restoredRanking, restoredDismantle, restoredStyles] = await Promise.all([
        restoreArray<Project>('projects', 'load_projects'),
        restoreArray<LibraryBook>('writer-library-books', 'load_library_books'),
        restoreArray<RankingBook>('writer-ranking-books', 'load_ranking_books'),
        restoreArray<DismantleBook>('writer-dismantle-books', 'load_dismantle_books'),
        restoreArray<WritingStyle>('writer-writing-styles', 'load_writing_styles'),
      ]);
      const restoredConfigValue = parseState('agent-config');
      const restoredModelsValue = parseState('agent-models');
      const restoredSkillsValue = parseState('writer-skills');
      const restoredManifest = parseState('backup-manifest') as { counts?: Record<string, unknown> } | null;
      const restoredRankings = Array.isArray(restoredRanking) ? restoredRanking.map((book, index) => normalizeRankingBook({
        ...book,
        sourceName: book.sourceName || (book.platform === 'qidian' ? '起点中文网官网' : book.platform === 'faloo' ? '飞卢小说网官网' : '番茄小说网'),
      }, index)) : null;
      const actualCounts: Record<string, number> = {
        projects: restoredProjects?.length || 0,
        libraryBooks: restoredLibrary?.length || 0,
        rankingBooks: restoredRankings?.length || 0,
        dismantleBooks: restoredDismantle?.length || 0,
        writingStyles: restoredStyles?.length || 0,
      };
      if (restoredManifest?.counts) {
        for (const [key, count] of Object.entries(restoredManifest.counts)) {
          if (key in actualCounts && Number(count) > actualCounts[key]) {
            throw new Error(`备份完整性校验失败：${key} 应有 ${Number(count)} 条，实际只读取到 ${actualCounts[key]} 条。`);
          }
        }
      }
      const restoreTasks: Array<{ label: string; run: () => Promise<string> }> = [];
      if (Array.isArray(restoredProjects)) restoreTasks.push({ label: '小说、章节、大纲与记忆', run: () => nativeClient.saveProjects(restoredProjects) });
      if (Array.isArray(restoredLibrary)) restoreTasks.push({ label: '书籍管理', run: () => nativeClient.saveLibraryBooks(restoredLibrary) });
      if (Array.isArray(restoredRankings)) restoreTasks.push({ label: '扫榜数据', run: () => nativeClient.saveRankingBooks(restoredRankings) });
      if (Array.isArray(restoredDismantle)) restoreTasks.push({ label: '拆书数据', run: () => nativeClient.saveDismantleBooks(restoredDismantle) });
      if (Array.isArray(restoredStyles)) restoreTasks.push({ label: '文风数据', run: () => nativeClient.saveWritingStyles(restoredStyles) });
      if (!restoreTasks.length) throw new Error('备份包中没有可恢复的小说、书籍、拆书、榜单或文风数据。');
      let restoredCount = 0;
      setCloudSyncMessage(`备份包已解析，正在并行恢复 ${restoreTasks.length} 类本机数据...`);
      await Promise.all(restoreTasks.map(async task => {
        await task.run();
        restoredCount += 1;
        setCloudSyncMessage(`已恢复 ${task.label}（${restoredCount}/${restoreTasks.length}），正在继续写入...`);
      }));
      // The data above now lives in the native app directory. Remove legacy
      // browser copies before persisting lightweight settings so iOS storage
      // quota cannot affect the next chapter save or model request.
      if ('__TAURI_INTERNALS__' in window) {
        deviceBackedStateKeys.forEach(key => localStorage.removeItem(key));
      } else {
        Object.entries(restoredState).forEach(([key, value]) => {
          if (deviceBackedStateKeys.has(key) || typeof value !== 'string') return;
          localStorage.setItem(key, value);
        });
      }
      const lightweightState = ['agent-config', 'agent-profiles', 'agent-active-profile', 'agent-models', 'agent-fetched-models', 'writer-skills', 'writer-runtime-usage', 'writer-runtime-usage-days', 'writer-banned-words', 'cloud-remote-path', ...Object.keys(restoredState).filter(key => key.startsWith('project-agent-current-session:'))];
      lightweightState.forEach(key => {
        const value = restoredState[key];
        if (typeof value !== 'string') return;
        try { localStorage.setItem(key, value); } catch { /* Native project files remain intact if WebView settings quota is full. */ }
      });
      if (Array.isArray(restoredLibrary)) setLibraryBooks(restoredLibrary.map(book => normalizeLibraryBook(book)));
      if (Array.isArray(restoredRankings)) setRankingBooks(restoredRankings);
      if (Array.isArray(restoredDismantle)) setDismantleBooks(restoredDismantle.map(book => normalizeDismantleBook(book)));
      if (Array.isArray(restoredStyles)) setWritingStyles(restoredStyles.map(style => normalizeWritingStyle(style)));
      if (restoredConfigValue && typeof restoredConfigValue === 'object') {
        const restoredConfig = normalizeAgentConfig(restoredConfigValue);
        setAgentConfig(restoredConfig);
        setSettingsDraft(restoredConfig);
      }
      if (Array.isArray(restoredModelsValue)) {
        const restoredModels = restoredModelsValue.filter((model): model is string => typeof model === 'string' && Boolean(model.trim()));
        if (restoredModels.length) {
          setAvailableModels(restoredModels);
          setSettingsModels(restoredModels);
        }
      }
      // Backups written after the multi-profile upgrade carry the whole list and
      // take precedence over the single-config keys restored above.
      const restoredProfilesValue = parseState('agent-profiles');
      if (Array.isArray(restoredProfilesValue) && restoredProfilesValue.length) {
        const profiles = restoredProfilesValue.map(normalizeAgentProfile);
        const restoredActiveId = restoredState['agent-active-profile'];
        const activeId = typeof restoredActiveId === 'string' && profiles.some(profile => profile.id === restoredActiveId) ? restoredActiveId : profiles[0].id;
        const active = profiles.find(profile => profile.id === activeId) ?? profiles[0];
        setProfileState({ profiles, activeId });
        setAgentConfig(active);
        setSettingsDraft(active);
        setSettingsModels(active.enabledModels);
        setAvailableModels(active.enabledModels);
      }
      if (Array.isArray(restoredSkillsValue)) {
        const restoredSkills = restoredSkillsValue.filter((skill): skill is Skill => Boolean(skill && typeof skill === 'object' && typeof (skill as Skill).name === 'string'));
        if (restoredSkills.length) setSkills(restoredSkills);
      }
      setCloudSyncMessage('本机数据写入完成，正在重新载入小说项目...');
      const restored = Array.isArray(restoredProjects)
        ? restoredProjects as Project[]
        : await nativeClient.loadProjects<Project>();
      if (restored) {
        setProjects(restored);
        if (editingProject) setEditingProject(restored.find(project => project.id === editingProject.id) || null);
      }
      onSuccess?.();
      setCloudSyncMessage(`完整恢复完成：小说 ${actualCounts.projects}、书籍 ${actualCounts.libraryBooks}、拆书 ${actualCounts.dismantleBooks}、榜单 ${actualCounts.rankingBooks}、文风 ${actualCounts.writingStyles}。正在重新载入...`);
      window.setTimeout(() => window.location.reload(), 1000);
    } catch (error) {
      setCloudSyncMessage(String(error));
    } finally {
      setCloudSyncRunning(false);
    }
  };

  const restoreFromCloud = async (selectedBackup?: CloudBackupFile) => {
    const remotePath = cloudRemotePath.trim();
    if (!remotePath) { setCloudSyncMessage('请填写云端备份目录。'); return; }
    if (!selectedBackup) { setCloudSyncMessage('请先选择要恢复的云端备份文件。'); return; }
    setShowCloudBackupPicker(false);
    await restoreFromBundle(selectedBackup.name, () => invoke('restore_projects_from_baidu', {
      remotePath,
      backupPath: selectedBackup.path,
      backupFsId: selectedBackup.fsId,
    }), () => localStorage.setItem('cloud-remote-path', remotePath));
  };

  // 本地备份：不需要百度网盘或 GitHub，直接写到下载目录
  const exportBackupBundle = async () => {
    setCloudSyncRunning(true);
    setCloudSyncMessage('正在打包完整备份...');
    try {
      const clientState = await buildBackupClientState();
      const result = await invoke<{ path: string; size: number }>('export_backup_bundle', { clientState });
      setCloudSyncMessage(`本地备份包已生成（${(result.size / 1_048_576).toFixed(1)} MB）：${result.path}`);
    } catch (error) {
      setCloudSyncMessage(String(error));
    } finally {
      setCloudSyncRunning(false);
    }
  };

  const loadLocalBackups = async () => {
    setCloudSyncRunning(true);
    try {
      const result = await invoke<{ directory: string; files: Array<{ name: string; size: number; modifiedAt: number }> }>('list_local_backups');
      setLocalBackups({ directory: result.directory, files: Array.isArray(result.files) ? result.files : [] });
      setShowLocalBackupPicker(true);
      setCloudSyncMessage(result.files?.length ? `找到 ${result.files.length} 个本地备份包，请选择要恢复的版本。` : '导出目录里还没有 .aswbackup 备份包。');
    } catch (error) {
      setCloudSyncMessage(String(error));
    } finally {
      setCloudSyncRunning(false);
    }
  };

  const restoreFromLocalBundle = async (fileName: string) => {
    setShowLocalBackupPicker(false);
    await restoreFromBundle(fileName, () => invoke('restore_backup_bundle', { fileName }));
  };

  const pullModels = async () => {
    const apiKey = settingsDraft.apiKey.trim();
    if (!apiKey) {
      setNotice({ title: '需要 API Key', content: '请先填写 API Key，再拉取模型列表。' });
      return;
    }
    const requestBaseURL = normalizeBaseURL(settingsDraft.baseURL, settingsDraft.apiMode);
    if (!requestBaseURL) {
      setModelListMessage('API 地址无效：请填写完整的 http:// 或 https:// 地址');
      return;
    }
    setModelsLoading(true);
    try {
      const result = await agentRpc<{ models?: string[] }>('models.list', { baseURL: requestBaseURL, apiKey, apiMode: settingsDraft.apiMode, ...agentNetworkParams(settingsDraft) });
      const models = (Array.isArray(result.models) ? result.models : []).filter(model => typeof model === 'string' && model.trim());
      if (!models.length) throw new Error(`${requestBaseURL} 没有返回可用模型`);
      setFetchedModels(models);
      localStorage.setItem('agent-fetched-models', JSON.stringify(models));
      setModelListMessage(`已获取 ${models.length} 个模型${settingsDraft.proxyEnabled ? `，请求已通过代理 ${settingsDraft.proxyURL}` : ''}，勾选模型即可启用。`);
    } catch (error) {
      setModelListMessage(`拉取模型失败（${apiModeLabel(settingsDraft.apiMode)} · ${requestBaseURL}）：${String(error)}`);
    } finally {
      setModelsLoading(false);
    }
  };

  const testSelectedModel = async () => {
    if (!settingsDraft.apiKey.trim()) {
      setModelListMessage('请先填写 API 密钥，再测试模型。');
      return;
    }
    const requestBaseURL = normalizeBaseURL(settingsDraft.baseURL, settingsDraft.apiMode);
    if (!requestBaseURL) {
      setModelListMessage('API 地址无效：请填写完整的 http:// 或 https:// 地址');
      return;
    }
    setModelsTesting(true);
    setModelListMessage('正在测试当前模型...');
    try {
      const selectedModel = settingsDraft.model.trim() || fallbackModels[0];
      await agentRpc<{ tested: boolean; model: string }>('models.test', {
        apiKey: settingsDraft.apiKey.trim(),
        baseURL: requestBaseURL,
        model: selectedModel,
        apiMode: settingsDraft.apiMode,
        reasoningMode: settingsDraft.reasoningMode,
        contextWindow: settingsDraft.contextWindow,
        ...agentNetworkParams(settingsDraft),
      });
      setModelListMessage(`模型 ${selectedModel} 测试成功（${apiModeLabel(settingsDraft.apiMode)}）${settingsDraft.proxyEnabled ? `，已通过代理 ${settingsDraft.proxyURL}` : ''}。`);
    } catch (error) {
      setModelListMessage(`模型测试失败（${apiModeLabel(settingsDraft.apiMode)} · ${resolvedEndpoint(settingsDraft)}）：${String(error)}`);
    } finally {
      setModelsTesting(false);
    }
  };

  /** Runs the full preflight in the runtime and shows one line per check, so a
   * wrong address, key, format or model is named before writing starts. */
  const runDiagnostics = async () => {
    const mode = settingsDraft.apiMode;
    const requestBaseURL = normalizeBaseURL(settingsDraft.baseURL, mode);
    if (!requestBaseURL) {
      setSettingsDiagnostics({
        mode, modelsEndpoint: '', chatEndpoint: '',
        checks: [{ id: 'address', label: '接口地址', status: 'fail', detail: 'API 地址无效：请填写完整的 http:// 或 https:// 地址' }],
      });
      return;
    }
    setDiagnosticsRunning(true);
    setSettingsDiagnostics(null);
    setModelListMessage('');
    try {
      const selectedModel = settingsDraft.model.trim();
      setSettingsDiagnostics(await agentRpc<DiagnosticReport>('settings.diagnose', {
          apiKey: settingsDraft.apiKey.trim(),
          baseURL: requestBaseURL,
          model: selectedModel,
          apiMode: mode,
          reasoningMode: settingsDraft.reasoningMode,
          contextWindow: settingsDraft.contextWindow,
          ...agentNetworkParams(settingsDraft),
        }));
    } catch (error) {
      setSettingsDiagnostics({
        mode, modelsEndpoint: '', chatEndpoint: '',
        checks: [{ id: 'runtime', label: '本地运行时', status: 'fail', detail: String(error) }],
      });
    } finally {
      setDiagnosticsRunning(false);
    }
  };

  const useSystemProxy = async () => {
    try {
      const detected = await invoke<string | null>('detect_system_proxy');
      if (!detected) {
        setModelListMessage('没有检测到系统 HTTP/HTTPS 代理，请手动填写代理地址。');
        return;
      }
      setSettingsDraft(current => ({ ...current, proxyEnabled: true, proxyURL: detected }));
      setModelListMessage(`已读取系统代理 ${detected}，保存设置后生效。`);
    } catch (error) {
      setModelListMessage(`读取系统代理失败：${String(error)}`);
    }
  };

  const toggleSettingsModel = (model: string) => {
    setSettingsModels(current => {
      if (current.includes(model)) {
        if (current.length === 1) return current;
        const next = current.filter(item => item !== model);
        setSettingsDraft(draft => draft.model === model ? { ...draft, model: next[0] } : draft);
        return next;
      }
      return [...current, model];
    });
  };

  const setCurrentSettingsModel = (model: string) => {
    const normalized = model.trim();
    if (!normalized) return;
    setSettingsModels(current => current.includes(normalized) ? current : [...current, normalized]);
    setSettingsDraft(current => ({ ...current, model: normalized }));
  };

  const addCustomModel = () => {
    const model = customModelName.trim();
    if (!model) return;
    setSettingsModels(current => Array.from(new Set([...current, model])));
    setSettingsDraft(current => ({ ...current, model: current.model || model }));
    setCustomModelName('');
  };

  const addSettingsModel = (model: string) => {
    const normalized = model.trim();
    if (!normalized) return;
    setSettingsModels(current => Array.from(new Set([...current, normalized])));
    setSettingsDraft(current => ({ ...current, model: current.model || normalized }));
  };

  const updatePrimaryApiKey = (apiKey: string) => {
    setSettingsDraft(current => ({ ...current, apiKey: apiKey.trim() }));
  };

  /** Loads a profile into the editor and into every downstream call site. */
  const applyProfileToEditor = (profile: AgentProfile) => {
    setAgentConfig(profile);
    setSettingsDraft(profile);
    setSettingsModels(profile.enabledModels);
    setAvailableModels(profile.enabledModels);
    localStorage.setItem('agent-models', JSON.stringify(profile.enabledModels));
    // Fetched models belong to the previous address and would mislead here.
    setFetchedModels([]);
    localStorage.removeItem('agent-fetched-models');
    setSettingsDiagnostics(null);
    setAgentError('');
    setAgentStage('idle');
  };

  const switchProfile = (id: string) => {
    if (id === activeProfileId) return;
    const profile = agentProfiles.find(item => item.id === id);
    if (!profile) return;
    setProfileState(current => ({ ...current, activeId: id }));
    applyProfileToEditor(profile);
    setModelListMessage(`已切换到「${profile.serviceName}」·${apiModeLabel(profile.apiMode)}·${profile.model || '未选择模型'}。`);
  };

  const addProfile = (presetId: string) => {
    const preset = profilePresets.find(item => item.id === presetId) ?? profilePresets[0];
    const taken = agentProfiles.filter(profile => profile.serviceName.startsWith(String(preset.config.serviceName ?? ''))).length;
    const profile = normalizeAgentProfile({
      ...preset.config,
      serviceName: taken ? `${preset.config.serviceName} ${taken + 1}` : preset.config.serviceName,
      id: newProfileId(),
    });
    setProfileState(current => ({ profiles: [...current.profiles, profile], activeId: profile.id }));
    applyProfileToEditor(profile);
    setShowProfilePresets(false);
    setSettingsServiceExpanded(true);
    setModelListMessage(`已新增「${profile.serviceName}」，请填写接口地址与 API Key 后保存。`);
  };

  const duplicateProfile = (id: string) => {
    const source = agentProfiles.find(item => item.id === id);
    if (!source) return;
    const profile: AgentProfile = { ...source, id: newProfileId(), serviceName: `${source.serviceName} 副本` };
    setProfileState(current => ({ profiles: [...current.profiles, profile], activeId: profile.id }));
    applyProfileToEditor(profile);
    setModelListMessage(`已复制为「${profile.serviceName}」。`);
  };

  const removeProfile = (id: string) => {
    if (agentProfiles.length <= 1) {
      setModelListMessage('至少需要保留一个 API 配置。');
      return;
    }
    const removed = agentProfiles.find(item => item.id === id);
    const remaining = agentProfiles.filter(profile => profile.id !== id);
    const nextActive = remaining.find(profile => profile.id === activeProfileId) ?? remaining[0];
    setProfileState({ profiles: remaining, activeId: nextActive.id });
    if (id === activeProfileId) applyProfileToEditor(nextActive);
    setModelListMessage(`已删除「${removed?.serviceName ?? '配置'}」，当前使用「${nextActive.serviceName}」。`);
  };

  const saveSettings = () => {
    const normalizedBaseURL = normalizeBaseURL(settingsDraft.baseURL, settingsDraft.apiMode);
    if (!normalizedBaseURL) {
      setModelListMessage('API 地址无效：请填写完整的 http:// 或 https:// 地址');
      return;
    }
    if (settingsDraft.proxyEnabled) {
      try {
        const proxyURL = new URL(settingsDraft.proxyURL.trim());
        if (!['http:', 'https:'].includes(proxyURL.protocol)) throw new Error('仅支持 HTTP/HTTPS 代理');
      } catch (error) {
        setModelListMessage(`代理地址无效：${error instanceof Error ? error.message : '请填写完整的 http:// 或 https:// 地址'}`);
        return;
      }
    }
    const enabledModels = Array.from(new Set((settingsModels.length ? settingsModels : [settingsDraft.model || fallbackModels[0]]).map(model => model.trim()).filter(Boolean)));
    const selectedModel = enabledModels.includes(settingsDraft.model) ? settingsDraft.model : enabledModels[0];
    const apiKey = settingsDraft.apiKey.trim();
    const saved: AgentConfig = {
      ...settingsDraft,
      serviceName: settingsDraft.serviceName.trim() || '自定义中转站',
      baseURL: normalizedBaseURL,
      apiKey,
      model: selectedModel,
      enabledModels,
      contextWindow: clampContextWindow(settingsDraft.contextWindow),
    };
    setAvailableModels(enabledModels);
    localStorage.setItem('agent-models', JSON.stringify(enabledModels));
    setAgentConfig(saved);
    setSettingsDraft(saved);
    setProfileState(current => ({
      ...current,
      profiles: current.profiles.map(profile => profile.id === current.activeId ? { ...saved, id: profile.id } : profile),
    }));
    setAgentError('');
    setAgentStage('idle');
    if (!apiKey) {
      // Saving an address without a key is allowed, but every later call would
      // fail with an authentication error, so say so now.
      setModelListMessage('已保存，但没有填写 API Key —— 现在调用模型一定会失败，请补齐后再写作。');
      return;
    }
    setShowSettingsModal(false);
    setNotice({
      title: '设置已保存',
      content: `${saved.serviceName}·${apiModeLabel(saved.apiMode)}·${resolvedEndpoint(saved)}，模型 ${selectedModel}，上下文 ${formatContextWindow(saved.contextWindow)}，思考强度 ${saved.reasoningMode}。`,
    });
  };

  const chooseOutlineType = (kind: OutlineKind) => {
    handleCreateOutline(kind);
    setShowOutlineTypeModal(false);
  };

  const updateMemoryDocument = (id: string, content: string) => {
    updateEditorProject(project => ({
      ...project,
      memoryDocuments: project.memoryDocuments.map(document => document.id === id
        ? { ...document, content, manuallyEdited: true, updatedAt: new Date().toISOString() }
        : document),
      updatedAt: new Date().toISOString(),
    }));
  };

  const updateChapterMemory = (patch: Partial<ChapterMemory>) => {
    if (!editingProject || activeChapterMemoryId === null) return;
    const memories = editingProject.memories.map(memory => memory.id === activeChapterMemoryId
      ? normalizeChapterMemory({ ...memory, ...patch, updatedAt: new Date().toISOString() })
      : memory);
    updateEditorProject(project => ({
      ...project,
      memories,
      memoryDocuments: buildMemoryDocuments(memories, project.memoryDocuments),
      updatedAt: new Date().toISOString(),
    }));
  };

  const saveActiveChapterMemory = async () => {
    if (!editingProject || activeChapterMemoryId === null) return;
    const memories = editingProject.memories.map(memory => memory.id === activeChapterMemoryId
      ? { ...memory, updatedAt: new Date().toISOString() }
      : memory);
    const updatedProject = {
      ...editingProject,
      memories,
      memoryDocuments: buildMemoryDocuments(memories, editingProject.memoryDocuments),
      updatedAt: new Date().toISOString(),
    };
    const snapshot = projects.map(item => item.id === updatedProject.id ? updatedProject : item);
    setEditingProject(updatedProject);
    setProjects(snapshot);
    try {
      if ('__TAURI_INTERNALS__' in window) {
        await nativeClient.saveProjects(snapshot);
      } else {
        localStorage.setItem('projects', JSON.stringify(snapshot));
      }
      setNotice({ title: '本章记忆已保存', content: '结构化章节快照和聚合记忆已写入本地。' });
    } catch (error) {
      setNotice({ title: '本章记忆保存失败', content: String(error) });
    }
  };

  const saveActiveMemoryDocument = async () => {
    if (!editingProject) return;
    const document = editingProject.memoryDocuments.find(item => item.id === activeMemoryDocumentId);
    if (!document) return;
    const updatedProject = {
      ...editingProject,
      memoryDocuments: editingProject.memoryDocuments.map(item => item.id === document.id
        ? { ...item, updatedAt: new Date().toISOString() }
        : item),
      updatedAt: new Date().toISOString(),
    };
    const snapshot = projects.map(item => item.id === updatedProject.id ? updatedProject : item);
    setEditingProject(updatedProject);
    setProjects(snapshot);
    try {
      if ('__TAURI_INTERNALS__' in window) {
        await nativeClient.saveProjects(snapshot);
      } else {
        localStorage.setItem('projects', JSON.stringify(snapshot));
      }
      setNotice({ title: '记忆已保存', content: `《${document.title}》已写入本地记忆目录。` });
    } catch (error) {
      setNotice({ title: '记忆保存失败', content: String(error) });
    }
  };

  const rebuildMemoryDocuments = () => {
    if (!editingProject) return;
    const now = new Date().toISOString();
    const memories = editingProject.memories.map(memory => {
      const chapter = editingProject.chapters.find(item => item.id === memory.chapterId);
      if (!chapter?.content.trim()) return memory;
      const local = buildLocalStructuredMemory(chapter, editingProject);
      return normalizeChapterMemory({
        ...memory,
        characterStateChanges: memory.characterStateChanges.length ? memory.characterStateChanges : local.characterStateChanges,
        knowledgeChanges: memory.knowledgeChanges.length ? memory.knowledgeChanges : local.knowledgeChanges,
        foreshadowingChanges: memory.foreshadowingChanges.length ? memory.foreshadowingChanges : local.foreshadowingChanges,
        timelineEvents: memory.timelineEvents.length ? memory.timelineEvents : local.timelineEvents,
        canonFacts: memory.canonFacts.length ? memory.canonFacts : local.canonFacts,
        conflicts: memory.conflicts.length ? memory.conflicts : local.conflicts,
        endingHook: memory.endingHook || local.endingHook,
        updatedAt: now,
      }, chapter);
    });
    const updated = {
      ...editingProject,
      memories,
      memoryDocuments: buildMemoryDocuments(memories, editingProject.memoryDocuments, true)
        .map(document => ({ ...document, updatedAt: now })),
      updatedAt: now,
    };
    setEditingProject(updated);
    setProjects(current => current.map(project => project.id === updated.id ? updated : project));
    setNotice({ title: '记忆已重新整理', content: '已按正文回填空的认知、伏笔和冲突，并重建全部记忆文档。' });
  };

  const activeOutline = editingProject?.outlines.find(outline => outline.id === activeOutlineId) ?? null;
  const outlineIntentPreview = editingProject && activeOutline?.kind === '章纲'
    ? resolveOutlineGenerationIntent(editingProject, activeOutline, outlineAgentInstruction)
    : null;
  const activeCard = editingProject?.cards.find(card => card.id === activeCardId) ?? null;
  const activeWritingStyle = editingProject?.styleProfileId ? writingStyles.find(style => style.id === editingProject.styleProfileId) ?? null : null;
  const activeMemoryDocument = editingProject?.memoryDocuments.find(document => document.id === activeMemoryDocumentId) ?? null;
  const activeChapterMemory = editingProject?.memories.find(memory => memory.id === activeChapterMemoryId) ?? null;
  const activeGraphNode = editingProject?.graphNodes.find(node => node.id === activeGraphNodeId) ?? null;
  const focusedGraphRelationIds = new Set(editingProject && activeGraphNodeId
    ? editingProject.graphEdges
      .filter(edge => edge.source === activeGraphNodeId || edge.target === activeGraphNodeId)
      .map(edge => edge.id)
    : []);
  const focusedGraphNodeIds = new Set(editingProject && activeGraphNodeId
    ? [
      activeGraphNodeId,
      ...editingProject.graphEdges
        .filter(edge => edge.source === activeGraphNodeId || edge.target === activeGraphNodeId)
        .map(edge => edge.source === activeGraphNodeId ? edge.target : edge.source),
    ]
    : []);
  const graphDocumentGroups = editingProject ? Array.from(new Set(editingProject.graphNodes.map(graphNodeGroup))) : [];
  const activeGraphDocumentGroup = graphDocumentGroups.some(group => group === graphDocumentGroup) ? graphDocumentGroup : (graphDocumentGroups[0] || '');
  const graphDocumentTypeOptions = editingProject ? Array.from(new Set(editingProject.graphNodes.map(graphNodeTypeLabel))).sort((left, right) => left.localeCompare(right, 'zh-CN')) : [];
  const graphDocumentNodes = editingProject ? editingProject.graphNodes.filter(node => {
    const matchesGroup = !activeGraphDocumentGroup || graphNodeGroup(node) === activeGraphDocumentGroup;
    const matchesType = graphDocumentType === '全部类型' || graphNodeTypeLabel(node) === graphDocumentType;
    const searchText = `${node.label}\n${graphNodeRelativePath(node)}\n${graphNodeProfile(node)}`.toLowerCase();
    const matchesQuery = !graphDocumentQuery.trim() || searchText.includes(graphDocumentQuery.trim().toLowerCase());
    const relationCount = editingProject.graphEdges.filter(edge => edge.source === node.id || edge.target === node.id).length;
    return matchesGroup && matchesType && matchesQuery && (!graphOnlyIsolated || relationCount === 0);
  }).sort((left, right) => {
    const relationStrength = (node: KnowledgeGraphNode) => editingProject.graphEdges
      .filter(edge => edge.source === node.id || edge.target === node.id)
      .reduce((sum, edge) => sum + normalizeKnowledgeGraphWeight(edge.weight, edge.label), 0);
    const relationDifference = relationStrength(right) - relationStrength(left);
    return relationDifference || left.label.localeCompare(right.label, 'zh-CN');
  }) : [];
  const visibleCards = editingProject?.cards.filter(card => cardTypeFilter === '全部' || card.type === cardTypeFilter) ?? [];
  const characterNames = editingProject ? Array.from(new Set([
    ...(editingProject.protagonist1 || '').split(/[、,，/\s]+/u),
    ...(editingProject.protagonist2 || '').split(/[、,，/\s]+/u),
    ...editingProject.cards.filter(card => card.type === '角色卡').map(card => card.title),
  ].map(item => item.trim()).filter(item => item.length > 1))) : [];
  const markTerms = Array.from(new Set([...characterNames, ...bannedWords].filter(Boolean))).sort((left, right) => right.length - left.length);
  const activeAIDetection = editingProject?.aiDetection?.chapters.find(item => item.chapterId === activeChapter?.id);
  const renderMarkedContent = (content: string) => {
    if (!content) return '\u200b';
    // 分段和当前正文对不上就退回纯文本，否则高亮层会一直铺检测时那份旧正文
    const hasDetectionSegments = aiDetectionSegmentsMatch(activeAIDetection?.segments, content);
    const detectionSegments = hasDetectionSegments ? activeAIDetection!.segments : [{ order: 1, text: content, confidence: 0, label: '人工' as AIDetectionLabel }];
    return detectionSegments.map((segment, segmentIndex) => {
      const detectionClass = hasDetectionSegments ? `ai-detection-mark ${segment.label === '人工' ? 'human' : segment.label === '疑似 AI' ? 'suspected' : 'ai'}` : '';
      if (!writingMarksEnabled || !markTerms.length) return <span key={`detection-${segmentIndex}`} className={detectionClass}>{segment.text}</span>;
      const pattern = new RegExp(`(${markTerms.map(escapeRegExp).join('|')})`, 'gu');
      return <span key={`detection-${segmentIndex}`} className={detectionClass}>{segment.text.split(pattern).map((part, partIndex) => {
        if (!part) return null;
        const isBanned = bannedWords.includes(part);
        const isCharacter = characterNames.includes(part);
        const classes = [isBanned ? 'banned-word-mark' : '', !isBanned && isCharacter ? 'character-mark' : '', segment.label === 'AI 特征' ? 'ai-detection-emphasis' : ''].filter(Boolean).join(' ');
        return classes ? <mark key={`${part}-${partIndex}`} className={classes}>{part}</mark> : <span key={`${part}-${partIndex}`}>{part}</span>;
      })}</span>;
    });
  };
  const currentSearchMatches = activeChapter && searchQuery ? countOccurrences(activeChapter.content, searchQuery) : 0;
  const bookSearchResults = editingProject && searchScope === 'book' && searchQuery.trim()
    ? editingProject.chapters.flatMap(chapter => {
      const matches = findTextMatches(chapter.content, searchQuery);
      const titleMatches = countOccurrences(chapter.title, searchQuery);
      if (!matches.length && !titleMatches) return [];
      return [{ chapter, count: matches.length + titleMatches, matches, snippets: matches.slice(0, 3).map(position => ({ position, text: searchSnippet(chapter.content, position, searchQuery) })) }];
    })
    : [];
  const bookSearchMatches = bookSearchResults.flatMap(result => result.matches.map(position => ({ chapter: result.chapter, position })));
  const focusBookSearchMatch = (index: number) => {
    const target = bookSearchMatches[(index + bookSearchMatches.length) % bookSearchMatches.length];
    if (!target) return;
    const targetIndex = bookSearchMatches.indexOf(target);
    setBookSearchMatchIndex(targetIndex);
    setEditorSidebarTab('chapters');
    setActiveChapter(target.chapter);
    setSearchMatchIndex(findTextMatches(target.chapter.content, searchQuery).indexOf(target.position));
    window.setTimeout(() => {
      const editor = chapterEditorRef.current;
      if (!editor) return;
      editor.focus();
      editor.setSelectionRange(target.position, target.position + searchQuery.length);
    }, 0);
  };

  const openBookSearchChapter = (chapter: Chapter, position?: number) => {
    setEditorSidebarTab('chapters');
    setActiveChapter(chapter);
    if (position === undefined) return;
    setSearchMatchIndex(findTextMatches(chapter.content, searchQuery).indexOf(position));
    window.setTimeout(() => {
      const editor = chapterEditorRef.current;
      if (!editor) return;
      editor.focus();
      editor.setSelectionRange(position, position + searchQuery.length);
    }, 0);
  };
  const graphLayout = (() => {
    const nodes = editingProject?.graphNodes ?? [];
    const edges = editingProject?.graphEdges ?? [];
    if (!nodes.length) return [];
    const positions = nodes.map((node, index) => {
      const angle = index * 2.399963229728653;
      const radius = 0.18 + 0.27 * Math.sqrt(index / Math.max(nodes.length - 1, 1));
      return { id: node.id, x: 0.5 + Math.cos(angle) * radius, y: 0.5 + Math.sin(angle) * radius };
    });
    const byId = new Map(positions.map(position => [position.id, position]));
    for (let iteration = 0; iteration < 65; iteration += 1) {
      for (let left = 0; left < positions.length; left += 1) {
        for (let right = left + 1; right < positions.length; right += 1) {
          const first = positions[left]; const second = positions[right];
          const dx = first.x - second.x; const dy = first.y - second.y;
          const distance = Math.max(0.025, Math.hypot(dx, dy));
          const force = Math.min(0.018, 0.0019 / (distance * distance));
          first.x += dx / distance * force; first.y += dy / distance * force;
          second.x -= dx / distance * force; second.y -= dy / distance * force;
        }
      }
      for (const edge of edges) {
        const source = byId.get(edge.source); const target = byId.get(edge.target);
        if (!source || !target) continue;
        const dx = target.x - source.x; const dy = target.y - source.y;
        const distance = Math.max(0.025, Math.hypot(dx, dy));
        const weight = normalizeKnowledgeGraphWeight(edge.weight, edge.label);
        const preferredDistance = 0.27 - weight * 0.11;
        const force = (distance - preferredDistance) * (0.018 + weight * 0.035);
        source.x += dx / distance * force; source.y += dy / distance * force;
        target.x -= dx / distance * force; target.y -= dy / distance * force;
      }
      positions.forEach(position => {
        position.x = Math.max(0.05, Math.min(0.95, position.x + (0.5 - position.x) * 0.004));
        position.y = Math.max(0.07, Math.min(0.93, position.y + (0.5 - position.y) * 0.004));
      });
    }
    return positions.map(position => ({
      ...position,
      x: 5 + position.x * 90,
      y: 6 + position.y * 88,
      degree: edges.filter(edge => edge.source === position.id || edge.target === position.id).length,
    }));
  })();
  const projectAgentPendingChanges = projectAgentSession?.changes.filter(change => change.status === 'pending') || [];
  const projectAgentChangeLabel = (change: ProjectAgentChange) => {
    switch (change.type) {
      case 'project.update': return '更新小说资料';
      case 'outline.upsert': return change.targetId ? '更新大纲' : '新建大纲';
      case 'card.upsert': return change.targetId ? '更新卡片' : '新建卡片';
      case 'memory.document.upsert': return '整理记忆文档';
      case 'graph.node.upsert': return '更新图谱节点';
      case 'graph.edge.upsert': return '更新图谱关系';
      case 'chapter.create': return '新建章节草稿';
      case 'chapter.update': return '修订章节正文';
      case 'chapter.titles': return '批量补章节标题';
      case 'chapter.parts': return '拆分超长章节';
      case 'chapter.delete': return '删除章节';
    }
  };
  const projectAgentChangeDetail = (change: ProjectAgentChange) => {
    if (change.type === 'project.update') return Object.keys(change.patch).join('、');
    if (change.type === 'outline.upsert') return `${change.kind} · ${change.title}`;
    if (change.type === 'card.upsert') return `${change.cardType} · ${change.title}`;
    if (change.type === 'memory.document.upsert') return `${change.kind} · ${change.title}`;
    if (change.type === 'graph.node.upsert') return `${change.nodeType} · ${change.label}`;
    if (change.type === 'graph.edge.upsert') return `${change.source} -[${change.label}]-> ${change.target}`;
    if (change.type === 'chapter.delete') return `${change.title || `章节 ${change.targetId}`} · 删除后不可恢复`;
    if (change.type === 'chapter.titles') {
      const stripped = change.titles.filter(item => item.stripHeading).length;
      return `${change.titles.length} 章${stripped ? ` · 其中 ${stripped} 章同时把正文开头的标题行移走` : ''}`;
    }
    if (change.type === 'chapter.parts') {
      const added = change.splits.reduce((sum, item) => sum + item.breakAfter.length, 0);
      return `${change.splits.length} 章拆成 ${change.splits.length + added} 章 · 正文不改写`;
    }
    if (change.type === 'chapter.update') {
      const target = editingProject?.chapters.find(item => item.id === change.targetId);
      return `${target?.title || `章节 ${change.targetId}`} · ${countNovelCharacters(change.content).toLocaleString()} 字${target ? `（原 ${target.wordCount.toLocaleString()} 字）` : ''}`;
    }
    return `${change.title} · ${countNovelCharacters(change.content).toLocaleString()} 字`;
  };
  const projectAgentChangePreview = (change: ProjectAgentChange) => {
    if (change.type === 'project.update') return JSON.stringify(change.patch, null, 2);
    if (change.type === 'outline.upsert' || change.type === 'card.upsert' || change.type === 'memory.document.upsert' || change.type === 'chapter.create' || change.type === 'chapter.update') return change.content;
    if (change.type === 'graph.node.upsert') return change.content || change.nodeStatus || projectAgentChangeDetail(change);
    if (change.type === 'chapter.titles') {
      // 几百章一次提上来，作者必须能逐条核对新旧标题再决定要不要应用
      return change.titles.map(item => {
        const index = editingProject?.chapters.findIndex(chapter => chapter.id === item.targetId) ?? -1;
        const current = index >= 0 ? editingProject?.chapters[index]?.title : '';
        return `${index >= 0 ? `#${index + 1}` : `id ${item.targetId}`}　${current || '（无标题）'} → ${item.title}${item.stripHeading ? '　[同时移走正文标题行]' : ''}`;
      }).join('\n');
    }
    if (change.type === 'chapter.parts') {
      // 拆章不改写正文，作者要核对的是"在哪里断开、断成几章、每章多少字"
      return change.splits.map(item => {
        const index = editingProject?.chapters.findIndex(chapter => chapter.id === item.targetId) ?? -1;
        const source = index >= 0 ? editingProject?.chapters[index] : undefined;
        const paragraphs = splitParagraphs(source?.content || '');
        const stale = paragraphs.length !== item.paragraphCount;
        const bodies = stale ? [] : partsFromBreaks(paragraphs, item.breakAfter);
        const parts = item.titles.map((title, order) => `    ${order + 1}. ${title}${stale ? '' : ` · ${countNovelCharacters(bodies[order] || '').toLocaleString()} 字`}`);
        const head = `${index >= 0 ? `#${index + 1}` : `id ${item.targetId}`}　${source?.title || `章节 ${item.targetId}`}（原 ${source?.wordCount.toLocaleString() || '?'} 字）拆成 ${item.titles.length} 章`;
        return [head, ...parts, stale ? '    ⚠ 这一章的正文在提案生成后被改过，应用时会跳过它' : ''].filter(Boolean).join('\n');
      }).join('\n\n');
    }
    return projectAgentChangeDetail(change);
  };
  const visibleSkills = skills.filter(skill => {
    const matchesCategory = !skillCategoryFilter || skill.category === skillCategoryFilter;
    const query = skillSearch.trim().toLowerCase();
    return matchesCategory && (!query || `${skill.displayName || ''} ${skill.name} ${skill.description} ${skill.tags.join(' ')}`.toLowerCase().includes(query));
  });
  const activeDismantleBook = dismantleBooks.find(book => book.id === activeDismantleBookId) || null;
  const activeDismantleChapter = activeDismantleBook?.chapters.find(chapter => chapter.id === activeDismantleChapterId) || null;
  const activeLibraryBook = libraryBooks.find(book => book.id === activeLibraryBookId) || null;
  const activeLibraryChapter = activeLibraryBook?.chapters.find(chapter => chapter.id === activeLibraryChapterId) || activeLibraryBook?.chapters[0] || null;
  const visibleRankingBooks = rankingQuery.trim()
    ? rankingBooks.filter(book => `${book.title} ${book.author} ${book.intro} ${book.category || ''}`.toLowerCase().includes(rankingQuery.trim().toLowerCase()))
    : rankingBooks;
  const rankingSourceName = rankingBooks[0]?.sourceName || '';
  const outlineMode = editingProject !== null && editorSidebarTab === 'outline';
  const cardMode = editingProject !== null && editorSidebarTab === 'cards';
  const styleMode = editingProject !== null && editorSidebarTab === 'style';
  const localToday = (() => { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; })();
  const usageRows = usageDays.filter(day => {
    if (usageStartDate || usageEndDate) return (!usageStartDate || day.date >= usageStartDate) && (!usageEndDate || day.date <= usageEndDate);
    if (usageDateFilter === 'all') return true;
    if (usageDateFilter === 'today') return day.date === localToday;
    const from = new Date(); from.setHours(0, 0, 0, 0); from.setDate(from.getDate() - Number(usageDateFilter) + 1);
    return new Date(`${day.date}T00:00:00`).getTime() >= from.getTime();
  });
  const emptyUsage: RuntimeUsageSummary = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, requests: 0, startedAt: '' };
  const usageView = (usageStartDate || usageEndDate || usageDateFilter !== 'all') ? usageRows.reduce((total, day) => ({ ...total, inputTokens: total.inputTokens + day.inputTokens, outputTokens: total.outputTokens + day.outputTokens, totalTokens: total.totalTokens + day.totalTokens, cachedInputTokens: total.cachedInputTokens + day.cachedInputTokens, cacheWriteTokens: total.cacheWriteTokens + day.cacheWriteTokens, reasoningTokens: total.reasoningTokens + day.reasoningTokens, requests: total.requests + day.requests }), emptyUsage) : runtimeUsage;
  const gatewayLogTime = (log: Record<string, unknown>) => {
    const value = Number(log.created_at || 0);
    return value > 10_000_000_000 ? value : value * 1000;
  };
  const gatewayLogs: Array<Record<string, unknown> & { __keyHint: string; __keyIndex: number }> = (gatewayUsage?.accounts || []).flatMap(account => account.logs.map(log => ({ ...log, __keyHint: account.keyHint, __keyIndex: account.keyIndex }))).filter(log => {
    const timestamp = gatewayLogTime(log);
    if (!timestamp) return true;
    const date = new Date(timestamp);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    if (usageStartDate || usageEndDate) return (!usageStartDate || key >= usageStartDate) && (!usageEndDate || key <= usageEndDate);
    if (usageDateFilter === 'all') return true;
    if (usageDateFilter === 'today') return key === localToday;
    const from = new Date(); from.setHours(0, 0, 0, 0); from.setDate(from.getDate() - Number(usageDateFilter) + 1);
    return timestamp >= from.getTime();
  }).sort((left, right) => gatewayLogTime(right) - gatewayLogTime(left));
  const enabledGatewayModels = new Set([settingsDraft.model, ...settingsModels].filter(Boolean));
  const gatewayPricing = (gatewayUsage?.accounts || []).flatMap(account => (account.pricing || [])
    .filter(item => enabledGatewayModels.size === 0 || enabledGatewayModels.has(String(item.model_name || '')))
    .flatMap(item => {
      const configuredRatio = account.group && account.groupRatios?.[account.group];
      if (Number.isFinite(Number(configuredRatio))) {
        return [{ ...item, __account: account, __group: account.group, __groupRatio: Number(configuredRatio), __groupKnown: true } as GatewayPricingEntry];
      }
      // New API's read-only usage endpoint does not expose Token.Group. Do not
      // silently price an unknown key at 1x: show each usable group instead.
      const enabledGroups = Array.isArray(item.enable_groups) ? item.enable_groups.map(String) : [];
      const groups = enabledGroups.filter(group => !account.usableGroups || Object.prototype.hasOwnProperty.call(account.usableGroups, group));
      return groups.map(group => ({ ...item, __account: account, __group: group, __groupRatio: Number(account.groupRatios?.[group]), __groupKnown: false } as GatewayPricingEntry))
        .filter(entry => Number.isFinite(entry.__groupRatio));
    }));
  const gatewayQuotaPerUnit = Number(gatewayUsage?.status?.quota_per_unit || 500000);
  const gatewayCurrency = String(gatewayUsage?.status?.quota_display_type || 'CNY');
  const gatewayExchangeRate = Number(gatewayUsage?.status?.usd_exchange_rate || 1);
  const gatewayCurrencySymbol = gatewayCurrency === 'CNY' ? '¥' : gatewayCurrency === 'USD' ? '$' : String(gatewayUsage?.status?.custom_currency_symbol || gatewayCurrency);
  const formatGatewayCurrency = (usd: number, suffix = '') => `${gatewayCurrencySymbol}${Number((usd * (gatewayCurrency === 'USD' ? 1 : gatewayExchangeRate)).toFixed(6)).toLocaleString('zh-CN', { maximumFractionDigits: 6 })}${suffix}`;
  const formatGatewayPrice = (usd: number) => `${formatGatewayCurrency(usd)} / 1M tokens`;
  const parseDynamicTiers = (expression: string) => Array.from(expression.matchAll(/tier\(\s*["']([^"']+)["']\s*,\s*([^)]*)\)/gu)).map(match => ({ label: match[1], formula: match[2] }));
  const dynamicTierPrice = (formula: string, name: string, groupRatio: number) => {
    const variable = name === '输入' ? 'p' : name === '输出' ? 'c' : name === '缓存读取' ? 'cr' : 'cw';
    const pattern = new RegExp(`(?:^|[+\\s])${variable}\\s*\\*\\s*([\\d.]+)`, 'u');
    const multiplier = Number(formula.match(pattern)?.[1] || 0);
    return multiplier > 0 ? formatGatewayPrice(multiplier * groupRatio) : '-';
  };
  const staticGatewayPrice = (item: Record<string, unknown>, type: 'input' | 'output' | 'cache' | 'write', groupRatio: number) => {
    if (Number(item.quota_type) === 1) return type === 'input' ? `${formatGatewayCurrency(Number(item.model_price || 0) * groupRatio)} / 次` : '-';
    // This is New API's published model-square formula for non-tiered
    // token models. Dynamic expressions and pay-per-request models bypass it.
    const input = Number(item.model_ratio || 0) * 2 * groupRatio;
    const multiplier = type === 'output' ? Number(item.completion_ratio || 1) : type === 'cache' ? Number(item.cache_ratio ?? 1) : type === 'write' ? Number(item.create_cache_ratio ?? 1) : 1;
    return Number.isFinite(input) && input > 0 ? formatGatewayPrice(input * multiplier) : '-';
  };
  const gatewayInputPrice = (item: GatewayPricingEntry) => {
    const groupRatio = Number(item.__groupRatio);
    if (String(item.billing_mode || '') === 'tiered_expr') {
      const tier = parseDynamicTiers(String(item.billing_expr || ''))[0];
      return Number(tier?.formula.match(/(?:^|[+\s])p\s*\*\s*([\d.]+)/u)?.[1] || Number.POSITIVE_INFINITY) * groupRatio;
    }
    return Number(item.quota_type) === 1 ? Number(item.model_price || Number.POSITIVE_INFINITY) * groupRatio : Number(item.model_ratio || Number.POSITIVE_INFINITY) * 2 * groupRatio;
  };
  gatewayPricing.sort((left, right) => gatewayInputPrice(left) - gatewayInputPrice(right));

  const startupReady = !('__TAURI_INTERNALS__' in window) || (deviceStorageReady && resourceStorageReady);
  if (!startupReady) {
    return (
      <div className="startup-screen" role="status" aria-live="polite">
        <div className="startup-mark" aria-hidden="true"><img src="/zhizhang-brand.png" alt="" /></div>
        <h1>织章</h1>
        <p>{deviceStorageReady ? '正在载入本地写作资料…' : '正在启动本地数据服务…'}</p>
        <span className="startup-spinner" aria-hidden="true" />
        <small>首次启动可能需要几秒，请稍候</small>
        <PlumBranch size="lg" />
      </div>
    );
  }

  return (
    <div className="app">
      {editingProject ? (
        <div className="editor-view">
          <header className="editor-header">
            <button className="btn-back" onClick={handleCloseEditor}><Icon name="arrow-left" size={16} />返回</button>
            <h2>{editingProject.title}</h2>
            <button className={`editor-tool-button project-agent-toggle ${showProjectAgent ? 'active' : ''}`} title="打开项目 Agent 对话" onClick={() => setShowProjectAgent(current => !current)}><Icon name="sparkles" size={15} />项目 Agent{projectAgentPendingChanges.length ? ` ${projectAgentPendingChanges.length}` : ''}</button>
            {!outlineMode && !cardMode && !styleMode && editorSidebarTab !== 'search' && <>
              <button className="editor-tool-button" title="搜索当前章节" onClick={() => { setShowSearchPanel(true); setSearchScope('chapter'); window.setTimeout(() => searchInputRef.current?.focus(), 0); }}><Icon name="search" size={14} />搜索</button>
              <button className={`editor-tool-button ${writingMarksEnabled ? 'active' : ''}`} title="人物名称与禁词标记" onClick={() => setWritingMarksEnabled(current => !current)}><Icon name="highlighter" size={14} />标记</button>
              <button className="editor-tool-button" title="编辑禁词列表" onClick={() => { setBannedWordsDraft(bannedWords.join('\n')); setShowBannedWords(true); }}><Icon name="ban" size={14} />禁词</button>
              <button className="editor-tool-button" title="历史版本与回滚（Ctrl/⌘ H）" disabled={!activeChapter} onClick={() => setShowChapterHistory(true)}><Icon name="history" size={14} />历史{activeChapter?.snapshots?.length ? ` ${activeChapter.snapshots.length}` : ''}</button>
              <button className="editor-tool-button" title="通读当前章（Ctrl/⌘ P）" disabled={!activeChapter} onClick={() => setReadingMode(true)}><Icon name="book-open" size={14} />阅读</button>
              <button className="editor-tool-button" title="写作统计（Ctrl/⌘ J）" onClick={() => setShowWritingStats(true)}><Icon name="bar-chart" size={14} />统计</button>
              <button className="editor-tool-button" title="导出小说（Ctrl/⌘ E）" onClick={() => setShowExportModal(true)}><Icon name="download" size={14} />导出</button>
              <button className="editor-tool-button" title="快捷键（Ctrl/⌘ /）" onClick={() => setShowShortcuts(true)}><Icon name="keyboard" size={14} /></button>
              <button className="btn-primary editor-save-button" disabled={!activeChapter || chapterSaving} onClick={persistCurrentChapter}><Icon name="save" size={14} />{chapterSaving ? '保存中...' : '保存章节'}</button>
              <div className="editor-stats">
                <span>{autoSaveStatus === 'saving' ? '自动保存中' : autoSaveStatus === 'saved' ? '已自动保存' : autoSaveStatus === 'error' ? '保存失败' : '本地写作'}</span>
                <span>{editingProject.chapters.length} 章</span>
              </div>
            </>}
            {outlineMode && <span className="editor-mode-label">大纲编辑</span>}
            {cardMode && <span className="editor-mode-label">卡片编辑</span>}
            {styleMode && <span className="editor-mode-label">作品文风</span>}
          </header>

          {showProjectAgent && <aside className="project-agent-drawer" aria-label="项目 Agent 对话" style={{ ['--pane-project-agent' as string]: `${panes.sizes.projectAgent}px` }}>
            <PaneResizer name="projectAgent" axis="x" label="拖动调整对话抽屉宽度，双击复位" invert controller={panes} />
            <header className="project-agent-header">
              <div><strong>项目 Agent</strong><small>仅操作《{editingProject.title}》</small></div>
              <div className="project-agent-header-actions"><button className="icon-button" title="新建会话" disabled={projectAgentRunning} onClick={startNewProjectAgentSession}><Icon name="plus" size={15} /></button><button className="icon-button" title="关闭" onClick={() => setShowProjectAgent(false)}><Icon name="x" size={15} /></button></div>
            </header>
            <div className="project-agent-mode" role="tablist" aria-label="项目 Agent 模式"><button className={projectAgentSession?.mode === 'discuss' ? 'active' : ''} disabled={!projectAgentSession || projectAgentRunning} onClick={() => setProjectAgentSession(current => current ? { ...current, mode: 'discuss' } : current)}>讨论</button><button className={projectAgentSession?.mode === 'execute' ? 'active' : ''} disabled={!projectAgentSession || projectAgentRunning} onClick={() => setProjectAgentSession(current => current ? { ...current, mode: 'execute' } : current)}>执行</button></div>
            <div
              className="project-agent-messages"
              ref={projectAgentMessagesRef}
              onScroll={event => {
                const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
                // 48px 容差：浏览器的小数缩放下 scrollTop 不一定能精确等于底部
                projectAgentPinnedRef.current = scrollHeight - scrollTop - clientHeight < 48;
              }}
            >
              {!projectAgentSession ? <div className="project-agent-empty"><strong>正在读取会话</strong></div> : projectAgentSession.messages.length === 0 ? <div className="project-agent-empty"><strong>讨论全书，或让 Agent 整理项目</strong><span>执行模式下，所有写入都会先生成待确认变更。</span></div> : projectAgentSession.messages.map(message => <article key={message.id} className={`project-agent-message ${message.role} ${message.error ? 'error' : ''}`}><small>{message.role === 'user' ? '你' : '项目 Agent'}</small><p>{message.content}</p>{message.toolEvents?.length ? <div className="project-agent-tools">{message.toolEvents.map((event, index) => <span className={event.status} key={`${message.id}-${event.tool}-${index}`}><b>{event.tool}</b>{event.message}</span>)}</div> : null}</article>)}
              {projectAgentRunning && <section className="project-agent-running" aria-live="polite"><div><strong>正在处理项目</strong><span>{projectAgentProgress}%</span></div><i><b style={{ width: `${projectAgentProgress}%` }} /></i>{projectAgentActivity.map(item => <span className={item.status} key={item.id}>{item.message}</span>)}</section>}
              {projectAgentPendingChanges.length > 0 && <section className="project-agent-changes"><header><div><strong>待确认变更</strong><small>{projectAgentPendingChanges.length} 项，应用前不会写入</small></div><button className="link-button" disabled={projectAgentRunning} onClick={() => dismissProjectAgentChanges()}>全部放弃</button></header>{projectAgentPendingChanges.map(change => <article key={change.id}><div><strong>{projectAgentChangeLabel(change)}</strong><small>{change.summary}</small><span>{projectAgentChangeDetail(change)}</span><details><summary>预览内容</summary><pre>{projectAgentChangePreview(change)}</pre></details><div className="project-agent-change-actions"><button className="btn-secondary" disabled={projectAgentRunning} onClick={() => dismissProjectAgentChanges([change.id])}>放弃</button><button className="btn-primary" disabled={projectAgentRunning} onClick={() => void applyPendingProjectAgentChanges([change.id])}>应用</button></div></div></article>)}<button className="btn-primary" disabled={projectAgentRunning} onClick={() => void applyPendingProjectAgentChanges()}>应用全部变更</button></section>}
            </div>
            <footer className="project-agent-composer"><textarea value={projectAgentInput} disabled={!projectAgentSession || projectAgentRunning} onChange={event => setProjectAgentInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void runProjectAgentChat(); } }} placeholder={projectAgentSession?.mode === 'execute' ? '例如：整理所有角色卡，并补充知识图谱关系' : '询问全书设定、剧情、人物或伏笔'} /><div><small>Ctrl / ⌘ + Enter 发送</small><button className="btn-primary" disabled={!projectAgentInput.trim() || !projectAgentSession || projectAgentRunning} onClick={() => void runProjectAgentChat()}>{projectAgentRunning ? '处理中...' : '发送'}</button></div></footer>
          </aside>}

          {notice && (
            <div className="editor-notice" role="status" aria-live="polite">
              <div className="editor-notice-copy">
                <strong>{notice.title}</strong>
                <span>{notice.content}</span>
              </div>
              <button className="editor-notice-close" aria-label="关闭提示" onClick={() => setNotice(null)}><Icon name="x" size={15} /></button>
            </div>
          )}

          {showBannedWords && (
            <div className="editor-popover" role="dialog" aria-modal="true" aria-label="自定义禁词列表">
              <div className="editor-popover-header"><strong>禁词提示</strong><button className="icon-delete" title="关闭" onClick={() => setShowBannedWords(false)}><Icon name="x" size={14} /></button></div>
              <p>每行一个，或用逗号分隔。写作时会以红色波浪线标记。</p>
              <textarea value={bannedWordsDraft} onChange={event => setBannedWordsDraft(event.target.value)} placeholder="输入需要提示的禁词" />
              <div><button className="btn-ghost" onClick={() => setShowBannedWords(false)}>取消</button><button className="btn-primary" onClick={saveBannedWords}>保存列表</button></div>
            </div>
          )}

          <div className="editor-body">
            <aside
              className="editor-sidebar"
              style={{ ['--editor-sidebar-width' as string]: `${panes.sizes.editorSidebar}px`, ['--editor-sidebar-tabs-height' as string]: `${panes.sizes.editorSidebarTabs}px` }}
            >
              <div className="editor-sidebar-tabs" ref={sidebarTabsRef}>
                <button
                  className={editorSidebarTab === 'chapters' ? 'active' : ''}
                  onClick={() => setEditorSidebarTab('chapters')}
                >
                  <Icon name="library" size={14} />章节
                </button>
                <button
                  className={editorSidebarTab === 'search' ? 'active' : ''}
                  onClick={openProjectSearch}
                >
                  <Icon name="search" size={14} />剧情搜索
                </button>
                <button
                  className={editorSidebarTab === 'outline' ? 'active' : ''}
                  onClick={() => setEditorSidebarTab('outline')}
                >
                  <Icon name="pen" size={14} />大纲
                </button>
                <button
                  className={editorSidebarTab === 'knowledge-graph' ? 'active' : ''}
                  onClick={() => setEditorSidebarTab('knowledge-graph')}
                >
                  <Icon name="network" size={14} />知识图谱 <small>{editingProject.graphEdges.length}</small>
                </button>
                <button
                  className={editorSidebarTab === 'cards' ? 'active' : ''}
                  onClick={() => setEditorSidebarTab('cards')}
                >
                  <Icon name="cards" size={14} />卡片
                </button>
                <button
                  className={editorSidebarTab === 'style' ? 'active' : ''}
                  onClick={() => setEditorSidebarTab('style')}
                >
                  <Icon name="highlighter" size={14} />文风
                </button>
                <button
                  className={editorSidebarTab === 'knowledge' ? 'active' : ''}
                  onClick={() => setEditorSidebarTab('knowledge')}
                >
                  <Icon name="memory" size={14} />记忆中心
                </button>
                <button
                  className={editorSidebarTab === 'ai-detect' ? 'active' : ''}
                  onClick={() => setEditorSidebarTab('ai-detect')}
                >
                  <Icon name="scan" size={14} />AI 检测
                </button>
              </div>
              <PaneResizer
                name="editorSidebarTabs"
                axis="y"
                label="拖动调整标签区高度，双击复位"
                controller={panes}
                measured={() => sidebarTabsRef.current?.offsetHeight}
              />

              {editorSidebarTab === 'ai-detect' && (() => {
                const report = editingProject.aiDetection;
                const currentDetection = report?.chapters.find(item => item.chapterId === activeChapter?.id);
                const segmentCounts = (currentDetection?.segments || []).reduce<Record<AIDetectionLabel, number>>((counts, segment) => ({ ...counts, [segment.label]: counts[segment.label] + 1 }), { '人工': 0, '疑似 AI': 0, 'AI 特征': 0 });
                return <div className="ai-detection-panel">
                  <div className="panel-section-title">AI 内容检测 <span>{report?.provider || '本地初筛'}</span></div>
                  <p className="ai-detection-hint">检测会把正文分段标为人工、疑似 AI、AI 特征，并同步显示在编辑器中。结果用于本地写作自检，建议结合人物口吻、具体细节和情节逻辑进行判断。</p>
                  <div className="ai-detection-actions"><button className="btn-secondary" disabled={aiDetecting || !activeChapter} onClick={() => runAIDetection('chapter')}>{aiDetecting ? '检测中...' : '检测当前章'}</button><button className="btn-primary" disabled={aiDetecting} onClick={() => runAIDetection('book')}>检测全书</button></div>
                  {report ? <>
                    <div className="ai-detection-summary"><strong>{report.averageAIRate}%</strong><span>预估 AI 率 · {report.level}</span><small>{report.suggestion}</small></div>
                    <div className="ai-detection-metrics"><span>句子均匀度 {report.chapters.length === 1 ? `${report.chapters[0].sentenceUniformity}%` : '按章节查看'}</span><span>口语化 {report.chapters.length === 1 ? `${report.chapters[0].colloquialFrequency}/百字` : '按章节查看'}</span><span>逻辑词 {report.chapters.length === 1 ? `${report.chapters[0].logicFrequency}/百字` : '按章节查看'}</span></div>
                    {currentDetection && <section className="ai-detection-segments"><div className="ai-detection-legend"><span className="human">人工 {segmentCounts['人工']}</span><span className="suspected">疑似 AI {segmentCounts['疑似 AI']}</span><span className="ai">AI 特征 {segmentCounts['AI 特征']}</span></div><div className="ai-detection-segment-list">{currentDetection.segments?.length ? currentDetection.segments.map(segment => <div className={`ai-detection-segment ${segment.label === '人工' ? 'human' : segment.label === '疑似 AI' ? 'suspected' : 'ai'}`} key={segment.order}><div><strong>{segment.label}</strong><small>第 {segment.order} 段 · 置信度 {(segment.confidence * 100).toFixed(1)}%</small></div><p>{segment.text.trim()}</p></div>) : <p className="empty-hint compact">旧检测记录没有分段结果，请重新检测当前章节。</p>}</div></section>}
                    <div className="ai-detection-list">{report.chapters.map(item => <button type="button" className="ai-detection-item" key={item.chapterId} onClick={() => { const target = editingProject.chapters.find(chapter => chapter.id === item.chapterId); if (target) setActiveChapter(target); }}><div><strong>{item.chapterTitle}</strong><small>{item.wordCount} 字 · {item.label || '待重新检测'} · 句子均匀度 {item.sentenceUniformity}%</small></div><b className={item.aiRate >= 60 ? 'high' : item.aiRate >= 45 ? 'medium' : 'low'}>{item.aiRate}%</b></button>)}</div>
                    <small className="ai-detection-updated">更新于 {new Date(report.updatedAt).toLocaleString()}</small>
                  </> : <p className="empty-hint compact">尚未检测，选择当前章或全书开始分析。</p>}
                </div>;
              })()}

              {editorSidebarTab === 'chapters' && (() => {
                const chapters = editingProject.chapters;
                const activeIndex = activeChapter ? chapters.findIndex(item => item.id === activeChapter.id) : -1;
                const selected = activeIndex >= 0 ? chapters[activeIndex] : null;
                const recycled = editingProject.deletedChapters?.length || 0;
                return (
                <div className="chapters-panel">
                  <div className="project-writing-stats">
                    <strong>{editingProject.wordCount.toLocaleString()} <small>总字数</small></strong>
                    <span>{chapters.length} 章</span>
                  </div>
                  <div className="chapter-target-row">
                    <label htmlFor="chapter-target-words">本章目标</label>
                    <input id="chapter-target-words" className="input" type="number" min="200" step="100" value={chapterTargetWordsDraft} onChange={event => setChapterTargetWordsDraft(event.target.value)} onBlur={updateChapterTargetWords} />
                    <span>字</span>
                  </div>
                  <div className="chapter-jump-row">
                    <input
                      className="input"
                      type="text"
                      placeholder="跳转：章节序号或标题"
                      aria-label="跳转到指定章节"
                      value={chapterJumpQuery}
                      onChange={event => setChapterJumpQuery(event.target.value)}
                      onKeyDown={event => { if (event.key === 'Enter') jumpToChapterByQuery(); }}
                    />
                    <button type="button" onClick={jumpToChapterByQuery} disabled={!chapterJumpQuery.trim()}>跳转</button>
                    <button type="button" onClick={jumpToLatestChapter} disabled={!chapters.length}>最新章</button>
                  </div>
                  {/* 排序、插入、定位、删除统一放在列表上方，只作用于当前选中章节；
                      挤在列表项里会把标题压成每行三个字，长篇几乎看不到目录 */}
                  <div className="chapter-toolbar" role="toolbar" aria-label="章节操作">
                    <button type="button" title="在末尾新建章节" onClick={handleAddChapter}><Icon name="file-plus" size={13} />新建</button>
                    <button type="button" title={selected ? `上移《${selected.title}》` : '先选中章节'} aria-label="上移当前章节" disabled={activeIndex <= 0} onClick={() => { if (selected) void moveActiveChapter(selected.id, -1); }}><Icon name="chevron-up" size={13} /></button>
                    <button type="button" title={selected ? `下移《${selected.title}》` : '先选中章节'} aria-label="下移当前章节" disabled={activeIndex < 0 || activeIndex === chapters.length - 1} onClick={() => { if (selected) void moveActiveChapter(selected.id, 1); }}><Icon name="chevron-down" size={13} /></button>
                    <button type="button" title={selected ? `在《${selected.title}》后插入新章` : '先选中章节'} disabled={!selected} onClick={() => { if (selected) void insertChapterBelow(selected.id); }}><Icon name="plus" size={13} />插入</button>
                    <button type="button" title={selected ? `打开《${selected.title}》文件所在位置` : '先选中章节'} disabled={!selected} onClick={() => { if (selected) void handleOpenChapterLocation(selected); }}><Icon name="folder-open" size={13} />定位</button>
                    <button type="button" className="chapter-toolbar-danger" title={selected ? `删除《${selected.title}》` : '先选中章节'} disabled={!selected} onClick={() => { if (selected) setChapterPendingDeletion(selected); }}><Icon name="trash" size={13} />删除</button>
                    {recycled > 0 && <button type="button" className="chapter-toolbar-recycle" title="查看已删除章节" onClick={() => setShowRecycleBin(true)}><Icon name="archive" size={13} />回收站 {recycled}</button>}
                  </div>
                  <div className="chapters-list" ref={chaptersListRef}>
                    {chapters.map(chapter => (
                      <div
                        key={chapter.id}
                        data-chapter-id={chapter.id}
                        className={`chapter-item ${activeChapter?.id === chapter.id ? 'active' : ''} ${draggingChapterId === chapter.id ? 'dragging' : ''}`}
                        title={chapter.title}
                        draggable
                        onDragStart={() => setDraggingChapterId(chapter.id)}
                        onDragEnd={() => setDraggingChapterId(null)}
                        onDragOver={event => { if (draggingChapterId !== null) event.preventDefault(); }}
                        onDrop={event => { event.preventDefault(); void dropChapterOn(chapter.id); }}
                        onClick={() => selectChapter(chapter)}
                      >
                        <div className="chapter-title">{chapter.title}</div>
                        <div className="chapter-meta">{chapter.wordCount} 字{chapter.snapshots?.length ? ` · ${chapter.snapshots.length} 版本` : ''}</div>
                      </div>
                    ))}
                  </div>
                </div>
                );
              })()}

              {editorSidebarTab === 'outline' && (
                <div className="outline-panel">
                  <div className="panel-toolbar outline-toolbar">
                    <button className="btn-add-chapter" onClick={() => setShowOutlineTypeModal(true)}>+ 新建大纲</button>
                    <button className="outline-location-button" onClick={handleOpenOutlineLocation}>打开位置</button>
                  </div>
                  <div className="outline-document-list">
                    {editingProject.outlines.map(outline => (
                      <div key={outline.id} className={`outline-document-item ${activeOutlineId === outline.id ? 'active' : ''}`} onClick={() => setActiveOutlineId(outline.id)}>
                        <div><strong>{outline.kind}</strong><small>{outline.title}{outline.kind === '章纲' && outline.chapterId ? ` · ${editingProject.chapters.find(chapter => chapter.id === outline.chapterId)?.title || '未关联章节'}` : ''}</small></div>
                        <button className="icon-delete" title="删除大纲" onClick={(event) => { event.stopPropagation(); handleDeleteOutline(outline.id); }}><Icon name="trash" size={14} /></button>
                      </div>
                    ))}
                  </div>
                  {activeOutline ? (
                    <p className="outline-editor-hint">选择大纲后，在中央编辑器顶部修改标题和正文。</p>
                  ) : <p className="empty-hint">点击“新建大纲”，再选择总纲、章纲或设定文档</p>}
                </div>
              )}

              {editorSidebarTab === 'cards' && (
                <div className="cards-panel">
                  <div className="panel-toolbar">
                    <select className="select" value={cardTypeFilter} onChange={(event) => setCardTypeFilter(event.target.value as CardType | '全部')}>
                      <option value="全部">全部卡片</option>
                      <option value="角色卡">角色卡</option>
                      <option value="物品卡">物品卡</option>
                      <option value="地点卡">地点卡</option>
                      <option value="势力卡">势力卡</option>
                      <option value="金手指卡">金手指卡</option>
                    </select>
                    <button className="btn-add-chapter" onClick={startNewCard}>+ 新建</button>
                    <button className="btn-secondary" onClick={() => updateCardStatesFromBook()}>一键更新状态</button>
                  </div>
                  <div className="card-list">
                    {visibleCards.map(card => (
                      <div key={card.id} className={`knowledge-card-item ${activeCardId === card.id ? 'active' : ''}`} onClick={() => editCard(card)}>
                        <div><strong>{card.title}</strong><small>{card.type} · {card.currentState ? card.currentState.slice(0, 80) : '状态未更新'}</small></div>
                        <button className="chapter-location-button" title="打开卡片文件所在位置" aria-label={`打开${card.title}文件所在位置`} onClick={(event) => { event.stopPropagation(); handleOpenCardLocation(card); }}>打开位置</button>
                        <button className="link-button" title="全文检索并更新卡片状态" onClick={(event) => { event.stopPropagation(); editCard(card); void updateCardStatesFromBook(card.id); }}>更新状态</button>
                        <button className="icon-delete" title="删除卡片" onClick={(event) => { event.stopPropagation(); deleteCard(card.id); }}><Icon name="trash" size={14} /></button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {editorSidebarTab === 'style' && (
                <div className="project-style-panel">
                  <div className="panel-section-title">作品绑定文风 <span>{activeWritingStyle ? '已绑定' : '未绑定'}</span></div>
                  <p className="project-style-hint">绑定后，章节智能体和大纲智能体都会自动带入这份文风 Skill。</p>
                  <label className="project-style-select" htmlFor="project-style-profile">
                    <span>当前文风</span>
                    <select id="project-style-profile" className="select" value={editingProject.styleProfileId || ''} onChange={event => bindStyleToCurrentProject(event.target.value)}>
                      <option value="">默认文风</option>
                      {writingStyles.map(style => <option key={style.id} value={style.id}>{style.name}</option>)}
                    </select>
                  </label>
                  {activeWritingStyle ? <div className="project-style-summary"><strong>{activeWritingStyle.name}</strong><small>{activeWritingStyle.sourceBookId ? '拆书蒸馏' : '自定义'} · {activeWritingStyle.tags.slice(0, 4).join('、') || '未分类'}</small><p>{activeWritingStyle.description || '暂无说明'}</p></div> : <p className="empty-hint compact">选择一份全局文风后，后续生成章节和大纲都会遵循它。</p>}
                  <button className="btn-secondary project-style-manage-button" onClick={() => { setActiveTab('styles'); setStyleDraft(activeWritingStyle || writingStyles[0] || null); setEditingProject(null); }}>管理全局文风</button>
                </div>
              )}

              {editorSidebarTab === 'knowledge' && (
                <div className="knowledge-panel">
                  <div className="knowledge-toolbar">
                    <button className="knowledge-rebuild-button" onClick={rebuildMemoryDocuments}>重新整理记忆</button>
                  </div>
                  <div className="memory-kind-list">
                    {memoryDocumentKinds.map(kind => {
                      const document = editingProject.memoryDocuments.find(item => item.kind === kind);
                      return <button
                        key={kind}
                        className={`memory-kind-button ${activeMemoryDocumentId === document?.id ? 'active' : ''}`}
                        onClick={() => setActiveMemoryDocumentId(document?.id ?? memoryDocumentId(kind))}
                      >{kind}{kind === '章节快照' && <small>{editingProject.memories.length}</small>}</button>;
                    })}
                  </div>

                  {activeMemoryDocumentId === memoryDocumentId('章节快照') && (
                    <section className="snapshot-section">
                      <div className="panel-section-title">章节记忆 <span>{editingProject.memories.length} 章</span></div>
                      {editingProject.memories.length === 0 ? <p className="empty-hint">保存有正文的章节后，会在这里形成逐章记忆快照。</p> : [...editingProject.memories].sort((left, right) => chapterOrder(left) - chapterOrder(right)).map(memory => (
                        <button
                          type="button"
                          className={`memory-item memory-item-button ${activeChapterMemoryId === memory.id ? 'active' : ''}`}
                          key={memory.id}
                          onClick={() => setActiveChapterMemoryId(memory.id)}
                        >
                          <strong>{memory.sourceChapterNumber ? `第 ${memory.sourceChapterNumber} 章` : memory.chapterTitle}</strong>
                          <span className="memory-item-title">{memory.chapterTitle}</span>
                          <p>{memory.summary || '暂无摘要'}</p>
                          <small>{memory.keywords.join(' · ') || '暂无关键词'}</small>
                          <div className="memory-details">
                            <span>{memory.characterStateChanges.length} 条人物变化 · {memory.foreshadowingChanges.length} 条伏笔 · {memory.timelineEvents.length} 条时间线</span>
                            {memory.endingHook && <span>章末钩子：{memory.endingHook}</span>}
                          </div>
                        </button>
                      ))}
                    </section>
                  )}

                </div>
              )}
              <div className="editor-sidebar-footer">
                <button className="settings-button" onClick={openSettings}><Icon name="settings" size={15} />设置</button>
              </div>
            </aside>

            <PaneResizer name="editorSidebar" axis="x" label="拖动调整侧栏宽度，双击复位" controller={panes} />

            <main className="editor-main">
              {editorSidebarTab === 'search' ? (
                <section className="project-search-workspace" aria-label="剧情搜索">
                  <header className="project-search-header">
                    <div>
                      <span>作品资料检索</span>
                      <h3>剧情搜索</h3>
                      <p>搜索人物、事件、线索和伏笔，结果按章节归集。</p>
                    </div>
                    <small>{editingProject.chapters.length} 章 · {editingProject.wordCount.toLocaleString()} 字</small>
                  </header>
                  <div className="project-search-input-row">
                    <span className="search-hero-icon"><Icon name="search" size={26} /></span>
                    <input
                      ref={searchInputRef}
                      className="input"
                      value={searchQuery}
                      placeholder="搜索人物、事件、伏笔..."
                      onChange={event => { setSearchQuery(event.target.value); setBookSearchMatchIndex(0); }}
                      onKeyDown={event => { if (event.key === 'Enter' && bookSearchMatches.length) focusBookSearchMatch(bookSearchMatchIndex); }}
                    />
                    {searchQuery && <button className="project-search-clear" title="清除搜索" aria-label="清除搜索" onClick={() => setSearchQuery('')}><Icon name="x" size={14} /></button>}
                  </div>
                  <div className="project-search-tabs" role="tablist" aria-label="检索方式">
                    <button className="active" type="button">关键词</button>
                    <span>覆盖章节标题与正文</span>
                  </div>
                  <div className="project-search-replace">
                    <input className="input" value={replaceQuery} placeholder="全书替换为（留空则删除关键词）" onChange={event => setReplaceQuery(event.target.value)} />
                    <button className="btn-secondary" disabled={!searchQuery.trim() || !bookSearchMatches.length} onClick={() => void replaceAllInBook()}>全书替换 {bookSearchMatches.length || ''}</button>
                    <small>每章覆盖前自动存一条历史版本，可在“历史”里逐章回滚。</small>
                  </div>
                  {!searchQuery.trim() ? <div className="project-search-empty"><b><Icon name="search" size={42} /></b><strong>输入关键词后按回车搜索</strong><span>可检索人物、事件、地点、线索与伏笔。</span><PlumBranch /></div>
                    : bookSearchResults.length ? <div className="project-search-results">
                      <div className="project-search-summary"><strong>找到 {bookSearchMatches.length} 处匹配</strong><span>分布在 {bookSearchResults.length} 个章节</span><div><button className="editor-tool-button" onClick={() => focusBookSearchMatch(bookSearchMatchIndex - 1)} disabled={!bookSearchMatches.length}>上一个</button><button className="editor-tool-button" onClick={() => focusBookSearchMatch(bookSearchMatchIndex + 1)} disabled={!bookSearchMatches.length}>下一个</button></div></div>
                      {bookSearchResults.map(({ chapter, count, snippets }) => <article className="project-search-result" key={chapter.id}>
                        <button className="project-search-result-heading" onClick={() => openBookSearchChapter(chapter, snippets[0]?.position)}><div><strong>{chapter.title}</strong><small>{count} 处匹配 · {chapter.wordCount.toLocaleString()} 字</small></div><span>打开章节 ›</span></button>
                        {snippets.map(snippet => <button className="project-search-snippet" key={`${chapter.id}-${snippet.position}`} onClick={() => openBookSearchChapter(chapter, snippet.position)}>{snippet.text}</button>)}
                      </article>)}
                    </div> : <div className="project-search-empty"><b><Icon name="search" size={42} /></b><strong>没有找到“{searchQuery}”</strong><span>试试人物全名、事件关键词或地点名称。</span></div>}
                </section>
              ) : editorSidebarTab === 'outline' ? (
                <section className="outline-workspace">
                  {activeOutline ? <>
                    <div className="outline-workspace-header"><div><span>{activeOutline.kind}</span><input className="outline-title-input" value={activeOutline.title} onChange={event => updateActiveOutline({ title: event.target.value })} placeholder="大纲标题" /><small>Markdown 大纲文档 · 内容会自动保存</small></div><button className={`editor-tool-button ${showSearchPanel ? 'active' : ''}`} onClick={toggleSearchPanel}>搜索 / 替换</button></div>
                    {renderDocumentSearchPanel('大纲', activeOutline.content, content => updateActiveOutline({ content }))}
                    <textarea className="outline-main-editor" value={activeOutline.content} onChange={event => updateActiveOutline({ content: event.target.value })} placeholder={`编辑${activeOutline.kind}内容...`} />
                  </> : <div className="empty-state"><p>从左侧选择一个大纲开始编辑。</p></div>}
                </section>
              ) : editorSidebarTab === 'cards' ? (
                <section className="card-workspace">
                  <>
                    <div className="card-workspace-header"><span>{cardDraft.type}</span><input className="card-main-title-input" value={cardDraft.title} onChange={event => setCardDraft(current => ({ ...current, title: event.target.value }))} placeholder="卡片名称" /><small>知识卡 Markdown · 内容会自动保存</small></div>
                    <div className="card-workspace-controls"><select className="select" value={cardDraft.type} onChange={event => setCardDraft(current => ({ ...current, type: event.target.value as CardType }))}><option value="角色卡">角色卡</option><option value="物品卡">物品卡</option><option value="地点卡">地点卡</option><option value="势力卡">势力卡</option><option value="金手指卡">金手指卡</option></select><button className={`editor-tool-button ${showSearchPanel ? 'active' : ''}`} onClick={toggleSearchPanel}>搜索 / 替换</button><button className="btn-secondary" disabled={cardGenerating} onClick={generateCardWithAI}>{cardGenerating ? '生成中...' : 'AI 生成卡片'}</button>{activeCard && <button className="btn-secondary" onClick={() => void updateCardStatesFromBook(activeCard.id)}>更新状态</button>}</div>
                    <div className="card-workspace-meta"><span>当前状态：{activeCard?.currentState || '尚未更新'}</span>{activeCard && <button className="link-button" onClick={() => void updateCardStatesFromBook(activeCard.id)}>全文检索并更新状态</button>}</div>
                    {renderDocumentSearchPanel('卡片', cardDraft.content, content => setCardDraft(current => ({ ...current, content })))}
                    <textarea className="card-main-editor" value={cardDraft.content} onChange={event => setCardDraft(current => ({ ...current, content: event.target.value }))} placeholder="编辑卡片详细信息..." />
                    <div className="card-workspace-footer"><span>{countNovelCharacters(cardDraft.content)} 字</span><button className="btn-primary" onClick={saveCard}>{activeCard ? '保存卡片' : '创建卡片'}</button></div>
                  </>
                </section>
              ) : editorSidebarTab === 'style' ? (
                <section className="project-style-workspace">
                  {activeWritingStyle ? <>
                    <div className="project-style-workspace-header"><span>已绑定至本作品</span><h3>{activeWritingStyle.name}</h3><small>章节生成与大纲生成均自动引用此文风</small></div>
                    <div className="project-style-coverage"><span>章节智能体</span><b>自动带入</b><span>大纲智能体</span><b>自动带入</b></div>
                    <div className="project-style-description">{activeWritingStyle.description || '这份文风没有补充说明。'}</div>
                    <pre className="project-style-content">{activeWritingStyle.content}</pre>
                  </> : <div className="empty-state"><p>从左侧选择一份文风，后续章节和大纲生成都会自动带入。</p></div>}
                </section>
              ) : editorSidebarTab === 'knowledge-graph' ? (
                <section className="knowledge-graph-workspace">
                  <div className="knowledge-graph-header"><div><span>{graphViewMode === 'document' ? '图谱文档' : '关系视图'}</span><h3>知识图谱</h3></div><small>{editingProject.graphNodes.length} 个节点 · {editingProject.graphEdges.length} 条关系</small></div>
                  {editingProject.graphNodes.length === 0 ? <div className="empty-state"><p>保存章节并勾选知识卡后，这里会显示章节、设定和卡片的引用关系。</p></div> : <>
                    <div className="knowledge-graph-view-switch" role="tablist" aria-label="图谱显示模式">
                      <button className={graphViewMode === 'document' ? 'active' : ''} onClick={() => setGraphViewMode('document')}>文档</button>
                      <button className={graphViewMode === 'graph' ? 'active' : ''} onClick={() => setGraphViewMode('graph')}>关系图</button>
                    </div>
                    {graphViewMode === 'document' ? <div className="graph-document-view">
                      <div className="graph-document-toolbar">
                        <div className="graph-document-groups">{graphDocumentGroups.map(group => <button key={group} className={group === activeGraphDocumentGroup ? 'active' : ''} onClick={() => setGraphDocumentGroup(group)}>{group} <small>{editingProject.graphNodes.filter(node => graphNodeGroup(node) === group).length}</small></button>)}</div>
                        <div className="graph-document-controls">
                          <select className="select" value={graphDocumentType} onChange={event => setGraphDocumentType(event.target.value)}><option>全部类型</option>{graphDocumentTypeOptions.map(type => <option key={type}>{type}</option>)}</select>
                          <input className="input" type="search" value={graphDocumentQuery} placeholder="搜索节点标题或来源路径" onChange={event => setGraphDocumentQuery(event.target.value)} />
                          <label className="graph-document-isolated"><input type="checkbox" checked={graphOnlyIsolated} onChange={event => setGraphOnlyIsolated(event.target.checked)} /> 只看孤立节点</label>
                        </div>
                        <div className="graph-document-summary"><span>当前显示 {graphDocumentNodes.length} / {editingProject.graphNodes.filter(node => !activeGraphDocumentGroup || graphNodeGroup(node) === activeGraphDocumentGroup).length} 个节点</span><span>孤立节点 {editingProject.graphNodes.filter(node => !editingProject.graphEdges.some(edge => edge.source === node.id || edge.target === node.id)).length} 个</span><button className="link-button" onClick={() => setExpandedGraphDocumentIds(graphDocumentNodes.map(node => node.id))}>全部展开</button><button className="link-button" onClick={() => setExpandedGraphDocumentIds([])}>全部收起</button></div>
                      </div>
                      {graphDocumentNodes.length === 0 ? <div className="empty-state"><p>当前筛选下暂无图谱节点。</p></div> : <div className="graph-document-list">{graphDocumentNodes.map((node, index) => {
                        const relations = editingProject.graphEdges.filter(edge => edge.source === node.id || edge.target === node.id)
                          .sort((left, right) => normalizeKnowledgeGraphWeight(right.weight, right.label) - normalizeKnowledgeGraphWeight(left.weight, left.label));
                        const relatedChapterNodes = relations.map(edge => editingProject.graphNodes.find(item => item.id === (edge.source === node.id ? edge.target : edge.source))).filter((item): item is KnowledgeGraphNode => Boolean(item && item.type === 'chapter'));
                        const expanded = expandedGraphDocumentIds.includes(node.id);
                        return <article className="graph-document-node" key={node.id}>
                          <div className="graph-document-node-heading"><div><h4>{index + 1}. {node.label}</h4><span>{graphNodeTypeLabel(node)} · {relations.length} 条关联</span></div><button className="link-button" onClick={() => setExpandedGraphDocumentIds(current => current.includes(node.id) ? current.filter(id => id !== node.id) : [...current, node.id])}>{expanded ? '收起' : '展开'}</button></div>
                          {expanded && <div className="graph-document-node-body">
                            <div className="graph-document-node-actions"><button className="link-button" onClick={() => void handleOpenGraphNodeLocation(node)}>打开位置</button><span>来源路径：{graphNodeRelativePath(node)}</span></div>
                            <div className="graph-document-profile"><strong>档案</strong><textarea value={graphNodeProfile(node)} onChange={event => updateGraphNodeProfile(node.id, event.target.value)} /></div>
                            <div className="graph-document-relations"><strong>关系网络</strong>{relations.length === 0 ? <p>暂无关联关系。</p> : <table><thead><tr><th>关联对象</th><th>关系</th><th>方向</th><th>权重</th></tr></thead><tbody>{relations.map(edge => { const isSource = edge.source === node.id; const other = editingProject.graphNodes.find(item => item.id === (isSource ? edge.target : edge.source)); return <tr key={edge.id}><td><button className="link-button" onClick={() => { setActiveGraphNodeId(other?.id || null); setGraphViewMode('graph'); }}>{other?.label || '未知节点'}</button></td><td>{edge.label}</td><td>{isSource ? '指向对方' : '来自对方'}</td><td>{normalizeKnowledgeGraphWeight(edge.weight, edge.label).toFixed(2)}</td></tr>; })}</tbody></table>}</div>
                            <div className="graph-document-events"><strong>相关事件</strong>{relatedChapterNodes.length ? relatedChapterNodes.map(chapter => <span key={chapter.id}>{chapter.label}</span>) : <p>暂无直接关联事件。</p>}</div>
                          </div>}
                        </article>;
                      })}</div>}
                    </div> : <>
                      <div className={`knowledge-graph-canvas ${activeGraphNodeId ? 'is-focused' : ''}`} onClick={() => setActiveGraphNodeId(null)}>
                        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">{editingProject.graphEdges.map(edge => {
                          const source = graphLayout.find(item => item.id === edge.source);
                          const target = graphLayout.find(item => item.id === edge.target);
                          const weight = normalizeKnowledgeGraphWeight(edge.weight, edge.label);
                          const edgeFocusClass = !activeGraphNodeId ? '' : focusedGraphRelationIds.has(edge.id) ? 'related' : 'muted';
                          return source && target ? <line key={edge.id} className={edgeFocusClass} x1={source.x} y1={source.y} x2={target.x} y2={target.y} style={{ strokeWidth: `${0.3 + weight * 1.05}px` }} /> : null;
                        })}</svg>
                        {editingProject.graphNodes.map(node => {
                          const position = graphLayout.find(item => item.id === node.id) ?? { x: 50, y: 50 };
                          const nodeFocusClass = !activeGraphNodeId ? '' : activeGraphNodeId === node.id ? 'active' : focusedGraphNodeIds.has(node.id) ? 'related' : 'muted';
                          return <button key={node.id} className={`knowledge-graph-vertex ${node.type} ${nodeFocusClass}`} style={{ left: `${position.x}%`, top: `${position.y}%` }} onClick={event => { event.stopPropagation(); setActiveGraphNodeId(node.id); }}>{node.label}</button>;
                        })}
                      </div>
                      <div className="knowledge-graph-details">
                        <div><strong>{activeGraphNode?.label || '选择一个节点'}</strong><span>{activeGraphNode ? graphNodeTypeLabel(activeGraphNode) : '查看节点关联'}</span></div>
                        <div className="knowledge-graph-relations">{!activeGraphNode ? '点击图中的节点查看关联。' : editingProject.graphEdges.filter(edge => edge.source === activeGraphNode.id || edge.target === activeGraphNode.id).sort((left, right) => normalizeKnowledgeGraphWeight(right.weight, right.label) - normalizeKnowledgeGraphWeight(left.weight, left.label)).map(edge => {
                          const otherId = edge.source === activeGraphNode.id ? edge.target : edge.source;
                          const other = editingProject.graphNodes.find(node => node.id === otherId);
                          return <button key={edge.id} onClick={() => setActiveGraphNodeId(otherId)}>{edge.source === activeGraphNode.id ? '关联到' : '被引用于'} {other?.label || otherId}<small>{edge.label} · {normalizeKnowledgeGraphWeight(edge.weight, edge.label).toFixed(2)}</small></button>;
                        })}</div>
                      </div>
                    </>}
                  </>}
                </section>
              ) : editorSidebarTab === 'knowledge' && activeMemoryDocumentId === memoryDocumentId('章节快照') && activeChapterMemory ? (
                <section className="memory-snapshot-editor">
                  <div className="memory-document-header">
                    <div><span>逐章记忆快照</span><h3>{activeChapterMemory.chapterTitle}</h3></div>
                    <button className="btn-primary" onClick={saveActiveChapterMemory}>保存本章记忆</button>
                  </div>
                  <div className="memory-snapshot-form">
                    <label>章节摘要<textarea value={activeChapterMemory.summary} onChange={(event) => updateChapterMemory({ summary: event.target.value })} /></label>
                    <label>关键词 <small>每行一个，也可用顿号分隔</small><textarea value={activeChapterMemory.keywords.join('\n')} onChange={(event) => updateChapterMemory({ keywords: memoryTextList(event.target.value).slice(0, 8) })} /></label>
                    <div className="memory-snapshot-grid">
                      <label>人物状态变化<textarea value={activeChapterMemory.characterStateChanges.join('\n')} onChange={(event) => updateChapterMemory({ characterStateChanges: memoryTextList(event.target.value) })} /></label>
                      <label>角色认知变化<textarea value={activeChapterMemory.knowledgeChanges.join('\n')} onChange={(event) => updateChapterMemory({ knowledgeChanges: memoryTextList(event.target.value) })} /></label>
                      <label>伏笔追踪<textarea value={activeChapterMemory.foreshadowingChanges.join('\n')} onChange={(event) => updateChapterMemory({ foreshadowingChanges: memoryTextList(event.target.value) })} /></label>
                      <label>时间线事件<textarea value={activeChapterMemory.timelineEvents.join('\n')} onChange={(event) => updateChapterMemory({ timelineEvents: memoryTextList(event.target.value) })} /></label>
                      <label>设定事实<textarea value={activeChapterMemory.canonFacts.join('\n')} onChange={(event) => updateChapterMemory({ canonFacts: memoryTextList(event.target.value) })} /></label>
                      <label>冲突<textarea value={activeChapterMemory.conflicts.join('\n')} onChange={(event) => updateChapterMemory({ conflicts: memoryTextList(event.target.value) })} /></label>
                    </div>
                    <label>章末钩子<textarea value={activeChapterMemory.endingHook} onChange={(event) => updateChapterMemory({ endingHook: event.target.value })} /></label>
                  </div>
                  <p className="memory-document-meta">本章快照与聚合记忆会同步写入小说目录的“记忆”文件夹，并可被章节智能体按勾选项检索。</p>
                </section>
              ) : editorSidebarTab === 'knowledge' && activeMemoryDocument ? (
                <section className="memory-document-editor">
                  <div className="memory-document-header">
                    <div><span>本地记忆文档</span><h3>{activeMemoryDocument.title}</h3></div>
                    <button className="btn-primary" onClick={saveActiveMemoryDocument}>保存记忆</button>
                  </div>
                  <textarea
                    className="memory-document-content"
                    value={activeMemoryDocument.content}
                    onChange={(event) => updateMemoryDocument(activeMemoryDocument.id, event.target.value)}
                    placeholder="在此编辑记忆 Markdown..."
                  />
                  <p className="memory-document-meta">保存后写入小说目录的“{'记忆/'}{activeMemoryDocument.title}.md”，章节智能体会把该类记忆加入上下文检索。</p>
                </section>
              ) : activeChapter ? (
                <>
                  <div className="chapter-editor-toolbar">
                    <div className="chapter-toolbar-search">
                      <button className={`editor-tool-button ${showSearchPanel ? 'active' : ''}`} onClick={toggleSearchPanel}>搜索 / 替换</button>
                      <span className="search-shortcut">⌘/Ctrl F</span>
                    </div>
                    <button className="editor-tool-button" title="统一换行、清理多余空格和空行" onClick={formatActiveChapter} disabled={!activeChapter.content.trim()}>格式化正文</button>
                    <span className="chapter-goal-status">目标 {Number(editingProject.chapterTargetWords) || 3000} 字 · 上限 {Math.floor((Number(editingProject.chapterTargetWords) || 3000) * 1.2)} 字</span>
                  </div>
                  {showSearchPanel && (
                    <section className="search-panel" aria-label="搜索与替换">
                      <div className="search-panel-row">
                        <input ref={searchInputRef} className="input" value={searchQuery} placeholder="搜索本章内容" onChange={event => { setSearchQuery(event.target.value); setSearchMatchIndex(0); }} />
                        <button className="editor-tool-button" title="上一处匹配" aria-label="上一处匹配" onClick={() => focusSearchMatch(-1)} disabled={!searchQuery}><Icon name="chevron-up" size={13} /></button><button className="editor-tool-button" title="下一处匹配" aria-label="下一处匹配" onClick={() => focusSearchMatch(1)} disabled={!searchQuery}><Icon name="chevron-down" size={13} /></button>
                        <button className="icon-delete" title="关闭搜索" onClick={() => setShowSearchPanel(false)}><Icon name="x" size={14} /></button>
                      </div>
                      <div className="search-panel-row replace-row"><input className="input" value={replaceQuery} placeholder="替换为" onChange={event => setReplaceQuery(event.target.value)} /><button className="editor-tool-button" onClick={replaceCurrentMatch} disabled={!searchQuery}>替换</button><button className="editor-tool-button" onClick={replaceAllMatches} disabled={!searchQuery}>全部替换</button><small>{currentSearchMatches ? `${Math.min(searchMatchIndex + 1, currentSearchMatches)} / ${currentSearchMatches}` : '无匹配'}</small></div>
                    </section>
                  )}
                  <div className="chapter-title-wrap">
                    <input
                      type="text"
                      className="chapter-title-input"
                      value={activeChapter.title}
                      onChange={(e) => {
                        const updatedChapter = { ...activeChapter, title: e.target.value, updatedAt: new Date().toISOString() };
                        const updatedChapters = editingProject.chapters.map(c => c.id === activeChapter.id ? updatedChapter : c);
                        const updated = { ...editingProject, chapters: updatedChapters, updatedAt: new Date().toISOString() };
                        setEditingProject(updated);
                        setActiveChapter(updatedChapter);
                        setProjects(current => current.map(p => p.id === updated.id ? updated : p));
                      }}
                      placeholder="章节标题"
                    />
                    <button
                      type="button"
                      className={`chapter-quick-copy-button ${copiedTitle ? 'copied' : ''}`}
                      title="快捷复制标题（用于发布平台）"
                      aria-label="快捷复制标题"
                      disabled={!activeChapter.title.trim()}
                      onClick={() => void copyChapterTitle()}
                    >
                      <Icon name={copiedTitle ? 'check' : 'copy'} size={14} />
                      <span>{copiedTitle ? '已复制标题' : '复制标题'}</span>
                    </button>
                  </div>
                  <div className="chapter-editor-wrap">
                    <div ref={highlightLayerRef} className="chapter-highlight-layer" aria-hidden="true">{renderMarkedContent(activeChapter.content)}</div>
                    <textarea
                      ref={chapterEditorRef}
                      className="chapter-content-editor"
                      value={activeChapter.content}
                      onChange={(e) => handleUpdateChapterContent(e.target.value)}
                      onSelect={captureChapterSelection}
                      onScroll={(event) => { if (highlightLayerRef.current) highlightLayerRef.current.scrollTop = event.currentTarget.scrollTop; }}
                      placeholder="开始写作..."
                      spellCheck={false}
                    />
                    <div ref={copyMenuRef} className="chapter-floating-copy-container">
                      <div className="chapter-floating-copy-group">
                        <button
                          type="button"
                          className={`chapter-floating-copy-main-btn ${copiedContent ? 'copied' : ''}`}
                          title={`快捷复制正文（当前：${platformFormatPresetLabels[copyPreset]}）`}
                          aria-label="快捷复制正文"
                          disabled={!activeChapter.content.trim()}
                          onClick={() => void copyChapterContent()}
                        >
                          <Icon name={copiedContent ? 'check' : 'copy'} size={14} />
                          <span>{copiedContent ? '已复制正文' : '复制正文'}</span>
                        </button>
                        <button
                          type="button"
                          className={`chapter-floating-copy-trigger-btn ${showCopyDropdown ? 'active' : ''}`}
                          title="选择复制排版预设与作话选项"
                          aria-label="复制选项"
                          aria-expanded={showCopyDropdown}
                          onClick={() => setShowCopyDropdown(prev => !prev)}
                        >
                          <Icon name="chevron-down" size={12} />
                        </button>
                      </div>
                      {showCopyDropdown && (
                        <div className="chapter-copy-dropdown-menu" role="menu">
                          <div className="chapter-copy-menu-header">发布排版预设</div>
                          {(['standard', 'clean', 'compact', 'raw'] as const).map(presetKey => (
                            <button
                              key={presetKey}
                              type="button"
                              className={`chapter-copy-menu-item ${copyPreset === presetKey ? 'selected' : ''}`}
                              onClick={() => {
                                selectCopyPreset(presetKey);
                                void copyChapterContent(presetKey);
                              }}
                            >
                              <span className="preset-radio">{copyPreset === presetKey ? '●' : '○'}</span>
                              <span className="preset-name">{platformFormatPresetLabels[presetKey]}</span>
                            </button>
                          ))}
                          {Boolean(activeChapter.authorNote?.trim()) && (
                            <>
                              <div className="chapter-copy-menu-divider" />
                              <div className="chapter-copy-menu-header">作家的话 / 组合发布</div>
                              <button
                                type="button"
                                className="chapter-copy-menu-item"
                                onClick={() => void copyAuthorNote()}
                              >
                                <Icon name={copiedAuthorNote ? 'check' : 'copy'} size={13} />
                                <span className="preset-name">{copiedAuthorNote ? '已复制作家的话' : `单独复制作家的话（${countNovelCharacters(activeChapter.authorNote || '').toLocaleString()} 字）`}</span>
                              </button>
                              <button
                                type="button"
                                className="chapter-copy-menu-item"
                                onClick={() => void copyCombinedContent()}
                              >
                                <Icon name={copiedCombined ? 'check' : 'copy'} size={13} />
                                <span className="preset-name">{copiedCombined ? '已合并复制' : '合并复制（正文 + 作家的话）'}</span>
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  {authorNoteExpanded ? (
                    <div className="chapter-author-note-card">
                      <div className="chapter-author-note-header">
                        <div className="chapter-author-note-title-wrap">
                          <span className="chapter-author-note-title">作家的话 / 作家寄语 (PS)</span>
                          <span className="chapter-author-note-badge">独立统计 · 不计入正文字数</span>
                          <span className="chapter-author-note-count">
                            {countNovelCharacters(activeChapter.authorNote || '').toLocaleString()} 字
                          </span>
                        </div>
                        <div className="chapter-author-note-actions">
                          <button
                            type="button"
                            className={`chapter-author-note-copy-btn ${copiedAuthorNote ? 'copied' : ''}`}
                            title="单独复制作家的话"
                            disabled={!activeChapter.authorNote?.trim()}
                            onClick={() => void copyAuthorNote()}
                          >
                            <Icon name={copiedAuthorNote ? 'check' : 'copy'} size={13} />
                            <span>{copiedAuthorNote ? '已复制作话' : '复制作话'}</span>
                          </button>
                          <button
                            type="button"
                            className="chapter-author-note-toggle-btn"
                            title="收起作家的话输入框"
                            onClick={() => setAuthorNoteExpanded(false)}
                          >
                            <Icon name="chevron-up" size={13} />
                            <span>收起</span>
                          </button>
                        </div>
                      </div>
                      <textarea
                        className="chapter-author-note-input"
                        value={activeChapter.authorNote || ''}
                        onChange={(e) => handleUpdateChapterAuthorNote(e.target.value)}
                        placeholder="在此输入作者有话说、更新通知、求票互动或剧情彩蛋（独立存储与统计，不计入正文字数，不影响签约与全勤）..."
                        rows={3}
                        spellCheck={false}
                      />
                    </div>
                  ) : (
                    <div className="chapter-author-note-bar">
                      <button
                        type="button"
                        className="chapter-author-note-expand-trigger"
                        onClick={() => setAuthorNoteExpanded(true)}
                      >
                        <Icon name="pen" size={13} />
                        <span>
                          {activeChapter.authorNote?.trim()
                            ? `作家的话（已写 ${countNovelCharacters(activeChapter.authorNote).toLocaleString()} 字，点击展开）`
                            : '+ 添加作家的话 / 作家寄语 (PS)'}
                        </span>
                      </button>
                      {Boolean(activeChapter.authorNote?.trim()) && (
                        <button
                          type="button"
                          className={`chapter-author-note-mini-copy-btn ${copiedAuthorNote ? 'copied' : ''}`}
                          title="快捷复制作家的话"
                          onClick={() => void copyAuthorNote()}
                        >
                          <Icon name={copiedAuthorNote ? 'check' : 'copy'} size={12} />
                          <span>{copiedAuthorNote ? '已复制' : '复制作话'}</span>
                        </button>
                      )}
                    </div>
                  )}
                  <div className="chapter-live-footer">
                    <span>
                      本章实时字数 <strong>{activeChapter.wordCount.toLocaleString()}</strong>
                      {Boolean(activeChapter.authorNote?.trim()) && (
                        <span className="chapter-footer-author-note-tag">
                          {' '}· 作话 <strong>{countNovelCharacters(activeChapter.authorNote || '').toLocaleString()}</strong> 字
                        </span>
                      )}
                    </span>
                    <span>{currentSearchMatches ? `搜索到 ${currentSearchMatches} 处` : writingMarksEnabled ? `人物 ${characterNames.length} 个 · 禁词 ${bannedWords.length} 个` : '标记已关闭'}</span>
                    {activeChapter.wordCount >= (Number(editingProject.chapterTargetWords) || 3000) && <button className="link-button" onClick={handleAddChapter}>创建下一章</button>}
                  </div>
                </>
              ) : (
                <div className="empty-state">
                  <p>从左侧选择或新建章节开始写作</p>
                </div>
              )}
            </main>

          <aside className="agent-panel" style={{ ['--pane-agent-panel' as string]: `${panes.sizes.agentPanel}px` }}>
            <PaneResizer name="agentPanel" axis="x" label="拖动调整 Agent 面板宽度，双击复位" invert controller={panes} />
              <div className="agent-panel-header">
                <span>{outlineMode ? '大纲智能体' : cardMode ? '卡片创建智能体' : styleMode ? '文风说明' : 'AI 智能体'}</span>
                <select
                  className="agent-model-select"
                  value={agentConfig.model}
                  onChange={(event) => setAgentConfig(current => ({ ...current, model: event.target.value }))}
                  aria-label="选择写作模型"
                >
                  {Array.from(new Set([agentConfig.model, ...availableModels])).filter(Boolean).map(model => <option key={model} value={model}>{model}</option>)}
                </select>
              </div>

              {outlineMode ? (
                <div className="agent-panel-scroll outline-agent-panel">
                  <section className="agent-task-section">
                    <div className="agent-instruction-heading"><label>大纲创作指令</label><button type="button" className="link-button" onClick={() => { setOutlinePreviousSessionId(outlineSessionId); setOutlineSessionId(newAgentSessionId('outline')); setOutlineChatMessages([]); outlineStreamRawRef.current = ''; setOutlineStreamContent(''); }}>新建会话</button><button type="button" className={`agent-skill-button ${showAgentSkillPicker ? 'active' : ''}`} onClick={() => setShowAgentSkillPicker(current => !current)}>技能{selectedAgentSkillNames.length ? ` ${selectedAgentSkillNames.length}` : ''}</button></div>
                    <textarea value={outlineAgentInstruction} onChange={event => setOutlineAgentInstruction(event.target.value)} placeholder="描述要补全的结构、节奏、冲突和章节安排" />
                    {outlineIntentPreview && <div className={`outline-intent-preview ${outlineIntentPreview.sourceChapter || outlineIntentPreview.isFirstChapter ? '' : 'warning'}`}>
                      <strong>意图识别</strong>
                      <span>目标：{outlineIntentPreview.targetOutline.title || '未命名章纲'}</span>
                      <span>依据：{outlineIntentPreview.sourceChapter ? `第 ${chapterNumberFromText(outlineIntentPreview.sourceChapter.title) || editingProject.chapters.findIndex(chapter => chapter.id === outlineIntentPreview.sourceChapter?.id) + 1} 章正文` : outlineIntentPreview.isFirstChapter ? '世界观与作品简介（首章无需上一章正文）' : '未找到正文'}</span>
                      <small>{outlineIntentPreview.sourceMode} · 格式：{outlineIntentPreview.formatMode}</small>
                    </div>}
                    {showAgentSkillPicker && <section className="agent-skill-picker" aria-label="选择大纲技能"><div className="agent-card-picker-title"><span>本次优先技能</span><button type="button" className="link-button" onClick={() => setSelectedAgentSkillNames([])}>自动选择</button></div><p>不选时由智能体按大纲创作意图自动选择技能。</p><div className="agent-skill-options">{skills.map(skill => <label key={skill.id} className="agent-skill-option"><input type="checkbox" checked={selectedAgentSkillNames.includes(skill.name)} onChange={() => setSelectedAgentSkillNames(current => current.includes(skill.name) ? current.filter(name => name !== skill.name) : [...current, skill.name].slice(0, 6))} /><span><strong>{skill.displayName || skill.name}</strong><small>{skill.description || skill.category}</small></span></label>)}</div></section>}
                    <div className="agent-card-picker"><div className="agent-card-picker-title">大纲带入卡片 <small>{selectedOutlineCardIds.length} 张</small></div>{editingProject.cards.length === 0 ? <p className="empty-hint compact">没有可带入的知识卡</p> : editingProject.cards.map(card => <label key={card.id} className="agent-card-option"><input type="checkbox" checked={selectedOutlineCardIds.includes(card.id)} onChange={() => setSelectedOutlineCardIds(current => current.includes(card.id) ? current.filter(id => id !== card.id) : [...current, card.id])} /><span><strong>{card.title}</strong><small>{card.type}</small></span></label>)}</div>
                    {(outlineGenerating || outlineAgentActivity.length > 0) && <section className="outline-agent-activity" aria-live="polite"><div className="outline-activity-heading"><strong>大纲智能体执行过程</strong><small>{outlineGenerating ? '运行中' : '已完成'}</small></div>{outlineAgentActivity.map(item => <div key={item.id} className={`outline-activity-row ${item.status}`}><span className="outline-activity-dot" /><div><strong>{item.step === 'intent' ? '意图识别' : item.step === 'retrieve' ? '上下文装载' : item.step === 'plan' ? '事件规划' : item.step === 'draft' ? '生成章纲' : item.step === 'review' ? '承接校验' : item.step === 'complete' ? '任务完成' : item.step === 'error' ? '运行失败' : '准备运行'}</strong><span>{item.message}</span>{item.source && <small>{item.source}</small>}</div></div>)}</section>}
                    {outlineChatMessages.length > 0 && <div className="agent-chat-history">{outlineChatMessages.map((message, index) => <article key={`${message.createdAt}-${index}`} className={`agent-chat-bubble ${message.role}`}><small>{message.role === 'user' ? '你' : '大纲智能体'}</small><p>{message.content}</p></article>)}</div>}
                    {outlineGenerating && <article className="agent-chat-bubble assistant"><small>大纲智能体正在回复</small><p>{outlineStreamContent || '正在连接模型...'}</p></article>}
                    <div className="outline-agent-actions"><button className="btn-primary" disabled={outlineGenerating || !activeOutline} onClick={() => void generateOutline()}>{outlineGenerating ? '生成大纲中...' : '生成当前大纲'}</button></div>
                    {outlineGenerating && <div className="outline-agent-progress"><span className="agent-progress-dot active" /><span>{outlineAgentActivity.at(-1)?.message || '正在分析作品设定、卡片和知识图谱...'}</span></div>}
                    {agentError && <div className="agent-error">{agentError}</div>}
                  </section>
                  <p className="outline-agent-hint">大纲智能体会读取作品简介、卡片、知识图谱和当前大纲内容，生成结果会直接回填左侧文本编辑区。</p>
                </div>
              ) : cardMode ? (
                <div className="agent-panel-scroll card-agent-panel">
                  <section className="agent-task-section">
                    <div className="agent-instruction-heading"><label>卡片创建指令</label><button type="button" className="link-button" onClick={() => { setCardPreviousSessionId(cardSessionId); setCardSessionId(newAgentSessionId('card')); setCardChatMessages([]); cardStreamRawRef.current = ''; setCardStreamContent(''); }}>新建会话</button><button type="button" className="agent-skill-button" onClick={() => setShowAgentSkillPicker(current => !current)}>技能{selectedAgentSkillNames.length ? ` ${selectedAgentSkillNames.length}` : ''}</button></div>
                    <textarea value={cardAgentInstruction} onChange={event => setCardAgentInstruction(event.target.value)} placeholder="描述要补充的身份、能力、关系、限制或状态变化" />
                    {showAgentSkillPicker && <section className="agent-skill-picker" aria-label="选择卡片技能"><div className="agent-card-picker-title"><span>本次优先技能</span><button type="button" className="link-button" onClick={() => setSelectedAgentSkillNames([])}>自动选择</button></div><div className="agent-skill-options">{skills.map(skill => <label key={skill.id} className="agent-skill-option"><input type="checkbox" checked={selectedAgentSkillNames.includes(skill.name)} onChange={() => setSelectedAgentSkillNames(current => current.includes(skill.name) ? current.filter(name => name !== skill.name) : [...current, skill.name].slice(0, 6))} /><span><strong>{skill.displayName || skill.name}</strong><small>{skill.description || skill.category}</small></span></label>)}</div></section>}
                    <div className="card-agent-context"><span>当前卡片</span><strong>{activeCard?.title || cardDraft.title || '新建卡片'}</strong><small>{cardDraft.type} · {countNovelCharacters(cardDraft.content)} 字</small></div>
                    {cardChatMessages.length > 0 && <div className="agent-chat-history">{cardChatMessages.map((message, index) => <article key={`${message.createdAt}-${index}`} className={`agent-chat-bubble ${message.role}`}><small>{message.role === 'user' ? '你' : '卡片智能体'}</small><p>{message.content}</p></article>)}</div>}
                    {cardGenerating && <article className="agent-chat-bubble assistant"><small>卡片智能体正在回复</small><p>{cardStreamContent || '正在连接模型...'}</p></article>}
                    <button className="agent-run-button" disabled={!cardDraft.title.trim() && !cardDraft.content.trim() || cardGenerating} onClick={() => void generateCardWithAI()}>{cardGenerating ? '卡片生成中...' : '运行卡片创建智能体'}</button>
                    {cardGenerating && <div className="outline-agent-progress"><span className="agent-progress-dot active" /><span>正在分析作品设定、章节和已有卡片...</span></div>}
                    <p className="outline-agent-hint">卡片智能体会读取作品简介、大纲、当前章节和已有知识卡，生成结果会直接回填中间卡片编辑区。</p>
                  </section>
                </div>
              ) : styleMode ? (
                <div className="agent-panel-scroll style-agent-panel">
                  <section className="agent-task-section">
                    <div className="agent-instruction-heading"><label>文风应用范围</label></div>
                    {activeWritingStyle ? <>
                      <div className="card-agent-context"><span>当前绑定</span><strong>{activeWritingStyle.name}</strong><small>{activeWritingStyle.tags.join('、') || '无标签'}</small></div>
                    <div className="style-agent-coverage"><div><strong>章节智能体</strong><span>生成正文时作为专用文风 Skill 带入。</span></div><div><strong>大纲智能体</strong><span>生成总纲、章纲和设定时同样带入，保证创作方向一致。</span></div></div>
                    </> : <p className="empty-hint compact">尚未绑定文风。请在左侧选择一份全局文风。</p>}
                  </section>
                </div>
              ) : (
              <div className="agent-panel-scroll">
                <section className="agent-task-section">
                  <div className="agent-instruction-heading"><label>创作指令</label><button type="button" className="link-button" onClick={() => { setChapterPreviousSessionId(chapterSessionId); setChapterSessionId(newAgentSessionId('chapter')); setAgentDraft(null); setAgentDisplayContent(''); setAgentProgress([]); }}>新建会话</button><button type="button" className={`agent-skill-button ${showAgentSkillPicker ? 'active' : ''}`} onClick={() => setShowAgentSkillPicker(current => !current)}>技能{selectedAgentSkillNames.length ? ` ${selectedAgentSkillNames.length}` : ''}</button></div>
                  <textarea value={agentInstruction} onChange={(event) => setAgentInstruction(event.target.value)} />
                  {showAgentSkillPicker && <section className="agent-skill-picker" aria-label="选择本次写作技能">
                    <div className="agent-card-picker-title"><span>本次优先技能</span><button type="button" className="link-button" onClick={() => setSelectedAgentSkillNames([])}>自动选择</button></div>
                    <p>不选时由智能体按创作意图自动调用；勾选后会优先带入，章节承接和下一章计划仍会自动保留。</p>
                    <div className="agent-skill-options">{skills.map(skill => <label key={skill.id} className="agent-skill-option"><input type="checkbox" checked={selectedAgentSkillNames.includes(skill.name)} onChange={() => setSelectedAgentSkillNames(current => current.includes(skill.name) ? current.filter(name => name !== skill.name) : [...current, skill.name].slice(0, 6))} /><span><strong>{skill.displayName || skill.name}</strong><small>{skill.description || skill.category}</small></span></label>)}</div>
                  </section>}
                  <div className="ai-writing-tools">
                    <div className="agent-card-picker-title">润色 / 续写要求 <small>可选</small></div>
                    <textarea value={aiToolInstruction} onChange={event => setAIToolInstruction(event.target.value)} placeholder="例如：加强紧张感，保留冷峻文风；或让主角先观察再行动" />
                    <div className="ai-writing-tool-actions">
                      <button className="btn-secondary" disabled={aiToolRunning || !activeChapter} onClick={() => runAITool('polish')}>{aiToolRunning && aiToolMode === 'polish' ? '润色中...' : '润色选中内容 / 整章'}</button>
                      <button className="btn-secondary" disabled={aiToolRunning || !activeChapter} onClick={() => runAITool('de-ai')}>{aiToolRunning && aiToolMode === 'de-ai' ? '处理中...' : '去 AI 味'}</button>
                      <button className="btn-primary" disabled={aiToolRunning || !activeChapter} onClick={() => runAITool('continue')}>{aiToolRunning && aiToolMode === 'continue' ? '续写中...' : '生成续写'}</button>
                    </div>
                    {aiToolResult && <div className="ai-tool-result">
                      <div><strong>{aiToolResult.mode === 'continue' ? '续写草稿' : aiToolResult.mode === 'de-ai' ? '去 AI 味草稿' : '润色草稿'}</strong><span>{countNovelCharacters(aiToolResult.content)} 字{aiToolResult.maxWords ? ` / 最多 ${aiToolResult.maxWords} 字` : ''}</span></div>
                      <textarea value={aiToolResult.content} onChange={event => setAIToolResult(current => current ? { ...current, content: event.target.value } : current)} />
                      <div className="ai-writing-tool-actions"><button className="btn-secondary" onClick={() => copyText(aiToolResult.content)}>复制</button><button className="btn-primary" onClick={acceptAIToolResult}>{aiToolResult.mode === 'continue' ? '确认插入章节' : '确认替换'}</button></div>
                    </div>}
                  </div>
                  <div className="agent-card-picker">
                    <div className="agent-card-picker-title"><span>本次带入章纲</span><small>{selectedOutlineIds.filter(id => editingProject.outlines.some(outline => outline.id === id && outline.kind === '章纲')).length} 份</small></div>
                    <button type="button" className={`agent-context-select ${showChapterOutlinePicker ? 'active' : ''}`} onClick={() => setShowChapterOutlinePicker(current => !current)}>选择章纲</button>
                    {showChapterOutlinePicker && <div className="agent-context-dropdown">{editingProject.outlines.filter(outline => outline.kind === '章纲').length === 0 ? <p className="empty-hint compact">先在大纲页创建章纲</p> : editingProject.outlines.filter(outline => outline.kind === '章纲').map(outline => <label key={outline.id} className="agent-card-option"><input type="checkbox" checked={selectedOutlineIds.includes(outline.id)} onChange={() => setSelectedOutlineIds(current => current.includes(outline.id) ? current.filter(id => id !== outline.id) : [...current, outline.id])} /><span><strong>{outline.title || '未命名章纲'}</strong><small>{String(outline.chapterId ?? '') === String(activeChapter?.id ?? '') ? '当前章节' : '其他章节'}</small></span></label>)}</div>}
                    <p className="empty-hint compact">世界观与作品设定固定自动带入；总纲不会传入章节智能体。</p>
                  </div>
                  <div className="agent-card-picker">
                    <div className="agent-card-picker-title">本章带入卡片 <small>{selectedCardIds.length} 张</small></div>
                    <button type="button" className={`agent-context-select ${showChapterCardPicker ? 'active' : ''}`} onClick={() => setShowChapterCardPicker(current => !current)}>选择卡片</button>
                    {showChapterCardPicker && <div className="agent-context-dropdown">{editingProject.cards.length === 0 ? <p className="empty-hint compact">先在卡片页创建知识卡</p> : editingProject.cards.map(card => <label key={card.id} className="agent-card-option"><input type="checkbox" checked={selectedCardIds.includes(card.id)} onChange={() => toggleCardForChapter(card.id)} /><span><strong>{card.title}</strong><small>{card.type}</small></span></label>)}</div>}
                  </div>
                  <div className="agent-memory-picker">
                    <div className="agent-card-picker-title">上一章记忆 <small>自动加载</small></div>
                    {(() => { const previous = activeChapter ? editingProject.chapters[editingProject.chapters.findIndex(chapter => chapter.id === activeChapter.id) - 1] : undefined; const memory = previous ? editingProject.memories.find(item => item.chapterId === previous.id) : undefined; return memory ? <div className="agent-context-fixed-item"><strong>{memory.sourceChapterNumber ? `第 ${memory.sourceChapterNumber} 章` : memory.chapterTitle}</strong><small>{memory.summary || '已自动加载上一章结构化记忆'}</small></div> : <p className="empty-hint compact">上一章暂无结构化记忆。</p>; })()}
                  </div>
                  <button className={`agent-run-button ${agentRunning(agentStage) ? 'running' : ''}`} aria-busy={agentRunning(agentStage)} onClick={runChapterAgent}>
                    {agentRunning(agentStage) ? `智能体执行中 · ${agentProgressPercent}%` : '运行章节智能体'}
                  </button>
                </section>

                {agentProgress.length > 0 && (
                  <section className={`agent-progress-panel ${agentStage === 'error' ? 'error' : agentStage === 'done' ? 'done' : ''}`} aria-live="polite">
                    <div className="agent-progress-heading">
                      <div><strong>智能体执行过程</strong><small>{agentProgressMessage || agentStageLabel[agentStage]}</small></div>
                      <span>{agentProgressPercent}%</span>
                    </div>
                    <div className="agent-progress-bar" aria-label={`智能体进度 ${agentProgressPercent}%`}><i style={{ width: `${agentProgressPercent}%` }} /></div>
                    <ol className="agent-progress-steps">
                      {agentProgress.map(item => (
                        <li key={item.id} className={item.status}>
                          <span className="agent-progress-dot" aria-hidden="true" />
                          <div><strong>{item.label}</strong><small>{item.message || item.description}</small></div>
                          <b>{item.status === 'complete' ? '完成' : item.status === 'active' ? '进行中' : item.status === 'error' ? '失败' : '等待'}</b>
                        </li>
                      ))}
                    </ol>
                  </section>
                )}

                {contextTrace.length > 0 && (
                  <details className="context-trace-panel" open>
                    <summary><strong>上下文追逐</strong><span>{contextTrace.length} 个步骤 · 实时追踪资料如何被检索与装载</span></summary>
                    <ol className="context-trace-list">
                      {contextTrace.map(item => (
                        <li key={item.id} className={`context-trace-item ${item.status || ''}`}>
                          <span className="context-trace-marker" />
                          <div><strong>{item.action}</strong><small>{item.source || item.step}{item.items !== undefined ? ` · ${item.items} 项` : ''}{item.bytes ? ` · ${(item.bytes / 1024).toFixed(1)} KB` : ''}</small></div>
                          <b>{item.status === 'cached' ? '命中缓存' : item.status === 'pruned' ? '已裁剪' : item.status === 'searching' ? '检索中' : item.status === 'selected' ? '已选择' : '已装载'}</b>
                        </li>
                      ))}
                    </ol>
                  </details>
                )}

                {agentError && <div className="agent-error">{agentError}</div>}

                {agentDraft?.draftContent && (
                  <section className="agent-result-section">
                    <div className="agent-result-title"><strong>章节草稿</strong><span>{countNovelCharacters(agentDraft.draftContent)} 字</span></div>
                    {(agentDraft.recognizedIntent || agentDraft.selectedSkills?.length) && <div className="agent-intent-result"><span>识别意图：{agentDraft.recognizedIntent || '章节创作与续写'}</span>{agentDraft.selectedSkills?.map(skill => <b key={skill}>{skills.find(item => item.name === skill)?.displayName || skill}</b>)}</div>}
                    {agentDraft.prewriteCheck && <div className={`agent-prewrite-check ${agentDraft.prewriteCheck.blockers.length ? 'warning' : 'passed'}`}><strong>{agentDraft.prewriteCheck.summary}</strong>{agentDraft.prewriteCheck.blockers.map(item => <span key={`block-${item}`}>阻断：{item}</span>)}{agentDraft.prewriteCheck.warnings.map(item => <span key={`warn-${item}`}>提醒：{item}</span>)}</div>}
                    {agentDraft.chapterPlan && <details className="agent-chapter-plan" open>
                      <summary>下一章执行计划</summary>
                      <div className="agent-plan-meta">已交给正文节点执行，接受草稿前可先核对承接与钩子。</div>
                      <div className="agent-plan-content">{readableChapterPlan(agentDraft.chapterPlan).split(/\n{2,}/u).map((section, index) => <p key={`${index}-${section.slice(0, 24)}`}>{section}</p>)}</div>
                    </details>}
                    {agentDraft.contextReport && <div className="agent-context-report">
                      <span>本地上下文包{agentDraft.contextReport.cache === 'hit' ? '缓存命中' : '缓存未命中'}</span>
                      {agentDraft.contextReport.contextProfile && <span>动态档案：{agentDraft.contextReport.contextProfile}</span>}
                      <span>发送上下文 {((agentDraft.contextReport.draftInputBytes || agentDraft.contextReport.packedBytes || 0) / 1024).toFixed(1)} KB</span>
                      {agentDraft.contextReport.prunedBytes ? <span>已裁剪 {(agentDraft.contextReport.prunedBytes / 1024).toFixed(1)} KB</span> : null}
                      {agentDraft.contextReport.upstreamUsage?.requests ? <><span>中转输入 {agentDraft.contextReport.upstreamUsage.inputTokens.toLocaleString()} tokens</span><span>中转输出 {agentDraft.contextReport.upstreamUsage.outputTokens.toLocaleString()} tokens</span><span>中转总计 {agentDraft.contextReport.upstreamUsage.totalTokens.toLocaleString()} tokens</span><span>上游缓存命中 {agentDraft.contextReport.upstreamUsage.cachedInputTokens.toLocaleString()} tokens</span><span>上游缓存命中率 {agentDraft.contextReport.upstreamUsage.inputTokens ? `${((agentDraft.contextReport.upstreamUsage.cachedInputTokens / agentDraft.contextReport.upstreamUsage.inputTokens) * 100).toFixed(1)}%` : '未返回输入用量'}</span></> : <span>中转站未返回用量与缓存字段</span>}
                    </div>}
                    <label className="agent-draft-title">
                      <span>章节标题</span>
                      <input
                        type="text"
                        value={agentDraftTitle}
                        maxLength={160}
                        placeholder={activeChapter?.title || '给这一章起个名字'}
                        onChange={(event) => setAgentDraftTitle(event.target.value)}
                      />
                    </label>
                    <textarea className="agent-draft-preview" value={agentDisplayContent || agentDraft.draftContent} onChange={(event) => { setAgentDisplayContent(event.target.value); setAgentDraft({ ...agentDraft, draftContent: event.target.value }); }} />
                    {agentDraft.summary && <p className="agent-summary">{agentDraft.summary}</p>}
                    {agentDraft.reviewResult && (
                      <div className={`agent-review ${agentDraft.reviewResult.consistent ? 'passed' : 'warning'}`}>
                        <strong>{agentDraft.reviewResult.consistent ? '一致性审查通过' : '发现一致性问题'}</strong>
                        {agentDraft.reviewResult.issues.map(issue => <p key={issue}>{issue}</p>)}
                        {agentDraft.reviewResult.suggestions.map(suggestion => <p key={suggestion}>建议：{suggestion}</p>)}
                      </div>
                    )}
                    <div className="agent-result-actions">
                      <button className="btn-secondary" onClick={() => { setAgentDraft(null); setAgentDraftTitle(''); }}>放弃</button>
                      <button className="btn-primary" onClick={acceptAgentDraft}>接受并写入</button>
                    </div>
                  </section>
                )}
              </div>
              )}
            </aside>
          </div>
        </div>
      ) : (
        <>
      <aside className="sidebar" style={{ ['--pane-app-sidebar' as string]: `${panes.sizes.appSidebar}px` }}>
        <div className="logo">
          <span className="logo-seal" aria-hidden="true"><img src="/zhizhang-brand.png" alt="" /></span>
          <div className="logo-copy">
            <h1>织章</h1>
            <p>长篇小说写作台</p>
          </div>
        </div>

        <nav className="nav">
          <button aria-label="小说管理" className={activeTab === 'projects' ? 'active' : ''} onClick={() => setActiveTab('projects')}>
            <span className="nav-icon"><Icon name="book-open" size={17} /></span><span className="nav-label">小说</span>
          </button>
          <button className={activeTab === 'books' ? 'active' : ''} onClick={() => setActiveTab('books')}>
            <span className="nav-icon"><Icon name="library" size={17} /></span><span className="nav-label">书籍</span><small>{libraryBooks.length}</small>
          </button>
          <button
            className={activeTab === 'dismantles' ? 'active' : ''}
            onClick={() => { setActiveTab('dismantles'); if (!activeDismantleBookId && dismantleBooks[0]) { setActiveDismantleBookId(dismantleBooks[0].id); setActiveDismantleChapterId(dismantleBooks[0].chapters[0]?.id || null); } }}
          >
            <span className="nav-icon"><Icon name="scissors" size={17} /></span><span className="nav-label">拆书</span><small>{dismantleBooks.length}</small>
          </button>
          <button className={activeTab === 'rankings' ? 'active' : ''} onClick={() => setActiveTab('rankings')}>
            <span className="nav-icon"><Icon name="chart" size={17} /></span><span className="nav-label">扫榜</span><small>{rankingBooks.length}</small>
          </button>
          <button className={activeTab === 'skills' ? 'active' : ''} onClick={() => setActiveTab('skills')}>
            <span className="nav-icon"><Icon name="sparkles" size={17} /></span><span className="nav-label">技能</span><small>{skills.length}</small>
          </button>
          <button className={activeTab === 'styles' ? 'active' : ''} onClick={() => { setActiveTab('styles'); setStyleDraft(current => current || writingStyles[0] || null); }}>
            <span className="nav-icon"><Icon name="pen" size={17} /></span><span className="nav-label">文风</span><small>{writingStyles.length}</small>
          </button>
          <button className="mobile-more-button" aria-expanded={showMobileMore} onClick={() => setShowMobileMore(current => !current)}>
            <span className="nav-icon"><Icon name="more" size={17} /></span><span className="nav-label">更多</span>
          </button>
        </nav>
        <div className={`mobile-more-menu ${showMobileMore ? 'open' : ''}`}>
          <button className={activeTab === 'skills' ? 'active' : ''} onClick={() => { setActiveTab('skills'); setShowMobileMore(false); }}><Icon name="sparkles" size={15} />技能管理 <small>{skills.length}</small></button>
          <button className={activeTab === 'styles' ? 'active' : ''} onClick={() => { setActiveTab('styles'); setStyleDraft(current => current || writingStyles[0] || null); setShowMobileMore(false); }}><Icon name="pen" size={15} />文风管理 <small>{writingStyles.length}</small></button>
        </div>
        <div className="sidebar-footer">
          <PlumBranch size="sm" flip />
          <button className="settings-button" onClick={openSettings}><Icon name="settings" size={17} /><b>设置</b></button>
        </div>
      </aside>

      <PaneResizer name="appSidebar" axis="x" label="拖动调整侧栏宽度，双击复位" controller={panes} />

      <main className="main">
        {activeTab === 'projects' && (
          <div className="projects">
            {projects.length === 0 ? (
              <div className="empty-project-home">
                <div className="empty-project-copy">
                  <span className="empty-project-eyebrow"><i aria-hidden="true" />新作 · 第一卷</span>
                  <h2>从一页空白，<br />写出一个世界</h2>
                  <p>故事尚未落笔。先为它起一个名字。</p>
                  <button className="btn-primary empty-project-cta" onClick={openNewProjectModal}><Icon name="file-plus" size={16} />新建小说</button>
                </div>
                <div className="empty-project-folio" aria-hidden="true"><small>ZHIZHANG</small><b>壹</b><span>本地创作空间</span></div>
                <PlumBranch size="lg" />
              </div>
            ) : (
              <>
                <header className="page-header">
                  <div><span className="page-eyebrow">本地创作空间</span><h2>小说管理</h2></div>
                  <button className="btn-primary" onClick={openNewProjectModal}><Icon name="file-plus" size={15} />新建小说</button>
                </header>
                <div className="project-grid">
                  {projects.map((project) => (
                    <div key={project.id} className="project-card">
                      <h3>{project.title}</h3>
                      <div className="project-meta">
                        <span className="genre">{project.subgenre ?? project.genre}</span>
                        {project.tags?.主题?.slice(0, 2).map(tag => <span key={tag} className="genre">{tag}</span>)}
                        <span className="status">{project.status === 'completed' ? '已完结' : '连载中'}</span>
                      </div>
                      <div className="project-stats">
                        <span>{project.wordCount.toLocaleString()} 字</span>
                        <span>更新于 {new Date(project.updatedAt).toLocaleDateString()}</span>
                      </div>
                      <div className="project-actions">
                        <button className="btn-primary" onClick={() => handleEditProject(project.id)}><Icon name="arrow-right" size={14} />进入</button>
                        <button className="btn-secondary" onClick={() => openProjectEdit(project)}><Icon name="pencil" size={14} />编辑</button>
                        <button className="btn-secondary" onClick={() => handleOpenProjectLocation(project)}><Icon name="folder-open" size={14} />打开位置</button>
                        <button className="btn-danger" onClick={() => setProjectPendingDeletion(project)}><Icon name="trash" size={14} />删除</button>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
        {activeTab === 'skills' && (
          <section className="global-management-page skills-management-page">
            <header className="page-header"><div><span className="page-eyebrow">全局写作资源</span><h2>技能管理</h2><p>管理内置与自定义写作技能。小说智能体可从这里选择并调用合适的技能。</p></div><button className="btn-primary" onClick={openNewSkill}>+ 新建技能</button></header>
            <div className="global-management-toolbar">
              <select className="select" value={skillCategoryFilter} onChange={(event) => setSkillCategoryFilter(event.target.value)}>
                <option value="">全部分类</option><option value="setup">项目设置</option><option value="write">写作</option><option value="review">审查</option><option value="polish">润色</option><option value="import">导入</option><option value="analyze">分析</option><option value="tool">工具</option><option value="creator">创建器</option>
              </select>
              <input type="search" className="input" placeholder="搜索技能名称、描述或标签" value={skillSearch} onChange={(event) => setSkillSearch(event.target.value)} />
              <button className="btn-secondary" onClick={() => { void loadSkills(); setNotice({ title: '技能已刷新', content: '已重新读取内置技能和本机自定义技能。' }); }}>刷新技能</button>
            </div>
            <div className="global-skill-grid">
              {visibleSkills.map(skill => <article className="global-skill-card" key={skill.id}>
                <div className="global-skill-card-header"><div><strong>{skill.displayName || skill.name}</strong><small>{skill.builtin ? '内置' : '自定义'} · {skillCategoryLabels[skill.category] || '未分类'}</small></div><span>{skill.tags.slice(0, 3).join(' · ') || '未分类'}</span></div>
                <p>{skill.description || '暂无描述'}</p>
                <details><summary>查看技能内容</summary><pre>{skill.content}</pre></details>
                <div className="global-card-actions"><button className="btn-secondary" onClick={() => openSkillEditor(skill)}>查看 / 编辑</button><button className="link-button danger-link" onClick={() => deleteSkill(skill)}>{skill.builtin ? '恢复默认' : '删除'}</button></div>
              </article>)}
              {!visibleSkills.length && <div className="empty-state"><p>没有匹配的技能。</p></div>}
            </div>
          </section>
        )}
        {activeTab === 'styles' && (
          <section className="global-management-page styles-management-page">
            <header className="page-header"><div><span className="page-eyebrow">全局写作资源</span><h2>文风管理</h2><p>新建或编辑文风 Skill。保存后可在每部小说的章节侧栏绑定使用。</p></div><button className="btn-primary" onClick={openNewWritingStyle}>+ 新建文风</button></header>
            <div className="global-style-workspace" style={{ ['--pane-style-list' as string]: `${panes.sizes.styleList}px` }}>
              <PaneResizer name="styleList" axis="x" label="拖动调整文风列表宽度，双击复位" controller={panes} />
              <aside className="global-style-list"><div className="panel-section-title">全部文风 <span>{writingStyles.length}</span></div>{writingStyles.map(style => <button type="button" key={style.id} className={`writing-style-item ${styleDraft?.id === style.id ? 'active' : ''}`} onClick={() => setStyleDraft(style)}><strong>{style.name}</strong><small>{style.sourceBookId ? '拆书蒸馏' : '自定义'} · {style.tags.slice(0, 3).join('、') || '未分类'}</small></button>)}{!writingStyles.length && <p className="empty-hint">暂无文风，点击“新建文风”开始。</p>}</aside>
              <section className="global-style-editor">{styleDraft ? <div className="writing-style-editor"><div className="style-editor-heading"><div><span>Skill 文档</span><h3>{styleDraft.name || '未命名文风'}</h3></div><button className={`editor-tool-button ${showSearchPanel ? 'active' : ''}`} onClick={toggleSearchPanel}>搜索 / 替换</button></div><label>文风名称<input className="input" value={styleDraft.name} onChange={event => setStyleDraft({ ...styleDraft, name: event.target.value })} /></label><label>简短说明<input className="input" value={styleDraft.description} onChange={event => setStyleDraft({ ...styleDraft, description: event.target.value })} /></label>{renderDocumentSearchPanel('文风', styleDraft.content, content => setStyleDraft({ ...styleDraft, content }))}<label>Skill 内容<textarea className="style-content-editor" value={styleDraft.content} onChange={event => setStyleDraft({ ...styleDraft, content: event.target.value })} /></label><div className="style-editor-actions"><button className="btn-primary" onClick={saveWritingStyleDraft}>保存文风</button>{writingStyles.some(style => style.id === styleDraft.id) && <button className="link-button danger-link" onClick={() => deleteWritingStyle(styleDraft.id)}>删除</button>}</div></div> : <div className="empty-state"><p>选择一个文风，或新建文风开始编辑。</p></div>}</section>
            </div>
          </section>
        )}
        {activeTab === 'books' && (
          <div className="library-page">
            <header className="page-header library-page-header"><div><span className="page-eyebrow">本地资料库</span><h2>书籍管理</h2><p>搜索书名或作者后，系统会同时查询全部书源；从结果中选择要下载的来源。</p></div><div className="library-search"><input className="input" value={bookSearchQuery} onChange={event => setBookSearchQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void runBookSearch(); }} placeholder="搜索书名或作者" /><button className="btn-primary" onClick={() => void runBookSearch()} disabled={bookSearchLoading}>{bookSearchLoading ? '全书源搜索中...' : '搜索全部书源'}</button><button className="btn-secondary" onClick={() => txtImportInputRef.current?.click()}>导入 TXT</button><input ref={txtImportInputRef} type="file" accept=".txt,text/plain" hidden onChange={event => void importLibraryTxt(event)} /></div></header>
            {librarySearchResults.length > 0 && <section className="library-search-results"><div className="panel-section-title">全部书源结果 <span>{librarySearchResults.length}</span></div><div className="library-result-grid">{librarySearchResults.map(book => <article className="library-result-card" key={book.id}><strong>{book.title}</strong><span>{book.author} · 来源：{book.source}</span><p>{book.intro || '暂无简介'}</p><button className="btn-secondary" disabled={bookDownloadRunningId === book.id} onClick={() => void downloadLibraryBook(book)}>{bookDownloadRunningId === book.id ? '下载中...' : `从${book.source}下载`}</button></article>)}</div></section>}
            <div className="library-workspace" style={{ ['--pane-library-list' as string]: `${panes.sizes.libraryList}px` }}>
              <PaneResizer name="libraryList" axis="x" label="拖动调整书籍列表宽度，双击复位" controller={panes} />
              <aside className="library-list"><div className="panel-section-title">已下载书籍 <span>{libraryBooks.length}</span></div>{libraryBooks.length === 0 ? <p className="empty-hint">还没有下载书籍。可先搜索，或从扫榜管理下载。</p> : libraryBooks.map(book => <button type="button" key={book.id} className={`library-book-item ${book.id === activeLibraryBookId ? 'active' : ''}`} onClick={() => { setActiveLibraryBookId(book.id); setActiveLibraryChapterId(book.chapters[0]?.id || null); }}><strong>{book.title}</strong><small>{book.author} · {book.chapters.length} 章</small></button>)}</aside>
              {activeLibraryBook ? <section className="library-detail"><header className="library-detail-header"><div><span>{activeLibraryBook.source}</span><h3>{activeLibraryBook.title}</h3><small>{activeLibraryBook.author} · {activeLibraryBook.chapters.length} 章 · {activeLibraryBook.chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0).toLocaleString()} 字</small></div><div className="library-detail-actions"><button className="link-button" onClick={() => void invoke<string>('open_library_book_location', { bookId: activeLibraryBook.id, bookTitle: activeLibraryBook.title }).catch(error => setNotice({ title: '打开书籍位置失败', content: String(error) }))}>打开位置</button>{activeLibraryBook.chapters.some(chapter => !chapter.downloaded) && <button className="link-button" disabled={libraryChapterDownloadRunningId === `book:${activeLibraryBook.id}`} onClick={() => void retryUnfinishedLibraryChapters(activeLibraryBook)}>{libraryChapterDownloadRunningId === `book:${activeLibraryBook.id}` ? '重新下载中...' : '重新下载未完成'}</button>}<button className="btn-primary library-dismantle-button" onClick={() => createDismantleFromLibrary(activeLibraryBook)}><span>拆</span>一键拆书</button><button className="link-button danger-link" onClick={() => void deleteLibraryBook(activeLibraryBook)}>删除</button></div></header><p className="library-intro">{activeLibraryBook.intro || '暂无简介'}</p><div className="library-reading-workspace" style={{ ['--pane-library-reader' as string]: `${panes.sizes.libraryReader}px` }}><PaneResizer name="libraryReader" axis="x" label="拖动调整章节目录宽度，双击复位" controller={panes} /><div className="library-chapter-pane"><div className="library-chapter-pane-heading"><strong>章节目录</strong><span>{activeLibraryBook.chapters.length} 章</span></div><div className="library-chapter-list">{activeLibraryBook.chapters.map(chapter => <div className={`library-chapter-row ${chapter.id === activeLibraryChapter?.id ? 'active' : ''}`} key={chapter.id}><button type="button" className="library-chapter-select" onClick={() => setActiveLibraryChapterId(chapter.id)}><span>第 {chapter.number} 章</span><strong>{chapter.title}</strong><small>{chapter.wordCount.toLocaleString()} 字 · {chapter.downloaded ? '已下载' : '未下载'}</small></button>{!chapter.downloaded && <button type="button" className="library-chapter-retry" disabled={libraryChapterDownloadRunningId === chapter.id || libraryChapterDownloadRunningId === `book:${activeLibraryBook.id}`} onClick={() => void retryLibraryChapter(activeLibraryBook, chapter)}>{libraryChapterDownloadRunningId === chapter.id ? '下载中...' : '重新下载'}</button>}</div>)}</div></div><article className="library-reader">{activeLibraryChapter ? <><header className="library-reader-header"><div><span>第 {activeLibraryChapter.number} 章</span><h4>{activeLibraryChapter.title}</h4><small>{activeLibraryChapter.wordCount.toLocaleString()} 字</small></div><button className="btn-secondary" disabled={libraryOutlineRunningId === activeLibraryChapter.id || !activeLibraryChapter.content.trim()} onClick={() => void generateLibraryChapterOutline(activeLibraryBook, activeLibraryChapter)}>{libraryOutlineRunningId === activeLibraryChapter.id ? '生成章纲中...' : '生成章纲'}</button></header>{activeLibraryChapter.unavailableReason && <div className="library-chapter-warning">{activeLibraryChapter.unavailableReason}</div>}{activeLibraryChapter.content.trim() ? <pre className="library-reader-content">{activeLibraryChapter.content}</pre> : <div className="library-reader-empty">该章节没有可阅读的本地正文。</div>}{activeLibraryChapter.outline && <details className="library-reader-outline" open><summary>本章章纲</summary><pre>{activeLibraryChapter.outline}</pre></details>}</> : <div className="library-reader-empty">选择章节开始阅读。</div>}</article></div></section> : <div className="empty-state"><p>选择一本已下载书籍查看章节。</p></div>}
            </div>
          </div>
        )}
        {activeTab === 'books' && activeLibraryBook && activeLibraryChapter && !activeLibraryChapter.downloaded && (
          <button className="library-retry-chapter-button" disabled={libraryChapterDownloadRunningId === activeLibraryChapter.id} onClick={() => void retryLibraryChapter(activeLibraryBook, activeLibraryChapter)}>
            {libraryChapterDownloadRunningId === activeLibraryChapter.id ? '重新下载中...' : '重新下载本章'}
          </button>
        )}
        {activeTab === 'rankings' && (
          <div className="ranking-page">
            <header className="page-header"><div><span className="page-eyebrow">市场观察</span><h2>扫榜管理</h2><p>聚合番茄小说网、起点和飞卢榜单，选书后可下载或进入拆书流程。</p></div><div className="ranking-header-actions"><button className="btn-primary" onClick={() => void fetchRankingBooks()} disabled={rankingLoading}>{rankingLoading ? '拉取中...' : '刷新榜单'}</button></div></header>
            <div className="ranking-toolbar"><select className="select" aria-label="榜单平台" value={rankingPlatform} onChange={event => { const nextPlatform = event.target.value as RankingPlatform; setRankingPlatform(nextPlatform); setRankingBooks([]); if (nextPlatform === 'fanqie') { setFanqieSection('male-read'); setFanqieCategoryId('all'); setRankingType('read'); } else { setRankingType(rankingTypeOptions(nextPlatform)[0].value); } }}><option value="fanqie">番茄小说网</option><option value="qidian">起点中文网</option><option value="faloo">飞卢中文网</option></select>{rankingPlatform === 'fanqie' ? <><select className="select" aria-label="番茄榜单分类" value={fanqieSection} onChange={event => { setFanqieSection(event.target.value as FanqieSection); setFanqieCategoryId('all'); }} >{fanqieSectionOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select><select className="select" aria-label="番茄题材分类" value={fanqieCategoryId} onChange={event => setFanqieCategoryId(event.target.value)} disabled={fanqieCategoriesLoading}><option value="all">{fanqieCategoriesLoading ? '分类加载中...' : '总榜'}</option>{(fanqieCategories[fanqieSection] || []).filter(category => category.id !== 'all').map(category => <option key={category.id} value={category.id}>{category.label}</option>)}</select></> : <select className="select" value={rankingType} onChange={event => setRankingType(event.target.value as RankingType)}>{rankingTypeOptions(rankingPlatform).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>}<input className="input" value={rankingQuery} onChange={event => setRankingQuery(event.target.value)} placeholder="筛选书名、作者、分类" />{rankingSourceName && <span className="ranking-source-label">数据来源：{rankingSourceName}</span>}</div>
            {visibleRankingBooks.length === 0 ? <div className="empty-state"><p>选择平台后点击“刷新榜单”。</p></div> : <div className="ranking-grid">{visibleRankingBooks.map(book => <article className="ranking-book-card" key={book.id}><div className="ranking-book-rank">{book.rank}</div><div className={`ranking-book-cover ${book.cover ? 'has-image' : ''}`}><span>{book.title.trim().slice(0, 1) || '书'}</span>{book.cover && <img src={book.cover} alt={`${book.title}封面`} loading="lazy" onError={event => event.currentTarget.parentElement?.classList.remove('has-image')} />}</div><div className="ranking-book-copy"><h3>{book.title}</h3><span>{book.author} · {book.category || '未分类'}</span><p>{book.intro || '暂无简介'}</p><small>{book.wordCount ? `${book.wordCount.toLocaleString()} 字` : '字数未知'}{book.readCount ? ` · ${book.readCount.toLocaleString()} 热度` : ''}</small><div className="ranking-book-actions"><button className="btn-secondary" disabled={bookDownloadRunningId === book.id} onClick={() => void downloadLibraryBook(book)}>{bookDownloadRunningId === book.id ? '下载中...' : '一键下载 TXT'}</button><button className="link-button" onClick={async () => { const downloaded = libraryBooks.find(item => item.title === book.title); const ready = downloaded || await downloadLibraryBook(book); if (ready) createDismantleFromLibrary(ready); }}>{bookDownloadRunningId === book.id ? '处理中...' : '一键拆书'}</button></div></div></article>)}</div>}
          </div>
        )}
        {activeTab === 'dismantles' && (
          <div className="dismantle-page">
            <header className="page-header dismantle-page-header">
              <div><span className="page-eyebrow">本地资料库</span><h2>拆书管理</h2><p>从书籍管理选择已下载小说，逐章提炼剧情结构，再生成独立原创章节。</p></div>
              <button className="btn-secondary" onClick={() => setActiveTab('books')}>去书籍管理下载</button>
            </header>
            {dismantleBooks.length === 0 ? <div className="dismantle-empty"><div className="dismantle-empty-mark">拆</div><h3>还没有拆书资料</h3><p>请先在书籍管理下载小说，再选择“加入拆书管理”。</p><button className="btn-primary" onClick={() => setActiveTab('books')}>选择本地书籍</button></div> : <div className="dismantle-workspace" style={{ ['--pane-dismantle-library' as string]: `${panes.sizes.dismantleLibrary}px` }}>
              <PaneResizer name="dismantleLibrary" axis="x" label="拖动调整拆书列表宽度，双击复位" controller={panes} />
              <aside className="dismantle-library">
                <div className="dismantle-library-heading"><div><strong>拆书书库</strong><small>{dismantleBooks.length} 部作品</small></div><button className="link-button" onClick={() => setActiveTab('books')}>选择书籍</button></div>
                <div className="dismantle-book-list">{dismantleBooks.map(book => <button type="button" key={book.id} className={`dismantle-book-item ${book.id === activeDismantleBookId ? 'active' : ''}`} onClick={() => { setActiveDismantleBookId(book.id); setActiveDismantleChapterId(book.chapters[0]?.id || null); setSelectedDismantleChapterIds(book.chapters.slice(0, 1).map(chapter => chapter.id)); }}><div><strong>{book.title}</strong><small>{book.chapters.length} 章 · {book.chapters.filter(chapter => chapter.status === 'analyzed' || chapter.status === 'rewritten').length} 章已分析</small>{book.boundProjectId && <em>已绑定小说</em>}</div></button>)}</div>
              </aside>
              {activeDismantleBook && <section className="dismantle-detail">
                <header className="dismantle-detail-header"><div><span>拆书资料</span><h3>{activeDismantleBook.title}</h3><small>{activeDismantleBook.chapters.length} 章 · {activeDismantleBook.chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0).toLocaleString()} 字</small></div><div className="dismantle-detail-actions"><button className="link-button" onClick={() => void invoke<string>('open_dismantle_location', { bookTitle: activeDismantleBook.title }).catch(error => setNotice({ title: '打开拆书位置失败', content: String(error) }))}>打开位置</button><button className="link-button danger-link" onClick={() => void deleteDismantleBook(activeDismantleBook)}>删除</button></div></header>
                <div className="dismantle-detail-toolbar"><label>绑定目标小说<select className="select" value={activeDismantleBook.boundProjectId?.toString() || ''} onChange={event => bindDismantleToProject(activeDismantleBook.id, event.target.value ? Number(event.target.value) : undefined)}><option value="">暂不绑定</option>{projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}</select></label><button className="btn-secondary" onClick={() => startDismantleImitation(activeDismantleBook)}>一键仿写此书</button><button className="btn-secondary" disabled={styleDistilling} onClick={() => void distillDismantleStyle()}>{styleDistilling ? '蒸馏中...' : '蒸馏文风 Skill'}</button><button className="btn-primary" disabled={Boolean(dismantleRunningIds.length)} onClick={() => void runDismantleAnalysis()}>{dismantleRunningIds.length ? `分析中 ${dismantleRunningIds.length} 章` : `生成选中章纲（${selectedDismantleChapterIds.length}）`}</button></div>
                <div className="dismantle-detail-body" style={{ ['--pane-dismantle-chapters' as string]: `${panes.sizes.dismantleChapters}px` }}>
                  <PaneResizer name="dismantleChapters" axis="x" label="拖动调整章节列表宽度，双击复位" controller={panes} />
                  <div className="dismantle-chapter-list"><div className="dismantle-list-heading"><strong>章节选择</strong><button className="link-button" onClick={() => setSelectedDismantleChapterIds(activeDismantleBook.chapters.map(chapter => chapter.id))}>全选</button><button className="link-button" onClick={() => setSelectedDismantleChapterIds([])}>清空</button></div>{activeDismantleBook.chapters.map(chapter => <label key={chapter.id} className={`dismantle-chapter-row ${chapter.id === activeDismantleChapterId ? 'active' : ''}`}><input type="checkbox" checked={selectedDismantleChapterIds.includes(chapter.id)} onChange={() => setSelectedDismantleChapterIds(current => current.includes(chapter.id) ? current.filter(id => id !== chapter.id) : [...current, chapter.id])} /><button type="button" onClick={() => setActiveDismantleChapterId(chapter.id)}><strong>第 {chapter.number} 章</strong><span>{chapter.title}</span><small>{chapter.wordCount.toLocaleString()} 字 · {chapter.status === 'rewritten' ? '已改写' : chapter.status === 'analyzed' ? '已分析' : chapter.status === 'analyzing' ? '分析中' : '待分析'}</small></button></label>)}</div>
                  {activeDismantleChapter && <article className="dismantle-chapter-editor"><div className="dismantle-chapter-heading"><div><span>第 {activeDismantleChapter.number} 章</span><h4>{activeDismantleChapter.title}</h4></div><button className="btn-secondary" onClick={() => void runDismantleRewrite()} disabled={dismantleRewriteRunning || !activeDismantleChapter.detailedOutline.trim()}>{dismantleRewriteRunning ? '原创生成中...' : '根据章纲生成原创稿'}</button></div><div className="dismantle-analysis-grid"><div><strong>剧情摘要</strong><textarea value={activeDismantleChapter.summary} onChange={event => updateDismantleBook(activeDismantleBook.id, book => ({ ...book, chapters: book.chapters.map(item => item.id === activeDismantleChapter.id ? { ...item, summary: event.target.value, updatedAt: new Date().toISOString() } : item), updatedAt: new Date().toISOString() }))} placeholder="分析后显示剧情摘要" /></div><div><strong>节奏判断</strong><textarea value={activeDismantleChapter.pacing} onChange={event => updateDismantleBook(activeDismantleBook.id, book => ({ ...book, chapters: book.chapters.map(item => item.id === activeDismantleChapter.id ? { ...item, pacing: event.target.value, updatedAt: new Date().toISOString() } : item), updatedAt: new Date().toISOString() }))} placeholder="开场、发展、转折、收束" /></div></div><label className="dismantle-outline-field"><strong>章节细纲（可人工修改）</strong><textarea value={activeDismantleChapter.detailedOutline} onChange={event => updateDismantleBook(activeDismantleBook.id, book => ({ ...book, chapters: book.chapters.map(item => item.id === activeDismantleChapter.id ? { ...item, detailedOutline: event.target.value, status: event.target.value.trim() ? 'analyzed' : 'pending', updatedAt: new Date().toISOString() } : item), updatedAt: new Date().toISOString() }))} placeholder="选择章节后点击生成章纲" /></label><details className="dismantle-source-details"><summary>查看原文（只读）</summary><pre>{activeDismantleChapter.sourceContent}</pre></details><label className="dismantle-outline-field"><strong>原创改写稿（确认前可编辑）</strong><textarea value={activeDismantleChapter.rewriteContent} onChange={event => updateDismantleBook(activeDismantleBook.id, book => ({ ...book, chapters: book.chapters.map(item => item.id === activeDismantleChapter.id ? { ...item, rewriteContent: event.target.value, status: event.target.value.trim() ? 'rewritten' : item.detailedOutline.trim() ? 'analyzed' : 'pending', updatedAt: new Date().toISOString() } : item), updatedAt: new Date().toISOString() }))} placeholder="AI 生成后可人工修改，确认后生成到目标小说" /></label><div className="dismantle-rewrite-footer"><input className="input" value={dismantleRewriteInstruction} onChange={event => setDismantleRewriteInstruction(event.target.value)} placeholder="原创改写要求（可选）" />{activeDismantleBook.boundProjectId && <button className="btn-primary" onClick={() => void generateDismantleChapter()}>确认并生成目标章节</button>}</div></article>}
                </div>
              </section>}
            </div>}
          </div>
        )}

      </main>

      {!editingProject && notice && (
        <div className="app-notice" role="status" aria-live="polite">
          <div className="app-notice-copy">
            <strong>{notice.title}</strong>
            <span>{notice.content}</span>
          </div>
          <button className="app-notice-close" aria-label="关闭提示" onClick={() => setNotice(null)}><Icon name="x" size={15} /></button>
        </div>
      )}
      {showNewSkillModal && (
        <div className="modal-overlay" onClick={() => setShowNewSkillModal(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="skill-modal-title" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h3 id="skill-modal-title">{skillEditingId === null ? '新建技能' : '编辑技能'}</h3>
              <button className="modal-close" aria-label="关闭" onClick={() => setShowNewSkillModal(false)}><Icon name="x" size={16} /></button>
            </div>
            <div className="modal-body">
              <div className="form-group"><label>技能名称 *</label><input type="text" className="input" placeholder="例如：场景切换" value={newSkill.name} onChange={(event) => setNewSkill({ ...newSkill, name: event.target.value })} /></div>
              <div className="form-group"><label>分类</label><select className="select" value={newSkill.category} onChange={(event) => setNewSkill({ ...newSkill, category: event.target.value })}><option value="setup">项目设置</option><option value="write">写作</option><option value="review">审查</option><option value="polish">润色</option><option value="import">导入</option><option value="analyze">分析</option><option value="tool">工具</option><option value="creator">创建器</option></select></div>
              <div className="form-group"><label>简短描述</label><input type="text" className="input" placeholder="一句话描述这个技能" value={newSkill.description} onChange={(event) => setNewSkill({ ...newSkill, description: event.target.value })} /></div>
              <div className="form-group"><label>详细内容 *</label><textarea className="textarea" rows={6} placeholder="详细说明如何使用这个技能..." value={newSkill.content} onChange={(event) => setNewSkill({ ...newSkill, content: event.target.value })} /></div>
              <div className="form-group"><label>标签（逗号分隔）</label><input type="text" className="input" placeholder="场景,过渡,技巧" value={newSkill.tags} onChange={(event) => setNewSkill({ ...newSkill, tags: event.target.value })} /></div>
              <div className="skill-creator-actions"><button className="btn-secondary" onClick={generateSkillWithAI} disabled={skillGenerating}>{skillGenerating ? '生成中...' : 'AI 生成技能草稿'}</button><span>可先填写一句需求，再由 skill-creator 补全步骤和输出格式。</span></div>
            </div>
            <div className="modal-footer"><button className="btn-ghost" onClick={() => setShowNewSkillModal(false)}>取消</button><button className="btn-primary" onClick={handleCreateSkill}>{skillEditingId === null ? '创建' : '保存修改'}</button></div>
          </div>
        </div>
      )}
      </>
      )}

      {showSettingsModal && (
        <div className="modal-overlay" onClick={() => setShowSettingsModal(false)}>
          <div className="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h3 id="settings-title">设置</h3>
              <button className="modal-close" aria-label="关闭" onClick={() => setShowSettingsModal(false)}><Icon name="x" size={16} /></button>
            </div>
            <div className="settings-layout">
              <nav className="settings-sidebar" aria-label="设置分类">
                <button className={settingsSection === 'model' ? 'active' : ''} onClick={() => setSettingsSection('model')}><strong>AI 模型配置</strong><small>服务、接口、密钥与模型参数</small></button>
                <button className={settingsSection === 'appearance' ? 'active' : ''} onClick={() => setSettingsSection('appearance')}><strong>正文外观</strong><small>字体、字号、行距与纸张模式</small></button>
                <button className={settingsSection === 'network' ? 'active' : ''} onClick={() => setSettingsSection('network')}><strong>网络设置</strong><small>代理连接与本地地址规则</small></button>
                <button className={settingsSection === 'usage' ? 'active' : ''} onClick={() => setSettingsSection('usage')}><strong>API 用量</strong><small>余额、模型价格与个人日志</small></button>
                <button className={settingsSection === 'sync' ? 'active' : ''} onClick={() => setSettingsSection('sync')}><strong>备份与同步</strong><small>百度网盘与 GitHub 仓库</small></button>
                <button className={settingsSection === 'tutorial' ? 'active' : ''} onClick={() => setSettingsSection('tutorial')}><strong>使用教程</strong><small>快速了解核心工作流</small></button>
              </nav>
            <div className="modal-body settings-content">
              {settingsSection === 'model' && <>
              <section className="settings-profile-card">
                <div className="settings-profile-header">
                  <div><strong>API 配置</strong><small>点击卡片即切换当前使用的服务，配置各自独立保存</small></div>
                  <button className="btn-secondary" onClick={() => setShowProfilePresets(current => !current)}>{showProfilePresets ? '取消' : '+ 新增配置'}</button>
                </div>
                {showProfilePresets && <div className="settings-profile-presets">
                  {profilePresets.map(preset => <button key={preset.id} type="button" onClick={() => addProfile(preset.id)}>
                    <strong>{preset.label}</strong><small>{preset.hint}</small>
                  </button>)}
                </div>}
                <div className="settings-profile-list">
                  {agentProfiles.map(profile => <div
                    key={profile.id}
                    className={`settings-profile-item ${profile.id === activeProfileId ? 'active' : ''}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => switchProfile(profile.id)}
                    onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); switchProfile(profile.id); } }}
                  >
                    <div className="settings-profile-item-main">
                      <strong>{profile.serviceName}{profile.id === activeProfileId && <em>使用中</em>}</strong>
                      <small>{apiModeLabel(profile.apiMode)} · {profile.model || '未选择模型'} · {profile.apiKey.trim() ? `Key ${profile.apiKey.slice(0, 4)}••••${profile.apiKey.slice(-4)}` : '未填 Key'}</small>
                      <code>{resolvedEndpoint(profile) || profile.baseURL}</code>
                    </div>
                    <div className="settings-profile-item-actions">
                      <button type="button" title="复制此配置" onClick={event => { event.stopPropagation(); duplicateProfile(profile.id); }}>复制</button>
                      <button type="button" title="删除此配置" disabled={agentProfiles.length <= 1} onClick={event => { event.stopPropagation(); removeProfile(profile.id); }}>删除</button>
                    </div>
                  </div>)}
                </div>
              </section>
              <section className="settings-service-card">
                <div className="settings-service-header">
                  <button className="settings-collapse-button" aria-label={settingsServiceExpanded ? '收起服务配置' : '展开服务配置'} onClick={() => setSettingsServiceExpanded(current => !current)}>{settingsServiceExpanded ? '⌄' : '›'}</button>
                  <div className="settings-service-title">
                    <strong>AI 模型配置</strong>
                    <span>服务、接口、密钥与模型参数</span>
                  </div>
                  <label className="settings-toggle" title="启用此服务">
                    <input type="checkbox" checked={settingsDraft.enabled} onChange={(event) => setSettingsDraft({ ...settingsDraft, enabled: event.target.checked })} />
                    <span />
                  </label>
                </div>
                {settingsServiceExpanded && <div className="settings-service-content">
                  <div className="form-group">
                    <label>服务名称</label>
                    <input className="input" value={settingsDraft.serviceName} onChange={(event) => setSettingsDraft({ ...settingsDraft, serviceName: event.target.value })} placeholder="服务名称" />
                  </div>
                  <div className="form-group">
                    <label>API 格式</label>
                    <div className="settings-segmented-control">
                      {apiModes.map(mode => <button
                        key={mode.value}
                        type="button"
                        className={settingsDraft.apiMode === mode.value ? 'active' : ''}
                        onClick={() => setSettingsDraft(current => ({
                          ...current,
                          apiMode: mode.value,
                          // Re-anchor the address on the new protocol's root so
                          // switching format never leaves a `/v1` mismatch.
                          baseURL: normalizeBaseURL(current.baseURL, mode.value) || defaultBaseURLFor(mode.value),
                        }))}
                      >{mode.label}</button>)}
                    </div>
                    <small className="settings-network-note">{apiModes.find(mode => mode.value === settingsDraft.apiMode)?.hint}</small>
                  </div>
                  <div className="form-group">
                    <label>接口地址 <small>{apiModeLabel(settingsDraft.apiMode)}</small></label>
                    <input className="input" value={settingsDraft.baseURL} placeholder={apiModes.find(mode => mode.value === settingsDraft.apiMode)?.placeholder} onChange={(event) => setSettingsDraft({ ...settingsDraft, baseURL: event.target.value })} />
                    <small className={`settings-network-note ${normalizeBaseURL(settingsDraft.baseURL, settingsDraft.apiMode) ? '' : 'error'}`}>
                      {normalizeBaseURL(settingsDraft.baseURL, settingsDraft.apiMode)
                        ? `实际请求地址：${resolvedEndpoint(settingsDraft)}`
                        : '地址无效：请填写完整的 http:// 或 https:// 地址'}
                    </small>
                  </div>
                  <div className="form-group">
                    <label>API 密钥</label>
                    <input className="input" type="password" value={settingsDraft.apiKey} placeholder="请输入 API Key" onChange={(event) => updatePrimaryApiKey(event.target.value)} />
                    <small className="settings-endpoint-hint">一个配置只对应一个 Key。需要多个供应商或多个分组时，在上方“+ 新增配置”建多个配置并随时切换。</small>
                  </div>
                  <div className="form-group model-management">
                    <label>模型标签 <small>可多选 · 当前模型：{settingsDraft.model || '未选择'}</small></label>
                    <div className="settings-model-tags">
                      {settingsModels.map(model => <button key={model} className={`settings-model-tag ${settingsDraft.model === model ? 'active' : ''}`} onClick={() => setCurrentSettingsModel(model)} title="点击设为当前模型"><span>{model}</span><b aria-label={`移除 ${model}`} onClick={(event) => { event.stopPropagation(); toggleSettingsModel(model); }}><Icon name="x" size={11} /></b></button>)}
                      {!settingsModels.length && <span className="settings-model-empty">暂无启用模型</span>}
                    </div>
                    <div className="settings-model-selection" aria-label="启用模型列表">
                      <span>启用模型</span>
                      {Array.from(new Set([...settingsModels, ...fetchedModels])).map(model => <label key={`select-${model}`}><input type="checkbox" checked={settingsModels.includes(model)} onChange={() => toggleSettingsModel(model)} /><span>{model}</span><button type="button" onClick={() => setCurrentSettingsModel(model)}>设为当前</button></label>)}
                    </div>
                    <div className="model-add-row">
                      <input className="input" value={customModelName} placeholder="输入模型 ID，回车添加" onChange={(event) => setCustomModelName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addCustomModel(); } }} />
                      <button className="btn-secondary" onClick={addCustomModel}>添加</button>
                    </div>
                    {fetchedModels.length > 0 && <div className="settings-fetched-models"><span>接口返回模型</span><div>{fetchedModels.map(model => <button key={model} className={settingsModels.includes(model) ? 'added' : ''} disabled={settingsModels.includes(model)} onClick={() => addSettingsModel(model)}><Icon name={settingsModels.includes(model) ? 'check' : 'plus'} size={12} />{model}</button>)}</div></div>}
                    <div className="settings-model-actions">
                      <button className="btn-secondary" onClick={pullModels} disabled={modelsLoading}>{modelsLoading ? '拉取中...' : '拉取模型'}</button>
                      <button className="btn-secondary" onClick={testSelectedModel} disabled={modelsTesting || !settingsDraft.model.trim()}>{modelsTesting ? '测试中...' : '测试模型'}</button>
                      <button className="btn-secondary" onClick={() => void runDiagnostics()} disabled={diagnosticsRunning}>{diagnosticsRunning ? '检测中...' : '检测配置'}</button>
                    </div>
                    {modelListMessage && <p className={`model-list-message ${modelListMessage.includes('失败') || modelListMessage.includes('错误') || modelListMessage.includes('无效') ? 'error' : ''}`}>{modelListMessage}</p>}
                    {settingsDiagnostics && <div className="settings-diagnostics">
                      <div className="settings-diagnostics-head">
                        <strong>配置检测结果</strong>
                        <small>{apiModeLabel(settingsDiagnostics.mode)}{settingsDiagnostics.chatEndpoint ? ` · ${settingsDiagnostics.chatEndpoint}` : ''}</small>
                        <button type="button" className="link-button" onClick={() => setSettingsDiagnostics(null)}>关闭</button>
                      </div>
                      {settingsDiagnostics.checks.map(check => <div key={check.id} className={`settings-diagnostic-row ${check.status}`}>
                        <span><Icon name={diagnosticStatusIcon[check.status]} size={14} /></span>
                        <b>{check.label}</b>
                        <p>{check.detail}</p>
                      </div>)}
                      {settingsDiagnostics.checks.every(check => check.status === 'pass') && <p className="settings-diagnostics-summary">全部检查通过，可以开始写作。</p>}
                    </div>}
                  </div>
                  <div className="settings-grid-two">
                    <div className="form-group">
                      <label>上下文窗口 <strong>{formatContextWindow(settingsDraft.contextWindow)}</strong> <small>应用侧 Token 上限，包含输入与最大输出；请按模型厂商上限选择，本设置不会扩大模型能力。OpenAI 兼容模型按 tokenizer 裁剪，Anthropic 在接口支持时用 count_tokens 校准</small></label>
                      <div className="settings-chip-row">
                        {contextWindowPresets.map(preset => <button
                          key={preset}
                          type="button"
                          className={settingsDraft.contextWindow === preset ? 'active' : ''}
                          onClick={() => setSettingsDraft({ ...settingsDraft, contextWindow: preset })}
                        >{formatContextWindow(preset)}</button>)}
                      </div>
                      <input className="settings-range" type="range" min="16" max={maxContextWindowKTokens} step="16" value={settingsDraft.contextWindow} onChange={(event) => setSettingsDraft({ ...settingsDraft, contextWindow: clampContextWindow(event.target.value) })} />
                    </div>
                    <div className="form-group">
                      <label>思考强度 <small>reasoning effort</small></label>
                      <div className="settings-chip-row">
                        {reasoningModes.map(mode => <button
                          key={mode.value}
                          type="button"
                          className={settingsDraft.reasoningMode === mode.value ? 'active' : ''}
                          title={mode.hint}
                          onClick={() => setSettingsDraft({ ...settingsDraft, reasoningMode: mode.value })}
                        >{mode.value}</button>)}
                      </div>
                      <small className="settings-network-note">{reasoningModes.find(mode => mode.value === settingsDraft.reasoningMode)?.hint}</small>
                    </div>
                  </div>
                </div>}
              </section>
              </>}
              {settingsSection === 'appearance' && <section className="settings-appearance-panel">
                <div className="settings-network-header"><div><strong>界面主题</strong><small>影响整个应用的底色、文字与强调色</small></div></div>
                <div className="appearance-theme-grid">
                  {themes.map(theme => <button
                    type="button"
                    key={theme.id}
                    className={`appearance-theme-option ${appearance.themeId === theme.id ? 'active' : ''}`}
                    onClick={() => setAppearance({ ...appearance, themeId: theme.id })}
                  >
                    <span className={`appearance-theme-swatch ${theme.id}`} aria-hidden="true" />
                    <strong>{theme.label}</strong>
                    <small>{theme.hint}</small>
                  </button>)}
                </div>
                <div className="settings-network-header"><div><strong>正文外观</strong><small>影响章节编辑器、大纲/卡片、小说预览与 Agent 对话</small></div></div>
                <div className="appearance-font-grid">
                  {readerFonts.map(font => <button
                    type="button"
                    key={font.id}
                    className={`appearance-font-card ${appearance.fontId === font.id ? 'active' : ''}`}
                    onClick={() => setAppearance({ ...appearance, fontId: font.id })}
                  >
                    <b style={{ fontFamily: font.stack || undefined }}>{font.label}</b>
                    <span style={{ fontFamily: font.stack || undefined }}>天下风云出我辈</span>
                    <small>{font.hint}</small>
                  </button>)}
                </div>
                {appearance.fontId === 'custom' && <label className="appearance-field">字体名称
                  <input className="input" value={appearance.customFont} placeholder="例如：方正书宋、汉仪Typo宋" onChange={event => setAppearance({ ...appearance, customFont: event.target.value })} />
                  <small>需要本机已安装该字体；找不到时自动回退到书籍宋体。</small>
                </label>}
                <div className="appearance-slider-row">
                  <label>字号 <b>{appearance.fontSize}px</b>
                    <input type="range" min="12" max="30" step="1" value={appearance.fontSize} onChange={event => setAppearance({ ...appearance, fontSize: Number(event.target.value) })} />
                  </label>
                  <label>行距 <b>{appearance.lineHeight.toFixed(1)}</b>
                    <input type="range" min="1.2" max="2.6" step="0.1" value={appearance.lineHeight} onChange={event => setAppearance({ ...appearance, lineHeight: Number(event.target.value) })} />
                  </label>
                </div>
                <label className="settings-network-check"><input type="checkbox" checked={appearance.paperMode} onChange={event => setAppearance({ ...appearance, paperMode: event.target.checked })} /> 纸张模式（正文区换成米白底色、深色字，白天写作更柔和）</label>
                <div className={`appearance-preview ${appearance.paperMode ? 'paper' : ''}`}>
                  <strong>第 一百三十二 章　剑落长安</strong>
                  <p>雨水沿着马面汇成细流，他抽剑的手卡了一下。三年了，这帮人终于又找上门来。“你应该知道我为何而来。”对面的人开口，声音比雨还冷。</p>
                </div>
                <small className="settings-network-note">只使用本机已装字体，不下载 Web Font，离线可用。设置保存在本机，不随备份同步。</small>
              </section>}
              {settingsSection === 'network' && <section className="settings-network-card settings-network-panel">
                <div className="settings-network-header"><div><strong>网络设置</strong><small>为模型请求配置代理连接</small></div><label className="settings-toggle" title="启用网络代理"><input type="checkbox" checked={settingsDraft.proxyEnabled} onChange={(event) => setSettingsDraft({ ...settingsDraft, proxyEnabled: event.target.checked })} /><span /></label></div>
                <div className="settings-network-address"><input className="input" value={settingsDraft.proxyURL} disabled={!settingsDraft.proxyEnabled} placeholder="http://127.0.0.1:7897" onChange={(event) => setSettingsDraft({ ...settingsDraft, proxyURL: event.target.value })} /><button className="btn-secondary" onClick={useSystemProxy}>读取系统代理</button></div>
                <label className="settings-network-check"><input type="checkbox" checked={settingsDraft.proxyBypassLocal} onChange={(event) => setSettingsDraft({ ...settingsDraft, proxyBypassLocal: event.target.checked })} /> 本地地址不走代理（推荐）</label>
                <small className="settings-network-note">支持 HTTP/HTTPS 代理，例如 Clash、Surge、V2Ray 的本地 HTTP 端口。</small>
              </section>}
              {settingsSection === 'usage' && supportsGatewayUsage(settingsDraft) && <section className="usage-dashboard">
                <div className="usage-filter-bar"><div className="usage-range-checks">{[['all', '全部时间'], ['today', '今天'], ['1', '近 1 天'], ['7', '近 7 天'], ['14', '近 14 天'], ['30', '近 30 天']].map(([value, label]) => <button type="button" key={value} className={!usageStartDate && !usageEndDate && usageDateFilter === value ? 'active' : ''} onClick={() => { setUsageStartDate(''); setUsageEndDate(''); setUsageDateFilter(value); }}>{label}</button>)}</div><div className="usage-date-controls"><label>开始<input type="date" value={usageStartDate} onChange={event => { setUsageStartDate(event.target.value); setUsageDateFilter('custom'); }} /></label><span>至</span><label>结束<input type="date" value={usageEndDate} onChange={event => { setUsageEndDate(event.target.value); setUsageDateFilter('custom'); }} /></label><button className="link-button" onClick={() => { setUsageStartDate(''); setUsageEndDate(''); setUsageDateFilter('all'); }}>重置</button></div></div>
                <div className="gateway-usage-heading"><div><strong>中转站用量</strong><small>余额、模型定价与日志直接来自你配置的中转站（需支持 New API 端点）；仅使用当前配置的 API Key 查询。</small></div><button className="btn-secondary" disabled={gatewayUsageLoading} onClick={() => void refreshGatewayUsage()}>{gatewayUsageLoading ? '刷新中...' : '刷新中转站数据'}</button></div>
                {gatewayUsageError && <p className="model-list-message error">{gatewayUsageError}</p>}
                {gatewayUsage?.errors.length ? <p className="model-list-message error">{gatewayUsage.errors.join('；')}</p> : null}
                {gatewayUsage && <>
                  <div className="gateway-balance-grid">{gatewayUsage.accounts.map(account => {
                    const available = Number(account.usage?.total_available ?? 0);
                    const used = Number(account.usage?.total_used ?? 0);
                    const unlimited = account.usage?.unlimited_quota === true;
                    const amount = (quota: number) => gatewayCurrency === 'TOKENS' ? quota.toLocaleString() : formatGatewayCurrency(quota / gatewayQuotaPerUnit);
                    return <article key={`${account.keyHint}-${account.keyIndex}`} className="gateway-balance-card"><header><strong>Key {account.keyIndex + 1}</strong><span>{account.keyHint}</span></header>{account.error ? <small className="gateway-card-error">{account.error}</small> : <><b>{unlimited ? '不限额' : amount(available)}</b><small>可用余额 · 已用 {amount(used)}</small><small>{String(account.usage?.name || '当前 API Key')}</small></>}</article>;
                  })}</div>
                  <section className="gateway-pricing"><div className="gateway-section-heading"><h4>当前启用模型价格</h4><small>直接按中转站的模型定价与分组倍率计算 · 已按输入价从低到高排序</small></div>{gatewayPricing.length ? <div className="gateway-price-table"><div className="gateway-price-row gateway-price-head"><span>模型 / Key</span><span>分组</span><span>计费类型</span><span>输入</span><span>输出</span><span>缓存读取</span><span>缓存写入</span></div>{gatewayPricing.map(item => {
                    const account = item.__account;
                    const group = item.__group || '未返回';
                    const groupRatio = Number(item.__groupRatio);
                    const dynamicTiers = String(item.billing_mode || '') === 'tiered_expr' ? parseDynamicTiers(String(item.billing_expr || '')) : [];
                    const dynamic = dynamicTiers.length > 0;
                    const primaryTier = dynamicTiers[0];
                    const price = (kind: 'input' | 'output' | 'cache' | 'write', dynamicName: string) => dynamic ? dynamicTierPrice(primaryTier.formula, dynamicName, groupRatio) : staticGatewayPrice(item, kind, groupRatio);
                    return <div key={`${String(item.model_name)}-${String(account.keyIndex)}-${group}`} className="gateway-price-row"><strong>{String(item.model_name || '-')}<small>{account.keyHint || ''}</small></strong><span title={item.__groupKnown ? '中转站返回的 Key 分组' : '中转站的只读 API 未返回该 Key 固定分组，列出该模型可用分组价格'}>{group} · {groupRatio}x{item.__groupKnown ? '' : '（可用）'}</span><span>{dynamic ? `动态分档${dynamicTiers.length > 1 ? `（${primaryTier.label}）` : ''}` : Number(item.quota_type) === 1 ? '按次' : '按 Token'}</span><span>{price('input', '输入')}</span><span>{price('output', '输出')}</span><span>{price('cache', '缓存读取')}</span><span>{price('write', '缓存写入')}</span>{dynamic && <small className="gateway-dynamic-formula" title={String(item.billing_expr || '')}>{dynamicTiers.map(tier => `${tier.label}: ${tier.formula}`).join(' | ')}</small>}</div>;
                  })}</div> : <p className="empty-hint compact">中转站暂未返回已启用模型的定价。请先刷新模型列表或检查 Key 权限。</p>}<small className="gateway-fetched-at">说明：中转站公开的 API Key 用量接口未公开 Token 固定分组时，以上会列出该模型的可用分组价格，不会错误按 1x 伪造为实际价格。</small></section>
                  <section className="gateway-logs"><div className="gateway-section-heading"><h4>中转站使用日志</h4><small>只显示当前 API Key 的日志 · {gatewayLogs.length} 条</small></div>{gatewayLogs.length ? <div className="gateway-log-table"><div className="gateway-log-row gateway-log-head"><span>时间</span><span>令牌</span><span>模型</span><span>流</span><span>Tokens</span><span>费用</span><span>耗时</span><span>详情</span></div>{gatewayLogs.map((log, index) => <div key={`${String(log.__keyIndex)}-${String(log.id || index)}-${String(log.created_at || '')}`} className="gateway-log-row"><span>{gatewayLogTime(log) ? new Date(gatewayLogTime(log)).toLocaleString('zh-CN', { hour12: false }) : '-'}</span><span>{String(log.token_name || log.__keyHint || '-')}</span><strong>{String(log.model_name || '-')}</strong><span>{log.is_stream === true ? '流' : '非流'}</span><span>{Number(log.prompt_tokens || 0).toLocaleString()} / {Number(log.completion_tokens || 0).toLocaleString()}</span><span>{gatewayCurrency === 'TOKENS' ? Number(log.quota || 0).toLocaleString() : formatGatewayCurrency(Number(log.quota || 0) / gatewayQuotaPerUnit)}</span><span>{Number(log.use_time || 0).toFixed(1)}s</span><span title={String(log.other || log.content || '')}>{String(log.content || log.group || '-')}</span></div>)}</div> : <p className="empty-hint compact">筛选时间内没有中转站使用日志，或该 Key 未开放日志查询。</p>}</section>
                  <small className="gateway-fetched-at">中转站数据更新于 {new Date(gatewayUsage.fetchedAt).toLocaleString('zh-CN', { hour12: false })}；本机统计仅作为离线回退，不参与上方账单。</small>
                </>}
                <details className="local-usage-details"><summary>本机应用统计（离线回退）</summary><div className="usage-total"><span>{usageDateFilter === 'all' ? '全部时间本机处理 Tokens' : '筛选时间本机处理 Tokens'}</span><strong>{usageView.totalTokens.toLocaleString()}</strong><small>请求 {usageView.requests} 次</small></div><div className="usage-metrics"><div><span>输入</span><b>{usageView.inputTokens.toLocaleString()}</b></div><div><span>输出</span><b>{usageView.outputTokens.toLocaleString()}</b></div><div><span>缓存命中</span><b>{usageView.cachedInputTokens.toLocaleString()}</b></div><div><span>缓存命中率</span><b>{usageView.inputTokens ? `${((usageView.cachedInputTokens / usageView.inputTokens) * 100).toFixed(1)}%` : '--'}</b></div></div><div className="usage-day-list"><h4>按天统计</h4>{usageRows.sort((a, b) => b.date.localeCompare(a.date)).map(day => <div className="usage-day-row" key={day.date}><strong>{day.date}</strong><span>{day.totalTokens.toLocaleString()} tokens</span><span>缓存 {day.cachedInputTokens.toLocaleString()}</span><b>{day.inputTokens ? `${((day.cachedInputTokens / day.inputTokens) * 100).toFixed(1)}%` : '--'}</b></div>)}</div></details>
              </section>}
              {settingsSection === 'usage' && !supportsGatewayUsage(settingsDraft) && <section className="usage-dashboard"><p className="empty-hint">Anthropic 接口或未填写地址时只有本机 Token 统计，没有中转站余额、价格和日志。</p><details className="local-usage-details" open><summary>本机应用统计</summary><div className="usage-total"><span>本机处理 Tokens</span><strong>{usageView.totalTokens.toLocaleString()}</strong><small>请求 {usageView.requests} 次</small></div></details></section>}
              {settingsSection === 'sync' && <>
                <section className="settings-sync-card">
                  <div className="settings-network-header"><div><strong>本地备份包</strong><small>不需要百度网盘或 GitHub 账号，直接写到本机下载目录</small></div><span className="settings-sync-badge">离线</span></div>
                  <div className="settings-sync-actions"><button className="btn-primary" disabled={cloudSyncRunning || isMobileRuntime()} onClick={() => void exportBackupBundle()}>{cloudSyncRunning ? '处理中...' : '导出备份包到本地'}</button><button className="btn-secondary" disabled={cloudSyncRunning || isMobileRuntime()} onClick={() => void loadLocalBackups()}>从本地备份包恢复</button></div>
                  <p className="settings-network-note">备份包格式与云端完全一致，两边可以互相恢复。文件保存在下载目录的“织章导出”文件夹，可自行拷到移动硬盘或其他网盘。恢复会替换本地对应数据并重新载入，建议先导出一份当前备份。</p>
                </section>
                <section className="settings-sync-card">
                  <div className="settings-network-header"><div><strong>百度网盘完整备份与同步</strong><small>备份所有写作资料与本机配置，安装新应用后可直接恢复</small></div><span className="settings-sync-badge">完整快照</span></div>
                  <label className="form-group settings-sync-path"><span>云端备份目录</span><input className="input" value={cloudRemotePath} onChange={event => setCloudRemotePath(event.target.value)} placeholder="Zhizhang/backup" /><small>使用相对路径，不要填写 /apps/bdpan 前缀。</small></label>
                  <div className="settings-sync-actions"><button className="btn-secondary" disabled={cloudSyncRunning} onClick={() => void checkCloudSyncStatus()}>{cloudSyncRunning ? '处理中...' : '检查登录状态'}</button><button className="btn-secondary" disabled={cloudSyncRunning} onClick={() => void beginBaiduLogin()}>登录百度网盘</button><button className="btn-primary" disabled={cloudSyncRunning} onClick={() => void backupToCloud()}>备份到百度网盘</button><button className="btn-secondary" disabled={cloudSyncRunning} onClick={() => void loadCloudBackups()}>选择备份恢复</button></div>
                  {baiduAuthURL && <div className="settings-baidu-auth"><strong>完成授权</strong><small>{isDirectBaiduRuntime() ? '复制以下链接到浏览器完成授权，再粘贴浏览器地址栏中的完整授权结果或 access_token。' : '复制以下链接到浏览器完成授权，再粘贴页面显示的 32 位授权码。'}</small><div className="settings-baidu-url"><input className="input" value={baiduAuthURL} readOnly aria-label="百度网盘授权链接" /><button className="btn-secondary" onClick={() => void copyText(baiduAuthURL)}>复制链接</button></div><div><input className="input" type="password" value={baiduAuthCode} onChange={event => setBaiduAuthCode(event.target.value)} placeholder={isDirectBaiduRuntime() ? '粘贴完整授权结果或 access_token' : '粘贴 32 位授权码'} autoComplete="off" /><button className="btn-primary" disabled={cloudSyncRunning} onClick={() => void confirmBaiduLogin()}>确认登录</button></div></div>}
                  <p className="settings-network-note">备份范围：小说及章节/大纲/记忆/卡片/知识图谱、书籍管理、拆书、扫榜缓存、文风、技能、API 与网络配置、用量统计和禁词。同步只操作应用自己的 /apps/bdpan/ 目录；恢复会替换对应本地数据并重新载入。</p>
                </section>
                <section className="settings-sync-card settings-github-card">
                  <div className="settings-network-header"><div><strong>GitHub 小说备份与恢复</strong><small>一个仓库对应一本小说，AI 会根据真实差异生成提交标题和章节变更说明</small></div><span className="settings-sync-badge github">Git</span></div>
                  <label className="form-group settings-sync-path"><span>本地小说</span><select className="input" value={githubProjectId ?? ''} onChange={event => selectGithubProject(Number(event.target.value))}><option value="">{projects.length ? '选择一本小说' : '本地还没有小说'}</option>{projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}</select></label>
                  <label className="form-group settings-sync-path"><span>GitHub 仓库链接</span><input className="input" value={githubRepositoryUrl} onChange={event => setGithubRepositoryUrl(event.target.value)} placeholder="https://github.com/owner/novel.git" spellCheck={false} /><small>支持 HTTPS 或 SSH；使用本机 Git 登录状态，不在应用中保存 Token。</small></label>
                  <div className="settings-sync-actions"><button className="btn-primary" disabled={cloudSyncRunning || !githubProjectId || isMobileRuntime()} onClick={() => void backupProjectToGithub()}>备份到 GitHub</button><button className="btn-secondary" disabled={cloudSyncRunning || isMobileRuntime()} onClick={() => void restoreProjectFromGithub()}>从 GitHub 恢复</button></div>
                  <p className="settings-network-note">提交正文会列出新增、修改和删除的章节，以及大纲、卡片、记忆、图谱变更数量；不会提交 API Key 和应用账号配置。目标仓库必须为空或已是织章规范仓库，桌面端需安装 Git 并提前完成登录。</p>
                </section>
                {cloudSyncMessage && <p className={`model-list-message settings-sync-message ${/失败|错误|未找到|未登录|拒绝|无效|不是规范/iu.test(cloudSyncMessage) ? 'error' : ''}`}>{cloudSyncMessage}</p>}
              </>}
              {settingsSection === 'tutorial' && <section className="settings-tutorial-card">
                <div className="settings-tutorial-heading"><strong>快速上手</strong><small>全部数据保存在本机，模型调用走你自己配置的接口。</small></div>
                <ol className="settings-tutorial-steps">
                  <li><strong>配置模型</strong><span>在「模型与接口」新增配置，填写接口地址与 API Key，点「拉取模型」后勾选要启用的模型。</span></li>
                  <li><strong>建立作品</strong><span>新建小说，先写作品简介与世界观，再建总纲；总纲是后续所有章纲的依据。</span></li>
                  <li><strong>铺开设定</strong><span>为主角、关键道具和势力建卡片，卡片状态会随章节推进自动更新到知识图谱。</span></li>
                  <li><strong>逐章推进</strong><span>先生成章纲，再由章纲生成正文；保存后确认章节记忆，后续章节才能接上前文。</span></li>
                  <li><strong>校对润色</strong><span>用 AI 检测看分段疑似度，配合去 AI 味技能重写；禁词和人物名标记在编辑器里实时提示。</span></li>
                  <li><strong>留好退路</strong><span>在「备份与同步」导出完整备份，或提交到自己的 GitHub 私有仓库；导出不含 API Key。</span></li>
                </ol>
              </section>}
              <p className="settings-hint">保存后，编辑器中的 AI 智能体会使用模型与网络配置。密钥仅保存到本机。</p>
            </div>
            </div>
            <div className="modal-footer">
              <button className="btn-ghost" onClick={() => setShowSettingsModal(false)}>取消</button>
              <button className="btn-primary" onClick={saveSettings}>保存设置</button>
            </div>
          </div>
        </div>
      )}


      {/* 本地备份包选择 */}
      {showLocalBackupPicker && (
        <div className="modal-overlay" onClick={() => setShowLocalBackupPicker(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="local-backup-title" onClick={event => event.stopPropagation()}>
            <div className="modal-header">
              <div><h3 id="local-backup-title">选择本地备份</h3><small className="cloud-backup-picker-subtitle">{localBackups.directory}</small></div>
              <button className="modal-close" aria-label="关闭" onClick={() => setShowLocalBackupPicker(false)}><Icon name="x" size={16} /></button>
            </div>
            <div className="modal-body history-body">
              {!localBackups.files.length ? <p className="empty-hint">导出目录里还没有 .aswbackup 备份包。先点“导出备份包到本地”生成一份。</p>
                : <>
                  <p className="empty-hint">恢复会覆盖本机对应的小说、书籍、拆书、扇榜、文风、技能、记忆和设置，完成后自动重新载入。</p>
                  {localBackups.files.map(file => <article className="history-entry" key={file.name}>
                    <div><strong>{file.name}</strong><small>{new Date(file.modifiedAt * 1000).toLocaleString('zh-CN', { hour12: false })} · {(file.size / 1_048_576).toFixed(1)} MB</small></div>
                    <button className="btn-primary" disabled={cloudSyncRunning} onClick={() => void restoreFromLocalBundle(file.name)}>恢复这个备份</button>
                  </article>)}
                </>}
            </div>
          </div>
        </div>
      )}

      {showCloudBackupPicker && (
        <div className="modal-overlay cloud-backup-picker-overlay" onClick={() => setShowCloudBackupPicker(false)}>
          <div className="modal cloud-backup-picker" role="dialog" aria-modal="true" aria-labelledby="cloud-backup-picker-title" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div><h3 id="cloud-backup-picker-title">选择云端备份</h3><small className="cloud-backup-picker-subtitle">从百度网盘备份目录中选择一个版本恢复</small></div>
              <button className="modal-close" aria-label="关闭" onClick={() => setShowCloudBackupPicker(false)}><Icon name="x" size={16} /></button>
            </div>
            <div className="modal-body cloud-backup-picker-body">
              <div className="cloud-backup-breadcrumb"><span>百度网盘</span><b>/</b><span>{cloudRemotePath.trim()}</span></div>
              <div className="cloud-backup-toolbar"><strong>完整备份文件</strong><span>{cloudBackupFiles.length} 个项目</span><button type="button" className="link-button" onClick={() => void loadCloudBackups()} disabled={cloudSyncRunning}>刷新列表</button></div>
              <div className="cloud-backup-list" role="radiogroup" aria-label="云端备份文件">
                {cloudBackupFiles.map(file => {
                  const selected = selectedCloudBackup?.path === file.path && selectedCloudBackup?.fsId === file.fsId;
                  const date = file.modifiedAt ? new Date(file.modifiedAt) : null;
                  const dateText = date && !Number.isNaN(date.getTime()) ? date.toLocaleString() : '时间未知';
                  const sizeText = file.size > 0 ? `${(file.size / 1_048_576).toFixed(file.size >= 1_048_576 ? 1 : 2)} MB` : '大小未知';
                  return <label key={`${file.path}-${file.fsId || ''}`} className={`cloud-backup-option${selected ? ' active' : ''}`}>
                    <input type="radio" name="cloud-backup" checked={selected} onChange={() => setSelectedCloudBackup(file)} />
                    <span className="cloud-backup-file-icon" aria-hidden="true">ZZ</span>
                    <span className="cloud-backup-option-main"><strong>{file.name}</strong><small>{file.isBundle ? '完整应用备份' : '备份文件'}</small><em className="cloud-backup-mobile-meta">{dateText} · {sizeText}</em></span>
                    <span className="cloud-backup-option-date">{dateText}</span>
                    <span className="cloud-backup-option-size">{sizeText}</span>
                  </label>;
                })}
              </div>
              <p className="cloud-backup-picker-note">恢复会覆盖本机对应的小说、书籍、拆书、扫榜、文风、技能、记忆和设置。</p>
            </div>
            <div className="modal-footer">
              <span className="cloud-backup-selection-status">{selectedCloudBackup ? `已选择：${selectedCloudBackup.name}` : '请选择一个备份文件'}</span>
              <div className="cloud-backup-picker-actions"><button className="btn-ghost" onClick={() => setShowCloudBackupPicker(false)}>取消</button>
              <button className="btn-primary" disabled={!selectedCloudBackup || cloudSyncRunning} onClick={() => selectedCloudBackup && void restoreFromCloud(selectedCloudBackup)}>恢复所选备份</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {githubRestoreConflict && (
        <div className="modal-overlay" onClick={() => setGithubRestoreConflict(null)}>
          <div className="modal github-restore-modal" role="dialog" aria-modal="true" aria-labelledby="github-restore-title" onClick={event => event.stopPropagation()}>
            <div className="modal-header"><h3 id="github-restore-title">本地已存在这本小说</h3><button className="modal-close" aria-label="关闭" onClick={() => setGithubRestoreConflict(null)}><Icon name="x" size={16} /></button></div>
            <div className="modal-body github-restore-body"><p>GitHub 仓库中的《{githubRestoreConflict.project.title}》与本地《{githubRestoreConflict.localProject.title}》匹配。</p><div><strong>更新本地小说</strong><small>以 GitHub 版本替换本地小说内容，并保留本地小说 ID。</small></div><div><strong>新建一本小说</strong><small>保留当前本地小说，创建一个不绑定原仓库的恢复副本。</small></div></div>
            <div className="modal-footer"><button className="btn-secondary" disabled={cloudSyncRunning} onClick={() => void completeGithubRestore('copy')}>新建一本小说</button><button className="btn-primary" disabled={cloudSyncRunning} onClick={() => void completeGithubRestore('update')}>更新本地小说</button></div>
          </div>
        </div>
      )}

      {showOutlineTypeModal && editingProject && (
        <div className="modal-overlay" onClick={() => setShowOutlineTypeModal(false)}>
          <div className="modal outline-type-modal" role="dialog" aria-modal="true" aria-labelledby="outline-type-title" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h3 id="outline-type-title">新建大纲</h3>
              <button className="modal-close" aria-label="关闭" onClick={() => setShowOutlineTypeModal(false)}><Icon name="x" size={16} /></button>
            </div>
            <div className="modal-body outline-type-options">
              <p>请选择要创建的大纲类型</p>
              {outlineKinds.map(kind => <button key={kind} className="outline-type-option" onClick={() => chooseOutlineType(kind)}><strong>{kind}</strong><span>创建 Markdown 文档</span></button>)}
            </div>
          </div>
        </div>
      )}

      {/* 新建小说模态框 */}
      {showNewProjectModal && (
        <div className="modal-overlay" onClick={() => setShowNewProjectModal(false)}>
          <div className="modal new-project-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{projectFormMode === 'edit' ? '编辑小说' : '新建小说'}</h3>
              <button className="modal-close" aria-label="关闭" onClick={() => setShowNewProjectModal(false)}><Icon name="x" size={16} /></button>
            </div>
            <div className="modal-body create-project-body">
              <aside className="cover-column">
                <div className={`cover-preview ${newProject.cover ? 'has-image' : ''}`}>
                  {newProject.cover ? (
                    <img src={newProject.cover} alt="小说封面预览" />
                  ) : (
                    <>
                      <span className="cover-book-name">{newProject.title || '书本名称'}</span>
                      <span className="cover-decoration">文</span>
                      <small>织章 · ZHIZHANG</small>
                      <PlumBranch size="sm" flip />
                    </>
                  )}
                </div>
                <label className="cover-upload-button">
                  <input type="file" accept="image/png,image/jpeg,image/webp" onChange={handleCoverChange} />
                  选择封面
                </label>
                <p>支持 JPG、PNG、WebP，自动压缩保存</p>
              </aside>

              <div className="create-project-form">
                <div className="create-form-row">
                  <label htmlFor="project-title"><span className="required-mark">*</span>书本名称</label>
                  <div className="project-field-stack">
                    <div className="counted-field">
                      <input
                        id="project-title"
                        type="text"
                        className="input"
                        placeholder="请输入作品名称"
                        maxLength={15}
                        value={newProject.title}
                        onChange={(e) => setNewProject({ ...newProject, title: e.target.value })}
                      />
                      <span>{newProject.title.length}/15</span>
                    </div>
                    <div className="project-ai-actions">
                      <span>AI 参考</span>
                      <select className="select" value={projectGenerationSource} onChange={(event) => setProjectGenerationSource(event.target.value as 'outline' | 'chapters')}>
                        <option value="outline">作品大纲</option>
                        <option value="chapters">前 3 章内容</option>
                      </select>
                      <button className="btn-secondary" type="button" disabled={projectGeneratingField !== null} onClick={() => generateProjectField('title')}>{projectGeneratingField === 'title' ? '生成中...' : 'AI 生成书名'}</button>
                    </div>
                  </div>
                </div>

                <div className="create-form-row">
                  <label>目标读者</label>
                  <div className="channel-switcher" role="radiogroup" aria-label="目标读者">
                    {(['男频', '女频'] as Channel[]).map(channel => (
                      <button
                        key={channel}
                        type="button"
                        role="radio"
                        aria-checked={newProject.channel === channel}
                        className={newProject.channel === channel ? 'active' : ''}
                        onClick={() => handleChannelChange(channel)}
                      >
                        <span className="radio-dot" />{channel}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="create-form-row">
                  <label>作品标签</label>
                  <div className="tag-field-wrap">
                    <button type="button" className="tag-picker-trigger" onClick={openProjectTagPicker}>
                      <span>{newProject.selectedTags.主分类.length ? '修改作品标签' : '请选择作品标签'}</span><span>›</span>
                    </button>
                    <div className="selected-tag-summary">
                      {Object.entries(newProject.selectedTags).flatMap(([tab, tags]) => tags.map(tag => <span key={`${tab}-${tag}`}>{tag}</span>))}
                    </div>
                  </div>
                </div>

                <div className="create-form-row">
                  <label>主角名</label>
                  <div className="protagonist-fields">
                    <div className="counted-field">
                      <input type="text" className="input" placeholder="请输入主角名1" maxLength={5} value={newProject.protagonist1} onChange={(e) => setNewProject({ ...newProject, protagonist1: e.target.value })} />
                      <span>{newProject.protagonist1.length}/5</span>
                    </div>
                    <div className="counted-field">
                      <input type="text" className="input" placeholder="请输入主角名2" maxLength={5} value={newProject.protagonist2} onChange={(e) => setNewProject({ ...newProject, protagonist2: e.target.value })} />
                      <span>{newProject.protagonist2.length}/5</span>
                    </div>
                  </div>
                </div>

                <div className="create-form-row synopsis-row">
                  <label htmlFor="project-synopsis">作品简介</label>
                  <div className="project-field-stack">
                    <div className="counted-field counted-textarea">
                      <textarea id="project-synopsis" className="textarea" placeholder="请输入作品简介" maxLength={500} value={newProject.synopsis} onChange={(e) => setNewProject({ ...newProject, synopsis: e.target.value })} />
                      <span>{newProject.synopsis.length}/500</span>
                    </div>
                    <div className="project-ai-actions synopsis-ai-actions">
                      <small>生成番茄风格的卖点简介，可根据当前选择的参考内容直接回填。</small>
                      <button className="btn-secondary" type="button" disabled={projectGeneratingField !== null} onClick={() => generateProjectField('synopsis')}>{projectGeneratingField === 'synopsis' ? '生成中...' : 'AI 生成作品简介'}</button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setShowNewProjectModal(false)}>
                取消
              </button>
              <button className="btn-primary" onClick={handleCreateProject}>
                {projectFormMode === 'edit' ? '保存修改' : '立即创建'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showTagPicker && (
        <div className="modal-overlay tag-picker-overlay" onClick={() => setShowTagPicker(false)}>
          <div className="modal work-tags-modal" role="dialog" aria-modal="true" aria-labelledby="work-tags-title" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h3 id="work-tags-title">作品标签</h3>
              <button className="modal-close" aria-label="关闭" onClick={() => setShowTagPicker(false)}><Icon name="x" size={16} /></button>
            </div>
            <div className="work-tags-body">
              <nav className="tag-tabs work-tag-tabs">
                {(Object.keys(channelTagCatalog[newProject.channel]) as TagTab[]).map(tab => (
                  <button key={tab} className={activeTagTab === tab ? 'active' : ''} onClick={() => setActiveTagTab(tab)}>
                    {tab === '主分类' && <span className="required-mark">*</span>}{tab}
                    {tagDraft[tab].length > 0 && <span className="tag-tab-count">{tagDraft[tab].length}</span>}
                  </button>
                ))}
              </nav>
              <div className="tag-grid work-tag-grid">
                {channelTagCatalog[newProject.channel][activeTagTab].map(tag => {
                  const selected = tagDraft[activeTagTab].includes(tag.name);
                  return (
                    <button key={tag.name} className={`tag-option ${selected ? 'selected' : ''}`} onClick={() => handleProjectTagToggle(tag.name)}>
                      <span className={`tag-option-icon ${tag.tone}`}>{tag.icon}</span>
                      <span className="tag-option-copy"><strong>{tag.name}</strong>{tag.description && <small>{tag.description}</small>}</span>
                      <span className="tag-check">{selected ? <Icon name="check" size={14} /> : null}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="work-tags-footer">
              <p>主分类必选且只能选一个，主题、角色、情节最多可选两个</p>
              <div><button className="btn-ghost" onClick={() => setShowTagPicker(false)}>取消</button><button className="btn-primary" onClick={confirmProjectTags}>确认</button></div>
            </div>
          </div>
        </div>
      )}

      {chapterPendingDeletion && (
        <div className="modal-overlay" onClick={() => setChapterPendingDeletion(null)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="delete-chapter-title" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h3 id="delete-chapter-title">删除章节</h3>
              <button className="modal-close" aria-label="关闭" onClick={() => setChapterPendingDeletion(null)}><Icon name="x" size={16} /></button>
            </div>
            <div className="modal-body">
              <p>确定删除《{chapterPendingDeletion.title}》吗？当前 {chapterPendingDeletion.wordCount.toLocaleString()} 字。</p>
              <p className="delete-warning">正文会进回收站，可以恢复；本章节记忆和图谱关系会清理，恢复后需重新生成；绑定的章纲保留但解除关联。</p>
            </div>
            <div className="modal-footer">
              <button className="btn-ghost" onClick={() => setChapterPendingDeletion(null)}>取消</button>
              <button className="btn-danger" onClick={() => void handleDeleteChapter()}>确认删除</button>
            </div>
          </div>
        </div>
      )}

      {projectPendingDeletion && (
        <div className="modal-overlay" onClick={() => setProjectPendingDeletion(null)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="delete-project-title" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h3 id="delete-project-title">删除小说</h3>
              <button className="modal-close" aria-label="关闭" onClick={() => setProjectPendingDeletion(null)}><Icon name="x" size={16} /></button>
            </div>
            <div className="modal-body">
              <p>确定删除《{projectPendingDeletion.title}》吗？</p>
              <p className="delete-warning">小说中的章节、大纲和本地保存内容都会被移除，此操作不可撤销。建议先在“设置 - 备份与同步”导出一份本地备份包。</p>
            </div>
            <div className="modal-footer">
              <button className="btn-ghost" onClick={() => setProjectPendingDeletion(null)}>取消</button>
              <button className="btn-danger" onClick={handleDeleteProject}>确认删除</button>
            </div>
          </div>
        </div>
      )}

      {/* 导出小说：全书或当前章，TXT / Markdown */}
      {showExportModal && editingProject && (
        <div className="modal-overlay" onClick={() => setShowExportModal(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="export-title" onClick={event => event.stopPropagation()}>
            <div className="modal-header">
              <h3 id="export-title">导出小说</h3>
              <button className="modal-close" aria-label="关闭" onClick={() => setShowExportModal(false)}><Icon name="x" size={16} /></button>
            </div>
            <div className="modal-body export-body">
              <div className="export-option-row" role="radiogroup" aria-label="导出范围">
                <button className={exportScope === 'book' ? 'active' : ''} onClick={() => setExportScope('book')}><strong>全书</strong><small>{editingProject.chapters.length} 章 · {editingProject.wordCount.toLocaleString()} 字</small></button>
                <button className={exportScope === 'chapter' ? 'active' : ''} disabled={!activeChapter} onClick={() => setExportScope('chapter')}><strong>当前章</strong><small>{activeChapter ? `${activeChapter.title} · ${activeChapter.wordCount.toLocaleString()} 字` : '未选中章节'}</small></button>
              </div>
              <div className="export-option-row" role="radiogroup" aria-label="导出格式">
                <button className={exportOptions.format === 'txt' ? 'active' : ''} onClick={() => setExportOptions({ ...exportOptions, format: 'txt' })}><strong>TXT</strong><small>纯文本，可直接往网文网站粘贴</small></button>
                <button className={exportOptions.format === 'md' ? 'active' : ''} onClick={() => setExportOptions({ ...exportOptions, format: 'md' })}><strong>Markdown</strong><small>带标题层级，适合归档与版本管理</small></button>
              </div>
              {exportScope === 'book' && <div className="export-check-row">
                <label><input type="checkbox" checked={exportOptions.includeOutlines} onChange={event => setExportOptions({ ...exportOptions, includeOutlines: event.target.checked })} /> 附上大纲与世界观设定（{editingProject.outlines.length} 篇）</label>
                <label><input type="checkbox" checked={exportOptions.includeCards} onChange={event => setExportOptions({ ...exportOptions, includeCards: event.target.checked })} /> 附上设定卡片（{editingProject.cards.length} 张）</label>
              </div>}
              <small className="settings-network-note">文件写入系统下载目录的“织章导出”文件夹，完成后自动在文件管理器中选中。</small>
            </div>
            <div className="modal-footer">
              <button className="btn-ghost" onClick={() => setShowExportModal(false)}>取消</button>
              <button className="btn-primary" disabled={exportRunning} onClick={() => void exportCurrentTarget()}>{exportRunning ? '导出中...' : '开始导出'}</button>
            </div>
          </div>
        </div>
      )}

      {/* 章节历史版本：AI 覆写、全书替换前的正文快照 */}
      {showChapterHistory && activeChapter && (
        <div className="modal-overlay" onClick={() => setShowChapterHistory(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="history-title" onClick={event => event.stopPropagation()}>
            <div className="modal-header">
              <h3 id="history-title">历史版本·{activeChapter.title}</h3>
              <button className="modal-close" aria-label="关闭" onClick={() => setShowChapterHistory(false)}><Icon name="x" size={16} /></button>
            </div>
            <div className="modal-body history-body">
              {!activeChapter.snapshots?.length ? <p className="empty-hint">本章还没有历史版本。AI 润色、去 AI 味、续写、Agent 修订和全书替换覆盖正文前，都会自动存一条。</p> : <>
                <p className="empty-hint">每章最多保留 {chapterSnapshotLimit} 条，最新在前。回滚时当前正文会存为新快照，所以回滚可以再回滚。</p>
                {activeChapter.snapshots.map(snapshot => <article className="history-entry" key={snapshot.savedAt}>
                  <div><strong>{snapshot.reason}</strong><small>{new Date(snapshot.savedAt).toLocaleString('zh-CN', { hour12: false })} · {snapshot.wordCount.toLocaleString()} 字</small></div>
                  <pre>{snapshot.content.slice(0, 400)}{snapshot.content.length > 400 ? '…' : ''}</pre>
                  <button className="btn-secondary" onClick={() => void rollbackChapterSnapshot(snapshot.savedAt)}>恢复这个版本</button>
                </article>)}
              </>}
            </div>
          </div>
        </div>
      )}

      {/* 章节回收站 */}
      {showRecycleBin && editingProject && (
        <div className="modal-overlay" onClick={() => setShowRecycleBin(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="recycle-title" onClick={event => event.stopPropagation()}>
            <div className="modal-header">
              <h3 id="recycle-title">章节回收站</h3>
              <button className="modal-close" aria-label="关闭" onClick={() => setShowRecycleBin(false)}><Icon name="x" size={16} /></button>
            </div>
            <div className="modal-body history-body">
              {!editingProject.deletedChapters?.length ? <p className="empty-hint">回收站是空的。</p> : <>
                <p className="empty-hint">最多保留最近删除的 20 章。恢复后章节记忆、图谱关系需要重新生成。</p>
                {editingProject.deletedChapters.map(entry => <article className="history-entry" key={entry.chapter.id}>
                  <div><strong>{entry.chapter.title}</strong><small>删除于 {new Date(entry.deletedAt).toLocaleString('zh-CN', { hour12: false })} · {entry.chapter.wordCount.toLocaleString()} 字</small></div>
                  <pre>{entry.chapter.content.slice(0, 300) || '（空章节）'}{entry.chapter.content.length > 300 ? '…' : ''}</pre>
                  <div className="history-entry-actions">
                    <button className="btn-primary" onClick={() => void restoreChapterFromBin(entry.chapter.id)}>恢复</button>
                    <button className="link-button danger-link" onClick={() => void purgeChapterFromBin(entry.chapter.id)}>彻底删除</button>
                  </div>
                </article>)}
              </>}
            </div>
          </div>
        </div>
      )}

      {/* 写作统计：作者视角的日更数据，不是 token 账单 */}
      {showWritingStats && editingProject && (
        <div className="modal-overlay" onClick={() => setShowWritingStats(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="stats-title" onClick={event => event.stopPropagation()}>
            <div className="modal-header">
              <h3 id="stats-title">写作统计</h3>
              <button className="modal-close" aria-label="关闭" onClick={() => setShowWritingStats(false)}><Icon name="x" size={16} /></button>
            </div>
            <div className="modal-body stats-body">
              <div className="stats-cards">
                <div><span>今日码字</span><strong>{(editingProject.dailyWords?.[todayKey()] || 0).toLocaleString()}</strong></div>
                <div><span>连续更新</span><strong>{writingStreak(editingProject.dailyWords)} 天</strong></div>
                <div><span>全书字数</span><strong>{editingProject.wordCount.toLocaleString()}</strong></div>
                <div><span>平均每章</span><strong>{editingProject.chapters.length ? Math.round(editingProject.wordCount / editingProject.chapters.length).toLocaleString() : 0}</strong></div>
              </div>
              <h4>最近 14 天</h4>
              {(() => {
                const days = Array.from({ length: 14 }, (_, offset) => ({ key: dayKeyOffset(13 - offset), words: editingProject.dailyWords?.[dayKeyOffset(13 - offset)] || 0 }));
                const peak = Math.max(1, ...days.map(day => day.words));
                return <div className="stats-chart">{days.map(day => <div key={day.key} title={`${day.key}：${day.words.toLocaleString()} 字`}>
                  <i style={{ height: `${Math.round((day.words / peak) * 100)}%` }} />
                  <small>{day.key.slice(5)}</small>
                </div>)}</div>;
              })()}
              <small className="settings-network-note">日更只累加正增量，删改不从当日成绩里扣除。统计从本版本开始记录，旧章节不回溯。</small>
            </div>
          </div>
        </div>
      )}

      {/* 快捷键说明 */}
      {showShortcuts && (
        <div className="modal-overlay" onClick={() => setShowShortcuts(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title" onClick={event => event.stopPropagation()}>
            <div className="modal-header">
              <h3 id="shortcuts-title">快捷键</h3>
              <button className="modal-close" aria-label="关闭" onClick={() => setShowShortcuts(false)}><Icon name="x" size={16} /></button>
            </div>
            <div className="modal-body shortcut-body">
              {[
                ['Ctrl / ⌘ S', '保存当前章节'],
                ['Ctrl / ⌘ F', '本章搜索；在全书检索页再按切回'],
                ['Ctrl / ⌘ E', '导出小说'],
                ['Ctrl / ⌘ H', '当前章历史版本'],
                ['Ctrl / ⌘ J', '写作统计'],
                ['Ctrl / ⌘ P', '阅读模式'],
                ['Ctrl / ⌘ /', '打开或关闭本面板'],
                ['Alt ↑ / ↓', '切到上一章 / 下一章'],
                ['Ctrl / ⌘ Enter', '在项目 Agent 输入框发送'],
                ['Esc', '退出阅读模式'],
              ].map(([keys, description]) => <div className="shortcut-row" key={keys}><kbd>{keys}</kbd><span>{description}</span></div>)}
            </div>
          </div>
        </div>
      )}

      {/* 阅读模式：只读通读，排版与正文外观设置一致 */}
      {readingMode && activeChapter && (
        <div className="reading-overlay" role="dialog" aria-modal="true" aria-label={`阅读 ${activeChapter.title}`}>
          <header>
            <div><strong>{activeChapter.title}</strong><small>{activeChapter.wordCount.toLocaleString()} 字</small></div>
            <button className="editor-tool-button" onClick={() => setReadingMode(false)}>退出阅读（Esc）</button>
          </header>
          <article ref={readingArticleRef}>{activeChapter.content.split(/\n+/u).filter(Boolean).map((paragraph, index) => <p key={`${index}-${paragraph.slice(0, 12)}`}>{paragraph}</p>)}</article>
        </div>
      )}

    </div>
  );
}

export default App;
