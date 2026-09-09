import { invoke as nativeInvoke } from '@tauri-apps/api/core';
import { allocateChapterParts, chapterCharacterCount, partsFromBreaks, planChapterBreaks, splitParagraphs, type AgentRpcCall } from '@zhizhang/contracts';
import { anthropicText, anthropicThinkingBudget, authHeaders, normalizeWireMode, openAIReasoningEffort, toAnthropicMessages } from '@zhizhang/model-protocol';
import { fitMessagesToTokenBudget } from './utils/token-budget';
import { applyDraftChapterTitle, cleanChapterTitleName, extractChapterNumber, isPlaceholderChapterTitle, parseChapterNumber, splitChapterTitleHeading } from './utils/text';
import { mobileBaiduStatus, mobileBaiduLoginURL, mobileBaiduCompleteLogin, mobileBaiduBackup, mobileBaiduListBackups, mobileBaiduRestore } from './platform/mobile/cloud-sync';
import { mobileFanqieSearch, mobileNovelCatchCategories, mobileRankingFetch, mobileQianyueSources, mobileSearchOneQianyueSource, mobileQianyueDownload, mobileQianyueDownloadChapter, mobileSearchAllQianyue } from './platform/mobile/book-sources';

type InvokeArgs = Record<string, unknown> | undefined;
type MobileParams = Record<string, unknown>;
type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };
type MobileUsage = { inputTokens: number; outputTokens: number; totalTokens: number; cachedInputTokens: number; cacheWriteTokens: number; reasoningTokens: number; requests: number; startedAt: string };

const mobileRuntime = () => '__TAURI_INTERNALS__' in window && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
// 百度网盘同步使用应用内 HTTP API。所有 Tauri 平台都走这条路径，避免
// macOS/Windows 依赖外部 bdpan CLI；桌面端的小说文件仍由原生命令写入本机目录。
const directBaiduRuntime = () => '__TAURI_INTERNALS__' in window;

let httpFetchPromise: Promise<typeof globalThis.fetch> | null = null;
const httpFetch = async (): Promise<typeof globalThis.fetch> => {
  if (!httpFetchPromise) {
    httpFetchPromise = import('@tauri-apps/plugin-http')
      .then(module => module.fetch as unknown as typeof globalThis.fetch)
      .catch(() => globalThis.fetch.bind(globalThis));
  }
  return httpFetchPromise;
};

const stringValue = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback;
const memoryList = (value: unknown, limit = 40): string[] => {
  if (typeof value === 'string') return value.split(/\r?\n|[；;、]/u).map(item => item.trim()).filter(Boolean).slice(0, limit);
  if (!Array.isArray(value)) return [];
  return value.map(item => {
    if (typeof item === 'string') return item.trim();
    if (!item || typeof item !== 'object') return '';
    const entry = item as Record<string, unknown>;
    return stringValue(entry.text || entry.content || entry.change || entry.changes || entry.description || entry.name).trim();
  }).filter(Boolean).slice(0, limit);
};
const isQuotaExceeded = (value: string) => /quota\s+(?:has\s+been\s+)?exceeded|insufficient[\s_-]*quota|billing[\s_-]*(?:limit|quota)|余额不足|额度(?:已)?用尽/iu.test(value);
/** OpenAI-compatible addresses resolve to their `/v1` root; Anthropic ones to
 * the host that serves `/v1/messages`. */
const baseURL = (value: unknown, mode: 'openai' | 'anthropic' = 'openai') => {
  const raw = stringValue(value).trim().replace(/\/+$/u, '');
  // 只有 Anthropic 有唯一官方地址可以兜底；OpenAI 兼容模式不内置任何厂商
  const fallback = mode === 'anthropic' ? 'https://api.anthropic.com' : '';
  if (!raw && !fallback) throw new Error('请先在设置中填写 API 接口地址');
  try {
    const parsed = new URL(raw || fallback);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('协议不受支持');
    if (!raw) return fallback;
    if (mode === 'anthropic') return raw.replace(/\/v1(?:\/messages)?$/iu, '') || raw;
    return /\/v1$/iu.test(raw) ? raw : `${raw}/v1`;
  } catch {
    throw new Error('API 地址无效，请填写完整的 http:// 或 https:// 地址');
  }
};
const chatEndpoint = (base: string, mode: 'openai' | 'anthropic') => mode === 'anthropic' ? `${base}/v1/messages` : `${base}/chat/completions`;
const modelsEndpoint = (base: string, mode: 'openai' | 'anthropic') => mode === 'anthropic' ? `${base}/v1/models` : `${base}/models`;
const usageKey = 'writer-mobile-usage';
const readUsage = (): MobileUsage => {
  try {
    const parsed = JSON.parse(localStorage.getItem(usageKey) || '') as Partial<MobileUsage>;
    return {
      inputTokens: Number(parsed.inputTokens) || 0, outputTokens: Number(parsed.outputTokens) || 0,
      totalTokens: Number(parsed.totalTokens) || 0, cachedInputTokens: Number(parsed.cachedInputTokens) || 0,
      cacheWriteTokens: Number(parsed.cacheWriteTokens) || 0, reasoningTokens: Number(parsed.reasoningTokens) || 0,
      requests: Number(parsed.requests) || 0, startedAt: stringValue(parsed.startedAt, new Date().toISOString()),
    };
  } catch {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, requests: 0, startedAt: new Date().toISOString() };
  }
};

const recordUsage = (usage: unknown) => {
  if (!usage || typeof usage !== 'object') return;
  const value = usage as Record<string, unknown>;
  const prompt = (value.prompt_tokens_details || value.input_tokens_details) as Record<string, unknown> | undefined;
  const completion = (value.completion_tokens_details || value.output_tokens_details) as Record<string, unknown> | undefined;
  const input = Number(value.prompt_tokens ?? value.input_tokens) || 0;
  const output = Number(value.completion_tokens ?? value.output_tokens) || 0;
  const next = readUsage();
  next.inputTokens += input;
  next.outputTokens += output;
  next.totalTokens += Number(value.total_tokens) || input + output;
  next.cachedInputTokens += Number(prompt?.cached_tokens ?? value.cached_tokens ?? value.prompt_cache_hit_tokens) || 0;
  next.cacheWriteTokens += Number(prompt?.cache_write_tokens ?? value.cache_creation_input_tokens) || 0;
  next.reasoningTokens += Number(completion?.reasoning_tokens) || 0;
  next.requests += 1;
  // iOS WKWebView has a small browser-storage quota. Usage telemetry must
  // never turn an otherwise successful model request or chapter save into an
  // error; project data itself is written through Tauri to the app directory.
  try { localStorage.setItem(usageKey, JSON.stringify(next)); } catch { /* Keep the current request successful. */ }
};

const compactValue = (value: unknown, depth = 0): unknown => {
  if (depth > 4) return '[已省略]';
  if (typeof value === 'string') return value.length > 18000 ? `${value.slice(0, 9000)}\n...[移动端上下文已压缩]...\n${value.slice(-7000)}` : value;
  if (Array.isArray(value)) return value.slice(-40).map(item => compactValue(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/^(apiKey|apiKeys|proxyURL|proxyEnabled|proxyBypassLocal)$/u.test(key)) continue;
    output[key] = compactValue(item, depth + 1);
  }
  return output;
};

const schemaFor = (method: string) => {
  const schemas: Record<string, string> = {
    'project.generate': '{"title":"书名（仅在 field=title 时填写）","synopsis":"番茄风格简介（仅在 field=synopsis 时填写）"}',
    'outline.write': '{"title":"大纲标题","content":"Markdown 大纲正文"}',
    'card.write': '{"title":"卡片名称","content":"Markdown 卡片正文"}',
    'chapter.write': '{"content":"章节正文","title":"本章标题（4-14 个汉字，不带“第几章”前缀）","summary":"本章摘要","consistency":"一致性检查"}',
    'memory.write': '{"summary":"摘要","keywords":[],"characterStateChanges":[],"knowledgeChanges":[],"foreshadowingChanges":[],"timelineEvents":[],"canonFacts":[],"conflicts":[],"endingHook":"","entities":[],"relations":[],"cardUpdates":[]}',
    'book.dismantle': '{"summary":"剧情摘要","detailedOutline":"章节章纲","plotBeats":[],"characterDynamics":[],"setupPayoff":[],"pacing":""}',
    'book.style.distill': '{"name":"文风名称","description":"文风说明","tags":[],"content":"Markdown 文风 Skill"}',
    'skill.write': '{"name":"技能名称","category":"write","description":"技能用途","tags":[],"content":"Markdown 技能正文"}',
  };
  return schemas[method] || '{"content":"处理结果"}';
};

const promptFor = (method: string, params: MobileParams) => {
  const context = JSON.stringify(compactValue(params), null, 2);
  const task = method === 'chapter.write'
    ? '你是中文长篇小说章节智能体。必须承接上一章结尾，严格遵守世界观、卡片、章纲和记忆，输出可直接保存的章节正文。不要输出分析过程。title 必须填，只概括本章真正发生的事，章号由应用自己编；标题只放 title 字段，不要在正文开头重复写一行 # 标题。'
    : method === 'outline.write'
      ? '你是中文网文大纲智能体。根据作品资料与作者指令生成可执行的大纲，保持设定一致，不泄露总纲之外的未来情节。'
      : method === 'card.write'
        ? '你是中文小说知识卡片智能体。只根据作品资料补全当前卡片，明确事实、状态、关系和边界，不把推测写成事实。'
        : method === 'memory.write'
          ? '你是章节记忆编辑。只从正文抽取明确事实、人物状态、角色认知、时间线、伏笔、知识图谱关系和卡片变化。人物状态变化写入 characterStateChanges，角色知道了什么、隐瞒了什么写入 knowledgeChanges；这两个字段必须始终返回数组，正文有相关事实时不得留空。'
          : `你是小说写作助手，负责执行 ${method}。`;
  return `${task}\n\n输入资料（已移除密钥与网络配置）：\n${context}\n\n${method === 'text.transform' ? '只返回处理后的 content 字段。' : `严格只返回 JSON，不要 Markdown 代码围栏或额外解释。JSON 结构：${schemaFor(method)}`}`;
};

const parseJSON = <T>(content: string): T | null => {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/iu, '').replace(/```$/u, '').trim();
  try { return JSON.parse(cleaned) as T; } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) { try { return JSON.parse(cleaned.slice(start, end + 1)) as T; } catch { return null; } }
    return null;
  }
};

const memoryField = (result: Record<string, unknown>, ...names: string[]) => {
  for (const name of names) {
    const value = result[name];
    if ((Array.isArray(value) && value.length) || (typeof value === 'string' && value.trim())) return value;
  }
  return [];
};

/** Normalise model-specific memory keys before App.tsx persists the chapter snapshot. */
const normalizeMobileMemoryResult = (value: Record<string, unknown>, rawContent: string): Record<string, unknown> => {
  // Some providers wrap the JSON object in a `content` string.
  let result = value;
  if (typeof value.content === 'string' && value.content.trim().startsWith('{')) {
    result = parseJSON<Record<string, unknown>>(value.content) || value;
  }
  const summary = stringValue(result.summary || result.摘要 || result.chapterSummary || result.chapter_summary, rawContent.slice(0, 220)).trim();
  return {
    ...result,
    summary,
    keywords: memoryList(memoryField(result, 'keywords', '关键词', 'key_words'), 8),
    characterStateChanges: memoryList(memoryField(result, 'characterStateChanges', 'character_state_changes', 'characterChanges', 'character_changes', '人物状态变化', '人物状态', '角色状态变化')),
    knowledgeChanges: memoryList(memoryField(result, 'knowledgeChanges', 'knowledge_changes', 'characterKnowledgeChanges', 'roleKnowledgeChanges', '角色认知变化', '角色认知', '认知变化', '知识变化')),
    foreshadowingChanges: memoryList(memoryField(result, 'foreshadowingChanges', 'foreshadowing_changes', '伏笔变化', '伏笔进展')),
    timelineEvents: memoryList(memoryField(result, 'timelineEvents', 'timeline_events', '时间线事件', '时间线')),
    canonFacts: memoryList(memoryField(result, 'canonFacts', 'canon_facts', '设定事实', '世界观事实')),
    conflicts: memoryList(memoryField(result, 'conflicts', '冲突', '冲突变化')),
    endingHook: stringValue(result.endingHook || result.ending_hook || result.章末钩子 || result.结尾钩子).trim(),
  };
};

const mobilePromptByteLength = (value: string) => new TextEncoder().encode(value).byteLength;
const mobilePromptWhitespace = (value: unknown) => String(value ?? '')
  .replace(/\r\n?/gu, '\n')
  .split('\n')
  .map(line => line.trim().replace(/[ \t]{2,}/gu, ' '))
  .join('\n')
  .replace(/\n{3,}/gu, '\n\n')
  .trim();

const mobileSliceToBytes = (value: string, maxBytes: number) => {
  if (mobilePromptByteLength(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (mobilePromptByteLength(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
};

const mobileCompactPromptText = (value: unknown, maxBytes: number) => {
  const text = mobilePromptWhitespace(value);
  if (!text || maxBytes <= 0 || mobilePromptByteLength(text) <= maxBytes) return text;
  const marker = '\n...[已按相关性与预算裁剪]...\n';
  const available = Math.max(0, maxBytes - mobilePromptByteLength(marker));
  const head = mobileSliceToBytes(text, Math.floor(available * 0.62));
  const tailCharacters = Array.from(text).reverse().join('');
  const tail = Array.from(mobileSliceToBytes(tailCharacters, Math.max(0, available - mobilePromptByteLength(head)))).reverse().join('');
  return `${head}${marker}${tail}`;
};

const mobileMemorySystemPrompt = `你是长篇小说的记忆编辑。只从章节正文与给定的相关资料抽取明确事实，不补写未发生的剧情。

输出必须是严格 JSON 对象，不要代码围栏或解释。摘要应简短、可检索、包含事件推进、人物状态和未解决线索。实体与关系必须有正文依据；卡片只在状态确有变化且正文能证明时更新。`;

const mobileKnowledgeGraphSummary = (value: unknown, query: string, maxBytes = 2400) => {
  if (!value || typeof value !== 'object') return '';
  const graph = value as Record<string, unknown>;
  const nodes = Array.isArray(graph.nodes) ? graph.nodes.filter(item => item && typeof item === 'object') as Array<Record<string, unknown>> : [];
  const edges = Array.isArray(graph.edges) ? graph.edges.filter(item => item && typeof item === 'object') as Array<Record<string, unknown>> : [];
  const queryText = query.toLocaleLowerCase();
  const selectedIds = new Set(nodes.filter(node => {
    const label = stringValue(node.label).trim();
    return Boolean(label) && queryText.includes(label.toLocaleLowerCase());
  }).map(node => String(node.id || '')));
  edges.forEach(edge => {
    const source = String(edge.source || '');
    const target = String(edge.target || '');
    if (selectedIds.has(source) || selectedIds.has(target)) {
      selectedIds.add(source);
      selectedIds.add(target);
    }
  });
  const selectedNodes = nodes.filter(node => selectedIds.has(String(node.id || ''))).slice(0, 30);
  const selectedEdges = edges.filter(edge => selectedIds.has(String(edge.source || '')) && selectedIds.has(String(edge.target || ''))).slice(0, 60);
  if (!selectedNodes.length && !selectedEdges.length) return '';
  const labels = new Map(selectedNodes.map(node => [String(node.id || ''), stringValue(node.label, String(node.id || '实体'))]));
  const lines = [
    ...selectedNodes.map(node => `实体：${stringValue(node.label, '未命名')}（${stringValue(node.category || node.type, '实体')}）`),
    ...selectedEdges.map(edge => `关系：${labels.get(String(edge.source || '')) || String(edge.source || '')} -[${stringValue(edge.label, '关联')}]-> ${labels.get(String(edge.target || '')) || String(edge.target || '')}（权重 ${Number(edge.weight) || 0.7}）`),
  ];
  return mobileCompactPromptText(lines.join('\n'), maxBytes);
};

const mobileMemoryMessages = (params: MobileParams): ChatMessage[] => {
  const projectTitle = stringValue(params.projectTitle, '未命名小说');
  const chapterTitle = stringValue(params.chapterTitle, '未命名章节');
  const content = stringValue(params.content);
  const contextWindowKTokens = Math.max(16, Number(params.contextWindow) || 128);
  // 章节记忆的预打包空间按中文约 3 UTF-8 bytes/token 分配；最终请求仍由 tokenizer 裁剪
  const chapterBudget = Math.min(20 * 1024, Math.max(8 * 1024, Math.floor(contextWindowKTokens * 1024 * 3 * 0.16)));
  const chapterContent = mobileCompactPromptText(content, chapterBudget);
  const cards = Array.isArray(params.cards)
    ? params.cards.filter(item => item && typeof item === 'object') as Array<Record<string, unknown>>
    : [];
  const relevantCards = cards.filter(card => {
    const title = stringValue(card.title).trim();
    return Boolean(title) && content.includes(title);
  }).slice(0, 10);
  const cardContext = relevantCards.length
    ? `\n## 正文命中的卡片（仅可更新这些卡片）\n${relevantCards.map(card => {
      const history = Array.isArray(card.stateHistory)
        ? card.stateHistory.slice(-2).map(item => item && typeof item === 'object' ? mobileCompactPromptText((item as Record<string, unknown>).changes, 180) : '').filter(Boolean).join('；')
        : '';
      return `${String(card.id || '')} | ${mobileCompactPromptText(card.title || '卡片', 100)}\n当前状态：${mobileCompactPromptText(card.currentState || '暂无', 360)}${history ? `\n近期变化：${history}` : ''}\n知识：${mobileCompactPromptText(card.content || '', 720)}`;
    }).join('\n\n')}`
    : '';
  const graphSummary = mobileKnowledgeGraphSummary(params.knowledgeGraph, `${chapterTitle}\n${chapterContent}\n${relevantCards.map(card => stringValue(card.title)).join(' ')}`);
  const graphContext = graphSummary ? `\n## 相关知识图谱（用于增量更新）\n${graphSummary}` : '';
  const prompt = `请为《${projectTitle}》的${chapterTitle}整理可检索的结构化章节记忆，并从正文抽取有证据的实体、关系和卡片变化。

## 本章正文
${chapterContent}${cardContext}${graphContext}

返回 JSON：
{
  "summary": "180 字以内的事件、人物状态和未解决线索",
  "keywords": ["最多 8 个关键词"],
  "characterStateChanges": ["角色名：本章结束时的位置、身体、情绪、能力、关系或目标状态变化"],
  "knowledgeChanges": ["角色名：本章新得知、确认、误解或仍被隐瞒的信息"],
  "foreshadowingChanges": ["已有伏笔的新增进展，或本章新埋且后续可回收的明确线索"],
  "foreshadowingItems": [{"text":"伏笔内容","status":"active|progressing|resolved|overdue","priority":"high|normal|low","plantedChapter":1,"targetChapter":5}],
  "timelineEvents": ["按发生顺序记录的关键事件"],
  "canonFacts": ["后续写作必须遵守且本章已确认的设定事实"],
  "conflicts": ["冲突双方、起因、本章结果与尚未解决部分"],
  "endingHook": "章末最后一个未解决事项或下一章必须承接的钩子",
  "entities": [{"name":"实体","type":"人物|物品|地点|势力|事件|设定"}],
  "relations": [{"source":"实体","target":"实体","label":"关系","weight":0.7}],
  "cardUpdates": [{"cardId":"卡片 ID","cardTitle":"卡片名称","status":"changed|acquired|lost|revealed|updated","changes":"有正文依据的变化"}]
}

分类必须互不混写：人物状态只写角色自身状态；角色认知必须明确写谁知道什么；伏笔只写可在后文回收的线索；冲突必须写双方和当前结果。正文明确存在相关事实时不得遗漏；确实不存在时使用空数组，不要用“暂无”“待补充”凑数。关系 weight 为 0.1 到 1.0 的正文证据强度：明确行动、身份、持有或状态变化为 0.85 以上；直接提及为 0.65 至 0.8；推断性弱关联不超过 0.6。实体不超过 30 个，关系不超过 60 条。`;
  return [
    { role: 'system', content: mobileMemorySystemPrompt },
    { role: 'user', content: prompt },
  ];
};

const emitProgress = (runId: string, payload: Record<string, unknown>) => {
  if (!runId) return;
  window.dispatchEvent(new CustomEvent('agent-progress', { detail: { ...payload, runId } }));
};

const mobileResponseText = (value: unknown, depth = 0): string => {
  if (depth > 5 || value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(item => mobileResponseText(item, depth + 1)).join('');
  if (typeof value !== 'object') return '';
  const item = value as Record<string, unknown>;
  if (typeof item.text === 'string') return item.text;
  if (typeof item.output_text === 'string') return item.output_text;
  if (typeof item.content === 'string') return item.content;
  return mobileResponseText(item.content, depth + 1)
    || mobileResponseText(item.output, depth + 1)
    || mobileResponseText(item.message, depth + 1);
};

/** Reads an Anthropic Messages reply, streaming or not. Anthropic reports input
 * tokens in `message_start` and output tokens in `message_delta`, so streamed
 * usage has to accumulate across events. */
async function mobileAnthropicResult(response: Response, endpoint: string, onChunk?: (chunk: string) => void): Promise<{ content: string; usage?: unknown }> {
  if (!onChunk || !response.body) {
    const data = await response.json() as Record<string, unknown>;
    const content = anthropicText(data.content);
    if (!content) {
      const stopReason = stringValue(data.stop_reason);
      throw new Error(stopReason === 'max_tokens'
        ? 'Anthropic 接口输出被截断，请提高输出上限或降低思考强度'
        : `Anthropic 接口返回内容为空（${endpoint}，stop_reason：${stopReason || '无'}）`);
    }
    recordUsage(data.usage);
    return { content, usage: data.usage };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  const usage: Record<string, number> = {};
  let done = false;
  while (!done) {
    const next = await reader.read();
    buffer += decoder.decode(next.value || new Uint8Array(), { stream: !next.done });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('event:')) continue;
      const raw = trimmed.replace(/^data:\s*/u, '');
      if (!raw || raw === '[DONE]') continue;
      try {
        const event = JSON.parse(raw) as Record<string, unknown>;
        const delta = event.delta as Record<string, unknown> | undefined;
        // `thinking_delta` events share this type and must stay out of the text.
        if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
          content += delta.text;
          onChunk(delta.text);
        }
        const message = event.type === 'message_start' && event.message && typeof event.message === 'object'
          ? (event.message as Record<string, unknown>).usage
          : event.usage;
        if (message && typeof message === 'object') {
          for (const [field, value] of Object.entries(message as Record<string, unknown>)) {
            if (typeof value === 'number') usage[field] = value;
          }
        }
        if (event.type === 'message_stop') done = true;
      } catch { /* Ignore keep-alives and malformed proxy fragments. */ }
    }
    if (next.done) break;
  }
  recordUsage(usage);
  return { content, usage };
}

async function mobileChat(params: MobileParams, messages: ChatMessage[], onChunk?: (chunk: string) => void, jsonMode = false): Promise<{ content: string; usage?: unknown }> {
  const fetcher = await httpFetch();
  const apiMode = normalizeWireMode(params.apiMode);
  const model = stringValue(params.model, 'gpt-4o-mini');
  // Some Gemini-compatible relay routes can reject OpenAI's response_format
  // option upstream. The prompt still asks for JSON, so parsing remains safe.
  const supportsJsonMode = !/^gemini(?:[-:/]|$)/iu.test(model.trim());
  const base = baseURL(params.baseURL, apiMode);
  // 每个配置只有一个 Key；权限以实际调用结果为准，不再靠模型目录猜
  const apiKey = stringValue(params.apiKey).trim();
  if (!apiKey) throw new Error('请先在设置中填写 API Key。');
  const endpoint = chatEndpoint(base, apiMode);
  const reasoningMode = stringValue(params.reasoningMode, 'auto');
  const thinkingBudget = apiMode === 'anthropic' ? anthropicThinkingBudget[reasoningMode] : undefined;
  const temperature = jsonMode ? 0.2 : 0.7;
  // Anthropic rejects a thinking budget that is not strictly below max_tokens.
  const requestedMaxTokens = Math.max(0, Math.min(8000, Number(params.maxOutputTokens) || 0));
  const maxTokens = Math.max(jsonMode ? 1300 : 6000, requestedMaxTokens, thinkingBudget ? thinkingBudget + 1024 : 0);
  const contextTokens = Math.max(16, Number(params.contextWindow) || 128) * 1024;
  if (maxTokens >= contextTokens) throw new Error(`当前输出和思考预算需要 ${maxTokens.toLocaleString()} tokens，已超过 ${contextTokens.toLocaleString()} tokens 的上下文窗口`);
  let contextMessages = await fitMessagesToTokenBudget(messages, contextTokens - maxTokens, model);
  if (apiMode === 'anthropic') {
    // 官方及兼容中转若支持 count_tokens，用服务端 tokenizer 再校准一次
    const countEndpoint = `${base}/v1/messages/count_tokens`;
    try {
      const { system, turns } = toAnthropicMessages(contextMessages);
      const countResponse = await fetcher(countEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders(apiKey, apiMode) }, body: JSON.stringify({ model, system: system || undefined, messages: turns }) });
      if (countResponse.ok) {
        const actual = Number(((await countResponse.json()) as Record<string, unknown>).input_tokens) || 0;
        const budget = contextTokens - maxTokens;
        if (actual > budget) contextMessages = await fitMessagesToTokenBudget(messages, Math.max(256, Math.floor(budget * budget / actual * 0.98)), model);
      }
    } catch { /* 不支持 count_tokens 的中转继续使用兼容 tokenizer */ }
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: onChunk ? 'text/event-stream' : 'application/json' };
  const body: Record<string, unknown> = apiMode === 'anthropic'
    ? (() => {
      const { system, turns } = toAnthropicMessages(contextMessages);
      return {
        model,
        max_tokens: maxTokens,
        messages: turns,
        stream: Boolean(onChunk),
        ...(system ? { system } : {}),
        // Extended thinking pins temperature at 1, so it must be omitted.
        ...(thinkingBudget ? { thinking: { type: 'enabled', budget_tokens: thinkingBudget } } : { temperature }),
      };
    })()
    : {
      model, messages: contextMessages, temperature, max_tokens: maxTokens, stream: Boolean(onChunk),
      ...(onChunk ? { stream_options: { include_usage: true } } : {}),
      ...(jsonMode && supportsJsonMode ? { response_format: { type: 'json_object' } } : {}),
      ...(openAIReasoningEffort[reasoningMode] ? { reasoning_effort: openAIReasoningEffort[reasoningMode] } : {}),
    };
  const requestBody = JSON.stringify(body);
  const response = await fetcher(endpoint, { method: 'POST', headers: { ...headers, ...authHeaders(apiKey, apiMode) }, body: requestBody });
  if (!response.ok) {
    const raw = await response.text();
    // 与桌面端保持一致：空响应体的 4xx 多来自网关或 WAF，不断言 Key 无效
    const detail = raw.trim().replace(/\s+/gu, ' ').slice(0, 400);
    const sizeHint = `，本次请求体 ${(requestBody.length / 1024).toFixed(1)} KB`;
    const modeName = apiMode === 'anthropic' ? 'Anthropic Messages' : 'OpenAI 兼容';
    if (isQuotaExceeded(detail)) throw new Error('API 中转服务额度已用尽。章节正文已保存，本章记忆将在额度恢复后再更新。');
    if (response.status === 413 || (response.status === 400 && !detail) || /prompt is too long|request_too_large|exceeds the context window|maximum context length/iu.test(detail)) {
      throw new Error(`请求超出模型上下文或网关的大小限制（${response.status}），模型 ${model} · ${endpoint}${sizeHint}。请降低思考强度、缩小上下文窗口，或减少本次带入的章节与资料。${detail}`.trim());
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(`模型接口拒绝了请求（${response.status}），模型 ${model} · ${endpoint}（${modeName}）。${detail || `上游没有返回任何说明${sizeHint}。常见原因是反向代理、CDN 或 WAF 拦截，也可能是该 Key 无权访问此模型或此地址`}`);
    }
    throw new Error(`模型接口返回 ${response.status}（${modeName} · ${endpoint}）：${detail || '上游没有返回任何说明'}`);
  }
  if (apiMode === 'anthropic') return mobileAnthropicResult(response, endpoint, onChunk);
  if (!onChunk || !response.body) {
    const data = await response.json() as Record<string, unknown>;
    const choices = Array.isArray(data.choices) ? data.choices as Array<Record<string, unknown>> : [];
    const message = choices[0]?.message as Record<string, unknown> | undefined;
    const content = mobileResponseText(message?.content)
      || mobileResponseText(data.output_text)
      || mobileResponseText(data.content)
      || mobileResponseText(data.output);
    recordUsage(data.usage);
    return { content, usage: data.usage };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let usage: unknown;
  while (true) {
    const next = await reader.read();
    buffer += decoder.decode(next.value || new Uint8Array(), { stream: !next.done });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const raw = line.trim().replace(/^data:\s*/u, '');
      if (!raw || raw === '[DONE]') continue;
      try {
        const event = JSON.parse(raw) as Record<string, unknown>;
        usage = event.usage || usage;
        const choice = Array.isArray(event.choices) ? event.choices[0] as Record<string, unknown> : undefined;
        const delta = choice?.delta as Record<string, unknown> | undefined;
        const chunk = stringValue(delta?.content);
        if (chunk) { content += chunk; onChunk(chunk); }
      } catch { /* Ignore keep-alives and malformed proxy fragments. */ }
    }
    if (next.done) break;
  }
  recordUsage(usage);
  return { content, usage };
}

const mobileProjectAgentContext = (params: MobileParams) => {
  const project = params.project && typeof params.project === 'object' ? params.project as Record<string, unknown> : {};
  const instruction = stringValue(params.instruction);
  const needsContinuity = /下一章|续写|继续写|章节草稿|创作下一章/u.test(instruction);
  const terms = Array.from(new Set(instruction.toLocaleLowerCase().split(/[\s，。！？、；：,.!?;:()（）【】\u005B\u005D]+/u).filter(term => term.length >= 2))).slice(0, 16);
  const records = (value: unknown) => Array.isArray(value) ? value.filter(item => item && typeof item === 'object') as Array<Record<string, unknown>> : [];
  const excerpt = (content: string, tail = false) => {
    const lower = content.toLocaleLowerCase();
    const term = terms.find(item => lower.includes(item));
    if (term) {
      const position = lower.indexOf(term);
      return mobileCompactPromptText(content.slice(Math.max(0, position - 150), Math.min(content.length, position + term.length + 320)), 1600);
    }
    return mobileCompactPromptText(tail ? content.slice(-3500) : content, tail ? 1800 : 700);
  };
  const choose = (value: unknown, fields: string[], limit: number, kind: 'chapter' | 'document' = 'document') => records(value).map((item, index, all) => {
    const content = fields.map(field => stringValue(item[field])).join('\n');
    const score = terms.reduce((total, term) => total + (content.toLocaleLowerCase().includes(term) ? 2 : 0), 0) + index / 1000;
    const compact = Object.fromEntries(['id', ...fields].flatMap(key => {
      const field = item[key];
      if (field === undefined) return [];
      return [[key, typeof field === 'string' && field.length > 900 ? excerpt(field, kind === 'chapter' && needsContinuity && index === all.length - 1) : field]];
    }));
    return { item: compact, score };
  }).sort((left, right) => right.score - left.score).slice(0, limit).map(entry => entry.item);
  return {
    id: project.id,
    title: project.title,
    synopsis: project.synopsis,
    genre: project.genre,
    subgenre: project.subgenre,
    protagonist1: project.protagonist1,
    protagonist2: project.protagonist2,
    status: project.status,
    chapters: choose(project.chapters, ['title', 'content'], 6, 'chapter'),
    outlines: choose(project.outlines, ['kind', 'title', 'content'], 6),
    cards: choose(project.cards, ['type', 'title', 'content', 'currentState'], 10),
    memories: choose(project.memories, ['chapterTitle', 'summary', 'endingHook'], 5),
    memoryDocuments: choose(project.memoryDocuments, ['kind', 'title', 'content'], 4),
    graphNodes: choose(project.graphNodes, ['label', 'category', 'content', 'status'], 16),
    graphEdges: records(project.graphEdges).slice(-40),
  };
};

/** 一次模型请求里塞多少章：与 agent-runtime 的 TITLE_BATCH_SIZE 保持一致 */
const mobileTitleBatchSize = 20;
/** 单次批量补标题最多处理多少章：手机端串行跑，章数过多会等到用户放弃 */
const mobileTitleLimit = 200;
/** 整章改写的三种口径，与 text.transform 的 mode 一致 */
const mobileReviseModes: Record<string, string> = { revise: '修订', polish: '润色', 'de-ai': '去 AI 味' };

const mobileTitleSystemPrompt = `你是中文长篇网文的责任编辑，正在为已经写好的章节补标题。

要求：
1. 每个标题只概括该章真正发生的事，不得使用别章的情节，不得凭空发明设定。
2. 4 到 14 个汉字，不带“第几章”前缀，不带书名号、引号、句号和省略号。
3. 同一批里的标题必须互不相同，不要都写成“危机”“转机”这类空词。
4. 严格返回 JSON 对象：{"titles":[{"index":序号,"title":"标题"}]}，不要代码围栏，不要解释。index 直接抄回各章开头的“第 X 章”那个 X。
5. 给了几章就返回几条，不要新增或漏掉章节。`;

/** 正文摘录：开头交代场景、结尾交代钩子，标题基本只靠这两段就能定 */
const mobileTitleExcerpt = (content: string) => {
  const text = content.trim().replace(/\s*\n\s*\n\s*/gu, '\n');
  if (text.length <= 900) return text;
  return `${text.slice(0, 620)}\n……\n${text.slice(-260)}`;
};

const mobileSingleTitleSystemPrompt = `你是中文长篇网文的责任编辑，正在为刚写完的一章起标题。

要求：
1. 只概括这一章真正发生的事，不得凭空发明设定。
2. 4 到 14 个汉字，不带“第几章”前缀，不带书名号、引号、句号和省略号。
3. 严格返回 JSON 对象：{"title":"标题"}，不要代码围栏，不要解释。`;

/**
 * 单章标题兵底
 * 章节智能体写完正文却没给标题时，这一章只剩“第 N 章”占位；
 * 补一次几十 token 的命名请求，失败则返回空串，不拖累已经写好的正文
 */
const mobileChapterTitle = async (params: MobileParams, content: string, projectTitle: string, instruction: string): Promise<string> => {
  const excerpt = mobileTitleExcerpt(content);
  if (!excerpt) return '';
  try {
    const response = await mobileChat({ ...params, runId: '', maxOutputTokens: 200 }, [
      { role: 'system', content: mobileSingleTitleSystemPrompt },
      { role: 'user', content: `《${projectTitle || '未命名小说'}》刚写完一章。${instruction.trim() ? `\n作者本章要求：${instruction.trim().slice(0, 400)}` : ''}\n\n${excerpt}` },
    ], undefined, true);
    const parsed = parseJSON<Record<string, unknown>>(response.content);
    return parsed ? cleanChapterTitleName(stringValue(parsed.title || parsed.chapterTitle || parsed['标题'])) : '';
  } catch {
    return '';
  }
};

/**
 * 移动端批量补章节标题
 * 与 agent-runtime 同一套两段式：先把旧版本遗留在正文开头的 # 标题行直接捡回来（零模型调用），
 * 剩下真的没有名字的章节再分批交给模型命名；一批失败只丢这一批，其余章节照常返回
 */
const mobileChapterTitles = async (params: MobileParams, request: Record<string, unknown>, chapters: unknown[], projectTitle: string, runId: string) => {
  const rows = chapters.filter(item => item && typeof item === 'object') as Array<Record<string, unknown>>;
  const wanted = (Array.isArray(request.targetIds) ? request.targetIds : []).map(Number).filter(value => Number.isInteger(value) && value > 0);
  const picked = (wanted.length
    ? rows.filter(row => wanted.includes(Number(row.id)))
    : rows.filter(row => request.scope === 'all' || isPlaceholderChapterTitle(stringValue(row.title)))
  ).slice(0, mobileTitleLimit);
  if (!picked.length) throw new Error(wanted.length ? '指定的章节都不存在' : '没有需要补标题的章节，所有章节都已经有名字');
  const entries: Array<{ targetId: number; title: string; stripHeading?: boolean }> = [];
  const failures: string[] = [];
  const pending: Array<Record<string, unknown>> = [];
  for (const row of picked) {
    const content = stringValue(row.content);
    const draft = splitChapterTitleHeading(content);
    if (draft.title) {
      // 正文开头本来就写着标题：搬到标题栏并让应用把那一行移走，不需要问模型
      entries.push({ targetId: Number(row.id), title: applyDraftChapterTitle(stringValue(row.title), draft.title).slice(0, 160), stripHeading: true });
      continue;
    }
    if (content.trim()) pending.push(row);
    else failures.push(`章节 ${Number(row.id)} 没有正文，无法起名`);
  }
  const recovered = entries.length;
  const extra = stringValue(request.instruction).trim() ? `\n作者额外要求：${stringValue(request.instruction).trim()}` : '';
  /** 行的序号键 → 章号；与运行时同名判定保持一致 */
  const chapterNumberOf = (row: Record<string, unknown>) => extractChapterNumber(stringValue(row.title));
  for (let index = 0; index < pending.length; index += mobileTitleBatchSize) {
    const batch = pending.slice(index, index + mobileTitleBatchSize);
    emitProgress(runId, { type: 'progress', data: { step: 'chapter-titles', progress: Math.min(72, 40 + Math.round(index / Math.max(1, pending.length) * 32)), message: `正在为 ${batch.length} 章生成标题（已完成 ${recovered + index} / ${picked.length}）` } });
    // 批量回包没配上的章收集起来，批后逐章兑底；配对按“序号 → 章号 → 真实 id → 位置”降级，
    // 模型最常把章号当 id 返回（线上真实事故：只按十几位真实 id 硬配会把整批全丢）
    const missing: Array<Record<string, unknown>> = [];
    try {
      const listing = batch.map((row, i) => {
        const num = chapterNumberOf(row);
        const indexLabel = num !== null ? String(num) : String(i + 1);
        return `### ${stringValue(row.title).trim() || '无标题'}（index=${indexLabel}）\n${mobileTitleExcerpt(stringValue(row.content))}`;
      }).join('\n\n');
      const response = await mobileChat({ ...params, runId: runId ? `${runId}:titles-${index}` : '', maxOutputTokens: 2000 }, [
        { role: 'system', content: mobileTitleSystemPrompt },
        { role: 'user', content: `《${projectTitle || '未命名小说'}》需要补标题的章节共 ${batch.length} 章。${extra}\n\n${listing}` },
      ], undefined, true);
      const parsed = parseJSON<Record<string, unknown>>(response.content);
      const produced = Array.isArray(parsed?.titles) ? parsed.titles : Array.isArray(parsed) ? parsed : [];
      const byId = new Map(batch.map(row => [String(Number(row.id)), row]));
      const used = new Set<Record<string, unknown>>();
      const leftovers: Array<{ index: number | null; id: string; title: string }> = [];
      for (const item of produced) {
        const record = item && typeof item === 'object' ? item as Record<string, unknown> : typeof item === 'string' ? { title: item } : null;
        if (!record) continue;
        const name = stringValue(record.title || record.chapterTitle || record.name || record['标题']).trim();
        if (!name) continue;
        const rowIndex = parseChapterNumber(record.index ?? record['序号'] ?? record.number ?? record.order);
        const rawId = String(record.id ?? record.targetId ?? record.chapterId ?? '');
        let target: Record<string, unknown> | undefined;
        if (rowIndex !== null) {
          target = batch.find(row => !used.has(row) && chapterNumberOf(row) === rowIndex) || batch.find(row => !used.has(row) && batch.indexOf(row) + 1 === rowIndex);
        }
        if (!target && rawId) {
          target = byId.get(rawId);
          if (!target) {
            const idNumber = parseChapterNumber(rawId);
            if (idNumber !== null) target = batch.find(row => !used.has(row) && chapterNumberOf(row) === idNumber);
          }
        }
        if (!target) {
          leftovers.push({ index: rowIndex, id: rawId, title: name });
          continue;
        }
        const title = applyDraftChapterTitle(stringValue(target.title), cleanChapterTitleName(name), { overwrite: true });
        if (title.trim() === stringValue(target.title).trim()) continue;
        used.add(target);
        entries.push({ targetId: Number(target.id), title: title.slice(0, 160) });
      }
      // 回包不带键或键写错时按位置兑底：尽量配对未命中的章节
      const unmatched = batch.filter(row => !used.has(row));
      if (leftovers.length > 0 && unmatched.length > 0) {
        const pairCount = Math.min(leftovers.length, unmatched.length);
        for (let i = 0; i < pairCount; i += 1) {
          const row = unmatched[i];
          const title = applyDraftChapterTitle(stringValue(row.title), cleanChapterTitleName(leftovers[i].title), { overwrite: true });
          if (title.trim() === stringValue(row.title).trim()) continue;
          used.add(row);
          entries.push({ targetId: Number(row.id), title: title.slice(0, 160) });
        }
      }
      for (const row of batch) if (!used.has(row)) missing.push(row);
    } catch (error) {
      missing.push(...batch);
      failures.push(`一批 ${batch.length} 章命名失败：${error instanceof Error ? error.message : String(error)}`);
    }
    // 批后逐章兑底：单章回包只有 {"title":"名"} 一种形状，出错空间小，一次几十 token
    for (const row of missing.slice(0, 20)) {
      const named = await mobileChapterTitle(params, stringValue(row.content), projectTitle, stringValue(request.instruction));
      if (!named) continue;
      const title = applyDraftChapterTitle(stringValue(row.title), named, { overwrite: true });
      if (title.trim() === stringValue(row.title).trim()) continue;
      entries.push({ targetId: Number(row.id), title: title.slice(0, 160) });
      const at = missing.indexOf(row);
      if (at >= 0) missing.splice(at, 1);
    }
    if (missing.length) {
      failures.push(`${missing.map(row => {
        const num = extractChapterNumber(stringValue(row.title));
        return num !== null ? `第 ${num} 章` : (stringValue(row.title).trim() || `id=${Number(row.id)}`);
      }).slice(0, 5).join('、')}${missing.length > 5 ? ` 等 ${missing.length} 章` : ''} 模型没给出可用标题，可以再说一次只处理这几章`);
    }
  }
  if (!entries.length) throw new Error(failures[0] || '没能生成任何标题');
  const detail = [recovered ? `${recovered} 章从正文开头找回` : '', entries.length - recovered ? `${entries.length - recovered} 章由模型命名` : '', ...failures].filter(Boolean).join('；');
  return {
    change: { type: 'chapter.titles', summary: `${stringValue(request.summary, '批量补标题')}（${entries.length} 章：${detail}）`.slice(0, 200), titles: entries },
    message: `已生成 ${entries.length} 章标题${detail ? `：${detail}` : ''}`,
  };
};

/**
 * 移动端批量拆章
 * 与运行时同一套判定（切点函数来自契约层）：切点纯文本按段落算，正文一个字都不改也不回传，
 * 只把段落序号和新标题合成一条 chapter.parts 变更。
 */
const mobileChapterSplit = async (params: MobileParams, request: Record<string, unknown>, chapters: unknown[], projectTitle: string, runId: string) => {
  const rows = chapters.filter(item => item && typeof item === 'object') as Array<Record<string, unknown>>;
  const wanted = (Array.isArray(request.targetIds) ? request.targetIds : []).map(Number).filter(value => Number.isInteger(value) && value > 0);
  const picked = rows.filter(row => wanted.includes(Number(row.id))).slice(0, 40);
  if (!picked.length) throw new Error('要拆分的章节都不存在');
  const targetWords = Math.min(20_000, Math.max(600, Number(request.targetWords) || 2400));
  const targetParts = Math.min(240, Math.max(0, Math.floor(Number(request.targetParts) || 0)));
  // 作者直接报了“这两章拆成 6 章”时，按各章字数把名额分下去；
  // 不比现有章数多就不可能是总章数，退回每章目标字数，不把整批章节跳过
  const asTotal = targetParts > picked.length ? targetParts : 0;
  const splits: Array<{ targetId: number; paragraphCount: number; breakAfter: number[]; titles: string[] }> = [];
  const failures: string[] = [];
  if (targetParts >= 2 && !asTotal) failures.push(`要的 ${targetParts} 章不比这 ${picked.length} 章多，没法当成拆完后的总章数，本次按每章 ${targetWords} 字拆`);
  const partsByChapter = asTotal
    ? allocateChapterParts(picked.map(row => ({ targetId: Number(row.id), characters: chapterCharacterCount(stringValue(row.content)) })), asTotal)
    : new Map<number, number>();

  for (const [index, row] of picked.entries()) {
    const title = stringValue(row.title);
    const paragraphs = splitParagraphs(stringValue(row.content));
    const total = paragraphs.reduce((sum, item) => sum + chapterCharacterCount(item), 0);
    if (paragraphs.length < 2) {
      failures.push(`《${title || row.id}》整章没有分段，没有拆分`);
      continue;
    }
    const parts = partsByChapter.get(Number(row.id));
    // 报了总章数而这一章只分到 1 章：它就该原样留着，再拆就超出作者要的章数
    if (partsByChapter.size && (!parts || parts < 2)) {
      failures.push(`《${title || row.id}》只有 ${total} 字，是这几章里最短的，为凑足你要的章数它保持原样`);
      continue;
    }
    const breakAfter = planChapterBreaks(paragraphs, targetWords, parts);
    if (!breakAfter.length) {
      failures.push(parts && parts >= 2
        ? `《${title || row.id}》只有 ${total} 字、${paragraphs.length} 个段落，切不出 ${parts} 段那么多`
        : `《${title || row.id}》只有 ${total} 字，没到需要拆分的长度`);
      continue;
    }
    emitProgress(runId, { type: 'progress', data: { step: 'chapter-split', progress: Math.min(72, 40 + Math.round(index / picked.length * 32)), message: `已规划 ${index + 1}/${picked.length} 章` } });
    // 只给切出来的后续段落命名，第一段留用原标题，作者的章号编排不被打乱
    const bodies = partsFromBreaks(paragraphs, breakAfter);
    const base = title.replace(/^\s*第\s*[0-9０-９一二三四五六七八九十百千零两]+\s*[章节回卷]\s*[：:、.．·\-—]?\s*/u, '').trim();
    let named: string[] = [];
    try {
      const answer = await mobileChat({ ...params, runId: runId ? `${runId}:split-${row.id}` : '', maxOutputTokens: 900 }, [
        { role: 'system', content: mobileTitleSystemPrompt },
        { role: 'user', content: `小说《${projectTitle || '未命名小说'}》的一章被拆成 ${bodies.length} 段，请给第 2 段起的每一段命名。\n${stringValue(request.instruction) ? `作者要求：${stringValue(request.instruction)}\n` : ''}${bodies.slice(1).map((body, order) => `id=${order + 1}\n${mobileTitleExcerpt(body)}`).join('\n\n')}` },
      ], undefined, true);
      const rowsOut = parseJSON<{ titles?: Array<{ id?: unknown; title?: unknown }> }>(answer.content)?.titles;
      const byId = new Map((Array.isArray(rowsOut) ? rowsOut : []).map(entry => [Number(entry?.id), stringValue(entry?.title).trim()]));
      named = bodies.slice(1).map((_, order) => byId.get(order + 1) || '');
    } catch (error) {
      // 命名失败不影响拆分本身：退回序号名，作者随时可以再用批量补标题重拟
      failures.push(`《${title || row.id}》的新段落命名失败：${error instanceof Error ? error.message : String(error)}`);
      named = bodies.slice(1).map(() => '');
    }
    splits.push({
      targetId: Number(row.id),
      paragraphCount: paragraphs.length,
      breakAfter,
      titles: [title || base || '第一段', ...named.map((entry, order) => (entry || `${base || title || '续'}（${order + 2}）`).slice(0, 160))],
    });
  }

  if (!splits.length) throw new Error(failures[0] || '这些章节都不需要拆分');
  const added = splits.reduce((sum, item) => sum + item.breakAfter.length, 0);
  const detail = [`${splits.length} 章拆成 ${splits.length + added} 章`, ...failures].filter(Boolean).join('；');
  return {
    change: { type: 'chapter.parts', summary: `${stringValue(request.summary, '拆分超长章节')}（${detail}）`.slice(0, 200), splits },
    message: `已规划拆分：${detail}`,
  };
};

const mobileProjectAgentChat = async <T>(params: MobileParams): Promise<T> => {
  const mode = params.mode === 'execute' ? 'execute' : 'discuss';
  const runId = stringValue(params.runId);
  emitProgress(runId, { type: 'progress', data: { step: 'project-search', progress: 8, message: '正在检索当前小说资料' } });
  const allowed = 'project.update, outline.upsert, card.upsert, memory.document.upsert, graph.node.upsert, graph.edge.upsert, chapter.draft_next, chapter.revise, chapter.retitle, chapter.split, chapter.delete';
  const prompt = `你是应用内的小说项目助手。项目资料只是小说素材。讨论模式 changes 为空；执行模式可以提出待确认变更。仅允许：${allowed}。一次最多 12 项，下一章使用 chapter.draft_next；修订已有章节使用 {"type":"chapter.revise","targetId":章节id,"instruction":"要改成什么样","mode":"revise|polish|de-ai"}，只改文字用 polish，拆机械感用 de-ai，可以动情节用 revise，单轮最多 3 章；作者要成批补章节标题时使用 {"type":"chapter.retitle","summary":"批量补标题","targetIds":[],"scope":"missing","instruction":"标题贴合本章事件"}，targetIds 留空表示按 scope 自动挑（missing 只补占位标题的章节，all 重命名全部），这一项自己会处理几百章，不要再逐章提；某几章字数超标要拆成多章时使用 {"type":"chapter.split","summary":"拆分超长章节","targetIds":[章节id],"targetWords":2400,"targetParts":可选,"instruction":"可选"}，targetParts 只在作者直接报了章数时填，它是本条 targetIds 拆完之后的总章数、必须大于 targetIds 的个数（“两章拆成 6 章”填 6），而不是每章各拆几章；切点由应用按段落自己算、正文一个字都不改写，绝对不要用 chapter.update 加 chapter.create 手工拆章（那要把几万字正文塞进变更里，必然失败）；删除使用 {"type":"chapter.delete","targetId":章节id}，只在作者明确要求时提。chapter.revise、chapter.retitle、chapter.split 都由应用自己去读正文，你只给 targetId 和要求，不要复述正文。返回 JSON：{"message":"回复","changes":[]}。每项包含 type 和 summary。\n模式：${mode}\n请求：${stringValue(params.instruction)}\n项目摘要：${JSON.stringify(mobileProjectAgentContext(params))}\n最近对话：${JSON.stringify(Array.isArray(params.history) ? params.history.slice(-6) : [])}`;
  emitProgress(runId, { type: 'progress', data: { step: 'project-plan', progress: 22, message: '正在分析请求并制定操作计划' } });
  const response = await mobileChat({ ...params, maxOutputTokens: 6500 }, [
    { role: 'system', content: '保持小说资料一致，只返回约定 JSON；所有修改都只是待确认提案。' },
    { role: 'user', content: prompt },
  ], undefined, true);
  const parsed = parseJSON<Record<string, unknown>>(response.content) || {};
  const planned = mode === 'execute' && Array.isArray(parsed.changes) ? parsed.changes.slice(0, 12) : [];
  const changes: unknown[] = [];
  const toolEvents: Array<{ tool: string; status: 'complete' | 'error'; message: string }> = [{ tool: 'project.search', status: 'complete', message: '已检索当前小说资料' }];
  const project = params.project && typeof params.project === 'object' ? params.project as Record<string, unknown> : {};
  const chapters = Array.isArray(project.chapters) ? project.chapters : [];
  const outlines = Array.isArray(project.outlines) ? project.outlines : [];
  for (const item of planned) {
    const kind = item && typeof item === 'object' ? (item as Record<string, unknown>).type : '';
    if (kind !== 'chapter.draft_next' && kind !== 'chapter.revise' && kind !== 'chapter.retitle' && kind !== 'chapter.split') {
      changes.push(item);
      continue;
    }
    const request = item as Record<string, unknown>;
    const { project: _project, history: _history, instruction: _projectInstruction, mode: _projectMode, ...modelParams } = params;
    if (kind === 'chapter.retitle') {
      // 批量补标题只回一条 chapter.titles 变更：几百章不能各自占一项，也不能把正文回传
      try {
        const result = await mobileChapterTitles(modelParams, request, chapters, stringValue(project.title), runId);
        changes.push(result.change);
        toolEvents.push({ tool: 'chapter.retitle', status: 'complete', message: result.message });
      } catch (error) {
        toolEvents.push({ tool: 'chapter.retitle', status: 'error', message: `批量补标题失败：${error instanceof Error ? error.message : String(error)}` });
      }
      continue;
    }
    if (kind === 'chapter.split') {
      // 拆章同样只回一条 chapter.parts：切点是段落序号，正文留在本地，几万字不进模型也不进变更
      try {
        const result = await mobileChapterSplit(modelParams, request, chapters, stringValue(project.title), runId);
        changes.push(result.change);
        toolEvents.push({ tool: 'chapter.split', status: 'complete', message: result.message });
      } catch (error) {
        toolEvents.push({ tool: 'chapter.split', status: 'error', message: `拆分章节失败：${error instanceof Error ? error.message : String(error)}` });
      }
      continue;
    }
    if (kind === 'chapter.revise') {
      // 修订走 text.transform 的三种口径，与桌面端同一条路径
      const reviseMode = mobileReviseModes[String(request.mode || 'revise')] ? String(request.mode || 'revise') : 'revise';
      const reviseLabel = mobileReviseModes[reviseMode];
      const targetId = Number(request.targetId);
      const target = chapters.find(entry => entry && typeof entry === 'object' && Number((entry as Record<string, unknown>).id) === targetId) as Record<string, unknown> | undefined;
      try {
        if (!target) throw new Error(`找不到待修订的章节 ID ${targetId}`);
        const original = stringValue(target.content).trim();
        if (!original) throw new Error(`章节《${stringValue(target.title)}》没有正文可修订`);
        emitProgress(runId, { type: 'progress', data: { step: 'chapter-revise', progress: 36, message: `正在${reviseLabel}《${stringValue(target.title, '章节')}》` } });
        const revised = await mobileAgentRpc<Record<string, unknown>>('text.transform', {
          ...modelParams,
          runId: runId ? `${runId}:revise-${targetId}` : '',
          maxOutputTokens: 8000,
          mode: reviseMode,
          instruction: stringValue(request.instruction),
          content: original,
          projectTitle: project.title,
          chapterTitle: target.title,
        });
        const revisedContent = stringValue(revised.content).trim();
        if (!revisedContent) throw new Error(`${reviseLabel}智能体没有返回可用正文`);
        changes.push({ type: 'chapter.update', summary: stringValue(request.summary, `${reviseLabel}章节`), targetId, content: revisedContent });
        toolEvents.push({ tool: 'chapter.revise', status: 'complete', message: `《${stringValue(target.title, '章节')}》已${reviseLabel}` });
      } catch (error) {
        toolEvents.push({ tool: 'chapter.revise', status: 'error', message: `${reviseLabel}失败（${stringValue(request.summary, '章节')}｜目标 ${targetId}）：${error instanceof Error ? error.message : String(error)}` });
      }
      continue;
    }
    try {
      emitProgress(runId, { type: 'progress', data: { step: 'chapter-delegate', progress: 36, message: '正在委托章节智能体起草下一章' } });
      const outlineId = Number(request.outlineId);
      const outline = outlines.find(entry => entry && typeof entry === 'object' && Number((entry as Record<string, unknown>).id) === outlineId) as Record<string, unknown> | undefined;
      const drafted = await mobileAgentRpc<Record<string, unknown>>('chapter.write', {
        ...modelParams,
        // 独立 runId：避免章节智能体的 complete 事件把项目 Agent 的进度提前推到 100%
        runId: runId ? `${runId}:chapter` : '',
        maxOutputTokens: 8000,
        projectId: project.id,
        projectTitle: project.title,
        chapterId: `project-agent-next-${Date.now()}`,
        instruction: stringValue(request.instruction),
        outline: stringValue(outline?.content),
        outlines,
        cards: Array.isArray(project.cards) ? project.cards : [],
        previousChapters: chapters.length ? [chapters[chapters.length - 1]] : [],
        memories: Array.isArray(project.memories) ? project.memories.slice(-2) : [],
        memoryDocuments: Array.isArray(project.memoryDocuments) ? project.memoryDocuments : [],
        knowledgeGraph: { nodes: project.graphNodes || [], edges: project.graphEdges || [] },
      });
      // 非 JSON 回退分支不会拆标题，这里再拆一次；拆分幂等，已拆过的正文原样返回
      const draft = splitChapterTitleHeading(stringValue(drafted.draftContent || drafted.content));
      const content = draft.content;
      if (!content) throw new Error('章节智能体没有返回可用正文');
      // 项目 Agent 没给章节起名时用章节智能体的标题补上占位章号（chapter.write 已做过单章命名兵底）
      const placeholderTitle = stringValue(request.title, `第 ${chapters.length + 1} 章`);
      const title = applyDraftChapterTitle(placeholderTitle, draft.title || stringValue(drafted.chapterTitle)).slice(0, 160);
      changes.push({ type: 'chapter.create', summary: stringValue(request.summary, '起草下一章'), title, content, chapterPlan: stringValue(drafted.chapterPlan), chapterSummary: stringValue(drafted.summary) });
      toolEvents.push({ tool: 'chapter.draft_next', status: 'complete', message: '章节草稿已生成' });
    } catch (error) {
      toolEvents.push({ tool: 'chapter.draft_next', status: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }
  emitProgress(runId, { type: 'complete', data: { message: changes.length ? `已生成 ${changes.length} 项待确认变更` : '项目 Agent 已完成回复' } });
  return { message: stringValue(parsed.message, changes.length ? `已生成 ${changes.length} 项待确认变更。` : '任务已完成。'), changes, toolEvents } as T;
};

const mobileAgentRpc = async <T>(method: string, params: MobileParams): Promise<T> => {
  if (method === 'usage.summary') return readUsage() as T;
  if (method === 'project.agent.chat') return mobileProjectAgentChat<T>(params);
  if (method === 'ranking.categories') return mobileNovelCatchCategories() as T;
  if (method === 'ranking.fetch') return mobileRankingFetch(params) as T;
  if (method === 'book.search.all' || method === 'book.search') {
    if (method === 'book.search') {
      const sourceId = stringValue(params.source, 'fanqie');
      if (sourceId === 'fanqie') return mobileFanqieSearch(stringValue(params.query).trim()) as T;
      const source = mobileQianyueSources.find(item => item.id === sourceId);
      if (!source) throw new Error('未知小说书源');
      return { books: await mobileSearchOneQianyueSource(source, stringValue(params.query).trim()), sourceId, sourceName: source.name } as T;
    }
    return mobileSearchAllQianyue(stringValue(params.query).trim()) as T;
  }
  if (method === 'book.download') {
    const sourceId = stringValue(params.source, 'fanqie');
    const source = mobileQianyueSources.find(item => item.id === sourceId);
    if (!source) throw new Error(sourceId === 'fanqie' ? '番茄移动端下载规则暂不可用，请从可下载书源结果中选择其它来源。' : '未知小说书源');
    return mobileQianyueDownload(source, stringValue(params.title), stringValue(params.author), stringValue(params.sourceBookId), stringValue(params.url), Number(params.maxChapters) || Number.MAX_SAFE_INTEGER) as T;
  }
  if (method === 'book.chapter.download') {
    const sourceId = stringValue(params.source);
    const source = mobileQianyueSources.find(item => item.id === sourceId);
    if (!source) throw new Error(sourceId === 'fanqie' ? '番茄移动端单章下载规则暂不可用，请选择其它书源。' : '未知小说书源');
    if (!params.chapter || typeof params.chapter !== 'object') throw new Error('缺少需要重新下载的章节');
    return { chapter: await mobileQianyueDownloadChapter(source, params.chapter as Record<string, unknown>) } as T;
  }
  const fetcher = await httpFetch();
  if (method === 'book.sources.list') {
    return { sources: [{ id: 'fanqie', name: '番茄小说' }, ...mobileQianyueSources.map(source => ({ id: source.id, name: source.name }))], defaultSourceId: mobileQianyueSources[0]?.id || 'fanqie' } as T;
  }
  if (method === 'gateway.usage') {
    const apiKey = stringValue(params.apiKey).trim();
    if (!apiKey) throw new Error('请先在设置中填写 API Key。');
    const keys = [apiKey];
    const root = baseURL(params.baseURL).replace(/\/v1\/?$/u, '');
    const getJSON = async (path: string, key?: string): Promise<Record<string, unknown>> => {
      const response = await fetcher(`${root}${path}`, { headers: { Accept: 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) } });
      const body = await response.text();
      if (!response.ok) throw new Error(`${path} 请求失败（${response.status}）：${body.replace(/\s+/gu, ' ').slice(0, 180)}`);
      return JSON.parse(body) as Record<string, unknown>;
    };
    const [statusResult, accounts] = await Promise.all([
      getJSON('/api/status').catch(error => ({ __error: String(error) })),
      Promise.all(keys.map(async (key, keyIndex) => {
        const [usage, logs, pricing] = await Promise.allSettled([getJSON('/api/usage/token', key), getJSON('/api/log/token', key), getJSON('/api/pricing', key)]);
        const errors = [usage, logs].filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => String(result.reason));
        const usagePayload: Record<string, unknown> | undefined = usage.status === 'fulfilled' ? usage.value : undefined;
        const logsPayload = logs.status === 'fulfilled' ? logs.value : undefined;
        const pricingPayload = pricing.status === 'fulfilled' ? pricing.value : undefined;
        return {
          keyIndex, keyHint: `${key.slice(0, 4)}••••${key.slice(-4)}`,
          usage: usagePayload?.data && typeof usagePayload.data === 'object' ? usagePayload.data : undefined,
          logs: Array.isArray(logsPayload?.data) ? logsPayload.data : [],
          pricing: Array.isArray(pricingPayload?.data) ? pricingPayload.data : [],
          group: usagePayload?.data && typeof usagePayload.data === 'object' && typeof (usagePayload.data as Record<string, unknown>).group === 'string' ? String((usagePayload.data as Record<string, unknown>).group) : undefined,
          groupRatios: pricingPayload?.group_ratio && typeof pricingPayload.group_ratio === 'object' ? pricingPayload.group_ratio as Record<string, number> : undefined,
          usableGroups: pricingPayload?.usable_group && typeof pricingPayload.usable_group === 'object' ? pricingPayload.usable_group as Record<string, unknown> : undefined,
          ...(errors.length ? { error: errors.join('；') } : {}),
        };
      })),
    ]);
    const pricing = accounts.flatMap(account => account.pricing || []).filter((item, index, all) => all.findIndex(other => String(other.model_name) === String(item.model_name)) === index);
    const status = statusResult as Record<string, unknown>;
    return {
      fetchedAt: new Date().toISOString(),
      status: status.data && typeof status.data === 'object' ? status.data : undefined,
      pricing,
      accounts,
      errors: [status.__error].filter((value): value is string => typeof value === 'string'),
    } as T;
  }
  if (method === 'models.list') {
    const apiKey = stringValue(params.apiKey).trim();
    if (!apiKey) throw new Error('请先在设置中填写 API Key。');
    const mode = normalizeWireMode(params.apiMode);
    const base = baseURL(params.baseURL, mode);
    const endpoint = modelsEndpoint(base, mode);
    const response = await fetcher(endpoint, { headers: { ...authHeaders(apiKey, mode), Accept: 'application/json' } });
    if (!response.ok) throw new Error(`模型列表请求失败（${response.status}）：${(await response.text()).replace(/\s+/gu, ' ').slice(0, 160)}`);
    const data = await response.json() as { data?: Array<{ id?: string } | string>; models?: Array<{ id?: string } | string> };
    const models = (data.data || data.models || []).map(item => typeof item === 'string' ? item : item.id || '').filter(Boolean);
    if (!models.length) throw new Error(`${endpoint} 没有返回可用模型`);
    return { models } as T;
  }
  if (method === 'settings.diagnose') {
    const mode = normalizeWireMode(params.apiMode);
    const checks: Array<{ id: string; label: string; status: 'pass' | 'warn' | 'fail'; detail: string }> = [];
    let base = '';
    try {
      base = baseURL(params.baseURL, mode);
    } catch (error) {
      return { mode, modelsEndpoint: '', chatEndpoint: '', checks: [{ id: 'address', label: '接口地址', status: 'fail', detail: error instanceof Error ? error.message : String(error) }] } as T;
    }
    const chat = chatEndpoint(base, mode);
    const models = modelsEndpoint(base, mode);
    const modeName = mode === 'anthropic' ? 'Anthropic Messages' : 'OpenAI 兼容';
    checks.push({ id: 'address', label: '接口地址', status: 'pass', detail: `${modeName} · ${chat}` });
    const apiKey = stringValue(params.apiKey).trim();
    checks.push(apiKey
      ? { id: 'keys', label: 'API 密钥', status: 'pass', detail: `认证方式 ${mode === 'anthropic' ? 'x-api-key' : 'Authorization: Bearer'}` }
      : { id: 'keys', label: 'API 密钥', status: 'fail', detail: '没有配置 API Key' });
    if (!apiKey) return { mode, modelsEndpoint: models, chatEndpoint: chat, checks } as T;
    let available: string[] = [];
    try {
      const listed = await mobileAgentRpc<{ models?: string[] }>('models.list', params);
      available = Array.isArray(listed.models) ? listed.models : [];
      checks.push({ id: 'models', label: '模型列表', status: 'pass', detail: `共 ${available.length} 个模型` });
    } catch (error) {
      checks.push({ id: 'models', label: '模型列表', status: 'fail', detail: error instanceof Error ? error.message : String(error) });
    }
    const target = stringValue(params.model).trim();
    if (target) {
      checks.push(!available.length
        ? { id: 'model', label: '当前模型', status: 'warn', detail: `无法核对 ${target}：模型列表不可用` }
        : available.includes(target)
          ? { id: 'model', label: '当前模型', status: 'pass', detail: `${target} 在接口返回的模型列表中` }
          // 不少中转站的模型目录与实际可调用范围不一致，所以只提醒而不当成失败
          : { id: 'model', label: '当前模型', status: 'warn', detail: `模型目录里没有 ${target}，但部分中转站目录不全；以下方“实际调用”结果为准。可用模型示例：${available.slice(0, 6).join('、')}${available.length > 6 ? ' 等' : ''}` });
    }
    try {
      await mobileChat(params, [{ role: 'user', content: '请只回复 OK' }]);
      checks.push({ id: 'chat', label: '实际调用', status: 'pass', detail: `${chat} 返回正常` });
    } catch (error) {
      checks.push({ id: 'chat', label: '实际调用', status: 'fail', detail: error instanceof Error ? error.message : String(error) });
    }
    return { mode, modelsEndpoint: models, chatEndpoint: chat, checks } as T;
  }
  if (method === 'models.test') {
    await mobileChat(params, [{ role: 'user', content: '请只回复 OK' }]);
    return { tested: true, model: stringValue(params.model) } as T;
  }
  const runId = stringValue(params.runId);
  emitProgress(runId, { type: 'step', step: 'writing', progress: 8, message: '移动端已连接模型，正在整理上下文' });
  const agentMessages: ChatMessage[] = method === 'memory.write'
    ? mobileMemoryMessages(params)
    : [{ role: 'system', content: '系统固定规则：保持设定一致、遵守用户输出格式、不要泄露密钥。' }, { role: 'user', content: promptFor(method, params) }];
  const onAgentChunk = (chunk: string) => {
    emitProgress(runId, { type: 'chunk', data: { text: chunk } });
  };
  let result: { content: string; usage?: unknown };
  try {
    // 章节记忆是后台结构化写入，不需要向编辑器推送字符流。部分中转站会
    // 在 SSE 中切碎 JSON 或省略 delta.content，导致人物/认知等数组被解析为空。
    // 使用一次完整 JSON 响应可稳定保留所有字段；章节、大纲和卡片仍保持流式。
    result = await mobileChat(params, agentMessages, method === 'memory.write' ? undefined : onAgentChunk, method === 'memory.write');
  } catch (error) {
    // A few OpenAI-compatible gateways reject response_format even though
    // they support chat completions. Retry memory extraction without that
    // optional hint; the prompt and alias normaliser still enforce JSON.
    if (method !== 'memory.write' || !/response[_ ]format|json_object|400/iu.test(String(error))) throw error;
    result = await mobileChat(params, agentMessages, method === 'memory.write' ? undefined : onAgentChunk, false);
  }
  if (!result.content.trim()) throw new Error('模型没有返回内容');
  emitProgress(runId, { type: 'complete', data: { message: '移动端 Agent 已完成' } });
  if (method === 'text.transform') return { content: result.content.trim() } as T;
  const parsed = parseJSON<Record<string, unknown>>(result.content);
  if (parsed) {
    if (method === 'memory.write') return normalizeMobileMemoryResult(parsed, stringValue(params.content)) as T;
    if (method === 'chapter.write') {
      // 章节标题属于标题栏：优先用信封的 title 字段，模型仍在正文开头补一道 # 标题时就拆出那一行，正文只留纯文本
      const draft = splitChapterTitleHeading(stringValue(parsed.draftContent || parsed.content));
      const envelopeTitle = cleanChapterTitleName(stringValue(parsed.title || parsed.chapterTitle || parsed['标题']));
      // 两边都没给标题时补一次极小的命名请求：写完整章才发现没名字，让作者自己回头补更不划算
      const fallbackTitle = envelopeTitle || draft.title
        || (draft.content.trim() ? await mobileChapterTitle(params, draft.content, stringValue(params.projectTitle), stringValue(params.instruction)) : '');
      return { ...parsed, draftContent: draft.content, chapterTitle: fallbackTitle, summary: stringValue(parsed.summary) } as T;
    }
    return parsed as T;
  }
  if (method === 'chapter.write' || method === 'book.rewrite') return { content: result.content.trim() } as T;
  if (method === 'outline.write' || method === 'card.write') return { content: result.content.trim() } as T;
  return { content: result.content.trim() } as T;
};

/** Agent runtime remains platform-specific; 百度网盘同步在所有 Tauri 平台统一走 HTTP API。 */
export const invoke = async <T>(command: string, args?: InvokeArgs): Promise<T> => {
  if (directBaiduRuntime() && command === 'cloud_sync_status') return mobileBaiduStatus() as T;
  if (directBaiduRuntime() && command === 'baidu_login_url') return mobileBaiduLoginURL() as T;
  if (directBaiduRuntime() && command === 'complete_baidu_login') {
    const input = args as { code?: string } | undefined;
    return mobileBaiduCompleteLogin(stringValue(input?.code)) as T;
  }
  if (directBaiduRuntime() && command === 'backup_projects_to_baidu') {
    const input = args as { remotePath?: string; clientState?: Record<string, string | null> } | undefined;
    return mobileBaiduBackup(stringValue(input?.remotePath), input?.clientState || {}) as T;
  }
  if (directBaiduRuntime() && command === 'list_baidu_backups') {
    const input = args as { remotePath?: string } | undefined;
    return mobileBaiduListBackups(stringValue(input?.remotePath)) as T;
  }
  if (directBaiduRuntime() && command === 'restore_projects_from_baidu') {
    const input = args as { remotePath?: string; backupPath?: string; backupFsId?: string } | undefined;
    return mobileBaiduRestore(stringValue(input?.remotePath), stringValue(input?.backupPath), stringValue(input?.backupFsId)) as T;
  }
  if (!mobileRuntime()) return nativeInvoke<T>(command, args);
  if (command === 'start_agent_runtime') return 'Mobile direct Agent ready' as T;
  if (command === 'call_agent_rpc') {
    const input = args as AgentRpcCall | undefined;
    if (!input?.method) throw new Error('缺少 Agent RPC 方法。');
    return mobileAgentRpc<T>(input.method, input.params || {});
  }
  if (command === 'detect_system_proxy') return null as T;
  return nativeInvoke<T>(command, args);
};

export const isMobileRuntime = mobileRuntime;
export const isDirectBaiduRuntime = directBaiduRuntime;
