import { describe, expect, it, vi } from "vitest";
import { agentRpcMethods, ProjectAgentChangeSchema, ProjectAgentPlannerChangeSchema } from "@zhizhang/contracts";
import { RpcRegistry } from "../src/rpc/registry.js";

describe("RPC registry", () => {
  it("rejects unknown methods before reaching business handlers", async () => {
    const legacy = vi.fn();
    const result = await new RpcRegistry(legacy).dispatch({ id: 1, method: "unknown.method", params: {} });
    expect(result.error?.code).toBe(-32601);
    expect(legacy).not.toHaveBeenCalled();
  });

  it("validates shared request contracts and delegates known methods", async () => {
    const legacy = vi.fn().mockResolvedValue({ id: 1, result: { ok: true } });
    const registry = new RpcRegistry(legacy);
    const result = await registry.dispatch({ id: 1, method: "chapter.write", params: { contextWindow: 128 } });
    expect(result.result).toEqual({ ok: true });
    expect(legacy).toHaveBeenCalledWith(expect.objectContaining({ method: "chapter.write", params: expect.objectContaining({ contextWindow: 128 }) }));
  });

  it("rejects malformed model params instead of passing them through", async () => {
    const legacy = vi.fn().mockResolvedValue({ id: 1, result: {} });
    const registry = new RpcRegistry(legacy);
    const badMode = await registry.dispatch({ id: 1, method: "chapter.write", params: { apiMode: "grpc" } });
    expect(badMode.error?.code).toBe(-32602);
    const badKeys = await registry.dispatch({ id: 2, method: "chapter.write", params: { apiKey: 42 } });
    expect(badKeys.error?.code).toBe(-32602);
    expect(legacy).not.toHaveBeenCalled();
  });

  it("keeps coerced param values instead of discarding them", async () => {
    const legacy = vi.fn().mockResolvedValue({ id: 1, result: {} });
    await new RpcRegistry(legacy).dispatch({ id: 1, method: "chapter.write", params: { contextWindow: "128", project: { title: "书" } } });
    const forwarded = legacy.mock.calls[0][0] as { params: Record<string, unknown> };
    expect(forwarded.params.contextWindow).toBe(128);
    // 大体量业务字段必须原样透传，不被协议层丢弃
    expect(forwarded.params.project).toEqual({ title: "书" });
  });

  it("keeps a single canonical method inventory", () => {
    expect(new Set(agentRpcMethods).size).toBe(agentRpcMethods.length);
    expect(agentRpcMethods).toContain("project.agent.chat");
    expect(agentRpcMethods).toContain("chapter.write");
  });

  it("shares the project change allowlist across frontend and runtime", () => {
    expect(ProjectAgentChangeSchema.parse({ type: "chapter.create", summary: "创建章节", title: "第一章", content: "正文" }).type).toBe("chapter.create");
    // 修订和删除必须带一个真存在的 targetId，缺少时必须直接报错
    expect(() => ProjectAgentChangeSchema.parse({ type: "chapter.delete", summary: "缺少目标" })).toThrow();
    expect(() => ProjectAgentChangeSchema.parse({ type: "chapter.update", summary: "缺少目标", content: "正文" })).toThrow();
    expect(ProjectAgentChangeSchema.parse({ type: "chapter.delete", summary: "删除空稿", targetId: 9 }).type).toBe("chapter.delete");
    expect(ProjectAgentChangeSchema.parse({ type: "outline.delete", summary: "删除重复章纲", targetId: 12, title: "章纲｜第 208 章" }).type).toBe("outline.delete");
    expect(ProjectAgentChangeSchema.parse({ type: "chapter.update", summary: "修订第 8 章", targetId: 8, content: "新正文" }).type).toBe("chapter.update");
  });

  it("allows both delegated revision and direct chapter edits", () => {
    expect(ProjectAgentPlannerChangeSchema.parse({ type: "chapter.revise", summary: "去 AI 味", targetId: 8, instruction: "保留情节" }).type).toBe("chapter.revise");
    expect(ProjectAgentPlannerChangeSchema.parse({ type: "chapter.update", summary: "直接写正文", targetId: 8, content: "模型自己写的正文" }).type).toBe("chapter.update");
  });
});
