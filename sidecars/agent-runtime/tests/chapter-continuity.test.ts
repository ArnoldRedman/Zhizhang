import { afterEach, describe, expect, it, vi } from "vitest";
import { draftAcceptanceIssues } from "@zhizhang/contracts";
import { createChapterGraph, chapterDraftMaxTokens, needsStructuralRepair, splitAuthorNotes, splitDraftTitleLine } from "../src/graphs/chapter-write.graph.js";
import { StoryStore } from "../src/storage/story-store.js";

// 各阶段靠任务提示词里的固定句子认出来：构思阶段说"先想一想"，审查阶段带"待审查章节"
const messagesOf = (init?: RequestInit) => JSON.stringify((JSON.parse(String(init?.body || "{}")) as Record<string, unknown>).messages || "");
const ok = (content: string) => new Response(JSON.stringify({ model: "test-model", choices: [{ message: { content } }] }), {
  status: 200,
  headers: { "Content-Type": "application/json" },
});
const passReview = JSON.stringify({ consistent: true, issues: [], suggestions: [] });

describe("chapter continuity context", () => {
  it("风格扫描只提示，不再自动重写；截断和复读仍需修复", () => {
    expect(needsStructuralRepair([{ type: "negation-parade", severity: "blocking", line: 1, column: 1, excerpt: "没问，没说", message: "" }])).toBe(false);
    expect(needsStructuralRepair([{ type: "truncated", severity: "blocking", line: 1, column: 1, excerpt: "未完", message: "" }])).toBe(true);
  });

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

    expect(result.draftContent).toContain("沈妄把案角那摞信札码齐");
    expect(result.authorNotes).toContain("越洋信的寄信人资料里没有，我留成待揭示。");
    const draftRequest = requests.find(body => JSON.stringify(body.messages || "").includes("写第 204 章正文"));
    expect(draftRequest).toBeTruthy();
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

  it("重复前文时自动换事件，只有修正版重新审查通过才采用", async () => {
    const requests: Array<Record<string, unknown>> = [];
    let reviewCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body || "{}")) as Record<string, unknown>);
      const messages = messagesOf(init);
      if (messages.includes("先想一想")) return ok("离开值班室，第二天到城门口。");
      if (messages.includes("待审查章节")) {
        reviewCalls++;
        return ok(reviewCalls <= 2
          ? JSON.stringify({ advances: false, repeatedEvents: ["门内第三声敲击"], findings: [] })
          : passReview);
      }
      if (messages.includes("上一版重演了前文")) return ok("出城\n\n第二天林砚走出城门。");
      return ok("第三声\n\n门外又响起了第三声敲击。");
    });

    const store = StoryStore.inMemory();
    store.createProject({ id: "repair-project", title: "重写测试" });
    const graph = createChapterGraph({ store, apiKey: "test-key", baseURL: "https://relay.test/v1", model: "test-model" });
    const result = await graph.invoke({ projectId: "repair-project", chapterId: "13", instruction: "继续写下一章", targetWords: 10 });

    expect(result.draftContent).toBe("第二天林砚走出城门。");
    expect(result.autoRepairRounds).toBe(1);
    expect(result.reviewResult?.advances).toBe(true);
    expect(result.reviewResult?.repeatedEvents).toEqual([]);
    expect(draftAcceptanceIssues(result.draftContent || "", 10, result.reviewResult)).toEqual([]);
    expect(reviewCalls).toBe(4);
    expect(requests.filter(body => !body.stream && JSON.stringify(body.messages || "").includes("上一版重演了前文"))).toHaveLength(1);
    store.close();
  });

  it("短稿自动补场景后复审，合格才交给连续创作采用", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body || "{}")) as Record<string, unknown>);
      const messages = messagesOf(init);
      if (messages.includes("先想一想")) return ok("确认试印结果。");
      if (messages.includes("待审查章节")) return ok(passReview);
      if (messages.includes("本稿验收问题")) return ok("试印已经定了，林砚笑了。");
      return ok("试印未定。");
    });
    const store = StoryStore.inMemory();
    store.createProject({ id: "short-project", title: "短稿测试" });
    const graph = createChapterGraph({ store, apiKey: "test-key", baseURL: "https://relay.test/v1", model: "test-model" });
    const result = await graph.invoke({ projectId: "short-project", chapterId: "13", instruction: "继续写", targetWords: 10 });

    expect(result.draftContent).toBe("试印已经定了，林砚笑了。");
    expect(result.autoRepairRounds).toBe(1);
    expect(draftAcceptanceIssues(result.draftContent || "", 10, result.reviewResult)).toEqual([]);
    expect(requests.filter(body => JSON.stringify(body.messages || "").includes("待审查章节"))).toHaveLength(4);
    expect(requests.filter(body => !body.stream && JSON.stringify(body.messages || "").includes("本稿验收问题"))).toHaveLength(1);
    store.close();
  });

  it("一致性审查截断但字数已明确不足时仍自动补稿，复审仍失败则不伪造通过", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body || "{}")) as Record<string, unknown>);
      const messages = messagesOf(init);
      if (messages.includes("先想一想")) return ok("确认试印结果。");
      if (messages.includes("你是这本书的一致性检查员")) throw new Error("一致性审查截断");
      if (messages.includes("待审查章节")) return ok(passReview);
      if (messages.includes("本稿验收问题")) return ok("试印已经定了，林砚笑了。");
      return ok("试印未定。");
    });
    const store = StoryStore.inMemory();
    store.createProject({ id: "partial-review", title: "审查中断测试" });
    const graph = createChapterGraph({ store, apiKey: "test-key", baseURL: "https://relay.test/v1", model: "test-model" });
    const result = await graph.invoke({ projectId: "partial-review", chapterId: "13", instruction: "继续写", targetWords: 10 });

    expect(result.autoRepairRounds).toBe(1);
    expect(result.draftContent).toBe("试印已经定了，林砚笑了。");
    expect(requests.filter(body => !body.stream && JSON.stringify(body.messages || "").includes("本稿验收问题"))).toHaveLength(1);
    expect(draftAcceptanceIssues(result.draftContent || "", 10, result.reviewResult).some(issue => issue.startsWith("审查未完成"))).toBe(true);
    store.close();
  });

  it("正文输出预算按目标字数算，不再用 4000 这个按短回复定的默认值", () => {
    expect(chapterDraftMaxTokens(3000)).toBe(6300);
    // 窗口小的时候输出最多占六成，不能把输入挤没了
    expect(chapterDraftMaxTokens(3000, 8)).toBeLessThanOrEqual(Math.floor(8 * 1024 * 0.6));
    expect(chapterDraftMaxTokens(200)).toBe(2000);
  });

  // 事实没修好只尝试一次，第二次审查仍显示问题，不再死循环
  it("S2 一致性问题修一次后仍存在就保留失败结论", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body || "{}")) as Record<string, unknown>);
      const messages = messagesOf(init);
      if (messages.includes("先想一想")) return ok("回院交样。");
      if (messages.includes("你是这本书的一致性检查员")) return ok(JSON.stringify({ verdict: "CONCERNS", findings: [
        { severity: "S2", category: "factual", location: "第 2 段", evidence: "试印结论仍未定", issue: "第 178 章的试印结论写成了已定，本章又当未定处理", fix: "统一为待刻坊回话" },
        { severity: "S2", category: "consistency", location: "第 4 段", evidence: "姜姑娘", issue: "姜冷月称呼与第 176 章不一致", fix: "统一为冷月" },
      ] }));
      if (messages.includes("待审查章节")) return ok(passReview);
      return ok("交样\n\n初稿：试印结论仍未定。");
    });

    const store = StoryStore.inMemory();
    store.createProject({ id: "review-only-project", title: "试讲与婚帖" });
    const graph = createChapterGraph({ store, apiKey: "test-key", baseURL: "https://relay.test/v1", model: "test-model" });
    const result = await graph.invoke({ projectId: "review-only-project", projectTitle: "穿成恶人前夫后，我只想安静等死", chapterId: "179", instruction: "继续写本章" });

    expect(result.draftContent).toBe("初稿：试印结论仍未定。");
    expect(result.reviewResult?.issues).toHaveLength(2);
    expect(result.reviewResult?.verdict).toBe("CONCERNS");
    expect(draftAcceptanceIssues(result.draftContent || "", 0, result.reviewResult).length).toBeGreaterThan(0);
    expect(result.reviewResult?.revised).toBeUndefined();
    expect(result.autoRepairRounds).toBe(1);
    expect(requests.filter(body => !body.stream && JSON.stringify(body.messages || "").includes("本稿验收问题"))).toHaveLength(1);
    expect(requests.filter(body => JSON.stringify(body.messages || "").includes("待审查章节"))).toHaveLength(4);
    store.close();
  });

  it("S1 事实矛盾也只出报告，不能让未经复审的修订稿覆盖首稿", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body || "{}")) as Record<string, unknown>);
      const messages = messagesOf(init);
      if (messages.includes("先想一想")) return ok("回院交样。");
      if (messages.includes("你是这本书的一致性检查员")) return ok(JSON.stringify({ verdict: "REJECT", findings: [
        { severity: "S1", category: "factual", location: "第 1 段", evidence: "试印结论仍未定", issue: "第 178 章结论已定，本章又当未定处理", fix: "统一为已定" },
      ] }));
      if (messages.includes("待审查章节")) return ok(passReview);
      return ok("交样\n\n初稿：试印结论仍未定。");
    });

    const store = StoryStore.inMemory();
    store.createProject({ id: "fix-facts-project", title: "试讲与婚帖" });
    const graph = createChapterGraph({ store, apiKey: "test-key", baseURL: "https://relay.test/v1", model: "test-model" });
    const result = await graph.invoke({ projectId: "fix-facts-project", chapterId: "179", instruction: "继续写本章" });

    expect(result.draftContent).toBe("初稿：试印结论仍未定。");
    expect(result.reviewResult?.findings.some(item => item.severity === "S1" && item.category === "factual")).toBe(true);
    expect(requests.some(body => JSON.stringify(body.messages || "").includes("按以下事实矛盾修订本章"))).toBe(false);
    store.close();
  });

  // 风格句式只提示作者，不再因为一句“不是 A 而是 B”整章重新生成
  it("验证门的句式提醒不触发自动修订，首稿原样交给作者", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body || "{}")) as Record<string, unknown>);
      const messages = messagesOf(init);
      if (messages.includes("先想一想")) return ok("回院交样。");
      if (messages.includes("待审查章节")) return ok(passReview);
      return ok("交样\n\n他不是冷漠，而是绝望——门开了。");
    });

    const store = StoryStore.inMemory();
    store.createProject({ id: "lint-project", title: "验证门测试" });
    const graph = createChapterGraph({ store, apiKey: "test-key", baseURL: "https://relay.test/v1", model: "test-model" });
    const result = await graph.invoke({ projectId: "lint-project", chapterId: "3", instruction: "继续写本章" });

    expect(result.draftContent).toBe("他不是冷漠，而是绝望，门开了。");
    expect(result.lintFindings.map(item => item.type)).toContain("not-is-comparison");
    expect(result.lintFindings.find(item => item.type === "not-is-comparison")?.severity).toBe("advisory");
    expect(requests.filter(body => JSON.stringify(body.messages || "").includes("只修复以下截断"))).toHaveLength(0);
    expect(JSON.stringify(requests.find(body => JSON.stringify(body.messages || "").includes("待审查章节"))?.messages)).toContain("他不是冷漠，而是绝望，门开了。");
    store.close();
  });

  it("审查档位决定跑几个视角；对标资料只进入构思，不进入正文", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body || "{}")) as Record<string, unknown>);
      const messages = messagesOf(init);
      if (messages.includes("先想一想")) return ok("这一章情绪从压抑走到热血。");
      if (messages.includes("待审查章节")) return ok(passReview);
      return ok("出城\n\n他推门出去。");
    });
    const benchmark = {
      anchors: [{ tone: "热血", source: "第 3 章", point: "爆发前先压三拍", excerpt: "原文热血段落。" }, { tone: "悲伤", source: "第 9 章", point: "", excerpt: "原文悲伤段落。" }],
      emotionModules: [{ id: "EM-001", name: "被低估者翻盘", readerNeed: "看他打脸", trigger: "当众被贬", arc: "忍 → 爆 → 众人失语", replaceable: "场合、对手", antiCopy: "换掉打脸的道具与台词", tone: "热血" }],
      rhythm: "| 信息 | 首次出现 |",
    };
    const store = StoryStore.inMemory();
    store.createProject({ id: "mode-project", title: "档位测试" });
    const graph = createChapterGraph({ store, apiKey: "test-key", baseURL: "https://relay.test/v1", model: "test-model" });
    await graph.invoke({ projectId: "mode-project", chapterId: "5", chapterNumber: 5, instruction: "继续写本章", reviewMode: "full", benchmark });
    expect(requests.filter(body => JSON.stringify(body.messages || "").includes("待审查章节"))).toHaveLength(4);
    const draftRequest = requests.find(body => JSON.stringify(body.messages || "").includes("写第 5 章正文"));
    expect(JSON.stringify(draftRequest?.messages)).not.toContain("原文热血段落");
    expect(JSON.stringify(draftRequest?.messages)).not.toContain("原文悲伤段落");

    requests.length = 0;
    store.createProject({ id: "solo-project", title: "档位测试" });
    await graph.invoke({ projectId: "solo-project", chapterId: "6", instruction: "继续写本章", reviewMode: "solo" });
    expect(requests.filter(body => JSON.stringify(body.messages || "").includes("待审查章节"))).toHaveLength(1);
    store.close();
  });

  it("puts the immediate previous chapter ending ahead of ordinary context", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      requests.push(body);
      const messages = JSON.stringify(body.messages || "");
      if (messages.includes("待审查章节")) return ok(passReview);
      if (messages.includes("很短的写作骨架")) return ok("- 起点：门外有人敲门\n- 核心冲突：确认来人并寻找脱身线索\n- 必要事实：旧电台在手\n- 结尾状态：门锁被拧动\n- 后文边界：不揭示来人身份");
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
    expect(result.chapterPlan).toBe("");
    expect(JSON.stringify(requests[1]?.messages)).not.toContain("这一章的想法");
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
    expect(result.chapterPlan).toBe("");
    expect(result.errors).toEqual([]);
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

describe("skills and cast in the writing graph", () => {
  afterEach(() => vi.restoreAllMocks());

  it("默认技能进正文提示词、按章纲匹配的技能追加；正文阶段只带构思点到名的卡，构思阶段带全部卡", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body || "{}")) as Record<string, unknown>);
      const messages = messagesOf(init);
      if (messages.includes("先想一想")) return ok("这一章只写周伯在书肆守夜，等一封信。");
      if (messages.includes("待审查章节")) return ok(passReview);
      return ok("守夜\n\n周伯把灯芯挑了挑。");
    });
    const store = StoryStore.inMemory();
    store.createProject({ id: "cast-project", title: "出场测试" });
    const graph = createChapterGraph({ store, apiKey: "test-key", baseURL: "https://relay.test/v1", model: "test-model" });
    const result = await graph.invoke({
      projectId: "cast-project", chapterId: "7", chapterNumber: 7, instruction: "继续写本章",
      outline: "本章：码头夜战之后的余波，周伯守店",
      skillCatalog: [
        { name: "story-long-write", category: "write", description: "长篇", tags: ["长篇"], content: "长篇写法。" },
        { name: "fight-scene", displayName: "战斗场面", category: "write", description: "打斗", tags: ["夜战"], content: "打斗写法。" },
        { name: "story-review", category: "review", description: "审查", tags: ["余波"], content: "审查规矩。" },
      ],
      defaultSkillNames: ["story-long-write"],
      cards: [{ type: "角色卡", title: "沈妄", content: "沈妄卡" }, { type: "角色卡", title: "周伯", content: "周伯卡" }],
    });
    expect(result.selectedSkills).toEqual(["story-long-write", "fight-scene"]);
    const draftRequest = requests.find(body => JSON.stringify(body.messages || "").includes("写第 7 章正文"));
    const draftText = JSON.stringify(draftRequest?.messages);
    expect(draftText).toContain("沈妄卡");
    expect(draftText).toContain("周伯卡");
    expect(draftText).toContain("本章相关人物与设定");
    expect(draftText).toContain("周伯卡");
    expect(draftText).toContain("沈妄卡");
    expect(draftText).toContain("本章相关人物与设定");
    expect(draftText).toContain("长篇写法");
    expect(draftText).toContain("打斗写法");
    expect(draftText).not.toContain("审查规矩");
    store.close();
  });
});

describe("重写历史章的时点提醒", () => {
  it("章号小于总章数时正文提示词带本章的时点，最后一章不带", async () => {
    const seen: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const messages = messagesOf(init);
      seen.push(messages);
      if (messages.includes("待审查章节")) return ok(passReview);
      if (messages.includes("先想一想")) return ok("承接敲门。");
      return ok("林砚僵在门前。");
    });
    const store = StoryStore.inMemory();
    store.createProject({ id: "history-note", title: "时点测试" });
    const graph = createChapterGraph({ store, apiKey: "test-key", baseURL: "https://relay.test/v1", model: "test-model" });
    await graph.invoke({ projectId: "history-note", chapterId: "130", chapterNumber: 130, totalChapters: 204, instruction: "重写第 130 章", previousChapters: [{ id: "129", title: "第 129 章", content: "门外传来三声敲门。" }] });
    expect(seen.some(messages => messages.includes("本章是第 130 章，正在重写") && messages.includes("第 129 章之前的记忆为准"))).toBe(true);
    seen.length = 0;
    await graph.invoke({ projectId: "history-note", chapterId: "204", chapterNumber: 204, totalChapters: 204, instruction: "继续写", previousChapters: [{ id: "203", title: "第 203 章", content: "门外传来三声敲门。" }] });
    expect(seen.some(messages => messages.includes("本章的时点"))).toBe(false);
    store.close();
  });
});
