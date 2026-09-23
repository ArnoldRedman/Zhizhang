# 织章架构

本文描述当前仓库的运行边界、模块职责和重构约束。产品使用方式见 [README.md](README.md)，待办与阶段验收见 [TODO.md](TODO.md)。

## 总体分层

```text
表现层       desktop-app/src/App.tsx 与 features/*
应用层       desktop-app/src/services/*、Agent Runtime application/*
端口/契约    packages/contracts、packages/model-protocol、services、RPC registry
基础设施     Tauri adapters、Node model/storage/source adapters
平台层       desktop-app/src-tauri、移动端 HTTP、文件系统和进程
```

依赖方向保持单向：

```text
UI / features -> application services -> contracts / ports -> platform adapters
Runtime RPC -> application handlers -> models / context / storage / sources
contracts 不依赖 desktop-app、agent-runtime 或 Tauri
```

不在当前项目中引入 Redux、DI 容器、事件总线、微服务或通用 Repository 框架。扩展通过新增领域模块和明确的 RPC 方法完成。

## 目录结构

```text
织章/
├── packages/contracts/          跨端 RPC DTO、方法表、运行时参数校验、拆章切点纯函数
├── packages/model-protocol/     OpenAI/Anthropic 共享纯协议规则
├── desktop-app/
│   ├── src/App.tsx              当前组合根，逐步收敛为页面组合器
│   ├── src/domain/              Project、Library、Skill 等领域类型
│   ├── src/features/            按功能组织的 UI 和会话模型
│   ├── src/services/            agent-client、native-client 等应用端口
│   ├── src/platform/            移动书源、云同步等平台适配器
│   └── src-tauri/src/
│       ├── lib.rs               Tauri command 组合与百度备份/系统能力
│       ├── github_backup.rs     GitHub 差异、AI 提交说明、提交与恢复
│       ├── project_store.rs     小说 Markdown/metadata 持久化
│       ├── resource_store.rs    书库、榜单、拆书和文风存储
│       └── runtime.rs           Node Agent 进程与 JSON 行 RPC 桥
├── sidecars/agent-runtime/src/
│   ├── main.ts                  Runtime 组合根和 stdin/stdout 生命周期
│   ├── rpc/                     registry 与按领域拆分的 RPC handler
│   ├── application/             模型客户端工厂等应用服务
│   ├── sources/                 书源、榜单、下载适配器
│   ├── context/                 上下文打包、Token 预算、持久缓存
│   ├── models/                  OpenAI/Anthropic 协议和 usage
│   ├── graphs/                  章节写作图
│   ├── storage/                 SQLite、FTS5、向量检索
│   └── streaming/               Agent 进度事件
├── schema/                      数据结构参考
├── scripts/                     构建和发布脚本
└── docs/                        专题文档与截图
```

## 平台边界

### 桌面端

React 通过 `src/services/agent-client.ts` 调用 Agent RPC，通过 `native-client.ts` 调用 Tauri 原生命令。Tauri 的 `runtime.rs` 负责：

- 启动和回收 Node Agent 子进程。
- 通过 stdin/stdout 传输 JSON 行 RPC。
- 转发流式进度事件。

`lib.rs` 负责本地项目/资源文件、备份恢复、系统命令和 Tauri command 注册。Node Agent 负责模型、上下文、章节写作、记忆、项目 Agent 和书源。

### Android 与 iOS

移动端复用前端端口，但不启动 Node 子进程。`src/platform/` 和 `src/platform.ts` 使用 Tauri HTTP 通道完成模型请求、书源访问和云同步；本地项目数据仍由 Tauri 数据层持久化。

## 共享契约

`packages/contracts` 是跨端 RPC 的唯一方法清单，`packages/model-protocol` 是桌面与移动端共用的模型协议纯函数：

- `AgentRpcMethodMap` 定义方法、参数和结果类型。
- `agentRpcSchemas` 在 Runtime 边界校验输入。
- `AgentProgressEvent`、`RpcError` 和 RPC envelope 统一桌面、移动端和 Runtime 约定。
- 认证头、Anthropic system/messages 转换、thinking 档位、reasoning effort 和正文块过滤只保留一份共享实现。
- `chapter-split.ts` 是拆章切点的唯一定义：`chapter.parts` 变更只带段落序号，桌面 Runtime、移动端和前端落地必须用同一套分段与切点规则；两边规则不同，同一个 `breakAfter` 就会切在不同位置，把正文拦腰截断。

前端通过 `agentRpc()` 调用，Runtime 通过 `RpcRegistry` 注册。迁移期间旧 Handler 可以由 registry 委托，但新方法必须先加入共享契约。

## Agent Runtime 模块

`main.ts` 只负责 Runtime 生命周期、上下文缓存和尚未迁移的组合逻辑。RPC 处理已按职责拆分：

- `rpc/model-handlers.ts`：模型列表、诊断、测试和用量。
- `rpc/content-handlers.ts`：作品信息和技能生成。
- `rpc/text-handlers.ts`：文本变换（润色、去 AI 味、续写、整章修订、按批注只改一段）。
- `rpc/library-handlers.ts`：书籍、榜单、拆书和文风相关 RPC。
- `sources/library-service.ts`：Fanqie、千阅、其他书源和榜单抓取。

章节写作仍由 `graphs/chapter-write.graph.ts` 编排：上下文准备、检索、承接、构思（简短确定事件、人物动机和结尾）、正文（纯文本，第一行章名）、本地验证门、审查。验证门（`packages/contracts` 的 `prose-lint` 与 `punctuation`，桌面端与运行时共用）不调模型：引号与停顿标点直接归一，风格句式只作为 advisory 提示，只有截断、复读、占位符与工程词泄漏触发一次定向修订。审查按项目设置分 full / lean / solo 三档，对照紧邻上一章原文核查已完成结果；字数不合格、重复事件或 S1/S2 跨章事实冲突自动修一次，再走验证门和审查。最终验收由 `packages/contracts/src/chapter-acceptance.ts` 前后端共用：修后仍不过才停草稿，不能伪造通过或覆盖旧章；手动覆盖前必须确认。模型拿不准的事写成「【给作者】」行，运行时剥出来交给界面，连续创作时汇总进大纲页的“给作者｜待答”。项目绑定了做过全书聚合的拆书时（`book.aggregate`，`application/benchmark.ts`），构思看情绪模块与节奏表，正文只带一段同基调原文锚点。

## 数据所有权

- Tauri 本地文件是项目和资源的持久化权威。
- React 只保存当前界面快照；`domain/` 类型不负责 IO。
- Agent Runtime 的缓存只保存有容量/生命周期限制的准备结果和会话摘要，不持有永久项目副本。
- Agent 变更先生成待确认提案，再由前端应用，避免模型直接写本地文件。

后续增量持久化应优先新增 `save_project`、`save_chapter` 等细粒度命令，逐步替代每次序列化完整项目数组；在此之前不改变现有文件格式。

## 性能与内存约束

- 流式正文通过 `requestAnimationFrame` 批量提交 UI，避免每个 chunk 触发一次 React render。
- 书源下载和分片上传使用固定并发，禁止无上限 `Promise.all`。
- LRU、会话和模型缓存必须有容量或 TTL；请求结束后不得由闭包继续持有完整正文和 Prompt。
- 上下文发送前使用模型 tokenizer 裁剪；Token 窗口为最大限制，不会扩大模型实际能力。
- Rust 无 GC，重点控制 `serde_json::Value` 深拷贝、整目录重写和一次性读入；文件操作需要路径校验和原子替换。
- 不调用手工 GC、不引入对象池；只有性能基线证明有分配热点时再优化。

## 验证命令

```bash
npm test
npm run typecheck
npm run build:shared
npm --prefix sidecars/agent-runtime run build
npm --prefix desktop-app run build
npm run check:rust
```

发布工作流会先执行 `npm run check`，再构建各平台安装包。严格桌面 TypeScript 检查使用 `tsc -b`。
