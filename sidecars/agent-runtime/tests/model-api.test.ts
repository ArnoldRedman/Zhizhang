import { afterEach, describe, expect, it, vi } from "vitest";
import { countMessageTokens } from "../src/context/token-budget.js";
import { ModelApiClient, buildModelConfig, createChatModel } from "../src/models/model-api.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("model client configuration", () => {
  it("normalizes an OpenAI-compatible API Saver base URL", () => {
    expect(buildModelConfig({
      provider: "openai",
      apiKey: "test-key",
      model: "gpt-4o-mini",
      baseUrl: "https://relay.test",
    })).toEqual({
      provider: "openai",
      apiKey: "test-key",
      model: "gpt-4o-mini",
      baseUrl: "https://relay.test/v1",
    });
  });

  it("preserves an explicit Claude messages endpoint", () => {
    expect(buildModelConfig({
      provider: "claude",
      apiKey: "test-key",
      model: "claude-3-5-sonnet",
      baseUrl: "https://relay.test/v1/messages",
    }).baseUrl).toBe("https://relay.test/v1/messages");
  });

  it("creates a LangChain chat model for both providers", () => {
    expect(createChatModel(buildModelConfig({ provider: "openai", apiKey: "x", model: "gpt-4o-mini", baseUrl: "https://relay.test/v1" }))._llmType()).toBe("openai");
    expect(createChatModel(buildModelConfig({ provider: "claude", apiKey: "x", model: "claude-3-5-sonnet" }))._llmType()).toBe("anthropic");
  });

  it("retries temporary gateway failures before returning a response", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("<html>bad gateway</html>", { status: 502 }))
      .mockResolvedValueOnce(new Response("<html>bad gateway</html>", { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        model: "gpt-test",
        choices: [{ message: { content: "生成完成" } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const request = new ModelApiClient({ apiKey: "test-key", baseURL: "https://example.test/v1", defaultModel: "gpt-test" })
      .chat([{ role: "user", content: "测试" }]);
    await vi.runAllTimersAsync();

    await expect(request).resolves.toEqual({ content: "生成完成", model: "gpt-test" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  // 回归：Key 曾经按重试次数轮换，一次网络抖动就会把请求换到另一个 Key，无权限时报 403
  it("重试始终使用同一个 API Key", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        model: "gpt-test",
        choices: [{ message: { content: "OK" } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const request = new ModelApiClient({ apiKey: "only-key", baseURL: "https://example.test/v1", defaultModel: "gpt-test" })
      .chat([{ role: "user", content: "测试" }]);
    await vi.runAllTimersAsync();
    await expect(request).resolves.toEqual({ content: "OK", model: "gpt-test" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const call of fetchMock.mock.calls) {
      expect(call[1]?.headers).toMatchObject({ Authorization: "Bearer only-key" });
    }
  });

  it("403 直接报错，不隐藏在重试后面", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ error: { message: "no permission for model" } }), { status: 403 }));

    await expect(new ModelApiClient({ apiKey: "only-key", baseURL: "https://example.test/v1", defaultModel: "gpt-test" })
      .chat([{ role: "user", content: "测试" }]))
      .rejects.toThrow("no permission for model");
    // 鉴权失败不可重试，也没有其他 Key 可换
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // 以下四条针对一个真实排查事故：空响应体的 403 被误报成“API Key 校验失败”，
  // 把排查方向带偏了两轮。错误文案必须区分“上游真的说了什么”和“我们在猜”。
  it("空响应体的 403 不断言 Key 无效，并报出请求体大小与网关嫌疑", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 403 }));

    await expect(new ModelApiClient({ apiKey: "only-key", baseURL: "https://example.test/v1", defaultModel: "gpt-test", apiMode: "anthropic" })
      .chat([{ role: "user", content: "测试" }]))
      .rejects.toThrow(/上游没有返回任何说明.*KB.*WAF/su);
  });

  it("401\u002f403 报错包含模型名和实际 endpoint", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 401 }));

    await expect(new ModelApiClient({ apiKey: "only-key", baseURL: "https://relay.test/v1", defaultModel: "gpt-test" })
      .chat([{ role: "user", content: "测试" }]))
      .rejects.toThrow("模型 gpt-test · https://relay.test/v1/chat/completions");
  });

  it("HTML 错误页不被丢弃，而是标明来自网关", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      "<html><head><title>403 Forbidden</title></head><body>nginx</body></html>",
      { status: 403 },
    ));

    await expect(new ModelApiClient({ apiKey: "only-key", baseURL: "https://relay.test/v1", defaultModel: "gpt-test" })
      .chat([{ role: "user", content: "测试" }]))
      .rejects.toThrow(/网页错误页面（403 Forbidden）/u);
  });

  it("上下文超限归为超限，不再提示检查 Key", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { type: "request_too_large", message: "Request exceeds the maximum size" } }), { status: 413 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "prompt is too long: 213462 tokens > 200000 maximum" } }), { status: 400 }))
      // 部分网关对过大请求体只回一个空响应体的 400
      .mockResolvedValueOnce(new Response("", { status: 400 }));
    const client = new ModelApiClient({ apiKey: "only-key", baseURL: "https://relay.test/v1", defaultModel: "gpt-test" });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(client.chat([{ role: "user", content: "测试" }], { retryAttempts: 1 }))
        .rejects.toThrow(/请求超出模型上下文或网关的大小限制/u);
    }
  });

  it("频控不会被误判为上下文超限", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ error: { message: "Rate limit reached: too many tokens" } }), { status: 429 }));

    await expect(new ModelApiClient({ apiKey: "only-key", baseURL: "https://relay.test/v1", defaultModel: "gpt-test" })
      .chat([{ role: "user", content: "测试" }], { retryAttempts: 1 }))
      .rejects.toThrow(/请求过于频繁/u);
  });

  it("模型列表只用当前配置的那一个 Key", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "gpt-a" }, { id: "gpt-b" }] }), { status: 200 }));

    const models = await new ModelApiClient({ apiKey: "only-key", baseURL: "https://invalid.example/v1" }).listModels();

    expect(models).toEqual(["gpt-a", "gpt-b"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://invalid.example/v1/models");
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer only-key" });
  });

  it("模型列表失败时报出上游原因", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "invalid api key" } }), { status: 401 }));

    await expect(new ModelApiClient({ apiKey: "bad-key", baseURL: "https://invalid.example/v1" }).listModels())
      .rejects.toThrow("invalid api key");
  });

  it("uses a custom OpenAI-compatible base URL for models and chat", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "local-model" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ model: "local-model", choices: [{ message: { content: "OK" } }] }), { status: 200 }));
    const client = new ModelApiClient({ apiKey: "local-key", baseURL: "http://127.0.0.1:8000", defaultModel: "local-model" });

    await expect(client.listModels()).resolves.toEqual(["local-model"]);
    await expect(client.chat([{ role: "user", content: "测试" }])).resolves.toMatchObject({ content: "OK" });
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:8000/v1/models");
    expect(fetchMock.mock.calls[1][0]).toBe("http://127.0.0.1:8000/v1/chat/completions");
  });

  it("enforces the configured context window with tokenizer counts", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      model: "gpt-4o",
      choices: [{ message: { content: "OK" } }],
    }), { status: 200 }));
    const client = new ModelApiClient({ apiKey: "k", baseURL: "https://example.test/v1", defaultModel: "gpt-4o", contextWindowKTokens: 16 });

    await client.chat([{ role: "user", content: "中".repeat(600) }], { max_tokens: 16_000, retryAttempts: 1 });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as { messages: Array<{ role: "user"; content: string }> };
    expect(countMessageTokens(body.messages, "gpt-4o")).toBeLessThanOrEqual(16 * 1024 - 16_000);
    expect(body.messages[0].content.length).toBeLessThan(600);
  });

  it("always uses chat completions even when an obsolete Responses mode is stored", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ model: "gpt-5.6-terra", choices: [{ message: { content: "OK" } }] }), { status: 200 }));

    await expect(new ModelApiClient({
      apiKey: "test-key", baseURL: "https://relay.test/v1", defaultModel: "gpt-5.6-terra", apiMode: "responses",
    }).chat([{ role: "user", content: "测试" }], { response_format: { type: "json_object" } }))
      .resolves.toMatchObject({ content: "OK" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://relay.test/v1/chat/completions");
  });

  it("uses the configured custom address for chat requests", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ model: "gpt-test", choices: [{ message: { content: "OK" } }] }), { status: 200 }));

    await expect(new ModelApiClient({ apiKey: "test-key", baseURL: "https://legacy.example/v1", defaultModel: "gpt-test" })
      .chat([{ role: "user", content: "测试" }]))
      .resolves.toEqual({ content: "OK", model: "gpt-test" });
    expect(fetchMock.mock.calls[0][0]).toBe("https://legacy.example/v1/chat/completions");
  });

  it("omits OpenAI-only JSON and reasoning options for Gemini-compatible models", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ model: "gemini-3.7-flash", choices: [{ message: { content: "{}" } }] }), { status: 200 }));

    await new ModelApiClient({
      apiKey: "test-key", baseURL: "https://relay.test/v1", defaultModel: "gemini-3.7-flash", reasoningMode: "high",
    }).chat([{ role: "user", content: "请输出 JSON" }], { response_format: { type: "json_object" } });

    const requestBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as Record<string, unknown>;
    expect(requestBody).not.toHaveProperty("response_format");
    expect(requestBody).not.toHaveProperty("reasoning");
  });

  // 症状：作者把推理强度设成 high，但模型名不在白名单里（如 deepseek/*），运行时不发 reasoning_effort
  // 也不给思考留额度，模型把 max_tokens 全花在思考上、正文返回空，只报“输出被截断”
  it("给推理强度非 auto 的模型预留思考额度，即使模型名不在白名单里", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ model: "deepseek/deepseek-flash", choices: [{ message: { content: "{}" } }] }), { status: 200 }));

    const client = new ModelApiClient({ apiKey: "test-key", baseURL: "https://relay.test/v1", defaultModel: "deepseek/deepseek-flash", reasoningMode: "high" });
    await client.chat([{ role: "user", content: "请输出 JSON" }], { max_tokens: 1300, response_format: { type: "json_object" } });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as Record<string, unknown>;
    expect(Number(body.max_tokens)).toBe(1300 + 12000);
  });

  it("auto 推理强度且模型名未知时不改调用方的 max_tokens", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ model: "some/plain", choices: [{ message: { content: "{}" } }] }), { status: 200 }));

    await new ModelApiClient({ apiKey: "test-key", baseURL: "https://relay.test/v1", defaultModel: "some/plain", reasoningMode: "auto" })
      .chat([{ role: "user", content: "请输出 JSON" }], { max_tokens: 1300 });
    expect((JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as Record<string, unknown>).max_tokens).toBe(1300);
  });

  it("看到过 reasoningTokens 的模型，下一次请求也会预留思考额度", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        model: "some/reasoner",
        choices: [{ message: { content: "{}" } }],
        usage: { completion_tokens: 900, completion_tokens_details: { reasoning_tokens: 880 } },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ model: "some/reasoner", choices: [{ message: { content: "{}" } }] }), { status: 200 }));

    const client = new ModelApiClient({ apiKey: "test-key", baseURL: "https://relay.test/v1", defaultModel: "some/reasoner", reasoningMode: "auto" });
    await client.chat([{ role: "user", content: "第一次" }], { max_tokens: 1000 });
    await client.chat([{ role: "user", content: "第二次" }], { max_tokens: 1000 });
    const first = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as Record<string, unknown>;
    const second = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)) as Record<string, unknown>;
    expect(first.max_tokens).toBe(1000);
    expect(Number(second.max_tokens)).toBeGreaterThan(1000);
  });

  it("extracts text from OpenAI-compatible content blocks and legacy text choices", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ model: "gpt-test", choices: [{ message: { content: [{ type: "text", text: "第一段" }, { text: "第二段" }] } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ model: "gpt-test", choices: [{ text: "旧格式正文" }] }), { status: 200 }));

    await expect(new ModelApiClient({ apiKey: "test-key", baseURL: "https://relay.test/v1", defaultModel: "gpt-test" })
      .chat([{ role: "user", content: "测试" }])).resolves.toMatchObject({ content: "第一段\n第二段" });
    await expect(new ModelApiClient({ apiKey: "test-key", baseURL: "https://relay.test/v1", defaultModel: "gpt-test" })
      .chat([{ role: "user", content: "测试" }])).resolves.toMatchObject({ content: "旧格式正文" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports truncation instead of a generic empty response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      model: "gemini-3.7-flash",
      choices: [{ message: { role: "assistant", content: "" }, finish_reason: "length" }],
    }), { status: 200 }));

    await expect(new ModelApiClient({ apiKey: "test-key", baseURL: "https://relay.test/v1", defaultModel: "gemini-3.7-flash" })
      .chat([{ role: "user", content: "测试" }], { max_tokens: 8, retryAttempts: 1 }))
      .rejects.toThrow("模型输出被截断（max_tokens=8）");
  });

  it("诊断只有推理的响应，不猜额度耗尽、不重复请求或泄露内容", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      model: "gpt-test",
      choices: [{ message: { reasoning_content: "内部推理" }, finish_reason: "stop" }],
    }), { status: 200 }));

    await expect(new ModelApiClient({ apiKey: "test-key", baseURL: "https://relay.test/v1", defaultModel: "gpt-test" })
      .chat([{ role: "user", content: "私有小说正文" }], { max_tokens: 1234, retryAttempts: 3 }))
      .rejects.toThrow("响应未明确标记额度耗尽");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const diagnostic = JSON.stringify(log.mock.calls);
    expect(diagnostic).toContain("max_tokens=1234");
    expect(diagnostic).toContain("finish_reason=stop");
    expect(diagnostic).toContain("推理长度=4");
    expect(diagnostic).not.toMatch(/内部推理|私有小说正文|test-key/);
  });

  it("结构化工具调用不会被误判为推理耗尽，未知别名仍保留 JSON 参数", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: null, tool_calls: [{ type: "function", function: { name: "open", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
    }), { status: 200 }));
    await expect(new ModelApiClient({ apiKey: "test-key", baseURL: "https://relay.test/v1", defaultModel: "custom-reasoner" })
      .chat([{ role: "user", content: "检查章节" }], { response_format: { type: "json_object" }, retryAttempts: 2 }))
      .rejects.toThrow("未请求的结构化工具调用");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).response_format).toEqual({ type: "json_object" });
  });

  it("finishes an SSE response on finish_reason even when the relay keeps the connection open", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode([
            `data: ${JSON.stringify({ choices: [{ delta: { content: "第一段" }, finish_reason: null }] })}`,
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { total_tokens: 7 } })}`,
            "",
          ].join("\n")));
          // Deliberately do not close: some relays omit [DONE] and leave the
          // HTTP connection open after sending the terminal choice event.
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    ));

    await expect(new ModelApiClient({ apiKey: "test-key", baseURL: "https://relay.test/v1", defaultModel: "gpt-test" })
      .chatStream([{ role: "user", content: "测试" }]))
      .resolves.toMatchObject({ content: "第一段", model: "gpt-test" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("建流阶段撞上 503 会重试，一个瞬时抖动不该让整章白跑", async () => {
    const ok = () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "正文" }, finish_reason: "stop" }] })}\n\n`));
        controller.close();
      },
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("upstream busy", { status: 503 }))
      .mockImplementation(async () => ok());

    const result = await new ModelApiClient({ apiKey: "k", baseURL: "https://relay.test/v1", defaultModel: "gpt-test" })
      .chatStream([{ role: "user", content: "改写整章" }], { retryAttempts: 3 });

    expect(result.content).toBe("正文");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("建流阶段的 524 不重试：网关超时说明这个请求本身太慢，重发只会再超一次", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("gateway time-out", { status: 524 }));

    await expect(new ModelApiClient({ apiKey: "k", baseURL: "https://relay.test/v1", defaultModel: "gpt-test" })
      .chatStream([{ role: "user", content: "改写整章" }], { retryAttempts: 3 }))
      .rejects.toThrow("524");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("does not retry an exhausted quota response", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ error: { message: "The quota has been exceeded" } }), { status: 429 }));

    const request = new ModelApiClient({ apiKey: "test-key", baseURL: "https://example.test/v1", defaultModel: "gpt-test" })
      .chat([{ role: "user", content: "测试" }]);

    await expect(request).rejects.toThrow("API 中转服务额度已用尽");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends the documented reasoning_effort field and saturates max at high", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ model: "gpt-test", choices: [{ message: { content: "OK" } }] }), { status: 200 }));

    await new ModelApiClient({ apiKey: "test-key", baseURL: "https://relay.test/v1", defaultModel: "gpt-test", reasoningMode: "max" })
      .chat([{ role: "user", content: "测试" }]);

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as Record<string, unknown>;
    expect(body.reasoning_effort).toBe("high");
    expect(body).not.toHaveProperty("reasoning");
  });

  it("流中断但已有部分内容时，带着已有内容非流式续写补齐而不是报错丢内容", async () => {
    // 模拟中转在输出一半时连接断掉：前两段内容正常流出，第三个 read 报错
    const frames = [
      new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "第一段完整" }, finish_reason: null }] })}\n`),
      new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "第二段开" }, finish_reason: null }] })}\n`),
    ];
    let frameIndex = 0;
    const brokenStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (frameIndex < frames.length) {
          const frame = frames[frameIndex];
          frameIndex += 1;
          controller.enqueue(frame);
          return;
        }
        controller.error(new Error("socket hang up"));
      },
    });
    const streamFetch = new Response(brokenStream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    const resumeFetch = new Response(JSON.stringify({ model: "gpt-test", choices: [{ message: { content: "头被掐断的部分。" } }] }), { status: 200 });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(streamFetch)
      .mockResolvedValue(resumeFetch);

    const chunks: string[] = [];
    const result = await new ModelApiClient({ apiKey: "k", baseURL: "https://relay.test/v1", defaultModel: "gpt-test" })
      .chatStream([{ role: "user", content: "写一章" }], {}, chunk => chunks.push(chunk));

    // 已流出的内容不能丢，续写内容无缝接上，UI 拿到完整正文
    expect(result.content).toBe("第一段完整第二段开头被掐断的部分。");
    expect(chunks).toEqual(["第一段完整", "第二段开", "头被掐断的部分。"]);
    // 续写请求必须携带已有内容，避免模型从零重写
    const resumeBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)) as { messages: Array<Record<string, unknown>> };
    expect(String(resumeBody.messages.at(-2)?.content)).toContain("第一段完整");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces the upstream error message instead of a bare status code", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ error: { type: "invalid_request_error", message: "model: claude-x not found" } }),
      { status: 400 },
    ));

    await expect(new ModelApiClient({ apiKey: "test-key", baseURL: "https://relay.test/v1", defaultModel: "claude-x" })
      .chat([{ role: "user", content: "测试" }], { retryAttempts: 1 }))
      .rejects.toThrow("model: claude-x not found");
  });

  it("explains a 404 as a possible API format mismatch", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not found", { status: 404 }));

    await expect(new ModelApiClient({ apiKey: "test-key", baseURL: "https://relay.test/v1", defaultModel: "gpt-test" })
      .chat([{ role: "user", content: "测试" }], { retryAttempts: 1 }))
      .rejects.toThrow("切换为 Anthropic Messages");
  });
});

describe("Anthropic Messages wire protocol", () => {
  const anthropicResponse = (content: unknown, extra: Record<string, unknown> = {}) => new Response(
    JSON.stringify({ model: "claude-opus-5", content, stop_reason: "end_turn", ...extra }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

  it("resolves every address shape to the same messages endpoint", async () => {
    for (const baseURL of ["https://relay.test", "https://relay.test/v1", "https://relay.test/v1/messages"]) {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(anthropicResponse([{ type: "text", text: "OK" }]));
      await new ModelApiClient({ apiKey: "k", baseURL, apiMode: "anthropic", defaultModel: "claude-opus-5" })
        .chat([{ role: "user", content: "测试" }]);
      expect(fetchMock.mock.calls[0][0]).toBe("https://relay.test/v1/messages");
      vi.restoreAllMocks();
    }
  });

  it("authenticates with x-api-key and pins the anthropic version", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(anthropicResponse([{ type: "text", text: "OK" }]));

    await new ModelApiClient({ apiKey: "claude-key", apiMode: "anthropic", defaultModel: "claude-opus-5" })
      .chat([{ role: "user", content: "测试" }]);

    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ "x-api-key": "claude-key", "anthropic-version": "2023-06-01" });
    expect(fetchMock.mock.calls[0][1]?.headers).not.toHaveProperty("Authorization");
  });

  it("lifts system prompts out of the turn list and merges same-role turns", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(anthropicResponse([{ type: "text", text: "OK" }]));

    await new ModelApiClient({ apiKey: "k", apiMode: "anthropic", defaultModel: "claude-opus-5" }).chat([
      { role: "system", content: "你是写作助手" },
      { role: "system", content: "保持人物一致" },
      { role: "user", content: "第一段要求" },
      { role: "user", content: "第二段要求" },
    ]);

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as Record<string, unknown>;
    expect(body.system).toBe("你是写作助手\n\n保持人物一致");
    expect(body.messages).toEqual([{ role: "user", content: "第一段要求\n\n第二段要求" }]);
  });

  it("turns the reasoning level into a thinking budget below max_tokens", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(anthropicResponse([{ type: "text", text: "OK" }]));

    await new ModelApiClient({ apiKey: "k", apiMode: "anthropic", defaultModel: "claude-opus-5", reasoningMode: "max" })
      .chat([{ role: "user", content: "测试" }], { max_tokens: 4000, temperature: 0.7 });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as Record<string, unknown>;
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 24576 });
    expect(body.max_tokens).toBe(25600);
    // Extended thinking requires the default temperature.
    expect(body).not.toHaveProperty("temperature");
  });

  it("keeps the required token budget when an unbounded review uses Anthropic", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(anthropicResponse([{ type: "text", text: "OK" }]));
    await new ModelApiClient({ apiKey: "k", apiMode: "anthropic", defaultModel: "claude-opus-5", reasoningMode: "max" })
      .chat([{ role: "user", content: "审查正文" }], { unbounded: true });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as { max_tokens: number; thinking: { budget_tokens: number } };
    expect(body.max_tokens).toBeGreaterThan(body.thinking.budget_tokens);
  });

  it("keeps thinking blocks out of the returned prose", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(anthropicResponse([
      { type: "thinking", thinking: "内部推理不应出现在正文" },
      { type: "text", text: "第一段" },
      { type: "text", text: "第二段" },
    ], { usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 100 } }));

    await expect(new ModelApiClient({ apiKey: "k", apiMode: "anthropic", defaultModel: "claude-opus-5" })
      .chat([{ role: "user", content: "测试" }]))
      .resolves.toMatchObject({
        content: "第一段第二段",
        model: "claude-opus-5",
        usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150, cachedInputTokens: 100 },
      });
  });

  it("reports truncation and thinking-only replies instead of an empty result", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(anthropicResponse([], { stop_reason: "max_tokens" }))
      .mockResolvedValueOnce(anthropicResponse([{ type: "thinking", thinking: "只有推理" }]));
    const client = new ModelApiClient({ apiKey: "k", apiMode: "anthropic", defaultModel: "claude-opus-5" });

    await expect(client.chat([{ role: "user", content: "测试" }], { max_tokens: 8, retryAttempts: 1 }))
      .rejects.toThrow("模型输出被截断（max_tokens=8）");
    await expect(client.chat([{ role: "user", content: "测试" }], { retryAttempts: 1 }))
      .rejects.toThrow("只返回了 thinking 块");
  });

  it("lists models from the Anthropic models endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "claude-opus-5" }, { id: "claude-sonnet-5" }] }), { status: 200 }));

    await expect(new ModelApiClient({ apiKey: "k", baseURL: "https://relay.test/v1", apiMode: "anthropic" }).listModels())
      .resolves.toEqual(["claude-opus-5", "claude-sonnet-5"]);
    expect(fetchMock.mock.calls[0][0]).toBe("https://relay.test/v1/models");
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ "x-api-key": "k" });
  });

  it("streams text_delta events, skips thinking_delta and accumulates usage", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode([
            "event: message_start",
            `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 200, output_tokens: 1 } } })}`,
            "event: content_block_delta",
            `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "推理" } })}`,
            "event: content_block_delta",
            `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "正文开头" } })}`,
            "event: message_delta",
            `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 42 } })}`,
            "event: message_stop",
            `data: ${JSON.stringify({ type: "message_stop" })}`,
            "",
          ].join("\n")));
          // Anthropic relays commonly leave the connection open after message_stop.
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    ));
    const chunks: string[] = [];

    await expect(new ModelApiClient({ apiKey: "k", apiMode: "anthropic", defaultModel: "claude-opus-5" })
      .chatStream([{ role: "user", content: "测试" }], {}, chunk => chunks.push(chunk)))
      .resolves.toMatchObject({
        content: "正文开头",
        usage: { inputTokens: 200, outputTokens: 42, totalTokens: 242 },
      });
    expect(chunks).toEqual(["正文开头"]);
  });

  it("reports each preflight step and names the failing one", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "claude-opus-5" }] }), { status: 200 }))
      .mockResolvedValue(new Response(JSON.stringify({ error: { message: "credit balance is too low" } }), { status: 400 }));

    const report = await new ModelApiClient({ apiKey: "k", baseURL: "https://relay.test", apiMode: "anthropic", defaultModel: "claude-opus-5" })
      .diagnose();

    expect(report.mode).toBe("anthropic");
    expect(report.chatEndpoint).toBe("https://relay.test/v1/messages");
    expect(report.checks.map(check => [check.id, check.status])).toEqual([
      ["address", "pass"], ["keys", "pass"], ["models", "pass"], ["model", "pass"], ["chat", "fail"],
    ]);
    expect(report.checks.at(-1)?.detail).toContain("credit balance is too low");
  });

  it("fails a hung upstream request with a timeout message instead of waiting forever", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockRejectedValue(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    const client = new ModelApiClient({ apiKey: "k", baseURL: "https://example.test/v1", defaultModel: "gpt-test" });

    await expect(client.chat([{ role: "user", content: "测试" }], { retryAttempts: 1 }))
      .rejects.toThrow(/请求超时/);
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("fails the address check on an unusable URL without any network call", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const report = await new ModelApiClient({ apiKey: "k", baseURL: "ftp://relay.test", apiMode: "anthropic" }).diagnose();

    expect(report.checks).toEqual([{ id: "address", label: "接口地址", status: "fail", detail: "API 地址仅支持 http:// 或 https:// 协议" }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
