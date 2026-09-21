import { describe, expect, it } from "vitest";
import { chapterReviewRequest, mergeReviewResults, normalizeChapterReviewResult, normalizePerspectiveResult, normalizeReviewMode, reviewPerspectivesFor, verdictFromFindings } from "../src/application/chapter-review.js";

const baseInput = {
  agentSystemPrompt: "你是写作 Agent。",
  worldSetting: "## 世界观\n沈妄不接受系统设定。",
  draftContent: "她把试印结论盖了章。",
};

describe("chapter review", () => {
  it("三档对应的视角序列：full 四个、lean 两个、solo 一个；不认识的档位按 lean", () => {
    expect(reviewPerspectivesFor("full")).toEqual(["architect", "character", "prose", "consistency"]);
    expect(reviewPerspectivesFor("lean")).toEqual(["architect", "consistency"]);
    expect(reviewPerspectivesFor("solo")).toEqual(["solo"]);
    expect(normalizeReviewMode("full")).toBe("full");
    expect(normalizeReviewMode("whatever")).toBe("lean");
  });

  it("架构视角带节拍、总纲、账本、构思与番茄六项；一致性视角带卡片、图谱与上一章承诺；文字视角只带正文", () => {
    const input = {
      ...baseInput,
      chapterBeat: "| 179 | 试讲落地 |",
      masterOutline: "## 七、第179章起分阶段规划\n### 第179～185章：试讲与婚帖",
      storyLedger: "前文已发生：第178章失败样上桌。",
      knowledgeGraph: "沈妄 -> 姜冷月",
      retrievedContext: ["第178章记忆摘要"],
      chapterPlan: "本章沈妄第一次去城西纸坊。",
      previousPromise: "第 179 章要把试讲的结果告诉齐望鹤。",
      cards: [{ title: "沈妄", content: "性格：克制。" }],
    };
    const architect = chapterReviewRequest(input, "architect").messages.map(message => message.content).join("\n");
    expect(architect).toContain("试讲落地");
    expect(architect).toContain("第179～185章");
    expect(architect).toContain("第178章失败样上桌");
    expect(architect).toContain("第一次去城西纸坊");
    expect(architect).toContain("开头吸引力");
    expect(architect).toContain("待审查章节");
    expect(architect).not.toContain("沈妄 -> 姜冷月");

    const consistency = chapterReviewRequest(input, "consistency").messages.map(message => message.content).join("\n");
    expect(consistency).toContain("沈妄 -> 姜冷月");
    expect(consistency).toContain("告诉齐望鹤");
    expect(consistency).toContain("nextChapterRisks");
    expect(consistency).not.toContain("开头吸引力");

    const prose = chapterReviewRequest(input, "prose").messages.map(message => message.content).join("\n");
    expect(prose).toContain("她把试印结论盖了章");
    expect(prose).not.toContain("第178章失败样上桌");
    expect(prose).not.toContain("性格：克制");
    expect(prose).toContain("aiLevel");

    const character = chapterReviewRequest(input, "character").messages.map(message => message.content).join("\n");
    expect(character).toContain("性格：克制");
    expect(character).toContain("问答式");
  });

  it("单视角 JSON 归一化：信封、代码围栏、夹带说明文字都能拆开；severity 与 category 不合法时兜底", () => {
    const envelope = JSON.stringify({ verdict: "CONCERNS", advances: true, progress: "推进到交样", repeatedEvents: [], rubric: { 开头吸引力: "fail", 翻页动力: "PASS" }, findings: [
      { severity: "S2", category: "structure", location: "第 3 段", evidence: "他站着没动", issue: "结尾静止", fix: "落在动作上" },
      { severity: "S9", category: "nonsense", issue: "没有 location 也要收" },
    ] });
    const result = normalizePerspectiveResult(envelope, "architect");
    expect(result.verdict).toBe("CONCERNS");
    expect(result.advances).toBe(true);
    expect(result.rubric).toEqual({ 开头吸引力: "FAIL", 翻页动力: "PASS" });
    expect(result.findings).toHaveLength(2);
    expect(result.findings[1]).toMatchObject({ severity: "S3", category: "structure", source: "architect" });
    expect(normalizePerspectiveResult("```json\n" + envelope + "\n```", "architect").findings).toHaveLength(2);
    expect(normalizePerspectiveResult(`审查结果如下：\n${envelope}\n以上。`, "architect").progress).toBe("推进到交样");
  });

  // 解析不出来时必须当成"没问题"：否则会把一段没读懂的文本当成审查意见去改正文
  it("解析失败时给空问题清单并如实标注", () => {
    const failed = normalizeChapterReviewResult("这一章写得不错，我挑不出毛病");
    expect(failed.issues).toEqual([]);
    expect(failed.consistent).toBe(true);
    expect(failed.suggestions).toEqual(["S4：无法解析审查结果"]);
    expect(failed.verdict).toBe("APPROVE");
  });

  it("合并：按严重度排序，事实类 S1/S2 进 issues，其余进 suggestions；lint blocking 记 S2、advisory 记 S4；verdict 取最重", () => {
    const merged = mergeReviewResults("lean", [
      { perspective: "architect", verdict: "CONCERNS", advances: false, progress: "还在门口", repeatedEvents: ["又敲了三下门"], findings: [
        { severity: "S3", category: "structure", location: "", evidence: "", issue: "结尾静止", fix: "", source: "architect" },
      ] },
      { perspective: "consistency", verdict: "REJECT", nextChapterRisks: ["信还没拆"], findings: [
        { severity: "S1", category: "factual", location: "第 5 段", evidence: "左臂", issue: "旧伤左右不一致", fix: "统一为左臂", source: "consistency" },
      ] },
    ], [
      { type: "not-is-comparison", severity: "blocking", line: 12, excerpt: "不是冷漠，而是绝望", message: "删掉否定铺垫" },
      { type: "period-stutter", severity: "advisory", line: 30, excerpt: "他走。她看。", message: "碎句" },
    ]);
    expect(merged.verdict).toBe("REJECT");
    expect(merged.consistent).toBe(false);
    expect(merged.advances).toBe(false);
    expect(merged.repeatedEvents).toEqual(["又敲了三下门"]);
    expect(merged.nextChapterRisks).toEqual(["信还没拆"]);
    expect(merged.findings.map(item => item.severity)).toEqual(["S1", "S2", "S3", "S4"]);
    expect(merged.issues).toEqual(["S1｜第 5 段：旧伤左右不一致（统一为左臂）"]);
    expect(merged.suggestions[0]).toContain("not-is-comparison");
    expect(merged.perspectives).toEqual([{ perspective: "architect", verdict: "CONCERNS", count: 1 }, { perspective: "consistency", verdict: "REJECT", count: 1 }]);
    expect(verdictFromFindings([])).toBe("APPROVE");
  });

  // 症状：审第 131 章时，账本写着"最新完成第178章、年节后"，审查把它当成本章的时间线矛盾，
  // 还建议"把总纲卷次改回当前写作位"——旧章不该追新进度
  it("审历史章节时去掉账本里的“现在到哪了”两行，并说明本章不是最新进度", () => {
    const ledger = [
      "- **current_timeline**：第178章末·江城梧桐路601·年节后",
      "- **latest_completed_chapter**：178",
      "- **财务底线**：书肆二期自有资金充足",
    ].join("\n");
    const historical = chapterReviewRequest({ ...baseInput, worldSetting: ledger, chapterNumber: 131, totalChapters: 182 }, "consistency");
    const text = historical.messages.map(message => message.content).join("\n");
    expect(text).not.toContain("第178章末·江城梧桐路601·年节后");
    expect(text).not.toContain("**latest_completed_chapter**");
    expect(text).toContain("财务底线");
    expect(text).toContain("审查的是历史章节");
    expect(text).toContain("第 131 章");
    const latest = chapterReviewRequest({ ...baseInput, worldSetting: ledger, chapterNumber: 182, totalChapters: 182 }, "consistency");
    const latestText = latest.messages.map(message => message.content).join("\n");
    expect(latestText).toContain("第178章末·江城梧桐路601·年节后");
    expect(latestText).not.toContain("审查的是历史章节");
  });
});

describe("chapter review · 感情线与人物区分", () => {
  it("作品定位进架构、人物、综合三个视角，不进文字与一致性视角", () => {
    const input = { ...baseInput, projectProfile: "## 作品定位\n类型：男频 / 都市日常\n标签：慢热高甜" };
    for (const perspective of ["architect", "character", "solo"] as const) {
      expect(chapterReviewRequest(input, perspective).messages.map(message => message.content).join("\n")).toContain("慢热高甜");
    }
    for (const perspective of ["prose", "consistency"] as const) {
      expect(chapterReviewRequest(input, perspective).messages.map(message => message.content).join("\n")).not.toContain("慢热高甜");
    }
    const architect = chapterReviewRequest(input, "architect").messages.map(message => message.content).join("\n");
    expect(architect).toContain("人物分得开");
    expect(architect).toContain("感情有戏");
    expect(architect).toContain("relationshipProgress");
  });

  it("relationshipProgress：模型写'无'归一成空串，合并后进报告；relationship 是合法 category", () => {
    const stalled = normalizePerspectiveResult(JSON.stringify({ verdict: "CONCERNS", advances: true, progress: "选址", relationshipProgress: "无", findings: [
      { severity: "S2", category: "relationship", location: "全章", evidence: "她把早饭往他手边推了推", issue: "只推事务，两人关系原地不动", fix: "加一处只对对方做的动作" },
    ] }), "architect");
    expect(stalled.relationshipProgress).toBe("");
    expect(stalled.findings[0].category).toBe("relationship");
    const moved = normalizePerspectiveResult(JSON.stringify({ verdict: "APPROVE", advances: true, progress: "选址", relationshipProgress: "她第一次在人前叫他名字" }), "architect");
    const merged = mergeReviewResults("lean", [moved, { perspective: "consistency", verdict: "APPROVE", findings: [] }]);
    expect(merged.relationshipProgress).toBe("她第一次在人前叫他名字");
    // relationship 类问题不算事实类，进 suggestions 而不是 issues
    const mergedStalled = mergeReviewResults("lean", [stalled]);
    expect(mergedStalled.issues).toHaveLength(0);
    expect(mergedStalled.suggestions[0]).toContain("原地不动");
  });
});
