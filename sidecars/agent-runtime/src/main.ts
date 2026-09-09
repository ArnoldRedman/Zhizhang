#!/usr/bin/env node
import { createChapterGraph, selectSkillsByIntent, type SkillDefinition } from "./graphs/chapter-write.graph.js";
import { StoryStore } from "./storage/story-store.js";
import { ModelApiClient, getRuntimeUsageSummary, normalizeWireMode } from "./models/model-api.js";
import { StreamEmitter } from "./streaming/stream-handler.js";
import { byteLength, compactKnowledgeGraph, compactText, contextBudgetBytes, prepareChapterInput, stableHash, type ContextReport, type PreparedChapterInput } from "./context/context-optimizer.js";
import { appendAgentSession, cardSessionCache, chapterMemoryCache, chapterPreparationCache, compactAgentSession, memoryEditorSystemPrompt, memoryField, memoryStringList, memoryTypeForDocument, normalizeAgentSession, normalizeMemoryResult, normalizeRelationWeight, novelSessionCache, outlineSessionCache, renderAgentSession, renderRecentTurns, renderSessionSummary, cardWriterSystemPrompt, chapterOutlineOutputProtocol, outlineWriterSystemPrompt, normalizeChapterOutlineOutput, type AgentSessionState } from "./application/runtime-state.js";
import { readPersistentContext, readPersistentDocument, writePersistentContext, writePersistentDocument } from "./context/persistent-context-cache.js";
import { runProjectAgent, type ProjectAgentCardRequest, type ProjectAgentChapterRequest, type ProjectAgentChapterRetitleRequest, type ProjectAgentChapterReviseRequest, type ProjectAgentChapterSplitRequest, type ProjectAgentOutlineRequest } from "./project-agent.js";
import { createModelApiClient, networkProxyConfig, stringList } from "./application/model-client.js";
import { applyDraftChapterTitle, detectChapterNumberStyle, generateChapterTitle, generateChapterTitles, isPlaceholderChapterTitle } from "./application/chapter-titles.js";
import { planChapterSplits } from "./application/chapter-split.js";
import { RpcRegistry, type RuntimeRpcRequest } from "./rpc/registry.js";
import { registerModelHandlers } from "./rpc/model-handlers.js";
import { registerLibraryHandlers } from "./rpc/library-handlers.js";
import { registerContentHandlers } from "./rpc/content-handlers.js";
import { registerTextHandlers } from "./rpc/text-handlers.js";
import type { RpcResponse } from "@zhizhang/contracts";

async function handleLegacyRequest(req: RuntimeRpcRequest): Promise<RpcResponse> {
  try {
    if (req.method === "memory.write") {
      const { projectTitle, chapterTitle, content, cards, knowledgeGraph, apiKey, baseURL, model, apiMode, reasoningMode, contextWindow } = req.params ?? {};
      if (!chapterTitle || !content || !apiKey) {
        return { id: req.id, error: { code: -32602, message: "Missing required params" } };
      }
      const memoryBudgetBytes = contextBudgetBytes(Number(contextWindow) || undefined, 20, 8);
      const chapterContent = compactText(content, memoryBudgetBytes);
      const rawCards = Array.isArray(cards) ? cards.filter(card => card && typeof card === "object") as Array<Record<string, unknown>> : [];
      // A card that is neither named in this chapter nor selected by graph context cannot change here.
      const relevantCards = rawCards.filter(card => {
        const title = String(card.title || "").trim();
        return title.length > 0 && String(content).includes(title);
      }).slice(0, 10);
      const graphSummary = compactKnowledgeGraph(
        knowledgeGraph,
        `${String(chapterTitle)}\n${chapterContent}\n${relevantCards.map(card => String(card.title || "")).join(" ")}`,
        2400,
      );
      const memoryCacheKey = stableHash({
        projectTitle: String(projectTitle || ""), chapterTitle: String(chapterTitle), content: String(content),
        cards: relevantCards.map(card => ({ id: card.id, title: card.title, state: card.currentState, updatedAt: card.updatedAt })),
        graphSummary, model: String(model || "gpt-5.5"), apiMode: String(apiMode || "openai"),
      });
      const cachedMemory = chapterMemoryCache.get(memoryCacheKey) || await readPersistentContext<Record<string, unknown>>(`memory-${memoryCacheKey}`);
      if (cachedMemory) {
        chapterMemoryCache.set(memoryCacheKey, cachedMemory);
        const cachedReport: ContextReport = {
          cache: "hit",
          sourceBytes: byteLength(JSON.stringify({ content, cards: rawCards, knowledgeGraph })),
          packedBytes: byteLength(chapterContent) + byteLength(graphSummary),
          prunedBytes: Math.max(0, byteLength(JSON.stringify({ content, cards: rawCards, knowledgeGraph })) - byteLength(chapterContent) - byteLength(graphSummary)),
          budgetBytes: memoryBudgetBytes,
          sections: { chapter: byteLength(chapterContent), cards: 0, knowledgeGraph: byteLength(graphSummary) },
        };
        return { id: req.id, result: { ...cachedMemory, contextReport: cachedReport } };
      }
      const client = createModelApiClient(req.params ?? {}, { model: "gpt-5.5" });
      const cardContext = Array.isArray(cards) && cards.length
        ? `\n## 已有卡片及当前状态（仅更新正文有证据的卡片）\n${cards.map(card => { const item = card as Record<string, unknown>; return `${String(item.id || "")}|${String(item.title || "卡片")}：${String(item.content || "")}\n当前状态：${String(item.currentState || "暂无")}`; }).join("\n")}`
        : "";
      const graphContext = knowledgeGraph && typeof knowledgeGraph === "object"
        ? `\n## 已有知识图谱（用于增量更新）\n${JSON.stringify(knowledgeGraph).slice(0, 12000)}`
        : "";
      const compactCardContext = relevantCards.length
        ? `\n## 正文命中的卡片（仅可更新这些卡片）\n${relevantCards.map(card => {
          const history = Array.isArray(card.stateHistory) ? card.stateHistory.slice(-2).map(item => {
            const entry = item && typeof item === "object" ? item as Record<string, unknown> : {};
            return compactText(entry.changes || "", 180);
          }).filter(Boolean).join("；") : "";
          return `${String(card.id || "")} | ${compactText(card.title || "卡片", 100)}\n当前状态：${compactText(card.currentState || "暂无", 360)}${history ? `\n近期变化：${history}` : ""}\n知识：${compactText(card.content || "", 720)}`;
        }).join("\n\n")}`
        : "";
      const compactGraphContext = graphSummary ? `\n## 相关知识图谱（用于增量更新）\n${graphSummary}` : "";
      const compactMemoryPrompt = `请为《${String(projectTitle || "未命名小说")}》的${String(chapterTitle)}整理可检索的结构化章节记忆，并从正文抽取有证据的实体、关系和卡片变化。

## 本章正文
${chapterContent}${compactCardContext}${compactGraphContext}

返回 JSON：
{
  "summary": "180 字以内的事件、人物状态和未解决线索",
  "keywords": ["最多 8 个关键词"],
  "characterStateChanges": ["角色名：持续状态变化"],
  "knowledgeChanges": ["角色名：得知或隐瞒的信息"],
  "foreshadowingChanges": ["伏笔进展"],
  "foreshadowingItems": [{"text":"伏笔内容","status":"active|progressing|resolved|overdue","priority":"high|normal|low","plantedChapter":1,"targetChapter":5}],
  "timelineEvents": ["可排序事件"],
  "canonFacts": ["后续必须遵守的事实"],
  "conflicts": ["冲突和结果"],
  "endingHook": "章末未解决事项",
  "entities": [{"name":"实体","type":"人物|物品|地点|势力|事件|设定"}],
  "relations": [{"source":"实体","target":"实体","label":"关系","weight":0.7}],
  "cardUpdates": [{"cardId":"卡片 ID","cardTitle":"卡片名称","status":"changed|acquired|lost|revealed|updated","changes":"有正文依据的变化"}]
}

关系 weight 为 0.1 到 1.0 的正文证据强度：明确行动、身份、持有或状态变化为 0.85 以上；直接提及为 0.65 至 0.8；推断性弱关联不超过 0.6。实体不超过 30 个，关系不超过 60 条；无内容使用空数组或空字符串。`;
      const optimizedResponse = await client.chat([
        { role: "system", content: memoryEditorSystemPrompt },
        { role: "user", content: compactMemoryPrompt },
      ], { response_format: { type: "json_object" }, temperature: 0.2, max_tokens: 1300, retryAttempts: 4 });
        const contextReport: ContextReport = {
        cache: "miss",
        sourceBytes: byteLength(JSON.stringify({ content, cards: rawCards, knowledgeGraph })),
        packedBytes: byteLength(chapterContent) + byteLength(compactCardContext) + byteLength(compactGraphContext),
        prunedBytes: Math.max(0, byteLength(JSON.stringify({ content, cards: rawCards, knowledgeGraph })) - byteLength(chapterContent) - byteLength(compactCardContext) - byteLength(compactGraphContext)),
        budgetBytes: memoryBudgetBytes,
        sections: { chapter: byteLength(chapterContent), cards: byteLength(compactCardContext), knowledgeGraph: byteLength(compactGraphContext) },
      };
      const memoryResult = normalizeMemoryResult(optimizedResponse.content);
      chapterMemoryCache.set(memoryCacheKey, memoryResult);
      void writePersistentContext(`memory-${memoryCacheKey}`, memoryResult);
      return { id: req.id, result: { ...memoryResult, contextReport } };
    }
    if (req.method === "project.agent.chat") {
      const { mode, instruction, project, history, activeChapterId, sessionId, apiKey, baseURL, model, apiMode, reasoningMode, contextWindow } = req.params ?? {};
      if (!apiKey || !instruction || !project || typeof project !== "object") {
        return { id: req.id, error: { code: -32602, message: "缺少项目 Agent 所需的小说、指令或模型配置" } };
      }
      const projectRecord = project as Record<string, unknown>;
      const runId = typeof req.params?.runId === "string" ? req.params.runId : "";
      const emitProjectEvent = (event: Record<string, unknown>) => {
        if (runId) process.stdout.write(JSON.stringify({ type: "agent_stream", runId, event: { ...event, timestamp: Date.now() } }) + "\n");
      };
      emitProjectEvent({ type: "progress", data: { step: "project-search", progress: 8, message: "正在检索全书章节、大纲、卡片、记忆和知识图谱" } });
      const client = createModelApiClient(req.params ?? {}, { model: "gpt-4o-mini" });
      // 三个委托都直接复用应用里已有的专用智能体 RPC，Agent 自己不写内容。
      // `...req.params` 会把 apiKey、skills、writingStyle 等一并带过去，和界面上点按钮走同一条路。
      const projectList = (key: string) => Array.isArray(projectRecord[key])
        ? (projectRecord[key] as unknown[]).filter(item => item && typeof item === "object") as Array<Record<string, unknown>>
        : [];
      const projectKnowledgeGraph = {
        nodes: Array.isArray(projectRecord.graphNodes) ? projectRecord.graphNodes : [],
        edges: Array.isArray(projectRecord.graphEdges) ? projectRecord.graphEdges : [],
      };
      const delegateBase = (suffix: string) => ({
        ...req.params,
        runId: runId ? `${runId}:${suffix}` : "",
        sessionId: `${String(sessionId || "project-agent")}:${suffix}`,
        previousSessionId: "",
        projectId: String(projectRecord.id || "project"),
        projectTitle: String(projectRecord.title || "未命名小说"),
        synopsis: projectRecord.synopsis,
      });
      const delegateResult = async (suffix: string, method: string, params: Record<string, unknown>) => {
        const delegated = await rpcRegistry.dispatch({ id: `${String(req.id)}:${suffix}`, method, params });
        if (delegated.error) throw new Error(delegated.error.message);
        return delegated.result && typeof delegated.result === "object" ? delegated.result as Record<string, unknown> : {};
      };

      const delegateOutline = async (request: ProjectAgentOutlineRequest) => {
        emitProjectEvent({ type: "progress", data: { step: "outline-delegate", progress: 40, message: `已委托大纲智能体处理《${request.title}》` } });
        const outlines = projectList("outlines");
        const target = request.targetId ? outlines.find(item => Number(item.id) === request.targetId) : undefined;
        const result = await delegateResult("outline", "outline.write", {
          ...delegateBase("outline"),
          outlineId: request.targetId,
          kind: request.kind,
          existingContent: String(target?.content || ""),
          instruction: request.instruction,
          cards: projectList("cards"),
          knowledgeGraph: projectKnowledgeGraph,
          worldSetting: outlines.filter(item => String(item.kind || "") === "世界观与作品设定")
            .map(item => ({ id: item.id, title: item.title, content: item.content })),
          authorPreferences: Array.isArray(projectRecord.authorPreferences) ? projectRecord.authorPreferences : [],
        });
        const content = String(result.content || "").trim();
        if (!content) throw new Error("大纲智能体没有返回内容");
        return { type: "outline.upsert" as const, summary: request.summary, targetId: request.targetId, kind: request.kind, title: request.title, content };
      };

      const delegateCard = async (request: ProjectAgentCardRequest) => {
        emitProjectEvent({ type: "progress", data: { step: "card-delegate", progress: 44, message: `已委托卡片智能体处理《${request.title}》` } });
        const cards = projectList("cards");
        const target = request.targetId ? cards.find(item => Number(item.id) === request.targetId) : undefined;
        const activeChapter = projectList("chapters").find(item => String(item.id) === String(activeChapterId));
        const result = await delegateResult("card", "card.write", {
          ...delegateBase("card"),
          cardType: request.cardType,
          cardTitle: request.title,
          existingContent: String(target?.content || ""),
          instruction: request.instruction,
          chapterTitle: activeChapter?.title,
          chapterContent: String(activeChapter?.content || "").slice(-6000),
          outlines: projectList("outlines").slice(-4).map(item => ({ kind: item.kind, content: item.content })),
          cards: cards.filter(item => Number(item.id) !== request.targetId).slice(-8),
        });
        const content = String(result.content || "").trim();
        if (!content) throw new Error("卡片智能体没有返回内容");
        return {
          type: "card.upsert" as const,
          summary: request.summary,
          targetId: request.targetId,
          cardType: request.cardType,
          title: String(result.title || request.title).trim() || request.title,
          content,
          currentState: typeof target?.currentState === "string" ? target.currentState : undefined,
        };
      };

      const delegateChapter = async (request: ProjectAgentChapterRequest) => {
        emitProjectEvent({ type: "progress", data: { step: "chapter-delegate", progress: 32, message: "已委托章节智能体规划并起草下一章" } });
        const chapters = Array.isArray(projectRecord.chapters)
          ? projectRecord.chapters.filter(item => item && typeof item === "object") as Array<Record<string, unknown>>
          : [];
        const outlines = Array.isArray(projectRecord.outlines)
          ? projectRecord.outlines.filter(item => item && typeof item === "object") as Array<Record<string, unknown>>
          : [];
        const memories = Array.isArray(projectRecord.memories)
          ? projectRecord.memories.filter(item => item && typeof item === "object") as Array<Record<string, unknown>>
          : [];
        const nextNumber = chapters.length + 1;
        const title = request.title?.trim() || `第 ${nextNumber} 章`;
        const targetOutline = request.outlineId
          ? outlines.find(item => Number(item.id) === request.outlineId)
          : outlines.find(item => String(item.kind || "") === "章纲" && !chapters.some(chapter => String(chapter.id) === String(item.chapterId)))
            || [...outlines].reverse().find(item => String(item.kind || "") === "章纲");
        const previousChapter = chapters.at(-1);
        const previousMemory = previousChapter
          ? memories.find(item => String(item.chapterId) === String(previousChapter.id))
          : undefined;
        const delegated = await rpcRegistry.dispatch({
          id: `${String(req.id)}:chapter`,
          method: "chapter.write",
          params: {
            ...req.params,
            runId: runId ? `${runId}:chapter` : "",
            sessionId: `${String(sessionId || "project-agent")}:chapter`,
            previousSessionId: "",
            projectId: String(projectRecord.id || "project"),
            projectTitle: String(projectRecord.title || "未命名小说"),
            chapterId: `project-agent-next-${Date.now()}`,
            instruction: request.instruction,
            outline: String(targetOutline?.content || ""),
            outlines,
            activeOutlineId: targetOutline?.id,
            cards: Array.isArray(projectRecord.cards) ? projectRecord.cards : [],
            previousChapters: previousChapter ? [previousChapter] : [],
            memories: previousMemory ? [previousMemory] : [],
            memoryDocuments: Array.isArray(projectRecord.memoryDocuments) ? projectRecord.memoryDocuments : [],
            knowledgeGraph: {
              nodes: Array.isArray(projectRecord.graphNodes) ? projectRecord.graphNodes : [],
              edges: Array.isArray(projectRecord.graphEdges) ? projectRecord.graphEdges : [],
            },
            authorPreferences: Array.isArray(projectRecord.authorPreferences) ? projectRecord.authorPreferences : [],
          },
        });
        if (delegated.error) throw new Error(delegated.error.message);
        const result = delegated.result && typeof delegated.result === "object" ? delegated.result as Record<string, unknown> : {};
        const content = String(result.draftContent || "").trim();
        if (!content) throw new Error("章节智能体没有返回可用正文");
        return {
          type: "chapter.create" as const,
          summary: request.summary,
          // 章节智能体把标题写在正文开头、已被拆成 chapterTitle；项目 Agent 没起名时用它补上，别让标题栏停在占位章号
          title: applyDraftChapterTitle(title, String(result.chapterTitle || "")).slice(0, 160),
          content,
          chapterPlan: typeof result.chapterPlan === "string" ? result.chapterPlan : undefined,
          chapterSummary: typeof result.summary === "string" ? result.summary : undefined,
        };
      };
      // 修订已有章节：走 text.transform 的对应模式，不重跑整张章节写作图，也不会改动其他章节
      // mode 由项目 Agent 判定：polish 只改文字、de-ai 拆机械感、revise 可动情节
      const reviseModeLabels: Record<string, string> = { revise: "修订", polish: "润色", "de-ai": "去 AI 味" };
      const delegateChapterRevise = async (request: ProjectAgentChapterReviseRequest) => {
        const chapters = projectList("chapters");
        const target = chapters.find(item => Number(item.id) === request.targetId);
        if (!target) throw new Error(`找不到待修订的章节 ID ${request.targetId}`);
        const original = String(target.content || "").trim();
        if (!original) throw new Error(`章节《${String(target.title || "")}》没有正文可修订`);
        const mode = request.mode || "revise";
        const label = reviseModeLabels[mode] || "修订";
        emitProjectEvent({ type: "progress", data: { step: "chapter-revise", progress: 36, message: `已委托${label}《${String(target.title || "章节")}》` } });
        const result = await delegateResult(`revise-${request.targetId}`, "text.transform", {
          ...req.params,
          runId: runId ? `${runId}:revise-${request.targetId}` : "",
          mode,
          instruction: request.instruction,
          content: original,
          projectTitle: String(projectRecord.title || "未命名小说"),
          chapterTitle: String(target.title || "当前章节"),
        });
        const content = String(result.content || "").trim();
        if (!content) throw new Error(`${label}智能体没有返回可用正文`);
        return { type: "chapter.update" as const, summary: request.summary, targetId: request.targetId, content };
      };

      /**
       * 批量补章节标题
       * 大部分缺标题的章其实把标题写在了正文开头（旧版本遗留），这部分在 generateChapterTitles 里
       * 直接拆出来，不花任何模型调用；真的没名字的章才分批交给模型命名。
       * 产出合成一条 chapter.titles 变更，而不是几百条提案——否则确认列表根本没法看。
       */
      const delegateChapterTitles = async (request: ProjectAgentChapterRetitleRequest) => {
        const chapters = projectList("chapters");
        const wanted = new Set(request.targetIds.map(id => String(id)));
        // 带上目录位置：模型回包按 index 配对、重编章号都以它为准，而不是标题里可能已经过时的旧章号
        const indexed = chapters.map((item, index) => ({ item, ordinal: index + 1 }));
        const picked = wanted.size
          ? indexed.filter(({ item }) => wanted.has(String(item.id)))
          : indexed.filter(({ item }) => request.scope === "all" || isPlaceholderChapterTitle(String(item.title || "")));
        if (!picked.length) {
          throw new Error(wanted.size ? "指定的章节都不存在" : "没有需要补标题的章节，所有章节都已经有名字");
        }
        // 重编章号时格式跟前文学：取待重编范围之前最近一条能解析的标题
        const renumber = request.renumber
          ? detectChapterNumberStyle(chapters.slice(0, picked[0].ordinal - 1).map(item => String(item.title || "")))
          : undefined;
        emitProjectEvent({ type: "progress", data: { step: "chapter-retitle", progress: 40, message: `正在为 ${picked.length} 章${renumber ? "重编章号并" : ""}补标题` } });
        const result = await generateChapterTitles(client, picked.map(({ item, ordinal }) => ({
          targetId: Number(item.id),
          currentTitle: String(item.title || ""),
          content: String(item.content || ""),
          ordinal,
        })), {
          instruction: request.instruction,
          projectTitle: String(projectRecord.title || "未命名小说"),
          renumber,
          // 命名要跑好几批，每批几十秒；不推进度作者会以为卡死了
          onProgress: (done, total) => emitProjectEvent({
            type: "progress",
            data: { step: "chapter-retitle", progress: Math.min(72, 40 + Math.round(done / Math.max(1, total) * 32)), message: `已处理 ${done}/${total} 章标题` },
          }),
        });
        if (!result.entries.length) {
          // 全部章节标题都已经是目标格式不算失败，但也没有东西可提案，如实说明
          if (result.unchanged === picked.length) throw new Error(`${picked.length} 章的标题已经是目标格式，没有需要改动的`);
          throw new Error(result.failures[0] || "没能生成任何标题");
        }
        const detail = [
          result.recovered ? `${result.recovered} 章从正文开头找回` : "",
          result.named ? `${result.named} 章由模型命名` : "",
          result.unchanged ? `${result.unchanged} 章标题未变` : "",
          ...result.failures,
        ].filter(Boolean).join("；");
        return {
          type: "chapter.titles" as const,
          summary: `${request.summary}（${result.entries.length} 章：${detail}）`.slice(0, 200),
          titles: result.entries,
        };
      };

      /**
       * 批量拆章
       * 切点是纯文本按段落算出来的，正文一个字都不改，也不回传：两边都有正文，
       * 回传十章正文只会把变更归档撑爆。落地时应用按段落序号就地切开。
       */
      const delegateChapterSplit = async (request: ProjectAgentChapterSplitRequest) => {
        const chapters = projectList("chapters");
        const wanted = new Set(request.targetIds.map(id => String(id)));
        const picked = chapters.filter(item => wanted.has(String(item.id)));
        if (!picked.length) {
          throw new Error("要拆分的章节都不存在");
        }
        emitProjectEvent({ type: "progress", data: { step: "chapter-split", progress: 40, message: `正在规划 ${picked.length} 章的拆分` } });
        const result = await planChapterSplits(client, picked.map(item => ({
          targetId: Number(item.id),
          title: String(item.title || ""),
          content: String(item.content || ""),
        })), {
          targetWords: request.targetWords,
          targetParts: request.targetParts,
          instruction: request.instruction,
          projectTitle: String(projectRecord.title || "未命名小说"),
          onProgress: (done, total) => emitProjectEvent({
            type: "progress",
            data: { step: "chapter-split", progress: Math.min(72, 40 + Math.round(done / Math.max(1, total) * 32)), message: `已规划 ${done}/${total} 章` },
          }),
        });
        if (!result.splits.length) {
          throw new Error(result.failures[0] || "这些章节都不需要拆分");
        }
        const added = result.splits.reduce((sum, item) => sum + item.breakAfter.length, 0);
        const detail = [`${result.splits.length} 章拆成 ${result.splits.length + added} 章`, ...result.failures].filter(Boolean).join("；");
        return {
          type: "chapter.parts" as const,
          summary: `${request.summary}（${detail}）`.slice(0, 200),
          splits: result.splits,
        };
      };

      const result = await runProjectAgent({
        mode: mode === "execute" ? "execute" : "discuss",
        instruction: String(instruction),
        project: projectRecord,
        history: Array.isArray(history) ? history as Array<{ role?: unknown; content?: unknown }> : [],
        activeChapterId,
        contextWindowKTokens: contextWindow,
        maxSteps: req.params?.maxSteps,
        // 每次工具调用都推一条进度，让抽屉里能看到它在检索什么
        onStep: step => emitProjectEvent({ type: "progress", data: { step: `project-${step.kind}`, progress: 24, message: step.message } }),
        // 委派阶段是整轮最慢的一段（批量修订能跑十几分钟）；不推进度，界面看起来就是卡死
        onDelegate: event => emitProjectEvent({
          type: "progress",
          data: {
            step: "project-delegate",
            progress: Math.min(96, 48 + Math.round(event.done / Math.max(1, event.total) * 48)),
            message: event.status === "start"
              ? `${event.label}开始处理（${event.done + 1}/${event.total}）`
              : `${event.label}${event.status === "complete" ? "完成" : "失败"}（${event.done}/${event.total}）`,
          },
        }),
      }, client, {
        chapter: delegateChapter,
        chapterRevise: delegateChapterRevise,
        chapterTitles: delegateChapterTitles,
        chapterSplit: delegateChapterSplit,
        outline: delegateOutline,
        card: delegateCard,
      });
      emitProjectEvent({ type: "complete", data: { message: result.changes.length ? `已生成 ${result.changes.length} 项待确认变更` : "项目 Agent 已完成回复" } });
      return { id: req.id, result };
    }
    if (req.method === "card.write") {
      const { projectTitle, synopsis, cardType, cardTitle, existingContent, instruction, chapterTitle, chapterContent, outlines, cards, sessionId, previousSessionId, apiKey, baseURL, model, apiMode, reasoningMode, contextWindow } = req.params ?? {};
      if (!projectTitle || !cardType || !apiKey) {
        return { id: req.id, error: { code: -32602, message: "缺少生成卡片所需参数" } };
      }
      const client = createModelApiClient(req.params ?? {}, { model: "gpt-5.5" });
      const runId = typeof req.params?.runId === "string" ? req.params.runId : "";
      const emitter = new StreamEmitter();
      emitter.subscribe(event => process.stdout.write(JSON.stringify({ type: "agent_stream", runId, event }) + "\n"));
      emitter.progress("draft", 20, "正在整理卡片资料");
      const outlineContext = Array.isArray(outlines) && outlines.length
        ? `## 作品大纲片段\n${outlines.map(outline => outline as Record<string, unknown>).sort((a, b) => String(a.id || a.title || "").localeCompare(String(b.id || b.title || ""), "zh-CN")).map(item => `### ${compactText(item.kind || "大纲", 80)}｜${compactText(item.title || "未命名", 100)}\n${compactText(item.content || "", 3000)}`).join("\n\n")}`
        : "";
      const cardContext = Array.isArray(cards) && cards.length
        ? `## 已有卡片（用于避免重复）\n${cards.map(card => card as Record<string, unknown>).sort((a, b) => String(a.id || a.title || "").localeCompare(String(b.id || b.title || ""), "zh-CN")).map(item => `${compactText(item.title || "卡片", 100)}：${compactText(item.content || "", 600)}`).join("\n")}`
        : "";
      const chapterContext = chapterContent
        ? `## 当前章节片段（用于提取事实）\n${compactText(chapterTitle || "当前章节", 120)}\n${compactText(chapterContent, 10000)}`
        : "";
      const stableProjectPacket = `## 作品资料\n书名：${compactText(projectTitle, 180)}\n作品简介：${compactText(synopsis || "暂无", 1400)}\n\n${[outlineContext, cardContext].filter(Boolean).join("\n\n") || "（暂无已确认大纲或卡片）"}`;
      const cardSessionKey = stableHash({ scope: "card", sessionId: String(sessionId || "default"), projectTitle, cardType, model, apiMode, stableProjectPacket });
      const storedCardSession = await readPersistentContext<unknown>(`card-session-${cardSessionKey}`);
      const inheritedCardSession = cardSessionCache.get(cardSessionKey)
        || (storedCardSession !== undefined ? normalizeAgentSession(storedCardSession) : undefined);
      const previousCardSessionState = previousSessionId && !inheritedCardSession
        ? await readPersistentContext<unknown>(`card-session-${stableHash({ scope: "card", sessionId: String(previousSessionId), projectTitle, cardType, model, apiMode, stableProjectPacket })}`)
        : undefined;
      const resolvedCardSession = inheritedCardSession || (previousCardSessionState !== undefined ? normalizeAgentSession(previousCardSessionState) : undefined);
      const cardDocumentSummary = await readPersistentDocument(`card-session-${cardSessionKey}`);
      const cardSession = compactAgentSession(cardDocumentSummary ? { ...(resolvedCardSession || { version: 1, recentTurns: [] }), summary: cardDocumentSummary } : (resolvedCardSession || { version: 1, summary: "", recentTurns: [] }), contextWindow, byteLength(stableProjectPacket)).state;
      const cardHistorySummary = renderSessionSummary(cardSession);
      const cardRecentTurns = renderRecentTurns(cardSession);
      const dynamicTask = `## 本次卡片任务\n类型：${compactText(cardType, 80)}\n作者指令：${compactText(instruction || "补全卡片知识，保持设定一致", 1800)}\n${cardTitle ? `用户给出的卡片名称：${compactText(cardTitle, 120)}` : "请根据上下文拟定一个准确、简洁的卡片名称。"}${existingContent ? `\n\n## 用户已有草稿\n${compactText(existingContent, 6000)}` : ""}${chapterContext ? `\n\n${chapterContext}` : ""}\n\n内容组织：角色卡写身份、性格、目标、能力、关系、当前状态和秘密；物品卡写来源、外观、能力、代价和持有者；地点卡写环境、势力、规则、资源和危险；势力卡写目标、组织结构、成员、资源和敌对关系；金手指卡写触发条件、能力、限制、升级路径和代价。未知部分明确标为待揭示。`;
      const response = await client.chatStream([
        { role: "system", content: cardWriterSystemPrompt },
        { role: "user", content: stableProjectPacket },
        ...(cardHistorySummary ? [{ role: "user" as const, content: compactText(cardHistorySummary, 7000) }] : []),
        { role: "user", content: dynamicTask },
        ...(cardRecentTurns ? [{ role: "user" as const, content: compactText(cardRecentTurns, 7000) }] : []),
      ], { response_format: { type: "json_object" } }, chunk => emitter.chunk(chunk));
      emitter.complete("卡片内容生成完成");
      const nextCardSession = appendAgentSession(cardSession, String(instruction || "补全卡片知识，保持设定一致"), response.content, contextWindow, byteLength(stableProjectPacket));
      cardSessionCache.set(cardSessionKey, nextCardSession.state);
      void writePersistentContext(`card-session-${cardSessionKey}`, nextCardSession.state);
      void writePersistentDocument(`card-session-${cardSessionKey}`, `# 卡片会话摘要\n\n${nextCardSession.state.summary || "暂无压缩摘要"}`);
      if (nextCardSession.compressed) emitter.progress("draft", 90, "会话动态上下文已超过 80%，已自动压缩为摘要并保留最近两轮");
      try {
        const result = JSON.parse(response.content) as Record<string, unknown>;
        return {
          id: req.id,
          result: {
            title: typeof result.title === "string" ? result.title.trim() : String(cardTitle || `${String(cardType)}设定`),
            content: typeof result.content === "string" ? result.content.trim() : response.content,
          },
        };
      } catch {
        return { id: req.id, result: { title: String(cardTitle || `${String(cardType)}设定`), content: response.content } };
      }
    }
    if (req.method === "outline.write") {
      const { projectTitle, kind, existingContent, instruction, synopsis, cards, knowledgeGraph, worldSetting, skills, preferredSkillNames, sessionId, previousSessionId, outlineId, targetChapter, sourceChapter, formatOutline, apiKey, baseURL, model, apiMode, reasoningMode, contextWindow } = req.params ?? {};
      if (!projectTitle || !kind || !apiKey) {
        return { id: req.id, error: { code: -32602, message: "Missing required params" } };
      }
      const client = createModelApiClient(req.params ?? {}, { model: "gpt-4o-mini" });
      const runId = typeof req.params?.runId === "string" ? req.params.runId : "";
      const emitter = new StreamEmitter();
      emitter.subscribe(event => process.stdout.write(JSON.stringify({ type: "agent_stream", runId, event }) + "\n"));
      emitter.progress("intent", 5, "步骤 1/5：识别大纲目标、正文依据与格式要求");
      const cardSection = Array.isArray(cards) && cards.length > 0
        ? `\n## 相关知识卡片\n${cards.slice(0, 8).map(card => card as Record<string, unknown>).sort((a, b) => String(a.title || "").localeCompare(String(b.title || ""), "zh-CN")).map(item => `### ${compactText(item.title || "卡片", 80)}\n${compactText(item.content || "", 700)}`).join("\n\n")}`
        : "";
      const graphSection = knowledgeGraph && typeof knowledgeGraph === "object"
        ? `\n## 知识图谱约束\n${compactKnowledgeGraph(knowledgeGraph, String(projectTitle), 2800)}\n请保持已有实体和关系一致，新增关系标注为“待揭示”。`
        : "";
      const worldSettingSection = Array.isArray(worldSetting) && worldSetting.length > 0
        ? `\n## 世界观与作品设定（作者确认的固定资料，只可引用，不得改写）\n${worldSetting
          .slice(0, 2)
          .map(item => item && typeof item === "object"
            ? `### ${compactText((item as Record<string, unknown>).title || "世界观与作品设定", 100)}\n${compactText((item as Record<string, unknown>).content || "", 12000)}`
            : "")
          .filter(Boolean)
          .join("\n\n")}\n请以该固定设定为首章创作和后续章纲承接的边界，未知内容标记为“待揭示”。`
        : "";
      const outlineSkillName = kind === "总纲" ? "outline-total-planner" : kind === "章纲" ? "小说章纲生成器" : "world-setting-planner";
      const skillCatalog = Array.isArray(skills) ? skills
        .filter((skill): skill is Record<string, unknown> => Boolean(skill && typeof skill === "object"))
        .map(item => ({
          name: String(item.name || ""), displayName: String(item.displayName || item.name || ""), category: String(item.category || "write"),
          description: String(item.description || ""), tags: stringList(item.tags, 12), content: String(item.content || ""),
        })).filter(item => Boolean(item.name)) as SkillDefinition[]
        : [];
      const targetChapterRecord = targetChapter && typeof targetChapter === "object" ? targetChapter as Record<string, unknown> : undefined;
      const sourceChapterRecord = sourceChapter && typeof sourceChapter === "object" ? sourceChapter as Record<string, unknown> : undefined;
      const formatOutlineRecord = formatOutline && typeof formatOutline === "object" ? formatOutline as Record<string, unknown> : undefined;
      const targetChapterNumber = Number(targetChapterRecord?.number || 0);
      const sourceChapterNumber = Number(sourceChapterRecord?.number || 0);
      const isFirstChapter = kind === "章纲" && targetChapterNumber === 1 && !sourceChapterRecord;
      // The handoff skill is only appropriate for the immediate previous chapter.
      // Current-chapter input is a reverse outline of already written events.
      const isNextChapterHandoff = Boolean(targetChapterNumber && sourceChapterNumber === targetChapterNumber - 1);
      const automaticSelection = selectSkillsByIntent(String(instruction || ""), skillCatalog);
      const preferredNames = stringList(preferredSkillNames, 6);
      const continuityNames = kind === "章纲" && isNextChapterHandoff ? ["章纲承接规范", "next-chapter-plan", "conflict-escalation", "foreshadowing-manager", "ending-hook", "setting-consistency"] : [];
      const matchedSkills = [
        skillCatalog.find(item => item.name === outlineSkillName),
        ...skillCatalog.filter(item => preferredNames.includes(item.name)),
        ...skillCatalog.filter(item => automaticSelection.skills.some(selected => selected.name === item.name) && (item.category === "setup" || continuityNames.includes(item.name))),
        ...(sourceChapter && isNextChapterHandoff ? skillCatalog.filter(item => continuityNames.includes(item.name)) : []),
      ].filter((item, index, list): item is SkillDefinition => Boolean(item) && list.findIndex(candidate => candidate?.name === item?.name) === index).slice(0, 4);
      const recognizedIntent = kind === "章纲" && isNextChapterHandoff
        ? "上一章正文承接并规划下一章"
        : kind === "章纲" && sourceChapterRecord && sourceChapterNumber === targetChapterNumber
          ? "根据本章正文反推本章章纲"
          : kind === "章纲" && sourceChapterRecord ? "根据指定章节正文生成章纲"
            : isFirstChapter ? "首章创作：根据世界观、作品简介与作者指令生成" : automaticSelection.intent;
      emitter.progress("intent", 14, `步骤 1/5：意图识别完成：${recognizedIntent}`);
      emitter.context("intent", `已选技能：${matchedSkills.map(item => item.displayName || item.name).join("、") || "默认大纲规则"}`, { source: "OutlineSkillRouter", status: "selected", items: matchedSkills.length });
      const skillSection = matchedSkills.length
        ? `\n## 本次匹配技能\n${matchedSkills.map(item => `### ${compactText(item.displayName || item.name || "技能", 80)}\n${compactText(item.content || item.description || "", 700)}`).join("\n\n")}`
        : "";
      const stableProjectPacket = `## 作品资料\n书名：${String(projectTitle)}\n作品简介：${compactText(synopsis || "暂无", 1400)}${worldSettingSection}${skillSection}${graphSection}${cardSection}`;
      const outlineSessionKey = stableHash({ scope: "outline", outlineId: String(outlineId || "active"), sessionId: String(sessionId || "default"), projectTitle, kind, model, apiMode, targetChapterId: targetChapterRecord?.id, sourceChapterId: sourceChapterRecord?.id, formatOutlineId: formatOutlineRecord?.id, stableProjectPacket });
      const storedOutlineSession = await readPersistentContext<unknown>(`outline-session-${outlineSessionKey}`);
      const inheritedOutlineSession = outlineSessionCache.get(outlineSessionKey)
        || (storedOutlineSession !== undefined ? normalizeAgentSession(storedOutlineSession) : undefined);
      const previousOutlineSessionState = previousSessionId && !inheritedOutlineSession
        ? await readPersistentContext<unknown>(`outline-session-${stableHash({ scope: "outline", outlineId: String(outlineId || "active"), sessionId: String(previousSessionId), projectTitle, kind, model, apiMode, targetChapterId: targetChapterRecord?.id, sourceChapterId: sourceChapterRecord?.id, formatOutlineId: formatOutlineRecord?.id, stableProjectPacket })}`)
        : undefined;
      const outlineDocumentSummary = await readPersistentDocument(`outline-session-${outlineSessionKey}`);
      const outlineSession = compactAgentSession(outlineDocumentSummary ? { ...(inheritedOutlineSession || { version: 1, recentTurns: [] }), summary: outlineDocumentSummary } : (inheritedOutlineSession || (previousOutlineSessionState !== undefined ? normalizeAgentSession(previousOutlineSessionState) : undefined) || { version: 1, summary: "", recentTurns: [] }), contextWindow, byteLength(stableProjectPacket)).state;
      const outlineHistorySummary = renderSessionSummary(outlineSession);
      const outlineRecentTurns = renderRecentTurns(outlineSession);
      emitter.progress("retrieve", 32, "步骤 2/5：装载唯一正文依据、上一章结尾与格式参考");
      emitter.context("retrieve", "已装载唯一正文依据", { source: sourceChapterRecord ? `第 ${String(sourceChapterRecord.number || "")} 章正文` : "无正文依据", status: "loaded", bytes: byteLength(String(sourceChapterRecord?.content || "")), items: sourceChapterRecord ? 1 : 0 });
      if (formatOutlineRecord) emitter.context("retrieve", "已装载格式参考章纲", { source: String(formatOutlineRecord.title || "参考章纲"), status: "loaded", bytes: byteLength(String(formatOutlineRecord.content || "")), items: 1 });
      const targetSection = targetChapterRecord
        ? `## 目标章（本次要生成的章纲）\n第 ${String(targetChapterRecord.number || "")} 章《${compactText(targetChapterRecord.title || "未命名", 120)}》\n`
        : "";
      const sourceContent = String(sourceChapterRecord?.content || "");
      const sourceHandoff = sourceContent.length > 7000 ? sourceContent.slice(-7000) : sourceContent;
      const sourceSection = sourceChapterRecord
        ? `## 唯一正文依据（优先级最高）\n依据模式：${compactText(sourceChapterRecord.mode || "作者指定", 80)}\n第 ${String(sourceChapterRecord.number || "")} 章《${compactText(sourceChapterRecord.title || "未命名", 120)}》正文：\n${compactText(sourceContent, 26000)}\n\n${isNextChapterHandoff ? `## 章节交接状态（最高优先级，目标章必须从此处之后开始）\n以下是上一章结尾原文：\n${compactText(sourceHandoff, 7000)}\n\n硬性要求：目标章开场只能发生在上述结尾状态之后。上一章已发生的行动、战斗、跟踪发现、资源消耗、人物位置与情绪不得重新规划或倒退；必须承接其结果并推进新的事件。` : sourceChapterNumber === targetChapterNumber ? `## 本章复盘规则\n这是“根据本章正文生成本章章纲”。章纲必须忠实概括正文中已发生的事件、人物状态、冲突、伏笔与结尾；不得把正文结尾之后的计划写成已发生事实，也不得使用“下一章承接”规则。` : `## 指定正文参考规则\n这是指定章节正文的参考分析。只提取该正文可证实的事实；不要把它误当作目标章的上一章，也不要强行制造章节承接。`}\n\n章纲事件、人物状态和结尾承接必须来自这段正文；不得引用其他章节正文，不得把历史会话中的旧章节当作事实。`
        : `## 正文依据\n本次没有提供可用正文。只能生成通用结构，不得声称承接任何具体章节。`;
      const formatSection = formatOutlineRecord
        ? `## 格式参考章纲（仅参考表达密度，不得覆盖固定输出协议）\n参考模式：${compactText(formatOutlineRecord.mode || "上一章章纲格式", 100)}\n${compactText(formatOutlineRecord.title || "参考章纲", 120)}\n${compactText(formatOutlineRecord.content || "", 9000)}\n\n硬性要求：固定输出协议的栏目、顺序和字段名优先；只能参考这份章纲的详略和语气，不得照抄其人物、事件、数字、旧栏目或结尾。`
        : `## 格式要求\n没有可用的参考章纲，请严格使用“小说章纲生成器”技能定义的固定模板。`;
      const dynamicTask = `## 本次大纲任务\n类型：${String(kind)}\n作者指令：${compactText(instruction || "补全结构并强化可执行性", 1800)}\n\n${targetSection}${sourceSection}\n${formatSection}\n${kind === "章纲" ? chapterOutlineOutputProtocol : ""}\n## 当前待完善文档（可被替换的旧草稿，不是事实来源）\n${compactText(existingContent || "暂无", 5000)}\n\n输出该类型的大纲 Markdown 正文。章纲必须严格逐项填写固定输出协议，不能使用旧的“核心主线与目标”“核心冲突与节奏”“分段剧情梗概”“实体与关系更新”等替代栏目。旧草稿若与唯一正文依据或章节交接状态冲突，必须完全丢弃冲突部分并重写。若作者指令与历史会话冲突，以本次目标章、唯一正文依据、固定输出协议和作者指令为准。不要输出分析过程、格式说明或额外前言。`;
      emitter.progress("plan", 48, isNextChapterHandoff ? "步骤 3/5：根据交接状态规划本章事件链与冲突升级" : sourceChapterNumber === targetChapterNumber ? "步骤 3/5：从本章正文提取事件链、冲突与伏笔" : "步骤 3/5：校验指定正文与目标章的事实边界");
      emitter.context("plan", isNextChapterHandoff ? "正在校验上一章结束状态，阻止重复事件" : sourceChapterNumber === targetChapterNumber ? "正在从本章正文提取已发生事件，避免虚构后续" : "正在校验指定正文与目标章的事实边界", { source: isNextChapterHandoff ? "章纲承接规范" : "正文事实校验", status: "loaded", bytes: byteLength(sourceHandoff), items: sourceChapterRecord ? 1 : 0 });
      emitter.progress("draft", 62, "步骤 4/5：调用模型生成章纲正文");
      const response = await client.chatStream([
        { role: "system", content: outlineWriterSystemPrompt },
        { role: "user", content: stableProjectPacket },
        ...(outlineHistorySummary ? [{ role: "user" as const, content: compactText(outlineHistorySummary, 7000) }] : []),
        ...(outlineRecentTurns ? [{ role: "user" as const, content: compactText(outlineRecentTurns, 7000) }] : []),
        // Keep the current target/source packet last so stale session turns
        // cannot override the chapter the author just selected.
        { role: "user", content: dynamicTask },
      ], { max_tokens: kind === "章纲" ? 5000 : 3000, temperature: 0.45, retryAttempts: 2 }, chunk => emitter.chunk(chunk));
      emitter.progress("review", 92, "步骤 5/5：校验章节承接、格式与章末钩子");
      emitter.complete("大纲内容生成完成");
      const nextOutlineSession = appendAgentSession(outlineSession, String(instruction || "补全结构并强化可执行性"), response.content, contextWindow, byteLength(stableProjectPacket));
      outlineSessionCache.set(outlineSessionKey, nextOutlineSession.state);
      void writePersistentContext(`outline-session-${outlineSessionKey}`, nextOutlineSession.state);
      void writePersistentDocument(`outline-session-${outlineSessionKey}`, `# 大纲会话摘要\n\n${nextOutlineSession.state.summary || "暂无压缩摘要"}`);
      if (nextOutlineSession.compressed) emitter.progress("plan", 90, "会话动态上下文已超过 80%，已自动压缩为摘要并保留最近两轮");
      return { id: req.id, result: { content: kind === "章纲" ? normalizeChapterOutlineOutput(response.content) : response.content } };
    }
    if (req.method === "chapter.write") {
      const {
        projectId,
        projectTitle,
        chapterId,
        instruction,
        outline,
        outlines,
        activeOutlineId,
        cards,
        previousChapters,
        memories,
        memoryDocuments,
        knowledgeGraph,
        writingStyle,
        authorPreferences,
        preferredSkillNames,
        apiKey,
        baseURL,
        model,
        apiMode,
        reasoningMode,
        contextWindow,
        sessionId,
        previousSessionId,
      } = req.params ?? {};
      if (!projectId || !chapterId || !instruction || !apiKey) {
        return { id: req.id, error: { code: -32602, message: "Missing required params" } };
      }
      const store = StoryStore.inMemory();
      const runId = typeof req.params?.runId === "string" ? req.params.runId : "";
      const streamEmitter = new StreamEmitter();
      streamEmitter.subscribe(event => {
        process.stdout.write(JSON.stringify({ type: "agent_stream", runId, event }) + "\n");
      });
      streamEmitter.progress("starting", 3, "运行环境已就绪，正在整理本章资料");
      const preparationKey = stableHash({
        projectId, chapterId, instruction, outline, outlines, activeOutlineId, cards,
        previousChapters, memories, memoryDocuments, knowledgeGraph, skills: req.params?.skills, preferredSkillNames,
        contextWindow: Number(contextWindow) || 128,
      });
      const cachedPreparation = chapterPreparationCache.get(preparationKey)
        || await readPersistentContext<PreparedChapterInput>(`chapter-prep-${preparationKey}`);
      const prepared = cachedPreparation || prepareChapterInput({
        instruction: String(instruction), outline, outlines, activeOutlineId, cards, previousChapters,
        memories, memoryDocuments, knowledgeGraph, skills: req.params?.skills,
        contextWindowKTokens: Number(contextWindow) || undefined,
      });
      chapterPreparationCache.set(preparationKey, prepared);
      if (!cachedPreparation) void writePersistentContext(`chapter-prep-${preparationKey}`, prepared);
      const contextReport: ContextReport = {
        ...prepared.report,
        cache: cachedPreparation ? "hit" : "miss",
        sections: { ...prepared.report.sections },
      };
      const sessionKey = stableHash({ projectId: String(projectId), sessionId: String(sessionId || "default"), model: String(model || ""), apiMode: String(apiMode || "openai") });
      const storedChapterSession = await readPersistentContext<unknown>(`chapter-session-${sessionKey}`);
      const cachedChapterSession = novelSessionCache.get(sessionKey)
        || (storedChapterSession !== undefined ? normalizeAgentSession(storedChapterSession) : undefined);
      const previousChapterSession = previousSessionId && !cachedChapterSession
        ? await readPersistentContext<unknown>(`chapter-session-${stableHash({ projectId: String(projectId), sessionId: String(previousSessionId), model: String(model || ""), apiMode: String(apiMode || "openai") })}`)
        : undefined;
      const chapterDocumentSummary = await readPersistentDocument(`chapter-session-${sessionKey}`);
      const chapterSession = compactAgentSession(chapterDocumentSummary ? { ...(cachedChapterSession || { version: 1, recentTurns: [] }), summary: chapterDocumentSummary } : (cachedChapterSession || (previousChapterSession !== undefined ? normalizeAgentSession(previousChapterSession) : undefined) || { version: 1, summary: "", recentTurns: [] }), contextWindow, prepared.report.packedBytes).state;
      const sessionContext = renderAgentSession(chapterSession);
      if (!cachedPreparation && (cachedChapterSession || chapterDocumentSummary || previousChapterSession)) {
        contextReport.cache = "hit";
      }
      streamEmitter.progress("starting", 6, `${cachedPreparation ? "上下文缓存命中" : "上下文缓存未命中"}；已将 ${Math.max(0, contextReport.prunedBytes / 1024).toFixed(1)} KB 无关资料移出本次请求`);
      try {
        const normalizedProjectId = String(projectId);
        store.createProject({ id: normalizedProjectId, title: String(projectTitle || "未命名小说") });
        const chapters = prepared.previousChapters;
        chapters.forEach((chapter, index) => {
          if (!chapter || typeof chapter !== "object") return;
          const item = chapter as Record<string, unknown>;
          const content = String(item.content || "").trim();
          if (!content) return;
          store.saveMemory({
            id: `chapter-memory-${String(item.id || index)}`,
            projectId: normalizedProjectId,
            type: "event",
            title: String(item.title || `第 ${index + 1} 章`),
            content: content.slice(-5000),
            entityNames: [],
            confirmed: true,
            importance: 0.55,
          });
        });
        const memoryItems = prepared.memories;
        memoryItems.forEach((memory, index) => {
          if (!memory || typeof memory !== "object") return;
          const item = memory as Record<string, unknown>;
          const entityNames = Array.isArray(item.keywords)
            ? item.keywords.filter((keyword): keyword is string => typeof keyword === "string")
            : [];
          const title = String(item.title || `章节记忆 ${index + 1}`);
          const save = (suffix: string, type: "event" | "character_state" | "canon_fact" | "foreshadowing" | "timeline", label: string, values: string[], importance: number) => {
            const content = values.join("\n").trim();
            if (!content) return;
            store.saveMemory({
              id: `saved-memory-${String(item.id || index)}-${suffix}`,
              projectId: normalizedProjectId,
              type,
              title: `${title} · ${label}`,
              content,
              entityNames,
              confirmed: true,
              importance,
            });
          };
          save("summary", "event", "章节摘要", [String(item.summary || "")], 0.82);
          save("character-state", "character_state", "人物状态", stringList(item.characterStateChanges), 1);
          save("knowledge", "character_state", "角色认知", stringList(item.knowledgeChanges), 0.98);
          save("foreshadowing", "foreshadowing", "伏笔追踪", stringList(item.foreshadowingChanges), 0.98);
          save("timeline", "timeline", "时间线", stringList(item.timelineEvents), 0.94);
          save("canon", "canon_fact", "设定事实", stringList(item.canonFacts), 0.96);
          save("conflict", "canon_fact", "冲突", stringList(item.conflicts), 0.92);
          save("hook", "foreshadowing", "章末钩子", [typeof item.endingHook === "string" ? item.endingHook : ""], 0.93);
        });
        const documents = prepared.memoryDocuments;
        documents.forEach((document, index) => {
          if (!document || typeof document !== "object") return;
          const item = document as Record<string, unknown>;
          const content = String(item.content || "").trim();
          if (!content) return;
          const kind = String(item.kind || item.title || "章节快照");
          store.saveMemory({
            id: `memory-document-${kind}-${index}`,
            projectId: normalizedProjectId,
            type: memoryTypeForDocument(kind),
            title: `记忆文档 · ${String(item.title || kind)}`,
            content: content.slice(0, 6000),
            entityNames: [],
            confirmed: true,
            importance: kind === "人物状态" || kind === "伏笔追踪" ? 0.99 : 0.9,
          });
        });
        streamEmitter.progress("starting", 8, `已载入 ${chapters.length} 个章节片段、${memoryItems.length} 条章节记忆；上下文包 ${Math.ceil(contextReport.packedBytes / 1024)} KB`);

        const graph = createChapterGraph({
          store,
          apiKey: String(apiKey),
          baseURL: String(baseURL || ""),
          model: String(model || "gpt-4o-mini"),
          apiMode: normalizeWireMode(apiMode),
          reasoningMode: String(reasoningMode || "auto"),
          contextWindowKTokens: Number(contextWindow) || undefined,
          ...networkProxyConfig(req.params),
          streamEmitter,
        });
        const result = await graph.invoke({
          projectId: normalizedProjectId,
          chapterId: String(chapterId),
          instruction: String(instruction),
          worldSetting: prepared.worldSetting,
          writingStyle: writingStyle && typeof writingStyle === "object" ? { name: String((writingStyle as Record<string, unknown>).name || "绑定文风"), content: compactText((writingStyle as Record<string, unknown>).content || "", 3000) } : undefined,
          outline: prepared.outline,
          previousChapters: prepared.previousChapters,
          knowledgeGraph: prepared.knowledgeGraph,
          cards: prepared.cards,
          skillCatalog: prepared.skills,
          preferredSkillNames: stringList(preferredSkillNames, 8),
          contextReport,
          sessionContext,
          authorPreferences: stringList(authorPreferences, 20),
        });
        const resultRecord = result as Record<string, unknown>;
        // 标题兵底：信封里没给 title、正文开头也没写标题行时，这一章会停在“第 N 章”占位。
        // 写完整章才发现没名字太晚，补一次几十 token 的命名请求；失败也不影响正文
        if (!String(resultRecord.chapterTitle || "").trim() && String(resultRecord.draftContent || "").trim()) {
          streamEmitter.progress("review", 97, "正文已完成，正在为本章起标题");
          // 命名失败绝不能拖垮已经写好的整章正文：建客户端和请求都吐在这里
          try {
            const named = await generateChapterTitle(
              createModelApiClient(req.params ?? {}, { model: "gpt-4o-mini" }),
              String(resultRecord.draftContent),
              { projectTitle: String(projectTitle || ""), instruction: String(instruction) },
            );
            if (named) resultRecord.chapterTitle = named;
          } catch {
            // 标题缺失时作者仍可在接受草稿前自己填，不报错中断本次写作
          }
        }
        const handoff = [resultRecord.chapterPlan, resultRecord.summary, resultRecord.reviewResult && JSON.stringify(resultRecord.reviewResult)].filter(Boolean).join("\n");
        if (handoff) {
          const nextChapterSession = appendAgentSession(chapterSession, String(instruction), handoff, contextWindow, prepared.report.packedBytes);
          novelSessionCache.set(sessionKey, nextChapterSession.state);
          void writePersistentContext(`chapter-session-${sessionKey}`, nextChapterSession.state);
          void writePersistentDocument(`chapter-session-${sessionKey}`, `# 章节会话摘要\n\n${nextChapterSession.state.summary || "暂无压缩摘要"}`);
          if (nextChapterSession.compressed) streamEmitter.progress("review", 96, "会话动态上下文已超过 80%，已自动压缩为摘要并保留最近两轮");
        }
        const resultWithUsage = {
          ...result,
          chapterTitle: resultRecord.chapterTitle,
          contextReport: {
            ...contextReport,
            ...(result.contextReport || {}),
            upstreamUsage: result.upstreamUsage,
          },
        };
        streamEmitter.complete("章节草稿和一致性审查已完成");
        return { id: req.id, result: resultWithUsage };
      } catch (error) {
        streamEmitter.error(error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        store.close();
      }
    }
    return { id: req.id, error: { code: -32601, message: "Method not found" } };
  } catch (err) {
    return { id: req.id, error: { code: -32000, message: String(err) } };
  }
}

const rpcRegistry = registerTextHandlers(registerContentHandlers(registerLibraryHandlers(registerModelHandlers(new RpcRegistry(handleLegacyRequest)))));

async function main() {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  for await (const chunk of process.stdin) {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let req: RuntimeRpcRequest | undefined;
      try {
        req = JSON.parse(line) as RuntimeRpcRequest;
      } catch (err) {
        console.error(`[runtime] 请求解析失败：${err instanceof Error ? err.message : String(err)}`);
        process.stdout.write(JSON.stringify({ error: { code: -32700, message: "Parse error" } }) + "\n");
        continue;
      }
      try {
        const res = await rpcRegistry.dispatch(req);
        // 失败原因写到 stderr，桌面端会把最近日志一起回传，避免界面只看到一句空泛错误
        if (res.error) console.error(`[runtime] ${req.method} 失败：${res.error.message}`);
        process.stdout.write(JSON.stringify(res) + "\n");
      } catch (err) {
        // dispatch 之外的意外异常也必须回一条响应，否则桌面端会一直等待而表现为卡死
        const message = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
        console.error(`[runtime] ${req.method} 抛出未捕获异常：${message}`);
        process.stdout.write(JSON.stringify({ id: req.id, error: { code: -32000, message: err instanceof Error ? err.message : String(err) } }) + "\n");
      }
    }
  }
}

// 未捕获异常只写日志：进程若直接退出，桌面端正在等待的请求会变成无响应
process.on("unhandledRejection", reason => {
  console.error(`[runtime] 未处理的 Promise 拒绝：${reason instanceof Error ? `${reason.message}\n${reason.stack ?? ""}` : String(reason)}`);
});
process.on("uncaughtException", error => {
  console.error(`[runtime] 未捕获异常：${error.message}\n${error.stack ?? ""}`);
});

main().catch(error => {
  console.error(`[runtime] 主循环退出：${error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)}`);
  process.exit(1);
});
