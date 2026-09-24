import { StateGraph, Annotation } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";
import { StoryStore } from "../storage/story-store.js";
import { ModelApiClient, type ApiUsage, type ApiWireMode, type ChatMessage } from "../models/model-api.js";
import type { StreamEmitter } from "../streaming/stream-handler.js";
import { byteLength, compactText, formatContextReport, masterOutlineBytes, storyLedgerBytes, tailText, type ContextReport } from "../context/context-optimizer.js";
import { draftAcceptanceIssues, lintProse, normalizePauses, normalizeQuotes, type LintFinding, type QuoteStyle } from "@zhizhang/contracts";
import { reviewUnavailable, type ChapterReviewResult, type ReviewMode } from "../application/chapter-review.js";
import { perspectiveLabel, runChapterReview } from "../application/review-runner.js";
import { chapterRevisePrompt, wholeChapterTokenBudget } from "../application/text-prompts.js";
import type { ChapterBenchmark } from "../application/benchmark.js";
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
export const chapterAgentSystemPrompt = `你是这本书的作者。阅读作者提供的作品资料、前后章节和本章要求，自由写出这一章。资料用于保持人物、事实和时间连续；写法、节奏、情绪和人物反应由你根据上下文判断。不要解释，不要评价，不要把资料复述成提纲，直接写正文。`;

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
    projectProfileSection(state.projectProfile),
    state.worldSetting ? `## 世界观与作品设定（作者定的固定规则）\n${state.worldSetting}` : "",
    state.writingStyle ? `## 绑定文风\n名称：${state.writingStyle.name}\n${state.writingStyle.content}` : "",
    authorAnswersSection(state.authorAnswers),
  ].filter(Boolean).join("\n\n");
}

/**
 * 作者已答复的问题：模型之前用【给作者】问过、作者拍了板的事，之后每章都按答复写
 * 没有这一段，模型每章都会把同一个问题再问一遍，作者答了也白答
 */
export function authorAnswersSection(answers: Array<{ question: string; answer: string }> | undefined): string {
  const items = (answers || []).filter(item => item.question.trim() && item.answer.trim()).slice(-20);
  if (!items.length) return "";
  return `## 作者已答复（你之前问过的，按答复写，不要再问）\n${items.map(item => `- 问：${compactText(item.question, 240)}\n  答：${compactText(item.answer, 400)}`).join("\n")}`;
}

/**
 * 作品定位：类型、标签、简介、主角
 * 以前只有卡片和大纲生成看得到简介，写正文的模型不知道这本书是"慢热高甜"还是"权谋清算"，
 * 只能照着事务性的章纲写，一本言情写成工作日志就是从这里开始的
 */
export function projectProfileSection(profile: ProjectProfile | undefined): string {
  if (!profile) return "";
  const genre = [profile.genre, profile.subgenre].filter(Boolean).join(" / ");
  const tags = (profile.tags || []).filter(Boolean).slice(0, 12).join("、");
  const leads = (profile.protagonists || []).filter(Boolean);
  const lines = [
    genre ? `类型：${genre}` : "",
    tags ? `标签：${tags}` : "",
    leads.length ? `主角：${leads.join(" × ")}` : "",
    profile.synopsis ? `简介：${compactText(profile.synopsis, 1400)}` : "",
  ].filter(Boolean);
  if (!lines.length) return "";
  return `## 作品定位\n${lines.join("\n")}`;
}

export interface ProjectProfile {
  genre?: string;
  subgenre?: string;
  tags?: string[];
  synopsis?: string;
  protagonists?: string[];
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

/** 只有写作与润色类技能会进正文提示词；审查、拆书、工具类的规矩混进来只会让模型束手束脚 */
const chapterSkillCategories = new Set(["write", "polish"]);
/** 流程词不算场景标签："继续写第三章"里的"续写"、章纲里的"正文"到处都是，按它们匹配等于每章都带满 */
const genericSkillTerms = new Set(["正文", "章节", "续写", "写作", "长篇", "短篇", "大纲", "结构", "润色", "小说", "创作", "剧情"]);

/**
 * 本章技能：作品默认技能每章必带，作者本次勾选的其次，再按章纲、节拍与指令里出现的标签自动匹配
 * 匹配只认整词命中（标签或显示名原样出现），不做分词打分：分词打分会把"章节""正文"这种到处都有的词当成命中，
 * 结果就是每章都带满四条。日常过渡章命不中任何标签，就只带默认技能
 */
export function routeChapterSkills(input: { catalog: SkillDefinition[]; defaultNames: string[]; preferredNames: string[]; haystack: string; limit?: number }): { skills: SkillDefinition[]; routed: SkillDefinition[] } {
  const limit = input.limit ?? 4;
  const byName = (name: string) => input.catalog.find(skill => skill.name === name);
  const defaults = input.defaultNames.map(byName).filter((skill): skill is SkillDefinition => Boolean(skill));
  const preferred = input.preferredNames.map(byName).filter((skill): skill is SkillDefinition => Boolean(skill));
  const haystack = input.haystack.toLowerCase();
  const routed = input.catalog.filter(skill => {
    if (!chapterSkillCategories.has(skill.category || "write")) return false;
    if (defaults.includes(skill) || preferred.includes(skill)) return false;
    const terms = [skill.displayName || "", ...(skill.tags || [])].map(term => term.trim().toLowerCase()).filter(term => term.length >= 2 && !genericSkillTerms.has(term));
    return terms.some(term => haystack.includes(term));
  });
  const skills = [...defaults, ...preferred, ...routed].filter((skill, index, list) => list.findIndex(item => item.name === skill.name) === index).slice(0, limit);
  return { skills, routed: routed.filter(skill => skills.includes(skill)) };
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
  /** 作品定位：类型、标签、简介、主角；进稳定资料，构思、正文、审查三步都看 */
  projectProfile: Annotation<ProjectProfile | undefined>,
  /** 作者对模型【给作者】提问的答复：进稳定资料，之后每章按答复写 */
  authorAnswers: Annotation<Array<{ question: string; answer: string }>>({ reducer: (_prev, next) => next, default: () => [] }),
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
  /** 全书总章数：本章不是最后一章时（重写旧章）审查按历史章节口径，不拿最新进度要求它 */
  totalChapters: Annotation<number | undefined>,
  outline: Annotation<string | undefined>,
  projectTitle: Annotation<string | undefined>,
  previousChapters: Annotation<Array<{ id?: string | number; title: string; content: string; ending?: string }> | undefined>,
  /** 重写历史章时的后文参考，只用于让模型知道本章不能把后面已经承担的戏提前写完 */
  followingChapters: Annotation<Array<{ id?: string | number; title: string; content: string }> | undefined>,
  referenceChapters: Annotation<Array<{ id?: string | number; number: number; title: string; content: string }> | undefined>,
  knowledgeGraph: Annotation<string | undefined>,
  cards: Annotation<Array<{ type?: string; title: string; content: string }> | undefined>,
  skillCatalog: Annotation<SkillDefinition[]>({ reducer: (_prev, next) => next, default: () => [] }),
  preferredSkillNames: Annotation<string[]>({ reducer: (_prev, next) => next, default: () => [] }),
  /** 作品默认技能：项目设置里绑定，每章必带；按章纲与指令自动匹配的技能在它之上追加 */
  defaultSkillNames: Annotation<string[]>({ reducer: (_prev, next) => next, default: () => [] }),
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
  /** 审查档位：full 四视角、lean 两视角、solo 一次合并审查 */
  reviewMode: Annotation<ReviewMode>({ reducer: (_prev, next) => next, default: () => "lean" }),
  /** 全书引号风格：验证门把本章引号统一到它；没传就按上一章正文侦测 */
  quoteStyle: Annotation<QuoteStyle | undefined>,
  /** 最近几章的开头句与结尾句：写作时让模型看见前面几章怎么开怎么收，验证门查同型 */
  recentOpenings: Annotation<string[]>({ reducer: (_prev, next) => next, default: () => [] }),
  recentEndings: Annotation<string[]>({ reducer: (_prev, next) => next, default: () => [] }),
  /** 上一章记忆里的"下一章承诺"：构思要回应它，一致性审查查它兑现了没 */
  previousPromise: Annotation<string | undefined>,
  /** 作者允许的字面片段：验证门对命中它们的风格类问题不报 */
  allowedPhrases: Annotation<string[]>({ reducer: (_prev, next) => next, default: () => [] }),
  /** 项目绑定的对标拆书的全书聚合：构思看情绪模块与节奏表，正文只带一段同基调锚点 */
  benchmark: Annotation<ChapterBenchmark | undefined>,
  /** 本地验证门的结果：进审查报告，不进模型 */
  lintFindings: Annotation<LintFinding[]>({ reducer: (_prev, next) => next, default: () => [] }),
  /** 验证门已经为本稿做过几次结构修订；只改一次，改不干净就交给作者 */
  lintRounds: Annotation<number>({ reducer: (_prev, next) => next, default: () => 0 }),
  /** 草稿不过关时最多自动修一次，修订版必须重新审查 */
  autoRepairRounds: Annotation<number>({ reducer: (_prev, next) => next, default: () => 0 }),
  autoRepairSucceeded: Annotation<boolean>({ reducer: (_prev, next) => next, default: () => false }),
  contextReport: Annotation<ContextReport | undefined>,
  sessionContext: Annotation<string | undefined>,
  authorPreferences: Annotation<string[]>({ reducer: (_prev, next) => next, default: () => [] }),
  upstreamUsage: Annotation<UsageTotals | undefined>({ reducer: (_prev, next) => next, default: () => undefined }),
  reviewResult: Annotation<(ChapterReviewResult & { revised?: boolean }) | undefined>,
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
  reviewModel?: string;
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

/**
 * 正文阶段的出场卡：构思里点到名的才带，构思没安排的人（哪怕是常驻的主角）本章就不出现
 * 支线章、第二视角的伏笔章靠这条才能只写配角；金手指卡是世界规则不是人物，一律带
 */
export function castCards(cards: Array<{ type?: string; title: string; content: string }> | undefined, chapterPlan: string | undefined): Array<{ type?: string; title: string; content: string }> {
  if (!cards?.length || !chapterPlan?.trim()) return cards || [];
  return cards.filter(card => card.type === "金手指卡" || chapterPlan.includes(card.title.trim()));
}

/** 正文、计划、重写三处看到的资料是同一份；各写一份迟早会漂移 */
function chapterMaterialPacket(state: ChapterStateType): string {
  const contextSection = state.retrievedContext.length > 0
    ? `\n## 前文记忆\n${state.retrievedContext.join("\n\n")}\n`
    : "";
  const outlineSection = state.outline ? `\n## 本章章纲\n${state.outline}\n` : "";
  const cardsSection = state.cards?.length
    ? `\n## 本章相关人物与设定\n${state.cards.map(card => `### ${card.type || "知识卡"}：${card.title}\n${card.content}`).join("\n\n")}\n`
    : "";
  // 保留默认、作者指定和最相关的少量技能；不要把整套技能目录变成正文规则
  const skillsSection = state.selectedSkills.length
    ? `\n## 写作参考\n${state.skillCatalog.filter(skill => state.selectedSkills.includes(skill.name)).slice(0, 3).map(skill => `### ${skill.displayName || skill.name}\n${compactText(skill.content, 1600)}`).join("\n\n")}\n`
    : "";
  const continuitySection = state.continuityContext ? `\n## 上一章结尾\n${state.continuityContext}\n` : "";
  const promiseSection = state.previousPromise ? `\n## 上一章留给本章的事\n${state.previousPromise}\n` : "";
  const directionSection = storyDirectionPacket(state);
  // 重写历史章：卡片正文和设定文档里难免写着后面章的事（"第 204 章体检""第 194 章改称阿妄"），这些在本章时点还没发生
  const number = typeof state.chapterNumber === "number" ? state.chapterNumber : 0;
  const historical = number > 0 && typeof state.totalChapters === "number" && number < state.totalChapters;
  const historyNote = historical
    ? `\n## 本章的时点\n本章是第 ${number} 章，正在重写。资料里凡是标着第 ${number} 章及以后章号的事（卡片里的"第 194 章起改称""第 204 章体检"、设定文档里的后续进展）在本章时点都还没发生，不能写进来、不能让人物知道；人物关系与状态以第 ${number - 1} 章之前的记忆为准。\n`
    : "";
  const followingSection = state.followingChapters?.length
    ? `\n## 后续章节参考\n${state.followingChapters.map(chapter => `### ${chapter.title}\n${compactText(chapter.content, 2200)}`).join("\n\n")}\n`
    : "";
  const referenceSection = state.referenceChapters?.length
    ? `\n## 人物参考章节\n第111章及其前后章节是本书人物和情绪的主要参考：\n${state.referenceChapters.map(chapter => `### 第${chapter.number}章｜${chapter.title}\n${compactText(chapter.content, chapter.number === 111 ? 9000 : 3500)}`).join("\n\n")}\n`
    : "";
  return [skillsSection, historyNote, directionSection ? `\n${directionSection}\n` : "", outlineSection, cardsSection, continuitySection, promiseSection, contextSection, followingSection, referenceSection].filter(Boolean).join("");
}

/** 修订类调用（验证门定向修订、事实矛盾定点修订）返回的整章正文：剥围栏、标题行与【给作者】，和首稿走同一套拆法 */
function parseRevisedDraft(raw: string): { content: string; title: string; authorNotes: string[] } {
  const parsed = parseDraftResponse(raw);
  return { content: parsed.content, title: parsed.title, authorNotes: parsed.authorNotes };
}

function chapterLabel(state: ChapterStateType): string {
  return state.chapterNumber ? `第 ${state.chapterNumber} 章` : "这一章";
}

/**
 * 正文阶段的提示词组装
 * 首稿直接写作，审查只读这版稿
 */
function chapterDraftPrompts(state: ChapterStateType, contextWindowKTokens?: number): {
  messages: ChatMessage[];
  dynamicPacket: string;
  draftInputBytes: number;
  maxTokens: number;
} {
  const stablePacket = stableProjectPacket(state);
  const dynamicPacket = chapterMaterialPacket({ ...state, cards: state.cards });
  const targetWords = state.targetWords && state.targetWords > 0 ? Math.round(state.targetWords) : 3000;
  const taskPrompt = `## 作者的要求
${state.instruction}

写${chapterLabel(state)}正文，约 ${targetWords} 字。第一行写章名（不带"第几章"），空一行后开始正文；只输出章节内容。`;
  return {
    messages: [
      { role: "system", content: chapterAgentSystemPrompt },
      { role: "user", content: `## 稳定作品资料\n${stablePacket || "（暂无稳定资料）"}` },
      { role: "user", content: `## 本章资料\n${dynamicPacket || "（暂无本章资料）"}` },
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

const structuralLintTypes = new Set(["truncated", "placeholder-leak", "verbatim-repeat", "meta-leak"]);
export const needsStructuralRepair = (findings: LintFinding[]): boolean => findings.some(item => item.severity === "blocking" && structuralLintTypes.has(item.type));

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
  const reviewClient = new ModelApiClient({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    defaultModel: config.reviewModel || config.model,
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
      const { skills, routed } = routeChapterSkills({
        catalog: state.skillCatalog,
        defaultNames: state.defaultSkillNames,
        preferredNames: state.preferredSkillNames,
        haystack: [state.outline, state.chapterBeat, state.instruction].filter(Boolean).join("\n"),
      });
      const label = (list: SkillDefinition[]) => list.map(skill => skill.displayName || skill.name).join("、");
      const parts = [
        state.defaultSkillNames.length ? `作品默认：${label(skills.filter(skill => state.defaultSkillNames.includes(skill.name)))}` : "",
        state.preferredSkillNames.length ? `本次指定：${label(skills.filter(skill => state.preferredSkillNames.includes(skill.name)))}` : "",
        routed.length ? `按章纲匹配：${label(routed)}` : "",
      ].filter(Boolean);
      emitter?.progress("intent", 8, parts.length ? parts.join("；") : "没有默认技能，本章也没匹配到技能，按资料直接写");
      emitter?.context("intent", "本章写作技能", { source: "SkillRouter", status: "selected", items: skills.length });
      return {
        recognizedIntent: "章节创作与续写",
        selectedSkills: skills.map(skill => skill.name),
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
    // 已有章纲就是写作骨架，不再额外调用模型生成一遍“想法”
    .addNode("plan", async (state: ChapterStateType) => {
      const chapterPlan = state.outline?.trim() || "";
      emitter?.progress("plan", 42, chapterPlan ? "已装载本章章纲" : "本章没有额外章纲，直接依据上下文创作");
      return { chapterPlan };
    })
    .addNode("draft", async (state: ChapterStateType) => {
      emitter?.progress("draft", 44, "正在组织本章资料");
      const prompts = chapterDraftPrompts(state, config.contextWindowKTokens);
      emitter?.context("draft", "组装稳定设定与本章资料", { source: "ContextAssembler", status: "loaded", bytes: byteLength(prompts.dynamicPacket), items: state.selectedSkills.length + (state.cards?.length || 0) });
      const contextReport = state.contextReport ? { ...state.contextReport, draftInputBytes: prompts.draftInputBytes } : undefined;
      if (contextReport?.cache === "hit") emitter?.context("draft", "命中本地资料指纹缓存", { source: "持久化上下文缓存", status: "cached", bytes: prompts.draftInputBytes });
      if (contextReport?.prunedBytes) emitter?.context("draft", "已裁掉低相关资料", { source: "ContextOptimizer", status: "pruned", bytes: contextReport.prunedBytes });

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
    // 标点统一；句式只提示作者，截断、占位符等坏稿才自动修一次
    .addNode("gate", async (state: ChapterStateType) => {
      if (!state.draftContent) return {};
      const quoted = normalizeQuotes(state.draftContent, state.quoteStyle || "curly");
      const paused = normalizePauses(quoted.text);
      const content = paused.text;
      const lintFindings = lintProse(content, {
        outline: state.chapterPlan,
        recentOpenings: state.recentOpenings,
        recentEndings: state.recentEndings,
        allowedPhrases: state.allowedPhrases,
      }).map(item => item.severity === "blocking" && !structuralLintTypes.has(item.type) ? { ...item, severity: "advisory" as const } : item);
      const structural = lintFindings.filter(item => item.severity === "blocking" && structuralLintTypes.has(item.type));
      const normalized = quoted.changes + paused.changes;
      emitter?.progress("review", 72, `验证门：标点归一 ${normalized} 处；结构问题 ${structural.length} 条，其他提醒 ${lintFindings.length - structural.length} 条`);
      emitter?.context("review", "本地验证门", { source: "prose-lint", status: structural.length ? "selected" : "loaded", items: lintFindings.length });
      return { draftContent: content, lintFindings };
    })
    // 定向修订：只把验证门点名的句子交给模型改，其余原样保留。每稿最多一次，改不干净就交给作者
    .addNode("fixLint", async (state: ChapterStateType) => {
      const blocking = state.lintFindings.filter(item => item.severity === "blocking" && structuralLintTypes.has(item.type));
      if (!state.draftContent || !blocking.length) return {};
      emitter?.progress("review", 74, `正在按验证门意见定向修订 ${blocking.length} 处`);
      const instruction = [
        "只修复以下截断、复读、占位符或工程词泄漏；未点名的句子保持原样：",
        ...blocking.map((item, index) => `${index + 1}. 第 ${item.line} 行「${item.excerpt}」：${item.message}`),
      ].join("\n");
      const prompt = chapterRevisePrompt({ projectTitle: state.projectTitle, chapterTitle: state.chapterTitle, instruction, content: state.draftContent });
      try {
        const response = await client.chatStream([{ role: "user", content: prompt }], { temperature: 0.5, max_tokens: wholeChapterTokenBudget(state.draftContent), retryAttempts: 2 }, chunk => emitter?.chunk(chunk));
        const revised = parseRevisedDraft(response.content);
        // 修订没产出正文就保留原稿：宁可报告里留着问题，也不能把整章弄丢
        if (!revised.content) return { lintRounds: state.lintRounds + 1, errors: ["验证门定向修订没有返回正文，已保留原稿"] };
        return { draftContent: revised.content, authorNotes: [...state.authorNotes, ...revised.authorNotes], lintRounds: state.lintRounds + 1, upstreamUsage: addUsage(state.upstreamUsage, response.usage) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { lintRounds: state.lintRounds + 1, errors: [`验证门定向修订失败：${message}`] };
      }
    })
    // 审查结果与正文始终同版；不合格先自动修一次，再重新验收
    .addNode("review", async (state: ChapterStateType) => {
      if (!state.draftContent) {
        return { reviewResult: { ...reviewUnavailable(state.reviewMode, "没有生成章节内容"), consistent: false, issues: ["没有生成章节内容"] } };
      }
      const { result, inputBytes, usages, failures } = await runChapterReview(reviewClient, state.reviewMode, {
        agentSystemPrompt: chapterAgentSystemPrompt,
        projectProfile: projectProfileSection(state.projectProfile),
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
        chapterNumber: state.chapterNumber,
        totalChapters: state.totalChapters,
        chapterPlan: state.chapterPlan,
        previousPromise: state.previousPromise,
        previousChapter: state.previousChapters?.at(-1),
        instruction: state.instruction,
      }, state.lintFindings, (perspective, index, total) => emitter?.progress("review", 75 + Math.round(index / total * 18), `${perspectiveLabel(perspective)}（${index + 1}/${total}）`));
      emitter?.progress("review", 94, `审查完成：${result.verdict}，${result.findings.length} 条`);
      const contextReport = state.contextReport ? { ...state.contextReport, reviewInputBytes: inputBytes } : undefined;
      let upstreamUsage = state.upstreamUsage;
      for (const usage of usages) upstreamUsage = addUsage(upstreamUsage, usage);
      // 视角全失败等于审查没跑：报告里如实写审查未完成，错误按"审查阶段失败"记，正文照常交给作者
      const allFailed = failures.length > 0 && result.perspectives.length === failures.length;
      if (allFailed) emitter?.progress("review", 95, `审查未完成：${failures.join("；")}`);
      return {
        reviewResult: allFailed ? reviewUnavailable(state.reviewMode, failures.join("；")) : result,
        contextReport,
        upstreamUsage,
        errors: failures.map(item => `${allFailed ? "审查阶段失败" : "审查视角失败"}：${item}`),
      };
    })
    .addNode("autoRepair", async (state: ChapterStateType) => {
      if (!state.draftContent || !state.reviewResult) return { autoRepairRounds: 1, autoRepairSucceeded: false };
      const target = state.targetWords && state.targetWords > 0 ? Math.round(state.targetWords) : 0;
      const issues = draftAcceptanceIssues(state.draftContent, target, state.reviewResult);
      // 所有视角都失败时没有任何事实依据，不能让正文模型盲修；部分视角失败仍可修已知的字数/事实问题，之后必须复审
      if (!state.reviewResult.perspectives.length) {
        return { autoRepairRounds: 1, autoRepairSucceeded: false, errors: ["审查未完成，未自动修正正文"] };
      }
      const repeated = state.reviewResult.advances === false || state.reviewResult.repeatedEvents.length > 0;
      emitter?.progress("draft", 95, `草稿未过关，自动修正一次：${issues.join("；")}`);
      try {
        const messages: ChatMessage[] = repeated
          ? [...chapterDraftPrompts(state, config.contextWindowKTokens).messages, {
            role: "user", content: `上一版重演了前文：${state.reviewResult.repeatedEvents.join("；") || state.reviewResult.progress}。从上一章结尾继续，写尚未发生的新事件；不要复述已经完成的结果。输出完整新章。`,
          }]
          : [{ role: "user", content: chapterRevisePrompt({
            projectTitle: state.projectTitle,
            chapterTitle: state.chapterTitle,
            content: state.draftContent,
            instruction: `本稿验收问题：${issues.join("；")}。目标 ${target || 3000} 字，不超过 ${Math.floor((target || 3000) * 1.2)} 字。按本章已有事件补足需要的场景或收紧超长部分，不用重复动作和解释凑字数；事实问题按上一章已发生的结果修正。`,
          }) }];
        const response = await client.chatStream(messages, {
          temperature: repeated ? 0.85 : 0.65,
          max_tokens: chapterDraftMaxTokens(target || 3000, config.contextWindowKTokens),
        }, chunk => emitter?.chunk(chunk));
        const revised = repeated ? parseDraftResponse(response.content) : parseRevisedDraft(response.content);
        if (!revised.content) return { autoRepairRounds: 1, autoRepairSucceeded: false, errors: ["自动修正没有返回正文，保留首稿"] };
        return {
          draftContent: revised.content,
          chapterTitle: revised.title || state.chapterTitle,
          authorNotes: [...state.authorNotes, ...revised.authorNotes],
          lintRounds: 0,
          autoRepairRounds: 1,
          autoRepairSucceeded: true,
          upstreamUsage: addUsage(state.upstreamUsage, response.usage),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { autoRepairRounds: 1, autoRepairSucceeded: false, errors: [`自动修正失败，保留首稿：${message}`] };
      }
    })
    .addEdge("__start__", "prewrite")
    .addEdge("prewrite", "intent")
    .addEdge("intent", "retrieve")
    .addEdge("retrieve", "continuity")
    .addEdge("continuity", "plan")
    // 构思里已经有问题：先问完再写，不要写完一章再为每个问题重写
    .addConditionalEdges("plan", (state: ChapterStateType) => state.authorNotes?.length ? "ask" : "draft", { ask: "__end__", draft: "draft" })
    .addEdge("draft", "gate")
    // 验证门之后：结构问题最多定向修一次，随后审查最终稿
    .addConditionalEdges("gate", (state: ChapterStateType) => {
      if (needsStructuralRepair(state.lintFindings) && state.lintRounds === 0 && state.draftContent) return "fixLint";
      return "review";
    }, { fixLint: "fixLint", review: "review" })
    .addEdge("fixLint", "gate")
    .addConditionalEdges("review", (state: ChapterStateType) => {
      if (state.autoRepairRounds || !state.draftContent || !state.reviewResult) return "done";
      const target = state.targetWords && state.targetWords > 0 ? Math.round(state.targetWords) : 0;
      const issues = draftAcceptanceIssues(state.draftContent, target, state.reviewResult);
      // 所有视角都失败时不能自动修；部分视角失败只有同时存在已知字数/事实问题时才修，最终仍不能伪造通过
      if (!state.reviewResult.perspectives.length) return "done";
      const repairableIssues = issues.filter(item => !item.startsWith("审查未完成"));
      return repairableIssues.length ? "autoRepair" : "done";
    }, { autoRepair: "autoRepair", done: "__end__" })
    .addConditionalEdges("autoRepair", (state: ChapterStateType) => state.autoRepairSucceeded ? "gate" : "done", { gate: "gate", done: "__end__" });

  return graph.compile();
}
