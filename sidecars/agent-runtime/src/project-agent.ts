import { z } from "zod";
import { ProjectAgentChangeSchema, ProjectAgentPlanSchema as projectAgentPlanSchema, ProjectAgentPlannerChangeSchema as plannerChangeSchema, type ProjectAgentCardRequest, type ProjectAgentCardUpsert, type ProjectAgentChange, type ProjectAgentChapterCreate, type ProjectAgentChapterRequest, type ProjectAgentChapterParts, type ProjectAgentChapterRetitleRequest, type ProjectAgentChapterReviseRequest, type ProjectAgentChapterSplitRequest, type ProjectAgentChapterTitles, type ProjectAgentChapterUpdate, type ProjectAgentOutlineRequest, type ProjectAgentOutlineUpsert } from "@zhizhang/contracts";
export { ProjectAgentChangeSchema };
export type { ProjectAgentCardRequest, ProjectAgentChange, ProjectAgentChapterRequest, ProjectAgentChapterRetitleRequest, ProjectAgentChapterReviseRequest, ProjectAgentChapterSplitRequest, ProjectAgentOutlineRequest } from "@zhizhang/contracts";
import { ModelApiClient } from "./models/model-api.js";
import { byteLength, compactText } from "./context/context-optimizer.js";
import { mapWithConcurrency } from "./application/concurrency.js";

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
 * 必须带上「第几章」的序号：章节 id 是创建时的时间戳，作者说的是“第 150 章”，
 * 没有序号模型就只能靠标题猜，而标题正好可能还是占位的“第 N 章”。
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
    `章节（${rows.length}，条目格式为 #序号｜id｜标题）：`,
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
    `章节条目格式为 #序号｜id｜标题，作者说的“第 150 章”对应 #150，提交变更时要用中间那个 id`,
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
  const needsContinuity = /下一章|续写|继续写|章节草稿|创作下一章/u.test(instruction);
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
      content: relevantExcerpt(text(item.content), terms, needsContinuity && index === chapters.length - 1),
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
  const budget = Math.min(24_000, Math.max(12_000, (Number(input.contextWindowKTokens) || 128) * 1024 * 0.28));
  const inventory = projectInventory(project, input.activeChapterId);
  const sections: string[] = [`## 项目索引\n${compactText(inventory, Math.min(14_000, Math.floor(budget * 0.28)))}`];
  const sources: string[] = [];
  let used = byteLength(sections[0]);
  for (const document of documents) {
    if (document.score <= 0 && sources.length >= 8) continue;
    const remaining = budget - used;
    if (remaining < 500 || sources.length >= 16) break;
    const documentLimit = document.kind === "章节" ? 2200 : document.kind.includes("大纲") ? 4200 : document.kind.includes("卡") ? 2400 : 3600;
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

function parsePlannerResponse(value: string): z.infer<typeof projectAgentPlanSchema> {
  const cleaned = value.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "").trim();
  return projectAgentPlanSchema.parse(JSON.parse(cleaned));
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
  z.object({ action: z.literal("open"), kind: z.string().max(40).optional(), id: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()])).min(1).max(OPEN_BATCH_LIMIT)]) }),
  z.object({ action: z.literal("finish"), message: z.string().min(1).max(5000), changes: z.array(z.unknown()).max(16).default([]) }),
]);

type ProjectAgentTurn = z.infer<typeof agentTurnSchema>;

const changeTypeNames = new Set<string>([
  "project.update", "outline.upsert", "card.upsert", "memory.document.upsert",
  "graph.node.upsert", "graph.edge.upsert", "chapter.draft_next",
  "chapter.revise", "chapter.retitle", "chapter.split", "chapter.delete",
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
  const changes = Array.isArray(parsed.changes) ? parsed.changes : [];
  if (message.length <= 5000) {
    return { ...parsed, action: "finish", message: message || "已生成待确认变更。", changes };
  }
  return { ...parsed, action: "finish", message: `${message.slice(0, 4800)}\n\n（后文过长已截断，如需完整内容请说一次继续）`, changes };
}

function parseAgentTurn(value: string): ProjectAgentTurn {
  const parsed = extractJsonObject(value);
  if (!parsed) throw new Error("回包里找不到 JSON 对象");
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

// 全量文档表：search 只回标题和片段，正文要等 open 才完整取出，避免一次把整本书塞进提示词
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
 * 取出资料全文，支持一次取多份
 * 多份时按份数摊薄单份预算：作者让改十章，一次全量取十章正文会把请求体顶爆，
 * 但逐章取又要耗掉十轮步数，摊薄后两头都不撞。
 */
function runOpen(documents: ProjectDocument[], kind: string | undefined, ids: string[]): string {
  const wanted = ids.slice(0, OPEN_BATCH_LIMIT);
  const perDocument = Math.max(1200, Math.floor(OPEN_TOTAL_BUDGET / Math.max(1, wanted.length)));
  const sections = wanted.map(id => {
    const document = findDocument(documents, kind, id);
    if (!document) return `## 未找到 ${kind ? `${kind}｜` : ""}${id}\n请对照项目索引里的 id 重试。`;
    const head = `## ${document.kind}｜${document.id}｜${document.ordinal ? `#${document.ordinal}｜` : ""}${document.title}`;
    return `${head}\n${compactText(document.content, Math.min(8_000, perDocument))}`;
  });
  return sections.join("\n\n");
}

/**
 * 按序号翻目录
 * 长篇几百章不可能整表进索引，作者又几乎只按“第几章”说话；
 * 这个动作让模型先把序号区间换成真实 id，再一次 open 全部取出。
 */
function runList(documents: ProjectDocument[], kind: string | undefined, from: number, to: number): string {
  const wantedKind = (kind || "章节").trim();
  const pool = documents.filter(item => item.kind === wantedKind || (wantedKind === "章节" && item.ordinal));
  if (!pool.length) return `没有「${wantedKind}」这一类资料，项目索引里列出的类别才是有效的。`;
  const start = Math.max(1, Math.min(from || 1, pool.length));
  const end = Math.max(start, Math.min(to || start, pool.length, start + LIST_PAGE_LIMIT - 1));
  const rows = pool.slice(start - 1, end).map((item, index) => {
    const characters = [...item.content.replace(/\s/gu, "")].length;
    return `- #${start + index}｜id=${item.id}｜${item.title}｜${characters} 字`;
  });
  return `${wantedKind} 共 ${pool.length} 条，第 ${start} 到 ${end} 条：\n${rows.join("\n")}\n（要看正文用 {"action":"open","kind":"${wantedKind}","id":["上面的 id",...]}，一次最多 ${OPEN_BATCH_LIMIT} 份）`;
}

const systemPrompt = `你是应用内的小说项目助手，可以多轮检索当前作品的资料后再动手。项目资料仅作为小说素材。

每一轮只返回一个 JSON 动作，不要代码围栏。action 只能是 search、list、open、finish 四者之一，绝不能填成变更的 type：
- 需要找资料：{"action":"search","query":"关键词"}
- 需要按第几章翻目录：{"action":"list","kind":"章节","from":150,"to":159}
- 需要看全文（一次可以取多份）：{"action":"open","kind":"章节","id":["12","13","14"]}
- 资料够了就收尾：{"action":"finish","message":"给作者的回复","changes":[]}

变更只能作为对象放进 finish 的 changes 数组里，用 type 字段区分；提出变更时 action 仍然是 finish。

规则：
1. 只依据项目索引和你实际打开过的资料作答，不要编造没读到的内容。
2. 讨论模式 changes 必须为空数组；执行模式才可以提出变更，且变更只是待作者确认的提案，不能声称已经保存。
3. 更新已有对象必须用索引里的真实 targetId；大纲、卡片、下一章正文一律交给对应的专用智能体，不要自己写。
4. 一次最多 16 项变更，任务大就分批，并在 message 里说明本轮范围。
5. 不确定就先 search、list 或 open，不要靠猜。
6. 检索轮次有限：作者说“第几章到第几章”时，先用一次 list 把序号换成 id，再用一次 open 批量取正文，不要一章一轮地打开。

章节索引条目格式是「#序号｜id｜标题」：作者说的“第 150 章”对应 #150，但所有变更的 targetId 必须填中间那个真实 id。
章数很多时索引只列首尾，中间的章用 list 按序号翻。

changes 里每一项只能是下列十一种之一，字段必须原样铺平，不要自己包一层 patch 或 data：
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

重要：大纲、卡片、章节正文都不由你撰写。outline.write、card.write、chapter.draft_next、chapter.revise 只需要给出 instruction，
应用会转交给对应的大纲智能体、卡片智能体和章节智能体去生成，它们有各自的专用提示词和技能。
你在 instruction 里把要求写清楚就行，不要在 changes 里塞正文。
只有 project.update 用 patch；memory.document.upsert 和图谱两项因为没有专用智能体，才由你直接给出内容。

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
- chapter.revise 会重写整章正文，一次最多提 10 章；更多章节请分批，并在 message 里说明已处理范围和剩下的部分。
- 删除是不可恢复操作：只有作者明确要求删除时才能提，不要自作主张清理你觉得多余的章节。

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
function runTurnTool(documents: ProjectDocument[], turn: Exclude<ProjectAgentTurn, { action: "finish" }>): { label: string; result: string } {
  if (turn.action === "search") {
    return { label: `检索「${turn.query}」`, result: runSearch(documents, turn.query) };
  }
  if (turn.action === "list") {
    const kind = turn.kind || "章节";
    const from = turn.from || 1;
    const to = turn.to || turn.from || 1;
    return { label: `翻阅${kind}第 ${from} 到 ${to} 条`, result: runList(documents, turn.kind, from, to) };
  }
  const ids = (Array.isArray(turn.id) ? turn.id : [turn.id]).map(item => String(item));
  const label = ids.length > 1
    ? `打开 ${turn.kind ? `${turn.kind}｜` : ""}${ids.length} 份资料（${ids.slice(0, 3).join("、")}${ids.length > 3 ? "…" : ""}）`
    : `打开 ${turn.kind ? `${turn.kind}｜` : ""}${ids[0]}`;
  return { label, result: runOpen(documents, turn.kind, ids) };
}

/**
 * 单次请求体上限
 * 每轮检索都往 messages 里追加一次动作和一段工具结果，这个数组只增不减：
 * 前几轮请求体很小，最后几轮能撑到 60 KB 以上，表现就是“做到一半突然失败”。
 * 无论上游阈值是多少，请求体无上限增长本身就是 bug。
 * ponytail: 固定上限并从中间丢旧工具结果；若以后需要更长的检索链，再改为按轮次摘要压缩
 */
const REQUEST_BODY_LIMIT = 40_000;

/**
 * 单轮修订章数上限
 * 修订一章要跑一次完整的正文重写，成本接近写新章；超出的部分如实告知而不静默丢弃。
 */
const REVISE_LIMIT = 10;

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
 * 同时跑几个委派
 * 委派的时间几乎全是等模型响应：十章串行按单章 3 分钟算就是半小时，作者只看到进度条不动，
 * 中途任何一次超时都让整轮白等。但并发太高会被上游限流，把本来能成的章一起打成 429。
 * 三路是能明显缩短墙钟又不至于触发限流的折中。
 */
const DELEGATE_CONCURRENCY = 3;

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

function boundedMessages(messages: AgentMessage[]): AgentMessage[] {
  const size = (list: AgentMessage[]) => list.reduce((sum, message) => sum + byteLength(message.content), 0);
  if (size(messages) <= REQUEST_BODY_LIMIT) return messages;

  // system 和首条请求（含项目资料）是任务前提，不能丢
  const head = messages.slice(0, 2);
  const rest = messages.slice(2);
  let budget = REQUEST_BODY_LIMIT - size(head);

  // 从新到旧保留检索轮次，旧的先丢；模型当前在看的是最后一轮
  const kept: AgentMessage[] = [];
  for (let index = rest.length - 1; index >= 0 && budget > 0; index -= 1) {
    const message = rest[index];
    const bytes = byteLength(message.content);
    if (bytes <= budget) {
      budget -= bytes;
      kept.unshift(message);
      continue;
    }
    // 最近一轮工具结果单条就超预算时截断保留，而不是整条丢掉
    if (!kept.length && budget > 500) {
      kept.unshift({ role: message.role, content: compactText(message.content, budget - 200) });
    }
    break;
  }

  const dropped = rest.length - kept.length;
  const notice: AgentMessage[] = dropped > 0
    ? [{ role: "user", content: `（为控制请求体大小，已省略较早的 ${dropped} 段检索记录；如需要请重新 search 或 open。）` }]
    : [];
  return [...head, ...notice, ...kept];
}

export async function runProjectAgent(
  input: ProjectAgentInput,
  client: ModelApiClient,
  delegates: ProjectAgentDelegates,
): Promise<ProjectAgentResult> {
  const context = buildProjectAgentContext(input);
  const documents = projectDocuments(input.project);
  const history = (input.history || []).slice(-10).flatMap(message => {
    const role: "user" | "assistant" | null = message.role === "assistant" ? "assistant" : message.role === "user" ? "user" : null;
    const content = compactText(message.content || "", 4000);
    return role && content ? [{ role, content }] : [];
  });
  const toolEvents: ProjectAgentToolEvent[] = [{
    tool: "project.context",
    status: "complete",
    message: `已载入项目索引与 ${context.sources.length} 份相关资料`,
  }];

  const messages: AgentMessage[] = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: `模式：${input.mode === "execute" ? "执行（可提出待确认变更）" : "讨论（禁止提出变更）"}\n\n## 当前项目资料\n${context.packet}\n\n## 本轮请求\n${input.instruction}` },
  ];

  // ponytail: 步数、工具输出和请求体都是硬上限，够用就停；需要更深的检索再把上限做成设置项
  // 默认 8 轮：list 翻目录 + 批量 open 之后还要留出改主意重新检索的余量，6 轮在跨章任务上刚好不够
  const maxSteps = Math.max(1, Math.min(16, Number(input.maxSteps) || 8));
  const toolOutputBudget = 48_000;
  let toolOutputUsed = 0;
  let plan: Extract<ProjectAgentTurn, { action: "finish" }> | null = null;

  for (let step = 0; step < maxSteps && !plan; step += 1) {
    const mustFinish = step === maxSteps - 1 || toolOutputUsed >= toolOutputBudget;
    const turnMessages = mustFinish
      ? [...boundedMessages(messages), { role: "user" as const, content: "检索预算已用尽，请直接返回 finish 动作。" }]
      : boundedMessages(messages);
    const response = await client.chat(turnMessages, { response_format: { type: "json_object" }, temperature: 0.2, max_tokens: 12_000, retryAttempts: 2 });

    let turn: ProjectAgentTurn;
    try {
      turn = parseAgentTurn(response.content);
    } catch (rawError) {
      const rawErrorText = rawError instanceof Error ? rawError.message : String(rawError);
      // 先试模型修复轮：只修格式不补事实；修不好就把原文当成纯文本回复收尾，不让一次格式抖动毁掉整轮
      let repaired: Awaited<ReturnType<typeof client.chat>> | null = null;
      try {
        repaired = await client.chat([
          { role: "system", content: systemPrompt },
          { role: "user", content: `请把以下内容整理成约定的 JSON 动作，只调整格式：\n${compactText(response.content, 6000)}` },
        ], { response_format: { type: "json_object" }, temperature: 0, max_tokens: 12_000, retryAttempts: 1 });
        turn = parseAgentTurn(repaired.content);
      } catch {
        // 两轮都没解析成动作时，看原文里有没有正文可用：纯散文回复（比如直接写出来的大纲）
        // 当成 finish 的 message 收尾，别把已经写好的内容丢掉；只剩错误信息才走引导重试的兑底话
        const prose = response.content.trim().replace(/^```(?:json|markdown|text)?\s*/iu, "").replace(/\s*```$/u, "").trim();
        const usableProse = prose.length >= 40 ? compactText(prose, 4800) : "";
        turn = {
          action: "finish",
          message: usableProse || `这轮回复没能解析成可执行的变更（${compactText(rawErrorText, 160)}）。多半是内容太长被截断：把范围说小一些，或明确说“交给章节智能体处理”再试一次。`,
          changes: [],
        };
      }
    }

    if (turn.action === "finish") {
      plan = turn;
      break;
    }

    const { label, result } = runTurnTool(documents, turn);
    toolOutputUsed += byteLength(result);
    toolEvents.push({ tool: `project.${turn.action}`, status: "complete", message: label });
    input.onStep?.({ kind: turn.action === "search" ? "search" : "open", message: label });
    messages.push({ role: "assistant", content: JSON.stringify(turn) });
    messages.push({ role: "user", content: `工具结果（${label}）：\n${result}` });
  }

  if (!plan) return { message: "本轮检索没有收敛出结论，请换个说法再试一次。", changes: [], toolEvents };
  if (input.mode === "discuss") return { message: plan.message, changes: [], toolEvents };

  const changes: ProjectAgentChange[] = [];

  // 先按顺序分好类再统一执行：委派要并发跑，但产出顺序必须还是模型给的顺序，
  // 否则确认列表的排序每轮都在跳，作者对不上自己刚说的那句话
  type DelegateTask = { label: string; change: { type: string; summary: string; targetId?: number | string }; run: () => Promise<unknown> };
  type Slot = { direct: ProjectAgentChange } | { task: DelegateTask } | { skipped: true };
  const slots: Slot[] = [];
  const tasks: Array<{ slot: number; task: DelegateTask }> = [];
  let revisedCount = 0;

  for (const raw of plan.changes) {
    // 逐条校验：一条写坏只丢这一条并如实报出来，不连累其余变更和回复正文
    const parsed = plannerChangeSchema.safeParse(raw);
    if (!parsed.success) {
      const type = raw && typeof raw === "object" ? String((raw as Record<string, unknown>).type || "未知") : "未知";
      toolEvents.push({ tool: "change.reject", status: "error", message: `变更 ${type} 字段不合法，已丢弃：${parsed.error.issues.slice(0, 3).map(issue => `${issue.path.join(".") || "根"} ${issue.message}`).join("；")}` });
      slots.push({ skipped: true });
      continue;
    }
    const change = parsed.data;
    if (change.type === "chapter.revise") {
      revisedCount += 1;
      if (revisedCount > REVISE_LIMIT) {
        toolEvents.push({ tool: "chapter.revise", status: "error", message: `单轮最多修订 ${REVISE_LIMIT} 章，章节 ${change.targetId} 本轮未处理，请再说一次继续` });
        slots.push({ skipped: true });
        continue;
      }
    }
    // 写入意图都转交给应用里已有的专用智能体，产出结果再变成待确认提案
    const delegateFor = {
      "chapter.draft_next": { label: "章节智能体", run: () => delegates.chapter(change as ProjectAgentChapterRequest) },
      "chapter.revise": { label: "章节修订智能体", run: () => delegates.chapterRevise(change as ProjectAgentChapterReviseRequest) },
      "chapter.retitle": { label: "标题智能体", run: () => delegates.chapterTitles(change as ProjectAgentChapterRetitleRequest) },
      "chapter.split": { label: "拆章", run: () => delegates.chapterSplit(change as ProjectAgentChapterSplitRequest) },
      "outline.write": { label: "大纲智能体", run: () => delegates.outline(change as ProjectAgentOutlineRequest) },
      "card.write": { label: "卡片智能体", run: () => delegates.card(change as ProjectAgentCardRequest) },
    }[change.type as string];
    if (!delegateFor) {
      slots.push({ direct: ProjectAgentChangeSchema.parse(change) });
      continue;
    }
    const task: DelegateTask = { label: delegateFor.label, change: change as DelegateTask["change"], run: delegateFor.run };
    tasks.push({ slot: slots.length, task });
    slots.push({ task });
  }

  // 预算跟着活儿走：按基础值 + 每项额度取总预算，否则批量修订会在固定 20 分钟处断掉，
  // 和单轮 10 章的修订上限矛盾。并发之后同样的预算能装下更多章
  const budgetMs = Math.max(0, Number(input.delegateBudgetMs) || Math.max(DELEGATE_BUDGET_MS, tasks.length * PER_DELEGATE_BUDGET_MS));
  const deadline = Date.now() + budgetMs;
  let finished = 0;

  // 有界并发执行：结果按输入顺序回来，一项失败只影响它自己
  const outcomes = await mapWithConcurrency(tasks, DELEGATE_CONCURRENCY, async ({ task }) => {
    // 预算只拦委派：其余变更不调模型，几乎不花时间。并发下每个任务开跑前各自看一次剩余时间
    if (Date.now() >= deadline) {
      finished += 1;
      input.onDelegate?.({ done: finished, total: tasks.length, label: task.label, status: "error" });
      return { event: { tool: task.change.type, status: "error" as const, message: `本轮委派已用满 ${Math.round(budgetMs / 60_000)} 分钟预算，「${task.change.summary}」未处理，请再说一次继续` } };
    }
    input.onDelegate?.({ done: finished, total: tasks.length, label: task.label, status: "start" });
    try {
      const produced = await task.run();
      const change = ProjectAgentChangeSchema.parse(produced);
      finished += 1;
      input.onDelegate?.({ done: finished, total: tasks.length, label: task.label, status: "complete" });
      return { change, event: { tool: task.change.type, status: "complete" as const, message: `${task.label}已完成《${describeProduced(change)}》` } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      finished += 1;
      input.onDelegate?.({ done: finished, total: tasks.length, label: task.label, status: "error" });
      // 带上是哪一项、原始原因和下一步怎么做，而不是只丢一句“API 有问题”
      return { event: { tool: task.change.type, status: "error" as const, message: `${task.label}失败（${changeIdentity(task.change)}）：${message}。${delegateFailureHint(message)}` } };
    }
  });

  const outcomeBySlot = new Map(tasks.map((entry, index) => [entry.slot, outcomes[index]]));
  for (const [index, slot] of slots.entries()) {
    if ("direct" in slot) {
      changes.push(slot.direct);
      continue;
    }
    const outcome = outcomeBySlot.get(index);
    if (!outcome) continue;
    if (outcome.change) changes.push(outcome.change);
    toolEvents.push(outcome.event);
  }
  return { message: plan.message, changes, toolEvents };
}

/** 委派产出的确认文案：章节给标题，批量标题给章数 */
function describeProduced(change: ProjectAgentChange): string {
  if (change.type === "chapter.titles") return `${change.titles.length} 章标题`;
  if (change.type === "chapter.parts") return `${change.splits.length} 章拆成 ${change.splits.reduce((sum, item) => sum + item.breakAfter.length + 1, 0)} 章`;
  if ("title" in change && change.title) return change.title;
  if ("targetId" in change && change.targetId !== undefined) return `目标 ${String(change.targetId)}`;
  return change.summary;
}
