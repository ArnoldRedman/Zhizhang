import { afterEach, describe, expect, it, vi } from "vitest";
import { createChapterGraph, chapterDraftMaxTokens, splitAuthorNotes, splitDraftTitleLine } from "../src/graphs/chapter-write.graph.js";
import { StoryStore } from "../src/storage/story-store.js";

// 各阶段靠任务提示词里的固定句子认出来：构思阶段说"先想一想"，审查阶段带"待审查章节"，重写阶段带"上一版的问题"
const messagesOf = (init?: RequestInit) => JSON.stringify((JSON.parse(String(init?.body || "{}")) as Record<string, unknown>).messages || "");
const ok = (content: string) => new Response(JSON.stringify({ model: "test-model", choices: [{ message: { content } }] }), {
  status: 200,
  headers: { "Content-Type": "application/json" },
});
const passReview = JSON.stringify({ consistent: true, issues: [], suggestions: [] });

describe("chapter continuity context", () => {
  afterEach(() => vi.restoreAllMocks());

  // 模型偶尔仍按旧习惯把正文包成 {content, title}，或者在正文开头补标题行；两种都要拆干净
  it("剥掉正文开头的章节标题行，不把标题写进正文", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const messages = messagesOf(init);
      if (messages.includes("待审查章节")) return ok(passReview);
      if (messages.includes("先想一想")) return ok("承接敲门，然后离开阁楼。");
      // 模型真实 bug：正文开头补了两行重复标题
      return ok(JSON.stringify({ content: "# 第 151 章 黑暗中的后退\n# 第 151 章 黑暗中的后退\n\n林砚僵在门前。", summary: "承接。" }));
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
    // 标题不能只是被丢掉：剥下来的标题行要带出图外，否则标题栏永远停在"第 N 章"占位
    expect(result.chapterTitle).toBe("第 151 章 黑暗中的后退");
    store.close();
  });

  it("信封里的 title 字段优先于正文开头的标题行", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const messages = messagesOf(init);
      if (messages.includes("待审查章节")) return ok(passReview);
      if (messages.includes("先想一想")) return ok("承接敲门。");
      return ok(JSON.stringify({ content: "林砚僵在门前。", title: "《黑暗中的后退》", summary: "承接。" }));
    });

    const store = StoryStore.inMemory();
    store.createProject({ id: "envelope-title-project", title: "信封标题测试" });
    const graph = createChapterGraph({ store, apiKey: "test-key", baseURL: "https://relay.test/v1", model: "test-model" });
    const result = await graph.invoke({ projectId: "envelope-title-project", chapterId: "12", instruction: "继续写本章" });

    expect(result.draftContent).toBe("林砚僵在门前。");
    // 书名号被摸掉，章号由应用自己拼，图只负责给名字
    expect(result.chapterTitle).toBe("黑暗中的后退");
    store.close();
  });

  // 正文现在是纯文本：第一行章名，空一行正文，末尾可以带【给作者】
  it("纯文本正文：第一行当章名，末尾的【给作者】剥出来单独交给界面", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body || "{}")) as Record<string, unknown>);
      const messages = messagesOf(init);
      if (messages.includes("待审查章节")) return ok(passReview);
      if (messages.includes("先想一想")) return ok("先写医院，再写夜路。\n【给作者】姜冷月是否知道体检结果，资料里没写，我按不知道处理。");
      return ok("越过书房门槛\n\n清晨，梧桐路601。\n\n沈妄把案角那摞信札码齐。\n【给作者】越洋信的寄信人资料里没有，我留成待揭示。\n【给作者】周伯是否住在601？");
    });

    const store = StoryStore.inMemory();
    store.createProject({ id: "plain-project", title: "纯文本测试" });
    const graph = createChapterGraph({ store, apiKey: "test-key", baseURL: "https://relay.test/v1", model: "test-model" });
    const result = await graph.invoke({ projectId: "plain-project", chapterId: "204", chapterNumber: 204, instruction: "写下一章", targetWords: 2200 });

    expect(result.chapterTitle).toBe("越过书房门槛");
    expect(result.draftContent).toBe("清晨，梧桐路601。\n\n沈妄把案角那摞信札码齐。");
    expect(result.draftContent).not.toContain("给作者");
    expect(result.authorNotes).toEqual([
      "姜冷月是否知道体检结果，资料里没写，我按不知道处理。",
      "越洋信的寄信人资料里没有，我留成待揭示。",
      "周伯是否住在601？",
    ]);
    // 正文请求走纯文本、高温度，任务里说清写第几章、约多少字
    const draftRequest = requests.find(body => JSON.stringify(body.messages || "").includes("写第 204 章正文"));
    expect(draftRequest).toBeTruthy();
    expect(draftRequest?.response_format).toBeUndefined();
    expect(Number(draftRequest?.temperature)).toBeGreaterThan(0.8);
    expect(JSON.stringify(draftRequest?.messages)).toContain("约 2200 字");
    store.close();
  });

  it("正文只回一句写作承诺时如实返回空，不用承诺语冒充正文", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const messages = messagesOf(init);
      if (messages.includes("待审查章节")) return ok(passReview);
      if (messages.includes("先想一想")) return ok("承接敲门。");
      // 模型真实 bug：content 是一句"我会……"的计划确认语，不是正文
      return ok(JSON.stringify({ content: "我会严格沿着十点整的门前对峙继续，保留三声敲击的节奏，只推进到值班室门被推开。", summary: "计划确认。" }));
    });

    const store = StoryStore.inMemory();
    store.createProject({ id: "affirmation-project", title: "承诺语测试" });
    const graph = createChapterGraph({ store, apiKey: "test-key", baseURL: "https://relay.test/v1", model: "test-model" });
    const result = await graph.invoke({ projectId: "affirmation-project", chapterId: "1", instruction: "继续写本章" });

    // 全段都是承诺语时返回空串，让上层报"没有生成正文"而不是把承诺语当正文展示
    expect(result.draftContent).toBe("");
    store.close();
  });

  it("审查判定本章没推进时换一件事重写一次，不再把重复前文的稿子直接交给作者", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body || "{}")) as Record<string, unknown>);
      const messages = messagesOf(init);
      if (messages.includes("先想一想")) return ok("离开值班室，第二天到城门口。");
      if (messages.includes("待审查章节")) return ok(JSON.stringify({ consistent: true, issues: [], suggestions: [], advances: false, progress: "仍停在值班室门前", repeatedEvents: ["门内第三声敲击"] }));
      if (messages.includes("上一版的问题")) return ok("出城\n\n第二天清晨，林砚已经站在城门口。");
      return ok("第三声\n\n门外又响起了第三声敲击。");
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
    expect(result.chapterTitle).toBe("出城");
    const repairRequest = requests.find(body => JSON.stringify(body.messages || "").includes("上一版的问题"));
    expect(repairRequest).toBeTruthy();
    expect(JSON.stringify(repairRequest?.messages)).toContain("门内第三声敲击");
    // 正文请求必须带上按目标字数算的输出预算，不能再用客户端那个按短回复定的 4000
    expect(requests.some(body => Number(body.max_tokens) > 4000)).toBe(true);
    // 重写后的稿子不该还挂着"没有推进"的旧结论
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

  // 审查只出报告：每多一轮低温改写，人物的情绪和口语就被磨平一层，一致性问题交给作者看
  it("审查提出一致性问题时只出报告，正文原样交给作者，不再定点修订", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body || "{}")) as Record<string, unknown>);
      const messages = messagesOf(init);
      if (messages.includes("先想一想")) return ok("回院交样。");
      if (messages.includes("待审查章节")) return ok(JSON.stringify({ consistent: false, issues: ["第 178 章的试印结论写成了已定，本章又当未定处理", "姜冷月称呼与第 176 章不一致"], suggestions: ["把“试印结论已定”改成“试印结论待刻坊回话”"], advances: true, progress: "推进到交样" }));
      return ok("交样\n\n初稿：试印结论仍未定。");
    });

    const store = StoryStore.inMemory();
    store.createProject({ id: "review-only-project", title: "试讲与婚帖" });
    const graph = createChapterGraph({ store, apiKey: "test-key", baseURL: "https://relay.test/v1", model: "test-model" });
    const result = await graph.invoke({ projectId: "review-only-project", projectTitle: "穿成恶人前夫后，我只想安静等死", chapterId: "179", instruction: "继续写本章" });

    expect(result.draftContent).toBe("初稿：试印结论仍未定。");
    expect(result.reviewResult?.issues).toHaveLength(2);
    expect(result.reviewResult?.revised).toBeUndefined();
    expect(requests.some(body => JSON.stringify(body.messages || "").includes("按以下一致性审查意见修订本章"))).toBe(false);
    // 审查只跑一次，之后没有任何改写请求（测试桩不回流式，正文会多一次非流式兜底请求，所以不数总数）
    expect(requests.filter(body => JSON.stringify(body.messages || "").includes("待审查章节"))).toHaveLength(1);
    expect(requests.some(body => JSON.stringify(body.messages || "").includes("本次仅调整正文长度"))).toBe(false);
    store.close();
  });

  it("puts the immediate previous chapter ending ahead of ordinary context", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      requests.push(body);
      const messages = JSON.stringify(body.messages || "");
      if (messages.includes("待审查章节")) return ok(passReview);
      if (messages.includes("先想一想")) return ok("主角先确认门外来人身份，再寻找脱身线索；结尾门锁被人从外面轻轻拧动。");
      return ok("敲门\n\n他握紧旧电台，门外又传来三声敲门。");
    });

    const store = StoryStore.inMemory();
    store.createProject({ id: "continuity-project", title: "承接测试" });
    const graph = createChapterGraph({ store, apiKey: "test-key", baseURL: "https://relay.test/v1", model: "test-model" });
    const result = await graph.invoke({
      projectId: "continuity-project",
      chapterId: "3",
      instruction: "继续写第三章，承接上一章结尾的危机",
      previousChapters: [{ id: "2", title: "第二章", content: "他推开阁楼门，旧电台突然亮起。章末钩子：门外响起三声敲门。" }],
      preferredSkillNames: ["chapter-continuity"],
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
    expect(JSON.stringify(requests[0]?.messages)).toContain("上一章结尾");
    expect(JSON.stringify(requests[0]?.messages)).toContain("三声敲门");
    // 只带作者亲手勾的技能，不再按指令关键词自动挑
    expect(result.selectedSkills).toEqual(["chapter-continuity"]);
    expect(JSON.stringify(requests[1]?.messages)).toContain("先检查上一章结尾");
    expect(JSON.stringify(requests[1]?.messages)).not.toContain("保持长篇节奏");
    expect(result.chapterPlan).toContain("门锁");
    expect(JSON.stringify(requests[1]?.messages)).toContain("这一章的想法");
    store.close();
  });

  it("字数不再自动调整：短稿原样交给作者，报告里不再出现字数调整", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body || "{}")) as Record<string, unknown>);
      const messages = messagesOf(init);
      if (messages.includes("待审查章节")) return ok(passReview);
      if (messages.includes("先想一想")) return ok("推进本章事件。");
      return ok(`短章\n\n${"文".repeat(50)}`);
    });
    const store = StoryStore.inMemory();
    store.createProject({ id: "short", title: "字数测试" });
    try {
      const result = await createChapterGraph({ store, apiKey: "test", baseURL: "https://relay.test/v1", model: "test" }).invoke({ projectId: "short", chapterId: "1", instruction: "写本章", targetWords: 100 });
      expect(result.draftContent).toBe("文".repeat(50));
      expect(requests.some(body => JSON.stringify(body.messages || "").includes("本次仅调整正文长度"))).toBe(false);
      expect(result.errors).toEqual([]);
    } finally { store.close(); }
  });
});

describe("chapter graph degrades instead of failing the whole chapter", () => {
  afterEach(() => vi.restoreAllMocks());

  // 推理模型把输出上限全花在推理上时，中转会返回空内容加 finish_reason=length，客户端据此抛截断错误
  const truncated = () => new Response(JSON.stringify({ model: "test-model", choices: [{ finish_reason: "length", message: { content: "" } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  it("构思阶段被截断时直接写正文，并把原因记进 errors", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const messages = messagesOf(init);
      if (messages.includes("先想一想")) return truncated();
      if (messages.includes("待审查章节")) return ok(passReview);
      return ok("推门\n\n林砚推开门。");
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
    expect(result.chapterPlan).toContain("按总纲");
    expect(result.errors.some(item => item.includes("计划阶段失败"))).toBe(true);
    store.close();
  });

  it("审查阶段失败时保留正文，并如实标注审查未完成", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const messages = messagesOf(init);
      if (messages.includes("先想一想")) return ok("进城。");
      if (messages.includes("待审查章节")) return truncated();
      return ok("进城\n\n林砚进了城。");
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

describe("正文文本拆分", () => {
  it("splitAuthorNotes 只剥【给作者】行，方括号写法也认，正文其余原样保留", () => {
    const split = splitAuthorNotes("清晨。\n【给作者】寄信人是谁？\n他站着没动。\n[给作者]：周伯住哪？\n【给作者】");
    expect(split.content).toBe("清晨。\n他站着没动。");
    expect(split.authorNotes).toEqual(["寄信人是谁？", "周伯住哪？"]);
  });

  it("splitDraftTitleLine 认第一行短标题，带章号前缀与书名号的也认；第一行是叙述句时整段都是正文", () => {
    expect(splitDraftTitleLine("越过书房门槛\n\n清晨。")).toEqual({ title: "越过书房门槛", content: "清晨。" });
    expect(splitDraftTitleLine("第 204 章 《越过书房门槛》\n清晨。")).toEqual({ title: "越过书房门槛", content: "清晨。" });
    expect(splitDraftTitleLine("清晨，梧桐路601。\n\n沈妄把信札码齐。")).toEqual({ title: "", content: "清晨，梧桐路601。\n\n沈妄把信札码齐。" });
    expect(splitDraftTitleLine("“走吧。”她说。\n他没动。")).toEqual({ title: "", content: "“走吧。”她说。\n他没动。" });
  });
});
