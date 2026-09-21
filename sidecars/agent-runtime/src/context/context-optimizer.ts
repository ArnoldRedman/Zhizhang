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
// 卡片占比是各区里最大的：人物性格、目标、恐惧、相处方式全在卡里，写出来的人有没有个性就看它进没进提示词；
// 上一章只传紧邻一章且另有章尾锚点，不需要三成预算
const CONTEXT_PROFILE_WEIGHTS: Record<ContextProfile, ContextWeights> = {
  剧情: { outline: 0.14, cards: 0.34, memories: 0.22, previousChapters: 0.20, knowledgeGraph: 0.05, skills: 0.05 },
  战斗: { outline: 0.12, cards: 0.36, memories: 0.18, previousChapters: 0.24, knowledgeGraph: 0.05, skills: 0.05 },
  情感: { outline: 0.12, cards: 0.36, memories: 0.24, previousChapters: 0.18, knowledgeGraph: 0.05, skills: 0.05 },
  转场: { outline: 0.16, cards: 0.32, memories: 0.20, previousChapters: 0.22, knowledgeGraph: 0.05, skills: 0.05 },
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

/**
 * 只保留开头，在句末收口
 * 账本里一章一行，摘要的头一两句就是主事件；头尾拼接会在每一行中间留一个裁剪标记，
 * 实测账本里六行事件带了十二个标记，模型读到的是被截成两半的句子
 */
export function leadText(value: unknown, maxBytes: number): string {
  const text = normalizePromptWhitespace(value).replace(/\s*\n\s*/gu, " ");
  if (!text || maxBytes <= 0) return "";
  if (byteLength(text) <= maxBytes) return text;
  const head = sliceToBytes(text, Math.max(0, maxBytes - byteLength("…")));
  const cut = Math.max(head.lastIndexOf("。"), head.lastIndexOf("！"), head.lastIndexOf("？"), head.lastIndexOf("；"));
  // 句末离得太近就整句砍掉，太远就只能截在半句
  return `${cut > head.length * 0.5 ? head.slice(0, cut + 1) : head}…`;
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

/**
 * 单份世界观文档的上限
 * 以前写死 6000 字节头尾截断：作者一份 11.6KB 的《写作风格与反 AI 味规范》，中段"人物声音 DNA"表整段被裁掉，
 * 模型只拿到目录和黑名单词；写出来的人自然没有声音。按窗口给，128K 时一份 24KB，小窗口才退到 8KB
 */
export function worldSettingDocumentBytes(contextWindowKTokens?: number): number {
  const window = Math.max(16, Number(contextWindowKTokens) || 128);
  return Math.max(8000, Math.min(24000, Math.floor(window * 1024 * 3 * 0.07)));
}

/** 总纲和故事账本不占各资料区的加权预算：它们是全书级资料，不该被上一章正文挤掉
 * 章节图与章纲两条路径都按这两个数截，别再各自写一个更小的数二次裁剪 */
export const masterOutlineBytes = 9000;
export const storyLedgerBytes = 4400;

/**
 * 阶段节拍表里本章那一行，连同前一行与后一行
 * 节拍表一章一行（表格行或列表项），行里带“第 N 章”；本章行是硬目标，前后行只用来看承接与不得提前兑现的边界
 */
export function stageBeatLines(content: unknown, chapterNumber: number | undefined): { current: string; previous: string; next: string } {
  const empty = { current: "", previous: "", next: "" };
  if (!chapterNumber) return empty;
  const lines = normalizePromptWhitespace(content).split("\n").filter(line => /第\s*\d{1,4}\s*章/u.test(line) && !/第\s*\d{1,4}\s*[～~\-—–至到]\s*\d{1,4}\s*章/u.test(line));
  const numberOf = (line: string) => Number(/第\s*(\d{1,4})\s*章/u.exec(line)?.[1]);
  const index = lines.findIndex(line => numberOf(line) === chapterNumber);
  if (index < 0) return empty;
  const clean = (line: string | undefined) => (line || "").replace(/^\|\s*|\s*\|$/gu, "").replace(/\s*\|\s*/gu, "｜").trim();
  return { current: clean(lines[index]), previous: clean(lines[index - 1]), next: clean(lines[index + 1]) };
}

/** 资料区预算占比：按 1 token ≈ 3 字节的汉字估算，给各资料区留窗口的 24%
 * 世界观、总纲、账本另算；实测 128K 窗口整包只用了三成，资料裁得太狠比窗口不够更常见 */
const contextBudgetShare = 0.24;
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

/**
 * 旧版按正文里卡名最后一次出现处截 220 字塞进"当前状态"，写的是"第 N 章《…》出现"沈妄"：起眼。医生已经在写……"
 * 这种随机片段。它既不是状态也不是性格，还先占掉卡片预算，把角色卡正文里的性格、目标、恐惧全挤出提示词。
 * 项目里存量的卡片状态几乎全是这种片段，读取时按形状过滤掉，只留记忆提炼写进去的真状态
 */
const heuristicCardState = /出现“[^”]*”：|当前全文未检索到可定位/u;

/** 单张卡的正文上限：角色卡写到性格、目标、关系一般八九 KB，再往上就是流水账了 */
const cardContentBytes = 10000;

function compactCards(cards: ContextCard[], text: string, maxBytes: number): Array<{ type: string; title: string; content: string }> {
  const ranked = cards
    .filter(card => card && card.title?.trim())
    .map(card => ({ card, score: relevanceScore(`${card.title} ${card.currentState || ""} ${card.content || ""}`, text) }))
    .sort((left, right) => right.score - left.score || left.card.title.localeCompare(right.card.title));
  let remaining = maxBytes;
  const packed: Array<{ type: string; title: string; content: string }> = [];
  for (const { card } of ranked.slice(0, 8)) {
    if (remaining < 160) break;
    const history = (card.stateHistory || [])
      .filter(item => !heuristicCardState.test(String(item.changes || "")))
      .slice(-3)
      .map(item => `${compactText(item.chapterTitle || "最近章节", 70)}：${compactText(item.changes || item.status || "", 240)}`)
      .filter(Boolean).join("；");
    const rawState = String(card.currentState || "");
    const state = heuristicCardState.test(rawState) ? "" : compactText(rawState, 600);
    const label = `[${compactText(card.type || "知识卡", 40)}] ${compactText(card.title, 100)}`;
    const fixed = [label, state && `当前状态：${state}`, history && `近期变化：${history}`].filter(Boolean).join("\n");
    // 出场人物的卡尽量整张带入：性格、目标、恐惧、相处方式都在正文中后段，截成几百字节只剩 id 和别名
    const knowledge = compactText(card.content || "", Math.max(120, Math.min(cardContentBytes, remaining - byteLength(fixed) - 20)));
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
function foreshadowingItemEntries(value: unknown, maxItems: number): Array<{ line: string; planted?: number }> {
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
    return [{ line: `[${status}] ${text}${meta ? `（${meta}）` : ""}`, planted: Number.isFinite(planted) && planted > 0 ? planted : undefined }];
  }).slice(0, maxItems);
}

function compactForeshadowingItems(value: unknown, maxItems: number): string[] {
  return foreshadowingItemEntries(value, maxItems).map(entry => entry.line);
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
      // 人物关系与情绪：以前的记忆全是事务（湿度 62、帘纹差半道），感情线没有任何可承接的东西
      relationshipState: compactList(memory.relationshipState, 4, 200),
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
/** 核对清单、格式说明、卖点定位这类流程性段落：占着“下一步”的位置却没写任何剧情 */
const metaOutlineHeading = /(核对|待确认|说明|格式|清单|检查|附录|流程|方法|边界|卖点|爽点|爽感|套路|定位|题材|基调|差异)/u;
/** 卷与阶段标题里手写的章号区间：有它就能按当前章号精确定位，不用猜
 * “第”可省：实测很多总纲写成“### 第四卷：书肆二期与大婚盛典（156～205章）”，旧写法要求“第156”才认，
 * 定位不到就退回词面打分，“接下来必须推进”会落在“市场常见套路与本书差异”这种卖点段落上，模型拿营销表当本章终点 */
const chapterRangeHeading = /(?:第\s*)?(\d{1,4})\s*[～~\-—–至到]\s*(\d{1,4})\s*章/u;

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

type VolumeBlock = { kind: "text"; lines: string[] } | { kind: "stage"; from: number; to: number; lines: string[] };

/**
 * 一行是不是阶段标题
 * 只认标题行与加粗列表项（"### 第178～185章：…""- **第178～185章：…**"）。
 * 表格行"| 阶段起止 | 第199～208章 |"和"- 第189～198章已完成的大婚流程不得改写"这种普通列表项也带区间，
 * 以前都被当成阶段：前者把总览表当成"当前阶段"，后者把"不得改写清单"标成"下一阶段"，真正的逐章条目反而被裁掉
 */
function stageRangeOf(line: string): RegExpExecArray | null {
  const trimmed = line.trim();
  if (trimmed.startsWith("|")) return null;
  const isHeading = /^#{1,6}\s/u.test(trimmed);
  const isBoldItem = /^[-*]\s*\*\*/u.test(trimmed);
  if (!isHeading && !isBoldItem) return null;
  return chapterRangeHeading.exec(trimmed);
}

/** 标题里写的单个章号（"#### 第204章 《西北来的日程表》"）；区间标题不算 */
const singleChapterHeading = /^#{1,6}\s*(?:第\s*)?(\d{1,4})\s*章(?!\s*[～~\-—–至到])/u;

/**
 * 卷内逐章条目：本章那条全文保留，其他章只留标题行
 * 作者在总纲里逐章写了"核心事件、出场人物、章末钩子"，以前整段被头尾截断，第 204、205 章的条目一个字都没进提示词，
 * 模型看不见就只能顺着上一章往下顺；把非本章的条目折成一行标题，本章条目就装得下了
 */
export function collapseOtherChapterEntries(text: string, chapterNumber: number): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  let skipping = false;
  let skipLevel = 0;
  for (const line of lines) {
    const heading = /^(#{1,6})\s/u.exec(line);
    if (heading) {
      const level = heading[1].length;
      const single = singleChapterHeading.exec(line);
      if (single) {
        const number = Number(single[1]);
        skipping = number !== chapterNumber;
        skipLevel = level;
        kept.push(skipping ? `${line.trim()}${number === chapterNumber + 1 ? "（下一章，本章不写它的事）" : number < chapterNumber ? "（已写）" : ""}` : line);
        continue;
      }
      if (skipping && level <= skipLevel) skipping = false;
    }
    if (!skipping) kept.push(line);
  }
  return kept.join("\n");
}

/** 阶段行多半写成“- **第178～185章：研究沉淀与生活回落**”，去掉列表符与加粗只留标题 */
const stageTitle = (stage: VolumeBlock): string => stage.lines[0].replace(/^[-*]\s*/u, "").replace(/\*\*/gu, "").trim();

/**
 * 当前卷按阶段压缩：找出本章所在阶段与下一阶段，其余阶段只留标题行，并给出“本章位置”
 * 把整卷平铺进提示词时，模型面对的是十几个阶段的文字，分不清自己在哪一段、离阶段结束还有几章；
 * 阶段末该收束的事就这样被一章章拖过去。位置是唯一能告诉模型“该走多快”的输入
 */
function compactVolumeByStage(volumeText: string, chapterNumber: number | undefined, maxBytes: number): { text: string; position: string; atVolumeEnd: boolean } {
  const blocks: VolumeBlock[] = [];
  let current: VolumeBlock = { kind: "text", lines: [] };
  volumeText.split("\n").forEach((line, index) => {
    // 首行是卷标题本身，它的章号区间是卷的，不是阶段的
    const range = index > 0 ? stageRangeOf(line) : null;
    if (range) {
      blocks.push(current);
      current = { kind: "stage", from: Number(range[1]), to: Number(range[2]), lines: [line] };
      return;
    }
    if (current.kind === "stage" && /^#{1,6}\s/u.test(line)) {
      blocks.push(current);
      current = { kind: "text", lines: [line] };
      return;
    }
    current.lines.push(line);
  });
  blocks.push(current);
  const stages = blocks.filter((block): block is Extract<VolumeBlock, { kind: "stage" }> => block.kind === "stage");
  if (chapterNumber !== undefined && !stages.length) return { text: compactText(collapseOtherChapterEntries(volumeText, chapterNumber), maxBytes), position: "", atVolumeEnd: false };
  if (!stages.length || chapterNumber === undefined) return { text: compactText(volumeText, maxBytes), position: "", atVolumeEnd: false };
  const currentStage = stages.find(stage => chapterNumber >= stage.from && chapterNumber <= stage.to);
  // 本章不在总纲列出的任何阶段区间内（《穿成恶人前夫后》第178章起就是这种情况：卷区间 156～205，
  // 但卷内只列到第174～177章）：这时按阶段压缩没有意义，反而会把卷内的“关键节点”“埋伏”跟着非当前阶段一起压掉，
  // 整卷原文给出去，只把“本章在哪一段”说清楚
  if (!currentStage) {
    const laterStage = stages.find(stage => stage.from > chapterNumber);
    return {
      text: compactText(collapseOtherChapterEntries(volumeText, chapterNumber), maxBytes),
      position: laterStage
        ? `本章不在总纲已列出的阶段区间内；下一阶段「${stageTitle(laterStage)}」从第 ${laterStage.from} 章开始`
        : `本章不在总纲已列出的阶段区间内（本卷已列出的阶段到第 ${Math.max(...stages.map(stage => stage.to))} 章为止）；这几章的事件顺序以章纲或阶段节拍表为准`,
      atVolumeEnd: false,
    };
  }
  const nextStage = stages[stages.indexOf(currentStage) + 1];
  const ordinal = chapterNumber - currentStage.from + 1;
  const total = currentStage.to - currentStage.from + 1;
  const left = currentStage.to - chapterNumber;
  const rendered = blocks.map(block => {
    if (block.kind === "text") return block.lines.join("\n");
    if (block === currentStage) return `【当前阶段：本章是本阶段第 ${ordinal}/${total} 章${left === 0 ? "，也是最后一章" : `，之后还剩 ${left} 章`}】\n${block.lines.join("\n")}`;
    if (block === nextStage) return `【下一阶段：本章还没到这里】\n${block.lines.join("\n")}`;
    // 其他阶段只留标题行：已完成阶段的细节再多也不是本章的事，更后面的阶段更不能提前写
    return block.lines[0];
  }).map(part => part.trim()).filter(Boolean).join("\n\n");
  const position = `本章位于阶段「${stageTitle(currentStage)}」：第 ${ordinal}/${total} 章${left === 0
    ? `，是本阶段最后一章：本章收束本阶段，章末站到${nextStage ? `下一阶段「${stageTitle(nextStage)}」` : "下一卷"}的起点`
    : `，本阶段还剩 ${left} 章，本章走其中一步`}`;
  return { text: compactText(collapseOtherChapterEntries(rendered, chapterNumber), maxBytes), position, atVolumeEnd: !nextStage };
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
  // 按章号精确定位到卷时，“当前节点/下一步”从卷内阶段里取，不再全书词面打分：
  // 实测词面打分挑中的是伏笔矩阵表格，而真正的下一步（卷内下一阶段）一次都没进过提示词
  let locatedByNumber = false;
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
    let atVolumeEnd = false;
    if (current) {
      const currentBudget = Math.max(240, Math.floor(remaining * 0.6));
      const subtree = outlineSubtreeText(sections, current.section.index, routeIndexes);
      if (located) {
        locatedByNumber = true;
        const byStage = compactVolumeByStage(subtree, chapterNumber, currentBudget);
        atVolumeEnd = byStage.atVolumeEnd;
        blocks.push(`${byStage.position ? `本章位置：${current.section.heading.replace(/^#+\s*/u, "")}；${byStage.position}\n\n` : ""}【当前卷】\n${byStage.text}`);
      } else {
        blocks.push(`【当前卷】\n${compactText(subtree, currentBudget)}`);
      }
    }
    if (next) {
      const left = remaining - byteLength(blocks.join("\n\n")) - 8;
      // 卷末最后一个阶段才需要看下一卷的细节；卷中只留下一卷的标题，省下的预算给当前卷与主线目标
      if (locatedByNumber && !atVolumeEnd) blocks.push(`【下一卷】\n${next.section.heading}`);
      else if (left > 200) blocks.push(`【下一卷】\n${compactText(outlineSubtreeText(sections, next.section.index, routeIndexes), left)}`);
    }
    route = blocks.join("\n\n");
    remaining -= byteLength(route) + 2;
  }

  // 已按章号定位时再带一份全书主线目标：它是校准本章方向的全书级尺度，不是本章任务
  const mainline = locatedByNumber ? sections.find(section => section.heading && /主线/u.test(section.heading) && !routeIndexes.has(section.index)) : undefined;
  const mainlineText = mainline && remaining > 300 ? compactText(outlineSubtreeText(sections, mainline.index), Math.min(remaining, 1500)) : "";
  if (mainlineText) remaining -= byteLength(mainlineText) + 2;
  // 人物成长弧：以前从没进过提示词，写出来的人物只剩动作没有性格；限定二级标题，免得把配角表整段带进来
  const characters = locatedByNumber ? sections.find(section => section.heading && section.level <= 2 && /人物|角色/u.test(section.heading) && /弧|成长|性格/u.test(section.heading) && !routeIndexes.has(section.index)) : undefined;
  const charactersText = characters && remaining > 300 ? compactText(outlineSubtreeText(sections, characters.index), Math.min(remaining, 2600)) : "";
  if (charactersText) remaining -= byteLength(charactersText) + 2;

  const usable = sections.filter(section => section.body
    && !endingOutlineHeading.test(section.heading)
    && !metaOutlineHeading.test(section.heading)
    && !routeIndexes.has(section.index));

  // 当前节点：与本章资料词面最合的段落，正文里已经写出来的东西就在这一段
  // 已经按章号定位到阶段时不再做这一步：卷内阶段就是当前节点与下一步，词面挑出来的段落只会是噪声
  const current = locatedByNumber ? undefined : usable
    .map(section => ({
      section,
      score: (/主线|目标|总览|核心|当前/u.test(section.heading) ? 24 : 0) + bigramOverlap(`${section.heading}\n${section.body}`, text),
    }))
    .sort((left, right) => right.score - left.score || left.section.index - right.section.index)[0]?.section;
  const currentText = current && remaining > 200 ? compactText(`${current.heading}\n${current.body}`, Math.max(160, Math.floor(remaining * 0.6))) : "";
  if (currentText) remaining -= byteLength(currentText) + 2;

  // 接下来必须推进：当前节点之后的第一段正文，本章的终点就落在这里
  const next = locatedByNumber ? undefined : usable.find(section => section.index > (current?.index ?? 0));
  const nextText = next && remaining > 200 ? compactText(`${next.heading}\n${next.body}`, remaining) : "";

  return [
    skeleton,
    route ? `推进路线（本章在【当前卷】里；【下一卷】还没到）：\n${route}` : "",
    mainlineText ? `主线目标（全书级方向）：\n${mainlineText}` : "",
    charactersText ? `人物成长弧（人物在本阶段的性格、局限与关系状态）：\n${charactersText}` : "",
    currentText ? `当前节点（本章的出发点）：\n${currentText}` : "",
    nextText ? `接下来要推进到（本章的终点，再后面的还没到）：\n${nextText}` : "",
  ].filter(Boolean).join("\n\n");
}

/** 事件行统一用“第 N 章 标题”：标题里自带的章号（第一百七十二章）去掉，避免同一章号两种写法 */
const chapterLabel = (memory: Record<string, unknown>): string => {
  const number = memoryChapterNumber(memory);
  const title = compactText(memory.title || memory.chapterTitle || "", 60).replace(/^第\s*[\d一二三四五六七八九十百千零〇两]+\s*章\s*[:：]?\s*/u, "");
  if (!number) return title || "前文章节";
  return title ? `第 ${number} 章 ${title}` : `第 ${number} 章`;
};

/**
 * 故事账本：近期章节的记忆压成"一章一行"的已发生事件清单，更早的章只列标题，再列出未回收伏笔
 * 章节图靠它禁止重复前文、并知道全书写到哪，这是过去"只看上一章"时完全缺失的信息；
 * 超预算时先丢最早的章的摘要（标题仍保留），最近几章和伏笔必须保住
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
    ? `注意：第 ${gaps[0][0]}–${gaps[0][1]} 章没有章节记忆，这段剧情不在下面的清单里，以总纲、章纲和记忆文档为准。`
    : "";
  const seen = new Set<string>();
  const entries = ordered.flatMap(memory => {
    const number = memoryChapterNumber(memory);
    const structured = foreshadowingItemEntries(memory.foreshadowingItems, 8).map(entry => ({ line: entry.line, planted: entry.planted ?? number }));
    if (structured.length) return structured;
    // 结构化伏笔要模型额外填一个带 status 的字段，实际几乎总是空的（整个项目 12 章一条都没写）
    // 退回到每章都有的伏笔文字，否则“未回收伏笔”永远为空，模型就永远不知道有线索要回收
    const changes = Array.isArray(memory.foreshadowingChanges) ? memory.foreshadowingChanges : [];
    return changes.map(text => compactText(text, 150)).filter(Boolean)
      // 启发式猜出来的伏笔经常是对话残句（以引号开头），列进账本只会干扰
      .filter(text => text.length >= 6 && !/^["“”‘’]/u.test(text))
      .map(text => ({ line: `第 ${number || "?"} 章：${text}`, planted: number }));
  }).filter(entry => (seen.has(entry.line) ? false : (seen.add(entry.line), true)));
  // 上一两章刚埋的多半是场景级的未了事项（单子没抽、信没拆、纸药栏空着）：
  // 以前把它们单列成"未了事项"要求开头收束，下一章就再默默摸一下那张单子，章章都停在同一个悬念上，这就是故弄玄虚的循环。
  // 现在只列埋了三章以上的长线伏笔，最多五条；场景待办靠上一章章尾自然承接，不进账本
  const currentNumber = position?.number;
  const longRunning = entries
    .filter(entry => currentNumber === undefined || entry.planted === undefined || currentNumber - entry.planted >= 3)
    .slice(-5);
  const foreshadowingBlock = longRunning.length
    ? `长线伏笔（前文埋下、还没回收的线索；本章顺手推进一条就够，不必逐条处理）：\n${longRunning.map(entry => `- ${entry.line}`).join("\n")}`
    : "";
  const remaining = maxBytes - byteLength(header) - byteLength(gapNote) - byteLength(foreshadowingBlock) - 120;
  // 近期章节带摘要，更早的只列标题：以前装不下的章直接消失，模型以为前文就只有最近六章
  const summaryBudget = Math.floor(remaining * 0.7);
  const events: string[] = [];
  let used = 0;
  let index = ordered.length - 1;
  for (; index >= 0; index -= 1) {
    const memory = ordered[index];
    const summary = leadText(memory.summary || "", 200);
    if (!summary) continue;
    const hook = leadText(memory.endingHook || "", 80);
    const relationship = leadText(compactList(memory.relationshipState, 3, 120).join("；"), 160);
    const line = `- ${chapterLabel(memory)}：${summary}${relationship ? `（人物：${relationship}）` : ""}${hook ? `（章末：${hook}）` : ""}`;
    if (used + byteLength(line) + 1 > summaryBudget) break;
    events.unshift(line);
    used += byteLength(line) + 1;
  }
  let titleBudget = remaining - used;
  const titles: string[] = [];
  for (const memory of ordered.slice(0, index + 1).reverse()) {
    const label = chapterLabel(memory);
    if (byteLength(label) + 2 > titleBudget) {
      if (titles.length) titles.push("……");
      break;
    }
    titles.push(label);
    titleBudget -= byteLength(label) + 2;
  }
  const olderBlock = titles.length ? `更早的章节（只列标题，事件以记忆文档与总纲为准）：${titles.reverse().join("、")}` : "";
  const eventsBlock = events.length ? `已发生事件（近期章节一章一行，这些已经写过了）：\n${events.join("\n")}` : "";
  // 上一章留下的承诺与作者真相：承诺是本章开头必须接住的事；作者真相是读者还不知道的底，写作时只能当背景压着，不能让角色说出来
  const latest = ordered[ordered.length - 1];
  const promise = latest ? leadText(String(latest.nextChapterPromise || ""), 240) : "";
  const promiseBlock = promise ? `上一章留给本章的事（下一章承诺）：${promise}` : "";
  const truths = ordered.slice(-6).flatMap(memory => compactList(memory.authorTruth, 3, 160).map(text => `- ${chapterLabel(memory)}：${text}`));
  const truthBlock = truths.length ? `作者真相（读者还不知道的底，角色不能提前说破）：\n${truths.slice(-6).join("\n")}` : "";
  return [header, gapNote, olderBlock, eventsBlock, promiseBlock, foreshadowingBlock, truthBlock].filter(Boolean).join("\n\n");
}

/**
 * 聚合记忆文档是不是过期的自动生成物
 * 实测一本 205 章的书，"人物状态 / 伏笔追踪 / 时间线"三份文档里是第 50、53 章的启发式句子加上一串"- 暂无"，
 * 被标成手动编辑后再也不刷新，却每章带 9KB 进提示词。条目里一半以上是"暂无"的，就当它不存在；
 * 作者手写的进度快照、文风护栏这类没有"暂无"条目的照常带
 */
export function isStaleMemoryDocument(content: unknown): boolean {
  const bullets = normalizePromptWhitespace(content).split("\n").filter(line => /^[-*]\s/u.test(line));
  if (bullets.length < 4) return false;
  const empty = bullets.filter(line => /^[-*]\s*暂无\s*$/u.test(line)).length;
  return empty / bullets.length >= 0.5;
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
    .map(item => `## ${compactText(item.title || item.kind || "世界观与作品设定", 80)}\n${compactText(item.content, worldSettingDocumentBytes(input.contextWindowKTokens))}`)
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
    ? input.memoryDocuments.filter(item => item && typeof item === "object" && !isStaleMemoryDocument((item as Record<string, unknown>).content)).slice(0, 5).map(item => {
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
