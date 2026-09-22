import { describe, expect, it } from "vitest";
import { buildStoryLedger, byteLength, compactCardContent, compactKnowledgeGraph, compactMasterOutline, compactText, contextBudgetBytes, isWorkLogDocument, leadText, LruCache, normalizePromptWhitespace, prepareChapterInput, stableHash, stageBeatLines, stripProgressSnapshots, tailText } from "../src/context/context-optimizer.js";

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
    expect(result).toContain("接下来要推进到");
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

  // 症状（《穿成恶人前夫后》第 177 章实测）：卷定位对了，但阶段区间写在列表项里而不是标题里，定位逻辑看不见；
  // “当前节点”按词面挑中了伏笔矩阵表格，“接下来必须推进”因预算耗尽根本没出现——模型只知道当前卷有 50 章，不知道自己在哪一段、该走多快
  // 症状（《穿成恶人前夫后》第 179 章实测）：卷标题写成“（156～205章）”（没有“第”），定位失败后退回词面打分，
  // “接下来必须推进”落到了“市场常见套路与本书差异”这张卖点表上——运行时把一张营销表当成了本章终点；
  // 而卷内的“关键节点/埋伏”被当作非当前阶段的附属行一并压掉
  it("compactMasterOutline 认识不带“第”的卷章号区间，并保住卷里的关键节点与埋伏", () => {
    const outline = [
      "# 全书总纲",
      "## 二、题材卖点与差异化钩子",
      "### 3. 市场常见套路与本书差异",
      "| 常见套路 | 本书处理 |",
      "|---|---|",
      "| 穿越后依靠系统逆袭 | 无系统、无面板 |",
      "## 六、分卷节拍与节点埋伏",
      "### 第三卷：灵魂相认与大唐攻坚（111～155章，已完成）",
      "- 核心：临安唐代国宝攻坚。",
      "### 第四卷：书肆二期与大婚盛典（156～205章，部分已完成至第173章）",
      "- 核心：栖迟书肆二期生活流；明制国风大婚盛典。",
      "- 已完成至第173章《温室试制桑皮纸》；桑皮纸试制阶段收尾须在第174～177章完成。",
      "- 关键节点：专著问世；大婚华服试样与仪式；国风盛典。",
      "- 埋伏：敦煌特邀函；海外流失国宝线索推进。",
      "### 第五卷：敦煌抢救与归国终局（206～250章，待续写）",
      "- 核心：敦煌莫高窟特邀抢救。",
    ].join("\n");
    const current = compactMasterOutline(outline, "沈妄在纸行对案", 5600, 179);
    expect(current).toContain("【当前卷】\n### 第四卷：书肆二期与大婚盛典");
    expect(current).toContain("关键节点：专著问世；大婚华服试样与仪式；国风盛典");
    expect(current).toContain("埋伏：敦煌特邀函");
    // "须在第174～177章完成"是正文里的一句话，不是阶段标题：以前被当成阶段，本章位置就标成了"第 2/4 章"这种假位置
    expect(current).not.toContain("本章位于阶段");
    expect(current).toContain("桑皮纸试制阶段收尾须在第174～177章完成");
    // 卖点段落既不能变成"当前节点"，也不能变成"接下来要推进到"
    expect(current).not.toContain("| 穿越后依靠系统逆袭");
    expect(current).not.toContain("接下来要推进到");
    // 已完成的第三卷只留标题，但卷内阶段标在第四章上时仍能定位
    const inside = compactMasterOutline(outline, "沈妄在纸行对案", 5600, 175);
    expect(inside).not.toContain("本章位于阶段");
  });

  it("compactMasterOutline 在当前卷里按章号定位阶段并标出本章位置，阶段最后一章要求收束并进入下一阶段", () => {
    const outline = [
      "# 全书总纲",
      "## 七、分卷规划",
      "## 第五卷：栖迟文脉（第156～205章）",
      "### 卷定位",
      "以稳定伴侣生活与长期研究为主。",
      "### 已完成阶段归纳",
      "- **第156～170章**",
      "  - 书肆二期生活进入持续推进阶段。",
      "- **第171～177章**",
      "  - 已进入桑皮纸试制与样本观察阶段。",
      "### 后续宏观方向",
      "- **第178～185章：研究沉淀与生活回落**",
      "  - 延续既有研究，不回写第177章技术流程。",
      "- **第186～195章：专著影响扩展**",
      "  - 《古籍微痕通论》逐渐形成社会影响。",
      "## 第六卷：大美敦煌（第206～250章）",
      "### 卷定位",
      "把个人治愈推向国家文化保护层面。",
      "## 十、伏笔埋设与回收矩阵",
      "| 伏笔 | 回收要求 |",
      "| 深蓝色笔记本 | 主动生活完成最终反转 |",
    ].join("\n");
    const last = compactMasterOutline(outline, "沈妄在教室里讲桑皮纸", 5600, 177);
    expect(last).toContain("本章位置：第五卷：栖迟文脉（第156～205章）；本章位于阶段「第171～177章」：第 7/7 章，是本阶段最后一章");
    expect(last).toContain("下一阶段「第178～185章：研究沉淀与生活回落」");
    expect(last).toContain("【当前阶段：本章是本阶段第 7/7 章，也是最后一章】");
    expect(last).toContain("【下一阶段：本章还没到这里】\n- **第178～185章：研究沉淀与生活回落**");
    // 其他阶段只留标题行；伏笔矩阵不再被当成“当前节点”
    expect(last).toContain("- **第186～195章：专著影响扩展**");
    expect(last).not.toContain("《古籍微痕通论》逐渐形成社会影响");
    expect(last).not.toContain("当前节点");
    expect(last).not.toContain("深蓝色笔记本");
    // 卷中只给下一卷的标题，细节留给卷末
    expect(last).toContain("【下一卷】\n## 第六卷：大美敦煌（第206～250章）");
    const middle = compactMasterOutline(outline, "沈妄整理记录", 5600, 180);
    expect(middle).toContain("本章位于阶段「第178～185章：研究沉淀与生活回落」：第 3/8 章，本阶段还剩 5 章，本章走其中一步");
  });

  it("leadText 只取开头并在句末收口，不留裁剪标记", () => {
    expect(leadText("沈砚回到老家。夜里听见敲门声。", 30)).toBe("沈砚回到老家。…");
    expect(leadText("短句", 40)).toBe("短句");
  });

  // 症状：账本把上一章刚埋的场景待办（签字没落、封条起翘）和长线伏笔混成一份“必须回收”的清单，
  // 下一章为了逐条回收就整章留在原地；摘要按头尾拼接，每行中间都插着裁剪标记；预算装不下的更早章节直接消失
  it("buildStoryLedger 只列埋了三章以上的长线伏笔，场景待办不进账本；事件行只取摘要开头，更早的章只列标题", () => {
    const memories = Array.from({ length: 30 }, (_, index) => ({
      chapterNumber: index + 1,
      title: `第 ${index + 1} 章 标题${index + 1}`,
      summary: `第${index + 1}章：沈砚在阁楼里守着旧电台，等门外的敲门声再响一次，顺手把频率表抄进笔记本。${"细".repeat(120)}`,
      foreshadowingItems: index === 4
        ? [{ text: "母亲留下的旧电台频率", status: "active", plantedChapter: 5, targetChapter: 40 }]
        : index === 28 ? [{ text: "签字笔悬在中止权条款上没落下", status: "active", plantedChapter: 29, targetChapter: 30 }] : [],
    }));
    const ledger = buildStoryLedger(memories, { number: 30, total: 29 }, 3000);
    expect(ledger).toContain("长线伏笔");
    expect(ledger).toContain("旧电台频率");
    // 第 29 章刚埋的"签字笔没落下"是场景待办：以前单列成"未了事项"，下一章就为了它整章留在原地
    expect(ledger).not.toContain("未了事项");
    expect(ledger).not.toContain("签字笔悬在中止权条款上没落下");
    expect(ledger).not.toContain("已按相关性与预算裁剪");
    expect(ledger).toContain("- 第 29 章 标题29：");
    expect(ledger).toContain("抄进笔记本。…");
    expect(ledger).not.toContain("细细细");
    expect(ledger).toContain("更早的章节（只列标题");
    expect(ledger).toContain("第 1 章 标题1");
  });

  it("buildStoryLedger 按章号排事件、标出当前位置、只列未回收伏笔", () => {
    const ledger = buildStoryLedger([
      { chapterNumber: 3, title: "第三章", summary: "沈砚确认门外是守夜人。", endingHook: "守夜人递来一把钥匙。", foreshadowingItems: [{ text: "钥匙能开灯塔地下室", status: "active", plantedChapter: 3, targetChapter: 6 }] },
      { chapterNumber: 2, title: "第二章", summary: "阁楼电台亮起，门外三声敲门。", foreshadowingItems: [{ text: "电台里的摩斯码", status: "resolved" }] },
    ], { number: 4, total: 3 }, 2400);
    expect(ledger).toContain("当前正在写第 4 章，全书已有 3 章");
    expect(ledger.indexOf("第 2 章")).toBeLessThan(ledger.indexOf("第 3 章"));
    expect(ledger).toContain("这些已经写过了");
    // 第 3 章刚埋的钥匙在第 4 章还是场景待办，不列；到第 6 章才算长线
    expect(ledger).not.toContain("钥匙能开灯塔地下室");
    expect(buildStoryLedger([
      { chapterNumber: 3, title: "第三章", summary: "沈砚确认门外是守夜人。", foreshadowingItems: [{ text: "钥匙能开灯塔地下室", status: "active", plantedChapter: 3, targetChapter: 6 }] },
    ], { number: 6, total: 5 }, 2400)).toContain("[active] 钥匙能开灯塔地下室（埋于第 3 章，计划第 6 章回收）");
    expect(ledger).not.toContain("摩斯码");
  });

  // 症状：模型几乎从不填 foreshadowingItems（真实项目 12 章一条都没填），
  // 而账本只读它，于是“未回收伏笔”永远为空，模型永远不知道有线索要回收
  it("buildStoryLedger 在结构化伏笔为空时退回伏笔文字，未回收伏笔不会一直空着", () => {
    const ledger = buildStoryLedger([
      { chapterNumber: 2, title: "第二章", summary: "阁楼电台亮起。", foreshadowingChanges: ["电台里的摩斯码还没译完"], foreshadowingItems: [] },
      { chapterNumber: 3, title: "第三章", summary: "守夜人出现。", foreshadowingChanges: ["守夜人递来一把钥匙。"], foreshadowingItems: [{ text: "钥匙能开地下室", status: "resolved" }] },
    ], { number: 6, total: 5 }, 2400);
    expect(ledger).toContain("长线伏笔");
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
    expect(budget).toBeLessThan(100 * 1024);
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

describe("stage beats", () => {
  it("stageBeatLines 取节拍表里本章那一行与前后行，区间标题行不算章", () => {
    const sheet = [
      "# 阶段节拍｜第178～185章",
      "本阶段：研究沉淀与生活回落。",
      "| 章 | 核心事件 | 时间与地点 |",
      "| 第178章 | 回书肆整理试讲记录 | 次日，书肆 |",
      "| 第179章 | 同行来访交流 | 三日后，文津书院 |",
      "| 第180章 | 挑喜帖 | 一周后，家中 |",
    ].join("\n");
    const beat = stageBeatLines(sheet, 179);
    expect(beat.current).toBe("第179章｜同行来访交流｜三日后，文津书院");
    expect(beat.previous).toContain("第178章");
    expect(beat.next).toContain("第180章");
    expect(stageBeatLines(sheet, 190).current).toBe("");
  });
});

describe("story ledger promise and author truth", () => {
  // 上一章的"下一章承诺"是本章开头必须接住的事；"作者真相"是读者还不知道的底，账本里标明角色不能说破
  it("buildStoryLedger 带上最后一章的下一章承诺与最近几章的作者真相", () => {
    const ledger = buildStoryLedger([
      { chapterNumber: 2, title: "第二章", summary: "阁楼电台亮起。", authorTruth: ["电台是父亲留下的，母亲一直瞒着"] },
      { chapterNumber: 3, title: "第三章", summary: "守夜人出现。", nextChapterPromise: "守夜人约定天亮前在灯塔见面", authorTruth: [] },
    ], { number: 4, total: 3 }, 3000);
    expect(ledger).toContain("上一章留给本章的事（下一章承诺）：守夜人约定天亮前在灯塔见面");
    expect(ledger).toContain("作者真相（读者还不知道的底，角色不能提前说破）");
    expect(ledger).toContain("- 第 2 章：电台是父亲留下的，母亲一直瞒着");
    // 没有承诺与真相时两段都不出现，不留空标题
    const plain = buildStoryLedger([{ chapterNumber: 3, title: "第三章", summary: "守夜人出现。" }], { number: 4, total: 3 }, 3000);
    expect(plain).not.toContain("下一章承诺");
    expect(plain).not.toContain("作者真相");
  });
});

describe("buildStoryLedger · 感情线", () => {
  it("单列最近一次人物关系状态，并写明之后停了几章", () => {
    const memories = [
      { chapterNumber: 200, title: "第 200 章", summary: "选址。", relationshipState: ["沈妄与姜冷月：她替他挡掉话筒线，他没躲。"] },
      { chapterNumber: 201, title: "第 201 章", summary: "看纸坊。" },
      { chapterNumber: 202, title: "第 202 章", summary: "水样复检。" },
      { chapterNumber: 203, title: "第 203 章", summary: "编号争执。" },
    ];
    const ledger = buildStoryLedger(memories, { number: 204, total: 203 }, 4000);
    expect(ledger).toContain("感情线（第 200 章时的人物关系与情绪");
    expect(ledger).toContain("她替他挡掉话筒线");
    expect(ledger).toContain("之后 3 章没有关系变化，感情线停在这里");
    // 上一章刚有变化：只提"接着往前走"，不报停
    const fresh = buildStoryLedger([...memories, { chapterNumber: 204, title: "第 204 章", summary: "拆信。", relationshipState: ["他当着她拆了信。"] }], { number: 205, total: 204 }, 4000);
    expect(fresh).toContain("第 204 章时的人物关系");
    expect(fresh).not.toContain("感情线停在这里");
    // 最近几章一条关系记录都没有：直接说停了
    const none = buildStoryLedger(memories.map(memory => ({ ...memory, relationshipState: [] })), { number: 204, total: 203 }, 4000);
    expect(none).toContain("都没有人物关系变化，感情线已经停了");
  });
});

describe("世界观文档与卡片的裁法", () => {
  it("修订日志、评审意见这类工作台账不进世界观资料；进度快照字段被剥掉", () => {
    expect(isWorkLogDocument("修订日志")).toBe(true);
    expect(isWorkLogDocument("变更记录")).toBe(true);
    expect(isWorkLogDocument("写作风格与反 AI 味规范")).toBe(false);
    const stripped = stripProgressSnapshots("- **current_timeline**：D114 大年初三\n- **latest_completed_chapter**：155\n- **active_volume**：5\n\n## hard_facts\n- 沈妄肉身 24 岁\n### 第四卷（156～205章，已完成至第178章）\n- 核心：书肆二期");
    expect(stripped).not.toContain("current_timeline");
    expect(stripped).not.toContain("latest_completed_chapter");
    expect(stripped).not.toContain("已完成至第178章");
    expect(stripped).toContain("沈妄肉身 24 岁");
    expect(stripped).toContain("### 第四卷（156～205章）");
    const prepared = prepareChapterInput({
      instruction: "写第 205 章",
      outlines: [
        { id: 1, kind: "世界观与作品设定", title: "修订日志", content: "## 2026-08-23 第 9 次修订\n旧书名改掉了。" },
        { id: 2, kind: "世界观与作品设定", title: "都市现实规则", content: "- 手机要充电。" },
      ],
      contextWindowKTokens: 128,
      chapterPosition: { number: 205, total: 205 },
    });
    expect(prepared.worldSetting).toContain("手机要充电");
    expect(prepared.worldSetting).not.toContain("旧书名改掉了");
  });

  it("卡片按小节裁：先丢项目职责与状态快照，再丢非核心小节，性格与关系整段保留", () => {
    const card = [
      "- **name**：沈妄",
      "## 当前身份", "书肆店主。".repeat(40),
      "## 前世与穿越", "前世是编辑。".repeat(60),
      "## 性格与声音", "句子短，不解释。".repeat(30),
      "## 主要项目职责", "造纸温室。".repeat(80),
      "## 核心目标与心理驱动", "把手艺留下来。".repeat(30),
      "## 与主要人物的关系与相处方式", "把她让到路灯内侧。".repeat(30),
      "## 专业能力边界", "会失手。".repeat(40),
      "## 微习惯与身体细节", "把东西码齐。".repeat(40),
      "## 当前状态（第171章末）", "在温室。".repeat(40),
    ].join("\n");
    const packed = compactCardContent(card, 2600);
    expect(byteLength(packed)).toBeLessThanOrEqual(2600);
    expect(packed).toContain("## 性格与声音");
    expect(packed).toContain("## 核心目标与心理驱动");
    expect(packed).toContain("## 与主要人物的关系与相处方式");
    expect(packed).toContain("- **name**：沈妄");
    expect(packed).not.toContain("主要项目职责");
    expect(packed).not.toContain("当前状态（第171章末）");
    expect(packed).not.toContain("已按相关性与预算裁剪");
    // 装得下就原样
    expect(compactCardContent("## 性格与声音\n短。", 1000)).toBe("## 性格与声音\n短。");
  });

  it("账本里的关系与情绪整条带，不再截成碎片", () => {
    const ledger = buildStoryLedger([
      { chapterNumber: 200, title: "第 200 章", summary: "选址。", relationshipState: [`沈妄与姜冷月：${"她记录地址、把关流程，不催不问；他蹲渠试水、判院、比对，她在台侧挪灯看比对却不问结论。".repeat(2)}`] },
      { chapterNumber: 201, title: "第 201 章", summary: "看纸坊。" },
    ], { number: 202, total: 201 }, 4000);
    expect(ledger).not.toContain("已按相关性与预算裁剪");
    expect(ledger).toContain("挪灯看比对却不问结论");
  });
});
