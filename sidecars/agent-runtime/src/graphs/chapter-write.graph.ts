import { StateGraph, Annotation } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";
import { StoryStore } from "../storage/story-store.js";
import { ModelApiClient, type ApiUsage, type ApiWireMode, type ChatMessage } from "../models/model-api.js";
import type { StreamEmitter } from "../streaming/stream-handler.js";
import { StreamAccumulator } from "../streaming/stream-handler.js";
import { byteLength, compactText, formatContextReport, masterOutlineBytes, tailText, type ContextReport } from "../context/context-optimizer.js";
// 标题拆分与补全是纯文本处理，批量补标题也要用同一套判定，统一放在 application 层
import { applyDraftChapterTitle, cleanChapterTitleName, splitChapterTitleHeading } from "../application/chapter-titles.js";

export interface SkillDefinition {
  name: string;
  displayName?: string;
  category?: string;
  description?: string;
  tags?: string[];
  content: string;
}

type UsageTotals = NonNullable<ContextReport["upstreamUsage"]>;
const addUsage = (left: UsageTotals | undefined, right: ApiUsage | undefined): UsageTotals => ({
  inputTokens: (left?.inputTokens || 0) + (right?.inputTokens || 0),
  outputTokens: (left?.outputTokens || 0) + (right?.outputTokens || 0),
  totalTokens: (left?.totalTokens || 0) + (right?.totalTokens || 0),
  cachedInputTokens: (left?.cachedInputTokens || 0) + (right?.cachedInputTokens || 0),
  cacheWriteTokens: (left?.cacheWriteTokens || 0) + (right?.cacheWriteTokens || 0),
  reasoningTokens: (left?.reasoningTokens || 0) + (right?.reasoningTokens || 0),
  requests: (left?.requests || 0) + (right ? 1 : 0),
});

const intentLabels: Record<string, string> = {
  setup: "项目设定与大纲",
  write: "章节创作与续写",
  review: "一致性审查与修改",
  polish: "文字润色与去模板化",
  import: "作品导入与结构化",
  analyze: "拆书分析与市场判断",
  tool: "写作辅助工具",
  creator: "技能设计",
};

// Keep these prompts byte-for-byte stable. Compatible providers can reuse this
// prefix on successive chapter runs instead of reprocessing the common rules.
const chapterAgentSystemPrompt = `你是专业长篇网络小说创作 Agent。只根据作者提供的作品资料工作，不编造与资料冲突的设定。

写作原则：
1. 服从章节任务、细纲、人物状态、时间线和已确认设定，资料冲突时以“已确认记忆”和作者任务为准。
2. 用具体动作、感官、对话和因果推进剧情；避免复述资料、解释写作过程、机械总结或套话。
3. 保持人物称谓、视角、时序、物品归属与关系一致；不把未知信息写成角色已知事实。
4. 正文使用自然的中文网文叙事，段落有节奏，结尾停在可继续发展的行动、发现或风险上。
5. 严格执行最后一条消息指定的阶段任务与输出格式，不输出隐藏思考。`;

const chapterWriterTaskPrompt = `你正在执行“章节正文”阶段。返回严格 JSON 对象，不要代码围栏或额外说明：{"content":"章节正文 Markdown","title":"本章标题","summary":"200 字以内章节摘要"}。content 只能是小说正文本身，绝不能是计划确认、写作思路、意向声明或对任务的回应。
title 是这一章的名字，必须填：4 到 14 个汉字，只概括本章真正发生的事，不带“第几章”前缀，不带书名号、引号、句号和省略号；章号由应用自己编，你不用数。
标题只放在 title 字段里，不要在 content 开头再写一遍 # 标题行。`;


/** JSON 传输信封绝不能成为展示给作者的章节正文。 */
function unwrapChapterDraft(value: unknown, depth = 0): string {
  if (typeof value !== "string") return "";
  const text = value.trim().replace(/^```(?:json|markdown|text)?\s*/iu, "").replace(/\s*```$/u, "").trim();
  if (depth >= 4 || !text.startsWith("{")) return stripPreambleAffirmation(value.trim());
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const nested = typeof parsed.draftContent === "string" ? parsed.draftContent : typeof parsed.content === "string" ? parsed.content : "";
    return nested ? unwrapChapterDraft(nested, depth + 1) : stripPreambleAffirmation(value.trim());
  } catch {
    return stripPreambleAffirmation(value.trim());
  }
}

/** 模型偶尔把“我会严格沿着计划写”这类确认语当正文返回；开头不是叙述就是承诺，整段丢掉只保留真正文 */
function stripPreambleAffirmation(text: string): string {
  const trimmed = text.trim();
  const match = /^(?:我会|我将|我计划|接下来会|本文将|这一章将|本章将|将严格)[^\n。！？]{0,80}[。！？]\s*/u.exec(trimmed);
  if (!match) return trimmed;
  const rest = trimmed.slice(match[0].length);
  // 只丢开头一句承诺语，后面必须还有真正文；全句都是承诺说明整段都是任务回应，直接报错让作者重试
  return rest.trim() ? rest.trim() : "";
}

function chapterSummaryFromEnvelope(value: unknown, depth = 0): string {
  if (typeof value !== "string" || depth >= 4) return "";
  try {
    const parsed = JSON.parse(value.trim().replace(/^```(?:json|markdown|text)?\s*/iu, "").replace(/\s*```$/u, "")) as Record<string, unknown>;
    if (typeof parsed.summary === "string") return parsed.summary.trim();
    const nested = typeof parsed.draftContent === "string" ? parsed.draftContent : typeof parsed.content === "string" ? parsed.content : "";
    return nested ? chapterSummaryFromEnvelope(nested, depth + 1) : "";
  } catch {
    return "";
  }
}

/**
 * 信封里的章节标题
 * 标题现在是信封的一等字段：模型不再把它写在正文开头，就不能只指望从正文里剥 # 标题行。
 * chapterTitle 缺失时新建的章节只能停在“第 N 章”占位，作者看到的就是“只写了正文、没写标题”。
 */
function chapterTitleFromEnvelope(value: unknown, depth = 0): string {
  if (typeof value !== "string" || depth >= 4) return "";
  try {
    const parsed = JSON.parse(value.trim().replace(/^```(?:json|markdown|text)?\s*/iu, "").replace(/\s*```$/u, "")) as Record<string, unknown>;
    for (const key of ["title", "chapterTitle", "chapter_title", "标题", "章节标题"]) {
      const found = parsed[key];
      // 只取一行：模型偶尔把标题写成“第 12 章 夜访\n（本章完）”这种多行文本
      if (typeof found === "string" && found.trim()) return cleanChapterTitleName(found);
    }
    const nested = typeof parsed.draftContent === "string" ? parsed.draftContent : typeof parsed.content === "string" ? parsed.content : "";
    return nested ? chapterTitleFromEnvelope(nested, depth + 1) : "";
  } catch {
    return "";
  }
}

const chapterReviewSystemPrompt = `你是长篇小说一致性编辑。审查时只依据给出的约束、故事账本与章节正文，不做文风重写，也不虚构问题。

重点检查两件事。一是一致性：人物状态、已知信息、时间线、实体关系、物品归属和剧情因果。二是推进：本章相对故事账本里的前文是否推进了新的事件或节点，有没有把账本里已发生的事件重新写了一遍。
返回严格 JSON 对象，不要代码围栏或解释：{"consistent":true,"issues":["明确矛盾"],"suggestions":["可执行修订建议"],"advances":true,"progress":"一句话说明本章把故事推进到了哪里","repeatedEvents":["与前文重复的事件"]}。没有明确问题时 issues、suggestions 和 repeatedEvents 返回空数组。`;

const chapterPlanSystemPrompt = `你是长篇网络小说主编。先为下一章制作一份短小、可执行的写作计划，不写正文，不输出隐藏思考。
只依据给定资料。先对照总纲与故事账本判断本章处在全书哪一段、必须把主线推进到哪个节点，再承接上一章结尾；承接只是开头几段的衔接，不是本章的全部内容。返回严格 JSON 对象：{"plan":"人类可读的 Markdown 计划","handoff":"下一章交接"}。plan 字段必须直接是普通 Markdown 文字，绝不能在 plan 字段中再次嵌套 JSON、JSON 字符串、代码围栏或字段对象。
计划必须包含：本章推进的节点（相对总纲与前文，本章新增的推进是什么）、承接锚点（人物位置、情绪、未解决事件、道具/线索、时间线、伏笔、章末钩子）、人物目标与动机、核心事件链、冲突升级、四段节奏（开场/发展/转折/收束）、本章新增信息、伏笔推进或回收（必须写明本章推进或回收哪条已有伏笔；若账本里没有未回收伏笔，就写明本章新埋的那条）、结尾钩子、下一章交接。
时间与地点位移：必须先写出本书目前处在总纲的哪一卷、哪一阶段，以及本章要推进到的下一个节点；再写明本章相对上一章的时间与地点关系（紧接、数小时后、数天后或换地点）。只要上一章的事件还没有结束，本章就得在开头几段内把它收束掉，再用过渡把它推进到下一个节点；不允许整章都停在同一地点、同一件事的交涉里。
硬性禁止：故事账本里"已发生事件"不得作为本章主事件再写一遍；上一章已经完成的行动、发现、对峙、交易不得重新发生；本章核心事件必须是前文没有出现过的新推进。未知项标为待确认，不能凭空补设定。`;

const planFieldLabels: Record<string, string> = {
  progress: "本章推进", advance: "本章推进", milestone: "本章推进", node: "本章推进",
  opening: "开篇承接", openingAnchor: "开篇承接", handoff: "下一章交接", continuity: "承接锚点", continuityAnchor: "承接锚点",
  story: "这章的故事", plot: "核心事件链", events: "核心事件链", characters: "这章的人物", characterGoals: "人物目标与动机",
  conflict: "冲突升级", pacing: "节奏安排", rhythm: "节奏安排", newInformation: "本章新增信息", foreshadowing: "伏笔推进",
  ending: "章末钩子", hook: "章末钩子", style: "写法与禁区",
};

function cleanPlanText(value: string): string {
  return value.trim().replace(/^```(?:json|markdown|text)?\s*/iu, "").replace(/\s*```$/u, "").trim();
}

function formatPlanValue(value: unknown): string {
  if (typeof value === "string") return cleanPlanText(value);
  if (Array.isArray(value)) return value.map(formatPlanValue).filter(Boolean).join("；");
  if (value && typeof value === "object") return Object.entries(value as Record<string, unknown>)
    .map(([key, entry]) => `${planFieldLabels[key] || key}：${formatPlanValue(entry)}`)
    .filter(entry => !entry.endsWith("：")).join("\n");
  return value === undefined || value === null ? "" : String(value);
}

function planObjectToMarkdown(value: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || entry === null || key === "plan" || key === "content") continue;
    const label = planFieldLabels[key] || key.replace(/([a-z])([A-Z])/gu, "$1 $2");
    if (typeof entry === "string") {
      const text = cleanPlanText(entry);
      if (text) lines.push(`## ${label}\n${text}`);
      continue;
    }
    if (Array.isArray(entry)) {
      const items = entry.map(item => typeof item === "string" ? item.trim() : formatPlanValue(item)).filter(Boolean);
      if (items.length) lines.push(`## ${label}\n${items.map(item => `- ${item}`).join("\n")}`);
      continue;
    }
    const text = formatPlanValue(entry);
    if (text) lines.push(`## ${label}\n${text}`);
  }
  return lines.join("\n\n");
}

/** Providers sometimes encode the plan object twice despite JSON mode. Never expose that envelope to the author. */
export function normalizeChapterPlan(value: unknown): string {
  if (typeof value === "string") {
    const text = cleanPlanText(value);
    if (!text) return "";
    try { return normalizeChapterPlan(JSON.parse(text) as unknown); }
    catch { return text; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const object = value as Record<string, unknown>;
  if (object.plan !== undefined) {
    const plan = normalizeChapterPlan(object.plan);
    const handoff = normalizeChapterPlan(object.handoff);
    return [plan, handoff && !plan.includes(handoff) ? `## 下一章交接\n${handoff}` : ""].filter(Boolean).join("\n\n");
  }
  if (object.content !== undefined && Object.keys(object).length === 1) return normalizeChapterPlan(object.content);
  return planObjectToMarkdown(object);
}

function buildPrewriteCheck(state: ChapterStateType): { blockers: string[]; warnings: string[]; summary: string } {
  const blockers: string[] = [];
  const warnings: string[] = [];
  // 没有章纲时不再硬报阻断：有总纲与故事账本时仍能按方向推进，只是精度下降；两者都没有才是真阻断
  if (!state.outline?.trim()) {
    if (state.masterOutline?.trim() || state.storyLedger?.trim()) warnings.push("本章没有章纲，只能依据总纲、故事账本和上一章推进，建议先生成本章章纲");
    else blockers.push("缺少当前章纲或可执行大纲");
  }
  if (!state.instruction.trim()) blockers.push("缺少本章创作指令");
  if (/(待定|待补|todo|\{.+?\}|\[待.+?\])/iu.test(`${state.outline || ""}\n${state.instruction}`)) warnings.push("章纲或指令含待补占位信息，正文将标记为待确认而不自行补设定");
  if (!state.previousChapters?.length) warnings.push("没有上一章正文，无法执行跨章承接检查");
  if (!state.knowledgeGraph?.trim()) warnings.push("知识图谱为空，本章只依据章纲、卡片与记忆校验设定");
  return { blockers, warnings, summary: blockers.length ? `写前检查发现 ${blockers.length} 项阻断` : `写前检查通过${warnings.length ? `，${warnings.length} 项提醒` : ""}` };
}

/** A deterministic, stable prefix lets compatible upstreams reuse prompt cache. */
function stableProjectPacket(state: ChapterStateType): string {
  return [
    state.worldSetting ? `## 世界观与作品设定（作者确认的只读固定规则；只可引用，不得自动改写或推断变化）\n${state.worldSetting}` : "",
    state.writingStyle ? `## 绑定文风（作品固定约束）\n名称：${state.writingStyle.name}\n${state.writingStyle.content}` : "",
  ].filter(Boolean).join("\n\n");
}

/** 总纲与故事账本：全书级的推进依据，计划、正文、审查三个阶段都要看到同一份 */
function storyDirectionPacket(state: ChapterStateType): string {
  return [
    state.masterOutline ? `## 总纲（含结构骨架、推进路线、当前节点与“接下来必须推进”的节点；本章必须沿它推进一个新节点，再后面的节点不得提前兑现）\n${compactText(state.masterOutline, masterOutlineBytes)}` : "",
    state.storyLedger ? `## 故事账本（前文已发生事件与未回收伏笔；已发生的事不得再写一遍）\n${compactText(state.storyLedger, 2400)}` : "",
  ].filter(Boolean).join("\n\n");
}

function splitSessionContext(value?: string): { summary: string; recent: string } {
  const context = compactText(value || "", 2200);
  if (!context) return { summary: "", recent: "" };
  const marker = "## 最近会话轮次";
  const index = context.indexOf(marker);
  if (index < 0) return { summary: context, recent: "" };
  return { summary: context.slice(0, index).trim(), recent: context.slice(index).trim() };
}

export function selectSkillsByIntent(instruction: string, catalog: SkillDefinition[]): { intent: string; skills: SkillDefinition[] } {
  const query = instruction.toLowerCase();
  const scored = catalog.map(skill => {
    const terms = [skill.name, skill.displayName || "", skill.category || "", skill.description || "", ...(skill.tags || [])]
      .join(" ").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    let score = terms.reduce((total, term) => total + (term.length > 1 && query.includes(term) ? 2 : 0), 0);
    const categoryTerms: Record<string, string[]> = {
      setup: ["大纲", "设定", "世界观", "人物卡", "角色"],
      write: ["写", "续", "章节", "正文", "日更", "开书"],
      review: ["审查", "检查", "一致性", "逻辑", "矛盾"],
      polish: ["润色", "改写", "去ai", "自然", "文风"],
      import: ["导入", "解析", "已有小说"],
      analyze: ["分析", "拆书", "扫榜", "趋势", "题材"],
      tool: ["封面", "浏览器", "榜单"],
      creator: ["技能", "skill"],
    };
    score += (categoryTerms[skill.category || ""] || []).reduce((total, term) => total + (query.includes(term) ? 3 : 0), 0);
    return { skill, score };
  }).sort((left, right) => right.score - left.score);
  const selected = scored.filter(item => item.score > 0).slice(0, 3).map(item => item.skill);
  const fallback = catalog.find(skill => skill.name === "story-long-write") || catalog.find(skill => skill.category === "write");
  const skills = selected.length ? selected : (fallback ? [fallback] : []);
  const category = skills[0]?.category || "write";
  return { intent: intentLabels[category] || "章节创作与续写", skills };
}

export const ChapterState = Annotation.Root({
  projectId: Annotation<string>,
  chapterId: Annotation<string>,
  instruction: Annotation<string>,
  worldSetting: Annotation<string | undefined>,
  writingStyle: Annotation<{ name: string; content: string } | undefined>,
  /** 总纲骨架与当前相关段落，见 compactMasterOutline */
  masterOutline: Annotation<string | undefined>,
  /** 前文已发生事件与未回收伏笔，见 buildStoryLedger */
  storyLedger: Annotation<string | undefined>,
  /** 项目设置的单章目标字数，缺省 3000 */
  targetWords: Annotation<number | undefined>,
  outline: Annotation<string | undefined>,
  previousChapters: Annotation<Array<{ id?: string | number; title: string; content: string; ending?: string }> | undefined>,
  knowledgeGraph: Annotation<string | undefined>,
  cards: Annotation<Array<{ type?: string; title: string; content: string }> | undefined>,
  skillCatalog: Annotation<SkillDefinition[]>({ reducer: (_prev, next) => next, default: () => [] }),
  preferredSkillNames: Annotation<string[]>({ reducer: (_prev, next) => next, default: () => [] }),
  selectedSkills: Annotation<string[]>({ reducer: (_prev, next) => next, default: () => [] }),
  recognizedIntent: Annotation<string | undefined>,
  retrievedContext: Annotation<string[]>({
    reducer: (prev, next) => next,
    default: () => [],
  }),
  continuityContext: Annotation<string | undefined>,
  prewriteCheck: Annotation<{ blockers: string[]; warnings: string[]; summary: string } | undefined>,
  chapterPlan: Annotation<string | undefined>,
  draftContent: Annotation<string | undefined>,
  /** 模型写在正文开头的章节标题：从正文剥出来后交给桌面端填进标题栏 */
  chapterTitle: Annotation<string | undefined>,
  summary: Annotation<string | undefined>,
  contextReport: Annotation<ContextReport | undefined>,
  sessionContext: Annotation<string | undefined>,
  authorPreferences: Annotation<string[]>({ reducer: (_prev, next) => next, default: () => [] }),
  upstreamUsage: Annotation<UsageTotals | undefined>({ reducer: (_prev, next) => next, default: () => undefined }),
  reviewResult: Annotation<{
    consistent: boolean;
    issues: string[];
    suggestions: string[];
    /** 本章相对前文是否有新推进；false 就是又把上一章写了一遍 */
    advances?: boolean;
    progress?: string;
    repeatedEvents?: string[];
  } | undefined>,
  errors: Annotation<string[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),
  messages: Annotation<BaseMessage[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),
});

export type ChapterStateType = typeof ChapterState.State;

interface ChapterGraphConfig {
  store: StoryStore;
  apiKey: string;
  baseURL?: string;
  model?: string;
  apiMode?: ApiWireMode | "responses";
  reasoningMode?: string;
  contextWindowKTokens?: number;
  proxyEnabled?: boolean;
  proxyURL?: string;
  proxyBypassLocal?: boolean;
  skillCatalog?: SkillDefinition[];
  streamEmitter?: StreamEmitter;
}

/**
 * 正文的输出预算
 * 客户端默认 4000 是按“几百字回复”定的；一章 3000 字光正文就接近这个数，
 * 加上 JSON 信封、标题摘要和推理模型的思考量，写到一半就被截断（finish_reason=length），整章白跑
 */
export function chapterDraftMaxTokens(targetWords: number, contextWindowKTokens?: number): number {
  const wanted = Math.round(targetWords * 1.6) + 1500;
  const contextTokens = Math.floor(Number(contextWindowKTokens || 0) * 1024);
  // 输出最多占窗口六成，剩下的留给输入；窗口未知时按 32K 估
  const cap = Math.floor((contextTokens || 32 * 1024) * 0.6);
  return Math.max(2000, Math.min(wanted, cap));
}

/**
 * 正文阶段的提示词组装
 * 首稿和“审查判定没推进、重写一遍”必须看到同一份资料，两处各写一份迟早会漂移
 */
function chapterDraftPrompts(state: ChapterStateType, contextWindowKTokens?: number, repair?: { repeatedEvents: string[]; progress?: string }): {
  messages: ChatMessage[];
  dynamicPacket: string;
  draftInputBytes: number;
  maxTokens: number;
} {
  const contextSection = state.retrievedContext.length > 0
    ? `\n## 相关背景\n${state.retrievedContext.join("\n\n")}\n`
    : "";
  const outlineSection = state.outline ? `\n## 章节细纲\n${state.outline}\n` : "";
  const graphSection = state.knowledgeGraph
    ? `\n## 知识图谱约束\n${state.knowledgeGraph}\n保持实体名称、类型和关系与图谱一致；新增关系需在正文中有依据。\n`
    : "";
  const cardsSection = state.cards?.length
    ? `\n## 本章知识卡片\n${state.cards.map(card => `### ${card.type || "知识卡"}：${card.title}\n${card.content}`).join("\n\n")}\n`
    : "";
  const skillsSection = state.selectedSkills.length
    ? `\n## 意图识别\n${state.recognizedIntent || "章节创作与续写"}\n\n## 自动选用技能\n${state.skillCatalog.filter(skill => state.selectedSkills.includes(skill.name)).slice(0, 3).map(skill => `### ${skill.displayName || skill.name}\n${compactText(skill.content, skill.name === "chapter-continuity" ? 1800 : 700)}`).join("\n\n")}\n`
    : "";
  const continuitySection = state.continuityContext
    ? `\n## 章节承接（只用于本章开头一到三段，不是本章内容）\n${state.continuityContext}\n`
    : "";
  const planSection = state.chapterPlan ? `\n## 下一章计划（必须执行）\n${state.chapterPlan}\n` : "";
  const directionSection = storyDirectionPacket(state);
  // Keep project facts first and byte-stable; only the dynamic turn changes after it.
  const stablePacket = stableProjectPacket(state);
  const session = splitSessionContext(state.sessionContext);
  // Skill routing is the first dynamic section so the model sees the task
  // method before chapter-specific material; stable canon remains above it.
  // 总纲与故事账本紧跟技能之后：模型要先知道全书写到哪、下一步该推到哪里，再看本章细纲和上一章结尾
  const mutableProjectContext = [skillsSection, directionSection ? `\n${directionSection}\n` : "", outlineSection, cardsSection, graphSection].filter(Boolean).join("");
  const dynamicPacket = [mutableProjectContext, continuitySection, planSection, contextSection].filter(Boolean).join("");
  const hasPreviousChapter = Boolean(state.previousChapters?.some(chapter => chapter?.content?.trim()));
  const continuityInstruction = hasPreviousChapter
    ? "开头用一到三段承接上一章最后的动作、位置和情绪，承接之后就离开那个场景：本章主体必须发生在新的时间或地点，或把上一章留下的事件在本章内彻底收束；不要把上一章最后一段的动作、对峙或对话再详细描写一遍"
    : "这是第一章，没有上一章正文；先依据世界观、章纲和作者指令建立场景、人物与初始冲突";
  // 字数读项目设置，写死两三千字会让作者设的目标形同虚设
  const targetWords = state.targetWords && state.targetWords > 0 ? Math.round(state.targetWords) : 3000;
  const repairInstruction = repair
    ? `\n\n## 本次是重写（首版被判定为没有推进主线）\n首版重复或停留的地方：${repair.repeatedEvents.join("；") || "与上一章高度重复"}${repair.progress ? `；首版只推进到：${repair.progress}` : ""}\n重写时必须先收束上一章留下的事件，再把时间或地点推进到“接下来必须推进”的节点；上一章最后一段的动作不得再作为本章主体。`
    : "";
  const taskPrompt = `${chapterWriterTaskPrompt}\n\n## 本章任务\n${state.instruction}\n\n请严格按照“下一章计划”创作约 ${targetWords} 字正文（不少于 ${Math.round(targetWords * 0.8)} 字，不超过 ${Math.round(targetWords * 1.2)} 字）：${continuityInstruction}；本章主体必须是计划里的新推进，不能连续多章停在同一地点、同一件事里，故事账本中已发生的事件不得再写一遍；不要复述计划或解释过程；content 直接从正文第一句开始，不要以“我会”“我将”“接下来会”等承诺性语句开头。${repairInstruction}`;
  return {
    messages: [
      { role: "system", content: chapterAgentSystemPrompt },
      { role: "user", content: `## 稳定作品资料\n${stablePacket || "（暂无稳定资料）"}` },
      ...(session.summary ? [{ role: "user" as const, content: session.summary }] : []),
      { role: "user", content: `## 本章动态资料\n${dynamicPacket || "（暂无动态资料）"}` },
      ...(session.recent ? [{ role: "user" as const, content: session.recent }] : []),
      { role: "user", content: taskPrompt },
    ],
    dynamicPacket,
    draftInputBytes: byteLength(chapterAgentSystemPrompt) + byteLength(stablePacket) + byteLength(dynamicPacket) + byteLength(taskPrompt),
    maxTokens: chapterDraftMaxTokens(targetWords, contextWindowKTokens),
  };
}

export function createChapterGraph(config: ChapterGraphConfig) {
  const store = config.store;
  const client = new ModelApiClient({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    defaultModel: config.model,
    apiMode: config.apiMode,
    reasoningMode: config.reasoningMode,
    contextWindowKTokens: config.contextWindowKTokens,
    proxyEnabled: config.proxyEnabled,
    proxyURL: config.proxyURL,
    proxyBypassLocal: config.proxyBypassLocal,
  });
  const emitter = config.streamEmitter;

  const graph = new StateGraph(ChapterState)
    .addNode("prewrite", async (state: ChapterStateType) => {
      const prewriteCheck = buildPrewriteCheck(state);
      emitter?.progress("starting", 5, prewriteCheck.summary);
      return { prewriteCheck };
    })
    .addNode("intent", async (state: ChapterStateType) => {
      const selection = selectSkillsByIntent(state.instruction, state.skillCatalog);
      const isWriting = selection.skills.some(skill => skill.category === "write") || /章节|正文|续写|创作|写作/u.test(state.instruction);
      const mandatoryNames = isWriting
        ? ["chapter-continuity", "next-chapter-plan"]
        : [];
      const mandatory = mandatoryNames.map(name => state.skillCatalog.find(skill => skill.name === name)).filter((skill): skill is SkillDefinition => Boolean(skill));
      const preferred = state.preferredSkillNames.map(name => state.skillCatalog.find(skill => skill.name === name)).filter((skill): skill is SkillDefinition => Boolean(skill));
      const selectedSkills = [...mandatory, ...preferred, ...selection.skills].filter((skill, index, list) => list.findIndex(item => item.name === skill.name) === index).slice(0, 6);
      const preferenceMessage = preferred.length ? `；手动优先：${preferred.map(skill => skill.name).join("、")}` : "";
      emitter?.progress("intent", 8, `工具 SkillRouter：识别意图“${selection.intent}”；已选技能：${selectedSkills.map(skill => skill.displayName || skill.name).join("、") || "默认写作规则"}${preferenceMessage}`);
      emitter?.context("intent", "自动匹配写作技能", { source: "SkillRouter", status: "selected", items: selectedSkills.length });
      return {
        recognizedIntent: selection.intent,
        selectedSkills: selectedSkills.map(skill => skill.name),
      };
    })
    .addNode("retrieve", async (state: ChapterStateType) => {
      emitter?.progress("retrieve", 10, "正在检索相关记忆...");
      emitter?.context("retrieve", "检索章节记忆、人物状态和时间线", { source: "StoryStore.searchHybrid", status: "searching" });

      // 首章没有可检索的历史章节或结构化记忆时，直接跳过数据库检索。
      // 这样不会把“空记忆”误显示成持续检索，也避免空 FTS/向量请求阻塞正文生成。
      const hasPreviousChapter = Boolean(state.previousChapters?.some(chapter => chapter?.content?.trim()));
      const hasStoredMemory = store.listConfirmed(state.projectId, 1).length > 0;
      if (!hasPreviousChapter && !hasStoredMemory) {
        emitter?.progress("retrieve", 25, "首章暂无历史记忆，已跳过检索");
        emitter?.context("retrieve", "首章无历史记忆，使用世界观、章纲和作者指令", { source: "StoryStore.searchHybrid", status: "selected", items: 0 });
        return { retrievedContext: [], contextReport: state.contextReport ? { ...state.contextReport, retrievedBytes: 0 } : undefined };
      }
      
      // 从指令和细纲中提取关键词
      const query = [state.instruction, state.outline].filter(Boolean).join(" ");
      
      // 使用混合检索：FTS5 + 向量语义（如果已启用）
      let results;
      let retrievalSource = "StoryStore.searchHybrid";
      try {
        results = await store.searchHybrid(state.projectId, query, 5);
      } catch {
        // 如果向量检索未启用，降级到 FTS5
        retrievalSource = "StoryStore.searchExact";
        results = store.searchExact(state.projectId, query, 5).map(r => ({
          ...r,
          similarity: 0.5,
        }));
      }

      // Structured memories are durable story constraints. Keep a small, high-priority
      // pack even when a new instruction has little lexical overlap with old chapters.
      const priorityTypes = new Set(["character_state", "foreshadowing", "timeline", "canon_fact"]);
      const priority = store.listConfirmed(state.projectId, 32)
        .filter(item => priorityTypes.has(item.type))
        .slice(0, 4)
        .map(item => ({ ...item, similarity: 1 }));
      const seen = new Set<string>();
      // 上一章正文已经由承接节点给出了真正的章尾；再把整段正文检索回来只会把模型按在上一章的场景里
      const previousTitles = new Set((state.previousChapters || []).map(chapter => chapter?.title).filter(Boolean));
      results = [...priority, ...results].filter(item => {
        if (previousTitles.has(item.title)) return false;
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      }).slice(0, 7);
      
      let remaining = 4600;
      const context = results.flatMap(r => {
        if (remaining < 180) return [];
        const heading = `[${r.type} · ${compactText(r.title, 120)}]`;
        const content = compactText(r.content, Math.max(150, Math.min(760, remaining - byteLength(heading) - 8)));
        const item = `${heading}\n${content}`;
        remaining -= byteLength(item) + 2;
        return content ? [item] : [];
      });
      const retrievedBytes = byteLength(context.join("\n\n"));
      const contextReport = state.contextReport ? { ...state.contextReport, retrievedBytes } : undefined;
      
      emitter?.progress("retrieve", 25, `工具 StoryStore.searchHybrid：找到 ${context.length} 条相关记忆${contextReport ? `；${formatContextReport(contextReport)}` : ""}`);
      emitter?.context("retrieve", `记忆检索完成：${context.length} 条`, { source: retrievalSource, status: "loaded", bytes: retrievedBytes, items: context.length });
      return { retrievedContext: context, contextReport };
    })
    .addNode("continuity", async (state: ChapterStateType) => {
      const previous = state.previousChapters?.[state.previousChapters.length - 1];
      if (!previous?.content?.trim()) {
        emitter?.progress("retrieve", 29, "没有上一章正文，按当前章节开篇创作");
        emitter?.context("retrieve", "未找到上一章正文，跳过承接资料", { source: "上一章正文", status: "selected", items: 0 });
        return { continuityContext: "（没有上一章正文；本章负责建立新的场景、人物位置和冲突。）" };
      }
      const relatedMemory = state.retrievedContext.find(item => item.includes(previous.title));
      // 承接锚点只能用真正的章尾；prepareChapterInput 已截好 ending，直接调图时退回从原文截尾
      const tail = previous.ending || tailText(previous.content, 2600);
      const continuityContext = `上一章：${previous.title}\n（以下只是承接锚点，只用于本章开头一到三段，不是本章的内容）\n上一章结尾（最高优先级）：\n${tail}${relatedMemory ? `\n\n上一章结构记忆：\n${compactText(relatedMemory, 900)}` : ""}\n\n承接清单：开头先确认人物位置和情绪，处理未完成事件与章末钩子；场景或时间跳跃必须给出因果过渡。承接只负责开头几段的衔接，上一章已经完成的事不得重演：承接之后必须离开上一章的场景，把本章主体放到新的时间或地点，或把上一章留下的事件在本章内收束。`;
      emitter?.progress("retrieve", 29, `已锁定${previous.title}结尾，生成阶段将优先承接`);
      emitter?.context("retrieve", "锁定上一章结尾作为承接锚点", { source: previous.title, status: "selected", bytes: byteLength(tail), items: 1 });
      return { continuityContext };
    })
    .addNode("plan", async (state: ChapterStateType) => {
      emitter?.progress("plan", 30, "工具 ChapterPlanner：正在根据承接清单制作下一章计划");
      emitter?.context("plan", "装载本章章纲与承接清单", { source: "ChapterPlanner", status: "loaded", bytes: byteLength(state.outline || "") });
      const skillSection = state.skillCatalog
        .filter(skill => state.selectedSkills.includes(skill.name))
        .slice(0, 6)
        .map(skill => `### ${skill.displayName || skill.name}\n${compactText(skill.content, 420)}`)
        .join("\n\n");
      const stablePacket = stableProjectPacket(state);
      const session = splitSessionContext(state.sessionContext);
      const direction = storyDirectionPacket(state);
      const planPrompt = [
        direction,
        state.outline ? "## 章节细纲\n" + compactText(state.outline, 1800) : "",
        state.continuityContext ? "## 上一章承接（最高优先级）\n" + compactText(state.continuityContext, 3200) : "",
        state.retrievedContext.length ? "## 结构化记忆\n" + compactText(state.retrievedContext.join("\n\n"), 2600) : "",
        state.knowledgeGraph ? "## 相关知识图谱\n" + compactText(state.knowledgeGraph, 1800) : "",
        skillSection ? "## 执行技能\n" + skillSection : "",
        state.prewriteCheck?.warnings.length ? `## 写前提醒\n${state.prewriteCheck.warnings.map(item => `- ${item}`).join("\n")}` : "",
      ].filter(Boolean).join("\n\n");
      const planInstruction = `${chapterPlanSystemPrompt}\n\n## 本章任务\n${state.instruction}\n\n请输出一份 600 字以内的五段写作任务书，计划是正文生成的硬约束。格式固定为：1. 本章推进（写出本书当前处在总纲的哪一卷/哪一阶段、本章推进到哪个新节点、本章相对上一章的时间与地点位移，以及不得重复的前文）；2. 开篇承接（只占开头一到三段，写清怎么收束上一章留下的事件）；3. 这章的故事与人物；4. 怎么写更顺（节奏、文风、禁区）；5. 收在哪里（章末钩子）。`;
      const fallbackPlan = "1. 本章推进：先收束上一章留下的事件，再对照总纲写出前文没有发生过的新事件，并给出本章相对上一章的时间与地点位移。\n2. 开篇承接：用一到三段确认上一章人物位置与情绪，随后离开那个场景。\n3. 这章的故事与人物：推进当前目标并制造有效阻力，每人按动机行动。\n4. 怎么写更顺：用动作、因果和对话推进，避免解释。\n5. 收在哪里：以有因果依据的未解行动或风险收尾。";
      let response: Awaited<ReturnType<ModelApiClient["chat"]>>;
      try {
        response = await client.chat([
          { role: "system", content: chapterAgentSystemPrompt },
          { role: "user", content: `## 稳定作品资料\n${stablePacket || "（暂无稳定资料）"}` },
          ...(session.summary ? [{ role: "user" as const, content: session.summary }] : []),
          { role: "user", content: planPrompt },
          ...(session.recent ? [{ role: "user" as const, content: session.recent }] : []),
          { role: "user", content: planInstruction },
        ], { response_format: { type: "json_object" }, temperature: 0.25, max_tokens: 3000, retryAttempts: 2 });
      } catch (error) {
        // 计划只是正文的脚手架：推理模型把输出上限吃光、JSON 被截断时，改用默认计划继续写，不让整章白跑；
        // 原因写进进度条，作者能看见这一章是按默认计划推进的
        const message = error instanceof Error ? error.message : String(error);
        emitter?.progress("plan", 42, `计划阶段失败，改用默认计划继续：${message}`);
        return { chapterPlan: fallbackPlan, errors: [`计划阶段失败：${message}`] };
      }
      let chapterPlan = "";
      try {
        const result = JSON.parse(response.content) as Record<string, unknown>;
        chapterPlan = normalizeChapterPlan(result);
      } catch {
        chapterPlan = normalizeChapterPlan(response.content);
      }
      if (!chapterPlan) chapterPlan = fallbackPlan;
      emitter?.progress("plan", 42, `模型规划完成（${chapterPlan.length.toLocaleString()} 字）；已交给正文节点执行`);
      return { chapterPlan, upstreamUsage: addUsage(state.upstreamUsage, response.usage) };
    })
    .addNode("draft", async (state: ChapterStateType) => {
      emitter?.progress("draft", 44, "工具 ContextAssembler：正在组织章节计划、设定、记忆和技能提示");
      const prompts = chapterDraftPrompts(state, config.contextWindowKTokens);
      emitter?.context("draft", "组装稳定设定与动态上下文", { source: "ContextAssembler", status: "loaded", bytes: byteLength(prompts.dynamicPacket), items: state.selectedSkills.length + (state.cards?.length || 0) });
      const contextReport = state.contextReport ? { ...state.contextReport, draftInputBytes: prompts.draftInputBytes } : undefined;
      if (contextReport?.cache === "hit") emitter?.context("draft", "命中本地资料指纹缓存", { source: "持久化上下文缓存", status: "cached", bytes: prompts.draftInputBytes });
      if (contextReport?.prunedBytes) emitter?.context("draft", "按上下文预算裁剪低相关资料", { source: "ContextOptimizer", status: "pruned", bytes: contextReport.prunedBytes });

      // 流式生成文本
      emitter?.progress("draft", 38, "已提交模型请求，正在生成正文");
      const response = await client.chatStream(prompts.messages, { response_format: { type: "json_object" }, max_tokens: prompts.maxTokens }, chunk => emitter?.chunk(chunk));
      emitter?.progress("draft", 70, "章节生成完成");

      // 标题行在产出时就从正文里拆走，避免模型补的 # 章节标题混进正文；承诺语由 unwrapChapterDraft 内部处理
      const draft = splitChapterTitleHeading(unwrapChapterDraft(response.content));
      // 标题两条路都要接：信封的 title 字段优先，模型仍把标题写在正文开头时用剥下来的那行兵底
      const envelopeTitle = chapterTitleFromEnvelope(response.content);
      return {
        draftContent: draft.content,
        chapterTitle: envelopeTitle || draft.title,
        summary: chapterSummaryFromEnvelope(response.content),
        contextReport,
        upstreamUsage: addUsage(state.upstreamUsage, response.usage),
      };
    })
    .addNode("review", async (state: ChapterStateType) => {
      emitter?.progress("review", 75, "工具 ConsistencyChecker：正在审查人物、设定、时间线和因果...");
      
      if (!state.draftContent) {
        return {
          reviewResult: {
            consistent: false,
            issues: ["没有生成章节内容"],
            suggestions: [],
          },
        };
      }

      // 构建审查 prompt
      const contextSection = state.retrievedContext.length > 0
        ? `\n## 已知背景信息\n${state.retrievedContext.join("\n\n")}\n`
        : "";
      const cardsSection = state.cards?.length
        ? `\n## 本章引用卡片状态\n${state.cards.map(card => `${card.title}：${compactText(card.content, 260)}`).join("\n")}`
        : "";
      const graphSection = state.knowledgeGraph
        ? `\n## 知识图谱约束\n${state.knowledgeGraph}\n`
        : "";
      // 审查也要看到账本：没有前文事件清单，"是否重复上一章"就只能靠猜
      const ledgerSection = state.storyLedger
        ? `\n## 故事账本（前文已发生事件；用于判断本章是否推进、是否重复）\n${compactText(state.storyLedger, 2400)}\n`
        : "";

      const reviewConstraints = `${cardsSection}${graphSection}${ledgerSection}${contextSection}`;
      const reviewDraft = compactText(state.draftContent, 10000);
      const reviewPrompt = `## 约束摘要\n${reviewConstraints || "（暂无额外约束）"}\n\n## 待审查章节\n${reviewDraft}`;
      const stablePacket = stableProjectPacket(state);
      const session = splitSessionContext(state.sessionContext);
      const reviewInstruction = chapterReviewSystemPrompt;
      const previousReport = state.contextReport;
      const reviewInputBytes = byteLength(chapterAgentSystemPrompt) + byteLength(stablePacket) + byteLength(session.summary) + byteLength(reviewPrompt) + byteLength(session.recent) + byteLength(reviewInstruction);
      const contextReport = previousReport ? {
        ...previousReport,
        reviewInputBytes,
      } : undefined;

      let response: Awaited<ReturnType<ModelApiClient["chat"]>>;
      try {
        response = await client.chat([
          { role: "system", content: chapterAgentSystemPrompt },
          { role: "user", content: `## 稳定作品资料\n${stablePacket || "（暂无稳定资料）"}` },
          ...(session.summary ? [{ role: "user" as const, content: session.summary }] : []),
          { role: "user", content: reviewPrompt },
          ...(session.recent ? [{ role: "user" as const, content: session.recent }] : []),
          { role: "user", content: reviewInstruction },
        ], { response_format: { type: "json_object" }, max_tokens: 2000 });
      } catch (error) {
        // 审查失败不能拖垮已经写好的整章正文：如实标注审查未完成，正文照常交给作者
        const message = error instanceof Error ? error.message : String(error);
        emitter?.progress("review", 95, `审查未完成：${message}`);
        return {
          reviewResult: { consistent: true, issues: [], suggestions: [`审查未完成：${message}`], advances: true, progress: "", repeatedEvents: [] },
          contextReport,
          errors: [`审查阶段失败：${message}`],
        };
      }

      emitter?.progress("review", 95, "审查完成");

      try {
        const result = JSON.parse(response.content);
        return {
          reviewResult: {
            consistent: result.consistent ?? true,
            issues: result.issues || [],
            suggestions: result.suggestions || [],
            advances: typeof result.advances === "boolean" ? result.advances : true,
            progress: typeof result.progress === "string" ? result.progress.trim() : "",
            repeatedEvents: Array.isArray(result.repeatedEvents) ? result.repeatedEvents.filter((item: unknown): item is string => typeof item === "string" && item.trim().length > 0) : [],
          },
          contextReport,
          upstreamUsage: addUsage(state.upstreamUsage, response.usage),
        };
      } catch {
        return {
          reviewResult: {
            consistent: true,
            issues: [],
            suggestions: ["无法解析审查结果"],
            advances: true,
            progress: "",
            repeatedEvents: [],
          },
          contextReport,
          upstreamUsage: addUsage(state.upstreamUsage, response.usage),
        };
      }
    })
    // 审查说“没推进”时就重写一遍：只把“不得重复”写进提示词是没约束力的，模型照样接着上一章写
    // 只重写一次就不再审，避免既烧 token 又陷入反复改的循环
    .addNode("repair", async (state: ChapterStateType) => {
      const review = state.reviewResult;
      if (!review) return {};
      emitter?.progress("draft", 80, "审查判定本章重复前文、没有推进主线，正在按下一个节点重写一次");
      emitter?.context("draft", "首版被判定为没推进，按总纲下一节点重写", { source: "ConsistencyChecker", status: "selected", items: review.repeatedEvents?.length || 0 });
      const prompts = chapterDraftPrompts(state, config.contextWindowKTokens, { repeatedEvents: review.repeatedEvents || [], progress: review.progress });
      try {
        const response = await client.chatStream(prompts.messages, { response_format: { type: "json_object" }, max_tokens: prompts.maxTokens }, chunk => emitter?.chunk(chunk));
        const draft = splitChapterTitleHeading(unwrapChapterDraft(response.content));
        return {
          // 重写没产出正文时保留首版：宁可让作者看到报告里的“没有推进”，也不能把整章弄丢
          draftContent: draft.content || state.draftContent,
          chapterTitle: chapterTitleFromEnvelope(response.content) || draft.title || state.chapterTitle,
          summary: chapterSummaryFromEnvelope(response.content) || state.summary,
          reviewResult: { ...review, advances: true, repeatedEvents: [], suggestions: [...review.suggestions, "本章首版未推进主线，已自动按下一节点重写一次"] },
          upstreamUsage: addUsage(state.upstreamUsage, response.usage),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emitter?.progress("review", 96, `重写失败，保留首版正文：${message}`);
        return { errors: [`重写阶段失败：${message}`] };
      }
    })
    .addEdge("__start__", "prewrite")
    .addEdge("prewrite", "intent")
    .addEdge("intent", "retrieve")
    .addEdge("retrieve", "continuity")
    .addEdge("continuity", "plan")
    .addEdge("plan", "draft")
    .addEdge("draft", "review")
    .addConditionalEdges("review", (state: ChapterStateType) => (state.reviewResult?.advances === false || (state.reviewResult?.repeatedEvents?.length || 0) > 0 ? "repair" : "done"), { repair: "repair", done: "__end__" })
    .addEdge("repair", "__end__");

  return graph.compile();
}
