import { describe, expect, it } from "vitest";
import { appendAgentSession, renderAgentSession, type AgentSessionState } from "../src/application/runtime-state.js";

const emptySession = (): AgentSessionState => ({ version: 1, summary: "", recentTurns: [] });

describe("agent session", () => {
  // 症状：一章写偏了反复重跑，每次都把模型自己的稿子当成“已确认结论”记一轮，
  // 下一轮就被自己的废稿带着继续偏。同一章重跑必须替换而不是堆叠
  it("同一章重跑只保留最新一轮，不堆叠废稿", () => {
    let session = emptySession();
    session = appendAgentSession(session, "继续写第 12 章", "写成了门前对峙。", 128, 0, "chapter:12").state;
    const retried = appendAgentSession(session, "继续写第 12 章（别再写门口）", "推进到出城。", 128, 0, "chapter:12").state;
    expect(retried.recentTurns).toHaveLength(1);
    expect(retried.recentTurns[0].conclusion).toContain("出城");
    expect(renderAgentSession(retried)).not.toContain("门前对峙");
  });

  it("换一章才新增轮次；超过阈值时旧的折进摘要，只留最近两轮", () => {
    let session = emptySession();
    // 阈值 = 窗口 × 0.8 字节（最小 16K 窗口）；换个足够大的 baseBytes 把阈值顶爆
    for (const [chapter, conclusion] of [["chapter:10", "第十章"], ["chapter:11", "第十一章"], ["chapter:12", "第十二章"]] as const) {
      session = appendAgentSession(session, "继续", conclusion, 16, 13_000, chapter).state;
    }
    expect(session.recentTurns).toHaveLength(2);
    expect(renderAgentSession(session)).toContain("第十二章");
    expect(session.summary).toContain("第十章");
  });

  it("会话结论标明作者未必采用，避免模型把它当成已确认事实", () => {
    const session = appendAgentSession(emptySession(), "继续写第 12 章", "写成了门前对峙。", 128, 0, "chapter:12").state;
    expect(renderAgentSession(session)).toContain("作者未必采用");
  });
});
