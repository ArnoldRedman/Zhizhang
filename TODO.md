# TODO

本清单已按当前代码和本地验证结果重新核对。勾选项表示已经实现并验证；未勾选项表示仍需开发或缺少真实环境验证。行号以 2026-09-14 的 main 分支为准。

## 写作流程：章节推进跑偏

核心症状：连续让智能体写下一章，十几章都在写同一件事。根因是整条链路"每一步只看上一步"：写第 N 章只看第 N-1 章，生成第 N 章章纲也只看第 N-1 章正文。没有任何输入告诉模型全书走到哪、下一个节点是什么、哪些事已经写过不能再写，模型只能围着上一章原地打转。

- [x] **章纲勾选状态切章后不清空，写新章时带着上一章的章纲**
  - `desktop-app/src/App.tsx:1341` 的 `selectedOutlineIds` 只在勾选框里改，切章不重置；`App.tsx:4752` 找不到绑定当前章的章纲时回退到 `selectedChapterOutlines[0]`。第 N 章按第 N-1 章的章纲写，直接复现"反复写同一件事"。
  - 已改：运行章节智能体时只用绑定当前章（chapterId 或标题章号匹配）的章纲，切章自动清空勾选，勾选框只追加参考章纲；没有绑定章纲时先弹提示。
- [x] **总纲从不进入章节智能体和章纲智能体**
  - `App.tsx:4749-4753` 明确过滤掉总纲；`App.tsx:4535-4581` 生成章纲时只传世界观、卡片、图谱和上一章正文；运行时 `sidecars/agent-runtime/src/main.ts:474-582` 的 outline.write 没有任何总纲入参。
  - 已改：`compactMasterOutline` 把总纲压成"全部标题骨架 + 主线段 + 与本章资料最相关的段落"，结局段永远只留标题；章节图与 outline.write 都带上，并明确"后续节点不得提前兑现"。
- [x] **章节智能体只拿到上一章一章正文和一条记忆**
  - `App.tsx:4779` 只传紧邻上一章；`App.tsx:4780` 只传上一章记忆；`App.tsx:4793` 把 memoryDocuments 硬编码成空数组；`App.tsx:4158` 存下的 foreshadowingItems 从未传给写作。运行时其实支持 2 章、6 条记忆、4 份文档（`context-optimizer.ts:311/339/429`）。
  - 已改：传目标章之前按章序排好的最近 6 章记忆（含章号与带状态的伏笔条目）、人物状态/伏笔追踪/时间线/设定事实四份文档；`buildStoryLedger` 把它们压成"当前写到第几章 + 已发生事件一章一行 + 未回收伏笔"的故事账本。
- [x] **"上一章结尾（最高优先级）"实际大半是上一章开头**
  - `context-optimizer.ts:131` 的 compactText 按头 62%、尾 38% 截；`chapter-write.graph.ts:405` 对已截过的正文再截一次，标成"结尾"喂给模型。
  - 已改：`tailText` 只取真正的章尾，`prepareChapterInput` 单独给出 `ending`，承接节点只用它。
- [x] **提示词只要求承接，不要求推进，也不禁止重复**
  - `chapter-write.graph.ts:120` 计划提示"优先处理上一章结尾"；`:406` 承接段标"最高优先级"；`:488` 正文指令"先承接上一章最后的动作、位置和情绪"。审查节点（`:115`）只查人物、时间线、因果，不查"是否推进主线、是否重复前文"。
  - 已改：计划、正文、审查三个阶段都先看总纲与故事账本；计划任务书第一项改为"本章推进"，硬性禁止把账本里的已发生事件再写一遍；审查返回 advances/progress/repeatedEvents，界面标出"本章没有推进主线"和"重复前文"。
- [x] **写前检查发现"缺少章纲"标为阻断，图却无条件继续**
  - `chapter-write.graph.ts:183-192` 产出 blockers，`:589-596` 的边无条件连到下一步，阻断只是显示一下。
  - 已改：有总纲或故事账本时降为提醒并照常推进；两者都没有才是阻断。
  - 再改：界面不再弹"本章没有章纲"的提示。运行章节智能体时若本章没有绑定章纲，先自动调大纲智能体按总纲、故事账本、上一章正文和本次创作指令生成一份，绑定到本章存进大纲页，然后接着写正文；作者只管点一次运行。
- [ ] **运行时"混合检索"检索的是提示词里已有的内容**
  - `main.ts:612` 每次请求新建内存库，`:655-720` 只装传入的上一章和记忆，然后在里面搜（`chapter-write.graph.ts:336-396`）。
  - 部分已改：库里现在有最近 6 章记忆和四份聚合文档，检索有东西可搜；按项目持久化 StoryStore 仍待做。
- [x] **章节字数写死 2000-3000，不读项目目标字数**
  - `chapter-write.graph.ts:488`；项目里的 `chapterTargetWords` 没传给运行时。
  - 已改：界面和项目 Agent 都传 `targetWords`，正文指令按目标字数的 80%～120% 约束。
- [x] **章纲生成只看上一章正文，模板每章强制"新危机"**
  - `main.ts:556` 把上一章全文（26K）和结尾（7K）标成"唯一正文依据"；`runtime-state.ts` 的 chapterOutlineOutputProtocol 每章必须有压抑/爆发/余韵/新危机闭环和"待揭示"伏笔，只加线不收线。
  - 已改：outline.write 带总纲骨架与故事账本，要求章纲核心事件是账本里没有的新推进；模板加"主线推进"栏（承接自、本章推进的总纲节点、与前文的区别），新危机改为优先推进或回收已有伏笔。
- [x] **项目 Agent 路径与界面路径的入参不一致**
  - `main.ts:235` 项目 Agent 起草下一章时传了全部大纲（含总纲），界面按钮路径不传；`main.ts:239` 同样只传一条记忆。两条路径应共用同一份入参组装。
  - 已改：两条路径都传总纲、最近 6 章记忆、章序与目标字数；章纲委派同样带总纲与记忆。入参组装仍是两份代码，合并成一份留到 App.tsx 拆分时做。
- [ ] **跨章会话交接被压到 2.2KB**
  - `chapter-write.graph.ts:203` 整段会话 compactText 到 2200 字节，多章交接实际不起作用。
- [ ] **结构化小任务没有按次降低推理强度的开关**
  - 计划、审查、补标题这类只要几百字 JSON 的调用，用的是作者在设置里选的全局推理强度；推理模型会把输出上限先花在推理上，上限一紧就返回空内容加 finish_reason=length，整章失败。2026-09-14 加"本章推进"栏后计划阶段就在 900 上限上撞了这个问题。
  - 已改：计划上限提到 3000、审查提到 2000；计划截断改用默认计划继续并把原因写进进度，审查失败保留正文并标注"审查未完成"，都有回归测试。
  - 仍待做：`ChatOptions` 增加按次的推理强度覆盖，这几类小任务固定用最低档；上限不再靠拍。
- [ ] **缺少"故事进度板"与批量章纲**
  - 系统里没有"当前卷/阶段目标、已完成节点、进行中伏笔、下一步必须推进"这张表，也没有一次规划接下来 N 章章纲的入口。这是人类作者脑子里那张表，现在没有对应物。
  - 部分已改：运行时每次从最近记忆自动生成"故事账本"（当前位置、已发生事件、未回收伏笔）；没有章纲的章会在运行章节智能体时自动补一份。作者可手改的进度板文档和一次规划接下来 N 章的批量章纲仍待做。
- [ ] **移动端 platform.ts 另有一套 chapter.write 提示词**
  - `desktop-app/src/platform.ts:114-130` 直接把参数 JSON 塞给模型，与运行时的章节图不共享任何改动。

## 架构与工程质量

- [ ] **前端 App.tsx 是 7890 行的单体组件**
  - 一个 `App()` 从 `App.tsx:1148` 到文件末尾：101 个 useState、25 处 agentRpc、33 处 invoke、JSX 从 6069 行到 7890 行。首页、编辑器、书库、拆书、扫榜、技能、文风、设置、记忆中心、图谱的界面和状态全在一个函数里；记忆归一化、图谱合并、章纲意图解析、AI 检测启发式、章节写作入参组装这些纯逻辑都写在组件闭包里，既不能单测也无法复用。ARCHITECTURE.md 写着"App.tsx 当前组合根，逐步收敛为页面组合器"，但 features/ 下只有 5 个模型文件。
  - 注：`desktop-app/src-tauri/src/main.rs` 只有 5 行，Rust 已拆成 lib.rs、project_store.rs、resource_store.rs、github_backup.rs、runtime.rs；"全挤在 main.rs"不成立，前后端目录也是分开的。真正的单体是 App.tsx。
  - 拆法（按依赖从里到外）：先把纯函数抽到 domain/ 与 features/*/model.ts 并补测试（记忆、章号解析与章纲意图、章节写作上下文组装、AI 检测），再按页面拆组件（编辑器、书库、设置、记忆中心、图谱），最后 App.tsx 只剩路由和顶层状态。
  - 进度（2026-09-14）：第一阶段的四块纯逻辑已抽出并补测试，App.tsx 从 7890 行降到 7567 行。`domain/memory.ts`（记忆归一化、聚合文档、本地结构化记忆、最近几章记忆）；`features/outline/model.ts`（章号解析、章纲绑定与"根据第 N 章正文生成"意图解析，并把与 `utils/text.ts` 重复的中文章号解析合并成一份）；`domain/ai-detection.ts`（AI 检测启发式）；`features/chapter-agent/context.ts`（章节智能体入参组装，界面与运行时项目 Agent 两条路径日后共用这一份）。
  - 仍待做：图谱合并与项目 Agent 变更落地（`applyProjectAgentChangeBatch` 一族）、书库/拆书/扫榜的数据流、备份与同步，然后按页面拆组件。
- [ ] **运行时 main.ts 把五个核心 handler 内联在一个函数里**
  - `sidecars/agent-runtime/src/main.ts:20-797` 的 handleLegacyRequest 里塞着 memory.write、project.agent.chat、card.write、outline.write、chapter.write，提示词、缓存、会话、委派全混在一起，共 844 行。ARCHITECTURE.md 说"RPC 处理已按职责拆分"只拆了外围四个。
  - 拆法：按 rpc/chapter-handlers.ts、outline-handlers.ts、card-handlers.ts、memory-handlers.ts、project-agent-handlers.ts 注册到 RpcRegistry，main.ts 只剩组合根。
- [ ] **platform.ts 1100 行把移动端整套智能体重写了一遍**
  - 模型客户端、拆章、补标题、项目 Agent 循环、章节/大纲/卡片/记忆提示词都有第二份实现，注释里靠"与 agent-runtime 保持一致"人工同步。
- [ ] **Rust lib.rs 1049 行混了六类职责**
  - 百度网盘、本地备份与导出、Agent 对话存储、目录打开、系统代理探测、Tauri 注册（21 个 command）都在一个文件里。
- [x] **质量门禁只在打 tag 时运行**
  - `.github/workflows/cross-platform-build.yml` 的触发条件只有 `push: tags` 和手动；日常 push/PR 没有任何检查。
  - 根 `package.json` 的 typecheck 不含 desktop-app，前端 `tsc -b` 只藏在 build 脚本里；`scripts/build-windows.ps1` 只跑运行时类型检查和一个测试文件，前端 lint/测试/类型检查要等到 tauri build 最后一步才顺带跑。
  - `desktop-app/tsconfig.app.json` 没有显式 `strict`（其余三个包都有），当前靠 TypeScript 6 的默认值撑着；desktop-app 锁的是 TS 6.0，其余包是 5.x，两套 lockfile、两套 node_modules。
  - `.oxlintrc.json` 只启用两条规则，exhaustive-deps 只是 warn，现有 2 处告警。
  - 已改：desktop-app 加 `typecheck` 脚本并纳入根 `typecheck`；新增根 `check:desktop`（类型检查 + lint + 测试）；tsconfig 显式 `strict: true`（当前代码 0 报错）；本地构建脚本在 Rust 测试之前先跑前端检查；新增 `.github/workflows/quality.yml`，push 到 main 与 PR 都跑 `npm run check`。
  - 仍待做：统一 TS 大版本与 lockfile；oxlint 规则收紧。
- [ ] **前端 52 个测试全部落在 domain/utils/features，App.tsx 零覆盖**
  - 进度：抽出的四个模块各自带测试，前端测试从 52 个增加到 71 个。组件层（App.tsx 本身）仍然没有测试，要等页面拆出来之后才有下手处。
- [x] **AI 检测高亮永远显示不出来**
  - 拆 AI 检测模块补测试时发现：`analyzeAIChapter` 按原文切分段，`aiDetectionSegmentsMatch` 却拿分段和去掉章节头、去掉首尾空白后的正文比。正文末尾只要有一个换行，或带 `【第N章】` 头，匹配就永远失败，高亮层一直退回纯文本。
  - 已改：匹配改为逐字比原文，`aiDetectionSource` 只用于统计指标；`domain/chapter.test.ts` 与 `domain/ai-detection.test.ts` 覆盖了带章节头和末尾换行的情况。
- [ ] **OutlineNode/project.outline 是死代码**
  - `domain/project.ts:25-32` 定义了 arc/chapter/scene 树与 planned/writing/completed 状态，全仓库只在读写时原样透传，从未使用。它正是"故事进度板"需要的结构。

## 历史事项

- [x] **项目Agent执行多章修订必报错**
  - 项目智能体执行多章任务，如查看150章到159章，修改每章的重复性结尾，他修改完一章就会报错，然后中断自己，同时上面的项目Agent1变成项目Agent2 
  - chapter.revise
    章节修订智能体失败：API 中转服务当前返回 504（可能来自代理或 API 上游网关），模型 gpt-5.6-sol · https://gt-token.zhuziplay.com/v1/chat/completions，已自动重试 1 次：openai_error
    chapter.revise
    章节修订智能体失败：API 中转服务当前返回 504（可能来自代理或 API 上游网关），模型 gpt-5.6-sol · https://gt-token.zhuziplay.com/v1/chat/completions，已自动重试 1 次：openai_error

- [x] **错误信息不再掩盖真实原因**
  - 旧 `upstreamErrorText` 只在响应体以 `{` / `[` 开头时解析，空响应体和 HTML 错误页被直接丢弃，401/403 退化成一句"请在设置中检查配置"，把排查方向带偏了两轮。
  - 新增 `describeErrorBody()`：JSON 取 message（无可读字段则回传压缩 JSON）、HTML 提取 `<title>` 并标明来自代理/CDN/WAF、纯文本截断 800 字符并注明省略量、空体单独标记。参考 `@earendil-works/pi-ai` 的 `utils/error-body.js`。
  - 401/403 补上模型名与实际 endpoint（与其他状态码一致）和请求体字节数；只在上游真的给出说明时才指向 Key，空体时改为列出网关/WAF 与权限两种可能。
  - 新增 `isContextOverflow()`：`request_too_large`、`prompt is too long`、413、以及空响应体的 400 归为超限，文案改成"降低思考强度 / 缩小上下文窗口"；频控文案里的 `too many tokens` 先排除，不误判为超限。参考 `utils/overflow.js`。
  - 新增 `ApiRequestError`（带 status）取代原来用 `message.startsWith("API ")` 区分致命/抖动的做法：文案一改就会错分类，把已读过响应体的请求拉回重试，报成 `Body is unusable`。

- [ ] **确认 `reasoning_effort` 在目标中转站真实生效**
  - OpenAI Chat Completions 请求已发送 `reasoning_effort`，`max` 会降级为 `high`。
  - 503 兼容重试会移除该字段；400 当前不会触发兼容重试。
  - 只有目标中转站出现 400，或确认忽略该字段时，再扩展重试规则。

- [x] **批量变更的整轮预算上限**
  - `REVISE_LIMIT` 从 3 章提到 10 章，系统提示词里的说明同步改写；作者处理 150 到 159 章这类连续段落时不必每三章重说一遍。
  - 委派阶段加 `DELEGATE_BUDGET_MS`（20 分钟）整轮墙钟预算：超预算的委派不再发请求，按条报出「未处理，请再说一次继续」，不静默丢弃。
  - 预算只拦委派。`memory.document.upsert`、图谱两项和 `chapter.delete` 不调模型，照常落地。
  - 预算可由 `delegateBudgetMs` 注入，`tests/project-agent.test.ts` 用 5ms 预算验证，不需要真的等 20 分钟。

- [ ] **扩展小说目录导入格式**
  - `desktop-app/scripts/import-story-folder.mjs` 仍只适配 StoryForge 的 `story_data/{chapters,outlines,bible,state}` 结构。
  - 如需导入其他目录布局，再按真实样本增加映射，不预先设计通用导入框架。

- [ ] **导入已有章节记忆**
  - 导入脚本会生成设定事实记忆文档和知识图谱，但 `memories` 仍为空。
  - 若源目录以后提供可靠的逐章摘要，可再导入；当前可在应用中运行章节智能体生成。

- [x] **具体的某一个小说的编辑页面难用**
  - 侧栏宽度和标签区高度改成行内 CSS 变量，两个手柄用 pointer capture 拖动，方向键也能调，结果写回 localStorage；窄屏和移动端隐藏手柄，标签区改横排。
  - 标签区加 `max-height` 与 `overflow-y: auto`：拖窄后自己滚动，不再固定占掉约 330px 高。
  - 章节排序、插入、定位、删除提到列表上方的操作条，只作用于当前选中章节，回收站入口并入同一行；列表项回到标题加字数两行，标题单行省略并挂 `title` 提示。
  - 字号 14/12 降到 12/10，条目间距收窄；删除桌面窄窗口写死的 230px / 205px 覆盖，交给用户拖动结果。
  - 尺寸夹取放在 `desktop-app/src/features/editor/layout.ts`，`layout.test.ts` 覆盖 localStorage 空值与越界值。
