import { ModelApiClient } from "../models/model-api.js";
import { mapWithConcurrency } from "./concurrency.js";

/**
 * 章节标题属于标题栏，不属于正文：模型爱在正文开头补一道 # 标题，存入前拆出来
 * 标题不能直接丢掉——它是模型唯一给出章节名的地方，丢了标题栏就只剩“第 N 章”占位
 * 模型偶尔连写多行重复标题，最多剥 3 行；标题只取第一行
 */
export function splitChapterTitleHeading(value: string): { title: string; content: string } {
  let text = value.trim();
  let title = "";
  for (let round = 0; round < 3; round += 1) {
    const match = /^#{1,3}\s*([^\n]{1,40})\n+/u.exec(text);
    if (!match) break;
    const titleLine = match[1].trim();
    // 只有看起来像章节名才剥（含“第 x 章”或较短且无标点的标题）；避免误伤正文里合法的 Markdown 小节
    const looksLikeChapterTitle = /第[\s\d零一二三四五六七八九十百千两]+章/u.test(titleLine)
      || (titleLine.length > 0 && !/[，。！？；：、“”…—]/u.test(titleLine) && titleLine.length <= 20);
    const rest = text.slice(match[0].length).trim();
    if (!looksLikeChapterTitle || !rest) break;
    if (!title) title = titleLine;
    text = rest;
  }
  return { title, content: text };
}

/** 新建章节时自动生成的编号占位标题，作者和项目 Agent 都还没给这一章起名 */
const numberedPlaceholderTitle = /^第\s*[\d零一二三四五六七八九十百千两]+\s*[章回节]$/u;
/** 连章号都没有的占位标题 */
const blankPlaceholderTitle = /^(?:新章节|未命名章节|无标题)$/u;
/** 标题名前的章号前缀：模型经常把章号数错，章号一律以应用自己的编号为准 */
const chapterNumberPrefix = /^第\s*[\d零一二三四五六七八九十百千两]+\s*[章回节]\s*[：:·、.\-—]?\s*/u;

/** 这一章还没有真正的名字，只有创建时的编号占位 */
export function isPlaceholderChapterTitle(value: string): boolean {
  const current = value.trim();
  return !current || numberedPlaceholderTitle.test(current) || blankPlaceholderTitle.test(current);
}

/**
 * 将中文数字或阿拉伯数字字符串转为正整数
 * 支持 "13", "十三", "二十一", "一百零五", "两百三十四" 等
 */
export function parseChapterNumber(raw: unknown): number | null {
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null;
  }
  if (typeof raw !== "string") return null;
  const str = raw.trim().replace(/\s+/g, "");
  if (!str) return null;
  if (/^\d+$/.test(str)) {
    const n = Number(str);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const digitMap: Record<string, number> = {
    "零": 0, "〇": 0, "0": 0,
    "一": 1, "1": 1,
    "二": 2, "两": 2, "2": 2,
    "三": 3, "3": 3,
    "四": 4, "4": 4,
    "五": 5, "5": 5,
    "六": 6, "6": 6,
    "七": 7, "7": 7,
    "八": 8, "8": 8,
    "九": 9, "9": 9,
  };
  let total = 0;
  let section = 0;
  let currentNum = 0;
  let hasDigit = false;
  for (let i = 0; i < str.length; i += 1) {
    const char = str[i];
    if (char in digitMap) {
      currentNum = digitMap[char];
      hasDigit = true;
    } else if (char === "十") {
      if (!hasDigit && i === 0) currentNum = 1;
      section += (currentNum || (hasDigit ? 0 : 1)) * 10;
      currentNum = 0;
      hasDigit = true;
    } else if (char === "百") {
      section += currentNum * 100;
      currentNum = 0;
      hasDigit = true;
    } else if (char === "千") {
      section += currentNum * 1000;
      currentNum = 0;
      hasDigit = true;
    } else if (char === "万") {
      total += (section + currentNum) * 10000;
      section = 0;
      currentNum = 0;
      hasDigit = true;
    } else {
      return null;
    }
  }
  total += section + currentNum;
  return hasDigit && total > 0 ? total : null;
}

/** 从章节标题中提取章号（支持“第13章”、“第 十三 章”、“第一百二十回”等） */
export function extractChapterNumber(title: string): number | null {
  const match = /^第\s*([\d零〇一二两三四五六七八九十百千0-9\s]+)\s*[章回节]/u.exec(title.trim());
  if (!match) return null;
  return parseChapterNumber(match[1]);
}

/**
 * 用模型写在正文开头的标题行补全章节标题
 * 默认只有占位标题才补，且沿用调用方自己的章号；overwrite 为 true 时允许全书统一定名覆盖
 */
export function applyDraftChapterTitle(currentTitle: string, draftHeading: string, options: { overwrite?: boolean } = {}): string {
  const name = draftHeading.trim().replace(chapterNumberPrefix, "").trim();
  if (!name) return currentTitle;
  const current = currentTitle.trim();
  if (numberedPlaceholderTitle.test(current)) return `${current} ${name}`;
  if (!current || blankPlaceholderTitle.test(current)) return name;
  if (options.overwrite) {
    const prefixMatch = chapterNumberPrefix.exec(current);
    if (prefixMatch) {
      const prefix = prefixMatch[0].replace(/[：:·、.\-—\s]+$/u, "").trim();
      return `${prefix} ${name}`;
    }
    return name;
  }
  return currentTitle;
}

/** 把正整数写成中文章号：151 → 一百五十一，110 → 一百一十，1005 → 一千零五，10 → 十 */
export function formatChineseNumber(value: number): string {
  const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  const units = ["", "十", "百", "千"];
  const n = Math.max(0, Math.floor(value));
  if (n === 0) return "零";
  if (n >= 10000) {
    const rest = n % 10000;
    // 万以下不足千位时要补“零”：一万零五、一万零五十
    const tail = rest === 0 ? "" : (rest < 1000 ? `零${formatChineseNumber(rest)}` : formatChineseNumber(rest));
    return `${formatChineseNumber(Math.floor(n / 10000))}万${tail}`;
  }
  let text = "";
  let pendingZero = false;
  const chars = String(n);
  for (let i = 0; i < chars.length; i += 1) {
    const digit = Number(chars[i]);
    const unit = units[chars.length - 1 - i];
    if (digit === 0) {
      pendingZero = text.length > 0;
      continue;
    }
    if (pendingZero) text += "零";
    pendingZero = false;
    text += `${digits[digit]}${unit}`;
  }
  // 10 到 19 习惯写“十X”而不是“一十X”；一百一十不受影响
  return text.replace(/^一十/u, "十");
}

/**
 * 章号的书写格式：数字用中文还是阿拉伯、“第”“章”与数字之间有没有空格、章号和名字之间用什么隔开
 * 全部从作者已有标题里学，重编时才能和前文保持一致
 */
export interface ChapterNumberStyle {
  digits: "chinese" | "arabic";
  /** “第”和数字之间的字符，通常是空格或空 */
  open: string;
  /** 数字和“章”之间的字符 */
  close: string;
  /** 章号和名字之间的分隔，如空格、“：” */
  separator: string;
}

/** 应用新建章节的占位格式「第 N 章」，没有任何可参考的标题时用它 */
const defaultChapterNumberStyle: ChapterNumberStyle = { digits: "arabic", open: " ", close: " ", separator: " " };

/**
 * 从已有章节标题里学章号格式，取最后一条能解析的：离要重编的章最近的格式最可能是作者现在在用的
 * 传入时调用方应按目录顺序给出、并只给待重编范围之前的标题
 */
export function detectChapterNumberStyle(titles: readonly string[]): ChapterNumberStyle {
  for (let i = titles.length - 1; i >= 0; i -= 1) {
    const match = /^第(\s*)([\d零〇一二两三四五六七八九十百千万]+)(\s*)章(\s*[：:·、.\-—]?\s*)(\S?)/u.exec(titles[i].trim());
    if (!match) continue;
    const [, open, number, close, gap, next] = match;
    return {
      digits: /^\d+$/u.test(number) ? "arabic" : "chinese",
      open,
      close,
      // 章号后面直接接名字（没有任何分隔）时保持紧贴；没有名字可参考时按空格
      separator: next ? gap : (gap || " "),
    };
  }
  return defaultChapterNumberStyle;
}

/** 按学到的格式生成章号前缀，不含名字：formatChapterNumber(151, 中文) → 第一百五十一章 */
export function formatChapterNumber(ordinal: number, style: ChapterNumberStyle): string {
  const number = style.digits === "chinese" ? formatChineseNumber(ordinal) : String(ordinal);
  return `第${style.open}${number}${style.close}章`;
}

/** 去掉章号前缀后剩下的名字部分 */
export function chapterTitleName(title: string): string {
  return title.trim().replace(chapterNumberPrefix, "").trim();
}

export interface ChapterTitleCandidate {
  targetId: number;
  /** 当前标题，通常是「第 N 章」这种占位；生成的名字会接在它后面 */
  currentTitle: string;
  content: string;
  /** 这一章在目录里的位置（从 1 起）；重编章号时以它为准，也是模型回包 index 的首选配对键 */
  ordinal?: number;
}

export interface ChapterTitleEntry {
  targetId: number;
  title: string;
  /** 标题原本写在正文开头（旧版本遗留），应用时要把那行从正文里移走 */
  stripHeading?: boolean;
}

export interface ChapterTitleResult {
  entries: ChapterTitleEntry[];
  /** 从正文里直接捡回来的章数，这部分不花任何模型调用 */
  recovered: number;
  /** 交给模型命名的章数 */
  named: number;
  /** 模型给的标题和当前一模一样、不需要改动的章数：这不是失败，不能报成“没给出可用标题” */
  unchanged: number;
  /** 没能命名的批次原因，交给调用方写进 toolEvents */
  failures: string[];
}

/** 一次批量命名的可选项 */
export interface ChapterTitlesOptions {
  instruction?: string;
  projectTitle?: string;
  /** 给了格式就按各章 ordinal 重编章号；模型只负责名字，章号一律由应用按位置生成 */
  renumber?: ChapterNumberStyle;
  onProgress?: (done: number, total: number) => void;
}

/**
 * 把模型给的名字装成最终标题
 * 重编模式：章号按目录位置生成，名字取模型给的；模型只回了章号没回名字时沿用当前名字（作者要的只是重排编号）
 * 普通模式：沿用当前章号，只换名字
 */
function composeChapterTitle(candidate: ChapterTitleCandidate, draftName: string, renumber?: ChapterNumberStyle): string {
  if (!renumber || !candidate.ordinal) return applyDraftChapterTitle(candidate.currentTitle, draftName, { overwrite: true });
  const name = chapterTitleName(draftName) || chapterTitleName(candidate.currentTitle);
  const prefix = formatChapterNumber(candidate.ordinal, renumber);
  return name ? `${prefix}${renumber.separator}${name}` : prefix;
}

/** 一次模型请求里塞多少章：标题只有十来个字，20 章一批兼顾吞吐与稳定性 */
const TITLE_BATCH_SIZE = 20;
/** 同时发几批：批量命名是纯等待，但并发太高会被上游限流 */
const TITLE_BATCH_CONCURRENCY = 3;
/** 一批全挂后最多再逐章补几次命名：设为 20 确保整批掉队时也能全数重试救回 */
const TITLE_SINGLE_RETRY_LIMIT = 20;

/**
 * 模型回包里的标题行
 * 兼容三种形状：{"index":1,"title":"名"}、{"id":150,"title":"名"}、纯字符串
 */
function collectTitleRows(parsed: unknown): Array<{ index: number | null; id: string; title: string }> {
  const rows: Array<{ index: number | null; id: string; title: string }> = [];
  if (Array.isArray(parsed)) {
    for (const row of parsed) collectTitleRowsInto(row, rows);
    return rows;
  }
  if (!parsed || typeof parsed !== "object") return rows;
  const record = parsed as Record<string, unknown>;
  for (const key of ["titles", "chapters", "items", "results", "data"]) {
    if (Array.isArray(record[key])) {
      for (const row of record[key]) collectTitleRowsInto(row, rows);
      return rows;
    }
  }
  // 有的模型直接把映射当回包：{"9":"夜雨敲窗","10":"口供"}，键是章号
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && value.trim() && /\d/u.test(key)) rows.push({ index: null, id: key, title: value });
  }
  return rows;
}

function collectTitleRowsInto(row: unknown, rows: Array<{ index: number | null; id: string; title: string }>): void {
  if (typeof row === "string") {
    if (row.trim()) rows.push({ index: null, id: "", title: row });
    return;
  }
  if (!row || typeof row !== "object") return;
  const record = row as Record<string, unknown>;
  const title = [record.title, record.chapterTitle, record.name, record["标题"]].find(value => typeof value === "string" && value.trim());
  if (typeof title !== "string" || !title.trim()) return;
  // index/序号 是新约定；旧约定的 id、以及把章号当 id 返回的情况都在这里兼容
  const index = firstNumericField(record.index ?? record["序号"] ?? record.number ?? record.order);
  const id = String(record.id ?? record.targetId ?? record.chapterId ?? "");
  rows.push({ index: index ?? null, id, title });
}

function firstNumericField(value: unknown): number | null {
  return parseChapterNumber(value);
}

/**
 * 把模型回的标题行配到具体章节上
 * 配对按“序号 → 章号（第 N 章里的 N）→ 十几位真实 id → 数量对上时按位置”四层降级：
 * 序号优先看调用方给的目录位置 ordinal（提示词里让模型抄的就是它），其次才是标题里写的章号——
 * 重排过的章目录位置和旧章号不一致，只认旧章号就会整批配不上
 */
function matchTitleRow(row: { index: number | null; id: string }, batch: readonly ChapterTitleCandidate[], used: Set<number>): ChapterTitleCandidate | null {
  const chapterNumber = (candidate: ChapterTitleCandidate) => candidate.ordinal ?? extractChapterNumber(candidate.currentTitle);
  const oldNumber = (candidate: ChapterTitleCandidate) => extractChapterNumber(candidate.currentTitle);
  const free = (predicate: (item: ChapterTitleCandidate, i: number) => boolean) => batch.find((item, i) => !used.has(i) && predicate(item, i));
  if (row.index !== null) {
    const target = free(item => chapterNumber(item) === row.index) || free(item => oldNumber(item) === row.index) || free((_, i) => i + 1 === row.index);
    if (target) return target;
  }
  const rawId = row.id.trim();
  if (rawId) {
    const idNumber = parseChapterNumber(rawId);
    const byExactId = free(item => String(item.targetId) === rawId);
    const byNumber = idNumber !== null ? free((item, i) => chapterNumber(item) === idNumber || oldNumber(item) === idNumber || i + 1 === idNumber) : undefined;
    const target = byExactId || byNumber;
    if (target) return target;
  }
  return null;
}

const titleSystemPrompt = `你是中文长篇网文的责任编辑，正在为已经写好的章节补标题。

要求：
1. 每个标题只概括该章真正发生的事，不得使用别章的情节，不得凭空发明设定。
2. 4 到 14 个汉字，不带“第几章”前缀，不带书名号、引号、句号和省略号。章号由应用自己编，你只负责名字。
3. 同一批里的标题必须互不相同，不要都写成“危机”“转机”这类空词。
4. 严格返回 JSON 对象：{"titles":[{"index":序号,"title":"标题"}]}，不要代码围栏，不要解释。index 直接抄回各章标头里的 index= 后面那个数。
5. 给了几章就返回几条，不要新增或漏掉章节。`;

const singleTitleSystemPrompt = `你是中文长篇网文的责任编辑，正在为刚写完的一章起标题。

要求：
1. 只概括这一章真正发生的事，不得凭空发明设定。
2. 4 到 14 个汉字，不带“第几章”前缀，不带书名号、引号、句号和省略号。
3. 严格返回 JSON 对象：{"title":"标题"}，不要代码围栏，不要解释。`;

/** 正文摘录：开头交代场景、结尾交代钩子，标题基本只靠这两段就能定 */
function titleExcerpt(content: string): string {
  const text = content.trim().replace(/\s*\n\s*\n\s*/gu, "\n");
  if (text.length <= 900) return text;
  return `${text.slice(0, 620)}\n……\n${text.slice(-260)}`;
}

/** 模型给的标题名里常带的多余包装：书名号、引号、句末标点和自己数的章号 */
export function cleanChapterTitleName(value: string): string {
  let name = value.trim().split(/\n/u)[0].trim();
  // “《夜雨敲窗》。”这种套层要反复剥：单轮只能去掉最外一层
  for (let round = 0; round < 4; round += 1) {
    const stripped = name
      .replace(/^[《【\["'“‘（(]+/u, "")
      .replace(/[》】\]"'”’）)]+$/u, "")
      .replace(/[。！？…、；，!?]+$/u, "")
      .trim();
    if (stripped === name) break;
    name = stripped;
  }
  return name.slice(0, 60);
}

/**
 * 给单独一章起标题
 * 章节智能体写完正文后如果没在信封里给出标题，这一章就只剩“第 N 章”占位；
 * 补一次极小的命名请求（几十 token）比让作者自己回头挨章补名划算得多。
 * 失败时返回空串：标题缺失不该让整章正文作废。
 */
export async function generateChapterTitle(
  client: ModelApiClient,
  content: string,
  options: { projectTitle?: string; instruction?: string } = {},
): Promise<string> {
  const excerpt = titleExcerpt(content);
  if (!excerpt) return "";
  try {
    const response = await client.chat([
      { role: "system", content: singleTitleSystemPrompt },
      { role: "user", content: `《${options.projectTitle || "未命名小说"}》刚写完一章。${options.instruction?.trim() ? `\n作者本章要求：${options.instruction.trim().slice(0, 400)}` : ""}\n\n${excerpt}` },
    ], { response_format: { type: "json_object" }, temperature: 0.5, max_tokens: 200, retryAttempts: 2 });
    const cleaned = response.content.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "").trim();
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    const name = [parsed.title, parsed.chapterTitle, parsed["标题"]].find(value => typeof value === "string" && value.trim());
    return typeof name === "string" ? cleanChapterTitleName(name) : "";
  } catch {
    return "";
  }
}

/**
 * 批量补章节标题
 * 分两段走：先把旧版本遗留在正文开头的 # 标题行直接捡回来（零模型调用），
 * 剩下真的没有名字的章节才分批交给模型命名。
 * 一批失败只丢这一批并如实报出来，其余章节照常返回。
 */
/**
 * 配不上的章节逐章补一次命名
 * 单章回包只有 {"title":"名"} 一种形状，出错空间小；一次几十 token，最多重试 TITLE_SINGLE_RETRY_LIMIT 章防失控
 */
async function retrySingles(
  source: { client: ModelApiClient; projectTitle: string },
  missing: readonly ChapterTitleCandidate[],
  options: { instruction?: string; renumber?: ChapterNumberStyle },
): Promise<{ entries: ChapterTitleEntry[]; missing: ChapterTitleCandidate[]; unchanged: number }> {
  if (!missing.length) return { entries: [], missing: [], unchanged: 0 };
  const capped = missing.slice(0, TITLE_SINGLE_RETRY_LIMIT);
  const entries: ChapterTitleEntry[] = [];
  const still: ChapterTitleCandidate[] = missing.slice(TITLE_SINGLE_RETRY_LIMIT);
  let unchanged = 0;
  for (const candidate of capped) {
    const name = await generateChapterTitle(source.client, candidate.content, {
      projectTitle: source.projectTitle,
      instruction: options.instruction,
    });
    if (!name) {
      still.push(candidate);
      continue;
    }
    const title = composeChapterTitle(candidate, name, options.renumber);
    if (title.trim() === candidate.currentTitle.trim()) {
      unchanged += 1;
      continue;
    }
    entries.push({ targetId: candidate.targetId, title: title.slice(0, 160) });
  }
  return { entries, missing: still, unchanged };
}

/** 失败名单里的章号列表，拼进提示语让作者知道再说一次时点哪些章 */
function labelList(missing: readonly ChapterTitleCandidate[]): string {
  const labels = missing.map(item => {
    const chapterNumber = item.ordinal ?? extractChapterNumber(item.currentTitle);
    return chapterNumber !== null ? `第 ${chapterNumber} 章` : (item.currentTitle.trim() || `id=${item.targetId}`);
  });
  return labels.length > 5 ? `${labels.slice(0, 5).join("、")} 等 ${labels.length} 章` : labels.join("、");
}

/** 回包摘要：排查“为什么没配上”时作者至少要能看到模型到底回了什么 */
function responseGlimpse(content: string): string {
  const flat = content.replace(/\s+/gu, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 160)}……` : flat;
}

export async function generateChapterTitles(
  client: ModelApiClient,
  candidates: readonly ChapterTitleCandidate[],
  options: ChapterTitlesOptions = {},
): Promise<ChapterTitleResult> {
  const entries: ChapterTitleEntry[] = [];
  const failures: string[] = [];
  const pending: ChapterTitleCandidate[] = [];
  let recovered = 0;
  let unchanged = 0;

  for (const candidate of candidates) {
    const draft = splitChapterTitleHeading(candidate.content);
    if (!draft.title) {
      if (candidate.content.trim()) pending.push(candidate);
      else failures.push(`章节 ${candidate.ordinal ? `#${candidate.ordinal}` : candidate.targetId} 没有正文，无法起名`);
      continue;
    }
    // 正文开头本来就写着标题：搬到标题栏并把那一行从正文里移走，不需要问模型
    const title = options.renumber ? composeChapterTitle(candidate, draft.title, options.renumber) : applyDraftChapterTitle(candidate.currentTitle, draft.title);
    entries.push({ targetId: candidate.targetId, title: title.slice(0, 160), stripHeading: true });
    recovered += 1;
  }
  options.onProgress?.(recovered, candidates.length);

  const batches: ChapterTitleCandidate[][] = [];
  for (let index = 0; index < pending.length; index += TITLE_BATCH_SIZE) {
    batches.push(pending.slice(index, index + TITLE_BATCH_SIZE));
  }
  let done = recovered;
  const extra = options.instruction?.trim() ? `\n作者额外要求：${options.instruction.trim()}` : "";
  const singleFallbackClient = { client, projectTitle: options.projectTitle || "" };
  const retryOptions = { instruction: options.instruction, renumber: options.renumber };

  const batchResults = await mapWithConcurrency(batches, TITLE_BATCH_CONCURRENCY, async batch => {
    // 标头里的 index 就是配对键：优先用目录位置，没有就用标题里的章号，再没有才按批内顺序
    const listing = batch
      .map((item, i) => {
        const indexLabel = String(item.ordinal ?? extractChapterNumber(item.currentTitle) ?? i + 1);
        return `### index=${indexLabel}｜当前标题：${item.currentTitle.trim() || "（无）"}\n${titleExcerpt(item.content)}`;
      })
      .join("\n\n");
    const produced: ChapterTitleEntry[] = [];
    const missing: ChapterTitleCandidate[] = [];
    let batchUnchanged = 0;
    // 记下这一批为什么有章没配上，最后报给作者，而不是笼统一句“没给出可用标题”
    let reason = "";
    try {
      const response = await client.chat([
        { role: "system", content: titleSystemPrompt },
        { role: "user", content: `《${options.projectTitle || "未命名小说"}》需要补标题的章节共 ${batch.length} 章。${extra}\n\n${listing}` },
      ], { response_format: { type: "json_object" }, temperature: 0.5, max_tokens: 2000, retryAttempts: 3 });
      const cleaned = response.content.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "").trim();
      const parsed = JSON.parse(cleaned) as unknown;
      const rows = collectTitleRows(parsed);
      const used = new Set<number>();
      const leftovers: Array<{ index: number | null; id: string; title: string }> = [];
      const accept = (candidate: ChapterTitleCandidate, rawTitle: string) => {
        const name = cleanChapterTitleName(rawTitle);
        if (!name) return;
        used.add(batch.indexOf(candidate));
        const title = composeChapterTitle(candidate, name, options.renumber);
        if (title.trim() === candidate.currentTitle.trim()) {
          batchUnchanged += 1;
          return;
        }
        produced.push({ targetId: candidate.targetId, title: title.slice(0, 160) });
      };
      for (const row of rows) {
        const candidate = matchTitleRow(row, batch, used);
        if (!candidate) {
          // 配不上的行先攒着：数量对得上时按位置兑底，一行都别浪费
          leftovers.push(row);
          continue;
        }
        accept(candidate, row.title);
      }
      // 模型不带任何键、纯按顺序回标题时（或键写错时）：尽量按顺序对齐匹配未命中的章节
      const unmatched = batch.filter((_, i) => !used.has(i));
      if (leftovers.length > 0 && unmatched.length > 0) {
        const pairCount = Math.min(leftovers.length, unmatched.length);
        for (let i = 0; i < pairCount; i += 1) accept(unmatched[i], leftovers[i].title);
      }
      for (let i = 0; i < batch.length; i += 1) if (!used.has(i)) missing.push(batch[i]);
      if (missing.length) {
        reason = rows.length
          ? `批量回包 ${rows.length} 行只配上 ${batch.length - missing.length}/${batch.length} 章`
          : `批量回包里没有标题行，回包开头：${responseGlimpse(response.content)}`;
      }
    } catch (error) {
      missing.push(...batch);
      // 整批异常时还没做过逐章重试，标记出来交给收尾统一救一次
      return { produced, missing, unchanged: batchUnchanged, needsRescue: true, failure: `一批 ${batch.length} 章命名失败：${describeTitleError(error)}` };
    } finally {
      done += batch.length;
      options.onProgress?.(Math.min(done, candidates.length), candidates.length);
    }
    // 批量回包没配上的章节逐章补一次：几百 token 一章的小请求，比让作者自己挨章补名划算
    const retried = await retrySingles(singleFallbackClient, missing, retryOptions);
    const failure = retried.missing.length ? `${labelList(retried.missing)} 模型没给出可用标题（${reason}，逐章重试也没拿到名字），可以再说一次只处理这几章` : "";
    return { produced: [...produced, ...retried.entries], missing: retried.missing, unchanged: batchUnchanged + retried.unchanged, needsRescue: false, failure };
  });

  let named = 0;
  const stillMissing: ChapterTitleCandidate[] = [];
  for (const result of batchResults) {
    entries.push(...result.produced);
    named += result.produced.length;
    unchanged += result.unchanged;
    if (result.needsRescue) stillMissing.push(...result.missing);
    if (result.failure) failures.push(result.failure);
  }
  // 整批异常（网络/JSON 挂掉）的批次在 catch 里跳过了逐章重试，这里统一救一次；批内已经重试过的不再重复调模型
  if (stillMissing.length) {
    const rescued = await retrySingles(singleFallbackClient, stillMissing, retryOptions);
    entries.push(...rescued.entries);
    named += rescued.entries.length;
    unchanged += rescued.unchanged;
    if (rescued.missing.length) failures.push(`${labelList(rescued.missing)} 模型没给出可用标题，可以再说一次只处理这几章`);
  }
  return { entries, recovered, named, unchanged, failures };
}

/** 命名失败时给一句能照着做的话，而不是只丢一句“网络错误” */
function describeTitleError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/JSON|Unexpected token/iu.test(message)) return `${message}（模型没按 JSON 返回，重跑一次通常就好）`;
  return message;
}
