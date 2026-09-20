import { StateGraph, Annotation } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";
import { StoryStore } from "../storage/story-store.js";
import { ModelApiClient, type ApiUsage, type ApiWireMode, type ChatMessage } from "../models/model-api.js";
import type { StreamEmitter } from "../streaming/stream-handler.js";
import { byteLength, compactText, formatContextReport, masterOutlineBytes, storyLedgerBytes, tailText, type ContextReport } from "../context/context-optimizer.js";
import { chapterReviewRequest, normalizeChapterReviewResult } from "../application/chapter-review.js";
// 标题拆分与补全是纯文本处理，批量补标题也要用同一套判定，统一放在 application 层
import { cleanChapterTitleName, splitChapterTitleHeading } from "../application/chapter-titles.js";

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

/**
 * 写作 Agent 的系统提示词
 * 以前这里加上各阶段任务累计五十多条"不得、必须、不要"，模型最安全的写法就是谁都不说话、什么都不做，
 * "他没问，只是默默记在心里"正是那套约束下的最优解。现在只说清身份、资料从哪来、人物怎么写、拿不准怎么办；
 * 具体怎么写交给模型和作者的资料。字节稳定，兼容的中转能复用前缀缓存
 */
export const chapterAgentSystemPrompt = `你是这本书的作者。资料里有世界观、人物卡、总纲、前文记忆和上一章结尾，写作以它们为准；资料里没有的可以自己定，但不能和已有设定冲突。
人物按各自的性格说话和做选择：每个人有想要的东西，也有拿不到的时候；情绪要写出来，不用沉默、"没问"、"淡淡地说"来代替。
拿不准或想和作者商量的事，写在输出末尾，每条单独一行，以「【给作者】」开头；作者会看到并回复你。`;

/** 【给作者】行的识别：模型按系统提示词把疑问写在末尾，逐行剥出来单独交给界面 */
const authorNoteLine = /^\s*[【\[]\s*给作者\s*[】\]]\s*[：:]?\s*(.*)$/u;

/** 把正文里的【给作者】行剥出来；正文和疑问分开交给界面，疑问不能混进章节存起来 */
export function splitAuthorNotes(text: string): { content: string; authorNotes: string[] } {
  const authorNotes: string[] = [];
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const match = authorNoteLine.exec(line);
    if (match) {
      if (match[1].trim()) authorNotes.push(match[1].trim());
      continue;
    }
    kept.push(line);
  }
  return { content: kept.join("\n").trim(), authorNotes };
}

/** JSON 传输信封绝不能成为展示给作者的章节正文：模型偶尔仍按旧习惯回 {"content": "..."} */
function unwrapChapterDraft(value: unknown, depth = 0): string {
  if (typeof value !== "string") return "";
  const text = value.trim().replace(/^```(?:json|markdown|text)?\s*/iu, "").replace(/\s*```$/u, "").trim();
  if (depth >= 4 || !text.startsWith("{")) return stripPreambleAffirmation(text);
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const nested = typeof parsed.draftContent === "string" ? parsed.draftContent : typeof parsed.content === "string" ? parsed.content : "";
    // 信封里就是空的：不能退回原始 JSON 串当正文，否则 {"content":""} 会被当成一整章正文存进去
    if (!nested.trim()) return "";
    const title = typeof parsed.title === "string" && parsed.title.trim() ? `# ${cleanChapterTitleName(parsed.title)}\n\n` : "";
    return `${title}${unwrapChapterDraft(nested, depth + 1)}`;
  } catch {
    return stripPreambleAffirmation(text);
  }
}

/** 模型偶尔把"我会严格沿着计划写"这类确认语当正文返回；开头不是叙述就是承诺，整段丢掉只保留真正文 */
function stripPreambleAffirmation(text: string): string {
  const trimmed = text.trim();
  const match = /^(?:我会|我将|我计划|接下来会|本文将|这一章将|本章将|将严格)[^\n。！？]{0,80}[。！？]\s*/u.exec(trimmed);
  if (!match) return trimmed;
  const rest = trimmed.slice(match[0].length);
  // 只丢开头一句承诺语，后面必须还有真正文；全句都是承诺说明整段都是任务回应，直接报错让作者重试
  return rest.trim() ? rest.trim() : "";
}

/**
 * 正文第一行是章名
 * 提示词让模型第一行只写章名；模型有时仍加 #、书名号或"第 N 章"，一并剥掉。
 * 第一行太长、带句末标点或就是一句叙述时不当标题，整段都是正文
 */
export function splitDraftTitleLine(text: string): { title: string; content: string } {
  const headed = splitChapterTitleHeading(text);
  if (headed.title) return { title: cleanChapterTitleName(headed.title), content: headed.content };
  const lines = text.trim().split("\n");
  const first = lines[0]?.trim() || "";
  const rest = lines.slice(1).join("\n").trim();
  const candidate = cleanChapterTitleName(first.replace(/^第\s*[\d零一二三四五六七八九十百千两]+\s*章\s*[：:·]?\s*/u, ""));
  const looksLikeTitle = candidate.length > 0 && candidate.length <= 20 && !/[，。！？；：、…]/u.test(candidate) && !/^[“"]/u.test(first);
  if (!looksLikeTitle || !rest) return { title: "", content: text.trim() };
  return { title: candidate, content: rest };
}

function buildPrewriteCheck(state: ChapterStateType): { blockers: string[]; warnings: string[]; summary: string } {
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (!state.instruction.trim()) blockers.push("缺少本章创作指令");
  if (!state.outline?.trim() && !state.masterOutline?.trim() && !state.storyLedger?.trim()) warnings.push("没有章纲、总纲和前文记忆，本章只能依据世界观、卡片和作者指令");
  if (!state.previousChapters?.length) warnings.push("没有上一章正文，本章按开篇写");
  return { blockers, warnings, summary: blockers.length ? `写前检查发现 ${blockers.length} 项阻断` : `写前检查通过${warnings.length ? `，${warnings.length} 项提醒` : ""}` };
}

/** A deterministic, stable prefix lets compatible upstreams reuse prompt cache. */
function stableProjectPacket(state: ChapterStateType): string {
  return [
    state.worldSetting ? `## 世界观与作品设定（作者定的固定规则）\n${state.worldSetting}` : "",
    state.writingStyle ? `## 绑定文风\n名称：${state.writingStyle.name}\n${state.writingStyle.content}` : "",
  ].filter(Boolean).join("\n\n");
}

/** 总纲与故事账本：全书级的推进依据，计划、正文、审查三个阶段都要看到同一份
 * 账本按 storyLedgerBytes 截，别在这里再写一个更小的数二次裁剪：之前 3600 字节的账本被截到 2400，中段章节无声消失 */
function storyDirectionPacket(state: ChapterStateType): string {
  return [
    state.chapterBeat ? `## 本章节拍（阶段节拍表给本章定的事件）\n${compactText(state.chapterBeat, 1200)}` : "",
    state.masterOutline ? `## 总纲（含本章位置与本章条目）\n${compactText(state.masterOutline, masterOutlineBytes)}` : "",
    state.storyLedger ? `## 故事账本（前文已发生的事与长线伏笔）\n${compactText(state.storyLedger, storyLedgerBytes)}` : "",
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
  /** 阶段节拍表里本章那一行（含前后行），见 stageBeatLines */
  chapterBeat: Annotation<string | undefined>,
  /** 项目设置的单章目标字数，缺省 3000 */
  targetWords: Annotation<number | undefined>,
  /** 正在写第几章：提示词里要说"写第 N 章"，模型才不用自己数 */
  chapterNumber: Annotation<number | undefined>,
  outline: Annotation<string | undefined>,
  projectTitle: Annotation<string | undefined>,
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
  /** 正文第一行的章名，剥下来交给桌面端填进标题栏 */
  chapterTitle: Annotation<string | undefined>,
  summary: Annotation<string | undefined>,
  /** 模型写在末尾的【给作者】：拿不准的设定、想商量的走向；界面单独展示，连续创作时汇总成待答文档 */
  authorNotes: Annotation<string[]>({ reducer: (_prev, next) => next, default: () => [] }),
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
    /** 保留字段：旧版本审查后会定点修订，现在审查只出报告不改正文 */
    revised?: boolean;
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
 * 客户端默认 4000 是按"几百字回复"定的；一章 3000 字光正文就接近这个数，
 * 加上推理模型的思考量，写到一半就被截断（finish_reason=length），整章白跑
 */
export function chapterDraftMaxTokens(targetWords: number, contextWindowKTokens?: number): number {
  const wanted = Math.round(targetWords * 1.6) + 1500;
  const contextTokens = Math.floor(Number(contextWindowKTokens || 0) * 1024);
  // 输出最多占窗口六成，剩下的留给输入；窗口未知时按 32K 估
  const cap = Math.floor((contextTokens || 32 * 1024) * 0.6);
  return Math.max(2000, Math.min(wanted, cap));
}

/** 正文、计划、重写三处看到的资料是同一份；各写一份迟早会漂移 */
function chapterMaterialPacket(state: ChapterStateType): string {
  const contextSection = state.retrievedContext.length > 0
    ? `\n## 前文记忆\n${state.retrievedContext.join("\n\n")}\n`
    : "";
  const outlineSection = state.outline ? `\n## 本章章纲\n${state.outline}\n` : "";
  const graphSection = state.knowledgeGraph ? `\n## 知识图谱\n${state.knowledgeGraph}\n` : "";
  const cardsSection = state.cards?.length
    ? `\n## 本章人物与设定卡\n${state.cards.map(card => `### ${card.type || "知识卡"}：${card.title}\n${card.content}`).join("\n\n")}\n`
    : "";
  // 只带作者亲手勾的技能：自动按关键词塞三条截断到七百字节的技能，等于往提示词里加一堆残缺的规矩
  const skillsSection = state.selectedSkills.length
    ? `\n## 作者指定的写作技能\n${state.skillCatalog.filter(skill => state.selectedSkills.includes(skill.name)).slice(0, 4).map(skill => `### ${skill.displayName || skill.name}\n${compactText(skill.content, 2400)}`).join("\n\n")}\n`
    : "";
  const continuitySection = state.continuityContext ? `\n## 上一章结尾\n${state.continuityContext}\n` : "";
  const directionSection = storyDirectionPacket(state);
  return [skillsSection, directionSection ? `\n${directionSection}\n` : "", outlineSection, cardsSection, graphSection, continuitySection, contextSection].filter(Boolean).join("");
}

function chapterLabel(state: ChapterStateType): string {
  return state.chapterNumber ? `第 ${state.chapterNumber} 章` : "这一章";
}

/**
 * 正文阶段的提示词组装
 * 首稿和"审查判定没推进、重写一遍"必须看到同一份资料
 */
function chapterDraftPrompts(state: ChapterStateType, contextWindowKTokens?: number, repair?: { repeatedEvents: string[]; progress?: string }): {
  messages: ChatMessage[];
  dynamicPacket: string;
  draftInputBytes: number;
  maxTokens: number;
} {
  const stablePacket = stableProjectPacket(state);
  const session = splitSessionContext(state.sessionContext);
  const dynamicPacket = chapterMaterialPacket(state);
  // 字数读项目设置，写死两三千字会让作者设的目标形同虚设
  const targetWords = state.targetWords && state.targetWords > 0 ? Math.round(state.targetWords) : 3000;
  const planSection = state.chapterPlan ? `\n\n## 这一章的想法\n${state.chapterPlan}` : "";
  const repairSection = repair
    ? `\n\n## 上一版的问题\n上一版被判定为又写了一遍前文：${repair.repeatedEvents.join("；") || "与上一章高度重复"}${repair.progress ? `；只推进到：${repair.progress}` : ""}。这一版换一件前文没发生过的事来写。`
    : "";
  const taskPrompt = `## 作者的要求\n${state.instruction}${planSection}${repairSection}\n\n写${chapterLabel(state)}正文，约 ${targetWords} 字。第一行只写章名（不带"第几章"），空一行后是正文；只输出正文，不要解释或复述资料。`;
  return {
    messages: [
      { role: "system", content: chapterAgentSystemPrompt },
      { role: "user", content: `## 稳定作品资料\n${stablePacket || "（暂无稳定资料）"}` },
      ...(session.summary ? [{ role: "user" as const, content: session.summary }] : []),
      { role: "user", content: `## 本章资料\n${dynamicPacket || "（暂无本章资料）"}` },
      ...(session.recent ? [{ role: "user" as const, content: session.recent }] : []),
      { role: "user", content: taskPrompt },
    ],
    dynamicPacket,
    draftInputBytes: byteLength(chapterAgentSystemPrompt) + byteLength(stablePacket) + byteLength(dynamicPacket) + byteLength(taskPrompt),
    maxTokens: chapterDraftMaxTokens(targetWords, contextWindowKTokens),
  };
}

/** 模型回的正文拆成标题、正文、给作者的话三份 */
function parseDraftResponse(raw: string): { title: string; content: string; authorNotes: string[] } {
  const notes = splitAuthorNotes(unwrapChapterDraft(raw));
  const split = splitDraftTitleLine(notes.content);
  return { title: split.title, content: split.content, authorNotes: notes.authorNotes };
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
      // 只认作者亲手勾选的技能；按指令关键词自动挑技能会把审查、润色类的规矩混进写作提示词
      const preferred = state.preferredSkillNames.map(name => state.skillCatalog.find(skill => skill.name === name)).filter((skill): skill is SkillDefinition => Boolean(skill));
      const selectedSkills = preferred.filter((skill, index, list) => list.findIndex(item => item.name === skill.name) === index).slice(0, 4);
      emitter?.progress("intent", 8, selectedSkills.length ? `作者指定技能：${selectedSkills.map(skill => skill.displayName || skill.name).join("、")}` : "没有指定技能，按资料直接写");
      emitter?.context("intent", "作者指定的写作技能", { source: "SkillRouter", status: "selected", items: selectedSkills.length });
      return {
        recognizedIntent: "章节创作与续写",
        selectedSkills: selectedSkills.map(skill => skill.name),
      };
    })
    .addNode("retrieve", async (state: ChapterStateType) => {
      emitter?.progress("retrieve", 10, "正在检索相关记忆...");
      emitter?.context("retrieve", "检索章节记忆、人物状态和时间线", { source: "StoryStore.searchHybrid", status: "searching" });

      // 首章没有可检索的历史章节或结构化记忆时，直接跳过数据库检索。
      const hasPreviousChapter = Boolean(state.previousChapters?.some(chapter => chapter?.content?.trim()));
      const hasStoredMemory = store.listConfirmed(state.projectId, 1).length > 0;
      if (!hasPreviousChapter && !hasStoredMemory) {
        emitter?.progress("retrieve", 25, "首章暂无历史记忆，已跳过检索");
        emitter?.context("retrieve", "首章无历史记忆，使用世界观、章纲和作者指令", { source: "StoryStore.searchHybrid", status: "selected", items: 0 });
        return { retrievedContext: [], contextReport: state.contextReport ? { ...state.contextReport, retrievedBytes: 0 } : undefined };
      }

      const query = [state.instruction, state.outline, state.chapterBeat].filter(Boolean).join(" ");
      let results;
      let retrievalSource = "StoryStore.searchHybrid";
      try {
        results = await store.searchHybrid(state.projectId, query, 6);
      } catch {
        retrievalSource = "StoryStore.searchExact";
        results = store.searchExact(state.projectId, query, 6).map(r => ({ ...r, similarity: 0.5 }));
      }

      // 人物状态、伏笔、时间线是长期约束：即使与本章指令词面不重合也带一小包
      const priorityTypes = new Set(["character_state", "foreshadowing", "timeline", "canon_fact"]);
      const priority = store.listConfirmed(state.projectId, 32)
        .filter(item => priorityTypes.has(item.type))
        .slice(0, 5)
        .map(item => ({ ...item, similarity: 1 }));
      const seen = new Set<string>();
      // 上一章正文已经由承接节点给出了真正的章尾；再把整段正文检索回来只会把模型按在上一章的场景里
      const previousTitles = new Set((state.previousChapters || []).map(chapter => chapter?.title).filter(Boolean));
      results = [...priority, ...results].filter(item => {
        if (previousTitles.has(item.title)) return false;
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      }).slice(0, 10);

      let remaining = 8000;
      const context = results.flatMap(r => {
        if (remaining < 180) return [];
        const heading = `[${r.type} · ${compactText(r.title, 120)}]`;
        const content = compactText(r.content, Math.max(150, Math.min(900, remaining - byteLength(heading) - 8)));
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
        return { continuityContext: "（没有上一章正文；本章是开篇。）" };
      }
      // 承接锚点只能用真正的章尾；prepareChapterInput 已截好 ending，直接调图时退回从原文截尾
      const tail = previous.ending || tailText(previous.content, 2600);
      const continuityContext = `上一章：${previous.title}\n结尾：\n${tail}\n\n本章从这之后写起；上一章已经发生的事不再重演，承接几段后就该发生新的事。`;
      emitter?.progress("retrieve", 29, `已锁定${previous.title}结尾作为承接锚点`);
      emitter?.context("retrieve", "锁定上一章结尾作为承接锚点", { source: previous.title, status: "selected", bytes: byteLength(tail), items: 1 });
      return { continuityContext };
    })
    // 想：一段自由格式的想法，不是表格也不是 JSON；它只是正文前的一次构思，正文照着它写
    .addNode("plan", async (state: ChapterStateType) => {
      emitter?.progress("plan", 30, "正在构思这一章");
      emitter?.context("plan", "装载本章资料", { source: "ChapterPlanner", status: "loaded", bytes: byteLength(state.outline || "") });
      const stablePacket = stableProjectPacket(state);
      const session = splitSessionContext(state.sessionContext);
      const material = chapterMaterialPacket(state);
      const planInstruction = `## 作者的要求\n${state.instruction}\n\n先想一想${chapterLabel(state)}怎么写，二三百字，自由格式：这一章发生什么（一件前文没发生过的事，总纲或章纲有安排就按它）；相对上一章过了多久、换没换地方；每个出场人物这一章想要什么、会怎么做、和别人怎么相处；情绪落在哪里；结尾停在什么地方。不要写正文。`;
      const fallbackPlan = "按总纲和章纲写这一章该发生的事，承接上一章结尾后推进；人物按各自性格行动，结尾停在能继续发展的地方。";
      let response: Awaited<ReturnType<ModelApiClient["chat"]>>;
      try {
        response = await client.chat([
          { role: "system", content: chapterAgentSystemPrompt },
          { role: "user", content: `## 稳定作品资料\n${stablePacket || "（暂无稳定资料）"}` },
          ...(session.summary ? [{ role: "user" as const, content: session.summary }] : []),
          { role: "user", content: `## 本章资料\n${material || "（暂无本章资料）"}` },
          ...(session.recent ? [{ role: "user" as const, content: session.recent }] : []),
          { role: "user", content: planInstruction },
        ], { temperature: 0.7, max_tokens: 2500, retryAttempts: 2 });
      } catch (error) {
        // 构思只是正文的脚手架：推理模型把输出上限吃光时，改用默认想法继续写，不让整章白跑
        const message = error instanceof Error ? error.message : String(error);
        emitter?.progress("plan", 42, `构思阶段失败，直接写正文：${message}`);
        return { chapterPlan: fallbackPlan, errors: [`计划阶段失败：${message}`] };
      }
      const notes = splitAuthorNotes(unwrapChapterDraft(response.content) || response.content.trim());
      const chapterPlan = notes.content || fallbackPlan;
      emitter?.progress("plan", 42, `构思完成（${chapterPlan.length.toLocaleString()} 字）`);
      return { chapterPlan, authorNotes: [...state.authorNotes, ...notes.authorNotes], upstreamUsage: addUsage(state.upstreamUsage, response.usage) };
    })
    .addNode("draft", async (state: ChapterStateType) => {
      emitter?.progress("draft", 44, "正在组织本章资料");
      const prompts = chapterDraftPrompts(state, config.contextWindowKTokens);
      emitter?.context("draft", "组装稳定设定与本章资料", { source: "ContextAssembler", status: "loaded", bytes: byteLength(prompts.dynamicPacket), items: state.selectedSkills.length + (state.cards?.length || 0) });
      const contextReport = state.contextReport ? { ...state.contextReport, draftInputBytes: prompts.draftInputBytes } : undefined;
      if (contextReport?.cache === "hit") emitter?.context("draft", "命中本地资料指纹缓存", { source: "持久化上下文缓存", status: "cached", bytes: prompts.draftInputBytes });
      if (contextReport?.prunedBytes) emitter?.context("draft", "按上下文预算裁剪低相关资料", { source: "ContextOptimizer", status: "pruned", bytes: contextReport.prunedBytes });

      emitter?.progress("draft", 46, "已提交模型请求，正在生成正文");
      // 正文走纯文本：JSON 模式里写三千字中文，模型会把力气花在转义和格式上，温度也压不上去
      const response = await client.chatStream(prompts.messages, { temperature: 0.85, max_tokens: prompts.maxTokens }, chunk => emitter?.chunk(chunk));
      emitter?.progress("draft", 70, "章节生成完成");
      const parsed = parseDraftResponse(response.content);
      return {
        draftContent: parsed.content,
        chapterTitle: parsed.title,
        summary: "",
        authorNotes: [...state.authorNotes, ...parsed.authorNotes],
        contextReport,
        upstreamUsage: addUsage(state.upstreamUsage, response.usage),
      };
    })
    // 审查只出报告：一致性问题写给作者看，不再自动定点修订。每多一轮低温改写，人物的情绪和口语就被磨平一层
    .addNode("review", async (state: ChapterStateType) => {
      emitter?.progress("review", 75, "正在审查人物、设定、时间线和推进...");

      if (!state.draftContent) {
        return { reviewResult: { consistent: false, issues: ["没有生成章节内容"], suggestions: [] } };
      }

      // 审查提示词与批量审查旧章共用一份（application/chapter-review.ts），改一处两边都生效
      const { messages: reviewMessages, inputBytes: reviewInputBytes } = chapterReviewRequest({
        agentSystemPrompt: chapterAgentSystemPrompt,
        worldSetting: state.worldSetting,
        writingStyle: state.writingStyle,
        chapterBeat: state.chapterBeat,
        masterOutline: state.masterOutline,
        storyLedger: state.storyLedger,
        cards: state.cards,
        knowledgeGraph: state.knowledgeGraph,
        retrievedContext: state.retrievedContext,
        draftContent: state.draftContent,
        sessionContext: state.sessionContext,
      });
      const contextReport = state.contextReport ? { ...state.contextReport, reviewInputBytes } : undefined;

      let response: Awaited<ReturnType<ModelApiClient["chat"]>>;
      try {
        response = await client.chat(reviewMessages, { response_format: { type: "json_object" }, max_tokens: 4000 });
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
      return {
        reviewResult: normalizeChapterReviewResult(response.content),
        contextReport,
        upstreamUsage: addUsage(state.upstreamUsage, response.usage),
      };
    })
    // 审查说"没推进"时重写一次：这是唯一保留的自动改写，因为把上一章再写一遍的稿子交给作者毫无价值
    // 只重写一次就不再审，避免既烧 token 又陷入反复改的循环
    .addNode("repair", async (state: ChapterStateType) => {
      const review = state.reviewResult;
      if (!review) return {};
      emitter?.progress("draft", 80, "审查判定本章重复前文，正在换一件事重写一次");
      emitter?.context("draft", "首版被判定为没推进，重写一次", { source: "ConsistencyChecker", status: "selected", items: review.repeatedEvents?.length || 0 });
      const prompts = chapterDraftPrompts(state, config.contextWindowKTokens, { repeatedEvents: review.repeatedEvents || [], progress: review.progress });
      try {
        const response = await client.chatStream(prompts.messages, { temperature: 0.85, max_tokens: prompts.maxTokens }, chunk => emitter?.chunk(chunk));
        const parsed = parseDraftResponse(response.content);
        return {
          // 重写没产出正文时保留首版：宁可让作者看到报告里的"没有推进"，也不能把整章弄丢
          draftContent: parsed.content || state.draftContent,
          chapterTitle: parsed.title || state.chapterTitle,
          authorNotes: [...state.authorNotes, ...parsed.authorNotes],
          reviewResult: { ...review, advances: true, repeatedEvents: [], suggestions: [...review.suggestions, "本章首版未推进主线，已自动换一件事重写一次"] },
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
    .addConditionalEdges("review", (state: ChapterStateType) => {
      const review = state.reviewResult;
      if (!review) return "done";
      if (review.advances === false || (review.repeatedEvents?.length || 0) > 0) return "repair";
      return "done";
    }, { repair: "repair", done: "__end__" })
    .addEdge("repair", "__end__");

  return graph.compile();
}
