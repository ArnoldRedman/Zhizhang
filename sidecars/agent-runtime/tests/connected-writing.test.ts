import { describe, expect, it, vi } from "vitest";
import { applyTextReplacements, isPlaceholderOutline } from "@zhizhang/contracts";
import { prepareChapterInput } from "../src/context/context-optimizer.js";
import { runProjectAgent } from "../src/project-agent.js";
import { buildProjectRevisionContext } from "../src/application/project-revision-context.js";
import type { ModelApiClient } from "../src/models/model-api.js";

const delegates = () => ({ chapter: vi.fn(), chapterRevise: vi.fn(), chapterTitles: vi.fn(), chapterSplit: vi.fn(), outline: vi.fn(), card: vi.fn() });

describe("连续写作资料与关联修订", () => {
  it("1M 窗口保留全部 204 章摘要、近期完整正文、大纲中段与所有卡片", () => {
    const chapters = Array.from({ length: 204 }, (_, i) => ({ id: i + 1, title: `第${i + 1}章`, content: `章首${i + 1}。${"正文人物行动。".repeat(300)}中段证据${i + 1}。${"故事发展。".repeat(300)}章尾${i + 1}。` }));
    const master = `# 总纲\n${"前期事件。".repeat(1200)}\n## 第196至205章\n关键阶段规划。\n${"后期事件。".repeat(1200)}`;
    const cards = Array.from({ length: 19 }, (_, i) => ({ title: `人物${i}`, content: `性格${i}，${"独特行动方式。".repeat(120)}` }));
    const input = prepareChapterInput({ instruction: "继续写下一章", contextWindowKTokens: 1024, chapterPosition: { number: 205, total: 205 }, previousChapters: chapters, outlines: [{ kind: "总纲", content: master }], cards, memories: chapters.map((chapter, i) => ({ chapterNumber: i + 1, title: chapter.title, summary: `事件摘要${i + 1}已完成。` })) });
    expect(input.masterOutline).toContain(master);
    expect(input.cards).toHaveLength(19);
    expect(input.previousChapters.length).toBeGreaterThanOrEqual(10);
    for (const chapter of input.previousChapters) expect(chapter.content).toBe(chapters.find(item => item.id === chapter.id)?.content);
    for (let i = 1; i <= 204; i++) expect(input.storyLedger).toContain(`事件摘要${i}已完成。`);
  });

  it("占位说明不能阻止自动规划，简短有效章纲仍然有效", () => {
    expect(isPlaceholderOutline("# 章纲｜第205章\n\n旧版计划/提问已归档。现稿写至204章，后续未续写；请重新讨论。")).toBe(true);
    expect(isPlaceholderOutline("# 章纲\n")).toBe(true);
    expect(isPlaceholderOutline("两人在车站重逢，当场说清误会。")).toBe(false);
  });

  it("修改后能读到新稿并联动下一章，原项目不变，同章只返回最终提案", async () => {
    const project = { title: "测试书", chapters: [{ id: 1, title: "第一章", content: "事件未解决" }, { id: 2, title: "第二章", content: "仍在处理事件" }], memories: [{ chapterId: 1, summary: "旧事件" }], memoryDocuments: [] };
    const turns = [
      { action: "edit", changes: [{ type: "chapter.update", summary: "结束事件", targetId: 1, content: "事件已经解决" }] },
      { action: "open", kind: "章节", id: [1, 2] },
      { action: "edit", changes: [{ type: "chapter.update", summary: "衔接第二章", targetId: 2, content: "众人开始新的生活" }] },
      { action: "finish", message: "两章已联动修订，等待应用。", changes: [{ type: "chapter.update", summary: "补全落点", targetId: 1, content: "事件已经解决，众人离开" }] },
    ];
    const chat = vi.fn(async (_messages: unknown) => ({ content: JSON.stringify(turns.shift()), model: "test" }));
    const result = await runProjectAgent({ mode: "execute", instruction: "结束事件并修改后续矛盾", project, contextWindowKTokens: 1024 }, { chat } as unknown as ModelApiClient, delegates());
    expect(JSON.stringify(chat.mock.calls[2])).toContain("事件已经解决");
    expect(project.chapters[0].content).toBe("事件未解决");
    expect(result.changes).toHaveLength(2);
    expect(result.changes[0]).toMatchObject({ targetId: 1, content: "事件已经解决，众人离开" });
    expect(result.changes[1]).toMatchObject({ targetId: 2, content: "众人开始新的生活" });
  });

  it("edit 可委派后继续复查，结束前修改同一章不会重复提案", async () => {
    const project = { chapters: [{ id: 1, title: "第一章", content: "旧稿" }] };
    const workers = delegates();
    workers.chapterRevise.mockResolvedValue({ type: "chapter.update", targetId: 1, summary: "完成初稿", content: "事件结束" });
    const turns = [
      { action: "edit", changes: [{ type: "chapter.revise", targetId: 1, summary: "修订", instruction: "结束事件" }] },
      { action: "open", kind: "章节", id: 1 },
      { action: "finish", message: "检查通过", changes: [] },
    ];
    const chat = vi.fn(async (_messages: unknown) => ({ content: JSON.stringify(turns.shift()), model: "test" }));
    const result = await runProjectAgent({ mode: "execute", instruction: "修订并核对", project }, { chat } as unknown as ModelApiClient, workers);
    expect(JSON.stringify(chat.mock.calls[2])).toContain("事件结束");
    expect(result.changes).toHaveLength(1);
    expect(project.chapters[0].content).toBe("旧稿");
  });

  it("局部替换只改命中的一句，重复或缺失都失败", () => {
    expect(applyTextReplacements("清早返江城。陆青留在江城。", [{ find: "清早返江城", replace: "傍晚返江城" }])).toBe("傍晚返江城。陆青留在江城。");
    expect(() => applyTextReplacements("没有这句话", [{ find: "清早", replace: "傍晚" }])).toThrow(/找不到/);
    expect(() => applyTextReplacements("清早。清早。", [{ find: "清早", replace: "傍晚" }])).toThrow(/2 次/);
  });

  it("局部修改章纲后能读到新句子，原项目不变", async () => {
    const project = { outlines: [{ id: 12, kind: "章纲", title: "章纲｜第 208 章", content: "清早返江城。陆青留在江城。" }], chapters: [] };
    const turns = [
      { action: "edit", changes: [{ type: "text.replace", summary: "改返程时间", target: "outline", targetId: 12, replacements: [{ find: "清早返江城", replace: "傍晚返江城" }] }] },
      { action: "open", kind: "章纲", id: 12 },
      { action: "finish", message: "只改了返程时间", changes: [] },
    ];
    const chat = vi.fn(async () => ({ content: JSON.stringify(turns.shift()), model: "test" }));
    const result = await runProjectAgent({ mode: "execute", instruction: "把返程改成傍晚", project }, { chat } as unknown as ModelApiClient, delegates());
    expect(JSON.stringify(chat.mock.calls)).toContain("傍晚返江城");
    expect(result.changes[0]).toMatchObject({ type: "text.replace", targetId: 12 });
    expect(project.outlines[0].content).toContain("清早返江城");
  });

  it("finish 可以提出删除章纲，作者确认前不改原项目", async () => {
    const project = { outlines: [{ id: 9, kind: "章纲", title: "章纲｜第 208 章", content: "重复" }], chapters: [] };
    const chat = vi.fn(async () => ({ content: JSON.stringify({ action: "finish", message: "删掉这份重复章纲", changes: [{ type: "outline.delete", summary: "删除重复章纲", targetId: 9, title: "章纲｜第 208 章" }] }), model: "test" }));
    const result = await runProjectAgent({ mode: "execute", instruction: "删除重复的第208章章纲", project }, { chat } as unknown as ModelApiClient, delegates());
    expect(result.changes).toEqual([expect.objectContaining({ type: "outline.delete", targetId: 9 })]);
    expect(project.outlines).toHaveLength(1);
  });

  it("同一章章纲再次写入覆盖原件，不另建一份", async () => {
    const project = { outlines: [{ id: 5, kind: "章纲", title: "章纲｜第 208 章", content: "旧版" }], chapters: [] };
    const turns = [
      () => ({ action: "edit", changes: [{ type: "outline.upsert", summary: "重写208", kind: "章纲", title: "章纲｜第 208 章 返程", content: "冷月傍晚返江城" }] }),
      () => ({ action: "edit", changes: [{ type: "outline.upsert", summary: "再改208", kind: "章纲", title: "章纲｜第 208 章 返程", content: "冷月傍晚返江城，陆青留在江城" }] }),
      () => ({ action: "finish", message: "只留一份", changes: [] }),
    ];
    const chat = vi.fn(async () => ({ content: JSON.stringify(turns.shift()!()), model: "test" }));
    const result = await runProjectAgent({ mode: "execute", instruction: "整理第208章章纲", project }, { chat } as unknown as ModelApiClient, delegates());
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({ type: "outline.upsert", targetId: 5, content: "冷月傍晚返江城，陆青留在江城" });
    expect(project.outlines).toHaveLength(1);
  });

  it("新建章后继续编辑仍返回一份创建提案", async () => {
    let id = 0;
    const turns = [
      () => ({ action: "edit", changes: [{ type: "chapter.create", summary: "新章", title: "第一章", content: "初稿" }] }),
      () => ({ action: "edit", changes: [{ type: "chapter.update", summary: "修改新章", targetId: id, content: "定稿" }] }),
      () => ({ action: "finish", message: "完成", changes: [] }),
    ];
    const chat = vi.fn(async () => ({ content: JSON.stringify(turns.shift()!()), model: "test" }));
    const result = await runProjectAgent({ mode: "execute", instruction: "写章并复查", project: { chapters: [] }, onStage: project => { id = Number((project.chapters as Array<{ id: number }>)[0].id); } }, { chat } as unknown as ModelApiClient, delegates());
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({ type: "chapter.create", title: "第一章", content: "定稿" });
  });

  it("委派按顺序读取前一项新稿和更新后的总纲", async () => {
    const project = { chapters: [{ id: 1, title: "第一章", content: "旧稿一" }, { id: 2, title: "第二章", content: "旧稿二" }], outlines: [], cards: [], memories: [] };
    let working: Record<string, unknown> = project;
    const workers = delegates();
    workers.chapterRevise.mockImplementation(async (request: { targetId: number }) => {
      if (request.targetId === 2) expect(buildProjectRevisionContext(working, 2, 1024)).toContain("事件已结束");
      return { type: "chapter.update", summary: "修改", targetId: request.targetId, content: request.targetId === 1 ? "事件已结束" : "新事件开始" };
    });
    const client = { chat: vi.fn(async () => ({ content: JSON.stringify({ action: "finish", message: "关联修订", changes: [1, 2].map(targetId => ({ type: "chapter.revise", summary: "修改", targetId, instruction: "调整事件" })) }), model: "test" })) } as unknown as ModelApiClient;
    const result = await runProjectAgent({ mode: "execute", instruction: "关联修改", project, onStage: value => { working = value; } }, client, workers);
    expect(result.changes).toHaveLength(2);
    expect(project.chapters[0].content).toBe("旧稿一");
  });
});
