import { compactText, masterOutlineBytes, storyLedgerBytes } from "../context/context-optimizer.js";

/**
 * 章节审查：三档四视角
 * 提示词原本只长在写作图里，只有"正在写的新章"能被审到；批量审查旧章要的是同一份口径，
 * 所以放在这里给两条路径共用（改一处两边都生效）。
 *
 * 档位参考 oh-story-claudecode 的 story-review：full 跑四个视角（架构 / 人物 / 文字 / 一致性），
 * lean 只跑架构与一致性，solo 只跑一次合并审查。这里是单模型，视角靠串行调用分开：
 * 四次各盯一件事，比一次"全都看看"稳得多，也方便按视角决定要不要自动改。
 * 本地 lint（prose-lint）的结果不进模型，由调用方合并进最终报告。
 */

export type ReviewMode = "full" | "lean" | "solo";
export type ReviewPerspective = "architect" | "character" | "prose" | "consistency" | "solo";
export type ReviewSeverity = "S1" | "S2" | "S3" | "S4";
export type ReviewCategory = "structure" | "character" | "prose" | "consistency" | "platform" | "factual" | "format" | "causal" | "relationship";
export type ReviewVerdict = "APPROVE" | "CONCERNS" | "REJECT";

export interface ReviewFinding {
  severity: ReviewSeverity;
  category: ReviewCategory;
  /** 段落序号或引用句：模型给不出行号，只要求能定位 */
  location: string;
  evidence: string;
  issue: string;
  /** 一致性类只写事实统一方向，不写文学建议 */
  fix: string;
  /** 来源视角；本地 lint 合并进来的记 lint */
  source: ReviewPerspective | "lint";
}

export interface PerspectiveResult {
  perspective: ReviewPerspective;
  verdict: ReviewVerdict;
  findings: ReviewFinding[];
  /** 架构视角专用：本章有没有发生前文没发生过的事 */
  advances?: boolean;
  progress?: string;
  /** 架构与综合视角：主角关系这一章走到哪；"无"或空就是没推进 */
  relationshipProgress?: string;
  repeatedEvents?: string[];
  /** 一致性视角专用：上一章承诺有没有兑现、本章留下哪些下章要接的风险 */
  nextChapterRisks?: string[];
  /** 逐项 PASS/FAIL（番茄六项加人物分得开、感情有戏），架构视角填 */
  rubric?: Record<string, "PASS" | "FAIL">;
}

export interface ChapterReviewResult {
  consistent: boolean;
  /** 兼容旧界面：S1/S2 的一致性、事实类问题 */
  issues: string[];
  /** 兼容旧界面：其余问题与建议 */
  suggestions: string[];
  advances: boolean;
  progress: string;
  /** 主角关系这一章走到哪；空串就是审查认为没推进 */
  relationshipProgress: string;
  repeatedEvents: string[];
  mode: ReviewMode;
  verdict: ReviewVerdict;
  findings: ReviewFinding[];
  perspectives: Array<{ perspective: ReviewPerspective; verdict: ReviewVerdict; count: number }>;
  nextChapterRisks: string[];
  /** 视角调用失败时保留原因；有它就不能把审查当作通过 */
  reviewFailures?: string[];
  rubric?: Record<string, "PASS" | "FAIL">;
}

export interface ChapterReviewInput {
  /** 写作 Agent 的系统提示词：审查必须站在写这一章的同一个 Agent 口上，不能两边各说一套
   * （它长在写作图里，这里当参数传，避免审查模块反向依赖写作图） */
  agentSystemPrompt: string;
  /** 作品定位（类型、标签、简介、主角）：架构与人物视角凭它判感情线该不该推、人物像不像模板 */
  projectProfile?: string;
  worldSetting?: string;
  writingStyle?: { name: string; content: string };
  chapterBeat?: string;
  masterOutline?: string;
  storyLedger?: string;
  cards?: Array<{ type?: string; title: string; content: string }>;
  knowledgeGraph?: string;
  retrievedContext?: string[];
  /** 要审查的正文：新章传草稿，旧章传已存正文 */
  draftContent: string;
  sessionContext?: string;
  /** 被审章号与全书总章数：审的是历史章时，不能拿"全书最新进度"当它的时点 */
  chapterNumber?: number;
  totalChapters?: number;
  /** 本章构思或章纲：架构视角对照它判断"该发生的事发生了没有" */
  chapterPlan?: string;
  /** 上一章记忆里的"下一章承诺"：一致性视角查有没有兑现 */
  previousPromise?: string;
  /** 上一章原文：摘要可能漏掉宣判、交付等不可逆结果 */
  previousChapter?: { title: string; content: string };
  /** 本章作者的要求：作者明确让停在同一场景时，架构视角不判"没推进" */
  instruction?: string;
}

export interface ChapterReviewMessage {
  role: "system" | "user";
  content: string;
}

/** 各档位要跑的视角，按串行顺序 */
export function reviewPerspectivesFor(mode: ReviewMode): ReviewPerspective[] {
  if (mode === "full") return ["architect", "character", "prose", "consistency"];
  if (mode === "lean") return ["architect", "consistency"];
  return ["solo"];
}

export function normalizeReviewMode(value: unknown): ReviewMode {
  return value === "full" || value === "solo" ? value : "lean";
}

/** 番茄平台的六项硬指标：进架构视角的提示词，PASS/FAIL 原样回传 */
const fanqieRubric = `| 指标 | PASS | FAIL |
|---|---|---|
| 开头吸引力 | 前 3 段有冲突、悬念或钩子 | 前 3 段纯描写或背景 |
| 翻页动力 | 结尾有悬念、反转或新信息 | 结尾是总结、抒情或静止画面 |
| 情绪节点 | 每 1000 字有情绪起伏 | 连续 2000 字情绪平直 |
| 信息密度 | 段落短、事件推进快 | 大段描写、慢节奏、低信息 |
| 实质推进 | 本章改变了目标、风险、信息、关系、资源、身份、情绪立场中至少一项 | 读完这章世界和之前一样 |
| 人物在做事 | 人物有想要的东西并为之行动 | 人物只在感受、沉默、旁观 |
| 人物分得开 | 遮住名字也能认出每句台词是谁说的，同一场戏里各人反应不同 | 几个人说话一个腔调，对同一件事都沉默、都点头、都"没说话" |
| 感情有戏 | 涉及主角关系的场景有可信的选择或交流；本章不涉及也可 PASS | 同一场戏里只剩无意义的点头、手指和物件，人物心意无法读懂 |`;

const findingsSchema = `每条 finding 是 {"severity":"S1|S2|S3|S4","category":"...","location":"第几段或引用原句前十字","evidence":"引用原文","issue":"问题","fix":"怎么改"}。
严重度：S1 破坏主线、人物动机、世界规则或读者信任；S2 明显影响本章效果、留存、节奏、人物可信度；S3 局部措辞或轻微节奏；S4 建议项。没有原文证据的不写。`;

const perspectivePrompts: Record<ReviewPerspective, string> = {
  architect: `你是这本书的结构编辑，只出报告，不改正文。对照作品定位、总纲、故事账本和本章构思读这一章，回答：
1. 本章有没有发生前文没发生过的事？先对照紧邻上一章原文中的结果（如宣判、死亡、交付），再看账本；已经完成的结果不能退回待定状态，也不能再次发生。命中时记 S1，category 用 consistency，evidence 引本章原句。整章停在上一章那件事里时 advances 记 false、repeatedEvents 写出重复内容。作者要求留在同一场景时只允许继续处理未完成的部分。
2. 读者为什么翻下一页？结尾落在动作、画面、台词还是总结、抒情、静止？
3. 构思里安排的事发生了吗？漏了哪件？
4. 只在人物确实面对彼此的场景检查关系是否可信；不能因为本章没有升温就判失败，不能建议添一处手部动作或物件互动凑指标。若几个人只会点头沉默、说话不像真人，用原句举证。
5. 按下面八项逐项 PASS / FAIL。人物分得开一项 FAIL 时另记一条 S2，category 用 character，evidence 里并列引用两个人的台词。
${fanqieRubric}
返回严格 JSON，不要代码围栏：{"verdict":"APPROVE|CONCERNS|REJECT","advances":true,"progress":"一句话：本章把故事推进到哪","relationshipProgress":"一句话：主角关系这一章走到哪，没推进就写'无'","repeatedEvents":[],"rubric":{"开头吸引力":"PASS","翻页动力":"PASS","情绪节点":"PASS","信息密度":"PASS","实质推进":"PASS","人物在做事":"PASS","人物分得开":"PASS","感情有戏":"PASS"},"findings":[]}。已完成事件被重写或退回待定时 category 用 consistency；其他问题用 structure、platform、character 或 relationship。${findingsSchema}`,
  character: `你是这本书的人物编辑，只出报告，不改正文。对照人物卡读这一章，回答：
1. 每个出场人物按自己卡上的性格说话和做选择了吗？哪句话换个人说也成立？
2. 人物之间分得开吗？遮住名字还认得出他们各自想要什么？如果人物只会沉默、点头、摸物件，要指出具体位置，不要建议加另一套微动作。
3. 有谁一整章只在沉默、点头、"没问"、"淡淡地说"？他此刻想要什么、为什么不说？
4. 对话有没有三种病：问答式（一句问一句答，没有情绪承接）、科普嘴（整段讲设定原理）、不分场合（高压时刻插科打诨）？
5. 关系尺度和当前阶段匹配吗？有没有突然亲密、突然信任、突然翻脸？本章没有关系进展本身不是错误。
返回严格 JSON，不要代码围栏：{"verdict":"APPROVE|CONCERNS|REJECT","findings":[]}。category 用 character。${findingsSchema}`,
  prose: `你是这本书的文字编辑，只出报告，不改正文。读这一章，回答：
1. 哪些句子是作者跳出来讲解、剧透、总结、定性（"之所以""原来""这意味着""她不知道的是""他终于明白"）？
2. 哪些情绪是贴标签而不是从选择、台词、物件、后果里出来的？哪些身体微动作删掉后什么都不损失？
3. 结尾是升华、总结、预告，还是落在具体动作画面上？
4. 有没有整段同长度、同结构的句子；有没有电报体（连着都是五个字以内的短句）？
5. AI 味整体分级：轻 / 中 / 重，给三处最重的证据。
返回严格 JSON，不要代码围栏：{"verdict":"APPROVE|CONCERNS|REJECT","aiLevel":"轻|中|重","findings":[]}。category 用 prose 或 format。${findingsSchema}`,
  consistency: `你是这本书的一致性检查员，只查事实，不评文学，不给创作建议。对照世界观、人物卡、故事账本、知识图谱读这一章，回答：
1. 直接对照紧邻上一章原文的已完成结果：已经宣判、交付、死亡或揭晓的事，不能在本章回到待定状态，也不能再次发生；命中时记 S1，category 用 consistency，evidence 引本章原句。
2. 人物属性、位置、已知信息有没有和前文矛盾？谁知道了不该知道的事？
3. 时间线自洽吗？相对上一章过了多久，正文里有没有互相打架的时间标记？
4. 物品归属、称谓、地点、能力边界有没有前后不一致？
5. 上一章的"下一章承诺"兑现了吗？没兑现算不算断线？
6. 本章留下哪些下一章必须接住的事（承诺、悬而未决的动作、刚出现的人物物件）？写进 nextChapterRisks。
返回严格 JSON，不要代码围栏：{"verdict":"APPROVE|CONCERNS|REJECT","nextChapterRisks":["一句一条"],"findings":[]}。category 用 consistency、factual 或 causal；fix 只写事实统一方向（"统一为左臂旧伤"），不写怎么写得更好。${findingsSchema}`,
  solo: `你是这本书的编辑，只出报告，不改正文。对照作品定位、世界观、人物卡、总纲、故事账本读这一章，回答五件事：
一、推进：先核对紧邻上一章原文中已完成的结果，再看账本。已经宣判、交付、死亡或揭晓的事不能回到待定状态或再次发生；命中时记 S1，category 用 consistency，evidence 引本章原句。整章重复前文则 advances 记 false、repeatedEvents 写清重复内容。留在同一场景可以，只能继续未完成的事。
二、一致性：人物状态、已知信息、时间线、物品归属、称谓有没有和前文或设定矛盾？只列明确矛盾。
三、人物：出场的人有没有按自己的性格说话和做选择？遮住名字能不能认出台词是谁说的？有谁一整章只在沉默、点头、"没问"？同一场戏里几个人反应一样的，记 S2，category 用 character。
四、人物与关系：在本章实际出现的交锋中，人物有没有按自己的处境说话和做选择？只在有具体原句证据时指出人物像模板或交流不可信，不因关系没有每章升温而扣分，不建议用手部动作凑感情线。
五、结尾：落在动作画面上，还是总结抒情？本章留下哪些下一章必须接住的事，写进 nextChapterRisks。
返回严格 JSON，不要代码围栏：{"verdict":"APPROVE|CONCERNS|REJECT","advances":true,"progress":"一句话","relationshipProgress":"一句话，没推进就写'无'","repeatedEvents":[],"nextChapterRisks":[],"findings":[]}。${findingsSchema}`,
};

/** 审查请求本体：稳定资料（作品定位/世界观/文风）+ 会话摘要 + 约束摘要与待审正文 + 该视角的审查口径 */
export function chapterReviewRequest(input: ChapterReviewInput, perspective: ReviewPerspective = "solo"): { messages: ChapterReviewMessage[]; inputBytes: number } {
  // 审历史章节时账本里的"现在"不是它的时点：实测第 131 章的审查把"账本标注第178章/第五卷"
  // 当成本章的时间线矛盾，还建议"把总纲卷次改回当前写作位"，那是要拿旧章去追新进度，改下去只会把正文改坏
  const historical = typeof input.chapterNumber === "number" && typeof input.totalChapters === "number" && input.chapterNumber < input.totalChapters;
  const worldSetting = historical ? stripLatestProgress(input.worldSetting) : input.worldSetting;
  const historyNote = historical
    ? `## 审查的是历史章节\n本章是第 ${input.chapterNumber} 章，全书已经写到第 ${input.totalChapters} 章。账本里的 current_timeline 与最新完成章描述的是现在，不是本章的时点；账本中与本章时点不符的行不算本章的问题，不要去建议改总纲或账本的进度标注，也不要拿后续章节的事实要求本章提前兑现。`
    : "";
  // 作品定位在架构、人物、综合三个视角都要看：判"感情线该不该推"和"人物像不像模板"都得先知道这本书卖什么
  const wantsProfile = perspective !== "prose" && perspective !== "consistency";
  const stablePacket = [
    wantsProfile ? input.projectProfile || "" : "",
    worldSetting ? `## 世界观与作品设定（作者定的固定规则）\n${worldSetting}` : "",
    input.writingStyle ? `## 绑定文风\n名称：${input.writingStyle.name}\n${input.writingStyle.content}` : "",
  ].filter(Boolean).join("\n\n");
  // 每个视角只装自己用得上的资料：一致性要卡片和图谱，架构要总纲账本和构思，文字视角什么资料都不要
  const wantsDirection = perspective !== "prose" && perspective !== "character";
  const wantsCards = perspective !== "prose";
  const wantsGraph = perspective === "consistency" || perspective === "solo";
  const directionSection = wantsDirection ? [
    input.previousChapter?.content ? `## 紧邻上一章原文（核对已经发生的结果）\n${compactText(input.previousChapter.content, 7500)}` : "",
    input.chapterBeat ? `## 本章节拍（阶段节拍表给本章定的事件）\n${compactText(input.chapterBeat, 1200)}` : "",
    input.masterOutline ? `## 总纲（含本章位置与本章条目）\n${compactText(input.masterOutline, masterOutlineBytes)}` : "",
    input.storyLedger ? `## 故事账本（前文已发生的事与长线伏笔）\n${compactText(input.storyLedger, storyLedgerBytes)}` : "",
    input.chapterPlan && perspective !== "consistency" ? `## 本章构思\n${compactText(input.chapterPlan, 2400)}` : "",
    input.previousPromise && (perspective === "consistency" || perspective === "solo") ? `## 上一章的下一章承诺\n${compactText(input.previousPromise, 600)}` : "",
    input.instruction && (perspective === "architect" || perspective === "solo") ? `## 作者对本章的要求\n${compactText(input.instruction, 800)}` : "",
  ].filter(Boolean).join("\n\n") : "";
  const cardsSection = wantsCards && input.cards?.length
    ? `\n## 本章人物与设定卡\n${input.cards.map(card => `### ${card.title}\n${compactText(card.content, perspective === "character" ? 4000 : 1200)}`).join("\n\n")}`
    : "";
  const graphSection = wantsGraph && input.knowledgeGraph ? `\n## 知识图谱约束\n${input.knowledgeGraph}\n` : "";
  const contextSection = wantsGraph && input.retrievedContext?.length ? `\n## 已知背景信息\n${input.retrievedContext.join("\n\n")}\n` : "";
  const constraints = `${cardsSection}${graphSection}${directionSection ? `\n${directionSection}\n` : ""}${contextSection}`;
  const reviewPrompt = [historyNote, `## 约束摘要\n${constraints || "（暂无额外约束）"}\n\n## 待审查章节\n${compactText(input.draftContent, 10000)}`].filter(Boolean).join("\n\n");
  const session = splitSessionContext(input.sessionContext);
  const messages: ChapterReviewMessage[] = [
    { role: "system", content: input.agentSystemPrompt },
    { role: "user", content: `## 稳定作品资料\n${stablePacket || "（暂无稳定资料）"}` },
    ...(session.summary && wantsDirection ? [{ role: "user" as const, content: session.summary }] : []),
    { role: "user", content: reviewPrompt },
    { role: "user", content: perspectivePrompts[perspective] },
  ];
  return { messages, inputBytes: messages.reduce((sum, message) => sum + byteLengthOf(message.content), 0) };
}

/** 单个视角的 JSON 归一化：模型偶尔带 Markdown 代码围栏或直接回自然语言，两种都要兜住 */
export function normalizePerspectiveResult(value: unknown, perspective: ReviewPerspective): PerspectiveResult {
  const fallback: PerspectiveResult = { perspective, verdict: "APPROVE", findings: [] };
  const text = String(value ?? "").trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { ...fallback, findings: [unparsedFinding(perspective)] };
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const findings = Array.isArray(parsed.findings)
      ? parsed.findings.filter(item => item && typeof item === "object").map(item => normalizeFinding(item as Record<string, unknown>, perspective)).filter((item): item is ReviewFinding => Boolean(item))
      : [];
    const verdict = normalizeVerdict(parsed.verdict, findings);
    const result: PerspectiveResult = { perspective, verdict, findings };
    if (perspective === "architect" || perspective === "solo") {
      result.advances = parsed.advances !== false;
      result.progress = typeof parsed.progress === "string" ? parsed.progress.trim() : "";
      // 模型按提示词在没推进时写"无"，归一成空串，界面和账本只认空
      const relationship = typeof parsed.relationshipProgress === "string" ? parsed.relationshipProgress.trim() : "";
      result.relationshipProgress = /^(?:无|没有|无推进|未推进|none|n\/a)[。.]?$/iu.test(relationship) ? "" : relationship;
      result.repeatedEvents = stringItems(parsed.repeatedEvents);
    }
    if (perspective === "consistency" || perspective === "solo") result.nextChapterRisks = stringItems(parsed.nextChapterRisks);
    if (perspective === "architect" && parsed.rubric && typeof parsed.rubric === "object") {
      result.rubric = Object.fromEntries(Object.entries(parsed.rubric as Record<string, unknown>).map(([key, item]) => [key, String(item).toUpperCase() === "FAIL" ? "FAIL" as const : "PASS" as const]));
    }
    if (perspective === "prose" && typeof parsed.aiLevel === "string" && /重|中/u.test(parsed.aiLevel)) {
      result.findings.push({ severity: parsed.aiLevel.includes("重") ? "S2" : "S3", category: "prose", location: "全章", evidence: "", issue: `AI 味分级：${parsed.aiLevel}`, fix: "按上面各条逐处处理", source: perspective });
    }
    return result;
  } catch {
    return { ...fallback, findings: [unparsedFinding(perspective)] };
  }
}

const unparsedFinding = (perspective: ReviewPerspective): ReviewFinding => ({
  severity: "S4", category: "format", location: "", evidence: "", issue: "无法解析审查结果", fix: "", source: perspective,
});

const severities = new Set<ReviewSeverity>(["S1", "S2", "S3", "S4"]);
const categories = new Set<ReviewCategory>(["structure", "character", "prose", "consistency", "platform", "factual", "format", "causal", "relationship"]);
const defaultCategory: Record<ReviewPerspective, ReviewCategory> = { architect: "structure", character: "character", prose: "prose", consistency: "consistency", solo: "structure" };

function normalizeFinding(item: Record<string, unknown>, perspective: ReviewPerspective): ReviewFinding | undefined {
  const issue = String(item.issue || item.problem || "").trim();
  if (!issue) return undefined;
  const severity = String(item.severity || "").toUpperCase();
  const category = String(item.category || "").toLowerCase();
  return {
    severity: severities.has(severity as ReviewSeverity) ? severity as ReviewSeverity : "S3",
    category: categories.has(category as ReviewCategory) ? category as ReviewCategory : defaultCategory[perspective],
    location: String(item.location || "").trim(),
    evidence: String(item.evidence || "").trim(),
    issue,
    fix: String(item.fix || item.suggestion || "").trim(),
    source: perspective,
  };
}

function normalizeVerdict(value: unknown, findings: ReviewFinding[]): ReviewVerdict {
  const text = String(value || "").toUpperCase();
  if (text === "APPROVE" || text === "CONCERNS" || text === "REJECT") return text;
  return verdictFromFindings(findings);
}

/** 无 S1/S2 通过；有 S2 有问题；有 S1 不通过 */
export function verdictFromFindings(findings: ReviewFinding[]): ReviewVerdict {
  if (findings.some(item => item.severity === "S1")) return "REJECT";
  if (findings.some(item => item.severity === "S2")) return "CONCERNS";
  return "APPROVE";
}

/**
 * 把各视角结果与本地 lint 合成一份报告
 * lint 的 blocking 一律 S2（是确定性句式问题，改法明确），advisory 一律 S4（只是读感提示）；
 * 旧界面还在读 issues / suggestions 两个数组：S1/S2 的一致性事实类进 issues，其余进 suggestions
 */
export function mergeReviewResults(
  mode: ReviewMode,
  results: PerspectiveResult[],
  lintFindings: Array<{ type: string; severity: "blocking" | "advisory"; line: number; excerpt: string; message: string }> = [],
  reviewFailures: string[] = [],
): ChapterReviewResult {
  const findings: ReviewFinding[] = [
    ...results.flatMap(result => result.findings),
    ...lintFindings.map(item => ({
      severity: item.severity === "blocking" ? "S2" as const : "S4" as const,
      category: /truncated|placeholder|verbatim|meta-leak|em-dash|quote/u.test(item.type) ? "format" as const : "prose" as const,
      location: `第 ${item.line} 行`,
      evidence: item.excerpt,
      issue: `${item.type}：${item.message}`,
      fix: "",
      source: "lint" as const,
    })),
  ];
  const order: Record<ReviewSeverity, number> = { S1: 0, S2: 1, S3: 2, S4: 3 };
  findings.sort((left, right) => order[left.severity] - order[right.severity]);
  const architect = results.find(result => result.perspective === "architect" || result.perspective === "solo");
  const factual = findings.filter(item => (item.category === "consistency" || item.category === "factual" || item.category === "causal") && (item.severity === "S1" || item.severity === "S2"));
  const rest = findings.filter(item => !factual.includes(item));
  const label = (item: ReviewFinding) => `${item.severity}${item.location ? `｜${item.location}` : ""}：${item.issue}${item.fix ? `（${item.fix}）` : ""}`;
  return {
    consistent: factual.length === 0,
    issues: factual.map(label),
    suggestions: rest.map(label),
    advances: architect?.advances !== false,
    progress: architect?.progress || "",
    relationshipProgress: architect?.relationshipProgress || "",
    repeatedEvents: architect?.repeatedEvents || [],
    mode,
    verdict: verdictFromFindings(findings),
    findings,
    perspectives: results.map(result => ({ perspective: result.perspective, verdict: result.verdict, count: result.findings.length })),
    nextChapterRisks: results.flatMap(result => result.nextChapterRisks || []),
    reviewFailures,
    rubric: results.find(result => result.rubric)?.rubric,
  };
}

/** 兼容旧调用：单份 JSON 直接当 solo 视角解析 */
export function normalizeChapterReviewResult(value: unknown): ChapterReviewResult {
  return mergeReviewResults("solo", [normalizePerspectiveResult(value, "solo")]);
}

/** 审查失败时的占位结果：正文照常交给作者，报告里如实写审查没跑完 */
export function reviewUnavailable(mode: ReviewMode, reason: string): ChapterReviewResult {
  return { ...mergeReviewResults(mode, [], [], [reason]), suggestions: [`审查未完成：${reason}`] };
}

const stringItems = (value: unknown): string[] => (Array.isArray(value)
  ? value.map(item => String(item).trim()).filter(Boolean)
  : []);

/** 去掉描述"全书现在到哪了"的两行：审旧章时它们会把历史章节误判成错位 */
const stripLatestProgress = (value?: string): string | undefined => (typeof value === "string"
  ? value.split("\n").filter(line => !/^-\s*\*\*(current_timeline|latest_completed_chapter)\*\*/u.test(line.trim())).join("\n")
  : value);

const byteLengthOf = (value: string) => Buffer.byteLength(value, "utf8");

function splitSessionContext(value?: string): { summary: string; recent: string } {
  const context = compactText(value || "", 2200);
  if (!context) return { summary: "", recent: "" };
  const marker = "## 最近会话轮次";
  const index = context.indexOf(marker);
  if (index < 0) return { summary: context, recent: "" };
  return { summary: context.slice(0, index).trim(), recent: context.slice(index).trim() };
}
