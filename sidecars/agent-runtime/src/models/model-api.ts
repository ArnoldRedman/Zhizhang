import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ProxyAgent } from "undici";
import { fitMessagesToTokenBudget } from "../context/token-budget.js";
import { anthropicText, anthropicThinkingBudget, authHeaders as protocolAuthHeaders, normalizeWireMode, openAIReasoningEffort, toAnthropicMessages } from "@zhizhang/model-protocol";

export type ModelProvider = "openai" | "claude";

export interface ModelInput {
  provider: ModelProvider;
  apiKey: string;
  model: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ModelConfig {
  provider: ModelProvider;
  apiKey: string;
  model: string;
  baseUrl: string;
  temperature?: number;
  maxTokens?: number;
}

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, "");

// 应用不内置任何 OpenAI 兼容厂商：地址为空时直接报错，不能悄悄连到某个默认站点
function normalizeOpenAIBaseURL(value?: string): string {
  const raw = trimTrailingSlash(value?.trim() || "");
  if (!raw) throw new Error("请先在设置中填写 API 接口地址");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("API 地址无效，请填写完整的 http:// 或 https:// 地址");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("API 地址仅支持 http:// 或 https:// 协议");
  }
  return /\/v1$/i.test(raw) ? raw : `${raw}/v1`;
}

/** Wire protocol actually spoken on the network. Legacy stored values such as
 * "responses" collapse to the OpenAI-compatible transport. */
export type ApiWireMode = "openai" | "anthropic";

const DEFAULT_ANTHROPIC_ROOT = "https://api.anthropic.com";

export { normalizeWireMode };

/** Anthropic addresses are stored as a root, because `/v1/messages` and
 * `/v1/models` hang off it. Users paste all three shapes, so accept them all. */
function normalizeAnthropicRoot(value?: string): string {
  const raw = trimTrailingSlash(value?.trim() || DEFAULT_ANTHROPIC_ROOT);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("API 地址无效，请填写完整的 http:// 或 https:// 地址");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("API 地址仅支持 http:// 或 https:// 协议");
  }
  return trimTrailingSlash(raw.replace(/\/v1(?:\/messages)?$/i, ""));
}

// OpenAI's Chat Completions API only accepts these four efforts, so "max"
// saturates at "high". Anthropic instead takes an explicit thinking budget,
// which is where the stronger levels become meaningful.

/**
 * OpenAI 兼容接口的思考预留（token）
 * 这类接口的思考 token 和正文共用 max_tokens：不给思考留额度，模型把额度全用在思考上，正文返回空，
 * 调用方只会看到“输出被截断”或“只返回了推理内容”（实测标题、章纲、记忆提炼、章节正文都踩过）
 * 实测 deepseek/deepseek-flash 这种开启推理的模型，连“返回 {ok:true}”都要花 700+ 思考 token
 */
const openAIReasoningHeadroom: Readonly<Record<string, number>> = Object.freeze({ minimal: 3000, low: 4000, medium: 8000, high: 12000, max: 12000 });

/**
 * 这个模型这次请求要留多少思考额度
 * 满足任一条件就留：模型名能确定是推理模型、解析过它的响应带 reasoningTokens、或者作者把推理强度设成了具体档位
 * （不能假设“没发 reasoning_effort 就不思考”：很多中继不认这个参数，模型照旧思考）
 */
function openAIReasoningTokens(reasoningMode: string | undefined, model: string, learned: boolean): number {
  if (!reasoningMode || reasoningMode === "off") return 0;
  const wantsThinking = supportsOpenAIReasoning(model) || learned || reasoningMode !== "auto";
  if (!wantsThinking) return 0;
  return openAIReasoningHeadroom[openAIReasoningEffort[reasoningMode] ?? "high"] ?? 0;
}

const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

/** 所有出网请求都必须带超时。Agent Runtime 每次只处理一个 RPC，
 * 上游一旦挂住不返回，整个 Runtime 乃至界面都会跟着卡死 */
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) } as RequestInit);
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒无响应）：${url}`);
    }
    throw error;
  }
}
const isQuotaExceeded = (value: string): boolean => /quota\s+(?:has\s+been\s+)?exceeded|insufficient[\s_-]*quota|billing[\s_-]*(?:limit|quota)|余额不足|额度(?:已)?用尽/i.test(value);

function supportsOpenAIJsonMode(model: string): boolean {
  // Gemini's OpenAI-compatible adapters commonly reject response_format at
  // the upstream gateway, even though a plain chat completion works.
  return !/^gemini(?:[-:/]|$)/iu.test(model.trim());
}

function supportsOpenAIReasoning(model: string): boolean {
  return /^(?:gpt-|o\d|chatgpt-)/iu.test(model.trim());
}

const MAX_ERROR_BODY_CHARS = 800;

type ErrorBodyKind = "json" | "html" | "text" | "empty";

interface ErrorBody {
  kind: ErrorBodyKind;
  /** 可直接展示给作者的说明；JSON 取 message 字段，其余为截断后的原文 */
  text: string;
  bytes: number;
}

const truncateBody = (value: string, limit: number) =>
  value.length <= limit ? value : `${value.slice(0, limit)}…（其余 ${value.length - limit} 字符已省略）`;

/**
 * 归一化上游错误响应体
 * 中转站、CDN 和 WAF 的失败响应不一定是 JSON：只解析 JSON 会把 HTML 错误页和空
 * 响应体一起丢掉，最后只剩一个光秃秃的状态码，反而把排查方向带偏
 */
function describeErrorBody(detail: string): ErrorBody {
  const bytes = Buffer.byteLength(detail, "utf8");
  const trimmed = detail.trim();
  if (!trimmed) return { kind: "empty", text: "", bytes };
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const error = parsed.error && typeof parsed.error === "object" ? parsed.error as Record<string, unknown> : parsed;
      const message = [error.message, error.detail, parsed.message, error.type]
        .find(value => typeof value === "string" && value.trim());
      // JSON 结构正常但没有可读字段时，原样回传压缩后的 JSON，不要退化成空
      const text = typeof message === "string" ? message.trim() : trimmed;
      return { kind: "json", text: truncateBody(text.replace(/\s+/gu, " "), MAX_ERROR_BODY_CHARS), bytes };
    } catch {
      // JSON 解析失败就当纯文本处理，不丢弃内容
    }
  }
  if (/^<(?:!doctype|html|head|body)/iu.test(trimmed)) {
    const title = /<title[^>]*>([^<]{1,200})<\/title>/iu.exec(trimmed)?.[1]?.trim();
    return {
      kind: "html",
      text: title
        ? `上游返回了网页错误页面（${title}），通常来自反向代理、CDN 或 WAF，而不是模型接口`
        : "上游返回了网页错误页面，通常来自反向代理、CDN 或 WAF，而不是模型接口",
      bytes,
    };
  }
  return { kind: "text", text: truncateBody(trimmed.replace(/\s+/gu, " "), MAX_ERROR_BODY_CHARS), bytes };
}

/**
 * 上下文或请求体超限
 * 这类失败必须与鉴权失败分开：提示“检查 Key”对超限毫无帮助。
 * 部分网关对超大请求体只回一个空响应体的 413/400，所以空 body 的这两个状态码也按超限处理。
 */
const CONTEXT_OVERFLOW_PATTERNS = [
  /prompt is too long/iu,                                     // Anthropic token 超限
  /request_too_large/iu,                                      // Anthropic 请求体超限（413）
  /exceeds the context window/iu,                             // OpenAI
  /exceeds (?:the )?(?:model'?s )?maximum context length/iu,  // OpenAI 兼容中转
  /input token count.*exceeds the maximum/iu,                 // Gemini
  /maximum prompt length is \d+/iu,                           // xAI
  /reduce the length of the messages/iu,                      // Groq
  /context[_ ]length[_ ]exceeded/iu,
  /too many tokens/iu,
  /token limit exceeded/iu,
  /payload too large|request entity too large|body exceeded/iu, // Nginx / 网关
  /上下文长度|超出.{0,6}上下文|输入过长|请求体过大/u,
];
// 频控文案里的 “too many tokens” 不是超限，先排除
const NON_OVERFLOW_PATTERN = /rate.?limit|too many requests|请求过于频繁/iu;

function isContextOverflow(status: number, body: ErrorBody): boolean {
  if (NON_OVERFLOW_PATTERN.test(body.text)) return false;
  if (status === 413) return true;
  if (status === 400 && body.kind === "empty") return true;
  return CONTEXT_OVERFLOW_PATTERNS.some(pattern => pattern.test(body.text));
}

function protocolHint(status: number, mode: ApiWireMode): string {
  if (status === 404) {
    return mode === "anthropic"
      ? "。当前为 Anthropic Messages 模式，请确认接口地址支持 /v1/messages；若这是 OpenAI 兼容中转站，请把 API 格式切换回 OpenAI"
      : "。当前为 OpenAI 兼容模式，请确认接口地址支持 /v1/chat/completions；若这是 Anthropic 官方或 Claude 专用地址，请把 API 格式切换为 Anthropic Messages";
  }
  // 只陈述实际发送方式，不替上游断言 Key 无效
  if (status === 401 || status === 403) {
    return mode === "anthropic"
      ? "。当前以 Anthropic Messages 模式发送，使用 x-api-key 认证"
      : "。当前以 OpenAI 兼容模式发送，使用 Authorization: Bearer 认证";
  }
  return "";
}

interface ApiErrorContext {
  status: number;
  detail: string;
  statusText: string;
  attempts?: number;
  routeHint?: string;
  requestHint?: string;
  mode?: ApiWireMode;
  /** 请求体字节数，用于判断是否触发了网关的大小限制 */
  requestBytes?: number;
}

/**
 * 上游已经明确给出 HTTP 状态的失败
 * 不能用错误文案前缀区分“致命”和“网络抖动”：文案一改就会错分类，把已读过
 * 响应体的请求拉回重试，反而报成 “Body is unusable”。用类型携带这个事实。
 */
class ApiRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiRequestError";
  }
}

function apiErrorMessage(context: ApiErrorContext): string {
  const { status, detail, statusText, attempts = 1, routeHint = "", requestHint = "", mode = "openai", requestBytes } = context;
  const retrySuffix = attempts > 1 ? `，已自动重试 ${attempts - 1} 次` : "";
  const body = describeErrorBody(detail);
  const sizeHint = requestBytes ? `，本次请求体 ${(requestBytes / 1024).toFixed(1)} KB` : "";
  const upstream = body.text ? `上游说明：${body.text}` : "";

  if (isQuotaExceeded(detail)) {
    return `API 中转服务额度已用尽${routeHint}。章节正文已保存，本章记忆将在额度恢复后再更新。`;
  }
  if (isContextOverflow(status, body)) {
    return `请求超出模型上下文或网关的大小限制（${status}）${requestHint}${routeHint}${sizeHint}。请降低思考强度、缩小上下文窗口，或减少本次带入的章节与资料。${upstream}`.trim();
  }
  if ([502, 503, 504, 524].includes(status)) {
    return `API 中转服务当前返回 ${status}（可能来自代理或 API 上游网关）${requestHint}${routeHint}${retrySuffix}${body.text ? `：${body.text}` : ""}`;
  }
  if (status === 429) return `API 中转服务请求过于频繁${routeHint}${retrySuffix}，请稍后再试。${upstream}`.trim();
  if (status === 401 || status === 403) {
    // 只有上游真的给出说明时才指向 Key；空响应体的 403 多来自网关或 WAF，
    // 断言“Key 无效”会把排查方向带偏
    const cause = body.kind === "empty"
      ? `上游没有返回任何说明${sizeHint}。常见原因是反向代理、CDN 或 WAF 拦截（例如请求体过大或命中规则），也可能是该 Key 无权访问此模型或此地址`
      : upstream;
    return `模型接口拒绝了请求（${status}）${requestHint}${routeHint}${protocolHint(status, mode)}。${cause}`;
  }
  return `模型接口请求失败（${status}）${routeHint}${requestHint}${protocolHint(status, mode)}${sizeHint}：${body.text || statusText || "未知错误"}`;
}

export function buildModelConfig(input: ModelInput): ModelConfig {
  const anthropicBaseURL = trimTrailingSlash(input.baseUrl?.trim() || DEFAULT_ANTHROPIC_ROOT);
  const baseUrl = input.provider === "openai"
    ? normalizeOpenAIBaseURL(input.baseUrl)
    : anthropicBaseURL.endsWith("/messages") ? anthropicBaseURL : `${anthropicBaseURL}/v1/messages`;
  return {
    provider: input.provider,
    apiKey: input.apiKey,
    model: input.model,
    baseUrl,
    temperature: input.temperature,
    maxTokens: input.maxTokens,
  };
}

export function createChatModel(config: ModelConfig): BaseChatModel {
  if (config.provider === "openai") {
    return new ChatOpenAI({
      apiKey: config.apiKey,
      model: config.model,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      configuration: { baseURL: config.baseUrl },
    });
  }
  return new ChatAnthropic({
    anthropicApiKey: config.apiKey,
    model: config.model,
    temperature: config.temperature,
    maxTokens: config.maxTokens ?? 4096,
    clientOptions: { baseURL: config.baseUrl },
  });
}

// Simple client for direct API calls
export interface ModelApiClientConfig {
  apiKey: string;
  baseURL?: string;
  defaultModel?: string;
  apiMode?: ApiWireMode | "responses";
  reasoningMode?: string;
  /** 上下文上限，单位为 1024 tokens */
  contextWindowKTokens?: number;
  proxyEnabled?: boolean;
  proxyURL?: string;
  proxyBypassLocal?: boolean;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: "json_object" | "text" };
  retryAttempts?: number;
}

export interface ApiUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface RuntimeUsageSummary extends Required<ApiUsage> {
  requests: number;
  startedAt: string;
}

export interface DiagnosticCheck {
  id: "address" | "keys" | "proxy" | "models" | "model" | "chat";
  label: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

export interface DiagnosticReport {
  mode: ApiWireMode;
  modelsEndpoint: string;
  chatEndpoint: string;
  checks: DiagnosticCheck[];
}

export interface GatewayUsageSnapshot {
  fetchedAt: string;
  status?: Record<string, unknown>;
  pricing?: Array<Record<string, unknown>>;
  accounts: Array<{ keyIndex: number; keyHint: string; usage?: Record<string, unknown>; logs: Array<Record<string, unknown>>; error?: string }>;
  errors: string[];
}

const runtimeUsage: RuntimeUsageSummary = {
  inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0,
  cacheWriteTokens: 0, reasoningTokens: 0, requests: 0, startedAt: new Date().toISOString(),
};

function recordRuntimeUsage(usage?: ApiUsage): void {
  if (!usage) return;
  runtimeUsage.inputTokens += usage.inputTokens || 0;
  runtimeUsage.outputTokens += usage.outputTokens || 0;
  runtimeUsage.totalTokens += usage.totalTokens || 0;
  runtimeUsage.cachedInputTokens += usage.cachedInputTokens || 0;
  runtimeUsage.cacheWriteTokens += usage.cacheWriteTokens || 0;
  runtimeUsage.reasoningTokens += usage.reasoningTokens || 0;
  runtimeUsage.requests += 1;
}

export function getRuntimeUsageSummary(): RuntimeUsageSummary {
  return { ...runtimeUsage };
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseUsage(value: unknown): ApiUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const prompt = usage.prompt_tokens_details as Record<string, unknown> | undefined;
  const input = usage.input_tokens_details as Record<string, unknown> | undefined;
  const completion = usage.completion_tokens_details as Record<string, unknown> | undefined;
  const output = usage.output_tokens_details as Record<string, unknown> | undefined;
  const result: ApiUsage = {
    inputTokens: numeric(usage.prompt_tokens) ?? numeric(usage.input_tokens),
    outputTokens: numeric(usage.completion_tokens) ?? numeric(usage.output_tokens),
    totalTokens: numeric(usage.total_tokens),
    cachedInputTokens: numeric(prompt?.cached_tokens) ?? numeric(input?.cached_tokens) ?? numeric(usage.cache_read_input_tokens) ?? numeric(usage.cached_tokens) ?? numeric(usage.prompt_cache_hit_tokens),
    cacheWriteTokens: numeric(prompt?.cache_write_tokens) ?? numeric(input?.cache_write_tokens) ?? numeric(usage.cache_creation_input_tokens),
    reasoningTokens: numeric(completion?.reasoning_tokens) ?? numeric(output?.reasoning_tokens),
  };
  if (result.totalTokens === undefined && result.inputTokens !== undefined && result.outputTokens !== undefined) {
    result.totalTokens = result.inputTokens + result.outputTokens;
  }
  return Object.values(result).some(value => value !== undefined) ? result : undefined;
}

/** Anthropic splits usage across `message_start` (input) and `message_delta`
 * (output), so streaming totals have to accumulate instead of overwrite. */
function mergeUsage(base: ApiUsage | undefined, next: ApiUsage | undefined): ApiUsage | undefined {
  if (!next) return base;
  if (!base) return next;
  const merged: ApiUsage = { ...base };
  for (const [field, value] of Object.entries(next) as Array<[keyof ApiUsage, number | undefined]>) {
    if (value !== undefined) merged[field] = value;
  }
  if (merged.inputTokens !== undefined && merged.outputTokens !== undefined) {
    merged.totalTokens = merged.inputTokens + merged.outputTokens;
  }
  return merged;
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(item => extractText(item)).filter(Boolean).join("\n");
  }
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (typeof record.content === "string") return record.content;
  return "";
}

/**
 * 响应本身合法但没有可用正文
 * 这类失败是确定性的，重试只会重复消耗额度；用 ApiRequestError 标记为不重试，
 * 否则会被当成网络抖动，最后包成误导的“无法连接 API 中转服务”。
 */
function emptyCompletionError(data: Record<string, unknown>, maxTokens: number): ApiRequestError {
  const choice = Array.isArray(data.choices) && data.choices[0] && typeof data.choices[0] === "object"
    ? data.choices[0] as Record<string, unknown>
    : undefined;
  const message = choice?.message && typeof choice.message === "object"
    ? choice.message as Record<string, unknown>
    : undefined;
  const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : "";
  if (finishReason === "length") {
    return new ApiRequestError(`模型输出被截断（max_tokens=${maxTokens}），请重试或提高输出上限`, 200);
  }
  const reasoningLength = [message?.reasoning_content, message?.reasoning]
    .find(value => typeof value === "string");
  if (typeof reasoningLength === "string" && reasoningLength.length > 0) {
    return new ApiRequestError("模型只返回了推理内容，没有正文；请关闭推理模式或提高输出上限", 200);
  }
  const topKeys = Object.keys(data).slice(0, 12).join(",");
  const choiceKeys = choice ? Object.keys(choice).slice(0, 12).join(",") : "";
  return new ApiRequestError(`模型返回内容为空（响应字段：${topKeys || "无"}；choice：${choiceKeys || "无"}）`, 200);
}

/** Only `text` blocks are prose. `thinking` and `tool_use` blocks share the
 * array and must not leak into a chapter. */
function emptyAnthropicError(data: Record<string, unknown>, maxTokens: number): ApiRequestError {
  const stopReason = typeof data.stop_reason === "string" ? data.stop_reason : "";
  if (stopReason === "max_tokens") {
    return new ApiRequestError(`模型输出被截断（max_tokens=${maxTokens}），请重试或提高输出上限`, 200);
  }
  const blocks = Array.isArray(data.content) ? data.content : [];
  const kinds = blocks
    .filter((block): block is Record<string, unknown> => Boolean(block && typeof block === "object"))
    .map(block => String(block.type ?? "unknown"));
  if (kinds.length && !kinds.includes("text")) {
    return new ApiRequestError(`Anthropic 接口只返回了 ${kinds.join("/")} 块，没有正文；请降低思考强度或提高输出上限`, 200);
  }
  return new ApiRequestError(`Anthropic 接口返回内容为空（stop_reason：${stopReason || "无"}；响应字段：${Object.keys(data).slice(0, 12).join(",") || "无"}）`, 200);
}

const proxyAgents = new Map<string, ProxyAgent>();

const isPrivateOrLocalHost = (hostname: string) => {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host === "::1" || host.startsWith("127.")) return true;
  if (host.startsWith("10.") || host.startsWith("192.168.")) return true;
  const parts = host.split(".").map(Number);
  return parts.length === 4 && parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31;
};

const proxyURLForRequest = (targetURL: string, config: Pick<ModelApiClientConfig, "proxyEnabled" | "proxyURL" | "proxyBypassLocal">) => {
  if (!config.proxyEnabled || !config.proxyURL?.trim()) return "";
  try {
    const proxy = new URL(config.proxyURL.trim());
    const target = new URL(targetURL);
    if (!/^https?:$/i.test(proxy.protocol)) return "";
    if (config.proxyBypassLocal === true && isPrivateOrLocalHost(target.hostname)) return "";
    return proxy.toString();
  } catch {
    return "";
  }
};

const proxyDispatcherFor = (targetURL: string, config: Pick<ModelApiClientConfig, "proxyEnabled" | "proxyURL" | "proxyBypassLocal">) => {
  const proxyURL = proxyURLForRequest(targetURL, config);
  if (!proxyURL) return undefined;
  const existing = proxyAgents.get(proxyURL);
  if (existing) return existing;
  const agent = new ProxyAgent(proxyURL);
  proxyAgents.set(proxyURL, agent);
  return agent;
};

const proxyRouteHint = (targetURL: string, config: Pick<ModelApiClientConfig, "proxyEnabled" | "proxyURL" | "proxyBypassLocal">) => {
  const proxyURL = proxyURLForRequest(targetURL, config);
  if (!proxyURL) return "";
  try {
    const proxy = new URL(proxyURL);
    return `，已通过代理 ${proxy.protocol}//${proxy.host}`;
  } catch {
    return "，已通过应用代理";
  }
};

export class ModelApiClient {
  private config: ModelApiClientConfig;
  /** 解析到过 reasoningTokens 的模型：中继可能不认 reasoning_effort，但模型确实在思考，下次要给它留额度 */
  private reasoningModels = new Set<string>();

  constructor(config: ModelApiClientConfig) {
    this.config = config;
  }

  private get wireMode(): ApiWireMode {
    return normalizeWireMode(this.config.apiMode);
  }

  /** Resolved network addresses. Exposed through `describeRoute` so error text
   * and the settings diagnostics can name the exact URL that was called. */
  private endpoints(): { models: string; chat: string } {
    if (this.wireMode === "anthropic") {
      const root = normalizeAnthropicRoot(this.config.baseURL);
      return { models: `${root}/v1/models`, chat: `${root}/v1/messages` };
    }
    const base = normalizeOpenAIBaseURL(this.config.baseURL);
    return { models: `${base}/models`, chat: `${base}/chat/completions` };
  }

  private authHeaders(key: string): Record<string, string> {
    return protocolAuthHeaders(key, this.wireMode);
  }

  // Anthropic 提供官方 count_tokens 端点；先用本地 tokenizer 裁剪，再用
  // 服务端真实计数校准。中转站未实现该端点时仍保持兼容编码的硬上限。
  /**
   * 输出预算 = 调用方要的正文额度 + 思考预留
   * 上限取窗口的一半：预留再重要也不能把输入挤没（fitContextMessages 会按这个数扣输入预算）
   */
  private outputBudget(baseTokens: number, reasoningTokens: number): number {
    const total = baseTokens + reasoningTokens;
    const contextTokens = Math.floor(Number(this.config.contextWindowKTokens || 0) * 1024);
    if (!contextTokens) return total;
    return Math.max(baseTokens, Math.min(total, Math.floor(contextTokens * 0.5)));
  }

  /** 记下这个模型会思考，供后续请求预留额度 */
  private noteReasoning(model: string, usage?: ApiUsage): void {
    if (!usage) return;
    if ((usage.reasoningTokens || 0) > 0) this.reasoningModels.add(model);
  }

  private async fitContextMessages(messages: ChatMessage[], maxOutputTokens: number, model: string, key: string): Promise<ChatMessage[]> {
    const contextTokens = Math.floor(Number(this.config.contextWindowKTokens || 0) * 1024);
    if (!contextTokens) return messages;
    if (maxOutputTokens >= contextTokens) {
      throw new Error(`当前输出和思考预算需要 ${maxOutputTokens.toLocaleString()} tokens，已超过 ${contextTokens.toLocaleString()} tokens 的上下文窗口`);
    }
    const inputBudget = contextTokens - maxOutputTokens;
    let localBudget = inputBudget;
    let fitted = fitMessagesToTokenBudget(messages, localBudget, model);
    if (this.wireMode !== "anthropic") return fitted;

    const endpoint = `${normalizeAnthropicRoot(this.config.baseURL)}/v1/messages/count_tokens`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const { system, turns } = toAnthropicMessages(fitted);
        const dispatcher = proxyDispatcherFor(endpoint, this.config);
        const response = await fetchWithTimeout(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...this.authHeaders(key) },
          body: JSON.stringify({ model, system: system || undefined, messages: turns }),
          ...(dispatcher ? { dispatcher } : {}),
        } as RequestInit, 20_000);
        if (!response.ok) return fitted;
        const data = await response.json() as { input_tokens?: number };
        const actual = Number(data.input_tokens) || 0;
        if (!actual || actual <= inputBudget) return fitted;
        localBudget = Math.max(256, Math.floor(localBudget * inputBudget / actual * 0.98));
        fitted = fitMessagesToTokenBudget(messages, localBudget, model);
      } catch {
        return fitted;
      }
    }
    return fitted;
  }

  describeRoute(): { mode: ApiWireMode; models: string; chat: string } {
    return { mode: this.wireMode, ...this.endpoints() };
  }

  /** 当前配置的唯一 Key。不再做多 Key 轮换，权限以实际调用结果为准 */
  private get requestKey(): string {
    const key = this.config.apiKey.trim();
    if (!key) throw new Error("缺少 API Key");
    return key;
  }

  async listModels(): Promise<string[]> {
    const endpoint = this.endpoints().models;
    const probe = await this.probeModels(this.requestKey, endpoint);
    if (!probe.models) throw new Error(probe.error || `模型列表请求失败：${endpoint}`);
    if (!probe.models.length) throw new Error("接口没有返回可用模型");
    return probe.models;
  }

  /** Raw model-list probe. Diagnostics and `listModels` both need the upstream
   * reason for a failure, not a silent undefined. */
  private async probeModels(key: string, endpoint: string): Promise<{ models?: string[]; error?: string }> {
    try {
      const dispatcher = proxyDispatcherFor(endpoint, this.config);
      const response = await fetchWithTimeout(endpoint, {
        headers: { ...this.authHeaders(key), Accept: "application/json" },
        ...(dispatcher ? { dispatcher } : {}),
      } as RequestInit, 20_000);
      const raw = await response.text();
      if (!response.ok) {
        return { error: apiErrorMessage({ status: response.status, detail: raw, statusText: response.statusText, routeHint: proxyRouteHint(endpoint, this.config), requestHint: `，${endpoint}`, mode: this.wireMode }) };
      }
      const payload = JSON.parse(raw) as { data?: Array<{ id?: string } | string>; models?: Array<{ id?: string } | string> };
      const models = (payload.data ?? payload.models ?? [])
        .map(item => typeof item === "string" ? item : item.id)
        .filter((model): model is string => Boolean(model));
      return { models };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Preflight for the settings screen: resolves the address, authenticates
   * the key, verifies the selected model exists and runs one real completion,
   * reporting the upstream text for whichever step fails. */
  async diagnose(model?: string): Promise<DiagnosticReport> {
    const mode = this.wireMode;
    const checks: DiagnosticCheck[] = [];
    let route: { models: string; chat: string };
    try {
      route = this.endpoints();
    } catch (error) {
      return {
        mode, modelsEndpoint: "", chatEndpoint: "",
        checks: [{ id: "address", label: "接口地址", status: "fail", detail: error instanceof Error ? error.message : String(error) }],
      };
    }
    checks.push({
      id: "address", label: "接口地址", status: "pass",
      detail: `${mode === "anthropic" ? "Anthropic Messages" : "OpenAI 兼容"} · ${route.chat}`,
    });

    const key = this.config.apiKey.trim();
    checks.push(key
      ? { id: "keys", label: "API 密钥", status: "pass", detail: `认证方式 ${mode === "anthropic" ? "x-api-key" : "Authorization: Bearer"}` }
      : { id: "keys", label: "API 密钥", status: "fail", detail: "没有配置 API Key" });

    if (this.config.proxyEnabled) {
      const resolved = proxyURLForRequest(route.chat, this.config);
      checks.push(resolved
        ? { id: "proxy", label: "网络代理", status: "pass", detail: `请求将通过 ${resolved}` }
        : { id: "proxy", label: "网络代理", status: "warn", detail: "代理已启用但对该地址未生效：代理地址无效，或命中了“本地地址不走代理”规则" });
    }
    if (!key) return { mode, modelsEndpoint: route.models, chatEndpoint: route.chat, checks };

    const probe = await this.probeModels(key, route.models);
    const available = probe.models ?? [];
    checks.push(probe.models
      ? { id: "models", label: "模型列表", status: "pass", detail: `读到 ${available.length} 个模型` }
      : { id: "models", label: "模型列表", status: "fail", detail: probe.error || `无法读取 ${route.models}` });

    const target = (model || this.config.defaultModel || "").trim();
    if (!target) {
      checks.push({ id: "model", label: "当前模型", status: "fail", detail: `还没有选择模型${available.length ? `。可用模型示例：${available.slice(0, 6).join("、")}` : ""}` });
      return { mode, modelsEndpoint: route.models, chatEndpoint: route.chat, checks };
    }
    checks.push(!available.length
      ? { id: "model", label: "当前模型", status: "warn", detail: `无法核对 ${target}：模型列表不可用` }
      : available.includes(target)
        ? { id: "model", label: "当前模型", status: "pass", detail: `${target} 在接口返回的模型列表中` }
        // 不少中转站的模型目录与实际可调用范围不一致，所以只提醒而不当成失败
        : { id: "model", label: "当前模型", status: "warn", detail: `模型目录里没有 ${target}，但部分中转站目录不全；以下方“实际调用”结果为准。可用模型示例：${available.slice(0, 6).join("、")}${available.length > 6 ? " 等" : ""}` });

    try {
      const probe = await this.chat([{ role: "user", content: "请只回复 OK" }], { model: target, max_tokens: 256, temperature: 0, retryAttempts: 1 });
      checks.push({ id: "chat", label: "实际调用", status: "pass", detail: `${route.chat} 返回正常（模型 ${probe.model}）` });
    } catch (error) {
      checks.push({ id: "chat", label: "实际调用", status: "fail", detail: error instanceof Error ? error.message : String(error) });
    }
    return { mode, modelsEndpoint: route.models, chatEndpoint: route.chat, checks };
  }

  /** Read-only dashboard data exposed by New API for the currently configured
   * relay keys. These endpoints deliberately authenticate each key on its own,
   * so the app never needs a dashboard cookie and cannot see another user. */
  async getGatewayUsageSnapshot(): Promise<GatewayUsageSnapshot> {
    // /api/status 与 /api/user/self 挂在中转站根域上，不在 /v1 下面
    const root = trimTrailingSlash(normalizeOpenAIBaseURL(this.config.baseURL).replace(/\/v1$/i, ""));
    const endpoint = (path: string) => `${root}${path}`;
    const keys = [this.requestKey];
    const requestJSON = async (path: string, key?: string): Promise<Record<string, unknown>> => {
      const url = endpoint(path);
      const dispatcher = proxyDispatcherFor(url, this.config);
      const response = await fetchWithTimeout(url, {
        headers: {
          Accept: "application/json",
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        ...(dispatcher ? { dispatcher } : {}),
      } as RequestInit, 20_000);
      const body = await response.text();
      if (!response.ok) throw new Error(`${path} 请求失败（${response.status}）：${body.replace(/\s+/g, " ").slice(0, 180)}`);
      try { return JSON.parse(body) as Record<string, unknown>; }
      catch { throw new Error(`${path} 没有返回 JSON 数据`); }
    };
    const [statusResult, accountResults] = await Promise.all([
      requestJSON("/api/status").catch(error => ({ __error: String(error) })),
      Promise.all(keys.map(async (key, keyIndex) => {
        const keyHint = `${key.slice(0, 4)}••••${key.slice(-4)}`;
        const [usageResult, logsResult, pricingResult] = await Promise.allSettled([
          requestJSON("/api/usage/token", key),
          requestJSON("/api/log/token", key),
          requestJSON("/api/pricing", key),
        ]);
        const failures = [usageResult, logsResult, pricingResult]
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map(result => String(result.reason));
        const usagePayload = usageResult.status === "fulfilled" ? usageResult.value : undefined;
        const logsPayload = logsResult.status === "fulfilled" ? logsResult.value : undefined;
        const pricingPayload = pricingResult.status === "fulfilled" ? pricingResult.value : undefined;
        const logs = Array.isArray(logsPayload?.data) ? logsPayload.data.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object")) : [];
        return {
          keyIndex,
          keyHint,
          usage: usagePayload && typeof usagePayload.data === "object" && usagePayload.data ? usagePayload.data as Record<string, unknown> : undefined,
          logs,
          pricing: Array.isArray(pricingPayload?.data) ? pricingPayload.data.filter((item: unknown): item is Record<string, unknown> => Boolean(item && typeof item === "object")) : [],
          group: usagePayload?.data && typeof usagePayload.data === "object" && typeof (usagePayload.data as Record<string, unknown>).group === "string" ? String((usagePayload.data as Record<string, unknown>).group) : undefined,
          groupRatios: pricingPayload?.group_ratio && typeof pricingPayload.group_ratio === "object" ? pricingPayload.group_ratio as Record<string, number> : undefined,
          usableGroups: pricingPayload?.usable_group && typeof pricingPayload.usable_group === "object" ? pricingPayload.usable_group as Record<string, unknown> : undefined,
          ...(failures.length ? { error: failures.join("；") } : {}),
        };
      })),
    ]);
    const errors = [statusResult.__error].filter((value): value is string => typeof value === "string");
    const statusPayload = statusResult as Record<string, unknown>;
    const statusData = statusPayload["data"];
    const pricing = accountResults.flatMap(account => account.pricing || []).filter((item, index, all) => all.findIndex(other => String(other.model_name) === String(item.model_name)) === index);
    return {
      fetchedAt: new Date().toISOString(),
      status: statusData && typeof statusData === "object" ? statusData as Record<string, unknown> : undefined,
      pricing,
      accounts: accountResults,
      errors,
    };
  }

  async chat(
    messages: ChatMessage[],
    options: ChatOptions = {}
  ): Promise<{ content: string; model: string; usage?: ApiUsage }> {
    const model = options.model || this.config.defaultModel || "gpt-4o-mini";
    const mode = this.wireMode;
    const reasoningMode = this.config.reasoningMode;
    const thinkingBudget = mode === "anthropic" && reasoningMode ? anthropicThinkingBudget[reasoningMode] : undefined;
    // Anthropic rejects a thinking budget that is not strictly below max_tokens.
    // OpenAI 兼容接口的思考 token 和正文共用 max_tokens，所以给思考额外留额度；
    // 没开推理时不能凭空加（会改掉调用方明确指定的 max_tokens）
    const openAIReasoning = mode === "anthropic" ? 0 : openAIReasoningTokens(reasoningMode, model, this.reasoningModels.has(model));
    const maxTokens = this.outputBudget(Math.max(options.max_tokens ?? 4000, thinkingBudget ? thinkingBudget + 1024 : 0), openAIReasoning);
    const apiKey = this.requestKey;
    const contextMessages = await this.fitContextMessages(messages, maxTokens, model, apiKey);
    const endpoint = this.endpoints().chat;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    let body: string;

    if (mode === "anthropic") {
      const { system, turns } = toAnthropicMessages(contextMessages);
      body = JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: system || undefined,
        messages: turns,
        // Extended thinking pins temperature at 1, so the caller's value has to
        // be dropped rather than sent and rejected.
        temperature: thinkingBudget ? undefined : options.temperature ?? 0.7,
        thinking: thinkingBudget ? { type: "enabled", budget_tokens: thinkingBudget } : undefined,
      });
    } else {
      body = JSON.stringify({
        model,
        messages: contextMessages,
        temperature: options.temperature ?? 0.7,
        max_tokens: maxTokens,
        // Gemini models use this same route but do not consistently implement
        // response_format. Prompt-level JSON rules remain in place.
        response_format: supportsOpenAIJsonMode(model) ? options.response_format : undefined,
        reasoning_effort: supportsOpenAIReasoning(model) && reasoningMode ? openAIReasoningEffort[reasoningMode] : undefined,
      });
    }
    const maxAttempts = Math.max(1, Math.min(5, options.retryAttempts ?? 3));
    // 重试始终用同一个 Key：以前 Key 按重试次数轮换，一次网络抖动就会把请求换到另一个无权限的 Key，报成 403
    const requestHeaders = { ...headers, ...this.authHeaders(apiKey) };
    let lastNetworkError = "";

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const dispatcher = proxyDispatcherFor(endpoint, this.config);
        const response = await fetchWithTimeout(endpoint, {
          method: "POST",
          headers: requestHeaders,
          body,
          ...(dispatcher ? { dispatcher } : {}),
        } as RequestInit, 300_000);
        if (response.ok) {
          const data = await response.json() as Record<string, unknown>;
          if (mode === "anthropic") {
            const content = anthropicText(data.content);
            if (!content) throw emptyAnthropicError(data, maxTokens);
            const anthropicUsage = parseUsage(data.usage);
            recordRuntimeUsage(anthropicUsage);
            return { content, model: typeof data.model === "string" ? data.model : model, usage: anthropicUsage };
          }
          const choices = Array.isArray(data.choices) ? data.choices as Array<Record<string, unknown>> : [];
          const firstChoice = choices[0];
          const firstMessage = firstChoice?.message as Record<string, unknown> | undefined;
          const content = extractText(firstMessage?.content) || extractText(firstChoice?.text);
          if (!content) throw emptyCompletionError(data, maxTokens);
          const usage = parseUsage(data.usage);
          recordRuntimeUsage(usage);
          this.noteReasoning(model, usage);
          return { content, model: typeof data.model === "string" ? data.model : model, usage };
        }

        const detail = await response.text();
        const retryable = [408, 429, 500, 502, 503, 504, 524].includes(response.status) && !isQuotaExceeded(detail);
        if (retryable && attempt < maxAttempts) {
          // Some upstream OpenAI-compatible adapters turn unsupported optional
          // fields into a 503. Retry the same task once with only core fields.
          if (response.status === 503 && attempt === 1) {
            try {
              const compatibilityBody = JSON.parse(body) as Record<string, unknown>;
              delete compatibilityBody.response_format;
              delete compatibilityBody.reasoning_effort;
              delete compatibilityBody.thinking;
              body = JSON.stringify(compatibilityBody);
            } catch { /* The original request remains valid for the next retry. */ }
          }
          await sleep(800 * 2 ** (attempt - 1));
          continue;
        }
        throw new ApiRequestError(apiErrorMessage({
          status: response.status, detail, statusText: response.statusText, attempts: attempt,
          routeHint: proxyRouteHint(endpoint, this.config), requestHint: `，模型 ${model} · ${endpoint}`,
          mode, requestBytes: Buffer.byteLength(body, "utf8"),
        }), response.status);
      } catch (error) {
        // 上游已明确拒绝的请求不重试：响应体已读完，重试只会得到无意义的二次错误
        if (error instanceof ApiRequestError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        lastNetworkError = message;
        if (attempt < maxAttempts) {
          await sleep(500 * 2 ** (attempt - 1));
          continue;
        }
      }
    }
    throw new Error(`无法连接 API 中转服务，已自动重试 ${maxAttempts - 1} 次：${lastNetworkError || "网络连接失败"}`);
  }

  async chatStream(messages: ChatMessage[], options: ChatOptions = {}, onChunk?: (chunk: string) => void): Promise<{ content: string; model: string; usage?: ApiUsage }> {
    // Streaming always uses the same wire protocol as the non-streaming path.
    // Never let a stale protocol selection silently degrade writing to a
    // non-streaming request.
    const model = options.model || this.config.defaultModel || "gpt-4o-mini";
    const mode = this.wireMode;
    const endpoint = this.endpoints().chat;
    const dispatcher = proxyDispatcherFor(endpoint, this.config);
    const reasoningMode = this.config.reasoningMode;
    const thinkingBudget = mode === "anthropic" && reasoningMode ? anthropicThinkingBudget[reasoningMode] : undefined;
    // OpenAI 兼容接口的思考 token 和正文共用 max_tokens，所以给思考额外留额度；
    // 没开推理时不能凭空加（会改掉调用方明确指定的 max_tokens）
    const openAIReasoning = mode === "anthropic" ? 0 : openAIReasoningTokens(reasoningMode, model, this.reasoningModels.has(model));
    const maxTokens = this.outputBudget(Math.max(options.max_tokens ?? 4000, thinkingBudget ? thinkingBudget + 1024 : 0), openAIReasoning);
    const apiKey = this.requestKey;
    const contextMessages = await this.fitContextMessages(messages, maxTokens, model, apiKey);
    const streamBody = mode === "anthropic"
      ? (() => {
        const { system, turns } = toAnthropicMessages(contextMessages);
        return JSON.stringify({
          model,
          max_tokens: maxTokens,
          system: system || undefined,
          messages: turns,
          temperature: thinkingBudget ? undefined : options.temperature ?? 0.7,
          thinking: thinkingBudget ? { type: "enabled", budget_tokens: thinkingBudget } : undefined,
          stream: true,
        });
      })()
      : JSON.stringify({ model, messages: contextMessages, temperature: options.temperature ?? 0.7, max_tokens: maxTokens, response_format: supportsOpenAIJsonMode(model) ? options.response_format : undefined, reasoning_effort: supportsOpenAIReasoning(model) && reasoningMode ? openAIReasoningEffort[reasoningMode] : undefined, stream: true, stream_options: { include_usage: true } });
    // 建流阶段和非流式一样会撞上 429/502/503 抖动，之前这里一次都不重试，
    // 一个瞬时限流就让整章白跑。只重试建流：一旦开始收字节就交给下面的断点续写逻辑
    const streamAttempts = Math.max(1, Math.min(5, options.retryAttempts ?? 3));
    let streamResponse!: Response;
    for (let attempt = 1; attempt <= streamAttempts; attempt += 1) {
      streamResponse = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.authHeaders(apiKey) },
        body: streamBody,
        ...(dispatcher ? { dispatcher } : {}),
      } as RequestInit, 300_000);
      if (streamResponse.ok) break;
      if (attempt >= streamAttempts || ![408, 429, 500, 502, 503].includes(streamResponse.status)) break;
      // 524 不在重试之列：网关超时说明上一次请求太慢，重发同一个请求只会再超时一次
      await streamResponse.text().catch(() => "");
      await sleep(800 * 2 ** (attempt - 1));
    }
    const responseBody = streamResponse.ok ? streamResponse.body : null;
    if (!responseBody) {
      const detail = await streamResponse.text();
      throw new ApiRequestError(apiErrorMessage({
        status: streamResponse.status, detail, statusText: streamResponse.statusText, attempts: streamAttempts,
        routeHint: proxyRouteHint(endpoint, this.config), requestHint: `，模型 ${model} · ${endpoint}`,
        mode, requestBytes: Buffer.byteLength(streamBody, "utf8"),
      }), streamResponse.status);
    }
    const reader = responseBody.getReader(); const decoder = new TextDecoder(); let buffer = ""; let content = ""; let usage: ApiUsage | undefined;
    // 正常完成后也必须取消 reader，否则中转不关连接时 socket 会挂在连接池里，拖累后续请求
    const finishStream = async () => { try { await reader.cancel(); } catch { /* 已关闭则忽略 */ } };
    try {
      streamLoop: while (true) {
        // 每次 read 单独计时，并在胜出后立即清除定时器，避免累积悬空计时器拖住进程
        let timer: NodeJS.Timeout | undefined;
        const next = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            // 推理型中转在思考段常有 2~3 分钟静默，45 秒会误杀正在正常生成的长章
            timer = setTimeout(() => reject(new Error(content ? "SSE 后续内容超时" : "SSE 首个响应超时")), content ? 180_000 : 60_000);
          }),
        ]).finally(() => { if (timer) clearTimeout(timer); }); if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        const lines = buffer.split("\n"); buffer = lines.pop() || "";
        for (const line of lines) {
          const text = line.trim().replace(/^data:\s*/, "");
          if (!text || line.trim().startsWith("event:")) continue;
          if (text === "[DONE]") break streamLoop;
          try {
            const event = JSON.parse(text) as Record<string, unknown>;
            if (mode === "anthropic") {
              if (event.type === "error") {
                throw new Error(describeErrorBody(text).text || "Anthropic 流式接口返回错误事件");
              }
              const delta = event.delta as Record<string, unknown> | undefined;
              // `thinking_delta` blocks share this event type and must not be
              // written into the chapter.
              if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text) {
                content += delta.text; onChunk?.(delta.text);
              }
              const startUsage = event.type === "message_start" && event.message && typeof event.message === "object"
                ? (event.message as Record<string, unknown>).usage
                : undefined;
              usage = mergeUsage(usage, parseUsage(startUsage ?? event.usage));
              if (event.type === "message_stop") break streamLoop;
              continue;
            }
            const choice = Array.isArray(event.choices) ? event.choices[0] as Record<string, unknown> : undefined;
            const delta = choice?.delta as Record<string, unknown> | undefined;
            const chunk = typeof delta?.content === "string" ? delta.content : "";
            if (chunk) { content += chunk; onChunk?.(chunk); }
            usage = parseUsage(event.usage) || usage;
            const reasoningDelta = typeof (delta?.reasoning_content ?? delta?.reasoning) === "string" ? String(delta?.reasoning_content ?? delta?.reasoning) : "";
            if (reasoningDelta) this.reasoningModels.add(model);
            // A number of OpenAI-compatible relays omit the terminal [DONE]
            // event but do provide choice.finish_reason. Stop as soon as the
            // model reports completion so the UI cannot remain stuck waiting
            // for another read from an otherwise open connection.
            if (typeof choice?.finish_reason === "string" && choice.finish_reason.trim()) break streamLoop;
          } catch (error) {
            // Ignore proxy keep-alives, but surface a real upstream error event.
            if (error instanceof Error && error.message.includes("Anthropic 流式接口")) throw error;
          }
        }
      }
      await finishStream();
    } catch (error) {
      // 连接异常后必须主动释放读取器，否则底层 socket 不会关闭，后续请求会受连接池耗尽影响
      try { await reader.cancel(); } catch { /* 已关闭则忽略 */ }
      // 已收到部分内容时流中断：不再丢掉几千字重头再来，带着已有内容非流式续写补齐；
      // 纯头部失败（content 为空）仍走原有回退
      if (!content) {
        const fallback = await this.chat(messages, options);
        onChunk?.(fallback.content);
        return fallback;
      }
      if (isQuotaExceeded(String(error instanceof Error ? error.message : String(error)))) throw error;
      try {
        const continuation = await this.chat([
          ...messages,
          { role: "assistant", content: `【已生成的前半段，请从断点无缝继续，不要重复已有内容】\n${content}` },
          { role: "user", content: "继续输出，从中断处直接接上，不要重复、不要解释、不要重新开头" },
        ], { ...options, max_tokens: undefined });
        const resumed = `${content}${continuation.content}`;
        onChunk?.(continuation.content);
        return { content: resumed, model, usage: usage ?? continuation.usage };
      } catch (resumeError) {
        // 续写也失败时如实报告中断位置，已有内容不丢，但流式确实无法完成
        throw new Error(`API Saver 流式连接中断：${error instanceof Error ? error.message : String(error)}；续写失败：${resumeError instanceof Error ? resumeError.message : String(resumeError)}`);
      }
    }
    recordRuntimeUsage(usage);
    // Some OpenAI-compatible gateways accept stream=true but answer with one
    // ordinary JSON response. Preserve compatibility and still update UI once.
    if (!content) {
      const fallback = await this.chat(messages, options);
      onChunk?.(fallback.content);
      return fallback;
    }
    return { content, model, usage };
  }
}
