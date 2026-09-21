import { describe, expect, it } from "vitest";
import { benchmarkDraftSection, benchmarkPlanSection, normalizeBenchmark } from "../src/application/benchmark.js";

const aggregate = {
  anchors: [
    { tone: "热血", source: "第 3 章", point: "爆发前先压三拍", excerpt: "原文热血段落。" },
    { tone: "悲伤", source: "第 9 章", point: "", excerpt: "原文悲伤段落。" },
    { tone: "", source: "", point: "", excerpt: "" },
  ],
  emotionModules: [
    { id: "EM-001", name: "被低估者翻盘", readerNeed: "看他打脸", trigger: "当众被贬", arc: "忍 → 爆 → 众人失语", replaceable: "场合、对手", antiCopy: "换掉打脸的道具与台词", tone: "热血" },
    { id: "", name: "", readerNeed: "", trigger: "", arc: "", replaceable: "", antiCopy: "", tone: "" },
  ],
  rhythm: "| 信息 | 首次出现 |",
};

describe("benchmark", () => {
  it("normalizeBenchmark 只收有 excerpt 的锚点与有名字的模块；空的或不是对象的按没绑对标", () => {
    const benchmark = normalizeBenchmark(aggregate);
    expect(benchmark?.anchors.map(item => item.tone)).toEqual(["热血", "悲伤"]);
    expect(benchmark?.emotionModules.map(item => item.name)).toEqual(["被低估者翻盘"]);
    expect(normalizeBenchmark(undefined)).toBeUndefined();
    expect(normalizeBenchmark({ anchors: [], emotionModules: [], rhythm: "只有节奏表" })).toBeUndefined();
  });

  it("构思阶段带全部情绪模块与节奏表；正文阶段只带与构思基调相同的一段锚点和一张模块，对不上就不带", () => {
    const benchmark = normalizeBenchmark(aggregate);
    const plan = benchmarkPlanSection(benchmark);
    expect(plan).toContain("EM-001 被低估者翻盘（热血）");
    expect(plan).toContain("| 信息 | 首次出现 |");
    expect(plan).not.toContain("原文热血段落");

    const matched = benchmarkDraftSection(benchmark, "这一章情绪从压抑走到热血，结尾停在他抬手那一下。");
    expect(matched.anchorTone).toBe("热血");
    expect(matched.section).toContain("原文热血段落");
    expect(matched.section).toContain("被低估者翻盘");
    expect(matched.section).not.toContain("原文悲伤段落");
    expect(matched.section).toContain("不抄字句");

    expect(benchmarkDraftSection(benchmark, "这一章是温馨日常。").section).toBe("");
    expect(benchmarkDraftSection(benchmark, undefined).section).toBe("");
    expect(benchmarkDraftSection(undefined, "热血").section).toBe("");
  });
});
