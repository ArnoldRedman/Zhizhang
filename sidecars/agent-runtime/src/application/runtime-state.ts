import { byteLength, compactText, LruCache, type ContextReport, type PreparedChapterInput } from "../context/context-optimizer.js";

// The desktop process keeps this runtime alive. These caches therefore survive
// normal editor actions without persisting any novel material outside memory.
export const chapterPreparationCache = new LruCache<PreparedChapterInput>(48);
export const chapterMemoryCache = new LruCache<Record<string, unknown>>(96);
export type AgentSessionTurn = {
  instruction: string;
  conclusion: string;
  createdAt: string;
  /** 这一轮写的是哪一章（如 chapter:12）。同一章重跑时用它替换旧轮次，不把废稿堆进会话 */
  turnKey?: string;
};

export type AgentSessionState = {
  version: 1;
  summary: string;
  recentTurns: AgentSessionTurn[];
  compressedAt?: string;
};

export const novelSessionCache = new LruCache<AgentSessionState>(128);
export const outlineSessionCache = new LruCache<AgentSessionState>(96);
export const cardSessionCache = new LruCache<AgentSessionState>(96);

const SESSION_KEEP_TURNS = 2;

export function normalizeAgentSession(value: unknown): AgentSessionState {
  if (typeof value === "string") {
    return { version: 1, summary: compactText(value, 5000), recentTurns: [] };
  }
  if (!value || typeof value !== "object") return { version: 1, summary: "", recentTurns: [] };
  const source = value as Record<string, unknown>;
  return {
    version: 1,
    summary: compactText(source.summary || "", 7000),
    recentTurns: Array.isArray(source.recentTurns)
      ? source.recentTurns.slice(-6).flatMap(turn => {
        if (!turn || typeof turn !== "object") return [];
        const item = turn as Record<string, unknown>;
        const instruction = compactText(item.instruction || "", 2200);
        const conclusion = compactText(item.conclusion || "", 6000);
        return instruction || conclusion ? [{ instruction, conclusion, createdAt: String(item.createdAt || ""), turnKey: typeof item.turnKey === "string" ? item.turnKey : undefined }] : [];
      })
      : [],
    compressedAt: typeof source.compressedAt === "string" ? source.compressedAt : undefined,
  };
}

/** 会话轮次里的“结论”是模型自己的产物，作者未必采用；标明这一点，免得模型把它当成已确认事实 */
const conclusionLabel = "上一轮结果（作者未必采用，与前文冲突时以故事账本和正文为准）";

export function renderAgentSession(state: AgentSessionState): string {
  const parts = [
    state.summary ? `## 已压缩的会话摘要\n${state.summary}` : "",
    state.recentTurns.length ? `## 最近会话轮次\n${state.recentTurns.map((turn, index) => `### 轮次 ${index + 1}\n作者请求：${turn.instruction || "延续上一轮"}\n${conclusionLabel}：${turn.conclusion || "暂无"}`).join("\n\n")}` : "",
  ].filter(Boolean);
  return parts.join("\n\n");
}

export function renderSessionSummary(state: AgentSessionState): string {
  return state.summary ? `## 历史会话摘要\n${state.summary}` : "";
}

export function renderRecentTurns(state: AgentSessionState): string {
  return state.recentTurns.length
    ? `## 最近两轮请求与结论\n${state.recentTurns.map((turn, index) => `### 轮次 ${index + 1}\n作者请求：${turn.instruction || "延续上一轮"}\n${conclusionLabel}：${turn.conclusion || "暂无"}`).join("\n\n")}`
    : "";
}

export function compactAgentSession(state: AgentSessionState, contextWindowKTokens: unknown, baseBytes: number): { state: AgentSessionState; compressed: boolean } {
  const threshold = Math.floor(Math.max(16, Number(contextWindowKTokens) || 128) * 1024 * 0.8);
  const rendered = renderAgentSession(state);
  if (baseBytes + byteLength(rendered) < threshold) return { state, compressed: false };

  const historicTurns = state.recentTurns.slice(0, -SESSION_KEEP_TURNS);
  // 历史轮次从新到旧拼：摘要按头 62%/尾 38% 截，最新的内容必须排在前面，
  // 否则被钉住的是最早那几轮的废稿，模型越写越被旧内容牵着走
  const historicDigest = [...historicTurns].reverse().map(turn => `请求：${compactText(turn.instruction, 500)}\n结论：${compactText(turn.conclusion, 1200)}`).join("\n\n");
  const availableBytes = Math.max(4096, threshold - baseBytes);
  const recentTurnBudget = Math.max(1000, Math.floor(availableBytes * 0.32));
  const recentTurns = state.recentTurns.slice(-SESSION_KEEP_TURNS).map(turn => ({
    instruction: compactText(turn.instruction, Math.max(300, Math.floor(recentTurnBudget * 0.25))),
    conclusion: compactText(turn.conclusion, Math.max(700, Math.floor(recentTurnBudget * 0.75))),
    createdAt: turn.createdAt,
  }));
  // The response itself already contains a model-produced plan/conclusion. Keep
  // that semantic material while collapsing older turns into one durable handoff.
  const summary = compactText([historicDigest, state.summary].filter(Boolean).join("\n\n"), Math.max(1200, Math.floor(availableBytes * 0.3)));
  return {
    compressed: true,
    state: {
      version: 1,
      summary: summary || "此前会话已压缩；后续以最近已确认结论继续。",
      recentTurns,
      compressedAt: new Date().toISOString(),
    },
  };
}

export function appendAgentSession(state: AgentSessionState, instruction: string, conclusion: string, contextWindowKTokens: unknown, baseBytes: number, turnKey?: string): { state: AgentSessionState; compressed: boolean } {
  // 同一章重跑（写偏了、被弃用重来）只保留最新一轮：把废稿当历史记下去，模型下一轮就会被自己的废稿带偏
  const previous = state.recentTurns[state.recentTurns.length - 1];
  const keepTurns = turnKey && previous?.turnKey === turnKey ? state.recentTurns.slice(0, -1) : state.recentTurns;
  const next: AgentSessionState = {
    version: 1,
    summary: state.summary,
    recentTurns: [...keepTurns, {
      instruction: compactText(instruction, 2200),
      conclusion: compactText(conclusion, 6500),
      createdAt: new Date().toISOString(),
      turnKey,
    }],
    compressedAt: state.compressedAt,
  };
  return compactAgentSession(next, contextWindowKTokens, baseBytes);
}

// Byte-stable prompt for compatible upstream prefix caches. Dynamic chapter
// instructions and the editable outline are deliberately sent afterwards.
export const outlineWriterSystemPrompt = `你是这本书的策划。根据作品资料写 Markdown 大纲；世界观与作品设定是作者定的固定规则，只引用不改写。资料里没有的可以自己定，但不能和已有设定冲突；拿不准的写"待揭示"。不写解释性前言。
拿不准或想和作者商量的事，写在输出末尾，每条单独一行，以「【给作者】」开头。`;

/**
 * 章纲的固定栏目
 * 以前是 3.5KB 的番茄爽点模板（情绪曲线 20/50/20/10、爽点拆解、低调装逼），生活流小说也被填成"低调装逼：不在公共场合拆报告"；
 * 章纲只需要回答这一章发生什么、人怎么动、停在哪里，其余交给正文
 */
export const chapterOutlineOutputProtocol = `## 章纲栏目
# 章纲｜第X章 标题

## 这一章发生什么
一件前文没发生过的事（总纲或节拍有安排就按它）；相对上一章过了多久、换没换地方。

## 人物
每个出场人物这一章想要什么、会怎么做、和别人怎么相处；至少一处只有这个人会做的选择或反应。同一场戏里的人对同一件事的反应要不一样，写出各自的说话方式和在意的东西，别让几个人像一个模板刻出来。

## 感情线
主角之间这一章走到哪一步，比上一章多了什么，用哪个具体场面写出来（一次靠近、一句真话、一个只对对方做的动作）；配角章、伏笔章可以写"本章不推进"并说明原因。作品定位是言情、甜宠、日常向的，每章都要有让读者想看两人在一起的段落。

## 场景
按顺序列出，每个场景写地点、人物、发生什么、情绪落在哪里。

## 结尾
停在什么地方（具体的动作、对话或画面）。

只输出 Markdown 章纲正文，不输出技能名、JSON 或分析过程。`;

/**
 * 阶段节拍表：进入一个阶段时先把这几章的事件一次规划好，一章一行
 * 没有它，每章章纲只能从上一章末尾往下顺，一条线越挖越深；有了它，本章那一行就是章纲和正文的目标
 */
export const stageBeatSheetProtocol = `## 阶段节拍表格式
输出一张 Markdown 表格，标题为"# 阶段节拍｜第A～B章"，第二行用一句话写本阶段的目标与结束时的状态。表格每章一行，列固定为：
| 章 | 核心事件（一句话） | 时间与地点（相对上一章） | 人物表现与关系变化 | 感情线推进 | 章末落点 |

几点要求：
1. 相邻两章写不同的事；同一条事件线最多连着两章，之后换到另一条线（事业、生活、关系、配角）再回来。本阶段里要有几次明显的时间跳跃和地点变化。
2. 总纲当前阶段写了什么方向，就把它拆成这几章可写的具体事件；每条线都要有看得见的进展与结果。
3. 已经写过的章（账本里有的）按账本填实际发生的事并在章号后标"（已写）"，只规划还没写的章。
4. 阶段最后一章收束本阶段，章末站到下一阶段的起点；下一阶段的事还没到。
5. 人物表现一栏写出至少一处只有这个人会做的选择或反应，不写"情绪复杂""若有所思"之类的空话；几个人物在同一章里的反应要分得开。
6. 感情线推进一栏写主角之间这一章比上一章多了什么，落到一个具体场面；连续两章不能都写"无"，配角章、伏笔章可以写"不推进"并注明。
只输出标题、一句阶段目标和表格，不输出解释。`;

export function normalizeChapterOutlineOutput(value: string): string {
  let content = String(value || "").trim()
    .replace(/^```(?:markdown|md|text)?\s*/iu, "")
    .replace(/```$/u, "")
    .trim();
  const graphTail = content.search(/^##\s*(?:实体与关系更新|知识图谱更新)\s*$/imu);
  if (graphTail >= 0) content = content.slice(0, graphTail).trim();
  const lines = content.split(/\r?\n/u);
  const seenHeadings = new Set<string>();
  const kept: string[] = [];
  for (const line of lines) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*$/u)?.[1]?.trim();
    if (heading) {
      const key = heading.replace(/[：:｜|]/gu, "").replace(/\s+/gu, "");
      if (seenHeadings.has(key)) break;
      seenHeadings.add(key);
    }
    kept.push(line);
  }
  content = kept.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
  return content;
}

// Kept byte-stable and paired with a separately sent project packet so card
// requests for the same novel can reuse compatible upstream prompt caches.
      export const cardWriterSystemPrompt = `你是长篇小说的知识设定编辑。只根据提供的作品资料生成可长期检索的知识卡，不把推测写成既定事实。
输出必须是严格 JSON 对象，不要代码围栏或额外说明：{"title":"卡片名称","content":"详细 Markdown 内容"}。`;

export const memoryEditorSystemPrompt = `你是长篇小说的记忆编辑。只从章节正文与给定的相关资料抽取明确事实，不补写未发生的剧情。

输出必须是严格 JSON 对象，不要代码围栏或解释。摘要应简短、可检索、包含事件推进、人物状态和未解决线索。实体与关系必须有正文依据；卡片只在状态确有变化且正文能证明时更新。`;

export const memoryStringList = (value: unknown, limit = 40): string[] => Array.isArray(value)
  ? value.map(item => {
      if (typeof item === "string") return item.trim();
      if (!item || typeof item !== "object") return "";
      const entry = item as Record<string, unknown>;
      return compactText(entry.text || entry.content || entry.change || entry.changes || entry.description || entry.name || "", 600).trim();
    }).filter(Boolean).slice(0, limit)
  : typeof value === "string"
    ? value.split(/\r?\n|[；;、]/u).map(item => item.trim()).filter(Boolean).slice(0, limit)
  : [];

export const memoryField = (result: Record<string, unknown>, ...names: string[]): unknown => {
  for (const name of names) {
    const value = result[name];
    if ((Array.isArray(value) && value.length) || (typeof value === "string" && value.trim())) return value;
  }
  return [];
};

export const memoryTypeForDocument = (kind: string): "event" | "character_state" | "canon_fact" | "foreshadowing" | "timeline" => {
  if (kind === "人物状态" || kind === "角色认知") return "character_state";
  if (kind === "伏笔追踪") return "foreshadowing";
  if (kind === "时间线") return "timeline";
  if (kind === "设定事实" || kind === "冲突") return "canon_fact";
  return "event";
};

export const normalizeRelationWeight = (value: unknown, fallback = 0.7): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  const weight = Number.isFinite(parsed) ? parsed : fallback;
  return Math.round(Math.max(0.1, Math.min(1, weight)) * 100) / 100;
};

export const normalizeMemoryResult = (content: string): Record<string, unknown> => {
  try {
    const cleanedResponse = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/u, "").trim();
    const parsed = JSON.parse(cleanedResponse) as Record<string, unknown>;
    const result = typeof parsed.content === "string" && parsed.content.trim().startsWith("{")
      ? (JSON.parse(parsed.content) as Record<string, unknown>)
      : parsed;
    return {
      summary: typeof (result.summary || result.摘要 || result.chapterSummary || result.chapter_summary) === "string" ? String(result.summary || result.摘要 || result.chapterSummary || result.chapter_summary) : content,
      keywords: memoryStringList(memoryField(result, "keywords", "关键词", "key_words"), 8),
      // 人物关系与情绪：感情线唯一的承接依据，没有它记忆里只剩事务
      relationshipState: memoryStringList(memoryField(result, "relationshipState", "relationship_state", "人物关系与情绪", "人物关系", "关系与情绪"), 8),
      readerKnown: memoryStringList(memoryField(result, "readerKnown", "reader_known", "读者已知"), 10),
      authorTruth: memoryStringList(memoryField(result, "authorTruth", "author_truth", "作者真相"), 6),
      nextChapterPromise: typeof (result.nextChapterPromise || result.next_chapter_promise || result.下一章承诺) === "string" ? String(result.nextChapterPromise || result.next_chapter_promise || result.下一章承诺).trim() : "",
      newlyIntroduced: memoryStringList(memoryField(result, "newlyIntroduced", "newly_introduced", "新增物", "本章新增"), 12),
      characterStateChanges: memoryStringList(memoryField(result, "characterStateChanges", "character_state_changes", "characterChanges", "character_changes", "人物状态变化", "人物状态", "角色状态变化")),
      knowledgeChanges: memoryStringList(memoryField(result, "knowledgeChanges", "knowledge_changes", "characterKnowledgeChanges", "roleKnowledgeChanges", "角色认知变化", "角色认知", "认知变化", "知识变化")),
      foreshadowingChanges: memoryStringList(memoryField(result, "foreshadowingChanges", "foreshadowing_changes", "伏笔变化", "伏笔进展")),
      foreshadowingItems: Array.isArray(result.foreshadowingItems) ? result.foreshadowingItems.filter(item => item && typeof item === "object").slice(0, 20).map(item => {
        const entry = item as Record<string, unknown>;
        return {
          text: compactText(entry.text || entry.content || entry.name || "", 260),
          status: String(entry.status || "active").trim(),
          priority: String(entry.priority || "normal").trim(),
          plantedChapter: Number.isFinite(Number(entry.plantedChapter)) ? Number(entry.plantedChapter) : undefined,
          targetChapter: Number.isFinite(Number(entry.targetChapter)) ? Number(entry.targetChapter) : undefined,
        };
      }).filter(item => item.text) : [],
      timelineEvents: memoryStringList(memoryField(result, "timelineEvents", "timeline_events", "时间线事件", "时间线")),
      canonFacts: memoryStringList(memoryField(result, "canonFacts", "canon_facts", "设定事实", "世界观事实")),
      conflicts: memoryStringList(memoryField(result, "conflicts", "冲突", "冲突变化")),
      endingHook: typeof (result.endingHook || result.ending_hook || result.章末钩子 || result.结尾钩子) === "string" ? String(result.endingHook || result.ending_hook || result.章末钩子 || result.结尾钩子).trim() : "",
      entities: Array.isArray(result.entities) ? (result.entities as unknown[]).filter(item => item && typeof item === "object").slice(0, 30).map((item: unknown) => {
        const entity = item as Record<string, unknown>;
        return { name: String(entity.name || "").trim(), type: String(entity.type || "实体").trim() };
      }).filter(item => item.name) : [],
      relations: Array.isArray(result.relations) ? (result.relations as unknown[]).filter(item => item && typeof item === "object").slice(0, 60).map((item: unknown) => {
        const relation = item as Record<string, unknown>;
        return {
          source: String(relation.source || "").trim(),
          target: String(relation.target || "").trim(),
          label: String(relation.label || "关联").trim(),
          weight: normalizeRelationWeight(relation.weight),
        };
      }).filter(item => item.source && item.target) : [],
      cardUpdates: Array.isArray(result.cardUpdates) ? (result.cardUpdates as unknown[]).filter(item => item && typeof item === "object").slice(0, 30).map((item: unknown) => {
        const update = item as Record<string, unknown>;
        return { cardId: typeof update.cardId === "number" || typeof update.cardId === "string" ? update.cardId : undefined, cardTitle: String(update.cardTitle || "").trim(), status: String(update.status || "updated").trim(), changes: String(update.changes || "").trim() };
      }).filter(item => item.cardTitle || item.cardId !== undefined) : [],
    };
  } catch {
    return {
      summary: content.slice(0, 220), keywords: [], characterStateChanges: [], knowledgeChanges: [],
      foreshadowingChanges: [], foreshadowingItems: [], timelineEvents: [], canonFacts: [], conflicts: [], endingHook: "", entities: [], relations: [], cardUpdates: [],
    };
  }
};


