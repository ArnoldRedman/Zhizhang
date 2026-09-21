import { describe, expect, it } from "vitest";
import { projectProfileSection, selectSkillsByIntent } from "../src/graphs/chapter-write.graph.js";

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
