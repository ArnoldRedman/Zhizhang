import { describe, expect, it } from "vitest";
import { chapterReviewRequest, normalizeChapterReviewResult } from "../src/application/chapter-review.js";

const baseInput = {
  agentSystemPrompt: "你是写作 Agent。",
  worldSetting: "## 世界观\n沈妄不接受系统设定。",
  draftContent: "她把试印结论盖了章。",
};

describe("chapter review", () => {
  it("审查请求带上节拍、总纲与故事账本：没有它们，“有没有推进”判不准", () => {
    const { messages, inputBytes } = chapterReviewRequest({
      ...baseInput,
      chapterBeat: "| 179 | 试讲落地 |",
      masterOutline: "## 七、第179章起分阶段规划\n### 第179～185章：试讲与婚帖",
      storyLedger: "前文已发生：第178章失败样上桌。",
      knowledgeGraph: "沈妄 -> 姜冷月",
      retrievedContext: ["第178章记忆摘要"],
    });
    const text = messages.map(message => message.content).join("\n");
    expect(text).toContain("本章节拍");
    expect(text).toContain("试讲落地");
    expect(text).toContain("第179～185章");
    expect(text).toContain("第178章失败样上桌");
    expect(text).toContain("待审查章节");
    expect(text).toContain("她把试印结论盖了章");
    expect(text).toContain("返回严格 JSON 对象");
    expect(text).toContain("repeatedEvents");
    expect(inputBytes).toBeGreaterThan(0);
  });

  it("解析模型返回：信封、代码围栏、夹带说明文字都能拆开", () => {
    const envelope = JSON.stringify({ consistent: false, issues: ["第 178 章结论冲突"], suggestions: ["改成待刻坊回话"], advances: true, progress: "推进到交样", repeatedEvents: [] });
    expect(normalizeChapterReviewResult(envelope)).toMatchObject({ consistent: false, issues: ["第 178 章结论冲突"], advances: true, progress: "推进到交样" });
    expect(normalizeChapterReviewResult("```json\n" + envelope + "\n```").issues).toHaveLength(1);
    expect(normalizeChapterReviewResult(`审查结果如下：\n${envelope}\n以上。`).suggestions).toEqual(["改成待刻坊回话"]);
  });

  // 解析不出来时必须当成“没问题”：否则会把一段没读懂的文本当成审查意见去改正文
  it("解析失败时给空问题清单并如实标注", () => {
    const failed = normalizeChapterReviewResult("这一章写得不错，我挑不出毛病");
    expect(failed.issues).toEqual([]);
    expect(failed.consistent).toBe(true);
    expect(failed.suggestions).toEqual(["无法解析审查结果"]);
  });

  // 症状：审第 131 章时，账本写着“最新完成第178章、年节后”，审查把它当成本章的时间线矛盾，
  // 还建议“把总纲卷次改回当前写作位”——旧章不该追新进度
  it("审历史章节时去掉账本里的“现在到哪了”两行，并说明本章不是最新进度", () => {
    const ledger = [
      "- **current_timeline**：第178章末·江城梧桐路601·年节后",
      "- **latest_completed_chapter**：178",
      "- **财务底线**：书肆二期自有资金充足",
    ].join("\n");
    const historical = chapterReviewRequest({ ...baseInput, worldSetting: ledger, chapterNumber: 131, totalChapters: 182 });
    const text = historical.messages.map(message => message.content).join("\n");
    expect(text).not.toContain("第178章末·江城梧桐路601·年节后");
    expect(text).not.toContain("**latest_completed_chapter**");
    expect(text).toContain("财务底线");
    expect(text).toContain("审查的是历史章节");
    expect(text).toContain("第 131 章");
    // 审最新一章时不需要这段说明，账本原样带上
    const latest = chapterReviewRequest({ ...baseInput, worldSetting: ledger, chapterNumber: 182, totalChapters: 182 });
    const latestText = latest.messages.map(message => message.content).join("\n");
    expect(latestText).toContain("第178章末·江城梧桐路601·年节后");
    expect(latestText).not.toContain("审查的是历史章节");
  });
});
