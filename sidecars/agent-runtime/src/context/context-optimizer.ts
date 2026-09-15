import { createHash } from "node:crypto";

export interface ContextReport {
  cache: "hit" | "miss";
  sourceBytes: number;
  packedBytes: number;
  prunedBytes: number;
  budgetBytes: number;
  retrievedBytes?: number;
  draftInputBytes?: number;
  reviewInputBytes?: number;
  contextProfile?: "剧情" | "战斗" | "情感" | "转场";
  sections: Record<string, number>;
  upstreamUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cachedInputTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    requests: number;
  };
}

type ContextProfile = "剧情" | "战斗" | "情感" | "转场";

type ContextWeights = Pick<Record<"outline" | "cards" | "memories" | "previousChapters" | "knowledgeGraph" | "skills", number>, "outline" | "cards" | "memories" | "previousChapters" | "knowledgeGraph" | "skills">;

// These weights apply only to the per-chapter dynamic pack. The stable prompt
// prefix remains byte-for-byte ordered for upstream prompt-cache reuse.
const CONTEXT_PROFILE_WEIGHTS: Record<ContextProfile, ContextWeights> = {
  剧情: { outline: 0.20, cards: 0.12, memories: 0.22, previousChapters: 0.30, knowledgeGraph: 0.09, skills: 0.07 },
  战斗: { outline: 0.16, cards: 0.21, memories: 0.16, previousChapters: 0.31, knowledgeGraph: 0.09, skills: 0.07 },
  情感: { outline: 0.18, cards: 0.16, memories: 0.28, previousChapters: 0.26, knowledgeGraph: 0.06, skills: 0.06 },
  转场: { outline: 0.23, cards: 0.10, memories: 0.17, previousChapters: 0.36, knowledgeGraph: 0.08, skills: 0.06 },
};

export function resolveContextProfile(instruction: string): ContextProfile {
  const text = instruction.toLowerCase();
  if (/战斗|打斗|厮杀|对决|追杀|战场|boss|副本|碾压/u.test(text)) return "战斗";
  if (/感情|情感|恋爱|暧昧|告白|关系|和解|亲情|心动/u.test(text)) return "情感";
  if (/转场|过渡|赶路|抵达|离开|时间跳跃|数日后|次日|场景切换/u.test(text)) return "转场";
  return "剧情";
}

export interface ContextCard {
  id?: string | number;
  type?: string;
  title: string;
  content?: string;
  currentState?: string;
  stateHistory?: Array<{ changes?: string; chapterTitle?: string; status?: string }>;
}

export interface ContextOutline {
  id?: string | number;
  kind?: string;
  title?: string;
  content?: string;
}

export interface ContextGraph {
  nodes?: Array<{ id?: string; label?: string; type?: string; category?: string }>;
  edges?: Array<{ id?: string; source?: string; target?: string; label?: string; weight?: number }>;
}

/** 正在写第几章、全书已有几章：让模型知道自己在全书的位置，而不是永远只看得见上一章 */
export interface ChapterPosition {
  number?: number;
  total?: number;
}

export interface PreparedChapterInput {
  worldSetting?: string;
  /** 总纲的结构骨架与当前相关段落，只用于判断推进方向 */
  masterOutline?: string;
  /** 前文已发生事件与未回收伏笔的账本，一章一行 */
  storyLedger?: string;
  outline?: string;
  cards: Array<{ type: string; title: string; content: string }>;
  /** content 是头尾摘录；ending 是真正的章尾，承接锚点只能用它 */
  previousChapters: Array<{ id?: string | number; title: string; content: string; ending?: string }>;
  memories: Array<Record<string, unknown>>;
  memoryDocuments: Array<Record<string, unknown>>;
  knowledgeGraph?: string;
  skills: Array<{ name: string; displayName?: string; category: string; description: string; tags: string[]; content: string }>;
  report: ContextReport;
}

const truncationMarker = "\n...[已按相关性与预算裁剪]...\n";

export const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");

/**
 * Normalize document whitespace only for model-bound context. This preserves
 * Markdown paragraph/code-fence semantics while removing editor-introduced
 * indentation, trailing whitespace and redundant empty lines that consume
 * tokens without adding meaning. Local files keep their original formatting.
 */
export function normalizePromptWhitespace(value: unknown): string {
  const lines = String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .split("\n");
  let inCodeFence = false;
  let emptyLines = 0;
  const normalized: string[] = [];

  for (const rawLine of lines) {
    const fence = /^\s*```/.test(rawLine);
    const line = inCodeFence
      ? rawLine.replace(/[ \t]+$/g, "")
      : rawLine
        .replace(/^[ \t]+|[ \t]+$/g, "")
        .replace(/[ \t]{2,}/g, " ");
    if (!line) {
      emptyLines += 1;
      if (emptyLines <= 1) normalized.push("");
    } else {
      emptyLines = 0;
      normalized.push(line);
    }
    if (fence) inCodeFence = !inCodeFence;
  }
  return normalized.join("\n").trim();
}

function sliceToBytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0 || !value) return "";
  if (byteLength(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (byteLength(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}

/** Preserve both the premise and the most recent state when a source is oversized. */
export function compactText(value: unknown, maxBytes: number): string {
  const text = normalizePromptWhitespace(value);
  if (!text || maxBytes <= 0) return "";
  if (byteLength(text) <= maxBytes) return text;
  if (maxBytes <= byteLength(truncationMarker) + 24) return sliceToBytes(text, maxBytes);
  const available = maxBytes - byteLength(truncationMarker);
  const head = sliceToBytes(text, Math.floor(available * 0.62));
  const tailBudget = Math.max(0, available - byteLength(head));
  const reversed = Array.from(text).reverse().join("");
  const tail = Array.from(sliceToBytes(reversed, tailBudget)).reverse().join("");
  return `${head}${truncationMarker}${tail}`;
}

/**
 * 只保留结尾
 * 承接锚点要的是上一章真正的最后几段；compactText 的头尾拼接会把开头当成"结尾"喂给模型，
 * 下一章就从上一章的开头重新写起
 */
export function tailText(value: unknown, maxBytes: number): string {
  const text = normalizePromptWhitespace(value);
  if (!text || maxBytes <= 0) return "";
  if (byteLength(text) <= maxBytes) return text;
  const reversed = Array.from(text).reverse().join("");
  const tail = Array.from(sliceToBytes(reversed, maxBytes)).reverse().join("");
  // 从第一个完整段落开始，避免以半句话开头；为此丢掉的内容不超过一半
  const firstBreak = tail.indexOf("\n");
  return (firstBreak > 0 && firstBreak < tail.length / 2 ? tail.slice(firstBreak + 1) : tail).trim();
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]));
  }
  return value;
}

export function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

export class LruCache<Value> {
  private readonly entries = new Map<string, Value>();

  constructor(private readonly maxEntries = 64) {}

  get(key: string): Value | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: Value): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.entries.delete(oldestKey);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

/** 总纲和故事账本不占各资料区的加权预算：它们是全书级资料，不该被上一章正文挤掉 */
export const masterOutlineBytes = 5600;
const storyLedgerBytes = 3600;

/** 资料区预算占比：按 1 token ≈ 3 字节的汉字估算，给各资料区留窗口的 16% */
const contextBudgetShare = 0.16;
/** 绝对上限：窗口再大也不把整部书塞进去，否则单次请求又慢又贵 */
const contextBudgetCeilingKB = 256;

export function contextBudgetBytes(contextWindowKTokens?: number, capKB?: number, minimumKB = 6): number {
  // 这里只分配各资料区的预打包空间；最终硬上限由模型 tokenizer 执行
  const configuredTokens = Math.max(16, Number(contextWindowKTokens) || 128) * 1024;
  // 预算要跟着窗口走：老代码把上限写死 18KB，128K 窗口也只装 18KB，剩下的 180 多 KB 全被裁掉
  const windowKB = Math.min(contextBudgetCeilingKB, Math.floor(configuredTokens * 3 * contextBudgetShare / 1024));
  const limitKB = capKB === undefined ? windowKB : Math.min(capKB, windowKB);
  return Math.max(minimumKB * 1024, limitKB * 1024);
}

function compactList(value: unknown, maxItems: number, itemBytes: number): string[] {
  return Array.isArray(value)
    ? value.map(item => compactText(item, itemBytes)).filter(Boolean).slice(0, maxItems)
    : [];
}

function queryText(instruction: string, outlines: ContextOutline[], memories: Array<Record<string, unknown>>, cards: ContextCard[]): string {
  return [
    instruction,
    ...outlines.map(outline => `${outline.kind || ""} ${outline.title || ""} ${outline.content || ""}`),
    ...memories.flatMap(memory => [memory.title, memory.summary, ...(Array.isArray(memory.keywords) ? memory.keywords : [])]),
    ...cards.map(card => `${card.title} ${card.currentState || ""}`),
  ].filter(Boolean).join("\n").toLowerCase();
}

function relevanceScore(label: string, text: string): number {
  const normalized = label.trim().toLowerCase();
  if (!normalized) return 0;
  if (text.includes(normalized)) return 12;
  const chunks = normalized.match(/[\p{L}\p{N}]{2,}/gu) || [];
  return chunks.reduce((score, chunk) => score + (text.includes(chunk) ? 3 : 0), 0);
}

function graphEdgeWeight(edge: { weight?: number; label?: string }): number {
  const parsed = Number(edge.weight);
  if (Number.isFinite(parsed)) return Math.max(0.1, Math.min(1, parsed));
  if (edge.label === "本章引用") return 1;
  if (edge.label === "状态更新") return 0.95;
  if (edge.label === "章节主角") return 0.92;
  if (edge.label === "状态引用") return 0.88;
  if (edge.label === "正文提及") return 0.75;
  if (edge.label === "章节提及") return 0.7;
  return 0.65;
}

function compactOutlines(outlines: ContextOutline[], activeOutlineId: unknown, text: string, maxBytes: number): string {
  const ordered = outlines
    .filter(outline => String(outline.content || "").trim())
    .map(outline => ({
      outline,
      score: (String(outline.id ?? "") === String(activeOutlineId ?? "") ? 100 : 0)
        + relevanceScore(`${outline.kind || ""} ${outline.title || ""}`, text)
        + (outline.kind === "章纲" || outline.kind === "细纲" ? 8 : outline.kind === "总纲" ? 4 : 0),
    }))
    .sort((left, right) => right.score - left.score || String(left.outline.id ?? "").localeCompare(String(right.outline.id ?? "")));
  let remaining = maxBytes;
  const sections: string[] = [];
  for (const { outline } of ordered.slice(0, 4)) {
    if (remaining < 180) break;
    const heading = `## ${compactText(outline.kind || outline.title || "大纲", 80)}\n`;
    const body = compactText(outline.content, Math.max(120, remaining - byteLength(heading)));
    const section = `${heading}${body}`;
    sections.push(section);
    remaining -= byteLength(section) + 2;
  }
  return sections.join("\n\n");
}

function compactCards(cards: ContextCard[], text: string, maxBytes: number): Array<{ type: string; title: string; content: string }> {
  const ranked = cards
    .filter(card => card && card.title?.trim())
    .map(card => ({ card, score: relevanceScore(`${card.title} ${card.currentState || ""} ${card.content || ""}`, text) }))
    .sort((left, right) => right.score - left.score || left.card.title.localeCompare(right.card.title));
  let remaining = maxBytes;
  const packed: Array<{ type: string; title: string; content: string }> = [];
  for (const { card } of ranked.slice(0, 8)) {
    if (remaining < 160) break;
    const history = (card.stateHistory || []).slice(-2)
      .map(item => `${compactText(item.chapterTitle || "最近章节", 70)}：${compactText(item.changes || item.status || "", 180)}`)
      .filter(Boolean).join("；");
    const state = compactText(card.currentState || "", 360);
    const label = `[${compactText(card.type || "知识卡", 40)}] ${compactText(card.title, 100)}`;
    const fixed = [label, state && `当前状态：${state}`, history && `近期变化：${history}`].filter(Boolean).join("\n");
    const knowledge = compactText(card.content || "", Math.max(120, Math.min(900, remaining - byteLength(fixed) - 20)));
    const content = [fixed, knowledge && `知识：${knowledge}`].filter(Boolean).join("\n");
    packed.push({ type: compactText(card.type || "知识卡", 40), title: compactText(card.title, 100), content });
    remaining -= byteLength(content) + 2;
  }
  return packed;
}

export function compactKnowledgeGraph(graph: unknown, text: string, maxBytes = 2800): string {
  if (!graph || typeof graph !== "object") return "";
  const source = graph as ContextGraph;
  const nodes = (source.nodes || []).filter(node => node?.id && node.label);
  const nodeById = new Map(nodes.map(node => [String(node.id), node]));
  const scored = nodes.map(node => ({ node, score: relevanceScore(`${node.label || ""} ${node.category || ""}`, text) }));
  const seeds = scored.filter(item => item.score > 0).sort((left, right) => right.score - left.score).slice(0, 10);
  const fallback = scored.sort((left, right) => String(left.node.label).localeCompare(String(right.node.label))).slice(0, 5);
  const selected = new Set((seeds.length ? seeds : fallback).map(item => String(item.node.id)));
  const edges = (source.edges || []).filter(edge => edge?.source && edge?.target)
    .sort((left, right) => graphEdgeWeight(right) - graphEdgeWeight(left));
  for (const edge of edges) {
    const sourceId = String(edge.source);
    const targetId = String(edge.target);
    if (!selected.has(sourceId) && !selected.has(targetId)) continue;
    // 留出空间给强关系；较弱的扩散关系不会挤掉当前写作的直接证据。
    if (selected.size >= 18 && (!selected.has(sourceId) || !selected.has(targetId))) continue;
    selected.add(sourceId);
    selected.add(targetId);
  }
  const selectedNodes = Array.from(selected).map(id => nodeById.get(id)).filter((node): node is NonNullable<typeof node> => Boolean(node))
    .sort((left, right) => relevanceScore(`${right.label || ""} ${right.category || ""}`, text) - relevanceScore(`${left.label || ""} ${left.category || ""}`, text) || String(left.label).localeCompare(String(right.label)))
    .slice(0, 18);
  const selectedIds = new Set(selectedNodes.map(node => String(node.id)));
  const selectedEdges = edges.filter(edge => selectedIds.has(String(edge.source)) && selectedIds.has(String(edge.target))).slice(0, 28);
  const nodeLines = selectedNodes.map(node => `- ${compactText(node.label || "实体", 80)}${node.category ? `（${compactText(node.category, 40)}）` : ""}`);
  const edgeLines = selectedEdges.map(edge => {
    const sourceLabel = nodeById.get(String(edge.source))?.label || edge.source;
    const targetLabel = nodeById.get(String(edge.target))?.label || edge.target;
    return `- ${compactText(sourceLabel || "实体", 70)} -[${compactText(edge.label || "关联", 50)}；权重 ${graphEdgeWeight(edge).toFixed(2)}]-> ${compactText(targetLabel || "实体", 70)}`;
  });
  return compactText([nodeLines.length ? `实体：\n${nodeLines.join("\n")}` : "", edgeLines.length ? `关系：\n${edgeLines.join("\n")}` : ""].filter(Boolean).join("\n"), maxBytes);
}

/** 带状态的伏笔条目压成一行：已回收的不再进入写作上下文，剩下的标明埋设章与计划回收章 */
function compactForeshadowingItems(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const entry = item as Record<string, unknown>;
    const text = compactText(entry.text || "", 160);
    const status = String(entry.status || "active").trim();
    if (!text || status === "resolved") return [];
    const planted = Number(entry.plantedChapter);
    const target = Number(entry.targetChapter);
    const meta = [
      Number.isFinite(planted) && planted > 0 ? `埋于第 ${planted} 章` : "",
      Number.isFinite(target) && target > 0 ? `计划第 ${target} 章回收` : "",
    ].filter(Boolean).join("，");
    return [`[${status}] ${text}${meta ? `（${meta}）` : ""}`];
  }).slice(0, maxItems);
}

const memoryChapterNumber = (memory: Record<string, unknown>): number | undefined => {
  const number = Number(memory.chapterNumber ?? memory.sourceChapterNumber);
  return Number.isFinite(number) && number > 0 ? number : undefined;
};

function compactMemories(memories: unknown, maxBytes: number): Array<Record<string, unknown>> {
  const source = Array.isArray(memories) ? memories.filter(item => item && typeof item === "object") : [];
  let remaining = maxBytes;
  const packed: Array<Record<string, unknown>> = [];
  // 不写死只带 6 章：能带多少由预算决定，长篇小说不该因为一个常量永远只能看见最近六章
  for (const item of [...source].reverse()) {
    if (remaining < 180) break;
    const memory = item as Record<string, unknown>;
    const value: Record<string, unknown> = {
      id: memory.id,
      chapterNumber: memoryChapterNumber(memory),
      // 界面路径传 title，项目 Agent 路径直接传项目里的记忆对象（chapterTitle），两边都要认
      title: compactText(memory.title || memory.chapterTitle || "章节记忆", 100),
      summary: compactText(memory.summary || "", 600),
      keywords: compactList(memory.keywords, 8, 70),
      characterStateChanges: compactList(memory.characterStateChanges, 4, 180),
      knowledgeChanges: compactList(memory.knowledgeChanges, 3, 180),
      foreshadowingChanges: compactList(memory.foreshadowingChanges, 5, 200),
      foreshadowingItems: compactForeshadowingItems(memory.foreshadowingItems, 8),
      timelineEvents: compactList(memory.timelineEvents, 3, 180),
      canonFacts: compactList(memory.canonFacts, 3, 180),
      conflicts: compactList(memory.conflicts, 2, 180),
      endingHook: compactText(memory.endingHook || "", 260),
    };
    const size = byteLength(JSON.stringify(value));
    if (size > remaining && packed.length) break;
    packed.push(value);
    remaining -= size;
  }
  return packed.reverse();
}

/** 承接锚点的章尾长度：约四五百个汉字，够看清最后一个场景怎么收的；
 * 再长就不是“承接”而是“上一章正文”，模型会顺着它把上一章最后一场戏再写一遍 */
const previousChapterEndingBytes = 1400;

function compactPreviousChapters(chapters: unknown, maxBytes: number): PreparedChapterInput["previousChapters"] {
  const source = Array.isArray(chapters) ? chapters.filter(item => item && typeof item === "object") : [];
  let remaining = maxBytes;
  const packed: PreparedChapterInput["previousChapters"] = [];
  for (const item of source.slice(-2).reverse()) {
    if (remaining < 180) break;
    const chapter = item as Record<string, unknown>;
    const title = compactText(chapter.title || "上一章", 100);
    const content = compactText(chapter.content || "", Math.max(160, Math.min(5400, remaining - byteLength(title) - 30)));
    if (!content) continue;
    // 章尾单独从原文截取：content 已经是头尾拼接，从它里面再截"结尾"只会截到开头
    const ending = tailText(chapter.content || "", previousChapterEndingBytes);
    packed.push({ id: typeof chapter.id === "string" || typeof chapter.id === "number" ? chapter.id : undefined, title, content, ending });
    remaining -= byteLength(title) + byteLength(content) + 30;
  }
  return packed.reverse();
}

/** 章节相关度打分用的二元组重合：总纲段落里出现越多当前章纲、记忆里的词，越可能是本章所处的阶段 */
function bigramOverlap(value: string, text: string): number {
  const chars = Array.from(value.replace(/[^\p{L}\p{N}]/gu, "")).slice(0, 600);
  const seen = new Set<string>();
  let score = 0;
  for (let index = 0; index + 1 < chars.length; index += 1) {
    const gram = `${chars[index]}${chars[index + 1]}`;
    if (seen.has(gram)) continue;
    seen.add(gram);
    if (text.includes(gram)) score += 1;
  }
  return score;
}

interface OutlineSection {
  heading: string;
  level: number;
  body: string;
  index: number;
}

/** 总纲按标题切段，保留层级与原始顺序：找“下一步”只能靠顺序，不能靠词面打分 */
function splitOutlineSections(normalized: string): OutlineSection[] {
  const sections: OutlineSection[] = [];
  let heading = "";
  let level = 0;
  let body: string[] = [];
  const flush = () => {
    if (heading || body.join("").trim()) sections.push({ heading, level, body: body.join("\n").trim(), index: sections.length });
  };
  for (const line of normalized.split("\n")) {
    const marked = /^(#{1,6})\s+\S/u.exec(line);
    if (marked) {
      flush();
      heading = line.trim();
      level = marked[1].length;
      body = [];
      continue;
    }
    body.push(line);
  }
  flush();
  return sections;
}

/** 总纲里写“后面还要交付什么”的段落：分卷与阶段规划，是模型唯一能拿到的未来节点 */
const forwardOutlineHeading = /(分卷|卷规划|卷纲|第[一二三四五六七八九十\d]+卷|阶段规划|阶段推进|主线推进|剧情推进|推进路线|节点规划)/u;
const endingOutlineHeading = /(结局|大结局|终章|完结|尾声)/u;
/** 核对清单、格式说明这类流程性段落：占着“下一步”的位置却没写任何剧情 */
const metaOutlineHeading = /(核对|待确认|说明|格式|清单|检查|附录|流程|方法|边界)/u;
/** 卷标题里手写的章号区间（第156～205章）：有它就能按当前章号精确定位，不用猜 */
const chapterRangeHeading = /第\s*(\d{1,4})\s*[～~\-—至]\s*(\d{1,4})\s*章/u;

/** 取某个标题及其子标题正文；同级或更浅的标题就是下一段了 */
function outlineSubtreeText(sections: OutlineSection[], startIndex: number, used?: Set<number>): string {
  const level = sections[startIndex].level;
  const picked: OutlineSection[] = [];
  for (const section of sections.slice(startIndex)) {
    if (section.index > startIndex && section.heading && section.level <= level) break;
    picked.push(section);
    used?.add(section.index);
  }
  return picked.map(section => [section.heading, section.body].filter(Boolean).join("\n")).join("\n\n");
}

/**
 * 总纲只给三样东西：全书结构骨架、当前卷与下一卷、以及本章所处的当前节点
 * 老做法按词面相关度挑段落，挑中的永远是“已经写过的部分”——后续节点用的词和正文本来就不重合，
 * 词面打分天然把未来排掉，模型只能看见过去，于是把上一章换个说法再写一遍
 */
export function compactMasterOutline(content: unknown, text: string, maxBytes: number, chapterNumber?: number): string {
  const normalized = normalizePromptWhitespace(content);
  if (!normalized || maxBytes <= 0) return "";
  const sections = splitOutlineSections(normalized);
  // 没有标题结构的总纲无法按段挑选，只能整体截断
  if (sections.filter(section => section.heading).length < 2) return compactText(normalized, maxBytes);
  // 骨架只列到二级标题：三级标题是细节，全列出来会占掉一半预算、还被位置截断把中间几卷的标题切掉
  const headingSections = sections.filter(section => section.heading);
  const topSections = headingSections.filter(section => section.level <= 2);
  const skeletonSource = topSections.length >= 3 ? topSections : headingSections;
  const skeleton = compactText(
    `结构骨架：\n${skeletonSource.map(section => section.heading).join("\n")}`,
    Math.max(320, Math.floor(maxBytes * 0.2)),
  );
  let remaining = maxBytes - byteLength(skeleton) - 12;

  // 卷/阶段段落：标题里写了章号区间的能按当前章号精确定位（长篇小说基本都这么列卷），
  // 没写区间才退回词面匹配
  const volumeLike = sections
    .filter(section => section.heading)
    .map(section => ({ section, range: chapterRangeHeading.exec(section.heading) }))
    .filter(entry => entry.range || forwardOutlineHeading.test(entry.section.heading));
  const routeIndexes = new Set<number>();
  let route = "";
  if (volumeLike.length > 0) {
    const located = chapterNumber === undefined ? undefined : volumeLike.find(entry => {
      if (!entry.range) return false;
      const from = Number(entry.range[1]);
      const to = Number(entry.range[2]);
      return chapterNumber >= from && chapterNumber <= to;
    });
    const scored = volumeLike
      .map(entry => ({ entry, score: bigramOverlap(`${entry.section.heading}\n${entry.section.body}`, text) }))
      .sort((left, right) => right.score - left.score || left.entry.section.index - right.entry.section.index);
    const anchor = located ?? scored[0]?.entry;
    // 定位到“分卷规划”这种只有标题没有正文的父级时，往下取紧随其后的那一卷
    const current = anchor && !anchor.section.body && !anchor.range
      ? volumeLike.find(entry => entry.section.index > anchor.section.index) ?? anchor
      : anchor;
    const next = current ? volumeLike.find(entry => entry.section.index > current.section.index) : undefined;
    const blocks: string[] = [];
    if (current) {
      blocks.push(`【当前卷】\n${compactText(outlineSubtreeText(sections, current.section.index, routeIndexes), Math.max(240, Math.floor(remaining * 0.6)))}`);
    }
    if (next) {
      const left = remaining - byteLength(blocks.join("\n\n")) - 8;
      if (left > 200) blocks.push(`【下一卷】\n${compactText(outlineSubtreeText(sections, next.section.index, routeIndexes), left)}`);
    }
    route = blocks.join("\n\n");
    remaining -= byteLength(route) + 2;
  }

  const usable = sections.filter(section => section.body
    && !endingOutlineHeading.test(section.heading)
    && !metaOutlineHeading.test(section.heading)
    && !routeIndexes.has(section.index));

  // 当前节点：与本章资料词面最合的段落，正文里已经写出来的东西就在这一段
  const current = usable
    .map(section => ({
      section,
      score: (/主线|目标|总览|核心|当前/u.test(section.heading) ? 24 : 0) + bigramOverlap(`${section.heading}\n${section.body}`, text),
    }))
    .sort((left, right) => right.score - left.score || left.section.index - right.section.index)[0]?.section;
  const currentText = current && remaining > 200 ? compactText(`${current.heading}\n${current.body}`, Math.max(160, Math.floor(remaining * 0.6))) : "";
  if (currentText) remaining -= byteLength(currentText) + 2;

  // 接下来必须推进：当前节点之后的第一段正文，本章的终点就落在这里
  const next = usable.find(section => section.index > (current?.index ?? 0));
  const nextText = next && remaining > 200 ? compactText(`${next.heading}\n${next.body}`, remaining) : "";

  return [
    skeleton,
    route ? `推进路线（【当前卷】是本章的出发点，必须推进到本卷的下一步；【下一卷】只在卷末交接时用，不得提前兑现）：\n${route}` : "",
    currentText ? `当前节点（本章的出发点）：\n${currentText}` : "",
    nextText ? `接下来必须推进（本章的终点：正文推进到这里就收笔，允许用一到两段过渡跨越时间或地点；再后面的节点不得提前兑现）：\n${nextText}` : "",
  ].filter(Boolean).join("\n\n");
}

/**
 * 故事账本：最近几章的记忆压成"一章一行"的已发生事件清单，再列出未回收伏笔
 * 章节图靠它禁止重复前文、并知道全书写到哪，这是过去"只看上一章"时完全缺失的信息；
 * 超预算时先丢最早的章，最近几章和伏笔必须保住
 */
export function buildStoryLedger(memories: unknown, position: ChapterPosition | undefined, maxBytes: number): string {
  const source = Array.isArray(memories) ? memories.filter(item => item && typeof item === "object") as Array<Record<string, unknown>> : [];
  const ordered = [...source].sort((left, right) => (memoryChapterNumber(left) || 0) - (memoryChapterNumber(right) || 0));
  const header = position?.number
    ? `当前正在写第 ${position.number} 章${position.total ? `，全书已有 ${position.total} 章` : ""}。`
    : "";
  // 中间大段章节没有记忆（导入的书、旧版本写的章节都可能没有）：
  // 不显式说出来，模型会以为“前文就只有这几章”，然后凭空补写一段从未发生过的历史
  const knownNumbers = ordered.map(memoryChapterNumber).filter((value): value is number => typeof value === "number");
  const gaps = knownNumbers.slice(1)
    .map((number, index) => [knownNumbers[index] + 1, number - 1] as const)
    .filter(([from, to]) => to - from >= 2)
    .sort((left, right) => (right[1] - right[0]) - (left[1] - left[0]));
  const gapNote = knownNumbers.length > 0 && gaps.length > 0
    ? `注意：第 ${gaps[0][0]}–${gaps[0][1]} 章没有章节记忆，这段剧情不在下面的清单里，只能以总纲、章纲和记忆文档为准，不得凭空补写这一段发生过什么。`
    : "";
  const seen = new Set<string>();
  const foreshadowing = ordered
    .flatMap(memory => {
      const items = compactForeshadowingItems(memory.foreshadowingItems, 8);
      if (items.length) return items;
      // 结构化伏笔要模型额外填一个带 status 的字段，实际几乎总是空的（整个项目 12 章一条都没写）
      // 退回到每章都有的伏笔文字，否则“未回收伏笔”永远为空，模型就永远不知道有线索要回收
      const number = memoryChapterNumber(memory);
      const changes = Array.isArray(memory.foreshadowingChanges) ? memory.foreshadowingChanges : [];
      return changes.map(text => compactText(text, 150)).filter(Boolean)
        // 启发式猜出来的伏笔经常是对话残句（以引号开头），列进账本只会干扰
        .filter(text => text.length >= 6 && !/^["“”‘’]/u.test(text))
        .map(text => `第 ${number || "?"} 章：${text}`);
    })
    .filter(item => (seen.has(item) ? false : (seen.add(item), true)))
    .slice(-10);
  const foreshadowingBlock = foreshadowing.length
    ? `未回收伏笔（推进或回收它们，不要再埋同类线）：\n${foreshadowing.map(item => `- ${item}`).join("\n")}`
    : "";
  let remaining = maxBytes - byteLength(header) - byteLength(gapNote) - byteLength(foreshadowingBlock) - 80;
  const events: string[] = [];
  for (const memory of [...ordered].reverse()) {
    const summary = compactText(memory.summary || "", 220);
    if (!summary) continue;
    const number = memoryChapterNumber(memory);
    const label = number ? `第 ${number} 章` : compactText(memory.title || "前文章节", 60);
    const hook = compactText(memory.endingHook || "", 90);
    const line = `- ${label}：${summary}${hook ? `（章末：${hook}）` : ""}`;
    if (byteLength(line) > remaining) break;
    events.unshift(line);
    remaining -= byteLength(line) + 1;
  }
  const eventsBlock = events.length ? `已发生事件（一章一行，本章不得再写一遍）：\n${events.join("\n")}` : "";
  return [header, gapNote, eventsBlock, foreshadowingBlock].filter(Boolean).join("\n\n");
}

function compactSkills(skills: unknown, instruction: string, maxBytes: number): Array<{ name: string; displayName?: string; category: string; description: string; tags: string[]; content: string }> {
  const source = Array.isArray(skills) ? skills.filter(item => item && typeof item === "object") : [];
  const query = instruction.toLowerCase();
  const ranked = source.map(item => {
    const skill = item as Record<string, unknown>;
    const tags = Array.isArray(skill.tags) ? skill.tags.filter((tag): tag is string => typeof tag === "string") : [];
    const terms = [skill.name, skill.displayName, skill.category, skill.description, ...tags].join(" ").toLowerCase();
    return { skill, tags, score: relevanceScore(terms, query) };
  }).sort((left, right) => right.score - left.score || String(left.skill.name || "").localeCompare(String(right.skill.name || "")));
  let remaining = maxBytes;
  const packed: Array<{ name: string; category: string; description: string; tags: string[]; content: string }> = [];
  const writingRequest = /章节|正文|续写|创作|写作|下一章/u.test(instruction);
  const priorityNames = writingRequest
    ? ["chapter-continuity", "next-chapter-plan"]
    : [];
  const priority = priorityNames
    .map(name => ranked.find(item => String(item.skill.name || "") === name))
    .filter((item): item is (typeof ranked)[number] => Boolean(item));
  const ordered = [...priority, ...ranked.filter(item => !priorityNames.includes(String(item.skill.name || "")))];
  for (const { skill, tags } of ordered.slice(0, 12)) {
    if (remaining < 120) break;
    const name = compactText(skill.displayName || skill.name || "技能", 90);
    const category = compactText(skill.category || "write", 40);
    const description = compactText(skill.description || "", 160);
    const contentLimit = skill.name === "chapter-continuity" ? 1800 : 700;
    const content = compactText(skill.content || "", Math.max(100, Math.min(contentLimit, remaining - byteLength(name) - byteLength(description) - 50)));
    packed.push({ name, category, description, tags: compactList(tags, 8, 50), content });
    remaining -= byteLength(name) + byteLength(category) + byteLength(description) + byteLength(content) + 60;
  }
  return packed;
}

export function prepareChapterInput(input: {
  instruction: string;
  outline?: unknown;
  outlines?: unknown;
  activeOutlineId?: unknown;
  cards?: unknown;
  previousChapters?: unknown;
  memories?: unknown;
  memoryDocuments?: unknown;
  knowledgeGraph?: unknown;
  skills?: unknown;
  contextWindowKTokens?: number;
  chapterPosition?: ChapterPosition;
}): PreparedChapterInput {
  const budgetBytes = contextBudgetBytes(input.contextWindowKTokens);
  const contextProfile = resolveContextProfile(input.instruction);
  const weights = CONTEXT_PROFILE_WEIGHTS[contextProfile];
  const allOutlines = Array.isArray(input.outlines)
    ? input.outlines.filter(item => item && typeof item === "object") as ContextOutline[]
    : input.outline ? [{ kind: "作品大纲", title: "作品大纲", content: String(input.outline) }] : [];
  // Canon is fixed by the author and must stay outside relevance sorting so it
  // remains a stable upstream prompt-cache prefix across chapter requests.
  const worldSetting = allOutlines
    .filter(item => item.kind === "世界观与作品设定" && String(item.content || "").trim())
    .sort((left, right) => String(left.id ?? left.title ?? "").localeCompare(String(right.id ?? right.title ?? ""), "zh-CN"))
    .map(item => `## ${compactText(item.kind || "世界观与作品设定", 80)}\n${compactText(item.content, 6000)}`)
    .join("\n\n");
  // 总纲不参与相关度排序，也不走头尾截断：它有自己的骨架加相关段落的压法
  const masterOutlineSource = allOutlines
    .filter(item => item.kind === "总纲" && String(item.content || "").trim())
    .sort((left, right) => String(left.id ?? left.title ?? "").localeCompare(String(right.id ?? right.title ?? ""), "zh-CN"))
    .map(item => String(item.content))
    .join("\n\n");
  const outlines = allOutlines.filter(item => item.kind !== "世界观与作品设定" && item.kind !== "总纲");
  const cards = Array.isArray(input.cards) ? input.cards.filter(item => item && typeof item === "object") as ContextCard[] : [];
  const raw = {
    outline: allOutlines,
    cards,
    previousChapters: input.previousChapters,
    memories: input.memories,
    memoryDocuments: input.memoryDocuments,
    knowledgeGraph: input.knowledgeGraph,
    skills: input.skills,
  };
  const sourceBytes = byteLength(JSON.stringify(raw));
  const text = queryText(input.instruction, outlines, Array.isArray(input.memories) ? input.memories as Array<Record<string, unknown>> : [], cards);
  const masterOutline = compactMasterOutline(masterOutlineSource, text, masterOutlineBytes, input.chapterPosition?.number);
  const storyLedger = buildStoryLedger(input.memories, input.chapterPosition, storyLedgerBytes);
  const outline = compactOutlines(outlines, input.activeOutlineId, text, Math.floor(budgetBytes * weights.outline));
  const packedCards = compactCards(cards, text, Math.floor(budgetBytes * weights.cards));
  const memories = compactMemories(input.memories, Math.floor(budgetBytes * weights.memories));
  const previousChapters = compactPreviousChapters(input.previousChapters, Math.floor(budgetBytes * weights.previousChapters));
  const knowledgeGraph = compactKnowledgeGraph(input.knowledgeGraph, text, Math.floor(budgetBytes * weights.knowledgeGraph));
  const skills = compactSkills(input.skills, input.instruction, Math.floor(budgetBytes * weights.skills));
  // 记忆文档是逐章累计的（第 1 章在最前），所以留尾部而不是头尾都留：
  // 头尾都留会把最老的几章当宝贝带进来，最新的反而被挤掉；额度也跟着窗口走
  const memoryDocumentBytes = Math.max(1600, Math.min(4000, Math.floor(budgetBytes * 0.06)));
  const memoryDocuments = Array.isArray(input.memoryDocuments)
    ? input.memoryDocuments.filter(item => item && typeof item === "object").slice(0, 5).map(item => {
      const document = item as Record<string, unknown>;
      return { kind: compactText(document.kind || "记忆文档", 80), title: compactText(document.title || "", 100), content: tailText(document.content || "", memoryDocumentBytes) };
    })
    : [];
  const sections = {
    worldSetting: byteLength(worldSetting),
    masterOutline: byteLength(masterOutline),
    storyLedger: byteLength(storyLedger),
    outline: byteLength(outline),
    cards: byteLength(JSON.stringify(packedCards)),
    memories: byteLength(JSON.stringify(memories)),
    previousChapters: byteLength(JSON.stringify(previousChapters)),
    knowledgeGraph: byteLength(knowledgeGraph),
    skills: byteLength(JSON.stringify(skills)),
    memoryDocuments: byteLength(JSON.stringify(memoryDocuments)),
  };
  const packedBytes = Object.values(sections).reduce((total, size) => total + size, 0);
  return {
    worldSetting: worldSetting || undefined,
    masterOutline: masterOutline || undefined,
    storyLedger: storyLedger || undefined,
    outline: outline || undefined,
    cards: packedCards,
    previousChapters,
    memories,
    memoryDocuments,
    knowledgeGraph: knowledgeGraph || undefined,
    skills,
    report: {
      cache: "miss",
      sourceBytes,
      packedBytes,
      prunedBytes: Math.max(0, sourceBytes - packedBytes),
      budgetBytes,
      contextProfile,
      sections,
    },
  };
}

export function formatContextReport(report: ContextReport): string {
  const cache = report.cache === "hit" ? "缓存命中" : "缓存未命中";
  const packedKB = (report.packedBytes / 1024).toFixed(1);
  const prunedKB = (report.prunedBytes / 1024).toFixed(1);
  return `${cache}；上下文 ${packedKB} KB，已裁剪 ${prunedKB} KB`;
}
