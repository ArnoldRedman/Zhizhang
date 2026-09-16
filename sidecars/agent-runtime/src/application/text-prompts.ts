/**
 * 整章改写的输出上限
 * 输出要和输入同量级，还得留出改写时自然变长的余量；中文一个字通常在 1 个 token 上下，
 * 这里按 1.2 倍加固定余量估，再夹在 [4000, 16000] 之间兜底。
 */
export function wholeChapterTokenBudget(content: string): number {
  const characters = content.replace(/\s/gu, "").length;
  return Math.min(16_000, Math.max(4000, Math.ceil(characters * 1.2) + 800));
}

/**
 * 按指令修订整章正文的提示词
 * 与“润色”的关键区别：允许按指令改动情节和结构，但仍禁止自己发明设定
 * 手工“修订章节”（text.transform 的 revise 模式）与审查后的自动修订共用这一份，免得两条路径的说法慢慢跑偏
 */
export function chapterRevisePrompt(input: {
  projectTitle?: unknown;
  chapterTitle?: unknown;
  instruction: string;
  content: string;
}): string {
  const instruction = input.instruction.trim() || "提升可读性和冲突强度，保留原有事实";
  return `你是中文长篇网文作者。请根据作者指令修订《${String(input.projectTitle || "未命名小说")}》${String(input.chapterTitle || "当前章节")}的整章正文。\n\n作者修订指令：${instruction}\n\n要求：按指令改动，指令没有要求的部分保持原样；不得新增与原文矛盾的人物、设定或事件；不得改写本章之外的剧情；保持叙述视角和时间线连贯；只输出完整的修订后正文，不要输出修改说明、对比、标题或 Markdown 标记。\n\n待修订正文：\n${input.content}`;
}
