import { describe, expect, it } from "vitest";
import { authorAnswersSection, projectProfileSection, selectSkillsByIntent, writingConstraintsSection } from "../src/graphs/chapter-write.graph.js";

describe("chapter skill intent selection", () => {
  const catalog = [
    { name: "story-long-write", category: "write", description: "长篇章节续写", tags: ["章节", "正文"], content: "write" },
    { name: "story-review", category: "review", description: "一致性审查", tags: ["审查", "逻辑"], content: "review" },
    { name: "story-deslop", category: "polish", description: "去 AI 味润色", tags: ["润色"], content: "polish" },
  ];

  it("selects review skills from an author's intent", () => {
    const result = selectSkillsByIntent("请检查本章逻辑和人物状态是否一致", catalog);
    expect(result.intent).toContain("审查");
    expect(result.skills.map(skill => skill.name)).toContain("story-review");
  });

  it("falls back to long-form writing when intent is implicit", () => {
    const result = selectSkillsByIntent("继续写下一章，结尾留下悬念", catalog);
    expect(result.skills[0]?.name).toBe("story-long-write");
  });
});

describe("routeChapterSkills", () => {
  const catalog = [
    { name: "story-long-write", category: "write", description: "长篇", tags: ["长篇", "大纲", "续写"], content: "a" },
    { name: "fight-scene", displayName: "战斗场面", category: "write", description: "打斗", tags: ["战斗", "打斗"], content: "b" },
    { name: "romance-beat", category: "write", description: "感情", tags: ["感情线", "告白"], content: "c" },
    { name: "story-review", category: "review", description: "审查", tags: ["审查", "章节"], content: "d" },
    { name: "story-deslop", category: "polish", description: "去 AI 味", tags: ["去 AI 味"], content: "e" },
  ];

  it("作品默认技能每章必带；章纲里出现标签才追加；审查类永不进正文；日常章只带默认", async () => {
    const { routeChapterSkills } = await import("../src/graphs/chapter-write.graph.js");
    const daily = routeChapterSkills({ catalog, defaultNames: ["story-long-write"], preferredNames: [], haystack: "两人在书房整理旧账，聊起明天的章节安排" });
    expect(daily.skills.map(skill => skill.name)).toEqual(["story-long-write"]);
    expect(daily.routed).toEqual([]);
    const fight = routeChapterSkills({ catalog, defaultNames: ["story-long-write"], preferredNames: [], haystack: "本章：码头夜战，沈妄与刺客打斗后受伤" });
    expect(fight.skills.map(skill => skill.name)).toEqual(["story-long-write", "fight-scene"]);
    expect(fight.routed.map(skill => skill.name)).toEqual(["fight-scene"]);
    // "章节"是审查技能的标签，但审查类不进正文；"续写"是流程词，不算 story-long-write 的场景命中
    expect(routeChapterSkills({ catalog, defaultNames: [], preferredNames: [], haystack: "继续写下一章节" }).skills).toEqual([]);
    // 本次勾选排在默认之后、匹配之前；上限四条
    const picked = routeChapterSkills({ catalog, defaultNames: ["story-long-write"], preferredNames: ["story-deslop"], haystack: "告白后打斗" });
    expect(picked.skills.map(skill => skill.name)).toEqual(["story-long-write", "story-deslop", "fight-scene", "romance-beat"]);
    expect(routeChapterSkills({ catalog, defaultNames: ["missing"], preferredNames: [], haystack: "" }).skills).toEqual([]);
  });
});

describe("castCards", () => {
  it("正文阶段只带构思里点到名的卡，金手指卡一律带；没有构思时全带", async () => {
    const { castCards } = await import("../src/graphs/chapter-write.graph.js");
    const cards = [
      { type: "角色卡", title: "沈妄", content: "" },
      { type: "角色卡", title: "周伯", content: "" },
      { type: "金手指卡", title: "修复之眼", content: "" },
      { type: "地点卡", title: "栖迟书肆", content: "" },
    ];
    expect(castCards(cards, "这一章只写周伯在栖迟书肆守夜，等一封信。").map(card => card.title)).toEqual(["周伯", "修复之眼", "栖迟书肆"]);
    expect(castCards(cards, undefined).map(card => card.title)).toEqual(["沈妄", "周伯", "修复之眼", "栖迟书肆"]);
    expect(castCards(undefined, "什么都没有")).toEqual([]);
  });
});

describe("projectProfileSection", () => {
  it("类型、标签、主角、简介拼成作品定位；全空返回空串", () => {
    const section = projectProfileSection({ genre: "男频", subgenre: "都市日常", tags: ["慢热高甜", "治愈"], synopsis: "核心题材：慢热高甜。", protagonists: ["沈妄", "姜冷月"] });
    expect(section).toContain("## 作品定位");
    expect(section).toContain("类型：男频 / 都市日常");
    expect(section).toContain("标签：慢热高甜、治愈");
    expect(section).toContain("主角：沈妄 × 姜冷月");
    expect(section).toContain("简介：核心题材：慢热高甜。");
    expect(projectProfileSection(undefined)).toBe("");
    expect(projectProfileSection({ tags: [], protagonists: [] })).toBe("");
  });
});

describe("authorAnswersSection", () => {
  it("只带有问有答的条目，最多二十条；空答复不进提示词", () => {
    const section = authorAnswersSection([
      { question: "沈砚的母亲是否在世？", answer: "在世，住在灯塔。" },
      { question: "电台频率要不要固定？", answer: "" },
    ]);
    expect(section).toContain("作者已答复");
    expect(section).toContain("问：沈砚的母亲是否在世？");
    expect(section).toContain("答：在世，住在灯塔。");
    expect(section).not.toContain("电台频率");
    expect(authorAnswersSection([])).toBe("");
    expect(authorAnswersSection(undefined)).toBe("");
  });
});

describe("writingConstraintsSection", () => {
  it("信息边界、到期承诺和未决问题进提示词，空的不出现", () => {
    const section = writingConstraintsSection({
      brief: { readerKnows: "读者知道灯还亮着", mustHide: "守夜人是父亲" },
      duePromises: [{ text: "灯塔的枪得响", dueChapter: 130 }],
      openQuestions: ["枪是谁的"],
    });
    // 隐瞒要写成「用别的说法盖过去」：只写「不能说破」时，模型最省事的执行方式就是让人物闭嘴、什么都不做
    expect(section).toContain("他此刻不说破的：守夜人是父亲");
    expect(section).toContain("嘴上用别的话盖过去");
    expect(section).toContain("灯塔的枪得响（期限第 130 章）");
    expect(section).toContain("每条落到一个具体场面");
    expect(section).toContain("枪是谁的");
    expect(section).toContain("只是不给出最终答案");
    // 未拍的板不许写成「可以绕开」:那是教模型什么都不做
    expect(section).not.toContain("可以绕开");
    expect(section).not.toContain("不能说破");
    expect(writingConstraintsSection({})).toBe("");
  });

  it("信息边界每章最多两条，优先留必须隐瞒与只给一半", () => {
    const section = writingConstraintsSection({
      brief: { readerKnows: "读者早就知道", protagonistKnows: "主角早就知道", mustHide: "底不能透", hintOnly: "信只露一半" },
    });
    expect(section).toContain("底不能透");
    expect(section).toContain("信只露一半");
    expect(section).not.toContain("读者早就知道");
    expect(section).not.toContain("主角早就知道");
  });
});
