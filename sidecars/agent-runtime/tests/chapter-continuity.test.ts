import { afterEach, describe, expect, it, vi } from "vitest";
import { createChapterGraph, chapterDraftMaxTokens } from "../src/graphs/chapter-write.graph.js";
import { StoryStore } from "../src/storage/story-store.js";

describe("chapter continuity context", () => {
  afterEach(() => vi.restoreAllMocks());

  // 正文体应该被模型包装成 {content, summary}，但模型有时直接回纯文本或带承诺语/标题；
  // 图内部已解析，但为了断言“写入前的清洗”行为，直接构造最小图状态验证 draft 产出
  it("剥掉正文开头的章节标题行，不把标题写进正文", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      const messages = JSON.stringify(body.messages || "");
      const content = messages.includes("待审查章节")
        ? JSON.stringify({ consistent: true, issues: [], suggestions: [] })
        : messages.includes("五段写作任务书")
          ? JSON.stringify({ plan: "1. 开篇承接：承接敲门。", handoff: "门锁转动。" })
          // 模型真实 bug：正文开头补了两行重复标题
          : JSON.stringify({ content: "# 第 151 章 黑暗中的后退\n# 第 151 章 黑暗中的后退\n\n林砚僵在门前。", summary: "承接。" });
      return new Response(JSON.stringify({ model: "test-model", choices: [{ message: { content } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const store = StoryStore.inMemory();
    store.createProject({ id: "strip-title-project", title: "剥标题测试" });
    const graph = createChapterGraph({ store, apiKey: "test-key", baseURL: "https://relay.test/v1", model: "test-model" });
    const result = await graph.invoke({
      projectId: "strip-title-project",
      chapterId: "151",
      instruction: "继续写本章",
      previousChapters: [{ id: "150", title: "第 150 章", content: "门外传来三声敲门。" }],
    });

    expect(result.draftContent).toBe("林砚僵在门前。");
    // 标题不能只是被丢掉：剥下来的标题行要带出图外，否则标题栏永远停在“第 N 章”占位
    expect(result.chapterTitle).toBe("第 151 章 黑暗中的后退");
    store.close();
  });

  it("信封里的 title 字段优先于正文开头的标题行", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      const messages = JSON.stringify(body.messages || "");
      const content = messages.includes("待审查章节")
        ? JSON.stringify({ consistent: true, issues: [], suggestions: [] })
        : messages.includes("五段写作任务书")
          ? JSON.stringify({ plan: "1. 开篇承接：承接敲门。", handoff: "门锁转动。" })
          // 正常路径：标题单独放在 title 字段，模型常带上书名号和自己数的章号
          : JSON.stringify({ content: "林砚僵在门前。", title: "《黑暗中的后退》", summary: "承接。" });
      return new Response(JSON.stringify({ model: "test-model", choices: [{ message: { content } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const store = StoryStore.inMemory();
    store.createProject({ id: "envelope-title-project", title: "信封标题测试" });
    const graph = createChapterGraph({ store, apiKey: "test-key", baseURL: "https://relay.test/v1", model: "test-model" });
    const result = await graph.invoke({
      projectId: "envelope-title-project",
      chapterId: "12",
      instruction: "继续写本章",
    });

    expect(result.draftContent).toBe("林砚僵在门前。");
    // 书名号被摸掉，章号由应用自己拼，图只负责给名字
    expect(result.chapterTitle).toBe("黑暗中的后退");
    store.close();
  });

  it("正文只回一句写作承诺时如实返回空，不用承诺语冒充正文", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      const messages = JSON.stringify(body.messages || "");
      const content = messages.includes("待审查章节")
        ? JSON.stringify({ consistent: true, issues: [], suggestions: [] })
        : messages.includes("五段写作任务书")
          ? JSON.stringify({ plan: "1. 开篇承接：承接敲门。", handoff: "门锁转动。" })
          // 模型真实 bug：content 是一句“我会……”的计划确认语，不是正文
          : JSON.stringify({ content: "我会严格沿着十点整的门前对峙继续，保留三声敲击的节奏，只推进到值班室门被推开。", summary: "计划确认。" });
      return new Response(JSON.stringify({ model: "test-model", choices: [{ message: { content } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const store = StoryStore.inMemory();
    store.createProject({ id: "affirmation-project", title: "承诺语测试" });
    const graph = createChapterGraph({ store, apiKey: "test-key", baseURL: "https://relay.test/v1", model: "test-model" });
    const result = await graph.invoke({
      projectId: "affirmation-project",
      chapterId: "1",
      instruction: "继续写本章",
    });

    // 全段都是承诺语时返回空串，让上层报“没有生成正文”而不是把承诺语当正文展示
    expect(result.draftContent).toBe("");
    store.close();
  });

  it("审查判定本章没推进时按下一节点重写一次，不再把重复前文的稿子直接交给作者", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const messagesOf = (init?: RequestInit) => JSON.stringify((JSON.parse(String(init?.body || "{}")) as Record<string, unknown>).messages || "");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body || "{}")) as Record<string, unknown>);
      const messages = messagesOf(init);
      const content = messages.includes("五段写作任务书")
        ? JSON.stringify({ plan: "1. 本章推进：离开值班室，第二天到城门口。", handoff: "城门。" })
        : messages.includes("待审查章节")
          ? JSON.stringify({ consistent: true, issues: [], suggestions: [], advances: false, progress: "仍停在值班室门前", repeatedEvents: ["门内第三声敲击"] })
          // 重写请求靠任务里的“本次是重写”认出来
          : messages.includes("本次是重写")
            ? JSON.stringify({ content: "第二天清晨，林砚已经站在城门口。", title: "出城", summary: "推进到出城。" })
            : JSON.stringify({ content: "门外又响起了第三声敲击。", title: "第三声", summary: "又把门前戏写了一遍。" });
      return new Response(JSON.stringify({ model: "test-model", choices: [{ message: { content } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const store = StoryStore.inMemory();
    store.createProject({ id: "repair-project", title: "重写测试" });
    const graph = createChapterGraph({ store, apiKey: "test-key", baseURL: "https://relay.test/v1", model: "test-model" });
    const result = await graph.invoke({
      projectId: "repair-project",
      chapterId: "13",
      instruction: "继续写下一章",
      masterOutline: "结构骨架：\n## 第一卷 交付失控\n## 第二卷 验证与转移",
      previousChapters: [{ id: "12", title: "第 12 章", content: "白光锁住了林砚的右肩。" }],
    });

    expect(result.draftContent).toBe("第二天清晨，林砚已经站在城门口。");
    expect(requests.some(body => JSON.stringify(body.messages || "").includes("本次是重写"))).toBe(true);
    // 正文请求必须带上按目标字数算的输出预算，不能再用客户端那个按短回复定的 4000
    expect(requests.some(body => Number(body.max_tokens) > 4000)).toBe(true);
    // 重写后的稿子不该还挂着“没有推进”的旧结论
    expect(result.reviewResult?.repeatedEvents).toEqual([]);
    expect(result.reviewResult?.suggestions.join("")).toContain("重写");
    store.close();
  });

  it("正文输出预算按目标字数算，不再用 4000 这个按短回复定的默认值", () => {
    expect(chapterDraftMaxTokens(3000)).toBe(6300);
    // 窗口小的时候输出最多占六成，不能把输入挤没了
    expect(chapterDraftMaxTokens(3000, 8)).toBeLessThanOrEqual(Math.floor(8 * 1024 * 0.6));
    expect(chapterDraftMaxTokens(200)).toBe(2000);
  });

  it("puts the immediate previous chapter ending ahead of ordinary context", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      requests.push(body);
      const isReview = Array.isArray(body.messages)
        && JSON.stringify(body.messages).includes("待审查章节");
      const isPlan = Array.isArray(body.messages)
        && JSON.stringify(body.messages).includes("五段写作任务书");
      const content = isReview
        ? JSON.stringify({ consistent: true, issues: [], suggestions: [] })
        : isPlan
          ? JSON.stringify({ plan: JSON.stringify({ opening: "承接电台亮起与门外三声敲门。", story: "主角先确认门外来人身份，再寻找脱身线索。", ending: "门锁被人从外面轻轻拧动。" }), handoff: "门锁转动，主角仍在阁楼。" })
        : JSON.stringify({ content: "他握紧旧电台，门外又传来三声敲门。", summary: "主角承接电台线索并迎来新的危机。" });
      return new Response(JSON.stringify({ model: "test-model", choices: [{ message: { content } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const store = StoryStore.inMemory();
    store.createProject({ id: "continuity-project", title: "承接测试" });
    const graph = createChapterGraph({
      store,
      apiKey: "test-key",
      baseURL: "https://relay.test/v1",
      model: "test-model",
    });
    const result = await graph.invoke({
      projectId: "continuity-project",
      chapterId: "3",
      instruction: "继续写第三章，承接上一章结尾的危机",
      previousChapters: [{ id: "2", title: "第二章", content: "他推开阁楼门，旧电台突然亮起。章末钩子：门外响起三声敲门。" }],
      skillCatalog: [{
        name: "chapter-continuity",
        category: "write",
        description: "章节承接",
        tags: ["章节承接"],
        content: "先检查上一章结尾，再写本章第一段。",
      }, {
        name: "story-long-write",
        category: "write",
        description: "长篇续写",
        tags: ["续写"],
        content: "保持长篇节奏。",
      }],
    });

    expect(result.continuityContext).toContain("三声敲门");
    expect(requests[0]?.messages && JSON.stringify(requests[0].messages)).toContain("上一章结尾（最高优先级）");
    expect(requests[0]?.messages && JSON.stringify(requests[0].messages)).toContain("三声敲门");
    expect(result.selectedSkills).toContain("chapter-continuity");
    expect(result.chapterPlan).toBeTruthy();
    expect(result.chapterPlan).toContain("## 开篇承接");
    expect(result.chapterPlan).toContain("门锁转动");
    expect(result.chapterPlan).not.toContain('{"opening"');
    expect(requests[1]?.messages && JSON.stringify(requests[1].messages)).toContain("下一章计划");
    store.close();
  });
});

describe("chapter graph degrades instead of failing the whole chapter", () => {
  afterEach(() => vi.restoreAllMocks());

  // 推理模型把输出上限全花在推理上时，中转会返回空内容加 finish_reason=length，客户端据此抛截断错误
  const truncated = () => new Response(JSON.stringify({ model: "test-model", choices: [{ finish_reason: "length", message: { content: "" } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
  const ok = (content: string) => new Response(JSON.stringify({ model: "test-model", choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
  const messagesOf = (init?: RequestInit) => JSON.stringify((JSON.parse(String(init?.body || "{}")) as Record<string, unknown>).messages || "");

  it("计划阶段被截断时改用默认计划继续写正文，并把原因记进 errors", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const messages = messagesOf(init);
      if (messages.includes("五段写作任务书")) return truncated();
      if (messages.includes("待审查章节")) return ok(JSON.stringify({ consistent: true, issues: [], suggestions: [] }));
      return ok(JSON.stringify({ content: "林砚推开门。", title: "推门", summary: "承接。" }));
    });
    const store = StoryStore.inMemory();
    store.createProject({ id: "plan-truncated", title: "计划截断测试" });
    const graph = createChapterGraph({ store, apiKey: "test-key", baseURL: "https://relay.test/v1", model: "test-model" });
    const result = await graph.invoke({
      projectId: "plan-truncated",
      chapterId: "5",
      instruction: "继续写本章",
      previousChapters: [{ id: "4", title: "第 4 章", content: "门外三声敲门。" }],
    });
    expect(result.draftContent).toBe("林砚推开门。");
    expect(result.chapterPlan).toContain("本章推进");
    expect(result.errors.some(item => item.includes("计划阶段失败"))).toBe(true);
    store.close();
  });

  it("审查阶段失败时保留正文，并如实标注审查未完成", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const messages = messagesOf(init);
      if (messages.includes("五段写作任务书")) return ok(JSON.stringify({ plan: "1. 本章推进：进城。", handoff: "抵达城门。" }));
      if (messages.includes("待审查章节")) return truncated();
      return ok(JSON.stringify({ content: "林砚进了城。", title: "进城", summary: "进城。" }));
    });
    const store = StoryStore.inMemory();
    store.createProject({ id: "review-failed", title: "审查失败测试" });
    const graph = createChapterGraph({ store, apiKey: "test-key", baseURL: "https://relay.test/v1", model: "test-model" });
    const result = await graph.invoke({
      projectId: "review-failed",
      chapterId: "6",
      instruction: "继续写本章",
      previousChapters: [{ id: "5", title: "第 5 章", content: "林砚推开门。" }],
    });
    expect(result.draftContent).toBe("林砚进了城。");
    expect(result.reviewResult?.consistent).toBe(true);
    expect(result.reviewResult?.suggestions[0]).toContain("审查未完成");
    expect(result.errors.some(item => item.includes("审查阶段失败"))).toBe(true);
    store.close();
  });
});
