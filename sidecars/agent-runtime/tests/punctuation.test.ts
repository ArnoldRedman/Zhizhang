import { describe, expect, it } from "vitest";
import { detectQuoteStyle, normalizePauses, normalizeQuotes } from "@zhizhang/contracts";

describe("normalizeQuotes", () => {
  it("「」转成“”并正确闭合", () => {
    const report = normalizeQuotes("「你来了。」她说。", "curly");
    expect(report.text).toBe("“你来了。”她说。");
    expect(report.changes).toBe(2);
    expect(report.unbalancedLines).toEqual([]);
  });

  it("一行只有开引号：记入 unbalancedLines 且该行不改，其他行照常转", () => {
    const report = normalizeQuotes("「你来了。她说。\n「好。」", "curly");
    expect(report.text).toBe("「你来了。她说。\n“好。”");
    expect(report.unbalancedLines).toEqual([1]);
    expect(report.changes).toBe(2);
  });

  it("先出现收引号也算未闭合", () => {
    expect(normalizeQuotes("」她说。「", "curly").unbalancedLines).toEqual([1]);
  });

  it("【系统】面板不动", () => {
    expect(normalizeQuotes("【系统】「任务完成。」", "curly").text).toBe("【系统】“任务完成。”");
  });

  it("ASCII 双引号按奇偶判开闭", () => {
    const report = normalizeQuotes('"你来了。"她说。"嗯。"', "curly");
    expect(report.text).toBe("“你来了。”她说。“嗯。”");
    expect(report.changes).toBe(4);
  });

  it("奇数个 ASCII 双引号算未闭合", () => {
    const report = normalizeQuotes('他说"走', "curly");
    expect(report.text).toBe('他说"走');
    expect(report.unbalancedLines).toEqual([1]);
  });

  it("“”转成「」和 ASCII", () => {
    expect(normalizeQuotes("“你来了。”", "corner").text).toBe("「你来了。」");
    expect(normalizeQuotes("“你来了。”", "ascii").text).toBe('"你来了。"');
  });

  it("嵌套的单引号与『』不转", () => {
    expect(normalizeQuotes("“他说‘走’。”", "corner").text).toBe("「他说‘走’。」");
    expect(normalizeQuotes("「他说『走』。」", "curly").text).toBe("“他说『走』。”");
  });

  it("已经是目标风格时零改动，CRLF 行尾原样保留", () => {
    expect(normalizeQuotes("“你来了。”", "curly").changes).toBe(0);
    expect(normalizeQuotes("「a」\r\n「b」\n「c」", "curly").text).toBe("“a”\r\n“b”\n“c”");
  });
});

describe("normalizePauses", () => {
  it("句中省略号换逗号", () => {
    const report = normalizePauses("他……说");
    expect(report.text).toBe("他，说");
    expect(report.changes).toBe(1);
  });

  it("数字之间的破折号换成「到」", () => {
    expect(normalizePauses("3——5 天").text).toBe("3到5 天");
  });

  it("后接「原来/因为」这类揭示语时用冒号", () => {
    expect(normalizePauses("他终于明白了……原来她早就知道。").text).toBe("他终于明白了：原来她早就知道。");
    expect(normalizePauses("他没说话……因为他也不知道。").text).toBe("他没说话：因为他也不知道。");
  });

  it("「因为……」收在句末不是冒号，而是句号", () => {
    expect(normalizePauses("因为……").text).toBe("因为。");
    expect(normalizePauses("他没去，因为……\n第二段。").text).toBe("他没去，因为。\n第二段。");
  });

  it("前接「原因/答案」这类词也用冒号", () => {
    expect(normalizePauses("原因……是他。").text).toBe("原因：是他。");
  });

  it("引号里的省略号：收引号前补句号，开引号后直接删", () => {
    expect(normalizePauses("“你……”").text).toBe("“你。”");
    expect(normalizePauses("“别——”").text).toBe("“别。”");
    expect(normalizePauses("“……你来了。”").text).toBe("“你来了。”");
  });

  it("句末标点后面的停顿符直接删", () => {
    expect(normalizePauses("他走了。……").text).toBe("他走了。");
    expect(normalizePauses("他走了，——然后呢").text).toBe("他走了，然后呢");
  });

  it("--- 分隔线整行删除", () => {
    const report = normalizePauses("第一段。\n---\n第二段。");
    expect(report.text).toBe("第一段。\n第二段。");
    expect(report.changes).toBe(1);
  });

  it("删空后粘出的新停顿符继续归一，连跑两次结果不变", () => {
    const first = normalizePauses("他.……..说");
    expect(first.text).toBe("他，说");
    const second = normalizePauses(first.text);
    expect(second.text).toBe(first.text);
    expect(second.changes).toBe(0);
  });

  it("没有停顿符时原样返回", () => {
    const report = normalizePauses("他推开门，风灌进来。\r\n她没动。");
    expect(report.text).toBe("他推开门，风灌进来。\r\n她没动。");
    expect(report.changes).toBe(0);
  });
});

describe("detectQuoteStyle", () => {
  it("返回占多数的引号风格", () => {
    expect(detectQuoteStyle("“a”“b”「c」")).toBe("curly");
    expect(detectQuoteStyle("「a」「b」“c”")).toBe("corner");
    expect(detectQuoteStyle('"a" "b"')).toBe("ascii");
  });

  it("没有引号返回 undefined，平局取弯引号", () => {
    expect(detectQuoteStyle("他推开门。")).toBeUndefined();
    expect(detectQuoteStyle("“a”「b」")).toBe("curly");
  });
});
