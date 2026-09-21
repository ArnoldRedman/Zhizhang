import { StateGraph, Annotation } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";
import { StoryStore } from "../storage/story-store.js";
import { ModelApiClient, type ApiUsage, type ApiWireMode, type ChatMessage } from "../models/model-api.js";
import type { StreamEmitter } from "../streaming/stream-handler.js";
import { byteLength, compactText, formatContextReport, masterOutlineBytes, storyLedgerBytes, tailText, type ContextReport } from "../context/context-optimizer.js";
import { hasBlocking, lintProse, normalizePauses, normalizeQuotes, type LintFinding, type QuoteStyle } from "@zhizhang/contracts";
import { reviewUnavailable, type ChapterReviewResult, type ReviewMode } from "../application/chapter-review.js";
import { perspectiveLabel, runChapterReview } from "../application/review-runner.js";
import { chapterRevisePrompt, wholeChapterTokenBudget } from "../application/text-prompts.js";
import { benchmarkDraftSection, benchmarkPlanSection, type ChapterBenchmark } from "../application/benchmark.js";
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
每个人物的说话方式、在意的东西、处理情绪的办法都不一样，一句台词遮住名字也能认出是谁说的；两个人在同一场戏里对同一件事的反应必须不同。
事务和感情一起推进：主角之间的关系每章都要往前走一点，用具体的一句话、一个动作、一次让步或一次靠近写出来，不用"默契""信任加深"这类总结代替。
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
    projectProfileSection(state.projectProfile),
    state.worldSetting ? `## 世界观与作品设定（作者定的固定规则）\n${state.worldSetting}` : "",
    state.writingStyle ? `## 绑定文风\n名称：${state.writingStyle.name}\n${state.writingStyle.content}` : "",
  ].filter(Boolean).join("\n\n");
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
  return `## 作品定位（这本书卖什么，每章都要兑现）\n${lines.join("\n")}`;
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
  /** 验证门已经为本稿做过几次定向修订；只改一次，改不干净就交给作者 */
  lintRounds: Annotation<number>({ reducer: (_prev, next) => next, default: () => 0 }),
  /** 走到验证门时正文处于哪个阶段：修订后的稿不再进审查，避免审改循环 */
  phase: Annotation<"draft" | "repaired" | "fixed">({ reducer: (_prev, next) => next, default: () => "draft" }),
  repairRounds: Annotation<number>({ reducer: (_prev, next) => next, default: () => 0 }),
  fixRounds: Annotation<number>({ reducer: (_prev, next) => next, default: () => 0 }),
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
  const graphSection = state.knowledgeGraph ? `\n## 知识图谱\n${state.knowledgeGraph}\n` : "";
  const cardsSection = state.cards?.length
    ? `\n## ${state.chapterPlan ? "本章出场人物与设定卡" : "人物与设定卡（资料；谁出场由本章构思定，常驻的人也可以整章不出现）"}\n${state.cards.map(card => `### ${card.type || "知识卡"}：${card.title}\n${card.content}`).join("\n\n")}\n`
    : "";
  // 只带作者亲手勾的技能：自动按关键词塞三条截断到七百字节的技能，等于往提示词里加一堆残缺的规矩
  const skillsSection = state.selectedSkills.length
    ? `\n## 作者指定的写作技能\n${state.skillCatalog.filter(skill => state.selectedSkills.includes(skill.name)).slice(0, 4).map(skill => `### ${skill.displayName || skill.name}\n${compactText(skill.content, 2400)}`).join("\n\n")}\n`
    : "";
  const continuitySection = state.continuityContext ? `\n## 上一章结尾\n${state.continuityContext}\n` : "";
  // 让模型自己看见前面几章怎么开头怎么收尾：比写一条"不得以灯收尾"的禁令管用，也不用往提示词里加规矩
  const echoSection = state.recentOpenings.length || state.recentEndings.length
    ? `\n## 前面几章的开头与结尾（本章换个开法和收法）\n${state.recentOpenings.map((line, index) => `开头${index + 1}：${line}`).join("\n")}\n${state.recentEndings.map((line, index) => `结尾${index + 1}：${line}`).join("\n")}\n`
    : "";
  const promiseSection = state.previousPromise ? `\n## 上一章留给本章的事\n${state.previousPromise}\n` : "";
  const directionSection = storyDirectionPacket(state);
  return [skillsSection, directionSection ? `\n${directionSection}\n` : "", outlineSection, cardsSection, graphSection, continuitySection, promiseSection, echoSection, contextSection].filter(Boolean).join("");
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
  // 正文阶段只带一段与构思基调相同的对标锚点和一张模块：整份聚合塞进来模型会照着抄结构；卡片只带构思里出场的
  const dynamicPacket = chapterMaterialPacket({ ...state, cards: castCards(state.cards, state.chapterPlan) }) + benchmarkDraftSection(state.benchmark, state.chapterPlan).section;
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
    // 想：一段自由格式的想法，不是表格也不是 JSON；它只是正文前的一次构思，正文照着它写
    .addNode("plan", async (state: ChapterStateType) => {
      emitter?.progress("plan", 30, "正在构思这一章");
      emitter?.context("plan", "装载本章资料", { source: "ChapterPlanner", status: "loaded", bytes: byteLength(state.outline || "") });
      const stablePacket = stableProjectPacket(state);
      const session = splitSessionContext(state.sessionContext);
      // 构思阶段多看一份对标资料：情绪模块与节奏表，让模型挑这一章的情绪链
      const material = chapterMaterialPacket(state) + benchmarkPlanSection(state.benchmark);
      const planInstruction = `## 作者的要求\n${state.instruction}\n\n先想一想${chapterLabel(state)}怎么写，四五百字，自由格式，但要写清这几样：这一章发生什么（一件前文没发生过的事，总纲或章纲有安排就按它）；读完这章什么变了（目标、风险、信息、关系、资源、身份、情绪立场里至少一项）；相对上一章过了多久、换没换地方；每个出场人物这一章想要什么、会怎么做、和别人怎么相处，以及这个人和别人不一样的地方在本章怎么显出来（说话的句式、在意的东西、处理情绪的办法，写一处只有这个人会做的选择）；感情线：主角之间这一章走到哪一步，比上一章多了什么，用哪个具体场面写出来（一次靠近、一句真话、一个只对对方做的动作），主角不出场的配角章或伏笔章可以写"本章不推进感情线"并说明原因；情绪从什么走到什么；按顺序列四到八个情节点，每个一句话；结尾停在哪个具体动作或画面上。不要写正文，不要把情节点写成成品句子。`;
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
    // 本地验证门：不调模型，毫秒级。引号与停顿标点直接归一；blocking 句式交给一次定向修订；其余进报告
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
      });
      const blocking = lintFindings.filter(item => item.severity === "blocking");
      const normalized = quoted.changes + paused.changes;
      emitter?.progress("review", 72, `验证门：标点归一 ${normalized} 处；句式问题 ${blocking.length} 条须改，${lintFindings.length - blocking.length} 条提示`);
      emitter?.context("review", "本地验证门", { source: "prose-lint", status: blocking.length ? "selected" : "loaded", items: lintFindings.length });
      return { draftContent: content, lintFindings };
    })
    // 定向修订：只把验证门点名的句子交给模型改，其余原样保留。每稿最多一次，改不干净就交给作者
    .addNode("fixLint", async (state: ChapterStateType) => {
      const blocking = state.lintFindings.filter(item => item.severity === "blocking");
      if (!state.draftContent || !blocking.length) return {};
      emitter?.progress("review", 74, `正在按验证门意见定向修订 ${blocking.length} 处`);
      const instruction = [
        "只改下面点名的句子，其余一字不动；改法：删掉否定铺垫直接写后项、破折号按功能换成动作或逗号、章尾预告改成具体动作画面、复读的句子只留一处、截断处补完结尾：",
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
    // 审查只出报告；两种情况自动改一次：判定重复前文（换事重写）、一致性给出 S1 事实矛盾（定向修订）
    .addNode("review", async (state: ChapterStateType) => {
      if (!state.draftContent) {
        return { reviewResult: { ...reviewUnavailable(state.reviewMode, "没有生成章节内容"), consistent: false, issues: ["没有生成章节内容"] } };
      }
      const { result, inputBytes, usages, failures } = await runChapterReview(client, state.reviewMode, {
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
    // 审查说"没推进"时换一件事重写一次：把上一章再写一遍的稿子交给作者毫无价值
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
          repairRounds: state.repairRounds + 1,
          lintRounds: 0,
          phase: "repaired" as const,
          upstreamUsage: addUsage(state.upstreamUsage, response.usage),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emitter?.progress("review", 96, `重写失败，保留首版正文：${message}`);
        return { repairRounds: state.repairRounds + 1, errors: [`重写阶段失败：${message}`] };
      }
    })
    // 一致性审查给出带证据的 S1 事实矛盾时定点修订一次：只含这几条，其余保持原样
    .addNode("fixFacts", async (state: ChapterStateType) => {
      const review = state.reviewResult;
      const critical = (review?.findings || []).filter(item => item.severity === "S1" && item.evidence && (item.category === "consistency" || item.category === "factual" || item.category === "causal"));
      if (!state.draftContent || !critical.length) return {};
      emitter?.progress("review", 96, `正在按 ${critical.length} 条事实矛盾定点修订一次`);
      const instruction = [
        "按以下事实矛盾修订本章，逐条落到正文里；意见没点到的地方保持原样：",
        ...critical.map((item, index) => `${index + 1}. ${item.location ? `${item.location}：` : ""}${item.issue}${item.evidence ? `（原文：${item.evidence}）` : ""}${item.fix ? `。改法：${item.fix}` : ""}`),
      ].join("\n");
      const prompt = chapterRevisePrompt({ projectTitle: state.projectTitle, chapterTitle: state.chapterTitle, instruction, content: state.draftContent });
      try {
        const response = await client.chatStream([{ role: "user", content: prompt }], { temperature: 0.5, max_tokens: wholeChapterTokenBudget(state.draftContent), retryAttempts: 2 }, chunk => emitter?.chunk(chunk));
        const revised = parseRevisedDraft(response.content);
        if (!revised.content) return { fixRounds: state.fixRounds + 1, errors: ["事实矛盾定点修订没有返回正文，已保留原稿"] };
        return {
          draftContent: revised.content,
          authorNotes: [...state.authorNotes, ...revised.authorNotes],
          reviewResult: review ? { ...review, revised: true, suggestions: [...review.suggestions, `已按 ${critical.length} 条事实矛盾定点修订一次`] } : review,
          fixRounds: state.fixRounds + 1,
          lintRounds: 0,
          phase: "fixed" as const,
          upstreamUsage: addUsage(state.upstreamUsage, response.usage),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { fixRounds: state.fixRounds + 1, errors: [`事实矛盾定点修订失败：${message}`] };
      }
    })
    .addEdge("__start__", "prewrite")
    .addEdge("prewrite", "intent")
    .addEdge("intent", "retrieve")
    .addEdge("retrieve", "continuity")
    .addEdge("continuity", "plan")
    .addEdge("plan", "draft")
    .addEdge("draft", "gate")
    // 验证门之后：有 blocking 且还没改过 → 定向修订再过一遍门；改过或干净 → 首稿进审查，修订稿直接结束
    .addConditionalEdges("gate", (state: ChapterStateType) => {
      if (hasBlocking(state.lintFindings) && state.lintRounds === 0 && state.draftContent) return "fixLint";
      return state.phase === "draft" ? "review" : "done";
    }, { fixLint: "fixLint", review: "review", done: "__end__" })
    .addEdge("fixLint", "gate")
    .addConditionalEdges("review", (state: ChapterStateType) => {
      const review = state.reviewResult;
      if (!review) return "done";
      if ((review.advances === false || (review.repeatedEvents?.length || 0) > 0) && state.repairRounds === 0) return "repair";
      const hasCritical = review.findings.some(item => item.severity === "S1" && item.evidence && (item.category === "consistency" || item.category === "factual" || item.category === "causal"));
      if (hasCritical && state.fixRounds === 0) return "fixFacts";
      return "done";
    }, { repair: "repair", fixFacts: "fixFacts", done: "__end__" })
    // 重写稿与修订稿都再过一遍验证门（标点、句式），但不再进审查，避免审改循环
    .addEdge("repair", "gate")
    .addEdge("fixFacts", "gate");

  return graph.compile();
}
