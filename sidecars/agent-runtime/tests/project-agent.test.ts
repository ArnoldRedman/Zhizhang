import { describe, expect, it, vi } from "vitest";
import { ModelApiClient } from "../src/models/model-api.js";
import { buildProjectAgentContext, extractDsmlTurn, isDsmlOrToolCall, isFormatRepairMetaComplaint, ProjectAgentChangeSchema, runProjectAgent } from "../src/project-agent.js";

const project = {
  id: 42,
  title: "城南夜雨",
  synopsis: "林舟在城南整理一批旧书档案。",
  chapters: [
    { id: 1, title: "第一章 入城", content: "林舟抵达城南书店，发现一本缺少借阅记录的旧书。" },
    { id: 2, title: "第二章 夜雨", content: "夜雨中，林舟确认旧书来自码头仓库，并决定次日前往核对。" },
  ],
  outlines: [{ id: 11, kind: "章纲", title: "章纲｜第三章 旧仓库", content: "林舟前往旧仓库，找到新的档案线索。" }],
  cards: [{ id: 21, type: "角色卡", title: "林舟", content: "谨慎，擅长整理档案。", currentState: "准备前往旧仓库" }],
  memories: [],
  memoryDocuments: [{ id: "memory-document:伏笔追踪", kind: "伏笔追踪", title: "伏笔追踪", content: "旧书的借阅记录尚待确认。" }],
  graphNodes: [{ id: "card:21", label: "林舟", type: "card", category: "角色卡" }],
  graphEdges: [],
};

const delegates = () => ({ chapter: vi.fn(), chapterRevise: vi.fn(), chapterTitles: vi.fn(), chapterSplit: vi.fn(), outline: vi.fn(), card: vi.fn() });

// 长篇：作者真实的书有一百多章，id 是创建时的时间戳，标题多半还是创建时的占位
const bigProject = {
  ...project,
  chapters: Array.from({ length: 180 }, (_, index) => ({
    id: 1_700_000_000_000 + index + 1,
    title: `第 ${index + 1} 章`,
    content: `第 ${index + 1} 章的正文：林舟继续核对码头仓库的档案，并记下新的疑点。`,
  })),
};

const clientWith = (content: string) => ({
  chat: vi.fn().mockResolvedValue({ content, model: "test" }),
}) as unknown as ModelApiClient;

describe("project agent", () => {
  it("selects relevant project documents within the context packet", () => {
    const context = buildProjectAgentContext({
      mode: "discuss",
      instruction: "整理林舟前往旧仓库前掌握的线索和待确认事项",
      project,
      activeChapterId: 2,
      contextWindowKTokens: 64,
    });

    expect(context.packet).toContain("角色卡｜21｜林舟");
    expect(context.packet).toContain("章纲｜11｜章纲｜第三章 旧仓库");
    expect(context.packet).toContain("伏笔追踪");
    expect(context.sources.length).toBeGreaterThan(0);
  });

  it("forces discuss mode to remain read-only", async () => {
    const client = clientWith(JSON.stringify({
      message: "林舟目前确认旧书来自码头仓库，下一步应核对仓库档案与借阅记录。",
      changes: [{
        type: "card.upsert",
        summary: "更新林舟状态",
        targetId: 21,
        cardType: "角色卡",
        title: "林舟",
        content: "准备前往旧仓库核对档案。",
      }],
    }));

    const result = await runProjectAgent({
      mode: "discuss",
      instruction: "分析林舟下一步如何整理资料",
      project,
    }, client, delegates());

    expect(result.message).toContain("仓库档案");
    expect(result.changes).toEqual([]);
    expect(result.toolEvents[0].tool).toBe("project.context");
  });

  it("delegates outline/card/chapter writing to the existing specialist agents", async () => {
    const client = clientWith(JSON.stringify({
      message: "我把林舟卡片和第三章都交给对应的智能体了。",
      changes: [
        {
          type: "card.write",
          summary: "补充林舟当前目标",
          targetId: 21,
          cardType: "角色卡",
          title: "林舟",
          instruction: "补上他核对旧仓库档案的当前目标。",
        },
        {
          type: "chapter.draft_next",
          summary: "起草第三章",
          title: "第三章 旧仓库",
          instruction: "承接夜雨结尾，写林舟前往旧仓库核对档案并发现新线索。",
          outlineId: 11,
        },
      ],
    }));
    const chapter = vi.fn().mockResolvedValue({
      type: "chapter.create",
      summary: "起草第三章",
      title: "第三章 旧仓库",
      content: "旧仓库的木门在晨风里轻响。",
      chapterPlan: "## 承接\n林舟从客栈出发。",
      chapterSummary: "林舟抵达旧仓库并找到新的档案线索。",
    });
    const card = vi.fn().mockResolvedValue({
      type: "card.upsert",
      summary: "补充林舟当前目标",
      targetId: 21,
      cardType: "角色卡",
      title: "林舟",
      content: "谨慎，擅长整理档案。当前目标：核对旧仓库中的书籍档案。",
    });

    const result = await runProjectAgent({
      mode: "execute",
      instruction: "整理林舟卡片并继续写第三章",
      project,
    }, client, { ...delegates(), chapter, card });

    // Agent 只给了 instruction，正文由专用智能体产出
    expect(card).toHaveBeenCalledWith(expect.objectContaining({ type: "card.write", targetId: 21, instruction: expect.any(String) }));
    expect(chapter).toHaveBeenCalledOnce();
    expect(result.changes.map(change => change.type)).toEqual(["card.upsert", "chapter.create"]);
    expect(result.toolEvents.some(event => event.tool === "card.write" && event.status === "complete")).toBe(true);
  });

  it("keeps the agent from authoring outline or card content itself", async () => {
    const client = clientWith(JSON.stringify({
      message: "我直接写好了卡片正文。",
      changes: [{
        type: "card.upsert",
        summary: "越过卡片智能体直接写内容",
        targetId: 21,
        cardType: "角色卡",
        title: "林舟",
        content: "我自己编的卡片正文。",
      }],
    }));

    const result = await runProjectAgent({
      mode: "execute",
      instruction: "更新林舟卡片",
      project,
    }, client, delegates());

    expect(result.changes).toEqual([]);
    expect(result.toolEvents.filter(event => event.tool === "change.reject")).toHaveLength(1);
  });

  it("rejects actions outside the allowlist", () => {
    expect(() => ProjectAgentChangeSchema.parse({
      type: "system.unsupported",
      summary: "不受支持的操作",
      targetId: 1,
    })).toThrow();
  });

  it("runs a search/open tool loop before finishing", async () => {
    const turns = [
      JSON.stringify({ action: "search", query: "旧仓库 线索" }),
      JSON.stringify({ action: "open", kind: "章节", id: "2" }),
      JSON.stringify({ action: "finish", message: "林舟已确认旧书来自码头仓库。", changes: [] }),
    ];
    const chat = vi.fn().mockImplementation(() => Promise.resolve({ content: turns.shift(), model: "test" }));
    const client = { chat } as unknown as ModelApiClient;

    const result = await runProjectAgent({
      mode: "discuss",
      instruction: "林舟对旧仓库掌握了哪些线索",
      project,
    }, client, delegates());

    expect(chat).toHaveBeenCalledTimes(3);
    expect(result.message).toContain("码头仓库");
    expect(result.toolEvents.map(event => event.tool)).toEqual(["project.context", "project.search", "project.open"]);
    // open 必须真的把第二章正文回灌给模型，否则循环就退化成空转
    const openTurn = chat.mock.calls[2][0] as Array<{ content: string }>;
    expect(openTurn.at(-1)?.content).toContain("码头仓库");
  });

  it("多轮检索后请求体不会无上限增长", async () => {
    // 回归：messages 只增不减，真实使用中请求体从几 KB 撑到 62 KB，做到一半突然被中转站拒绝
    const bulky = { ...project, chapters: project.chapters.map(chapter => ({ ...chapter, content: "旧仓库的档案细节。".repeat(2000) })) };
    const chat = vi.fn().mockImplementation((messages: Array<{ content: string }>) => {
      const bytes = messages.reduce((sum, message) => sum + Buffer.byteLength(message.content, "utf8"), 0);
      // 40 KB 上限叠上最后一轮的截断余量，留一些余地
      expect(bytes).toBeLessThan(48_000);
      return Promise.resolve({ content: JSON.stringify({ action: "open", kind: "章节", id: "1" }), model: "test" });
    });

    await runProjectAgent({
      mode: "discuss",
      instruction: "把旧仓库相关的章节全看一遍",
      project: bulky,
      maxSteps: 8,
    }, { chat } as unknown as ModelApiClient, delegates());

    expect(chat).toHaveBeenCalledTimes(8);
    // 被省略早期轮次时要如实告知模型，而不是默默丢掉
    const lastTurn = chat.mock.calls.at(-1)?.[0] as Array<{ content: string }>;
    expect(lastTurn.some(message => message.content.includes("已省略较早的"))).toBe(true);
    // system 与首条请求（含项目资料）是任务前提，任何情况下都不能被丢
    expect(lastTurn[0]?.content).toContain("小说项目助手");
    expect(lastTurn.some(message => message.content.includes("本轮请求"))).toBe(true);
  });

  it("stops the loop at maxSteps and still returns a result", async () => {
    const chat = vi.fn().mockResolvedValue({ content: JSON.stringify({ action: "search", query: "林舟" }), model: "test" });
    const client = { chat } as unknown as ModelApiClient;

    const result = await runProjectAgent({
      mode: "discuss",
      instruction: "随便找点东西",
      project,
      maxSteps: 3,
    }, client, delegates());

    expect(chat).toHaveBeenCalledTimes(3);
    expect(result.changes).toEqual([]);
    expect(result.message).toContain("没有收敛");
  });

  it("recovers when the model puts a change type in the action field", async () => {
    // 真实接口上 gpt-5.6-sol 会回 {"action":"chapter.draft_next",...}，把两套命名空间混在一起
    const chat = vi.fn().mockResolvedValue({
      content: JSON.stringify({ action: "chapter.draft_next", summary: "起草第三章", title: "第三章 旧仓库", instruction: "承接夜雨结尾", outlineId: 0 }),
      model: "test",
    });
    const delegate = vi.fn().mockResolvedValue({
      type: "chapter.create", summary: "起草第三章", title: "第三章 旧仓库", content: "旧仓库的木门轻响。",
    });

    const result = await runProjectAgent({
      mode: "execute", instruction: "继续写第三章", project,
    }, { chat } as unknown as ModelApiClient, { ...delegates(), chapter: delegate });

    expect(delegate).toHaveBeenCalledOnce();
    expect(result.changes.map(change => change.type)).toEqual(["chapter.create"]);
    expect(result.toolEvents.some(event => event.tool === "change.reject")).toBe(false);
  });

  it("drops one malformed change without losing the reply or the valid ones", async () => {
    const chat = vi.fn().mockResolvedValue({
      content: JSON.stringify({ action: "finish", message: "整理完成。", changes: [
        { type: "card.write", summary: "坏的", targetId: "168", patch: { currentState: "x" } },
        { type: "card.write", summary: "好的", targetId: 21, cardType: "角色卡", title: "林舟", instruction: "补充当前目标。" },
      ] }),
      model: "test",
    });
    const card = vi.fn().mockResolvedValue({
      type: "card.upsert", summary: "好的", targetId: 21, cardType: "角色卡", title: "林舟", content: "谨慎。",
    });

    const result = await runProjectAgent({
      mode: "execute", instruction: "整理林舟卡片", project,
    }, { chat } as unknown as ModelApiClient, { ...delegates(), card });

    expect(result.message).toBe("整理完成。");
    expect(card).toHaveBeenCalledOnce();
    expect(result.changes).toHaveLength(1);
    expect(result.toolEvents.filter(event => event.tool === "change.reject")).toHaveLength(1);
  });

  it("delegates a chapter revise and returns a chapter.update proposal", async () => {
    const chat = vi.fn().mockResolvedValue({
      content: JSON.stringify({ action: "finish", message: "已修订第二章。", changes: [
        { type: "chapter.revise", summary: "去 AI 味", targetId: 2, instruction: "保留情节和人物口吻" },
      ] }),
      model: "test",
    });
    const chapterRevise = vi.fn().mockResolvedValue({
      type: "chapter.update", summary: "去 AI 味", targetId: 2, content: "夜雨敲在窗框上。",
    });

    const result = await runProjectAgent({
      mode: "execute", instruction: "把第二章的 AI 味去掉", project,
    }, { chat } as unknown as ModelApiClient, { ...delegates(), chapterRevise });

    expect(chapterRevise).toHaveBeenCalledWith(expect.objectContaining({ targetId: 2, instruction: "保留情节和人物口吻" }));
    expect(result.changes).toEqual([{ type: "chapter.update", summary: "去 AI 味", targetId: 2, content: "夜雨敲在窗框上。" }]);
  });

  it("caps revises per turn so one request cannot rewrite the whole book", async () => {
    const chat = vi.fn().mockResolvedValue({
      content: JSON.stringify({ action: "finish", message: "开始批量修订。", changes: Array.from({ length: 13 }, (_, index) => ({
        type: "chapter.revise", summary: `修订 ${index + 1}`, targetId: index + 1, instruction: "润色",
      })) }),
      model: "test",
    });
    const chapterRevise = vi.fn().mockImplementation((request: { targetId: number; summary: string }) => Promise.resolve({
      type: "chapter.update", summary: request.summary, targetId: request.targetId, content: "修订后正文。",
    }));

    const result = await runProjectAgent({
      mode: "execute", instruction: "把全书都润色一遍", project,
    }, { chat } as unknown as ModelApiClient, { ...delegates(), chapterRevise });

    // 前 10 章真的执行，剩下的如实报错而不静默丢弃
    expect(chapterRevise).toHaveBeenCalledTimes(10);
    expect(result.changes).toHaveLength(10);
    expect(result.toolEvents.filter(event => event.tool === "chapter.revise" && event.status === "error")).toHaveLength(3);
  });

  it("整轮委派超预算后停手，剩余变更如实报出", async () => {
    // 回归：一轮最多 16 项委派，每项都要跑完整的正文生成，串行下来可能几十分钟不返回
    const chat = vi.fn().mockResolvedValue({
      content: JSON.stringify({ action: "finish", message: "开始批量起草。", changes: Array.from({ length: 6 }, (_, index) => ({
        type: "chapter.draft_next", summary: `起草 ${index + 1}`, title: `第 ${index + 3} 章`, instruction: "承接上一章",
      })) }),
      model: "test",
    });
    const chapter = vi.fn().mockImplementation((request: { summary: string; title: string }) => new Promise(resolve => {
      setTimeout(() => resolve({ type: "chapter.create", summary: request.summary, title: request.title, content: "正文。" }), 12);
    }));

    const result = await runProjectAgent({
      mode: "execute", instruction: "一口气把后面几章都写了", project, delegateBudgetMs: 5,
    }, { chat } as unknown as ModelApiClient, { ...delegates(), chapter });

    // 并发三路：开头三项在预算内同时开跑，跑完就超时，后面三项不再发请求
    expect(chapter).toHaveBeenCalledTimes(3);
    expect(result.changes).toHaveLength(3);
    const skipped = result.toolEvents.filter(event => event.tool === "chapter.draft_next" && event.status === "error");
    expect(skipped).toHaveLength(3);
    expect(skipped[0].message).toContain("未处理");
  });

  it("预算只拦委派，不影响本地就能落地的变更", async () => {
    const chat = vi.fn().mockResolvedValue({
      content: JSON.stringify({ action: "finish", message: "整理完成。", changes: [
        { type: "memory.document.upsert", summary: "整理时间线", kind: "时间线", title: "时间线", content: "第一天入城。" },
        { type: "chapter.delete", summary: "删除空稿", targetId: 2, title: "第二章 夜雨" },
      ] }),
      model: "test",
    });

    const result = await runProjectAgent({
      mode: "execute", instruction: "整理时间线并删掉空稿", project, delegateBudgetMs: 1,
    }, { chat } as unknown as ModelApiClient, delegates());

    expect(result.changes.map(change => change.type)).toEqual(["memory.document.upsert", "chapter.delete"]);
    expect(result.toolEvents.filter(event => event.status === "error")).toHaveLength(0);
  });

  it("批量修订的预算随章节数扩展，不再固定 20 分钟", async () => {
    // 回归：单章修订 5 分钟以上很常见，固定 20 分钟会在第 4~5 章撞满预算整轮断掉；
    // 10 章批量必须给足 10×20 = 200 分钟，而不是在 20 分钟处停手
    vi.useFakeTimers();
    try {
      const chat = vi.fn().mockResolvedValue({
        content: JSON.stringify({ action: "finish", message: "批量修订。", changes: Array.from({ length: 10 }, (_, index) => ({
          type: "chapter.revise", summary: `修订 ${index + 1}`, targetId: index + 1, instruction: "统一结尾",
        })) }),
        model: "test",
      });
      const chapterRevise = vi.fn().mockImplementation((request: { summary: string; targetId: number }) =>
        new Promise(resolve => setTimeout(() => resolve({ type: "chapter.update", summary: request.summary, targetId: request.targetId, content: "修订后正文。" }), 6 * 60_000)));

      const pending = runProjectAgent({
        mode: "execute", instruction: "把第 150 到 159 章的结尾都改掉", project,
      }, { chat } as unknown as ModelApiClient, { ...delegates(), chapterRevise });
      await vi.advanceTimersByTimeAsync(61 * 60_000);

      const result = await pending;
      expect(chapterRevise).toHaveBeenCalledTimes(10);
      expect(result.toolEvents.filter(event => event.status === "error")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("章节索引带序号，作者说的“第 150 章”能对上真实 id", () => {
    // 回归：索引只印 id=标题，而 id 是创建时的时间戳；作者说“第 150 章”时模型只能瞎猜
    const context = buildProjectAgentContext({
      mode: "discuss",
      instruction: "看一下第 150 章讲了什么",
      project: bigProject,
      contextWindowKTokens: 128,
    });

    expect(context.packet).toContain("#150｜1700000000150｜第 150 章");
    expect(context.packet).toContain("目录位置不等于标题章号");
  });

  it("长书索引从中间省略时给出翻页办法，而不是默默丢掉中段", () => {
    const context = buildProjectAgentContext({
      mode: "discuss",
      instruction: "整本书的结构梳理一下",
      project: bigProject,
      contextWindowKTokens: 128,
    });

    // 首尾保留、中段明确说明省了多少，并指向 list
    expect(context.packet).toContain("#1｜1700000000001");
    expect(context.packet).toContain("#180｜1700000000180");
    expect(context.packet).toMatch(/中间 \d+ 章未列出/u);
    expect(context.packet).toContain("\"action\":\"list\"");
  });

  it("一次 list 翻到序号区间，一次 open 批量取回多章正文", async () => {
    const turns = [
      JSON.stringify({ action: "list", kind: "章节", from: 150, to: 152 }),
      JSON.stringify({ action: "open", kind: "章节", id: ["1700000000150", "1700000000151", "1700000000152"] }),
      JSON.stringify({ action: "finish", message: "三章都读过了。", changes: [] }),
    ];
    // messages 数组会被原地追加，mock.calls 事后看到的都是最终态，只能在调用当时抓下末条
    const tails: string[] = [];
    const chat = vi.fn().mockImplementation((messages: Array<{ content: string }>) => {
      tails.push(messages.at(-1)?.content || "");
      return Promise.resolve({ content: turns.shift(), model: "test" });
    });

    const result = await runProjectAgent({
      mode: "discuss",
      instruction: "把第 150 到 152 章读一遍",
      project: bigProject,
    }, { chat } as unknown as ModelApiClient, delegates());

    expect(result.toolEvents.map(event => event.tool)).toEqual(["project.context", "project.list", "project.open"]);
    // list 只回序号、id 和字数，不回正文
    expect(tails[1]).toContain("#150｜id=1700000000150");
    expect(tails[1]).not.toContain("第 150 章的正文");
    // 一次 open 三章正文全部回灌，不需要三轮
    for (const ordinal of [150, 151, 152]) {
      expect(tails[2]).toContain(`第 ${ordinal} 章的正文`);
    }
  });

  it("批量补标题交给标题智能体，只产出一条 chapter.titles", async () => {
    const chat = vi.fn().mockResolvedValue({
      content: JSON.stringify({ action: "finish", message: "开始补标题。", changes: [
        { type: "chapter.retitle", summary: "批量补标题", targetIds: [], scope: "missing", instruction: "标题贴合本章事件" },
      ] }),
      model: "test",
    });
    const chapterTitles = vi.fn().mockResolvedValue({
      type: "chapter.titles",
      summary: "批量补标题（2 章：2 章从正文开头找回）",
      titles: [
        { targetId: 1, title: "第 1 章 入城", stripHeading: true },
        { targetId: 2, title: "第 2 章 夜雨", stripHeading: true },
      ],
    });

    const result = await runProjectAgent({
      mode: "execute", instruction: "把之前缺的章节标题都补上", project,
    }, { chat } as unknown as ModelApiClient, { ...delegates(), chapterTitles });

    expect(chapterTitles).toHaveBeenCalledWith(expect.objectContaining({ type: "chapter.retitle", scope: "missing", targetIds: [] }));
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].type).toBe("chapter.titles");
    expect(result.toolEvents.some(event => event.tool === "chapter.retitle" && event.message.includes("2 章标题"))).toBe(true);
  });

  it("拆章交给拆章智能体，只产出一条 chapter.parts，正文不进变更", async () => {
    const chat = vi.fn().mockResolvedValue({
      content: JSON.stringify({ action: "finish", message: "开始拆章。", changes: [
        { type: "chapter.split", summary: "把超长章拆开", targetIds: [1, 2], targetWords: 2400, instruction: "新段落标题贴合该段事件" },
      ] }),
      model: "test",
    });
    const chapterSplit = vi.fn().mockResolvedValue({
      type: "chapter.parts",
      summary: "把超长章拆开（2 章拆成 5 章）",
      splits: [
        { targetId: 1, paragraphCount: 12, breakAfter: [4, 8], titles: ["第 1 章 入城", "雨里的门牌", "空屋"] },
        { targetId: 2, paragraphCount: 9, breakAfter: [5], titles: ["第 2 章 夜雨", "窗外"] },
      ],
    });

    const result = await runProjectAgent({
      mode: "execute", instruction: "150 到 159 章有的六千字，拆成两千多字一章", project,
    }, { chat } as unknown as ModelApiClient, { ...delegates(), chapterSplit });

    expect(chapterSplit).toHaveBeenCalledWith(expect.objectContaining({ type: "chapter.split", targetIds: [1, 2], targetWords: 2400 }));
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].type).toBe("chapter.parts");
    // 拆章走的是段落序号，几万字正文一个字都不该出现在变更里
    expect(JSON.stringify(result.changes[0]).length).toBeLessThan(400);
    expect(result.toolEvents.some(event => event.tool === "chapter.split" && event.message.includes("5 章"))).toBe(true);
  });

  it("作者直接说拆成几章时，章数跟着意图一起交给拆章智能体", async () => {
    const chat = vi.fn().mockResolvedValue({
      content: JSON.stringify({ action: "finish", message: "拆成 6 章。", changes: [
        { type: "chapter.split", summary: "两章拆成 6 章", targetIds: [1, 2], targetWords: 2000, targetParts: 6 },
      ] }),
      model: "test",
    });
    const chapterSplit = vi.fn().mockResolvedValue({
      type: "chapter.parts",
      summary: "两章拆成 6 章（2 章拆成 6 章）",
      splits: [
        { targetId: 1, paragraphCount: 12, breakAfter: [6], titles: ["第 1 章 入城", "雨里的门牌"] },
        { targetId: 2, paragraphCount: 16, breakAfter: [4, 8, 12], titles: ["第 2 章 夜雨", "窗外", "灯下", "天亮"] },
      ],
    });

    const result = await runProjectAgent({
      mode: "execute", instruction: "150、151 两章字数到了 6000，拆成 6 章，每章 2000 字", project,
    }, { chat } as unknown as ModelApiClient, { ...delegates(), chapterSplit });

    expect(chapterSplit).toHaveBeenCalledWith(expect.objectContaining({ targetParts: 6, targetWords: 2000 }));
    expect(result.changes[0].type).toBe("chapter.parts");
  });
  it("委派并发执行但产出顺序不变，一项失败不拖垮其余", async () => {
    const chat = vi.fn().mockResolvedValue({
      content: JSON.stringify({ action: "finish", message: "批量润色。", changes: Array.from({ length: 6 }, (_, index) => ({
        type: "chapter.revise", summary: `润色 ${index + 1}`, targetId: index + 1, instruction: "只改文字", mode: "polish",
      })) }),
      model: "test",
    });
    let running = 0;
    let peak = 0;
    const chapterRevise = vi.fn().mockImplementation(async (request: { summary: string; targetId: number }) => {
      running += 1;
      peak = Math.max(peak, running);
      // 完成顺序与输入顺序刻意错开：后面的先回来
      await new Promise(resolve => setTimeout(resolve, 30 - request.targetId * 4));
      running -= 1;
      if (request.targetId === 3) throw new Error("无法连接 API 中转服务，已自动重试 3 次：fetch failed");
      return { type: "chapter.update", summary: request.summary, targetId: request.targetId, content: `第 ${request.targetId} 章润色后正文。` };
    });

    const result = await runProjectAgent({
      mode: "execute", instruction: "把这几章都润一遍", project,
    }, { chat } as unknown as ModelApiClient, { ...delegates(), chapterRevise });

    expect(peak).toBeGreaterThan(1);
    expect(chapterRevise).toHaveBeenCalledTimes(6);
    // 一项失败只掉这一项，其余五项仍按模型给的顺序排列
    expect(result.changes.map(change => "targetId" in change ? change.targetId : 0)).toEqual([1, 2, 4, 5, 6]);
    expect(result.toolEvents.filter(event => event.status === "error")).toHaveLength(1);
  });

  it("委派失败要说清是哪一章、什么原因、下一步怎么办", async () => {
    const chat = vi.fn().mockResolvedValue({
      content: JSON.stringify({ action: "finish", message: "批量润色。", changes: [
        { type: "chapter.revise", summary: "润色第二章", targetId: 2, instruction: "只改文字", mode: "polish" },
      ] }),
      model: "test",
    });
    const chapterRevise = vi.fn().mockRejectedValue(new Error("请求过于频繁（429）"));

    const result = await runProjectAgent({
      mode: "execute", instruction: "润色第二章", project,
    }, { chat } as unknown as ModelApiClient, { ...delegates(), chapterRevise });

    const failure = result.toolEvents.find(event => event.tool === "chapter.revise" && event.status === "error");
    expect(failure?.message).toContain("润色第二章｜目标 2");
    expect(failure?.message).toContain("429");
    // 限流要给出能照着做的下一步，而不是只说“API 有问题”
    expect(failure?.message).toContain("等一两分钟再说一次继续");
  });

  it("委派阶段持续上报进度，前端进度条不会整段停住", async () => {
    const chat = vi.fn().mockResolvedValue({
      content: JSON.stringify({ action: "finish", message: "批量润色。", changes: [
        { type: "chapter.revise", summary: "润色第一章", targetId: 1, instruction: "只改文字", mode: "polish" },
        { type: "chapter.revise", summary: "润色第二章", targetId: 2, instruction: "只改文字", mode: "polish" },
      ] }),
      model: "test",
    });
    const chapterRevise = vi.fn().mockImplementation((request: { summary: string; targetId: number }) =>
      Promise.resolve({ type: "chapter.update", summary: request.summary, targetId: request.targetId, content: "润色后正文。" }));
    const seen: string[] = [];

    await runProjectAgent({
      mode: "execute",
      instruction: "润色前两章",
      project,
      onDelegate: event => seen.push(`${event.status}:${event.done}/${event.total}`),
    }, { chat } as unknown as ModelApiClient, { ...delegates(), chapterRevise });

    expect(seen.filter(item => item.startsWith("start"))).toHaveLength(2);
    expect(seen.at(-1)).toBe("complete:2/2");
  });
});

  it("长大纲回复超过 message 上限时截断保留而不是整轮拒绝", async () => {
    // 线上真实事故：作者让项目 Agent 写大纲，模型把整份大纲写进 message，
    // 超过 5000 字后 zod 整轮拒绝，兜底话术还在教"一次只处理三五章"，驴唇不对马嘴
    const outline = Array.from({ length: 300 }, (_, i) => `第${i + 1}节：林舟在城南追查旧书档案，线索指向码头仓库，他决定夜访。`).join("\n");
    const client = clientWith(JSON.stringify({ action: "finish", message: outline, changes: [] }));

    const result = await runProjectAgent(
      { mode: "discuss", instruction: "你把大纲写一下吧", project, contextWindowKTokens: 64 },
      client as unknown as ModelApiClient,
      delegates(),
    );

    expect(result.message).toContain("林舟在城南追查旧书档案");
    expect(result.message).toContain("后文过长已截断");
    expect(result.message.length).toBeLessThanOrEqual(5000);
  });

  it("回包被 max_tokens 截断掉末尾括号时本地补齐，不烧修复轮", async () => {
    const finishJson = `{"action":"finish","message":"林舟已确认旧书来自码头仓库，下一步核对借阅记录。","changes":[{"type":"project.update","summary":"更新设定","patch":{"synopsis":"林舟追查码头仓库的旧书来源。"}}]`;
    const client = clientWith(finishJson);

    const result = await runProjectAgent(
      { mode: "execute", instruction: "整理当前线索并更新简介", project, contextWindowKTokens: 64 },
      client as unknown as ModelApiClient,
      delegates(),
    );

    expect(result.message).toContain("码头仓库");
    expect(result.changes).toHaveLength(1);
    // 本地抢救成功，不应再调第二次模型修格式
    expect((client as unknown as { chat: ReturnType<typeof vi.fn> }).chat).toHaveBeenCalledTimes(1);
  });

  it("散文包着 JSON 的回包能剥出动作", async () => {
    const client = clientWith(`好的，以下是整理后的动作：\n\n{"action":"finish","message":"林舟下一步前往旧仓库核对档案。","changes":[]}\n\n希望对你有帮助。`);

    const result = await runProjectAgent(
      { mode: "discuss", instruction: "下一步林舟该做什么", project, contextWindowKTokens: 64 },
      client as unknown as ModelApiClient,
      delegates(),
    );

    expect(result.message).toContain("旧仓库核对档案");
  });

  it("两轮都解析不出动作时，够长的散文回复直接当内容收尾", async () => {
    // 模型直接把大纲写成散文，连 JSON 都没包：丢掉的话作者就白等了
    const prose = `关于这本书的主线：${"林舟在城南整理旧书档案，逐步揭开码头仓库背后三十年前的旧案。".repeat(12)}`;
    const chat = vi.fn()
      .mockResolvedValueOnce({ content: prose, model: "test" })
      .mockResolvedValue({ content: "还是解析不了", model: "test" });
    const client = { chat } as unknown as ModelApiClient;

    const result = await runProjectAgent(
      { mode: "discuss", instruction: "这书到底讲的是什么", project, contextWindowKTokens: 64 },
      client,
      delegates(),
    );

    expect(result.message).toContain("码头仓库背后");
    expect(result.changes).toEqual([]);
  });

  it("能识别并过滤模型修复轮中对提示词本身的元抱怨", () => {
    expect(isFormatRepairMetaComplaint("你这条消息里只有一句「请把以下内容整理成约定的 JSON 动作，只调整格式：」，后面没有跟着任何待整理的内容——我这边没有收到需要转换的原文。")).toBe(true);
    expect(isFormatRepairMetaComplaint("你这条消息里只有要求，没有跟着要整理的内容——“以下内容”是空的，我这边看不到任何需要转换的文本。")).toBe(true);
    expect(isFormatRepairMetaComplaint("这是正常回复：192章与194章之间确实缺少了193章的剧情过渡。")).toBe(false);
  });

  it("当模型返回空或{}时不会发送无上下文的只调整格式修复，而是带完整上下文收尾", async () => {
    const chat = vi.fn()
      // 第一轮 list
      .mockResolvedValueOnce({ content: JSON.stringify({ action: "list", from: 1, to: 2 }), model: "test" })
      // 第二轮返回空 JSON {}
      .mockResolvedValueOnce({ content: "{}", model: "test" })
      // 第三轮：带上下文重试，直接回答
      .mockResolvedValueOnce({ content: JSON.stringify({ action: "finish", message: "经比对，两章剧情连贯，仅序号跳号。", changes: [] }), model: "test" });

    const result = await runProjectAgent(
      { mode: "discuss", instruction: "192和194连贯吗", project },
      { chat } as unknown as ModelApiClient,
      delegates(),
    );

    // 严禁发出带有空待整理内容的“请把以下内容整理成约定的 JSON 动作”
    for (const call of chat.mock.calls) {
      const messages = call[0] as Array<{ role: string; content: string }>;
      const userMessage = messages.find(msg => msg.content.includes("请把以下内容整理成约定的 JSON 动作"));
      if (userMessage) {
        expect(userMessage.content).not.toMatch(/请把以下内容整理成约定的 JSON 动作，只调整格式：\s*$/);
      }
    }

    expect(result.message).toContain("经比对，两章剧情连贯");
  });

  it("只解析动作明确的 DSML，残缺前缀不猜测工具意图", () => {
    // 完整格式
    const fullDsml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="open">
<｜｜DSML｜｜ parameter name="id">["1789712569700", "1789712877740", "1789713515724"]</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`;
    const parsedFull = extractDsmlTurn(fullDsml);
    expect(parsedFull).toEqual({
      action: "open",
      kind: undefined,
      id: ["1789712569700", "1789712877740", "1789713515724"],
    });

    // 线上截断格式：网关或传输导致前置标签丢失，只剩数组和尾标签
    const truncatedDsml = `["1789712569700", "1789712877740", "1789713515724"]</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`;
    const parsedTruncated = extractDsmlTurn(truncatedDsml);
    expect(parsedTruncated).toBeNull();
  });

  it("判定 DSML 标记为工具调用而非作者可见的散文回复", () => {
    expect(isDsmlOrToolCall('["1789712569700"]</｜｜DSML｜｜ parameter>')).toBe(true);
    expect(isDsmlOrToolCall('<｜DSML｜invoke name="open">')).toBe(true);
    expect(isDsmlOrToolCall('这是正常的散文回复，两章情节完全连贯。')).toBe(false);
  });

  it("当模型返回 DSML 格式的 open 指令时，能正常驱动工具打开正文而非泄露标签", async () => {
    const dsmlResponse = `<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="open"><｜｜DSML｜｜ parameter name="id">[1,2]</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`;

    const chat = vi.fn()
      // 第一轮模型输出 DSML 请求打开第 1、2 章
      .mockResolvedValueOnce({ content: dsmlResponse, model: "test" })
      // 第二轮正文载入后，给出最终答复
      .mockResolvedValueOnce({ content: JSON.stringify({ action: "finish", message: "正文已读取：两章剧情完全连贯。", changes: [] }), model: "test" });

    const result = await runProjectAgent(
      { mode: "discuss", instruction: "看两章正文", project },
      { chat } as unknown as ModelApiClient,
      delegates(),
    );

    // 严禁将 DSML 标记直接当成 message 输出给作者
    expect(result.message).not.toContain("DSML");
    expect(result.message).toContain("两章剧情完全连贯");
    // 工具事件应记录实际执行了 project.open
    expect(result.toolEvents.some(event => event.tool === "project.open")).toBe(true);
  });




describe("project agent context regressions", () => {
  it("长历史和多轮读取不会丢掉当前问题，讨论模式不带写入工具说明", async () => {
    const requests: Array<Array<{ role: string; content: string }>> = [];
    const chat = vi.fn(async (messages: Array<{ role: string; content: string }>) => {
      requests.push(messages);
      return { model: "test", content: JSON.stringify(requests.length < 5
        ? { action: "open", id: [1, 2] }
        : { action: "finish", message: "已核对。", changes: [] }) };
    });
    await runProjectAgent({
      mode: "discuss", instruction: "本轮唯一问题：192后面194是否缺剧情",
      history: Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `旧消息${i}` + "旧".repeat(1400) })),
      project: { ...project, chapters: project.chapters.map(chapter => ({ ...chapter, content: "中".repeat(4000) })) },
    }, { chat } as unknown as ModelApiClient, delegates());
    for (const messages of requests) {
      expect(messages.some(message => message.content.includes("本轮唯一问题：192后面194是否缺剧情"))).toBe(true);
      expect(messages[0].content).not.toContain("chapter.delete");
      expect(Buffer.byteLength(messages.map(message => message.content).join(""))).toBeLessThanOrEqual(40_000);
    }
    expect(requests[1].at(-1)?.content).toContain("</正文>");
  });

  it("连续分段读取保留长章的中间内容及 Unicode 字符", async () => {
    const content = "开头\r\n" + "雨🌧".repeat(1800) + "中间关键线索" + "夜".repeat(3000) + "结尾";
    const pages: string[] = [];
    const chat = vi.fn(async (messages: Array<{ content: string }>) => {
      const tool = messages.at(-1)?.content || "";
      const page = /<正文>\n([\s\S]*)\n<\/正文>/u.exec(tool);
      if (page) pages.push(page[1]);
      const next = /继续读取：([^\n]+)/u.exec(tool);
      return { model: "test", content: next ? next[1] : JSON.stringify(pages.length
        ? { action: "finish", message: "正文已读完。", changes: [] }
        : { action: "open", id: 1 }) };
    });
    await runProjectAgent({ mode: "discuss", instruction: "检查全文是否有缺失", project: { ...project, chapters: [{ id: 1, title: "第192章", content }] } }, { chat } as unknown as ModelApiClient, delegates());
    expect(pages.length).toBeGreaterThan(2);
    expect(pages.join("")).toBe(content);
  });

  it("跳号目录保留标题与位置，按标题或真实ID读取同一章", async () => {
    const replies = [
      { action: "list", from: 1, count: 2 },
      { action: "open", id: [101, "第194章 夜雨"] },
      { action: "finish", message: "两章已读取。", changes: [] },
    ];
    const chat = vi.fn().mockImplementation(async () => ({ content: JSON.stringify(replies.shift()), model: "test" }));
    await runProjectAgent({ mode: "discuss", instruction: "192章之后为什么是194章", project: { ...project, chapters: [
      { id: 101, title: "第192章 入城", content: "192正文" },
      { id: 102, title: "第194章 夜雨", content: "194正文" },
    ] } }, { chat } as unknown as ModelApiClient, delegates());
    expect(JSON.stringify(chat.mock.calls[1])).toContain("#2｜id=102｜标题：第194章 夜雨");
    expect(JSON.stringify(chat.mock.calls[2])).toContain("194正文");
  });

  it("残缺工具标记恢复失败不泄露，也不猜动作执行", async () => {
    const broken = '["1","2"]</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke>';
    const chat = vi.fn().mockResolvedValue({ content: broken, model: "test" });
    const result = await runProjectAgent({ mode: "execute", instruction: "检查192和194", project }, { chat } as unknown as ModelApiClient, delegates());
    expect(chat).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(chat.mock.calls[1])).toContain("检查192和194");
    expect(result.message).toContain("工具指令解析失败");
    expect(result.message).not.toContain("DSML");
    expect(result.toolEvents.some(event => event.tool === "project.open")).toBe(false);
    expect(result.changes).toEqual([]);
  });

  it("finish 包裹工具标记也不能漏到作者回复", async () => {
    const client = clientWith(JSON.stringify({ action: "finish", message: '<｜｜DSML｜｜ invoke name="open">', changes: [] }));
    const result = await runProjectAgent({ mode: "discuss", instruction: "分析正文", project }, client, delegates());
    expect(result.message).not.toContain("DSML");
    expect(result.message).toContain("解析失败");
  });
});
