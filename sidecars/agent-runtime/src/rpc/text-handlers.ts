import { createModelApiClient, stringList } from "../application/model-client.js";
import { chapterRevisePrompt, paragraphAnnotationPrompt, wholeChapterTokenBudget } from "../application/text-prompts.js";
import type { RpcRegistry } from "./registry.js";

const textModes = new Set(["polish", "de-ai", "continue", "revise", "annotate"]);

export const registerTextHandlers = (registry: RpcRegistry): RpcRegistry => registry
  .register("text.transform", async params => {
    const { mode, instruction, content, previousChapter, maxWords, projectTitle, chapterTitle } = params;
    if (!content && !previousChapter) throw new Error("缺少文本处理所需参数");
    if (typeof mode !== "string" || !textModes.has(mode)) throw new Error("不支持的文本处理类型");
    const client = createModelApiClient(params, { model: "gpt-4o-mini" });
    // 按批注只改一段：输入是那一段加前后文，输出只有那一段，几百字，走非流式就够
    if (mode === "annotate") {
      const notes = stringList(params.notes, 12);
      if (!notes.length) throw new Error("缺少批注内容");
      const cards = Array.isArray(params.cards)
        ? params.cards.filter(item => item && typeof item === "object").map(item => ({ title: String((item as Record<string, unknown>).title || ""), content: String((item as Record<string, unknown>).content || "").slice(0, 4000) })).slice(0, 6)
        : [];
      const prompt = paragraphAnnotationPrompt({
        projectTitle, chapterTitle, notes, paragraph: String(content),
        before: typeof params.before === "string" ? params.before : undefined,
        after: typeof params.after === "string" ? params.after : undefined,
        cards,
      });
      const response = await client.chat([{ role: "user", content: prompt }], { temperature: 0.7, max_tokens: Math.min(4000, Math.max(800, Math.ceil(String(content).length * 2))), retryAttempts: 2 });
      return { content: response.content.trim().replace(/^```(?:markdown|text)?\s*/i, "").replace(/```$/u, "").trim() };
    }
    const extraRequirement = String(instruction || "").trim();
    const numericLimit = Math.max(1, Math.floor(Number(maxWords) || 0));
    const prompt = mode === "polish"
      ? `你是小说文字编辑。请润色以下《${String(projectTitle || "未命名小说")}》${String(chapterTitle || "当前章节")}中的文本。\n\n要求：保持原意、人物口吻、叙述视角和情节事实不变；优化表达、动作逻辑、可读性和画面感；不要新增剧情，不要解释，不要加标题或 Markdown 标记。${extraRequirement ? `\n作者额外要求：${extraRequirement}` : ""}\n\n待润色文本：\n${String(content)}`
      : mode === "revise"
        // 修订与润色的关键区别：允许按作者指令改动情节和结构，但仍禁止自己发明设定
        ? chapterRevisePrompt({ projectTitle, chapterTitle, instruction: extraRequirement, content: String(content) })
      : mode === "de-ai"
        ? `你是小说文字编辑。请为以下《${String(projectTitle || "未命名小说")}》${String(chapterTitle || "当前章节")}的文本去除机械化 AI 写作痕迹。\n\n要求：保持原意、人物、叙述视角、事实、情节与既有文风不变；拆除模板化套话、均匀句式、总结腔和机械因果衔接；优先使用准确的动作、感官细节与角色化表达；不要新增剧情、设定、人物或信息，不要解释，不加标题或 Markdown 标记。${extraRequirement ? `\n作者额外要求：${extraRequirement}` : ""}\n\n待改写文本：\n${String(content)}`
      : `你是长篇网络小说作者。请为《${String(projectTitle || "未命名小说")}》的${String(chapterTitle || "当前章节")}续写一段可直接插入正文的内容。\n\n要求：只输出续写正文，不复述已有内容，不加标题、注释或 Markdown 标记；承接已有的叙事视角、人物状态、时间线和文风；推进一个明确动作或事件，并自然收束在可继续写作的位置；输出不得超过 ${numericLimit} 个非空白字符。${extraRequirement ? `\n作者续写要求：${extraRequirement}` : ""}\n\n上一章结尾（仅在当前章为空时优先承接）：\n${String(previousChapter || "无")}\n\n当前章节已有内容：\n${String(content || "（当前章为空，请承接上一章）")}`;
    const options = {
      temperature: mode === "continue" ? 0.75 : mode === "de-ai" ? 0.45 : mode === "revise" ? 0.6 : 0.35,
      // 整章改写的输出长度和输入同量级：润色、去 AI 味、修订都会重写整章，
      // 固定 5000 会把三千字以上的章节从中间截断，作者看到的是“后半章没了”
      max_tokens: mode === "continue"
        ? Math.min(7000, Math.max(500, Math.ceil(numericLimit * 1.6)))
        : wholeChapterTokenBudget(String(content || "")),
      retryAttempts: mode === "continue" ? 2 : 3,
    };
    // 整章改写走流式：六千字的章节要生成一两分钟，非流式时网关全程收不到任何字节，
    // 会在模型写完之前先切断连接并回 524；而重试发出去的是同一个同样慢的请求，重几次都还是 524。
    // 流式下字节持续流动，网关不会认为源站卡死；中途真断了也能带着已生成的半章接着写完。
    const response = mode === "continue"
      ? await client.chat([{ role: "user", content: prompt }], options)
      : await client.chatStream([{ role: "user", content: prompt }], options);
    let result = response.content.trim().replace(/^```(?:markdown|text)?\s*/i, "").replace(/```$/u, "").trim();
    if (mode === "continue" && numericLimit > 0 && Array.from(result.replace(/\s/gu, "")).length > numericLimit) {
      const limited = Array.from(result).slice(0, numericLimit).join("");
      const ending = Math.max(limited.lastIndexOf("。"), limited.lastIndexOf("！"), limited.lastIndexOf("？"));
      result = (ending > numericLimit * 0.55 ? limited.slice(0, ending + 1) : limited).trim();
    }
    return { content: result };
  });
