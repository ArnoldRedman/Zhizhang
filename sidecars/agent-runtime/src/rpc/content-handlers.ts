import { createModelApiClient, stringList } from "../application/model-client.js";
import { compactText, contextBudgetBytes } from "../context/context-optimizer.js";
import type { RpcRegistry } from "./registry.js";

/** 从模型返回里剥掉 ```json 围栏，失败时返回原始文本 */
const parseJsonContent = (content: string): Record<string, unknown> | null => {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/u, "").trim();
  try {
    const parsed = JSON.parse(cleaned) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
};

const trimmed = (value: unknown, fallback = "") => typeof value === "string" ? value.trim() : fallback;

export const registerContentHandlers = (registry: RpcRegistry): RpcRegistry => registry
  .register("project.generate", async params => {
    const { field, source, title, synopsis, channel, tags, protagonist1, protagonist2, outlines, chapters } = params;
    if (field !== "title" && field !== "synopsis") throw new Error("缺少生成作品信息所需参数");
    const client = createModelApiClient(params, { model: "gpt-4o-mini" });
    const tagRecord = tags && typeof tags === "object" ? tags as Record<string, unknown> : {};
    const tagText = Object.entries(tagRecord).flatMap(([kind, values]) => stringList(values).map(value => `${kind}：${value}`)).join("；");
    const outlineContext = Array.isArray(outlines) && outlines.length
      ? outlines.map(item => {
        const outline = item as Record<string, unknown>;
        return `### ${String(outline.kind || "大纲")}｜${String(outline.title || "未命名")}\n${String(outline.content || "").slice(0, 5000)}`;
      }).join("\n\n")
      : "（暂无可用大纲，请根据已有作品信息构思）";
    const chapterContext = Array.isArray(chapters) && chapters.length
      ? chapters.map(item => {
        const chapter = item as Record<string, unknown>;
        return `### ${String(chapter.title || "章节")}\n${String(chapter.content || "").slice(0, 4500)}`;
      }).join("\n\n")
      : "（暂无可用章节，请根据已有作品信息构思）";
    const selectedContext = source === "chapters" ? chapterContext : outlineContext;
    const common = `频道：${String(channel || "男频")}\n标签：${tagText || "暂无"}\n主角：${[protagonist1, protagonist2].filter(Boolean).map(String).join("、") || "暂无"}\n当前书名：${String(title || "暂无")}\n已有作品简介：${String(synopsis || "暂无")}\n\n## ${source === "chapters" ? "前 3 章正文" : "作品大纲"}\n${selectedContext}`;
    const prompt = field === "title"
      ? `你是番茄小说平台的网文责编。请根据下列素材拟定一个适合${String(channel || "男频")}读者、具备题材卖点和记忆点的中文网文书名。\n\n${common}\n\n只返回 JSON：\n{ "title": "书名" }\n\n规则：书名 4 到 15 个汉字或常用数字；不要加《》、引号、作者名、解释、标点或副标题；避免与素材无关的套路词。`
      : `你是番茄小说平台的网文责编。请根据下列素材撰写可直接用于上架页的作品简介。\n\n${common}\n\n只返回 JSON：\n{ "synopsis": "作品简介" }\n\n规则：180 到 320 个中文字符，最多 500 字；开头迅速给出主角处境、核心金手指或矛盾，中段明确升级目标与风险，结尾留下强钩子；突出标签卖点和读者预期；不加标题、Markdown、分段序号、免责声明或解释；不得编造与素材矛盾的事实。`;
    const response = await client.chat([{ role: "user", content: prompt }], {
      response_format: { type: "json_object" },
      temperature: field === "title" ? 0.9 : 0.7,
      max_tokens: field === "title" ? 180 : 900,
      retryAttempts: 2,
    });
    const parsed = parseJsonContent(response.content);
    // 模型没有返回合法 JSON 时，把正文整体当作请求的那个字段
    if (!parsed) {
      const content = response.content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/u, "").trim();
      return field === "title" ? { title: content } : { synopsis: content };
    }
    return { title: trimmed(parsed.title), synopsis: trimmed(parsed.synopsis) };
  })
  .register("github.commit.describe", async params => {
    const projectTitle = String(params.projectTitle || "未命名小说");
    const changes = params.changes && typeof params.changes === "object" ? params.changes : {};
    const fallbackTitle = String(params.fallbackTitle || `更新《${projectTitle}》创作资料`);
    const fallbackBody = String(params.fallbackBody || "");
    const client = createModelApiClient(params, { model: "gpt-4o-mini" });
    const prompt = `你是 Git 提交信息编辑。程序已经计算出《${projectTitle}》本次备份的真实差异。\n\n真实差异 JSON：\n${JSON.stringify(changes, null, 2)}\n\n程序回退标题：${fallbackTitle}\n程序明细：\n${fallbackBody}\n\n只返回 JSON：{"title":"中文提交标题","body":"2-5 行中文概述"}\n规则：title 不超过 60 个字符；body 不超过 1000 个字符；只能概括给定差异，不得编造章节、人物、剧情或数量；明确说明新增几章、修改哪几章、删除哪几章，其他资料按大纲/卡片/记忆/图谱分类概括。`;
    const response = await client.chat([{ role: "user", content: prompt }], { response_format: { type: "json_object" }, temperature: 0.2, max_tokens: 800, retryAttempts: 2 });
    const parsed = parseJsonContent(response.content);
    return {
      title: trimmed(parsed?.title, fallbackTitle).replace(/[\r\n]+/gu, " ").slice(0, 60) || fallbackTitle,
      body: trimmed(parsed?.body, fallbackBody).slice(0, 1000) || fallbackBody,
    };
  })
  .register("skill.write", async params => {
    const { name, category, description, content, tags } = params;
    if (!name && !description && !content) throw new Error("缺少创建技能所需参数");
    const client = createModelApiClient(params, { model: "gpt-4o-mini" });
    const prompt = `你是 skill-creator。请把用户的小说写作需求整理成一个可复用技能。\n\n名称：${String(name || "待命名技能")}\n分类：${String(category || "write")}\n用途：${String(description || "暂无")}\n草稿：${String(content || "暂无")}\n标签：${stringList(tags).join("、") || "暂无"}\n\n只返回 JSON：\n{\n  "name": "短名称（英文 kebab-case）",\n  "category": "setup|write|review|polish|import|analyze|tool|creator",\n  "description": "一句话用途",\n  "tags": ["标签"],\n  "content": "Markdown 技能正文，包含触发条件、输入、步骤、输出格式、质量检查和失败处理"\n}\n不要输出 JSON 以外的文字。`;
    const response = await client.chat([{ role: "user", content: prompt }], { response_format: { type: "json_object" }, temperature: 0.3, max_tokens: 2200 });
    const parsed = parseJsonContent(response.content);
    if (!parsed) {
      return { name: String(name || "custom-skill"), category: String(category || "write"), description: String(description || ""), content: response.content, tags: stringList(tags, 12) };
    }
    return {
      name: trimmed(parsed.name, String(name || "custom-skill")),
      category: trimmed(parsed.category, String(category || "write")),
      description: trimmed(parsed.description, String(description || "")),
      content: trimmed(parsed.content, response.content),
      tags: stringList(parsed.tags, 12),
    };
  });

/**
 * 卡片批量刷新：按最近几章正文把每张卡的"当前状态"重写一遍
 * 逐章记忆提炼只更新本章提到的卡，十几章下来没被点名的卡状态就停在旧处；这里一次调用把全部卡对着近期正文重新校准。
 * 只改 currentState，不动卡片正文（那是作者写的设定）；没依据的卡返回空串，调用方跳过
 */
export const registerCardRefreshHandler = (registry: RpcRegistry): RpcRegistry => registry
  .register("card.refresh", async params => {
    const { projectTitle, cards, chapters, contextWindow } = params;
    const list = Array.isArray(cards) ? cards.filter(item => item && typeof item === "object").map(item => item as Record<string, unknown>) : [];
    const recent = Array.isArray(chapters) ? chapters.filter(item => item && typeof item === "object").map(item => item as Record<string, unknown>) : [];
    if (!list.length) throw new Error("没有可刷新的卡片");
    if (!recent.length) throw new Error("没有可对照的章节正文");
    const client = createModelApiClient(params, { model: "gpt-4o-mini" });
    const budget = contextBudgetBytes(Number(contextWindow) || undefined, 60, 24);
    const perChapter = Math.max(2000, Math.floor(budget / recent.length));
    const chapterText = recent.map(item => `### ${compactText(item.title || "", 60)}\n${compactText(item.content || "", perChapter)}`).join("\n\n");
    const cardText = list.map(item => `- [${compactText(item.type || "知识卡", 20)}] ${compactText(item.title || "", 60)}（id ${String(item.id)}）\n  现状：${compactText(item.currentState || "（空）", 400)}\n  设定摘录：${compactText(item.content || "", 600)}`).join("\n");
    const prompt = `你是《${String(projectTitle || "未命名小说")}》的档案员。下面是最近几章正文和全部知识卡的现状。请对照正文，把每张卡的"当前状态"改成截至最新一章的实际情况：这个人现在在哪、在做什么、和谁的关系变成了什么、手里有什么、知道了什么；地点和势力卡写现在的状态与归属。只写正文有依据的事，正文没提到、现状也没变的卡返回空字符串。每张卡的状态两三句，不超过 200 字。

## 最近几章正文
${chapterText}

## 知识卡
${cardText}

只返回 JSON：{"cards":[{"id":"卡片 id","currentState":"新的当前状态，没变化就空串"}]}`;
    const response = await client.chat([{ role: "user", content: prompt }], { response_format: { type: "json_object" }, temperature: 0.2, max_tokens: 6000, retryAttempts: 2 });
    const parsed = JSON.parse(response.content.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "")) as Record<string, unknown>;
    const updates = (Array.isArray(parsed.cards) ? parsed.cards : []).flatMap(item => {
      const entry = item && typeof item === "object" ? item as Record<string, unknown> : {};
      const currentState = String(entry.currentState || "").trim();
      const id = String(entry.id || "").trim();
      if (!id || !currentState) return [];
      return [{ id, currentState: currentState.slice(0, 600) }];
    });
    return { updates, usage: response.usage };
  });
