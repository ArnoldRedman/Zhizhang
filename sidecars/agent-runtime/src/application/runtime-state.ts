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
export const outlineWriterSystemPrompt = `你是长篇网络小说总策划与章节规划 Agent。根据作品资料编写可直接执行的 Markdown 大纲。
世界观与作品设定是作者确认的只读固定规则，只能引用，不得自动改写、补全或推断变化；保持人物、时间线、设定和知识图谱一致。不要输出解释性前言。未知信息标记为待揭示，不能编造为既定事实。`;

// Chapter outlines have one canonical contract. A user-provided outline may
// supply facts or writing density, but it cannot replace these fields.
export const chapterOutlineOutputProtocol = `## 番茄小说章纲生成器输出协议（必须严格遵守）
仅当类型为“章纲”时使用。参考章纲只能借鉴叙事密度，不能替换以下栏目或字段。

# 章纲｜第X章 标题

## 主线推进
承接自：上一章结尾留下的状态（一句话）
本章推进的总纲节点：____（对照总纲“本章位置”写出本章是本阶段第几章、把主线推进到本阶段的哪一步）
时间与地点位移：____（相对上一章：紧接 / 数小时后 / 次日 / 数日后；同一地点 / 换地点。上一章的场景只占开场，不超过全章两成）
与前文的区别：____（本章核心事件必须是故事账本里没有发生过的新推进，不得重写旧事件）

## 核心爽点类型
主：从打脸、升级、得宝、揭秘、装逼、复仇、收女、差异感、低调装逼、异性倾慕、事业成果、生活流温情、情感推进中选择。
副：从上述类型中选择。本章节拍或总纲位置没有安排揭秘时，不得选揭秘，也不得凭空制造新谜团。

## 情绪曲线
压抑：____（20%）
爆发：____（50%）
余韵：____（20%，必须明确本章释放点）
新危机或新转折：____（10%；可以是关系、生活、事业上的转折，不必是悬案；优先推进或回收已有伏笔，未回收线索多时不要再埋新线）

## 场景划分
场景一：
- 地点：
- 人物：
- 目标：
- 冲突：
- 转折：

场景二（如需要）：
- 地点：
- 人物：
- 目标：
- 冲突：
- 转折：

场景三（如需要）：
- 地点：
- 人物：
- 目标：
- 冲突：
- 转折：

## 人物功能
逐人说明行动、独立作用和状态变化，禁止工具人；每个人的行动方式要符合总纲人物弧和卡片里的性格，写出至少一处只有这个人会做的选择或反应。

## 信息揭示与伏笔
新信息：至少1条。
伏笔：最多1条，优先推进已有伏笔；本章节拍没有安排新谜团时留空。若新埋，必须明确标注“待揭示”，并写出可回收方向。

## 爽点拆解
至少填写其中两项：
- 差异感：
- 低调装逼：
- 异性倾慕：
- 因果铺陈：

## 章末钩子
必须落在具体动作、对话或画面上，形成追读钩子；不得写“欲知后事如何”。

硬性限制：不设固定字数上限，必须优先完整输出所有必要场景、人物功能、信息伏笔、爽点拆解与章末钩子；不得因长度裁剪或半途结束。只输出 Markdown 章纲正文，不输出技能名、知识图谱、实体关系、JSON、分析过程、前言或后记。未知信息写“待揭示”，不得虚构。`;

/**
 * 阶段节拍表：进入一个阶段时先把这几章的事件一次规划好，一章一行
 * 没有它，每章章纲只能从上一章末尾往下顺，一条线越挖越深；有了它，本章那一行就是章纲和正文的硬目标
 */
export const stageBeatSheetProtocol = `## 阶段节拍表输出协议（必须严格遵守）
输出一张 Markdown 表格，标题为“# 阶段节拍｜第A～B章”，第二行用一句话写本阶段的目标与结束时的状态。表格每章一行，列固定为：
| 章 | 核心事件（一句话，本阶段内不得重复） | 时间与地点（相对上一章的位移） | 人物表现与关系变化（按人物弧写出性格） | 章末落点 |

硬性要求：
1. 相邻两章不得围绕同一件文件、同一次交涉、同一个物件或同一个悬案；同一条事件线最多连续占两章，之后必须换到另一条线（事业、生活、关系、配角）再回来。
2. 本阶段至少三处明显的时间跳跃（次日、数日后、一周后），至少两次地点变化；不得整个阶段停在同一间屋子里。
3. 总纲当前阶段写了什么方向，就把它拆成这几章可写的具体事件；生活流、事业、关系三条线在阶段内轮换，每条线都要有可见的进展与结果，不能只留悬念。
4. 已经写过的章（账本里有的）按账本填实际发生的事并在章号后标“（已写）”，只规划还没写的章；账本里的事件不得再安排一遍。
5. 下一阶段与总纲标“待揭示”的内容不得提前兑现；阶段最后一章要把本阶段收束，并让章末站到下一阶段的起点。
6. 人物表现一栏必须写出至少一处只有这个人会做的选择或反应，不写“情绪复杂”“若有所思”之类的空话。
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


