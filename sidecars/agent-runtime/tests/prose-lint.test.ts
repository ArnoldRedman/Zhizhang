import { describe, expect, it } from "vitest";
import { classifyEnding, classifyOpening, firstSentence, hasBlocking, lastSentence, lintProse, type LintContext } from "@zhizhang/contracts";

const types = (text: string, context?: LintContext) => lintProse(text, context).map(item => item.type);
const of = (text: string, type: string, context?: LintContext) => lintProse(text, context).filter(item => item.type === type);
/** 造几段互不相同、不含任何句式指纹的叙述，每段约 45 个可见字 */
const filler = (count: number) => Array.from({ length: count }, (_, index) => `他数到${index + 1}，把茶壶放回炉边，窗外的雨还在下，巷子里的灯一盏一盏亮起来，卖馄饨的推车吱呀吱呀往东去了。`).join("\n\n");

describe("not-is-comparison", () => {
  it("「不是A，而是B」命中，位置落在「不是」上", () => {
    const [hit] = of("他不是冷漠，而是绝望。", "not-is-comparison");
    expect(hit.severity).toBe("blocking");
    expect(hit.line).toBe(1);
    expect(hit.column).toBe(2);
    expect(hit.excerpt).toBe("不是冷漠，而是绝望");
  });

  it("对话里的「不是…是不是」不命中", () => {
    expect(types("“你不是说好了吗，是不是？”")).not.toContain("not-is-comparison");
  });

  it("「不是A就是B」不命中", () => {
    expect(types("他不是在书房就是在后院。")).not.toContain("not-is-comparison");
  });

  it("「是的，他还记得」是承接确认，不命中", () => {
    expect(types("这不是第一次来。是的，他还记得那扇门。")).not.toContain("not-is-comparison");
  });

  it("跨空行的「不是A。是B」也抓", () => {
    const [hit] = of("这不是巧合。\n\n是有人安排的。", "not-is-comparison");
    expect(hit.line).toBe(1);
  });
});

describe("reverse-not-is", () => {
  it("「是A，不是B」命中", () => {
    expect(of("是真嗓子，不是修音修出来的。", "reverse-not-is")[0].severity).toBe("blocking");
  });

  it("「还是」合成词、「是不是」问句、「不是吗」反问都不命中", () => {
    expect(types("他还是没来，不是不想来。")).not.toContain("reverse-not-is");
    expect(types("你是不是忘了，不是说好了吗。")).not.toContain("reverse-not-is");
    expect(types("他是走了，不是吗？")).not.toContain("reverse-not-is");
  });
});

describe("negation-parade", () => {
  it("「没有X，没有Y，」连排命中", () => {
    expect(of("没有伴奏，没有和声，没有提词器。", "negation-parade")).toHaveLength(1);
  });

  it("「没X，没有Y。只是Z」命中", () => {
    expect(of("他没炫技，没有那种架势。他只是唱。", "negation-parade")).toHaveLength(1);
  });

  it("黏着语素「沉没」和单个否定不命中", () => {
    expect(types("船沉没在雾里，没人回头，只有风。")).not.toContain("negation-parade");
    expect(types("没有人回答。")).not.toContain("negation-parade");
  });
});

describe("voice-contrast", () => {
  it("「声音不大，却…」命中", () => {
    const [hit] = of("声音不大，却带着不容置疑的力量。", "voice-contrast");
    expect(hit.excerpt).toBe("声音不大，却");
  });

  it("句号断开后不命中", () => {
    expect(types("声音不大。她转过身。")).not.toContain("voice-contrast");
  });

  it("台词里的不命中", () => {
    expect(types("“声音不大，却很清楚。”")).not.toContain("voice-contrast");
  });
});

describe("em-dash", () => {
  it("破折号命中", () => {
    expect(of("他愣住了——门开了。", "em-dash")[0].column).toBe(5);
  });

  it("没有破折号不命中；标题、列表、分隔线里的不算", () => {
    expect(types("他愣住了，门开了。")).not.toContain("em-dash");
    expect(types("# 标题——带破折号\n\n- 列表——项\n\n---\n\n正文。")).not.toContain("em-dash");
  });
});

describe("trailer-ending / trailer-summary", () => {
  it("文末「才刚刚开始」命中", () => {
    const [hit] = of(`${filler(15)}\n\n属于他的反击才刚刚开始。`, "trailer-ending");
    expect(hit.severity).toBe("blocking");
    expect(hit.excerpt).toBe("才刚刚开始");
  });

  it("同一句放在文首、后面还有六百字时不命中", () => {
    expect(types(`属于他的反击才刚刚开始。\n\n${filler(15)}`)).not.toContain("trailer-ending");
  });

  it("「这一夜注定…」命中总结体，否定认知「不知道这一切意味着什么」不命中", () => {
    expect(of("这一夜注定无人入眠。", "trailer-summary")).toHaveLength(1);
    expect(types("他不知道这一切意味着什么。")).not.toContain("trailer-summary");
  });
});

describe("verbatim-repeat", () => {
  it("同一 ≥12 字叙述句出现 3 次命中，只报首次出现处", () => {
    const hits = of("他把钥匙插进锁孔转了两圈。门没开。\n\n她看了看表。他把钥匙插进锁孔转了两圈。\n\n风停了。他把钥匙插进锁孔转了两圈。", "verbatim-repeat");
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(1);
    expect(hits[0].message).toContain("3 次");
  });

  it("对话「“叮咚~”」重复 3 次不命中", () => {
    expect(types("“叮咚~”\n“叮咚~”\n“叮咚~”")).not.toContain("verbatim-repeat");
  });

  it("紧邻整行重复命中", () => {
    expect(of("他推开门走进去看见桌上的信。\n他推开门走进去看见桌上的信。", "verbatim-repeat")[0].line).toBe(2);
  });
});

describe("truncated", () => {
  it("末行没有句末标点命中", () => {
    const [hit] = of("他推开门。\n\n他把门推开，看见", "truncated");
    expect(hit.line).toBe(3);
    expect(hit.column).toBe(8);
  });

  it("末行以句号或收引号结尾不命中", () => {
    expect(types("他把门推开。")).not.toContain("truncated");
    expect(types("他把门推开。\n\n“走吧。”")).not.toContain("truncated");
  });
});

describe("placeholder-leak", () => {
  it("括号省略、未完待续、AI 自指命中", () => {
    expect(of("（此处省略三百字）", "placeholder-leak")[0].severity).toBe("blocking");
    expect(of("未完待续", "placeholder-leak")).toHaveLength(1);
    expect(of("作为AI，我无法继续写下去。", "placeholder-leak")).toHaveLength(1);
  });

  it("台词里的「作为AI」是合法对话，不命中", () => {
    expect(types("“作为AI，我会保护你。”")).not.toContain("placeholder-leak");
  });
});

describe("meta-leak", () => {
  it("一级词「细纲」命中 blocking", () => {
    const [hit] = of("按细纲，他该在这里转身。", "meta-leak");
    expect(hit.severity).toBe("blocking");
    expect(hit.column).toBe(2);
  });

  it("二级词「上一章」命中 advisory", () => {
    expect(of("上一章的事他还没缓过来。", "meta-leak")[0].severity).toBe("advisory");
  });

  it("一级词落在台词里降为 advisory", () => {
    expect(of("“细纲上没有这一段。”他说。", "meta-leak")[0].severity).toBe("advisory");
  });

  it("标题行「第 12 章 夜访」不命中", () => {
    expect(types("第 12 章 夜访\n\n他推开门。")).not.toContain("meta-leak");
  });

  it("front matter 与代码围栏里的工程词不命中", () => {
    expect(types("---\ntitle: 第一章\nsummary: 按细纲写\n---\n\n他推开门。")).not.toContain("meta-leak");
    expect(types("```\n按细纲——\n```\n他推开门。")).toEqual([]);
  });
});

describe("period-stutter", () => {
  it("连续 6 个短句命中", () => {
    expect(of("他起身。开门。风进来。灯灭了。他站着。没动。", "period-stutter")).toHaveLength(1);
  });

  it("中间有长句就不命中", () => {
    expect(types("他起身。开门。风从巷子那头一路灌过来吹得纸页哗哗响。灯灭了。他站着。没动。")).not.toContain("period-stutter");
  });
});

describe("long-paragraph", () => {
  it("超过 200 字命中，正好 200 字不命中", () => {
    expect(of(`${"字".repeat(200)}。`, "long-paragraph")).toHaveLength(1);
    expect(types(`${"字".repeat(199)}。`)).not.toContain("long-paragraph");
  });
});

describe("micro-action-tic", () => {
  it("「了一下」5 处命中", () => {
    expect(of("他看了一下表，又敲了一下门，退了一下，愣了一下，笑了一下。", "micro-action-tic")).toHaveLength(1);
  });

  it("两处不命中", () => {
    expect(types("他看了一下表，又敲了一下门。")).not.toContain("micro-action-tic");
  });
});

describe("stock-reaction-tic", () => {
  it("指尖、喉结、眼眶、声音放轻 4 处命中", () => {
    expect(of("指尖轻轻叩着桌面。喉结滚了一下。眼眶红了。声音放轻了些。", "stock-reaction-tic")).toHaveLength(1);
  });

  it("两处不命中", () => {
    expect(types("指尖轻轻叩着桌面。眼眶红了。")).not.toContain("stock-reaction-tic");
  });
});

describe("action-list-tic", () => {
  it("同段 5 个动作动词加 4 个逗号命中", () => {
    expect(of("他伸手拿起杯子，放下，转身走到窗边，抬头看着外面，低头坐下。", "action-list-tic")).toHaveLength(1);
  });

  it("动词多但没有逗号串联不命中", () => {
    expect(types("他伸手拿起杯子。放下。转身走到窗边。抬头看着外面。")).not.toContain("action-list-tic");
  });
});

describe("abstract-summary-tic", () => {
  it("命运大词 3 处命中", () => {
    expect(of("从这一刻开始，他有了前所未有的清醒。这是新的开始。", "abstract-summary-tic")).toHaveLength(1);
  });

  it("一处不命中", () => {
    expect(types("从这一刻开始，他不再回头。")).not.toContain("abstract-summary-tic");
  });
});

describe("cliche-density-tic", () => {
  it("套词 8 处以上命中", () => {
    expect(of("他仿佛看见一丝光。她缓缓抬头，微微一笑，轻轻点头，淡淡地说。眼中闪过不容置疑的神色，心头一震。", "cliche-density-tic")).toHaveLength(1);
  });

  it("两处不命中", () => {
    expect(types("他仿佛看见一丝光。")).not.toContain("cliche-density-tic");
  });
});

describe("metaphor-density-tic", () => {
  it("比喻标记 7 处命中", () => {
    expect(of("他像一块石头。她像水。风像刀。夜像墨。心像火。手像冰一样。声音仿佛来自远处。", "metaphor-density-tic")).toHaveLength(1);
  });

  it("「头像」「不像」不算比喻", () => {
    expect(types("他换了头像。她不像以前了。")).not.toContain("metaphor-density-tic");
  });
});

describe("reasoning-chain-tic", () => {
  it("判断链聚集命中", () => {
    expect(of("他知道这意味着什么。也就是说，必须判断风险。她明白，只有这样才能控制局面。问题在于结果。", "reasoning-chain-tic")).toHaveLength(1);
  });

  it("单个「知道」不命中", () => {
    expect(types("他知道她在等。")).not.toContain("reasoning-chain-tic");
  });
});

describe("quote-emphasis-tic", () => {
  it("叙述里短词加引号 3 处命中", () => {
    expect(of("他是被请来“把关”的。这是“规矩”。所谓“面子”，不过如此。", "quote-emphasis-tic")).toHaveLength(1);
  });

  it("引语动词邻接的极短台词和【】面板不算", () => {
    expect(types("他说“走”。她答“好”。他喊“停”。【系统】")).not.toContain("quote-emphasis-tic");
  });
});

describe("formulaic-parallelism", () => {
  it("「至于X不X，怎么X」命中", () => {
    expect(of("至于去不去，怎么去，他没想过。", "formulaic-parallelism")).toHaveLength(1);
  });

  it("跨段「不是… / 也不是… / 只是…」命中", () => {
    const [hit] = of("不是他不想去。\n也不是他没时间。\n只是他不敢。", "formulaic-parallelism");
    expect(hit.line).toBe(1);
  });

  it("点单式「不放辣，不放葱」对象太短不命中", () => {
    expect(types("不放辣，不放葱。")).not.toContain("formulaic-parallelism");
  });
});

describe("allowedPhrases", () => {
  it("命中落在允许片段内的风格类 finding 跳过", () => {
    expect(types("声音不大，却带着不容置疑的力量。", { allowedPhrases: ["声音不大，却带着不容置疑的力量"] })).not.toContain("voice-contrast");
    expect(types("他不是冷漠，而是绝望。", { allowedPhrases: ["", "不是冷漠，而是绝望"] })).not.toContain("not-is-comparison");
  });

  it("meta-leak 与 truncated 不豁免", () => {
    expect(of("按细纲，他转身。", "meta-leak", { allowedPhrases: ["按细纲"] })[0].severity).toBe("blocking");
    expect(types("他把门推开，看见", { allowedPhrases: ["他把门推开，看见"] })).toContain("truncated");
  });
});

describe("classifyOpening / classifyEnding", () => {
  it("开头三型", () => {
    expect(classifyOpening("周三上午，他到了码头。")).toBe("报时式");
    expect(classifyOpening("周三上午他到了码头然后去了很远的地方，")).toBe("other");
    expect(classifyOpening("灯亮了一夜，他没合眼。")).toBe("灯夜式");
    expect(classifyOpening("钥匙在锁孔里转了两圈。")).toBe("钥匙式");
    expect(classifyOpening("他推开门。")).toBe("other");
  });

  it("结尾三型", () => {
    expect(classifyEnding("他把灯关了。")).toBe("灯上收尾");
    expect(classifyEnding("她站着没动。")).toBe("否定静止式");
    expect(classifyEnding("新的一天开始了。")).toBe("抒情升华式");
    expect(classifyEnding("门开了。")).toBe("other");
  });
});

describe("firstSentence / lastSentence", () => {
  it("跳过标题行取第一句，末句带上收引号", () => {
    expect(firstSentence("第 12 章 夜访\n\n他推开门。风灌进来。")).toBe("他推开门。");
    expect(lastSentence("他推开门。风灌进来。\n\n她说：“别等了。”")).toBe("她说：“别等了。”");
    expect(lastSentence("他放下杯子。灯还亮着。")).toBe("灯还亮着。");
    expect(lastSentence("“走吧。”她说。")).toBe("她说。");
    expect(firstSentence("")).toBe("");
  });
});

describe("opening-echo / ending-echo", () => {
  const text = "周三上午，他到了码头。\n\n船还没来。他把灯关了。";

  it("最近三章开头都是报时式，本章也是 → blocking", () => {
    const [hit] = of(text, "opening-echo", { recentOpenings: ["周一清晨，她出门了。", "傍晚，雨停了。", "次日，他回来了。"] });
    expect(hit.severity).toBe("blocking");
    expect(hit.line).toBe(1);
  });

  it("只有一章同型 → advisory；五章里最后三章同型才升 blocking", () => {
    expect(of(text, "opening-echo", { recentOpenings: ["他推开门。", "傍晚，雨停了。"] })[0].severity).toBe("advisory");
    expect(of(text, "opening-echo", { recentOpenings: ["他推开门。", "钥匙在门上。", "周一，她走了。", "傍晚，雨停了。", "次日，他回来了。"] })[0].severity).toBe("blocking");
    expect(of(text, "opening-echo", { recentOpenings: ["周一，她走了。", "傍晚，雨停了。", "他推开门。"] })[0].severity).toBe("advisory");
  });

  it("本章或对方是 other 都不算", () => {
    expect(types("他推开门。", { recentOpenings: ["周一，她走了。", "傍晚，雨停了。", "次日，他回来了。"] })).not.toContain("opening-echo");
    expect(types(text, { recentOpenings: ["他推开门。", "她坐下。", "门开了。"] })).not.toContain("opening-echo");
  });

  it("结尾同型：三章都落在灯上 → blocking，一章 → advisory", () => {
    const [hit] = of(text, "ending-echo", { recentEndings: ["灯灭了。", "她把灯拧暗。", "灯还亮着。"] });
    expect(hit.severity).toBe("blocking");
    expect(hit.line).toBe(3);
    expect(of(text, "ending-echo", { recentEndings: ["灯灭了。"] })[0].severity).toBe("advisory");
    expect(types(text, { recentEndings: ["门开了。"] })).not.toContain("ending-echo");
  });
});

describe("silence-density", () => {
  it("五百字里 3 个沉默词命中", () => {
    expect(of(`${filler(10)}\n\n他没问。她默默收拾碗筷。他没问第二遍。`, "silence-density")).toHaveLength(1);
  });

  it("一个「点头」不命中，台词里的不算", () => {
    expect(types(`${filler(10)}\n\n他点头。`)).not.toContain("silence-density");
    expect(types("“我没问，也没说话，默默走了。”")).not.toContain("silence-density");
  });
});

describe("dialogue-sparse", () => {
  it("九百字没有一行对话命中", () => {
    expect(of(filler(20), "dialogue-sparse")).toHaveLength(1);
  });

  it("每千字 3 行对话或全文不足 800 字都不命中", () => {
    expect(types(`${filler(20)}\n\n“走吧。”\n\n「不走。」\n\n"那你等着。"`)).not.toContain("dialogue-sparse");
    expect(types(filler(10))).not.toContain("dialogue-sparse");
  });
});

describe("outline-copy", () => {
  const outline = "情节点：他把那封没有寄出去的信塞回抽屉的最底层压好，然后去开门。\n目标情绪：压抑。";

  it("章纲里一句 20 字原样出现在正文命中，位置指向正文行列", () => {
    const [hit] = of("第一段。\n\n他把那封没有寄出去的信塞回抽屉的最底层压好，转身去开门。", "outline-copy", { outline });
    expect(hit.severity).toBe("advisory");
    expect(hit.line).toBe(3);
    expect(hit.column).toBe(1);
    expect(hit.excerpt.length).toBeGreaterThanOrEqual(16);
  });

  it("只重合 10 字不命中；没给 outline 不查", () => {
    expect(types("他把那封没有寄出去的信撕了，转身去开门。", { outline })).not.toContain("outline-copy");
    expect(types("他把那封没有寄出去的信塞回抽屉的最底层压好，转身去开门。")).not.toContain("outline-copy");
  });
});

describe("lintProse 整体", () => {
  it("正常段落没有 blocking，结果按行列排序", () => {
    const findings = lintProse("老周把最后一筐橘子搬上车，拍了拍手上的灰。\n\n“今年的价钱不好。”他说。\n\n儿子没接话，把绳子又勒紧了一圈。");
    expect(hasBlocking(findings)).toBe(false);
    const mixed = lintProse("他不是冷漠，而是绝望。\n\n声音不大，却带着笑。他愣住了——门开了。");
    expect(mixed.map(item => [item.line, item.type])).toEqual([[1, "not-is-comparison"], [3, "voice-contrast"], [3, "em-dash"]]);
    expect(hasBlocking(mixed)).toBe(true);
  });
});

describe("terse-dialogue", () => {
  it("四字以内的对话行占三成以上且够密才报；正常对话不报", () => {
    const terse = Array.from({ length: 8 }, (_, index) => ["“嗯。”", "“多久。”", "“收了。”", "“拆吧。”", "“我去。”", "“走吧。”", "“结果。”", "“这回。”"][index]).join("\n\n");
    const hits = of(`${filler(20)}\n\n${terse}\n\n“他走了。”\n\n“你去问问周伯，他昨晚回来得晚。”`, "terse-dialogue");
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("advisory");
    expect(hits[0].message).toContain("电报体对话");
    const normal = Array.from({ length: 12 }, (_, index) => `“今天先不去城西，等湿度稳了再说，第${index + 1}批纸坏了四十一张。”`).join("\n\n");
    expect(types(`${filler(20)}\n\n${normal}\n\n“嗯。”\n\n“好。”`)).not.toContain("terse-dialogue");
  });
});
