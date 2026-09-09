import { z } from "zod";

// 拆章切点的纯函数：运行时、移动端和前端落地共用同一份分段与切点规则，否则同一个 breakAfter 会切在不同地方
export { allocateChapterParts, chapterCharacterCount, maxChapterParts, minChapterPartCharacters, partsFromBreaks, planBalancedBreaks, planChapterBreaks, splitParagraphs } from "./chapter-split.js";

/**
 * 模型类 RPC 的共享参数形状
 * 这是全仓库唯一一份模型参数定义：字段名、类型和 TS 类型都从这里派生
 */
export const modelParamsSchema = z.object({
  // 每个配置只有一个 Key：多 Key 轮换曾让重试悄悄换到无权限的 Key，报成 403
  apiKey: z.string().optional(),
  baseURL: z.string().optional(),
  model: z.string().optional(),
  apiMode: z.enum(["openai", "anthropic", "responses"]).optional(),
  reasoningMode: z.string().optional(),
  contextWindow: z.coerce.number().positive().optional(),
  proxyEnabled: z.boolean().optional(),
  proxyURL: z.string().optional(),
  proxyBypassLocal: z.boolean().optional(),
});

export type ModelRequestParams = z.infer<typeof modelParamsSchema> & Record<string, unknown>;

/** 携带模型配置的方法；参数在 registry 处按 modelParamsSchema 校验 */
const modelParamMethods = [
  "gateway.usage", "settings.diagnose", "models.list", "models.test", "project.generate",
  "skill.write", "github.commit.describe", "memory.write", "ranking.analyze", "book.dismantle", "book.style.distill",
  "book.rewrite", "book.adapt", "text.transform", "project.agent.chat", "card.write",
  "outline.write", "chapter.write",
] as const;

/**
 * 不含共享参数形状的方法
 * 这些方法的参数各不相同且体量很大（整本小说、章节列表），由各自 handler 校验必需字段，
 * 协议层只负责方法白名单，不做无意义的空对象校验
 */
const rawParamMethods = [
  "usage.summary", "book.search", "book.search.all", "book.sources.list",
  "ranking.categories", "ranking.fetch", "book.chapter.download", "book.download",
] as const;

export type ModelRpcMethod = typeof modelParamMethods[number];
export type AgentRpcMethod = ModelRpcMethod | typeof rawParamMethods[number];

const modelMethodSet: ReadonlySet<string> = new Set(modelParamMethods);
const methodSet: ReadonlySet<string> = new Set<string>([...modelParamMethods, ...rawParamMethods]);

export const agentRpcMethods: readonly AgentRpcMethod[] = Object.freeze([...modelParamMethods, ...rawParamMethods]);
export const isAgentRpcMethod = (value: string): value is AgentRpcMethod => methodSet.has(value);
export const isModelRpcMethod = (value: string): value is ModelRpcMethod => modelMethodSet.has(value);

const optionalId = z.preprocess(
  value => value === 0 || value === '0' || value === '' || value === null ? undefined : value,
  z.coerce.number().int().positive().optional(),
);
// 章节修订和删除必须指向一个已存在的章节，不能像新增那样留空
const requiredId = z.coerce.number().int().positive();
const cardTypes = ['角色卡', '物品卡', '地点卡', '势力卡', '金手指卡'] as const;
const outlineKinds = ['总纲', '章纲', '世界观与作品设定'] as const;
const memoryKinds = ['章节快照', '人物状态', '角色认知', '伏笔追踪', '时间线', '设定事实', '冲突'] as const;
const graphNodeTypes = ['chapter', 'card', 'outline', 'entity'] as const;
// 整章文本改写的三种口径，直接对应 text.transform 的同名模式；批量润色和批量去 AI 味都走这一条
const chapterReviseModes = ['revise', 'polish', 'de-ai'] as const;
// 补标题的范围：只补占位标题，还是连作者起过名的也一起重拟
const chapterRetitleScopes = ['missing', 'all'] as const;

export const projectUpdateSchema = z.object({
  type: z.literal('project.update'), summary: z.string().min(1).max(200),
  patch: z.object({
    title: z.string().min(1).max(120).optional(), synopsis: z.string().max(6000).optional(),
    genre: z.string().max(60).optional(), subgenre: z.string().max(60).optional(),
    protagonist1: z.string().max(80).optional(), protagonist2: z.string().max(80).optional(),
    status: z.enum(['writing', 'completed']).optional(),
    authorPreferences: z.array(z.string().min(1).max(300)).max(20).optional(),
  }).strict(),
});
export const outlineUpsertSchema = z.object({ type: z.literal('outline.upsert'), summary: z.string().min(1).max(200), targetId: optionalId, kind: z.enum(outlineKinds), title: z.string().min(1).max(160), content: z.string().min(1).max(60_000), chapterId: optionalId });
export const cardUpsertSchema = z.object({ type: z.literal('card.upsert'), summary: z.string().min(1).max(200), targetId: optionalId, cardType: z.enum(cardTypes), title: z.string().min(1).max(120), content: z.string().min(1).max(40_000), currentState: z.string().max(6000).optional() });
export const memoryDocumentUpsertSchema = z.object({ type: z.literal('memory.document.upsert'), summary: z.string().min(1).max(200), kind: z.enum(memoryKinds), title: z.string().min(1).max(120), content: z.string().min(1).max(60_000) });
export const graphNodeUpsertSchema = z.object({ type: z.literal('graph.node.upsert'), summary: z.string().min(1).max(200), targetId: z.string().min(1).max(160), label: z.string().min(1).max(120), nodeType: z.enum(graphNodeTypes), category: z.string().max(80).optional(), content: z.string().max(30_000).optional(), nodeStatus: z.string().max(1000).optional() });
export const graphEdgeUpsertSchema = z.object({ type: z.literal('graph.edge.upsert'), summary: z.string().min(1).max(200), targetId: z.string().min(1).max(240), source: z.string().min(1).max(160), target: z.string().min(1).max(160), label: z.string().min(1).max(80), weight: z.number().min(0.1).max(1).optional() });
export const outlineWriteSchema = z.object({ type: z.literal('outline.write'), summary: z.string().min(1).max(200), targetId: optionalId, kind: z.enum(outlineKinds), title: z.string().min(1).max(160), instruction: z.string().min(1).max(4000) });
export const cardWriteSchema = z.object({ type: z.literal('card.write'), summary: z.string().min(1).max(200), targetId: optionalId, cardType: z.enum(cardTypes), title: z.string().min(1).max(120), instruction: z.string().min(1).max(4000) });
export const chapterDraftNextSchema = z.object({ type: z.literal('chapter.draft_next'), summary: z.string().min(1).max(200), title: z.string().min(1).max(160).optional(), instruction: z.string().min(1).max(6000), outlineId: optionalId });
export const chapterCreateSchema = z.object({ type: z.literal('chapter.create'), summary: z.string().min(1).max(200), title: z.string().min(1).max(160), content: z.string().min(1).max(120_000), chapterPlan: z.string().max(30_000).optional(), chapterSummary: z.string().max(3000).optional() });
// 修订意图：只描述要改成什么样，正文交给文本智能体产出，落地为 chapter.update
// mode 决定交给 text.transform 的哪种口径：revise 可改情节、polish 只改文字、de-ai 拆机械感
export const chapterReviseSchema = z.object({ type: z.literal('chapter.revise'), summary: z.string().min(1).max(200), targetId: requiredId, instruction: z.string().min(1).max(6000), mode: z.enum(chapterReviseModes).default('revise') });
// 批量补标题的意图：targetIds 为空表示按 scope 自己挑章节，落地为一条 chapter.titles
// renumber 为 true 时章号按各章在目录里的当前位置重编，格式沿用前文章节；模型只负责名字，章号一律由应用生成
export const chapterRetitleSchema = z.object({ type: z.literal('chapter.retitle'), summary: z.string().min(1).max(200), targetIds: z.array(requiredId).max(400).default([]), scope: z.enum(chapterRetitleScopes).default('missing'), renumber: z.boolean().default(false), instruction: z.string().max(2000).optional() });
/**
 * 批量标题落地：一条变更带多章标题，不按章拆成几百条提案
 * stripHeading 表示这一章的标题原本写在正文开头（旧版本遗留），应用时要把那行从正文里移走
 */
export const chapterTitlesSchema = z.object({
  type: z.literal('chapter.titles'), summary: z.string().min(1).max(200),
  titles: z.array(z.object({ targetId: requiredId, title: z.string().min(1).max(160), stripHeading: z.boolean().optional() })).min(1).max(400),
});
// 拆章意图：只说要把哪几章拆到多少字（或拆成几段），切点由应用按段落算，正文不经过模型，落地为一条 chapter.parts
// targetParts 是作者直接给的整批总段数（“两章拆成 6 章”）；给了就按字数比例分到各章，不再拿 targetWords 反推
export const chapterSplitSchema = z.object({ type: z.literal('chapter.split'), summary: z.string().min(1).max(200), targetIds: z.array(requiredId).min(1).max(40), targetWords: z.coerce.number().int().min(600).max(20_000).default(2400), targetParts: z.coerce.number().int().min(2).max(240).optional(), instruction: z.string().max(2000).optional() });
/**
 * 拆章落地：只带切点和新标题，不带正文
 * 正文两边都有，回传几万字只会撑爆变更归档；应用按 breakAfter 里的段落序号就地切开。
 * paragraphCount 是规划时的段落数，落地前对不上就说明正文已被改过，这一章跳过。
 */
export const chapterPartsSchema = z.object({
  type: z.literal('chapter.parts'),
  summary: z.string().min(1).max(200),
  splits: z.array(z.object({
    targetId: requiredId,
    paragraphCount: z.coerce.number().int().min(2),
    breakAfter: z.array(z.coerce.number().int().min(1)).min(1).max(20),
    titles: z.array(z.string().min(1).max(160)).min(2).max(21),
  })).min(1).max(40),
});

export const chapterUpdateSchema = z.object({ type: z.literal('chapter.update'), summary: z.string().min(1).max(200), targetId: requiredId, title: z.string().min(1).max(160).optional(), content: z.string().min(1).max(120_000) });
// 删除不需要模型产出，规划和落地用同一个形状；title 只用于确认时显示
export const chapterDeleteSchema = z.object({ type: z.literal('chapter.delete'), summary: z.string().min(1).max(200), targetId: requiredId, title: z.string().max(160).optional() });

export const ProjectAgentChangeSchema = z.discriminatedUnion('type', [projectUpdateSchema, outlineUpsertSchema, cardUpsertSchema, memoryDocumentUpsertSchema, graphNodeUpsertSchema, graphEdgeUpsertSchema, chapterCreateSchema, chapterUpdateSchema, chapterTitlesSchema, chapterPartsSchema, chapterDeleteSchema]);
export const ProjectAgentPlannerChangeSchema = z.discriminatedUnion('type', [projectUpdateSchema, outlineWriteSchema, cardWriteSchema, memoryDocumentUpsertSchema, graphNodeUpsertSchema, graphEdgeUpsertSchema, chapterDraftNextSchema, chapterReviseSchema, chapterRetitleSchema, chapterSplitSchema, chapterDeleteSchema]);
export const ProjectAgentPlanSchema = z.object({ message: z.string().min(1).max(5000), changes: z.array(ProjectAgentPlannerChangeSchema).max(16).default([]) });

export type ProjectAgentChange = z.infer<typeof ProjectAgentChangeSchema>;
export type ProjectAgentChapterRequest = z.infer<typeof chapterDraftNextSchema>;
export type ProjectAgentChapterReviseRequest = z.infer<typeof chapterReviseSchema>;
export type ProjectAgentChapterRetitleRequest = z.infer<typeof chapterRetitleSchema>;
export type ProjectAgentChapterSplitRequest = z.infer<typeof chapterSplitSchema>;
export type ProjectAgentOutlineRequest = z.infer<typeof outlineWriteSchema>;
export type ProjectAgentCardRequest = z.infer<typeof cardWriteSchema>;
export type ProjectAgentChapterCreate = z.infer<typeof chapterCreateSchema>;
export type ProjectAgentChapterUpdate = z.infer<typeof chapterUpdateSchema>;
export type ProjectAgentChapterTitles = z.infer<typeof chapterTitlesSchema>;
export type ProjectAgentChapterParts = z.infer<typeof chapterPartsSchema>;
export type ProjectAgentOutlineUpsert = z.infer<typeof outlineUpsertSchema>;
export type ProjectAgentCardUpsert = z.infer<typeof cardUpsertSchema>;

export interface RuntimeUsageSummary {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  requests: number;
  startedAt: string;
}

export interface AgentProgressEvent {
  runId?: string;
  type?: "progress" | "context" | "chunk" | "complete" | "error";
  data?: {
    step?: string;
    progress?: number;
    text?: string;
    message?: string;
    error?: string;
    context?: {
      action: string;
      source?: string;
      status?: "searching" | "selected" | "pruned" | "loaded" | "cached";
      bytes?: number;
      items?: number;
    };
  };
}

export interface AgentRpcCall {
  method: AgentRpcMethod;
  params: Record<string, unknown>;
}

export interface RpcRequest extends AgentRpcCall {
  id: string | number;
}

export interface RpcError {
  code: number;
  message: string;
}

export interface RpcResponse<Result = unknown> {
  id: string | number;
  result?: Result;
  error?: RpcError;
}

// 只投影协议字段做边界校验，避免 Zod 为完整小说、章节和知识图谱 payload 创建深副本；
// 投影字段直接来自 modelParamsSchema，新增字段不会漏校验
const modelParamKeys = Object.keys(modelParamsSchema.shape) as Array<keyof typeof modelParamsSchema.shape>;

export const parseAgentRpcParams = (method: AgentRpcMethod, value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("RPC params 必须是对象");
  const source = value as Record<string, unknown>;
  if (!isModelRpcMethod(method)) return source;
  const projection: Record<string, unknown> = {};
  for (const key of modelParamKeys) {
    if (source[key] !== undefined) projection[key] = source[key];
  }
  // 合并回校验后的值，让 contextWindow 之类的 coerce 结果真正生效
  return { ...source, ...modelParamsSchema.parse(projection) };
};
