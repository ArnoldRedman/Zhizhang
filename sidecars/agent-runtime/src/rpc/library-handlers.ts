import { compactText, contextBudgetBytes } from "../context/context-optimizer.js";
import { createModelApiClient, stringList } from "../application/model-client.js";
import {
  qianyueSources, webBookSources, searchQianyueSource, searchConfiguredBookSource, searchFanqieSource,
  searchAllBookSources, fetchNovelCatchRankingCategories, fetchQidianRanking, fetchFalooRanking,
  fetchNovelCatchRanking, downloadFanqieChapter, downloadFallbackChapter, downloadQianyueChapter,
  downloadConfiguredBookChapter, downloadQianyueSource, downloadConfiguredBookSource, downloadFanqieBook,
} from "../sources/library-service.js";
import type { RpcRegistry } from "./registry.js";

export const registerLibraryHandlers = (registry: RpcRegistry): RpcRegistry => registry
  .register("book.search", async params => {
    const { query, source } = params;
    if (!String(query || "").trim()) throw new Error("请输入书名或作者");
    const sourceId = String(source || "fanqie");
    const searchQuery = String(query).trim();
    if (sourceId.startsWith("qianyue-")) {
      const definition = qianyueSources.find(item => item.id === sourceId);
      if (!definition) throw new Error("未知千阅小说书源");
      return { books: await searchQianyueSource(definition, searchQuery, params), sourceId, sourceName: definition.name };
    }
    if (sourceId !== "fanqie") {
      const definition = webBookSources.find(item => item.id === sourceId);
      if (!definition) throw new Error("未知书源");
      return { books: await searchConfiguredBookSource(definition, searchQuery, params), sourceId, sourceName: definition.name };
    }
    const result = await searchFanqieSource(searchQuery, params);
    return { ...result, sourceId: "fanqie", sourceName: "番茄小说" };
  })
  .register("book.search.all", async params => {
    const query = String(params.query || "").trim();
    if (!query) throw new Error("请输入书名或作者");
    return await searchAllBookSources(query, params);
  })
  .register("book.sources.list", async params => {
    return { sources: [{ id: "fanqie", name: "番茄小说" }, ...qianyueSources.map(source => ({ id: source.id, name: source.name })), ...webBookSources.map(source => ({ id: source.id, name: source.name }))], defaultSourceId: "qianyue-kuwo" };
  })
  .register("ranking.categories", async params => {
    return { sections: await fetchNovelCatchRankingCategories(params) };
  })
  .register("ranking.fetch", async params => {
    const { platform, rankType, gender, rankUrl } = params;
    const selectedPlatform = String(platform || "fanqie");
    const type = String(rankType || "read");
    const selectedGender = String(gender || "all");
    if (selectedPlatform === "qidian") return { books: await fetchQidianRanking(type, selectedGender, params), fetchedAt: new Date().toISOString() };
    if (selectedPlatform === "faloo") return { books: await fetchFalooRanking(type, selectedGender, params), fetchedAt: new Date().toISOString() };
    if (selectedPlatform !== "fanqie") throw new Error("未知扫榜平台");
    const books = await fetchNovelCatchRanking(type, selectedGender, typeof rankUrl === "string" ? rankUrl : undefined, params);
    if (!books.length) throw new Error("NovelCatch 番茄官方榜单没有返回书籍，请稍后刷新");
    return { books: books.slice(0, 60), fetchedAt: new Date().toISOString(), sourceName: "番茄小说网" };
  })
  .register("book.chapter.download", async params => {
    const { source, sourceBookId, chapter } = params;
    const sourceId = String(source || "").trim();
    if (!sourceId) throw new Error("该书籍缺少书源信息，无法重试本章");
    if (!chapter || typeof chapter !== "object") throw new Error("缺少需要重新下载的章节");
    const currentChapter = chapter as Record<string, unknown>;
    if (sourceId === "fanqie") {
      const chapterId = String(currentChapter.url || "").match(/\/reader\/(\d+)/u)?.[1];
      if (!chapterId) throw new Error("该番茄章节缺少有效地址");
      const result = await downloadFanqieChapter({
        id: chapterId,
        title: String(currentChapter.title || "未命名章节"),
        url: String(currentChapter.url),
        locked: false,
      }, Number(currentChapter.number) || 1, String(sourceBookId || ""), params);
      if (result.downloaded === true) return { chapter: result };
      const fallback = await downloadFallbackChapter(
        String(params.bookTitle || ""),
        Number(currentChapter.number) || 1,
        String(currentChapter.title || ""),
        Number(result.expectedWords) || 0,
        params,
      );
      if (fallback) {
        return {
          chapter: {
            ...result,
            ...fallback,
            id: result.id,
            number: result.number,
            title: result.title,
            url: result.url,
            unavailableReason: undefined,
            downloaded: true,
          },
        };
      }
      return { chapter: result };
    }
    if (sourceId.startsWith("qianyue-")) {
      const definition = qianyueSources.find(item => item.id === sourceId);
      if (!definition) throw new Error("未知千阅小说书源");
      return { chapter: await downloadQianyueChapter(definition, currentChapter, params) };
    }
    const definition = webBookSources.find(item => item.id === sourceId);
    if (!definition) throw new Error("未知书源");
    return { chapter: await downloadConfiguredBookChapter(definition, currentChapter, params) };
  })
  .register("book.download", async params => {
    const { title, author, source, sourceBookId, url, maxChapters } = params;
    const sourceId = String(source || "fanqie");
    if (!String(url || "").trim()) throw new Error("缺少可下载的书籍地址");
    if (sourceId.startsWith("qianyue-")) {
      const definition = qianyueSources.find(item => item.id === sourceId);
      if (!definition) throw new Error("未知千阅小说书源");
      const chapters = await downloadQianyueSource(definition, String(url), params, Number(maxChapters) || Number.MAX_SAFE_INTEGER);
      return { title: String(title || "未命名书籍"), author: String(author || "未知作者"), sourceId, sourceName: definition.name, sourceBookId: String(sourceBookId || url), chapters };
    }
    if (sourceId !== "fanqie") {
      const definition = webBookSources.find(item => item.id === sourceId);
      if (!definition) throw new Error("未知书源");
      const chapters = await downloadConfiguredBookSource(definition, String(url), params, Number(maxChapters) || Number.MAX_SAFE_INTEGER);
      return { title: String(title || "未命名书籍"), author: String(author || "未知作者"), sourceId, sourceName: definition.name, sourceBookId: String(sourceBookId || url), chapters };
    }
    const chapters = await downloadFanqieBook(String(url), String(sourceBookId || ""), params, Number(maxChapters) || Number.MAX_SAFE_INTEGER);
    const downloadedChapterCount = chapters.filter(chapter => String(chapter.content || "").trim()).length;
    if (!downloadedChapterCount) throw new Error("番茄正文没有返回有效内容，未保存空章节；请稍后重试或导入 TXT");
    const completedChapterCount = chapters.filter(chapter => chapter.downloaded === true).length;
    return { title: String(title || "未命名书籍"), author: String(author || "未知作者"), sourceBookId: String(sourceBookId || ""), chapters, downloadedChapterCount, completedChapterCount };
  })
  .register("ranking.analyze", async params => {
    const { books, platform, rankType, gender, contextWindow } = params;
    if (!Array.isArray(books) || books.length === 0) throw new Error("缺少榜单样本或模型配置");
    const client = createModelApiClient(params, { model: "gpt-4o-mini" });
    const samples = books.slice(0, 60).map((item, index) => {
      const book = item && typeof item === "object" ? item as Record<string, unknown> : {};
      return `${index + 1}. ${compactText(book.title || "未命名", 80)}｜${compactText(book.author || "未知", 40)}｜${compactText(book.category || "未分类", 40)}｜${compactText(book.intro || "", 260)}`;
    }).join("\n");
    const prompt = `你执行 story-long-scan 扫榜技能。根据${String(platform || "番茄小说")} ${String(gender || "全部频道")} ${String(rankType || "read")}榜样本，输出一份可供原创选题使用的市场盘点。\n\n要求：仅分析样本里可观察到的题材、标题、卖点、人物关系和开篇承诺；区分“样本证据”和“推断”；不建议复制具体作品、人名、世界观或桥段。\n\n使用以下 Markdown 结构：\n## 榜单概览\n## 高频题材与组合\n## 标题与开篇承诺\n## 读者爽点和冲突结构\n## 可验证的选题机会\n## 避免同质化的方向\n\n样本：\n${samples}`;
    const response = await client.chat([{ role: "user", content: prompt }], { temperature: 0.25, max_tokens: 1800, retryAttempts: 3 });
    return { report: response.content.trim() };
  })
  .register("book.dismantle", async params => {
    const { bookTitle, chapterTitle, chapterNumber, sourceContent, contextWindow } = params;
    if (!sourceContent) {
      throw new Error("缺少拆书分析所需的正文或模型配置");
    }
    const client = createModelApiClient(params, { model: "gpt-4o-mini" });
    const source = compactText(sourceContent, Math.min(contextBudgetBytes(Number(contextWindow) || undefined, 35, 18), 28_000));
    const prompt = `你是长篇小说结构分析编辑。请拆解《${String(bookTitle || "未命名作品")}》第 ${Number(chapterNumber) || 1} 章《${String(chapterTitle || "未命名章节")}》的剧情结构，生成可用于原创创作的细纲。

要求：只提炼抽象剧情结构、人物目标、冲突、信息揭示、伏笔和节奏；不得抄录原文句子，不得复述大段原文。章节细纲必须可执行，保留因果关系但不保留特定表达。

## 待分析正文
${source}

只返回 JSON：
{
  "summary":"180 字以内剧情摘要",
  "detailedOutline":"Markdown 章节细纲，包含：本章目标、承接状态、四段事件链、人物动机与对抗、信息与伏笔、节奏、结尾钩子",
  "plotBeats":["4-8 条事件节点"],
  "characterDynamics":["人物目标或关系变化"],
  "setupPayoff":["伏笔/回收"],
  "pacing":"开场/发展/转折/收束的节奏判断"
}`;
    const response = await client.chat([{ role: "user", content: prompt }], { response_format: { type: "json_object" }, temperature: 0.25, max_tokens: 2400, retryAttempts: 3 });
    try {
      const parsed = JSON.parse(response.content) as Record<string, unknown>;
      return {
        summary: String(parsed.summary || "").trim(),
        detailedOutline: String(parsed.detailedOutline || "").trim(),
        plotBeats: stringList(parsed.plotBeats, 10),
        characterDynamics: stringList(parsed.characterDynamics, 10),
        setupPayoff: stringList(parsed.setupPayoff, 10),
        pacing: String(parsed.pacing || "").trim(),
      };
    } catch {
      return { summary: "", detailedOutline: response.content.trim(), plotBeats: [], characterDynamics: [], setupPayoff: [], pacing: "" };
    }
  })
  /**
   * 拆书全书聚合：逐章拆解之上再做一次整书级提炼
   * 参考 oh-story 拆文的 Stage 3～6：文风档案（含原文锚点）、情绪模块、节奏表。
   * 句长分布本地算，不让模型数；原文锚点由模型挑段，落盘前按原文精确回查，挑不到原文里的一律丢掉
   */
  .register("book.aggregate", async params => {
    const { bookTitle, chapters, contextWindow } = params;
    const list = Array.isArray(chapters) ? chapters.filter(item => item && typeof item === "object") as Array<Record<string, unknown>> : [];
    if (!list.length) throw new Error("没有可聚合的章节：先给这本书生成几章章纲");
    const client = createModelApiClient(params, { model: "gpt-4o-mini" });
    const analyzed = list.filter(item => String(item.summary || "").trim() || String(item.detailedOutline || "").trim());
    const summaries = compactText(analyzed.map(item => `### 第 ${Number(item.number) || 0} 章 ${compactText(item.title || "", 60)}\n摘要：${compactText(item.summary || "", 400)}\n节拍：${stringList(item.plotBeats, 8).join("；")}\n人物：${stringList(item.characterDynamics, 6).join("；")}\n节奏：${compactText(item.pacing || "", 200)}`).join("\n\n"), Math.min(contextBudgetBytes(Number(contextWindow) || undefined, 60, 24), 48_000));
    // 文风采样：首中尾各一章正文，本地算句长分布；原文全量给模型挑锚点太贵，只给这三章
    const withText = list.filter(item => String(item.sourceContent || "").trim());
    const picks = [withText[0], withText[Math.floor(withText.length / 2)], withText[withText.length - 1]].filter((item, index, array) => item && array.indexOf(item) === index);
    const sampleText = picks.map(item => `### 第 ${Number(item.number) || 0} 章 ${compactText(item.title || "", 60)}\n${compactText(item.sourceContent || "", 9000)}`).join("\n\n");
    const stats = sentenceStats(picks.map(item => String(item.sourceContent || "")).join("\n"));
    const prompt = `你是网文结构分析师。下面是《${String(bookTitle || "参考作品")}》的逐章拆解摘要和三章原文样本。请做一次整书级提炼，供另一本书写作时"对标"用。对标只借情绪链、功能位与写法，不借人物、场景、道具、专名和句子。

## 逐章摘要
${summaries || "（无）"}

## 三章原文样本
${sampleText || "（无）"}

## 本地统计（已算好，直接引用）
${stats}

只返回 JSON：
{
  "styleProfile": "Markdown 文风档案：## 整体语感（句长分布引用上面的统计、标点习惯、段落节奏）/ ## 对话技法（潜台词模式、对话标签习惯、角色语气区分）/ ## 情绪交替模式（章内基调切换、跨章周期）/ ## 可借鉴技巧（五条，各配一个本书例子）/ ## 分层模仿建议（能直接学的、要换壳的、不要学的）",
  "anchors": [{"tone":"紧张|轻松|悲伤|热血|爽|甜|温馨|压抑","source":"第几章","point":"这一段示范了什么手法","excerpt":"原文里连续的 300～500 字，逐字照抄，不改一个字"}],
  "emotionModules": [{"id":"EM-001","name":"模块名","readerNeed":"读者在这里想要什么","trigger":"什么事触发","arc":"前状态 → 触发 → 后状态","replaceable":"哪些要素可以换（人物、场景、道具、触发条件）","antiCopy":"复现时必须换掉什么，否则就是套壳","tone":"基调"}],
  "rhythm": "Markdown 表格：| 关键信息 | 首次出现 | 扩写技法 | 情绪触动点 | 爆发或冷却 |，八到十五行"
}
anchors 三到五段，基调各不相同；emotionModules 三到六张。`;
    const response = await client.chat([{ role: "user", content: prompt }], { response_format: { type: "json_object" }, temperature: 0.3, max_tokens: 9000, retryAttempts: 2 });
    const parsed = JSON.parse(response.content.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "")) as Record<string, unknown>;
    // 模型只看过这三章样本，锚点也只能出自这三章：拿全书去比会把模型凭记忆复述的段落当成原文放过
    const corpus = picks.map(item => String(item.sourceContent || "").replace(/\s+/gu, "")).join("\n");
    const anchors = (Array.isArray(parsed.anchors) ? parsed.anchors : []).flatMap(item => {
      const entry = item && typeof item === "object" ? item as Record<string, unknown> : {};
      const excerpt = String(entry.excerpt || "").trim();
      // 锚点必须真在原文里：模型偶尔"复述"一段当原文，那种锚点会把别人的句子当成范本教给写手
      if (excerpt.length < 120 || !corpus.includes(excerpt.replace(/\s+/gu, ""))) return [];
      return [{ tone: String(entry.tone || "其他").trim(), source: String(entry.source || "").trim(), point: String(entry.point || "").trim(), excerpt }];
    });
    const emotionModules = (Array.isArray(parsed.emotionModules) ? parsed.emotionModules : []).flatMap((item, index) => {
      const entry = item && typeof item === "object" ? item as Record<string, unknown> : {};
      if (!String(entry.name || "").trim()) return [];
      return [{ id: String(entry.id || `EM-${String(index + 1).padStart(3, "0")}`), name: String(entry.name).trim(), readerNeed: String(entry.readerNeed || "").trim(), trigger: String(entry.trigger || "").trim(), arc: String(entry.arc || "").trim(), replaceable: String(entry.replaceable || "").trim(), antiCopy: String(entry.antiCopy || "").trim(), tone: String(entry.tone || "").trim() }];
    });
    return {
      styleProfile: String(parsed.styleProfile || "").trim(),
      anchors,
      emotionModules,
      rhythm: String(parsed.rhythm || "").trim(),
      chapterNumbers: analyzed.map(item => Number(item.number) || 0).filter(Boolean),
      droppedAnchors: (Array.isArray(parsed.anchors) ? parsed.anchors.length : 0) - anchors.length,
    };
  })
  .register("book.style.distill", async params => {
    const { bookTitle, styleName, samples, contextWindow } = params;
    if (!Array.isArray(samples) || samples.length === 0) {
      throw new Error("请选择至少一个章节用于蒸馏文风");
    }
    const client = createModelApiClient(params, { model: "gpt-4o-mini" });
    const sampleText = compactText(samples.map((sample, index) => {
      const item = sample && typeof sample === "object" ? sample as Record<string, unknown> : {};
      return `### 样本 ${index + 1}｜${String(item.title || "章节")}\n${String(item.content || "")}`;
    }).join("\n\n"), Math.min(contextBudgetBytes(Number(contextWindow) || undefined, 45, 24), 36_000));
    const prompt = `你是小说文风编辑。请从《${String(bookTitle || "参考作品")}》的节选中蒸馏一份可复用的“文风 Skill”。

只描述抽象、可执行的写作特征：叙述视角、句长与段落、动作和感官比例、对话节奏、情绪张力、场景切换、悬念收束、禁忌项。不要引用、改写或模仿可识别的原文句式；输出必须用于创作独立的新故事。

## 样本
${sampleText}

只返回 JSON：
{
  "name":"文风名称",
  "description":"一句话特征说明",
  "tags":["标签"],
  "content":"Markdown 文风 Skill，包含适用范围、写作指令、段落节奏、对话、感官、钩子、禁止项和自检清单"
}`;
    const response = await client.chat([{ role: "user", content: prompt }], { response_format: { type: "json_object" }, temperature: 0.3, max_tokens: 2200, retryAttempts: 3 });
    try {
      const parsed = JSON.parse(response.content) as Record<string, unknown>;
      return {
        name: String(parsed.name || styleName || "蒸馏文风").trim(),
        description: String(parsed.description || "从拆书章节提炼的原创写作约束。").trim(),
        tags: stringList(parsed.tags, 10),
        content: String(parsed.content || response.content).trim(),
      };
    } catch {
      return { name: String(styleName || "蒸馏文风"), description: "从拆书章节提炼的原创写作约束。", tags: ["蒸馏文风"], content: response.content.trim() };
    }
  })
  .register("book.rewrite", async params => {
    const { bookTitle, chapterTitle, detailedOutline, instruction, targetWords, contextWindow } = params;
    if (!detailedOutline) {
      throw new Error("请先生成并确认章节细纲");
    }
    const client = createModelApiClient(params, { model: "gpt-4o-mini" });
    const wordLimit = Math.max(600, Math.min(8000, Math.floor(Number(targetWords) || 2200)));
    const prompt = `你是原创网络小说作者。根据下面从《${String(bookTitle || "参考作品")}》抽象出的章节结构，写一份完全独立的新章节草稿。

不可使用原作品的人名、地名、专有设定、原句、独特措辞或可识别事件细节；请重构人物、场景、冲突解决方式与情节表面，保留的只能是一般性的戏剧功能。只输出正文，不加标题、注释或 Markdown。

目标章节：${String(chapterTitle || "原创章节")}
作者要求：${String(instruction || "保留节奏和冲突强度，写成独立故事。")}
目标长度：约 ${wordLimit} 个中文字符。

## 抽象细纲
${compactText(detailedOutline, 14_000)}`;
    const response = await client.chat([{ role: "user", content: prompt }], { temperature: 0.75, max_tokens: Math.min(9000, Math.ceil(wordLimit * 1.7)), retryAttempts: 3 });
    return { content: response.content.trim().replace(/^```(?:markdown|text)?\s*/i, "").replace(/```$/u, "").trim() };
  })
  .register("book.adapt", async params => {
    const { projectTitle, projectSynopsis, projectOutlines, chapterTitle, detailedOutline, rewriteContent, styleProfile, contextWindow } = params;
    if ((!detailedOutline && !rewriteContent)) {
      throw new Error("请先准备章节细纲或原创改写稿");
    }
    const client = createModelApiClient(params, { model: "gpt-4o-mini" });
    const prompt = `你是《${String(projectTitle || "未命名小说")}》的章节作者。把下列原创章节素材转换成符合目标小说设定的可编辑正文。

只使用目标小说的人物、世界观和大纲；如果素材与设定冲突，以目标设定为准并重构。必须写成独立原创内容，不复用参考作品的专名、句子和可识别桥段。只输出章节正文，不加标题。

## 目标作品简介
${String(projectSynopsis || "暂无")}

## 目标作品大纲
${compactText(projectOutlines, 7000)}

${styleProfile ? `## 已绑定文风 Skill\n${compactText(styleProfile, 6000)}\n` : ""}
## 章节素材｜${String(chapterTitle || "新章节")}
${compactText(rewriteContent || detailedOutline, 14_000)}`;
    const response = await client.chat([{ role: "user", content: prompt }], { temperature: 0.72, max_tokens: 7000, retryAttempts: 3 });
    return { title: String(chapterTitle || "新章节"), content: response.content.trim().replace(/^```(?:markdown|text)?\s*/i, "").replace(/```$/u, "").trim() };
  });

/** 句长分布与标点密度：本地算好给模型引用，不让模型自己数（数出来的永远是编的） */
function sentenceStats(text: string): string {
  const narrative = text.replace(/[“「][^”」\n]*[”」]/gu, "");
  const sentences = narrative.split(/[。！？!?]/u).map(item => item.replace(/\s+/gu, "")).filter(item => item.length >= 2);
  if (!sentences.length) return "（样本太短，无法统计）";
  const lengths = sentences.map(item => Array.from(item).length);
  const share = (predicate: (length: number) => boolean) => `${Math.round(lengths.filter(predicate).length / lengths.length * 100)}%`;
  const average = Math.round(lengths.reduce((sum, length) => sum + length, 0) / lengths.length);
  const paragraphs = text.split(/\n+/u).map(item => item.trim()).filter(Boolean);
  const dialogueLines = paragraphs.filter(item => /^[“「"]/u.test(item)).length;
  const punctuation = (text.match(/[，。！？；：、]/gu) || []).length;
  const visible = text.replace(/\s+/gu, "").length || 1;
  return [
    `叙述句长：短句(<15字) ${share(length => length < 15)}、中句(15～30) ${share(length => length >= 15 && length <= 30)}、长句(>30) ${share(length => length > 30)}，平均 ${average} 字`,
    `段落：${paragraphs.length} 段，对话行占 ${Math.round(dialogueLines / Math.max(1, paragraphs.length) * 100)}%`,
    `标点密度：每百字 ${(punctuation / visible * 100).toFixed(1)} 个`,
    `感叹号 ${(text.match(/[！!]/gu) || []).length} 个、问号 ${(text.match(/[？?]/gu) || []).length} 个、省略号 ${(text.match(/…/gu) || []).length} 个、破折号 ${(text.match(/—/gu) || []).length} 个`,
  ].join("\n");
}
