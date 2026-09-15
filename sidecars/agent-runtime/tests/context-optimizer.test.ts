import { describe, expect, it } from "vitest";
import { buildStoryLedger, byteLength, compactKnowledgeGraph, compactMasterOutline, compactText, contextBudgetBytes, LruCache, normalizePromptWhitespace, prepareChapterInput, stableHash, tailText } from "../src/context/context-optimizer.js";

describe("context optimizer", () => {
  it("keeps both ends of oversized chapter material", () => {
    const source = `开场事实${"中".repeat(200)}章末钩子`;
    const result = compactText(source, 120);
    expect(byteLength(result)).toBeLessThanOrEqual(120);
    expect(result).toContain("开场事实");
    expect(result).toContain("章末钩子");
  });

  it("normalizes token-wasting document whitespace without changing Markdown structure", () => {
    const source = "  # 标题  \r\n\r\n\r\n段落   之间   空格\n\n```txt\n  保留   代码缩进  \n```\n";
    expect(normalizePromptWhitespace(source)).toBe("# 标题\n\n段落 之间 空格\n\n```txt\n  保留   代码缩进\n```");
    expect(compactText(source, 500)).not.toContain("\r");
  });

  it("packs only a relevant graph neighborhood", () => {
    const result = compactKnowledgeGraph({
      nodes: [
        { id: "a", label: "沈砚", type: "entity" },
        { id: "b", label: "旧电台", type: "entity" },
        { id: "c", label: "无关地点", type: "entity" },
      ],
      edges: [{ source: "a", target: "b", label: "发现" }, { source: "b", target: "c", label: "远处" }],
    }, "沈砚在旧电台前停下", 800);
    expect(result).toContain("沈砚");
    expect(result).toContain("旧电台");
    expect(byteLength(result)).toBeLessThanOrEqual(800);
  });

  it("puts stronger graph relationships ahead of weaker ones in the chapter context", () => {
    const result = compactKnowledgeGraph({
      nodes: [
        { id: "a", label: "沈砚", type: "entity" },
        { id: "b", label: "锁匙", type: "card" },
        { id: "c", label: "旧传闻", type: "entity" },
      ],
      edges: [
        { source: "a", target: "c", label: "听说", weight: 0.2 },
        { source: "a", target: "b", label: "持有", weight: 0.95 },
      ],
    }, "沈砚准备使用锁匙", 800);
    expect(result).toContain("权重 0.95");
    expect(result.indexOf("持有")).toBeLessThan(result.indexOf("听说"));
  });

  it("uses deterministic hashes and reports source pruning", () => {
    const input = {
      instruction: "继续写沈砚发现旧电台",
      outlines: [{ id: 1, kind: "细纲", title: "第一章", content: "沈砚回到海边老家" }],
      cards: [{ title: "沈砚", type: "角色卡", content: "性格敏感" }],
      knowledgeGraph: { nodes: [{ id: "a", label: "沈砚", type: "entity" }], edges: [] },
      skills: [{ name: "story-long-write", category: "write", description: "续写", tags: ["章节"], content: "保持视角" }],
      contextWindowKTokens: 16,
    };
    const first = prepareChapterInput(input);
    const second = prepareChapterInput({ ...input, outlines: [...input.outlines] });
    expect(stableHash(input)).toBe(stableHash({ ...input }));
    expect(first.report.sourceBytes).toBeGreaterThanOrEqual(first.report.packedBytes);
    expect(first.outline).toContain("海边老家");
    expect(second.report.sections).toEqual(first.report.sections);
  });

  it("evicts the least recently used entry", () => {
    const cache = new LruCache<number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
  });
});

describe("story-level context", () => {
  it("tailText 只保留章尾，不再头尾拼接", () => {
    const source = `开场事实${"中".repeat(300)}\n\n章末钩子在这里`;
    const result = tailText(source, 120);
    expect(result).toContain("章末钩子在这里");
    expect(result).not.toContain("开场事实");
    expect(byteLength(result)).toBeLessThanOrEqual(120);
  });

  it("compactMasterOutline 给出全部标题骨架，正文只取主线段与相关段，结局段只留标题", () => {
    const outline = [
      "# 总纲",
      "## 主线目标",
      "沈砚要找到母亲留下的旧电台背后的真相。",
      "## 第一卷 归乡",
      "沈砚回到海边老家，在阁楼发现旧电台，夜里听见敲门声。",
      "## 第二卷 暗流",
      "沈砚进城追查电台来源，与灯塔守夜人结盟。",
      "## 结局方向",
      "真相是母亲仍然活着，电台是她的求救信号。",
    ].join("\n");
    const result = compactMasterOutline(outline, "沈砚在阁楼守着旧电台等敲门的人", 2000);
    expect(result).toContain("## 第一卷 归乡");
    expect(result).toContain("## 结局方向");
    expect(result).toContain("主线目标");
    expect(result).toContain("阁楼发现旧电台");
    expect(result).not.toContain("母亲仍然活着");
  });

  // 症状：连续写十几章都在写同一件事。旧的相关度排序只按词面重合挑段落，
  // 而未来的节点用的词和前文本来就不重合，于是每章都看不到“下一步”，只能把上一章再写一遍
  it("compactMasterOutline 必带分卷推进路线与下一节点，未来的段落不会因为用词不同被筛掉", () => {
    const outline = [
      "# 总纲",
      "## 主线目标",
      "沈砚要找到母亲留下的旧电台背后的真相。",
      "## 下一步节点",
      "沈砚必须在三天内找到灯塔守夜人，问出电台频率。",
      "## 分卷规划",
      "### 第一卷 归乡",
      "沈砚回到海边老家，在阁楼发现旧电台。",
      "### 第二卷 暗流",
      "沈砚进城追查电台来源，与灯塔守夜人结盟。",
      "## 结局方向",
      "真相是母亲仍然活着，电台是她的求救信号。",
    ].join("\n");
    const result = compactMasterOutline(outline, "沈砚在阁楼守着旧电台等敲门的人", 3000);
    // 第二卷用的是“进城、追查、结盟”，与已写正文零重合，旧做法会把它整个丢掉
    expect(result).toContain("推进路线");
    expect(result).toContain("沈砚进城追查电台来源");
    expect(result).toContain("接下来必须推进");
    expect(result).toContain("三天内找到灯塔守夜人");
    expect(result).not.toContain("母亲仍然活着");
  });

  // 症状：长篇小说的卷标题里写着章号区间（第156～205章），却被当成普通段落按词面打分挑，
  // 挑中的是旧卷和伏笔表，真正的当前卷（含“已完成阶段归纳/后续宏观方向”）一次都没进过提示词
  it("compactMasterOutline 按章号区间定位当前卷，并把当前卷与下一卷的正文带进提示词", () => {
    const outline = [
      "# 全书总纲",
      "## 六、六卷结构总览",
      "从旧雨到敦煌，六卷推进。",
      "## 七、分卷规划",
      "## 第一卷：梧桐旧雨（第1～40章）",
      "### 卷定位",
      "回到旧宅，确认身份。",
      "## 第五卷：栖迟文脉（第156～205章）",
      "### 已完成阶段归纳",
      "第171～177章进入桑皮纸试制与样本观察阶段。",
      "### 后续宏观方向",
      "第178～185章：研究沉淀与生活回落，不回写第177章技术流程。",
      "## 第六卷：大美敦煌（第206～250章）",
      "### 卷定位",
      "把个人治愈推向国家文化保护层面。",
    ].join("\n");
    const result = compactMasterOutline(outline, "沈妄在温室里试制桑皮纸", 5600, 176);
    expect(result).toContain("【当前卷】");
    expect(result).toContain("第五卷：栖迟文脉");
    expect(result).toContain("第178～185章：研究沉淀与生活回落");
    expect(result).toContain("【下一卷】");
    expect(result).toContain("第六卷：大美敦煌");
  });

  it("buildStoryLedger 按章号排事件、标出当前位置、只列未回收伏笔", () => {
    const ledger = buildStoryLedger([
      { chapterNumber: 3, title: "第三章", summary: "沈砚确认门外是守夜人。", endingHook: "守夜人递来一把钥匙。", foreshadowingItems: [{ text: "钥匙能开灯塔地下室", status: "active", plantedChapter: 3, targetChapter: 6 }] },
      { chapterNumber: 2, title: "第二章", summary: "阁楼电台亮起，门外三声敲门。", foreshadowingItems: [{ text: "电台里的摩斯码", status: "resolved" }] },
    ], { number: 4, total: 3 }, 2400);
    expect(ledger).toContain("当前正在写第 4 章，全书已有 3 章");
    expect(ledger.indexOf("第 2 章")).toBeLessThan(ledger.indexOf("第 3 章"));
    expect(ledger).toContain("不得再写一遍");
    expect(ledger).toContain("[active] 钥匙能开灯塔地下室（埋于第 3 章，计划第 6 章回收）");
    expect(ledger).not.toContain("摩斯码");
  });

  // 症状：模型几乎从不填 foreshadowingItems（真实项目 12 章一条都没填），
  // 而账本只读它，于是“未回收伏笔”永远为空，模型永远不知道有线索要回收
  it("buildStoryLedger 在结构化伏笔为空时退回伏笔文字，未回收伏笔不会一直空着", () => {
    const ledger = buildStoryLedger([
      { chapterNumber: 2, title: "第二章", summary: "阁楼电台亮起。", foreshadowingChanges: ["电台里的摩斯码还没译完"], foreshadowingItems: [] },
      { chapterNumber: 3, title: "第三章", summary: "守夜人出现。", foreshadowingChanges: ["守夜人递来一把钥匙。"], foreshadowingItems: [{ text: "钥匙能开地下室", status: "resolved" }] },
    ], { number: 4, total: 3 }, 2400);
    expect(ledger).toContain("未回收伏笔");
    expect(ledger).toContain("第 2 章：电台里的摩斯码还没译完");
    expect(ledger).toContain("第 3 章：守夜人递来一把钥匙。");
  });

  // 症状：导入的书或旧版本写的章节没有章节记忆，账本只列最后几章，模型就以为“前文只有这些”
  it("buildStoryLedger 标出中间的记忆断档，不让模型凭空补写缺失的百余章", () => {
    const ledger = buildStoryLedger([
      { chapterNumber: 50, title: "第五十章", summary: "旧事。" },
      { chapterNumber: 53, title: "第五十三章", summary: "旧事。" },
      { chapterNumber: 172, title: "第 172 章", summary: "晨揭桑纸。" },
      { chapterNumber: 173, title: "第 173 章", summary: "纤痕入编。" },
      { chapterNumber: 174, title: "第 174 章", summary: "试讲。" },
      { chapterNumber: 175, title: "第 175 章", summary: "展示箱。" },
    ], { number: 176, total: 175 }, 3600);
    expect(ledger).toContain("第 54–171 章没有章节记忆");
  });

  it("contextBudgetBytes 跟着窗口走，128K 窗口不再只装 18KB", () => {
    const budget = contextBudgetBytes(128);
    expect(budget).toBeGreaterThan(48 * 1024);
    expect(budget).toBeLessThan(80 * 1024);
    expect(contextBudgetBytes(1024)).toBe(256 * 1024);
    // 调用方显式给小预算时仍然听它的（记忆提炼、图书路径靠这个控制成本）
    expect(contextBudgetBytes(128, 20, 8)).toBe(20 * 1024);
  });

  it("prepareChapterInput 不再写死只带 6 章记忆，能带多少由预算决定", () => {
    const prepared = prepareChapterInput({
      instruction: "继续写第十三章",
      outlines: [],
      previousChapters: [],
      memories: Array.from({ length: 12 }, (_, index) => ({ chapterNumber: index + 1, summary: `第 ${index + 1} 章发生了什么。` })),
      chapterPosition: { number: 13, total: 12 },
      contextWindowKTokens: 128,
    });
    expect(prepared.memories.length).toBeGreaterThan(6);
    expect(prepared.storyLedger).toContain("第 1 章");
  });

  it("prepareChapterInput 把总纲和章尾从普通资料里分出来", () => {
    const prepared = prepareChapterInput({
      instruction: "继续写第三章",
      outlines: [
        { id: 1, kind: "总纲", title: "总纲", content: "# 总纲\n## 主线目标\n找到电台真相。\n## 结局方向\n母亲活着。" },
        { id: 2, kind: "章纲", title: "第三章章纲", content: "沈砚面对守夜人。" },
      ],
      previousChapters: [{ id: 2, title: "第二章", content: `开头：沈砚回到老家。${"中".repeat(3000)}\n\n结尾：门外三声敲门。` }],
      memories: [{ chapterNumber: 2, summary: "阁楼电台亮起。", endingHook: "三声敲门。" }],
      chapterPosition: { number: 3, total: 2 },
      contextWindowKTokens: 32,
    });
    expect(prepared.masterOutline).toContain("结构骨架");
    expect(prepared.masterOutline).toContain("找到电台真相");
    expect(prepared.masterOutline).not.toContain("母亲活着");
    expect(prepared.outline).toContain("守夜人");
    expect(prepared.outline).not.toContain("结局方向");
    expect(prepared.previousChapters[0]?.ending).toContain("门外三声敲门");
    expect(prepared.previousChapters[0]?.ending).not.toContain("沈砚回到老家");
    expect(prepared.storyLedger).toContain("当前正在写第 3 章");
    expect(prepared.report.sections.masterOutline).toBeGreaterThan(0);
  });
});
