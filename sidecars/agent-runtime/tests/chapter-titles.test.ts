import { describe, expect, it, vi } from "vitest";
import { mapWithConcurrency } from "../src/application/concurrency.js";
import { detectChapterNumberStyle, formatChineseNumber, generateChapterTitle, generateChapterTitles, isPlaceholderChapterTitle } from "../src/application/chapter-titles.js";
import { ModelApiClient } from "../src/models/model-api.js";

const clientReturning = (bodies: string[]) => {
  const chat = vi.fn().mockImplementation(() => Promise.resolve({ content: bodies.shift() ?? "{}", model: "test" }));
  return { client: { chat } as unknown as ModelApiClient, chat };
};

describe("mapWithConcurrency", () => {
  it("按输入顺序返回结果，与完成顺序无关", async () => {
    const delays = [30, 5, 20, 1];
    const output = await mapWithConcurrency(delays, 2, async (delay, index) =>
      new Promise<string>(resolve => setTimeout(() => resolve(`#${index}:${delay}`), delay)));

    expect(output).toEqual(["#0:30", "#1:5", "#2:20", "#3:1"]);
  });

  it("同时在跑的任务数不超过上限", async () => {
    let running = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 9 }, (_, index) => index), 3, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise(resolve => setTimeout(resolve, 5));
      running -= 1;
      return true;
    });

    expect(peak).toBe(3);
  });

  it("空输入不启动任何 worker", async () => {
    const run = vi.fn();
    expect(await mapWithConcurrency([], 4, run)).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("isPlaceholderChapterTitle", () => {
  it("认得出创建时的编号占位和空标题", () => {
    for (const title of ["第 12 章", "第十二章", "新章节", "未命名章节", "无标题", "  ", ""]) {
      expect(isPlaceholderChapterTitle(title)).toBe(true);
    }
  });

  it("作者已经起过的名字不算占位", () => {
    for (const title of ["第 12 章 夜雨敲窗", "夜雨敲窗", "第十二章 旧仓库的账本"]) {
      expect(isPlaceholderChapterTitle(title)).toBe(false);
    }
  });
});

describe("generateChapterTitles", () => {
  it("正文开头写着标题的章节零调用捡回来", async () => {
    const { client, chat } = clientReturning([]);

    const result = await generateChapterTitles(client, [
      { targetId: 150, currentTitle: "第 150 章", content: "## 第一百五十章 旧仓库的账本\n\n林舟翻开账本。" },
      { targetId: 151, currentTitle: "第 151 章", content: "### 夜雨敲窗\n\n夜雨又落下来。" },
    ]);

    expect(chat).not.toHaveBeenCalled();
    expect(result.recovered).toBe(2);
    expect(result.named).toBe(0);
    // 章号一律用应用自己的编号，模型写错的“第一百五十章”前缀被剥掉
    expect(result.entries).toEqual([
      { targetId: 150, title: "第 150 章 旧仓库的账本", stripHeading: true },
      { targetId: 151, title: "第 151 章 夜雨敲窗", stripHeading: true },
    ]);
  });

  it("正文里没有标题时才分批交给模型命名", async () => {
    const { client, chat } = clientReturning([
      JSON.stringify({ titles: [{ index: 150, title: "旧仓库的账本" }, { index: 151, title: "夜雨里的口供" }] }),
    ]);

    const result = await generateChapterTitles(client, [
      { targetId: 150, currentTitle: "第 150 章", content: "林舟翻开账本，纸页上只有一行数字。" },
      { targetId: 151, currentTitle: "新章节", content: "夜雨落在窗框上，他把口供压在灯下。" },
    ], { projectTitle: "城南夜雨", instruction: "标题贴合本章事件" });

    expect(chat).toHaveBeenCalledOnce();
    const [messages] = chat.mock.calls[0] as [Array<{ role: string; content: string }>];
    expect(messages[1].content).toContain("城南夜雨");
    expect(messages[1].content).toContain("标题贴合本章事件");
    expect(messages[1].content).toContain("index=150");
    expect(result.recovered).toBe(0);
    expect(result.named).toBe(2);
    // 有章号的沿用章号，没章号的直接用模型给的名字
    expect(result.entries).toEqual([
      { targetId: 150, title: "第 150 章 旧仓库的账本" },
      { targetId: 151, title: "夜雨里的口供" },
    ]);
    expect(result.failures).toEqual([]);
  });

  it("一批失败只丢这一批，其余章节照常返回", async () => {
    const chat = vi.fn()
      .mockRejectedValueOnce(new Error("无法连接 API 中转服务，已自动重试 3 次"))
      .mockRejectedValue(new Error("无法连接 API 中转服务，已自动重试 3 次"))
      .mockResolvedValueOnce({ content: JSON.stringify({ titles: [{ index: 21, title: "码头的第二封信" }] }), model: "test" });
    const client = { chat } as unknown as ModelApiClient;
    const candidates = Array.from({ length: 21 }, (_, index) => ({
      targetId: index + 1,
      currentTitle: `第 ${index + 1} 章`,
      content: `第 ${index + 1} 章的正文内容，林舟继续核对档案。`,
    }));

    const result = await generateChapterTitles(client, candidates);

    // 20 章一批：第一批整批失败且兑底也失败（网络不通），第二批的一章正常产出；
    // 兑底重试过的章仍排在失败名单里，作者能照着章号重试
    expect(result.entries).toEqual([{ targetId: 21, title: "第 21 章 码头的第二封信" }]);
    expect(result.failures.some(item => item.includes("无法连接"))).toBe(true);
    expect(result.failures.some(item => item.includes("等 20 章") && item.includes("没给出可用标题"))).toBe(true);
  });

  it("模型漏掉的章节如实报出来，不假装全部完成", async () => {
    const { client } = clientReturning([JSON.stringify({ titles: [{ index: 1, title: "入城" }] }), "这一章可以叫夜雨敲窗"]);

    const result = await generateChapterTitles(client, [
      { targetId: 1, currentTitle: "第 1 章", content: "林舟抵达城南。" },
      { targetId: 2, currentTitle: "第 2 章", content: "夜雨中他确认旧书来自码头。" },
    ]);

    expect(result.entries).toHaveLength(1);
    expect(result.failures[0]).toContain("第 2 章");
    expect(result.failures[0]).toContain("模型没给出可用标题");
  });

  it("没有正文的章节不去调模型，直接报为失败", async () => {
    const { client, chat } = clientReturning([]);

    const result = await generateChapterTitles(client, [{ targetId: 7, currentTitle: "第 7 章", content: "   " }]);

    expect(chat).not.toHaveBeenCalled();
    expect(result.entries).toEqual([]);
    expect(result.failures[0]).toContain("章节 7 没有正文");
  });

  it("进度回调随批次推进，前端进度条不会整段停住", async () => {
    const { client } = clientReturning([JSON.stringify({ titles: [{ id: 2, title: "夜雨" }] })]);
    const seen: Array<[number, number]> = [];

    await generateChapterTitles(client, [
      { targetId: 1, currentTitle: "第 1 章", content: "## 第一章 入城\n\n林舟抵达城南。" },
      { targetId: 2, currentTitle: "第 2 章", content: "夜雨中他确认旧书来自码头。" },
    ], { onProgress: (done, total) => seen.push([done, total]) });

    expect(seen).toEqual([[1, 2], [2, 2]]);
  });
});

describe("generateChapterTitle", () => {
  it("单章兵底命名去掉书名号和句末标点", async () => {
    const { client, chat } = clientReturning([JSON.stringify({ title: "《夜雨敲窗》。" })]);

    const title = await generateChapterTitle(client, "夜雨落在窗框上，他把口供压在灯下。", {
      projectTitle: "城南夜雨",
      instruction: "承接上一章的对峙",
    });

    expect(title).toBe("夜雨敲窗");
    const [messages] = chat.mock.calls[0] as [Array<{ role: string; content: string }>];
    expect(messages[1].content).toContain("城南夜雨");
    expect(messages[1].content).toContain("承接上一章的对峙");
  });

  it("模型报错或返回不可解析内容时返回空串，不拖累正文", async () => {
    const chat = vi.fn().mockRejectedValue(new Error("无法连接 API 中转服务"));
    expect(await generateChapterTitle({ chat } as unknown as ModelApiClient, "正文内容")).toBe("");

    const { client } = clientReturning(["这一章可以叫夜雨敲窗"]);
    expect(await generateChapterTitle(client, "正文内容")).toBe("");
  });

  it("正文为空时不调模型", async () => {
    const { client, chat } = clientReturning([]);
    expect(await generateChapterTitle(client, "   ")).toBe("");
    expect(chat).not.toHaveBeenCalled();
  });
});

  it("模型把章号当 id 返回时照样配上章节（线上真实事故：9/10/11 章全被丢）", async () => {
    const { client } = clientReturning([
      // 三个 targetId 是十几位时间戳，模型回的 id 却是章号 9/10/11——旧代码按真实 id 硬配，整批全丢
      JSON.stringify({ titles: [{ id: 9, title: "旧仓库的账本" }, { id: 10, title: "夜雨里的口供" }, { id: 11, title: "码头的第二封信" }] }),
    ]);

    const result = await generateChapterTitles(client, [
      { targetId: 1756880000001, currentTitle: "第 9 章", content: "林舟翻开账本，纸页上只有一行数字。" },
      { targetId: 1756880000002, currentTitle: "第 10 章", content: "夜雨落在窗框上，他把口供压在灯下。" },
      { targetId: 1756880000003, currentTitle: "第 11 章", content: "码头的第二封信到了，他拆开看了一遍。" },
    ]);

    expect(result.failures).toEqual([]);
    expect(result.entries).toEqual([
      { targetId: 1756880000001, title: "第 9 章 旧仓库的账本" },
      { targetId: 1756880000002, title: "第 10 章 夜雨里的口供" },
      { targetId: 1756880000003, title: "第 11 章 码头的第二封信" },
    ]);
  });

  it("模型回包形状不标准时逐章兑底补命名", async () => {
    const { client } = clientReturning([
      // 批量回包不是约定的 {titles:[...]}，一行都没配上
      JSON.stringify({ results: "标题我起好了" }),
      // 逐章兑底走单章信封，一次一章
      JSON.stringify({ title: "夜雨敲窗" }),
      JSON.stringify({ title: "旧仓库的账本" }),
    ]);

    const result = await generateChapterTitles(client, [
      { targetId: 1756880000001, currentTitle: "第 9 章", content: "夜雨落在窗框上，他把口供压在灯下。" },
      { targetId: 1756880000002, currentTitle: "第 10 章", content: "林舟翻开账本，纸页上只有一行数字。" },
    ]);

    expect(result.failures).toEqual([]);
    expect(result.entries).toEqual([
      { targetId: 1756880000001, title: "第 9 章 夜雨敲窗" },
      { targetId: 1756880000002, title: "第 10 章 旧仓库的账本" },
    ]);
  });

  it("模型把映射当回包（键是章号）时也能配上", async () => {
    const { client } = clientReturning([
      JSON.stringify({ "9": "夜雨敲窗", "10": "旧仓库的账本" }),
    ]);

    const result = await generateChapterTitles(client, [
      { targetId: 1756880000001, currentTitle: "第 9 章", content: "夜雨落在窗框上，他把口供压在灯下。" },
      { targetId: 1756880000002, currentTitle: "第 10 章", content: "林舟翻开账本，纸页上只有一行数字。" },
    ]);

    expect(result.failures).toEqual([]);
    expect(result.entries).toEqual([
      { targetId: 1756880000001, title: "第 9 章 夜雨敲窗" },
      { targetId: 1756880000002, title: "第 10 章 旧仓库的账本" },
    ]);
  });

  it("中文数字章号（如第 十三 章）无论模型回阿拉伯数字还是中文都能准确匹配", async () => {
    const { client } = clientReturning([
      JSON.stringify({
        titles: [
          { index: 13, title: "遗迹风云" },
          { index: "十四", title: "夜色突袭" },
        ],
      }),
    ]);

    const result = await generateChapterTitles(client, [
      { targetId: 20001, currentTitle: "第 十三 章", content: "狂风卷着黄沙吹打在破旧的石碑上。" },
      { targetId: 20002, currentTitle: "第 十四 章", content: "暗夜之中刀剑交错。" },
    ]);

    expect(result.failures).toEqual([]);
    expect(result.entries).toEqual([
      { targetId: 20001, title: "第 十三 章 遗迹风云" },
      { targetId: 20002, title: "第 十四 章 夜色突袭" },
    ]);
  });

  it("支持对已有标题统一重新定名", async () => {
    const { client } = clientReturning([
      JSON.stringify({
        titles: [
          { index: 15, title: "青云试炼" },
        ],
      }),
    ]);

    const result = await generateChapterTitles(client, [
      { targetId: 20003, currentTitle: "第 15 章 旧的临时标题", content: "少年踏上青云宗的天梯。" },
    ]);

    expect(result.failures).toEqual([]);
    expect(result.entries).toEqual([
      { targetId: 20003, title: "第 15 章 青云试炼" },
    ]);
  });

  it("模型回的名字和当前标题一样时算未变，不报成没给出可用标题", async () => {
    const { client, chat } = clientReturning([
      JSON.stringify({ titles: [{ index: 15, title: "青云试炼" }] }),
    ]);

    const result = await generateChapterTitles(client, [
      { targetId: 20003, currentTitle: "第 15 章 青云试炼", content: "少年踏上青云宗的天梯。" },
    ]);

    expect(chat).toHaveBeenCalledTimes(1);
    expect(result.entries).toEqual([]);
    expect(result.unchanged).toBe(1);
    expect(result.failures).toEqual([]);
  });

  it("重排后的章按目录位置配对，不被标题里的旧章号带偏", async () => {
    // 线上事故：#151~#171 里夹着 12 章新章，旧章号和目录位置对不上，模型按 index 回，旧逻辑只认旧章号整批配不上
    const { client } = clientReturning([
      JSON.stringify({ titles: [
        { index: 151, title: "试捞湿纸见裂" },
        { index: 152, title: "缺页归档待补" },
        { index: 153, title: "婚期喜帖入匣" },
      ] }),
    ]);
    const style = detectChapterNumberStyle(["第一百四十九章 修复通论定纲", "第一百五十章 夜校开讲"]);

    const result = await generateChapterTitles(client, [
      { targetId: 1, ordinal: 151, currentTitle: "第一百五十二章 试捞湿纸一张见裂", content: "湿纸出水。" },
      { targetId: 2, ordinal: 152, currentTitle: "第 151 章", content: "归档缺页。" },
      { targetId: 3, ordinal: 153, currentTitle: "择定婚期喜帖入匣", content: "喜帖入匣。" },
    ], { renumber: style });

    expect(result.failures).toEqual([]);
    expect(result.entries).toEqual([
      { targetId: 1, title: "第一百五十一章 试捞湿纸见裂" },
      { targetId: 2, title: "第一百五十二章 缺页归档待补" },
      { targetId: 3, title: "第一百五十三章 婚期喜帖入匣" },
    ]);
  });

  it("重编章号时模型没回名字的章沿用原名，只换章号", async () => {
    const { client, chat } = clientReturning([JSON.stringify({ titles: [] }), JSON.stringify({ title: "" })]);
    const style = detectChapterNumberStyle(["第一百五十章 夜校开讲"]);

    const result = await generateChapterTitles(client, [
      { targetId: 7, ordinal: 171, currentTitle: "第一百六十一章 受聘主编筹备教材", content: "受聘主编。" },
    ], { renumber: style });

    // 批量与单章都没拿到名字：仍然报失败而不是静默沿用，作者要的是可区分的新名字
    expect(chat).toHaveBeenCalledTimes(2);
    expect(result.entries).toEqual([]);
    expect(result.failures[0]).toContain("第 171 章");
    expect(result.failures[0]).toContain("批量回包");
  });

  it("批量没配上但单章重试拿到名字时按目录位置重编", async () => {
    const { client } = clientReturning([JSON.stringify({ titles: [] }), JSON.stringify({ title: "《受聘主编》。" })]);
    const style = detectChapterNumberStyle(["第一百五十章 夜校开讲"]);

    const result = await generateChapterTitles(client, [
      { targetId: 7, ordinal: 171, currentTitle: "第一百六十一章 受聘主编筹备教材", content: "受聘主编。" },
    ], { renumber: style });

    expect(result.entries).toEqual([{ targetId: 7, title: "第一百七十一章 受聘主编" }]);
  });

describe("章号格式", () => {
  it("中文数字按口语习惯写", () => {
    expect(formatChineseNumber(10)).toBe("十");
    expect(formatChineseNumber(15)).toBe("十五");
    expect(formatChineseNumber(110)).toBe("一百一十");
    expect(formatChineseNumber(151)).toBe("一百五十一");
    expect(formatChineseNumber(205)).toBe("二百零五");
    expect(formatChineseNumber(1005)).toBe("一千零五");
  });

  it("从前文标题学格式，取最近一条能解析的", () => {
    expect(detectChapterNumberStyle(["第 12 章 夜雨", "第一百五十章 夜校开讲"])).toEqual({ digits: "chinese", open: "", close: "", separator: " " });
    expect(detectChapterNumberStyle(["第一百五十章 夜校开讲", "第 151 章：口供"])).toEqual({ digits: "arabic", open: " ", close: " ", separator: "：" });
    expect(detectChapterNumberStyle(["随便起的名字"])).toEqual({ digits: "arabic", open: " ", close: " ", separator: " " });
  });
});
