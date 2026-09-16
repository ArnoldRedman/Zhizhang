import { describe, expect, it } from "vitest";
import { chapterNumberFromOutlineTitle, outlineWriteTargetContext, stageBeatContentFor } from "../src/application/outline-target.js";

const chapter = (id: number, title: string, content = `第 ${id} 章正文`) => ({ id, title, content });
const outline = (id: number, title: string, content = `# ${title}\n\n## 主线推进\n推进到下一步。`) => ({ id, kind: "章纲", title, content });

const chapters = [chapter(176, "第 176 章 第三张薄斑入档"), chapter(177, "第 177 章 桑皮纸试制阶段总结与归档"), chapter(178, "第 178 章 失败样上桌")];
const outlines = [outline(11, "章纲｜第 177 章"), outline(12, "章纲｜第 178 章 失败样上桌"), outline(13, "阶段节拍｜第174～177章")];

describe("outline target context", () => {
  it("认章纲标题里的章号，区间与没有章号的标题不算", () => {
    expect(chapterNumberFromOutlineTitle("章纲｜第 189 章")).toBe(189);
    expect(chapterNumberFromOutlineTitle("第179章 章纲")).toBe(179);
    expect(chapterNumberFromOutlineTitle("章纲｜第一百七十九章 归乡")).toBe(179);
    expect(chapterNumberFromOutlineTitle("阶段节拍｜第174～177章")).toBeUndefined();
    expect(chapterNumberFromOutlineTitle("章纲｜还没有章号")).toBeUndefined();
  });

  // 症状：一次项目 Agent 委托里分别要写第 179、180、181 章的三份章纲，正文全写成“第179章”，
  // 运行时永远按“全书章数 + 1”定位账本，并且告诉模型“本次没有提供可用正文”
  it("按标题章号给出目标章、上一章正文与上一章章纲格式", () => {
    const context = outlineWriteTargetContext("章纲｜第 179 章", chapters, outlines);
    expect(context.targetChapter?.number).toBe(179);
    expect(context.targetChapter?.title).toBe("第 179 章");
    expect(context.sourceChapter?.number).toBe(178);
    expect(context.sourceChapter?.content).toBe("第 178 章正文");
    expect(context.formatOutline?.title).toBe("章纲｜第 178 章 失败样上桌");
    expect(chapterNumberFromOutlineTitle(context.formatOutline?.title)).toBe(178);
  });

  it("规划还没建的章时只给章号与占位标题，承接锚点回退到全书最后一章已写正文", () => {
    const context = outlineWriteTargetContext("第190章 章纲", chapters, outlines);
    expect(context.targetChapter?.id).toBe(0);
    expect(context.targetChapter?.number).toBe(190);
    expect(context.sourceChapter?.number).toBe(178);
    expect(context.sourceChapter?.title).toBe("第 178 章 失败样上桌");
    // 不是紧邻上一章，运行时据此走“指定正文分析”，不会标成承接
    expect(context.sourceChapter?.mode).toBe("全书最后一章已写正文");
  });

  it("上一章还没正文、或写第 1 章时不给承接依据", () => {    const empty = [chapter(1, "第 1 章", "")];
    expect(outlineWriteTargetContext("章纲｜第 2 章", empty, outlines).sourceChapter).toBeUndefined();
    const first = outlineWriteTargetContext("章纲｜第 1 章", chapters, outlines);
    expect(first.targetChapter?.number).toBe(1);
    expect(first.sourceChapter).toBeUndefined();
    expect(first.formatOutline).toBeUndefined();
    expect(outlineWriteTargetContext("总纲", chapters, outlines)).toEqual({});
  });

  it("覆盖本章的阶段节拍表跟着委托一起带过去", () => {
    const beats = { id: 21, kind: "章纲", title: "阶段节拍｜第179～186章", content: "| 179 | 纸背对案 |" };
    expect(stageBeatContentFor([...outlines, beats], 180)).toBe("| 179 | 纸背对案 |");
    expect(stageBeatContentFor([...outlines, beats], 187)).toBeUndefined();
    expect(stageBeatContentFor(outlines, 180)).toBeUndefined();
    // 章号没解析出来时不要去猜一章的节拍
    expect(stageBeatContentFor([...outlines, beats], undefined)).toBeUndefined();
  });
});
