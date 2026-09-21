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

/**
 * 按作者批注只改一段的提示词
 * 与整章修订的区别：模型只看到要改的那一段和前后文，输出也只有那一段，其余正文根本不经过模型，不会被顺手磨平
 */
export function paragraphAnnotationPrompt(input: {
  projectTitle?: unknown;
  chapterTitle?: unknown;
  /** 作者的批注，一条一句；同一段多条批注一起给 */
  notes: string[];
  paragraph: string;
  before?: string;
  after?: string;
  /** 段落里出场人物的卡片，让模型按性格改台词与动作 */
  cards?: Array<{ title: string; content: string }>;
}): string {
  const cards = (input.cards || []).filter(card => card.title.trim() && card.content.trim());
  const cardsSection = cards.length ? `\n\n## 这段里的人物\n${cards.map(card => `### ${card.title}\n${card.content}`).join("\n\n")}` : "";
  const beforeSection = input.before ? `\n\n## 这段之前的正文（不改，只供衔接）\n${input.before}` : "";
  const afterSection = input.after ? `\n\n## 这段之后的正文（不改，只供衔接）\n${input.after}` : "";
  return `你是中文长篇网文作者。作者在《${String(input.projectTitle || "未命名小说")}》${String(input.chapterTitle || "当前章节")}的下面这一段旁边写了批注，请按批注把这一段改好。\n\n## 作者批注\n${input.notes.map((note, index) => `${index + 1}. ${note}`).join("\n")}${cardsSection}${beforeSection}\n\n## 要改的这一段\n${input.paragraph}${afterSection}\n\n只输出改后的这一段正文，长度与原段相当，开头结尾要能接上前后文；不输出前后文、说明、标题或 Markdown 标记。`;
}
