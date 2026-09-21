import { afterEach, describe, expect, it, vi } from "vitest";
import { registerTextHandlers } from "../src/rpc/text-handlers.js";
import { RpcRegistry } from "../src/rpc/registry.js";

afterEach(() => vi.restoreAllMocks());

describe("text.transform annotate", () => {
  it("按批注只改一段：提示词里带批注、前后文与人物卡，输出只有改后的段落", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      model: "gpt-test",
      choices: [{ message: { content: "```text\n沈妄把账本合上，没接话。\n```" } }],
    }), { status: 200 }));
    const registry = registerTextHandlers(new RpcRegistry(async request => ({ id: request.id, result: {} })));
    const result = await registry.dispatch({
      id: 1,
      method: "text.transform",
      params: {
        mode: "annotate", apiKey: "key", baseURL: "https://relay.test/v1", model: "gpt-test",
        projectTitle: "试讲与婚帖", chapterTitle: "第 174 章",
        content: "沈妄淡淡地说：“随你。”",
        notes: ["沈妄这里不会这么说，他会先把账本合上", "去掉“淡淡地”"],
        before: "姜冷月把笔放下。", after: "窗外的灯亮了。",
        cards: [{ title: "沈妄", content: "寡言，先做事再开口。" }],
      },
    });
    expect(result.result).toEqual({ content: "沈妄把账本合上，没接话。" });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as { messages: Array<{ content: string }>; stream?: boolean };
    const prompt = body.messages[0].content;
    expect(prompt).toContain("1. 沈妄这里不会这么说");
    expect(prompt).toContain("2. 去掉“淡淡地”");
    expect(prompt).toContain("### 沈妄\n寡言");
    expect(prompt).toContain("姜冷月把笔放下。");
    expect(prompt).toContain("窗外的灯亮了。");
    expect(prompt).toContain("只输出改后的这一段");
    expect(body.stream).toBeFalsy();
  });

  it("没有批注时拒绝", async () => {
    const registry = registerTextHandlers(new RpcRegistry(async request => ({ id: request.id, result: {} })));
    const result = await registry.dispatch({ id: 1, method: "text.transform", params: { mode: "annotate", apiKey: "key", baseURL: "https://relay.test/v1", content: "一段。", notes: [] } });
    expect(result.error?.message).toContain("缺少批注内容");
  });
});
