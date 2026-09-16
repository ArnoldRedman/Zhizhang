import { compactText, masterOutlineBytes, storyLedgerBytes } from "../context/context-optimizer.js";

/**
 * 章节一致性审查
 * 提示词原本只长在写作图里，只有“正在写的新章”能被审到；批量审查旧章要的是同一份口径，
 * 所以搬到这里给两条路径共用（改一处两边都生效）
 */

export const chapterReviewSystemPrompt = `你是长篇小说一致性编辑。审查时只依据给出的约束、总纲位置、故事账本与章节正文，不做文风重写，也不虚构问题。

重点检查三件事。一是一致性：人物状态、已知信息、时间线、实体关系、物品归属和剧情因果。二是推进：本章相对故事账本里的前文是否推进了新的事件或节点，有没有把账本里已发生的事件重新写了一遍。三是位置与事件线：对照总纲里的“本章位置”和“本章节拍”，本章主体是否就是节拍定的那件事、是否走到了当前阶段应到的一步；位置说明本章是阶段最后一章而正文没有收束本阶段，或者本章主体仍停留在上一章的地点、同一时间段与同一件事的枝节里，advances 都记为 false。再对照账本近期几章：若本章主事件仍是同一条事件线（同一份文件、同一次签字或交涉、同一个物件、同一个悬案）的下一个枝节，而节拍或作者任务没有要求本章继续这条线，也记 advances=false，并在 repeatedEvents 里写明“仍在×××这条线上”。作者任务或章纲明确要求本章留在同一场景时不算停留。
返回严格 JSON 对象，不要代码围栏或解释：{"consistent":true,"issues":["明确矛盾"],"suggestions":["可执行修订建议"],"advances":true,"progress":"一句话说明本章把故事推进到了哪里","repeatedEvents":["与前文重复的事件"]}。没有明确问题时 issues、suggestions 和 repeatedEvents 返回空数组。`;

export interface ChapterReviewInput {
  /** 写作 Agent 的系统提示词：审查必须站在写这一章的同一个 Agent 口上，不能两边各说一套
   * （它长在写作图里，这里当参数传，避免审查模块反向依赖写作图） */
  agentSystemPrompt: string;
  worldSetting?: string;
  writingStyle?: { name: string; content: string };
  chapterBeat?: string;
  masterOutline?: string;
  storyLedger?: string;
  cards?: Array<{ type?: string; title: string; content: string }>;
  knowledgeGraph?: string;
  retrievedContext?: string[];
  /** 要审查的正文：新章传草稿，旧章传已存正文 */
  draftContent: string;
  sessionContext?: string;
  /** 被审章号与全书总章数：审的是历史章时，不能拿“全书最新进度”当它的时点 */
  chapterNumber?: number;
  totalChapters?: number;
}

export interface ChapterReviewResult {
  consistent: boolean;
  issues: string[];
  suggestions: string[];
  advances: boolean;
  progress: string;
  repeatedEvents: string[];
}

export interface ChapterReviewMessage {
  role: "system" | "user";
  content: string;
}

/** 审查请求本体：稳定资料（世界观/文风）+ 会话摘要 + 约束摘要与待审正文 + 审查口径 */
export function chapterReviewRequest(input: ChapterReviewInput): { messages: ChapterReviewMessage[]; inputBytes: number } {
  // 审历史章节时账本里的“现在”不是它的时点：实测第 131 章的审查把“账本标注第178章/第五卷”
  // 当成本章的时间线矛盾，还建议“把总纲卷次改回当前写作位”——那是要拿旧章去追新进度，改下去只会把正文改坏
  const historical = typeof input.chapterNumber === "number" && typeof input.totalChapters === "number" && input.chapterNumber < input.totalChapters;
  const worldSetting = historical ? stripLatestProgress(input.worldSetting) : input.worldSetting;
  const historyNote = historical
    ? `## 审查的是历史章节\n本章是第 ${input.chapterNumber} 章，全书已经写到第 ${input.totalChapters} 章。账本里的 current_timeline 与最新完成章描述的是现在，不是本章的时点；账本中与本章时点不符的行不算本章的问题，不要去建议改总纲或账本的进度标注，也不要拿后续章节的事实要求本章提前兑现。`
    : "";
  const stablePacket = [
    worldSetting ? `## 世界观与作品设定（作者确认的只读固定规则；只可引用，不得自动改写或推断变化）\n${worldSetting}` : "",
    input.writingStyle ? `## 绑定文风（作品固定约束）\n名称：${input.writingStyle.name}\n${input.writingStyle.content}` : "",
  ].filter(Boolean).join("\n\n");
  // 总纲与故事账本是“有没有推进、有没有停下”的唯一依据，审查阶段必须看到同一份
  const directionSection = [
    input.chapterBeat ? `## 本章节拍（阶段节拍表为本章定好的事件，本章主体必须就是它；不得把它写成上一章事件线的下一个枝节）\n${compactText(input.chapterBeat, 1200)}` : "",
    input.masterOutline ? `## 总纲（含结构骨架、“本章位置”、当前阶段与下一阶段；本章只走当前阶段里的一步，位置说明本章是阶段最后一章就必须在本章内收束本阶段；下一阶段与再后面的节点不得提前兑现）\n${compactText(input.masterOutline, masterOutlineBytes)}` : "",
    input.storyLedger ? `## 故事账本（前文已发生事件与未回收伏笔；已发生的事不得再写一遍，上一两章的未了事项只在开头收束）\n${compactText(input.storyLedger, storyLedgerBytes)}` : "",
  ].filter(Boolean).join("\n\n");
  const cardsSection = input.cards?.length
    ? `\n## 本章引用卡片状态\n${input.cards.map(card => `${card.title}：${compactText(card.content, 260)}`).join("\n")}`
    : "";
  const graphSection = input.knowledgeGraph ? `\n## 知识图谱约束\n${input.knowledgeGraph}\n` : "";
  const contextSection = input.retrievedContext?.length ? `\n## 已知背景信息\n${input.retrievedContext.join("\n\n")}\n` : "";
  const constraints = `${cardsSection}${graphSection}${directionSection ? `\n${directionSection}\n` : ""}${contextSection}`;
  const reviewPrompt = [historyNote, `## 约束摘要\n${constraints || "（暂无额外约束）"}\n\n## 待审查章节\n${compactText(input.draftContent, 10000)}`].filter(Boolean).join("\n\n");
  const session = splitSessionContext(input.sessionContext);
  const messages: ChapterReviewMessage[] = [
    { role: "system", content: input.agentSystemPrompt },
    { role: "user", content: `## 稳定作品资料\n${stablePacket || "（暂无稳定资料）"}` },
    ...(session.summary ? [{ role: "user" as const, content: session.summary }] : []),
    { role: "user", content: reviewPrompt },
    ...(session.recent ? [{ role: "user" as const, content: session.recent }] : []),
    { role: "user", content: chapterReviewSystemPrompt },
  ];
  return { messages, inputBytes: messages.reduce((sum, message) => sum + byteLengthOf(message.content), 0) };
}

/** 审查 JSON 归一化：模型偶尔带 Markdown 代码围栏或直接回自然语言，两种都要兜住 */
export function normalizeChapterReviewResult(value: unknown): ChapterReviewResult {
  const fallback: ChapterReviewResult = { consistent: true, issues: [], suggestions: [], advances: true, progress: "", repeatedEvents: [] };
  const text = String(value ?? "").trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { ...fallback, suggestions: ["无法解析审查结果"] };
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    return {
      consistent: parsed.consistent !== false,
      issues: stringItems(parsed.issues),
      suggestions: stringItems(parsed.suggestions),
      advances: parsed.advances !== false,
      progress: typeof parsed.progress === "string" ? parsed.progress.trim() : "",
      repeatedEvents: stringItems(parsed.repeatedEvents),
    };
  } catch {
    return { ...fallback, suggestions: ["无法解析审查结果"] };
  }
}

const stringItems = (value: unknown): string[] => (Array.isArray(value)
  ? value.map(item => String(item).trim()).filter(Boolean)
  : []);

/** 去掉描述“全书现在到哪了”的两行：审旧章时它们会把历史章节误判成错位 */
const stripLatestProgress = (value?: string): string | undefined => (typeof value === "string"
  ? value.split("\n").filter(line => !/^-\s*\*\*(current_timeline|latest_completed_chapter)\*\*/u.test(line.trim())).join("\n")
  : value);

const byteLengthOf = (value: string) => Buffer.byteLength(value, "utf8");

function splitSessionContext(value?: string): { summary: string; recent: string } {
  const context = compactText(value || "", 2200);
  if (!context) return { summary: "", recent: "" };
  const marker = "## 最近会话轮次";
  const index = context.indexOf(marker);
  if (index < 0) return { summary: context, recent: "" };
  return { summary: context.slice(0, index).trim(), recent: context.slice(index).trim() };
}
