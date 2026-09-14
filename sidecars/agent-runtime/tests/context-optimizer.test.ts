import { describe, expect, it } from "vitest";
import { buildStoryLedger, byteLength, compactKnowledgeGraph, compactMasterOutline, compactText, LruCache, normalizePromptWhitespace, prepareChapterInput, stableHash, tailText } from "../src/context/context-optimizer.js";

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
