import { z } from "zod";
import { ProjectAgentChangeSchema, ProjectAgentPlannerChangeSchema as plannerChangeSchema, type ProjectAgentCardRequest, type ProjectAgentCardUpsert, type ProjectAgentChange, type ProjectAgentChapterCreate, type ProjectAgentChapterRequest, type ProjectAgentChapterParts, type ProjectAgentChapterRetitleRequest, type ProjectAgentChapterReviseRequest, type ProjectAgentChapterSplitRequest, type ProjectAgentChapterTitles, type ProjectAgentChapterUpdate, type ProjectAgentOutlineRequest, type ProjectAgentOutlineUpsert } from "@zhizhang/contracts";
export { ProjectAgentChangeSchema };
export type { ProjectAgentCardRequest, ProjectAgentChange, ProjectAgentChapterRequest, ProjectAgentChapterRetitleRequest, ProjectAgentChapterReviseRequest, ProjectAgentChapterSplitRequest, ProjectAgentOutlineRequest } from "@zhizhang/contracts";
import { ModelApiClient } from "./models/model-api.js";
import { byteLength, compactText } from "./context/context-optimizer.js";
import { attachOutlineTarget, stageProjectChange, proposalKey } from "./application/project-working-copy.js";

// 四个委托口子都指向应用里已经存在的智能体
export interface ProjectAgentDelegates {
  chapter: (request: ProjectAgentChapterRequest) => Promise<ProjectAgentChapterCreate>;
  chapterRevise: (request: ProjectAgentChapterReviseRequest) => Promise<ProjectAgentChapterUpdate>;
  chapterTitles: (request: ProjectAgentChapterRetitleRequest) => Promise<ProjectAgentChapterTitles>;
  chapterSplit: (request: ProjectAgentChapterSplitRequest) => Promise<ProjectAgentChapterParts>;
  outline: (request: ProjectAgentOutlineRequest) => Promise<ProjectAgentOutlineUpsert>;
  card: (request: ProjectAgentCardRequest) => Promise<ProjectAgentCardUpsert>;
}

export interface ProjectAgentToolEvent {
  tool: string;
  status: "complete" | "error";
  message: string;
}

export interface ProjectAgentResult {
  message: string;
  changes: ProjectAgentChange[];
  toolEvents: ProjectAgentToolEvent[];
}

interface ProjectAgentInput {
  mode: "discuss" | "execute";
  instruction: string;
  project: Record<string, unknown>;
  history?: Array<{ role?: unknown; content?: unknown }>;
  activeChapterId?: unknown;
  contextWindowKTokens?: unknown;
  maxSteps?: unknown;
  /** 委派阶段的整轮墙钟预算，缺省用 DELEGATE_BUDGET_MS */
  delegateBudgetMs?: unknown;
  onStep?: (step: { kind: "search" | "open"; message: string }) => void;
  /** 将临时项目交给委派入口，下一项委派读取新版资料 */
  onStage?: (project: Record<string, unknown>) => void;
  /** 委派阶段的进度回调：批量修订是最慢的一段，没有它前端进度条会整段停住 */
  onDelegate?: (event: { done: number; total: number; label: string; status: "start" | "complete" | "error" }) => void;
}

interface ProjectDocument {
  kind: string;
  id: string;
  title: string;
  content: string;
  score: number;
  /** 章节的第几章序号，只有章节有；作者按序号说话，模型要靠它把“第 150 章”换成 id */
  ordinal?: number;
}

const objectList = (value: unknown): Array<Record<string, unknown>> => Array.isArray(value)
  ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
  : [];

const text = (value: unknown): string => typeof value === "string" ? value : "";

function queryTerms(value: string): string[] {
  const terms = value.toLocaleLowerCase().split(/[\s，。！？、；：,.!?;:()（）【】\[\]"“”'‘’]+/u)
    .map(item => item.trim()).filter(item => item.length >= 2);
  return Array.from(new Set(terms)).slice(0, 20);
}

// 原文只按本轮关键词截取短片段；续写时额外保留上一章结尾
function relevantExcerpt(content: string, terms: string[], tail = false): string {
  if (!content.trim()) return "";
  const lower = content.toLocaleLowerCase();
  const snippets: string[] = [];
  for (const term of terms) {
    let position = lower.indexOf(term);
    for (let count = 0; position >= 0 && count < 2; count += 1) {
      snippets.push(content.slice(Math.max(0, position - 180), Math.min(content.length, position + term.length + 360)).trim());
      position = lower.indexOf(term, position + term.length);
    }
    if (snippets.length >= 4) break;
  }
  if (snippets.length) return compactText(Array.from(new Set(snippets)).join("\n...\n"), 2200);
  if (tail) return compactText(content.slice(-5000), 2200);
  return compactText(content, 900);
}

/** 索引里一次直接列出的章节条数：长篇有几百章，整表铺开会把其他资料全挤掉 */
const INVENTORY_CHAPTER_HEAD = 40;
const INVENTORY_CHAPTER_TAIL = 60;

/**
 * 章节清单行
 * 同时保留目录位置、真实ID与原始标题，章号错乱时不能用位置替代标题章号
 * 章数过多时只列首尾，中间让模型用 list 动作按序号翻，而不是被 compactText 从中间无声截断。
 */
function chapterInventoryLine(chapters: Array<Record<string, unknown>>, activeChapterId: unknown): string {
  const rows = chapters.map((item, index) => {
    const title = text(item.title) || "无标题";
    const active = String(item.id) === String(activeChapterId) ? "[当前]" : "";
    return `#${index + 1}｜${String(item.id)}｜${title}${active}`;
  });
  if (rows.length <= INVENTORY_CHAPTER_HEAD + INVENTORY_CHAPTER_TAIL) return `章节（${rows.length}）：${rows.join("；")}`;
  const elided = rows.length - INVENTORY_CHAPTER_HEAD - INVENTORY_CHAPTER_TAIL;
  return [
    `章节（${rows.length}，条目格式为 #目录位置｜真实ID｜原始标题）：`,
    rows.slice(0, INVENTORY_CHAPTER_HEAD).join("；"),
    `；……中间 ${elided} 章未列出，需要时用 {"action":"list","kind":"章节","from":序号,"count":数量} 按序号翻；`,
    rows.slice(-INVENTORY_CHAPTER_TAIL).join("；"),
  ].join("");
}

function projectInventory(project: Record<string, unknown>, activeChapterId: unknown): string {
  const chapters = objectList(project.chapters);
  const outlines = objectList(project.outlines);
  const cards = objectList(project.cards);
  const memoryDocuments = objectList(project.memoryDocuments);
  const graphNodes = objectList(project.graphNodes);
  const graphEdges = objectList(project.graphEdges);
  return [
    `书名：${text(project.title) || "未命名小说"}`,
    `分类：${text(project.genre) || "未分类"}${project.subgenre ? ` / ${text(project.subgenre)}` : ""}`,
    `状态：${text(project.status) || "writing"}`,
    `主角：${[project.protagonist1, project.protagonist2].map(text).filter(Boolean).join("、") || "暂无"}`,
    `作品简介：${compactText(project.synopsis || "暂无", 1800)}`,
    `章节条目格式为 #目录位置｜真实ID｜原始标题。目录位置不等于标题章号；按标题确认作者所指章节，提交变更时使用真实ID。`,
    chapterInventoryLine(chapters, activeChapterId),
    `大纲（${outlines.length}）：${outlines.map(item => `${String(item.id)}=${text(item.kind)}｜${text(item.title)}`).join("；")}`,
    `卡片（${cards.length}）：${cards.map(item => `${String(item.id)}=${text(item.type)}｜${text(item.title)}`).join("；")}`,
    `记忆文档（${memoryDocuments.length}）：${memoryDocuments.map(item => `${String(item.id)}=${text(item.kind)}｜${text(item.title)}`).join("；")}`,
    `图谱节点（${graphNodes.length}）：${graphNodes.map(item => `${String(item.id)}=${text(item.type)}｜${text(item.label)}`).join("；")}`,
    `图谱关系（${graphEdges.length}）：${graphEdges.map(item => `${String(item.id)}:${String(item.source)}-[${text(item.label)}]->${String(item.target)}`).join("；")}`,
  ].join("\n");
}

export function buildProjectAgentContext(input: ProjectAgentInput): { packet: string; sources: string[] } {
  const { project, instruction } = input;
  const terms = queryTerms(instruction);
  const chapters = objectList(project.chapters);
  const outlines = objectList(project.outlines);
  const cards = objectList(project.cards);
  const memories = objectList(project.memories);
  const memoryDocuments = objectList(project.memoryDocuments);
  const graphNodes = objectList(project.graphNodes);
  const graphEdges = objectList(project.graphEdges);
  const domainBoost = {
    chapter: /章节|正文|下一章|续写|创作/u.test(instruction) ? 8 : 0,
    outline: /大纲|章纲|结构|剧情/u.test(instruction) ? 8 : 0,
    card: /卡片|人物|角色|物品|地点|势力/u.test(instruction) ? 8 : 0,
    memory: /记忆|伏笔|时间线|设定|冲突/u.test(instruction) ? 8 : 0,
    graph: /图谱|关系|实体/u.test(instruction) ? 8 : 0,
  };
  const score = (title: string, content: string, boost: number) => {
    const haystack = `${title}\n${content}`.toLocaleLowerCase();
    const lexical = terms.reduce((total, term) => total + (haystack.includes(term) ? 3 : 0), 0);
    return boost + lexical + (instruction.includes(title) && title.length >= 2 ? 12 : 0);
  };
  const documents: ProjectDocument[] = [
    ...chapters.map((item, index) => ({
      kind: "章节", id: String(item.id || index), title: text(item.title) || `第 ${index + 1} 章`,
      content: text(item.content),
      score: score(text(item.title), text(item.content), domainBoost.chapter) + (index >= chapters.length - 3 ? 5 : 0) + (String(item.id) === String(input.activeChapterId) ? 8 : 0),
    })),
    ...outlines.map((item, index) => ({
      kind: text(item.kind) || "大纲", id: String(item.id || index), title: text(item.title) || "未命名大纲", content: text(item.content),
      score: score(text(item.title), text(item.content), domainBoost.outline),
    })),
    ...cards.map((item, index) => ({
      kind: text(item.type) || "卡片", id: String(item.id || index), title: text(item.title) || "未命名卡片",
      content: `${text(item.content)}\n当前状态：${text(item.currentState) || "暂无"}`,
      score: score(text(item.title), `${text(item.content)} ${text(item.currentState)}`, domainBoost.card),
    })),
    ...memories.map((item, index) => ({
      kind: "章节记忆", id: String(item.id || index), title: text(item.chapterTitle) || "章节记忆", content: JSON.stringify(item),
      score: score(text(item.chapterTitle), JSON.stringify(item), domainBoost.memory),
    })),
    ...memoryDocuments.map((item, index) => ({
      kind: text(item.kind) || "记忆文档", id: String(item.id || index), title: text(item.title) || "记忆文档", content: text(item.content),
      score: score(text(item.title), text(item.content), domainBoost.memory),
    })),
    ...graphNodes.map((item, index) => ({
      kind: "图谱节点", id: String(item.id || index), title: text(item.label) || "图谱节点",
      content: `${text(item.category || item.type)}\n${text(item.status)}\n${text(item.content)}`,
      score: score(text(item.label), `${text(item.category)} ${text(item.status)} ${text(item.content)}`, domainBoost.graph),
    })),
  ].sort((left, right) => right.score - left.score);

  // 上下文包必须给后续检索轮次留出空间：它占死请求体后，每次 open 都会把总体推高
  const budget = Math.floor(projectRequestBudget(input.contextWindowKTokens) * 0.45);
  const inventory = projectInventory(project, input.activeChapterId);
  const sections: string[] = [`## 项目索引\n${compactText(inventory, Math.min(14_000, Math.floor(budget * 0.28)))}`];
  const sources: string[] = [];
  const overview = memories.map(memory => `### ${text(memory.chapterTitle)}\n${text(memory.summary)}`).join("\n\n");
  if (overview) sections.push(`## 全书章节摘要\n${compactText(overview, Math.floor(budget * 0.3))}`);
  let used = byteLength(sections.join("\n\n"));
  for (const document of documents) {
    if (document.kind === "章节记忆") continue;
    const remaining = budget - used;
    if (remaining < 500) break;
    const documentLimit = Math.max(4000, Math.floor(budget * 0.15));
    const content = compactText(document.content, Math.min(documentLimit, remaining - 160));
    if (!content) continue;
    const section = `## ${document.kind}｜${document.id}｜${document.title}\n${content}`;
    sections.push(section);
    sources.push(`${document.kind}｜${document.title}`);
    used += byteLength(section);
  }
  if (domainBoost.graph) {
    const graph = compactText(JSON.stringify({ nodes: graphNodes, edges: graphEdges }), Math.max(1000, Math.min(6000, budget - used)));
    if (graph) {
      sections.push(`## 知识图谱结构\n${graph}`);
      sources.push("知识图谱结构");
    }
  }
  return { packet: sections.join("\n\n"), sources };
}

/**
 * 一次 open 最多取几份资料
 * 逐份 open 会把步数预算烧在往返上：要读十章就得十轮，默认步数根本不够，
 * 表现就是“看了半天没看完，最后什么都没改”。批量取则一轮解决。
 */
const OPEN_BATCH_LIMIT = 20;
/** 批量 open 的总正文预算：单份上限仍按份数摊薄，避免十章正文把请求体顶爆 */
const OPEN_TOTAL_BUDGET = 26_000;
/** 一次 list 最多列多少条：只是目录行，列多了也只是浪费上下文 */
const LIST_PAGE_LIMIT = 60;

// Agent 每一轮只返回一个动作：继续检索、按序号翻目录、打开资料，或收尾给出回复与变更提案
// message 上限只是防失控：写大纲这类长回复会被模型写进 message，超长时截断保留而不是整轮拒绝
const agentTurnSchema = z.union([
  z.object({ action: z.literal("search"), query: z.string().min(1).max(200) }),
  // 按序号翻目录：长篇的章节表不可能整表进提示词，作者又常按“第几章”说话
  z.object({ action: z.literal("list"), kind: z.string().max(40).optional(), from: z.coerce.number().int().optional(), to: z.coerce.number().int().optional(), count: z.coerce.number().int().optional() }),
  // id 允许给数组：一次要读十章时逐章 open 会把步数预算耗光，最后什么都没做成
  z.object({ action: z.literal("open"), kind: z.string().max(40).optional(), id: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()])).min(1).max(OPEN_BATCH_LIMIT)]), offset: z.number().int().nonnegative().optional() }),
  z.object({ action: z.literal("edit"), changes: z.array(plannerChangeSchema).min(1).max(16) }),
  z.object({ action: z.literal("finish"), message: z.string().min(1).max(5000), changes: z.array(z.unknown()).max(16).default([]) }),
]);

type ProjectAgentTurn = z.infer<typeof agentTurnSchema>;

const changeTypeNames = new Set<string>([
  "project.update", "outline.upsert", "card.upsert", "memory.document.upsert",
  "graph.node.upsert", "graph.edge.upsert", "chapter.draft_next", "chapter.update", "chapter.create",
  "chapter.revise", "chapter.retitle", "chapter.split", "chapter.delete", "outline.delete", "text.replace",
]);

/**
 * 从可能被散文包裹/截断的模型回包里抠出 JSON 对象
 * max_tokens 截断会把末尾的 } 砍掉，有的模型还爱在 JSON 前后写一句“好的，以下是……”：
 * 先剥围栏和前后缀，再补齐括号；都不行才把整段当散文（返回 null），交给模型修复轮
 */
function extractJsonObject(value: string): Record<string, unknown> | null {
  const candidates: string[] = [];
  const stripped = value.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "").trim();
  candidates.push(stripped);
  // 前后缀散文：第一个 { 到最后一个 }
  const first = stripped.indexOf("{");
  const last = stripped.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(stripped.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as Record<string, unknown>;
    } catch {
      continue;
    }
  }
  // 补齐被截断的括号：从 { 到最后一个完整字符串后，逐层补 }
  if (first >= 0) {
    const tail = stripped.slice(first);
    for (let close = 1; close <= 8; close += 1) {
      try {
        return JSON.parse(`${tail}${"}".repeat(close)}`) as Record<string, unknown>;
      } catch {
        continue;
      }
    }
  }
  return null;
}

/** finish 的 message 超长时截断保留前半，别因为模型话多就把整轮丢掉 */
function clampFinishTurn(parsed: Record<string, unknown>): Record<string, unknown> | null {
  const action = typeof parsed.action === "string" ? parsed.action : "";
  const looksFinish = action === "finish"
    || (!action && (typeof parsed.message === "string" || changeTypeNames.has(String(parsed.type || ""))));
  if (!looksFinish) return null;
  const message = typeof parsed.message === "string" ? parsed.message : "";
  if (isDsmlOrToolCall(message) || isFormatRepairMetaComplaint(message)) throw new Error("回复包含未执行的工具标记或格式修复说明");
  const changes = Array.isArray(parsed.changes) ? parsed.changes : [];
  if (message.length <= 5000) {
    return { ...parsed, action: "finish", message: message || "已生成待确认变更。", changes };
  }
  return { ...parsed, action: "finish", message: `${message.slice(0, 4800)}\n\n（后文过长已截断，如需完整内容请说一次继续）`, changes };
}

/** 判定文本是否包含未解析的 DSML 或工具调用标记，避免将工具调用片段误当作散文答复 */
export function isDsmlOrToolCall(text: string): boolean {
  return /DSML|tool_calls?|<[｜|]{1,2}|<\/[｜|]{1,2}|invoke\s+name=|parameter\s+name=/iu.test(text);
}

/**
 * 识别 DeepSeek 等模型原生输出的 DSML (DeepSeek Markup Language) 工具调用标记
 * 并将其解析为标准的 ProjectAgentTurn 动作
 */
export function extractDsmlTurn(value: string): Record<string, unknown> | null {
  if (!/DSML/iu.test(value)) return null;

  // 提取 invoke 名称，兼容 <｜｜DSML｜｜ invoke name="open"> 与 <｜DSML｜invoke name="project.open"> 等变体
  const invokeMatch = /<[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*invoke\s+name=["']?([^"'>\s]+)["']?/iu.exec(value);
  let action = invokeMatch ? invokeMatch[1].trim().replace(/^project\./iu, "") : "";

  // 提取所有 parameter 参数
  const params: Record<string, unknown> = {};
  const paramRegex = /<[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*parameter\s+name=["']?([^"'>\s]+)["']?[^>]*>([\s\S]*?)<\/[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*parameter>/giu;
  let match: RegExpExecArray | null;
  while ((match = paramRegex.exec(value)) !== null) {
    const key = match[1].trim();
    const rawVal = match[2].trim();
    try {
      params[key] = JSON.parse(rawVal);
    } catch {
      params[key] = rawVal;
    }
  }

  // 缺少动作名或出现多个调用时不猜测意图，交给带上下文的格式恢复
  if (!action || (value.match(/invoke\s+name=/giu) || []).length !== 1) return null;

  if (action === "open") {
    const id = params.id ?? params.ids;
    if (!id) return null;
    return {
      action: "open",
      kind: typeof params.kind === "string" ? params.kind : undefined,
      id,
      ...(params.offset === undefined ? {} : { offset: Number(params.offset) }),
    };
  }

  if (action === "list") {
    return {
      action: "list",
      kind: typeof params.kind === "string" ? params.kind : undefined,
      from: params.from !== undefined ? Number(params.from) : undefined,
      to: params.to !== undefined ? Number(params.to) : undefined,
      count: params.count !== undefined ? Number(params.count) : undefined,
    };
  }

  if (action === "search") {
    const query = typeof params.query === "string" ? params.query : String(params.query ?? "");
    if (!query) return null;
    return { action: "search", query };
  }

  if (action === "finish") {
    return {
      action: "finish",
      message: typeof params.message === "string" ? params.message : "",
      changes: Array.isArray(params.changes) ? params.changes : [],
    };
  }

  return { action, ...params };
}

function parseAgentTurn(value: string): ProjectAgentTurn {
  const parsed = isDsmlOrToolCall(value) ? extractDsmlTurn(value) : extractJsonObject(value);
  if (!parsed) throw new Error("回包里找不到 JSON 对象或可执行动作");
  // 先把超长 finish 归一成合法形状，长大纲回复就不会在 zod 校验时被整轮拒绝
  const clamped = clampFinishTurn(parsed);
  const source = clamped ?? parsed;
  const action = typeof source.action === "string" ? source.action : "";
  // 模型经常把变更的 type 直接填进 action，或者干脆只回一个变更对象；都归一成“带一条变更的收尾”
  if (changeTypeNames.has(action) || (!action && changeTypeNames.has(String(source.type || "")))) {
    const { action: _discarded, ...rest } = source;
    const change = { ...rest, type: changeTypeNames.has(action) ? action : source.type };
    return agentTurnSchema.parse({
      action: "finish",
      message: typeof source.summary === "string" && source.summary ? source.summary : "已生成待确认变更。",
      changes: [change],
    });
  }
  // 兼容只回 {message, changes} 的旧格式
  if (!action && typeof source.message === "string") {
    return agentTurnSchema.parse({ action: "finish", message: source.message, changes: source.changes ?? [] });
  }
  return agentTurnSchema.parse(source);
}

/** 识别模型修复轮里对“请把以下内容整理成约定的 JSON 动作”提示词本身的元抱怨，防止其作为正式回复呈现给作者 */
export function isFormatRepairMetaComplaint(text: string): boolean {
  return /只调整格式|待整理的内容|没有收到需要转换的原文|以下内容.*是空的|看不到任何需要转换|没有跟着任何待整理/u.test(text);
}

// 全量文档表：search 只回标题和片段，正文通过 open 分段读取
function projectDocuments(project: Record<string, unknown>): ProjectDocument[] {
  const entry = (kind: string, id: unknown, title: string, content: string, ordinal?: number): ProjectDocument =>
    ({ kind, id: String(id ?? ""), title: title || "未命名", content, score: 0, ordinal });
  return [
    ...objectList(project.chapters).map((item, index) => entry("章节", item.id ?? index, text(item.title) || `第 ${index + 1} 章`, text(item.content), index + 1)),
    ...objectList(project.outlines).map((item, index) => entry(text(item.kind) || "大纲", item.id ?? index, text(item.title), text(item.content))),
    ...objectList(project.cards).map((item, index) => entry(text(item.type) || "卡片", item.id ?? index, text(item.title), `${text(item.content)}\n当前状态：${text(item.currentState) || "暂无"}`)),
    ...objectList(project.memories).map((item, index) => entry("章节记忆", item.id ?? index, text(item.chapterTitle) || "章节记忆", JSON.stringify(item))),
    ...objectList(project.memoryDocuments).map((item, index) => entry(text(item.kind) || "记忆文档", item.id ?? index, text(item.title), text(item.content))),
    ...objectList(project.graphNodes).map((item, index) => entry("图谱节点", item.id ?? index, text(item.label), `${text(item.category || item.type)}\n${text(item.status)}\n${text(item.content)}`)),
  ];
}

function runSearch(documents: ProjectDocument[], query: string): string {
  const terms = queryTerms(query);
  const hits = documents
    .map(document => {
      const haystack = `${document.title}\n${document.content}`.toLocaleLowerCase();
      const lexical = terms.reduce((total, term) => total + (haystack.includes(term) ? 3 : 0), 0);
      return { document, score: lexical + (query.includes(document.title) && document.title.length >= 2 ? 12 : 0) };
    })
    .filter(hit => hit.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 8);
  if (!hits.length) return `没有命中「${query}」。可以换个关键词，或直接用项目索引里的 id 打开资料。`;
  return hits.map(({ document }) => `- ${document.kind}｜${document.id}｜${document.title}\n  ${compactText(relevantExcerpt(document.content, terms), 400)}`).join("\n");
}

function findDocument(documents: ProjectDocument[], kind: string | undefined, id: string): ProjectDocument | undefined {
  const wanted = String(id).trim();
  // 模型偶尔把序号当 id 交上来：#150 这种写法直接按章节序号查，比报错让它重试一轮划算
  const ordinal = /^#\d+$/u.test(wanted) ? Number(wanted.slice(1)) : 0;
  if (ordinal > 0) {
    const byOrdinal = documents.find(item => item.ordinal === ordinal);
    if (byOrdinal) return byOrdinal;
  }
  return documents.find(item => item.id === wanted && (!kind || item.kind === kind))
    || documents.find(item => item.id === wanted)
    || documents.find(item => item.title === wanted);
}

/**
 * 按预算连续读取正文，支持批量；长文返回续读游标，不能静默省略中间剧情
 */
function runOpen(documents: ProjectDocument[], kind: string | undefined, ids: string[], offset = 0, totalBudget = OPEN_TOTAL_BUDGET): string {
  const wanted = ids.slice(0, OPEN_BATCH_LIMIT);
  const perDocument = Math.max(1200, Math.floor(totalBudget / Math.max(1, wanted.length)));
  const sections = wanted.map(id => {
    const document = findDocument(documents, kind, id);
    if (!document) return `## 未找到 ${kind ? `${kind}｜` : ""}${id}\n请对照项目索引里的 id 重试。`;
    const head = `## ${document.kind}｜${document.id}｜${document.ordinal ? `目录位置 #${document.ordinal}｜` : ""}标题：${document.title}`;
    // 按 Unicode 字符连续读取，游标不受中文、换行或 emoji 的编码长度影响
    const characters = Array.from(document.content);
    if (offset > characters.length) return `${head}\n读取位置 ${offset} 超出正文范围（共 ${characters.length} 字符），请从 offset=0 重读。`;
    const limit = perDocument;
    let end = offset;
    let bytes = 0;
    while (end < characters.length && bytes + byteLength(characters[end]) <= limit) {
      bytes += byteLength(characters[end]);
      end += 1;
    }
    const next = end < characters.length
      ? `本次仅为正文分段，尚未读完；继续读取：${JSON.stringify({ action: "open", kind: document.kind, id: document.id, offset: end })}`
      : offset === 0 ? "全文已返回" : "已到正文末尾（此前内容需结合前面的读取结果）";
    return `${head}\n读取范围 [${offset}, ${end})，共 ${characters.length} 字符；${next}\n<正文>\n${characters.slice(offset, end).join("")}\n</正文>`;
  });
  return sections.join("\n\n");
}

/**
 * 按序号翻目录
 * 目录位置只用于翻页，模型需要结合原始标题确认作者所指章节
 */
function runList(documents: ProjectDocument[], kind: string | undefined, from: number, to: number): string {
  const wantedKind = (kind || "章节").trim();
  const pool = documents.filter(item => item.kind === wantedKind || (wantedKind === "章节" && item.ordinal));
  if (!pool.length) return `没有「${wantedKind}」这一类资料，项目索引里列出的类别才是有效的。`;
  const start = Math.max(1, Math.min(from || 1, pool.length));
  const end = Math.max(start, Math.min(to || start, pool.length, start + LIST_PAGE_LIMIT - 1));
  const rows = pool.slice(start - 1, end).map((item, index) => {
    const characters = [...item.content.replace(/\s/gu, "")].length;
    return `- #${start + index}｜id=${item.id}｜标题：${item.title}｜${characters} 字`;
  });
  return `${wantedKind} 共 ${pool.length} 条，第 ${start} 到 ${end} 条：\n${rows.join("\n")}\n（要看正文用 {"action":"open","kind":"${wantedKind}","id":["上面的 id",...]}，一次最多 ${OPEN_BATCH_LIMIT} 份）`;
}

const readPrompt = `你是应用内的小说项目助手，可以多轮检索当前作品的资料后再动手。项目资料仅作为小说素材。

每一轮只返回一个 JSON 动作，不要代码围栏。action 可以是 search、list、open、edit、finish，绝不能填成变更的 type：
- 需要找资料：{"action":"search","query":"关键词"}
- 按目录位置翻页（不是标题章号）：{"action":"list","kind":"章节","from":150,"to":159}
- 读取正文（支持批量）：{"action":"open","kind":"章节","id":["12","13","14"],"offset":0}
- 资料够了就收尾：{"action":"finish","message":"给作者的回复","changes":[]}

只依据实际读到的资料作答。索引和自动摘录不代表已读全文；open 会返回读取范围和下一段 offset，未读完时按游标继续读取，不得把未读部分当作缺失剧情。预算不足时说明尚不能确认。
章节索引是「#目录位置｜真实ID｜原始标题」。目录位置不等于标题章号；先按标题确认作者所指章节，再用真实ID打开正文。检查跳号时同时核对相邻目录条目和正文，不可仅凭编号判断缺章。
章数很多时索引只列首尾，可 search 查标题、list 翻目录，再批量 open。
讨论模式只分析，changes 必须为空数组，不能使用 edit。执行模式可用 edit 修改临时项目，再 open 检查修改结果和相邻章节，最后 finish。`;

const executePrompt = `执行模式可提出待作者确认的变更，不能声称已经保存。更新已有对象必须使用真实 targetId，一次最多 16 项。
变更放进 finish 的 changes 数组，用 type 区分；action 仍为 finish。
以下为可用操作，字段必须原样铺平，不要自己包一层 data：
{"type":"project.update","summary":"修改简介","patch":{"synopsis":"..."}}
{"type":"outline.write","summary":"重写总纲","targetId":1,"kind":"总纲","title":"...","instruction":"要改成什么样"}
{"type":"card.write","summary":"更新角色卡","targetId":2,"cardType":"角色卡","title":"林舟","instruction":"要补充或修正什么"}
{"type":"memory.document.upsert","summary":"整理时间线","kind":"时间线","title":"时间线","content":"..."}
{"type":"graph.node.upsert","summary":"新增节点","targetId":"entity:林舟","label":"林舟","nodeType":"entity","category":"人物","content":"...","nodeStatus":"..."}
{"type":"graph.edge.upsert","summary":"补充关系","targetId":"entity:林舟->entity:沈砚:同盟","source":"entity:林舟","target":"entity:沈砚","label":"同盟","weight":0.8}
{"type":"chapter.draft_next","summary":"起草下一章","title":"第 12 章 夜访","instruction":"承接上一章并推进线索","outlineId":3}
{"type":"chapter.revise","summary":"修订第 8 章","targetId":8,"instruction":"去掉 AI 味，保留情节和人物口吻","mode":"de-ai"}
{"type":"chapter.retitle","summary":"批量补标题","targetIds":[],"scope":"missing","renumber":false,"instruction":"标题贴合本章事件"}
{"type":"chapter.split","summary":"把超长章拆开","targetIds":[150,151],"targetWords":2000,"targetParts":6,"instruction":"新段落标题贴合该段事件"}
{"type":"chapter.delete","summary":"删除空稿章节","targetId":9,"title":"第 9 章"}
{"type":"outline.delete","summary":"删除重复章纲","targetId":12,"title":"章纲｜第 208 章"}

你可以直接写章节、大纲和卡片，也可以用上述委派动作生成长文。直接修改用以下形状：
{"type":"chapter.update","summary":"修复前后衔接","targetId":8,"content":"修改后的完整正文"}
{"type":"chapter.create","summary":"续写下一章","title":"第 12 章 夜访","content":"完整正文"}
{"type":"outline.upsert","summary":"同步总纲","targetId":1,"kind":"总纲","title":"总纲","content":"完整内容"}
{"type":"text.replace","summary":"只改章纲里的返程时间","target":"outline","targetId":12,"replacements":[{"find":"清早返江城","replace":"傍晚返江城"}]}
{"type":"text.replace","summary":"只改正文里的一句","target":"chapter","targetId":8,"replacements":[{"find":"她没有说话。","replace":"她说，明天再打。"}]}
{"type":"card.upsert","summary":"更新人物资料","targetId":2,"cardType":"角色卡","title":"林舟","content":"完整内容"}
执行时优先返回 {"action":"edit","changes":[直接修改对象或委派对象]}，修改仅进入临时项目，不会保存到作者文件。
之后继续 open/search 读取更新后的版本，检查衔接，需要时修改其他章节和资料，最后 finish 汇总。
已经 edit 的变更自动保留，不用在 finish 重复抄写。chapter.delete、outline.delete、chapter.parts、chapter.titles 留到 finish。
修改范围由作者任务和实际影响决定，不限当前章；后文是待核对的旧稿，出现矛盾时可以联动修订。
委派生成按提案顺序进行，后一步可以看到前一步的新稿；在 instruction 里写清关联改动和预期结果。

作者只要求改某一段、某几句或大纲里的一处节奏时，用 text.replace，不要整篇重写。find 必须是 open 读到的连续原文，且在目标里只出现一次；replace 只写改后的这一段。其余文字由应用原样保留。整章重写、整份章纲重写仍用 chapter.revise 或 outline.upsert。

新建章纲时 title 必须写成“章纲｜第 N 章”（要规划第 189 章就写“章纲｜第 189 章”）：应用只从标题里的章号得到目标章、
上一章正文与上一章章纲格式，标题没写章号就不会带上这些依据，大纲智能体不知道自己在写第几章；已经有章纲的章改它那份，不要另建一份。

章节修订的三种口径，用 mode 区分，选错作者就得重来一遍：
- mode 填 "polish" 只改文字表达，不动情节和结构，作者说“润色”“改改文字”“读起来别扭”时用它。
- mode 填 "de-ai" 专门拆掉机械感和模板腔，作者说“太像 AI 写的”“去 AI 味”时用它。
- mode 填 "revise" 可以改情节和结构，作者明确要求改剧情、补细节、调整设定时才用它；缺省就是 revise。

批量补标题用 chapter.retitle，不要一章一条 chapter.revise：
- 作者说“把缺标题的章节补上”时，targetIds 留空数组、scope 填 "missing"，应用会自己挑出还是占位标题的章节，你不用先把它们一个个列出来。
- 只补指定章节时才填 targetIds（真实 id，不是序号）；作者明确要求连已有标题一起重拟时才把 scope 填 "all"。
- 一条 chapter.retitle 就能覆盖几百章，应用会分批调用模型并合成一条待确认变更，所以不要拆成多条。
- 作者要“重排章号”“按新位置重新编号”“把新插的章编进去”时把 renumber 填 true：应用会按各章在目录里的当前位置重编章号，
  数字格式（中文还是阿拉伯、有没有空格）自动跟前文保持一致，模型只需要给名字。不要在 instruction 里让模型自己写“第一百五十一章”这种章号——章号一律由应用生成。
- 只重排章号、名字不动时也用 renumber，scope 填 "all"，instruction 写“保留原有标题名字”。

章节修订和删除的额外约束：
- chapter.revise 和 chapter.delete 的 targetId 必须是项目索引里真实存在的章节 id，不是第几章的序号。
- 修订前先 open 该章正文，确认真的需要改，不要凭标题猜。
- chapter.revise 会生成整章新稿，按依赖顺序提交；后续修订可读取本轮已生成的新稿。
- 删除是不可恢复操作：只有作者明确要求删除时才能提，不要自作主张清理你觉得多余的章节。
- outline.delete 只删章纲。targetId 是章纲自己的 id，不是章节 id。总纲、世界观和阶段节拍不要删。同一章已有章纲时用 outline.upsert 覆盖，不要删了再新建。

一章太长要拆成几章时用 chapter.split，不要自己写正文：
- 填 targetIds（真实 id）和 targetWords（每章目标字数，作者说“两千多字”就填 2400）。
- 作者直接说了拆成几章（“这两章拆成 6 章”）时另外填 targetParts：它是本条所有 targetIds 拆完之后的总章数，
  必须大于 targetIds 的个数，不是每章各拆几章；“两章拆成 6 章”就填 6，不是 3。
  应用会按各章字数把名额分下去，并保证每段字数尽量相等；给了 targetParts 就不再看 targetWords，
  这意味着不算超长的章也会被拆，所以只在作者真的报了章数时才填；作者只说“拆短一点”就只填 targetWords。
- 应用会按段落边界就地切开，正文一个字都不改写，也不需要你把正文贴进 changes；新段落的标题由应用命名。
- 一条 chapter.split 就能拆多章，不要一章一条，更不要用 chapter.update 加 chapter.create 手工拆——那样要贴几万字正文，必然超长失败。
- 拆分只在段落边界上进行；某章整章没有分段、或段落数不够切到要的章数时，应用会跳过它并如实说明。

失败重试：历史里出现「[本轮未完成] …失败（…｜目标 N）」时，说明那一项没做成，其余的已经生成了提案。
作者说“再试一次”“重来一次”时，只针对失败的那一项重新提同一条变更即可，不要重提已经成功的部分，也不要说自己做不到——
chapter.revise、chapter.retitle、chapter.split 都只需要 targetId 和 instruction，正文由应用自己从项目里读取，
你并不需要先把该章正文 open 进上下文才能重试（想确认改动方向时才需要 open）。`;

type AgentMessage = { role: "system" | "user" | "assistant"; content: string };

/** 把一轮检索动作跑成工具结果，附带给作者看的一句话说明 */
function runTurnTool(documents: ProjectDocument[], turn: Exclude<ProjectAgentTurn, { action: "finish" | "edit" }>, openBudget = OPEN_TOTAL_BUDGET): { label: string; result: string } {
  if (turn.action === "search") {
    return { label: `检索「${turn.query}」`, result: runSearch(documents, turn.query) };
  }
  if (turn.action === "list") {
    const kind = turn.kind || "章节";
    const from = turn.from || 1;
    const to = turn.to ?? (from + Math.max(1, turn.count ?? 1) - 1);
    return { label: `翻阅${kind}第 ${from} 到 ${to} 条`, result: runList(documents, turn.kind, from, to) };
  }
  const ids = (Array.isArray(turn.id) ? turn.id : [turn.id]).map(item => String(item));
  const label = ids.length > 1
    ? `打开 ${turn.kind ? `${turn.kind}｜` : ""}${ids.length} 份资料（${ids.slice(0, 3).join("、")}${ids.length > 3 ? "…" : ""}）`
    : `打开 ${turn.kind ? `${turn.kind}｜` : ""}${ids[0]}`;
  return { label, result: runOpen(documents, turn.kind, ids, turn.offset, openBudget) };
}

/**
 * 单次请求体上限
 * 每轮检索都往 messages 里追加一次动作和一段工具结果，这个数组只增不减：
 * 前几轮请求体很小，最后几轮能撑到 60 KB 以上，表现就是“做到一半突然失败”。
 * 无论上游阈值是多少，请求体无上限增长本身就是 bug。
 * ponytail: 固定上限并从中间丢旧工具结果；若以后需要更长的检索链，再改为按轮次摘要压缩
 */
// 为预算结束提示和一次格式恢复预留空间
const REQUEST_BODY_LIMIT = 37_000;

/**
 * 单轮请求体。窗口大也不跟着放大：腾讯云这条线路 TPM 是 100 万 token/分钟，
 * 1M 窗口按 1.5 字节/token 会变成约 150 万字节，一轮加上立刻重试就超限。
 * 汉字约 1.5 token/字、3 字节/字，18 万字节约 9 万 token，同一分钟还能再读几轮。
 */
const PROJECT_TURN_BYTES = 180_000;
const projectRequestBudget = (window: unknown): number => {
  const byWindow = Math.floor((Number(window) || 128) * 1024 * 1.5);
  return Math.max(REQUEST_BODY_LIMIT, Math.min(byWindow, PROJECT_TURN_BYTES));
};

/**
 * 委派阶段的整轮墙钟预算
 * 每个委派内部的 fetch 各自有超时（最长 300 秒 × 重试），但一轮 changes 最多 16 项，
 * 串行跑下来仍可能几十分钟不返回，前端只看到项目 Agent 一直转。
 * 超预算后剩余委派如实报出来，让作者再说一次继续。
 * ponytail: 基础值 + 每项固定额度，需要按模型实际速度自适应时再做成设置项
 */
const DELEGATE_BUDGET_MS = 20 * 60_000;

/**
 * 每项委派的额外预算
 * 一次修订要跑完整的正文重写，单章 5 分钟以上很常见，重试多时能到 15 分钟；
 * 固定 20 分钟撑不满单轮 10 章的修订上限，批量改到第 4~5 章就会撞满预算整轮断掉。
 * 预算必须跟着委派数量扩展：10 章修订就是 200 分钟，小任务仍是 20 分钟兑底。
 */
const PER_DELEGATE_BUDGET_MS = 20 * 60_000;

/**
 * 委派失败时补一句能照着做的话
 * 上游报的是“无法连接 API 中转服务”这类原始信息，作者看到只会以为整个功能坏了；
 * 必须分清是网络、限流、额度还是格式抖动，并说清剩下的变更没受影响。
 */
function delegateFailureHint(message: string): string {
  if (/429|rate limit|too many requests|限流|请求过于频繁/iu.test(message)) return "上游在限流：等一两分钟再说一次继续，或把每轮章数减到 3 章以内";
  if (/401|403|余额|quota|欠费|无权限/iu.test(message)) return "Key 权限或额度有问题：先到设置里测试这个模型配置";
  if (/无法连接|timeout|timed out|超时|ECONN|ETIMEDOUT|socket|fetch failed|network/iu.test(message)) return "网络或中转服务不通：检查设置里的中转地址与代理，然后说一次继续";
  if (/JSON|Unexpected token|格式/iu.test(message)) return "模型这次没按约定格式返回：只针对这一项再说一次通常就好";
  return "这一项没有改动，其余变更不受影响，可以只针对它再说一次";
}

/** 失败提示里要能看出是哪一章：一次批量修订报五条“API 有问题”，作者根本不知道该重跑哪几章 */
function changeIdentity(change: { type: string; summary: string; targetId?: number | string }): string {
  const target = change.targetId === undefined || change.targetId === "" ? "" : `｜目标 ${String(change.targetId)}`;
  return `${change.summary}${target}`;
}

function boundedMessages(system: AgentMessage, request: AgentMessage, context: string, history: AgentMessage[], turns: AgentMessage[], requestLimit = REQUEST_BODY_LIMIT): AgentMessage[] {
  const size = (list: AgentMessage[]) => list.reduce((sum, message) => sum + byteLength(message.content), 0);
  // 本轮问题与最新工具结果必须完整保留，旧历史和自动摘录让出预算
  const latest = turns.slice(-2);
  const required = [system, request, ...latest];
  if (size(required) > requestLimit) throw new Error("本轮问题与最新读取结果超过上下文预算，请缩小单次读取范围");
  let budget = requestLimit - size(required) - 300;
  const packet = compactText(context, Math.min(Math.floor(requestLimit * 0.35), budget));
  budget -= byteLength(packet);
  const keepRecent = (items: AgentMessage[]): AgentMessage[] => {
    const kept: AgentMessage[] = [];
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const bytes = byteLength(items[index].content);
      if (bytes > budget) break;
      kept.unshift(items[index]);
      budget -= bytes;
    }
    return kept;
  };
  // 旧工具结果按动作与结果成对保留，避免裁出孤立的工具指令
  const older: AgentMessage[] = [];
  for (let index = turns.length - 4; index >= 0; index -= 2) {
    const pair = turns.slice(index, index + 2);
    const bytes = size(pair);
    if (bytes > budget) break;
    older.unshift(...pair);
    budget -= bytes;
  }
  const keptHistory = keepRecent(history);
  const dropped = history.length + turns.length - keptHistory.length - older.length - latest.length;
  const notice: AgentMessage[] = dropped > 0 ? [{ role: "user", content: `已省略较早的 ${dropped} 条历史或检索消息；需要其原文时请重新读取，不能声称仍掌握全部内容。` }] : [];
  return [system, ...keptHistory, ...(packet ? [{ role: "user" as const, content: packet }] : []), request, ...notice, ...older, ...latest];
}

export async function runProjectAgent(
  input: ProjectAgentInput,
  client: ModelApiClient,
  delegates: ProjectAgentDelegates,
): Promise<ProjectAgentResult> {
  input = { ...input, project: structuredClone(input.project) };
  const context = buildProjectAgentContext(input);
  let documents = projectDocuments(input.project);
  const staged: ProjectAgentChange[] = [];
  const createdTargets = new Map<string, number>();
  const stage = (change: ProjectAgentChange) => {
    const normalized = attachOutlineTarget(input.project, change);
    const creating = normalized.type === "outline.upsert" && normalized.targetId === undefined;
    stageProjectChange(input.project, normalized);
    input.onStage?.(input.project);
    const key = proposalKey(normalized);
    const createdIndex = key ? createdTargets.get(key) : undefined;
    const previous = createdIndex ?? (key ? staged.findIndex(item => proposalKey(item) === key) : -1);
    if (previous >= 0) {
      const old = staged[previous];
      staged[previous] = createdIndex !== undefined
        ? ProjectAgentChangeSchema.parse({ ...old, ...normalized, type: old.type, targetId: undefined })
        : old.type === "project.update" && normalized.type === "project.update"
          ? { ...normalized, patch: { ...old.patch, ...normalized.patch } }
          : old.type === "text.replace" && normalized.type === "text.replace"
            ? { ...normalized, replacements: [...old.replacements, ...normalized.replacements] }
            : normalized;
    } else {
      staged.push(normalized);
      if (creating && key) createdTargets.set(key, staged.length - 1);
      const collection = normalized.type === "chapter.create" ? "chapters" : normalized.type === "card.upsert" && !normalized.targetId ? "cards" : undefined;
      if (collection) {
        const id = objectList(input.project[collection]).at(-1)?.id;
        const updateType = change.type === "chapter.create" ? "chapter.update" : change.type;
        createdTargets.set(`${updateType}:${String(id)}`, staged.length - 1);
      }
    }
    documents = projectDocuments(input.project);
  };
  const requestLimit = projectRequestBudget(input.contextWindowKTokens);
  const produce = async (change: z.infer<typeof plannerChangeSchema>): Promise<ProjectAgentChange> => {
    switch (change.type) {
      case "chapter.draft_next": return delegates.chapter(change);
      case "chapter.revise": return delegates.chapterRevise(change);
      case "chapter.retitle": return delegates.chapterTitles(change);
      case "chapter.split": return delegates.chapterSplit(change);
      case "outline.write": return delegates.outline(change);
      case "card.write": return delegates.card(change);
      default: return ProjectAgentChangeSchema.parse(change);
    }
  };
  const history = (input.history || []).slice(-10).flatMap(message => {
    const role: "user" | "assistant" | null = message.role === "assistant" ? "assistant" : message.role === "user" ? "user" : null;
    const content = compactText(message.content || "", 4000);
    return role && content ? [{ role, content }] : [];
  });
  const toolEvents: ProjectAgentToolEvent[] = [{
    tool: "project.context",
    status: "complete",
    message: `已载入项目索引与 ${context.sources.length} 份资料摘录`,
  }];

  const system: AgentMessage = { role: "system", content: input.mode === "execute" ? `${readPrompt}

${executePrompt}` : readPrompt };
  const request: AgentMessage = { role: "user", content: `模式：${input.mode === "execute" ? "执行" : "讨论"}

## 本轮请求
${input.instruction}` };
  const messages: AgentMessage[] = [];

  // 给阅读、修改和复查留下多轮空间；达到上限时保留已完成提案并如实说明
  const maxSteps = Math.max(1, Math.min(128, Number(input.maxSteps) || 48));
  const toolOutputBudget = requestLimit * 4;
  let toolOutputUsed = 0;
  let plan: Extract<ProjectAgentTurn, { action: "finish" }> | null = null;

  for (let step = 0; step < maxSteps && !plan; step += 1) {
    const mustFinish = step === maxSteps - 1 || toolOutputUsed >= toolOutputBudget;
    const turnMessages = mustFinish
      ? [...boundedMessages(system, request, `## 项目索引与资料摘录
${context.packet}`, history, messages, requestLimit), { role: "user" as const, content: "检索预算已用尽，请直接返回 finish 动作。" }]
      : boundedMessages(system, request, `## 项目索引与资料摘录
${context.packet}`, history, messages, requestLimit);
    const response = await client.chat(turnMessages, { response_format: { type: "json_object" }, temperature: 0.2, max_tokens: 12_000, retryAttempts: 2 });

    let turn: ProjectAgentTurn;
    try {
      turn = parseAgentTurn(response.content);
    } catch {
      const rawProse = response.content.trim().replace(/^```(?:json|markdown|text)?\s*/iu, "").replace(/\s*```$/u, "").trim();
      if (input.mode === "discuss" && rawProse.length >= 40 && !/^[{\[]/u.test(rawProse) && !rawProse.includes('"action"') && !isDsmlOrToolCall(rawProse) && !isFormatRepairMetaComplaint(rawProse)) {
        turn = { action: "finish", message: compactText(rawProse, 4800), changes: [] };
      } else {
        // 唯一的格式恢复轮保留原任务与已读资料，不把残缺指令当作分析结论
        try {
          const repaired = await client.chat([
            ...turnMessages,
            { role: "user", content: `上一轮未返回有效动作。请依据本轮请求和已读资料返回一个合法 JSON 动作；资料不足可继续检索。待修复输出：
${compactText(rawProse, 2000) || "（空）"}` },
          ], { response_format: { type: "json_object" }, temperature: 0, max_tokens: 12_000, retryAttempts: 1 });
          turn = parseAgentTurn(repaired.content);
        } catch {
          toolEvents.push({ tool: "project.format", status: "error", message: "工具指令解析失败，格式恢复未成功" });
          return { message: staged.length ? "本轮工具指令解析失败；已完成的临时稿保留供预览，后续任务尚未完成。" : "本轮工具指令解析失败，未能完成分析，也未生成变更。请重试。", changes: staged, toolEvents };
        }
      }
    }


    if (turn.action === "finish") {
      plan = turn;
      break;
    }

    if (turn.action === "edit") {
      const results: string[] = [];
      for (const change of turn.changes) {
        try {
          if (input.mode !== "execute") throw new Error("讨论模式不能修改项目");
          if (["chapter.delete", "outline.delete", "chapter.parts", "chapter.titles"].includes(change.type)) throw new Error("此变更请放在 finish 中交给作者确认");
          input.onDelegate?.({ done: 0, total: turn.changes.length, label: change.summary, status: "start" });
          const produced = ProjectAgentChangeSchema.parse(await produce(change));
          stage(produced);
          input.onDelegate?.({ done: 1, total: turn.changes.length, label: change.summary, status: "complete" });
          results.push(`已更新临时稿：${change.summary}`);
          toolEvents.push({ tool: "project.edit", status: "complete", message: change.summary });
        } catch (error) {
          results.push(`修改失败：${error instanceof Error ? error.message : String(error)}`);
          toolEvents.push({ tool: "project.edit", status: "error", message: results.at(-1)! });
        }
      }
      messages.push({ role: "assistant", content: JSON.stringify({ action: "edit", summaries: turn.changes.map(change => change.summary) }) });
      messages.push({ role: "user", content: `${results.join("\n")}\n可 open 查看新稿并继续关联修订；尚未保存，finish 后由作者应用。` });
      continue;
    }
    const { label, result } = runTurnTool(documents, turn, Math.floor(requestLimit * 0.2));
    toolOutputUsed += byteLength(result);
    toolEvents.push({ tool: `project.${turn.action}`, status: "complete", message: label });
    input.onStep?.({ kind: turn.action === "search" ? "search" : "open", message: label });
    messages.push({ role: "assistant", content: JSON.stringify(turn) });
    messages.push({
      role: "user",
      content: `工具结果（${label}）：\n${result}\n\n（若根据上述资料已足够解答作者请求，请直接返回 {"action":"finish","message":"你的详细分析与回复","changes":[]} 收尾；若还需其他资料，可继续使用 search/list/open）`,
    });
  }

  if (!plan) return { message: "本轮达到步数上限，已保留完成的临时稿供预览；其余范围尚未完成。", changes: staged, toolEvents };
  if (input.mode === "discuss") return { message: plan.message, changes: [], toolEvents };

  // 按提案顺序更新临时项目，后续委派从同一份项目读取已完成的新稿
  const budgetMs = Math.max(0, Number(input.delegateBudgetMs) || Math.max(DELEGATE_BUDGET_MS, plan.changes.length * PER_DELEGATE_BUDGET_MS));
  const deadline = Date.now() + budgetMs;
  let finished = 0;

  for (const raw of plan.changes) {
    // 逐条校验：一条写坏只丢这一条并如实报出来，不连累其余变更和回复正文
    const parsed = plannerChangeSchema.safeParse(raw);
    if (!parsed.success) {
      const type = raw && typeof raw === "object" ? String((raw as Record<string, unknown>).type || "未知") : "未知";
      toolEvents.push({ tool: "change.reject", status: "error", message: `变更 ${type} 字段不合法，已丢弃：${parsed.error.issues.slice(0, 3).map(issue => `${issue.path.join(".") || "根"} ${issue.message}`).join("；")}` });
      continue;
    }
    const change = parsed.data;
    // 写入意图都转交给应用里已有的专用智能体，产出结果再变成待确认提案
    const delegateFor = ["chapter.draft_next", "chapter.revise", "chapter.retitle", "chapter.split", "outline.write", "card.write"].includes(change.type);
    const label = change.summary;
    try {
      if (delegateFor && Date.now() >= deadline) throw new Error("本轮委派预算已用尽，此项尚未处理");
      if (delegateFor) input.onDelegate?.({ done: finished, total: plan.changes.length, label, status: "start" });
      const produced = ProjectAgentChangeSchema.parse(await produce(change));
      stage(produced);
      finished += 1;
      if (delegateFor) input.onDelegate?.({ done: finished, total: plan.changes.length, label, status: "complete" });
      toolEvents.push({ tool: change.type, status: "complete", message: `${label}已生成《${describeProduced(produced)}》临时稿` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      finished += 1;
      input.onDelegate?.({ done: finished, total: plan.changes.length, label, status: "error" });
      toolEvents.push({ tool: change.type, status: "error", message: `${label}失败（${changeIdentity(change)}）：${message}。${delegateFailureHint(message)}` });
    }
  }
  return { message: plan.message, changes: staged, toolEvents };
}

/** 委派产出的确认文案：章节给标题，批量标题给章数 */
function describeProduced(change: ProjectAgentChange): string {
  if (change.type === "chapter.titles") return `${change.titles.length} 章标题`;
  if (change.type === "chapter.parts") return `${change.splits.length} 章拆成 ${change.splits.reduce((sum, item) => sum + item.breakAfter.length + 1, 0)} 章`;
  if ("title" in change && change.title) return change.title;
  if ("targetId" in change && change.targetId !== undefined) return `目标 ${String(change.targetId)}`;
  return change.summary;
}
