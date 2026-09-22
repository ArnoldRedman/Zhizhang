import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCardRefreshHandler, registerGraphDedupeHandler } from "../src/rpc/content-handlers.js";
import { RpcRegistry } from "../src/rpc/registry.js";

afterEach(() => vi.restoreAllMocks());

describe("card.refresh", () => {
  it("把全部卡与最近几章送给模型，只收回有内容的状态；空串表示没变化", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      model: "gpt-test",
      choices: [{ message: { content: JSON.stringify({ cards: [{ id: "1", currentState: "沈妄在书肆守夜，等刻坊回话。" }, { id: "2", currentState: "" }, { id: "", currentState: "没 id" }] }) } }],
    }), { status: 200 }));
    const registry = registerCardRefreshHandler(new RpcRegistry(async request => ({ id: request.id, result: {} })));
    const result = await registry.dispatch({
      id: 1, method: "card.refresh",
      params: {
        apiKey: "key", baseURL: "https://relay.test/v1", model: "gpt-test", projectTitle: "试讲与婚帖",
        cards: [{ id: 1, type: "角色卡", title: "沈妄", content: "寡言。", currentState: "在暖阁写婚帖" }, { id: 2, type: "地点卡", title: "书肆", content: "老街。", currentState: "" }],
        chapters: [{ title: "第 173 章", content: "沈妄去了书肆。" }, { title: "第 174 章", content: "他守了一夜。" }],
      },
    });
    expect((result.result as { updates: unknown[] }).updates).toEqual([{ id: "1", currentState: "沈妄在书肆守夜，等刻坊回话。" }]);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as { messages: Array<{ content: string }> };
    expect(body.messages[0].content).toContain("### 第 173 章");
    expect(body.messages[0].content).toContain("[角色卡] 沈妄（id 1）");
    expect(body.messages[0].content).toContain("现状：在暖阁写婚帖");
  });

  it("没有卡或没有章节时拒绝", async () => {
    const registry = registerCardRefreshHandler(new RpcRegistry(async request => ({ id: request.id, result: {} })));
    expect((await registry.dispatch({ id: 1, method: "card.refresh", params: { apiKey: "k", baseURL: "https://relay.test/v1", cards: [], chapters: [{ title: "a", content: "b" }] } })).error?.message).toContain("没有可刷新的卡片");
    expect((await registry.dispatch({ id: 2, method: "card.refresh", params: { apiKey: "k", baseURL: "https://relay.test/v1", cards: [{ id: 1, title: "x" }], chapters: [] } })).error?.message).toContain("没有可对照的章节正文");
  });
});

describe("graph.dedupe", () => {
  it("把卡片正名别名与剩余实体送给模型，只收回有 from/to 的合并与有 name 的删除", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      model: "gpt-test",
      choices: [{ message: { content: JSON.stringify({ merges: [{ from: "姜老太爷", to: "姜正霖", reason: "尊称" }, { from: "同名", to: "同名" }, { from: "", to: "x" }], removes: [{ name: "爷爷", reason: "称谓" }, { name: "" }] }) } }],
    }), { status: 200 }));
    const registry = registerGraphDedupeHandler(new RpcRegistry(async request => ({ id: request.id, result: {} })));
    const result = await registry.dispatch({
      id: 1, method: "graph.dedupe",
      params: {
        apiKey: "key", baseURL: "https://relay.test/v1", model: "gpt-test", projectTitle: "试讲与婚帖",
        cards: [{ title: "姜正霖", aliases: ["姜老董事长", "父亲"] }],
        entities: [{ label: "姜老太爷", category: "人物", chapters: ["第 94 章", "第 108 章"] }, { label: "爷爷", category: "人物", chapters: ["第 95 章"] }],
      },
    });
    expect(result.result).toMatchObject({ merges: [{ from: "姜老太爷", to: "姜正霖", reason: "尊称" }], removes: [{ name: "爷爷", reason: "称谓" }] });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as { messages: Array<{ content: string }> };
    expect(body.messages[0].content).toContain("姜正霖（又称：姜老董事长、父亲）");
    expect(body.messages[0].content).toContain("姜老太爷｜人物｜提到它的章：第 94 章、第 108 章");
  });

  it("没有实体时不调模型，直接返回空", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const registry = registerGraphDedupeHandler(new RpcRegistry(async request => ({ id: request.id, result: {} })));
    const result = await registry.dispatch({ id: 1, method: "graph.dedupe", params: { apiKey: "k", baseURL: "https://relay.test/v1", cards: [], entities: [] } });
    expect(result.result).toEqual({ merges: [], removes: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
