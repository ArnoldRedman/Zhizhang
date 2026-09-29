# AI写作软件｜AI写小说软件｜织章 Zhizhang

**关键词：AI写作软件、AI写小说软件、AI网文写作、小说智能体、长篇小说创作、网文大纲、章节记忆、Tauri 多端写作。**

> 织章是一款面向长篇网文创作的 AI 写作软件、AI 写小说软件和本地优先写作工作台。

[![Version](https://img.shields.io/badge/version-0.1.6-1677ff)](https://github.com/ArnoldRedman/Zhizhang/releases)
[![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Android%20%7C%20iOS-20a162)](#下载安装)
[![License](https://img.shields.io/badge/license-AGPL--3.0--or--later-8a2be2)](LICENSE)

织章将作品资料、世界观、大纲、章节、角色卡、记忆与写作技能组织在一个本地项目中。它面向需要持续创作、追踪设定与维持上下文一致性的长篇网文作者，而不是一次性文本生成器。

## 下载安装

安装包与版本更新记录发布在 [GitHub Releases](https://github.com/ArnoldRedman/Zhizhang/releases)。

当前提供 macOS、Windows、Android 与 iOS 构建版本。iOS 安装包为未签名 IPA，需使用适合设备的签名或安装方式导入。

## 快速上手

应用自带「设置 - 使用教程」快速上手清单。核心流程如下。

### 一、配置模型接口

织章不内置任何模型中转厂商，接口地址与 API Key 都由你自己填写。

1. 打开设置，在「模型与接口」点「+ 新增配置」。
2. 选择接口协议：OpenAI 兼容（`/v1/chat/completions`）或 Anthropic Messages（`/v1/messages`）。
3. 填写接口地址与 API Key。
4. 点击「拉取模型」，勾选要启用的模型并保存。

### 二、小说管理

1. 新建小说。
2. 新建总纲。
3. 新建世界观与作品设定。
4. 新建主角卡片和金手指卡片。
5. 创建章纲；章纲上可以填本章信息边界（读者已经知道、视角人物已经知道、必须隐瞒、只能暗示）。
6. 在大纲页的「承诺账」里登记伏笔与节奏（例如灯塔上的枪在第 30 章必须响，或每 8 章发一次糖）。
7. 根据章纲生成章节正文。
8. 在记忆中心查看章节记忆。
9. 查看知识图谱。
10. 使用 AI 检测、AI 润色和去 AI 味。
11. 绑定文风，并在作品设置选择原文参考章节（可留空）。

桌面端需要连同前后章节一起调整时，使用章节面板的「关联修订前后章节」，补充具体要求后发送给项目 Agent。它可以读取原文，直接编辑或委派生成章节、大纲、卡片，再读取临时稿检查衔接。变更统一在项目 Agent 中预览、应用，章节旧稿保留在历史版本中；修订后的章节记忆会重新提炼。

写章上下文按配置的模型窗口分配：总纲放得下时保留全文，全书前文摘要进入账本，近期原文优先保留整章。归档说明和空章纲不算有效规划，会在写章前重新生成。上述关联修订循环目前由桌面运行时提供，移动端本地模型直连仍使用原有提案流程。

写作提示词里的约束只写「本章要做什么」：信息边界每章最多两条，到期的承诺要落到具体场面，还没拍板的问题要求给一次进展或表态而不是绕开。该收的线有没有收、有没有说破不该说的事，由审查报告核对，不用再加禁止项。承诺账里没填期限也没填节奏的条目只是备忘，不会进提示词。

### 三、书籍管理

1. 搜索并下载书籍。
2. 下载完成后，可调用 AI 生成章纲，也可以一键拆书到拆书管理。
3. 使用“蒸馏文风”Skill 提取参考作品的写作风格。

### 四、拆书管理

可以选择书籍管理中的小说进行拆书，生成结构、节奏、人物和文风分析。

### 五、扫榜管理

扫榜支持番茄、起点和飞卢榜单，可查看榜单书籍及封面信息。

### 六、技能管理

1. 技能管理中提供软件内置的默认技能。
2. 可以新建自定义技能，用于扩展写作流程。

### 七、文风管理

可以新建文风，并添加图标、封面和文风说明，供章节写作时绑定使用。

## 界面预览

以下截图来自 v0.1.4 的实际构建，用于展示主要工作流；移动端采用独立的窄屏布局。

| 首页 | 新建小说 |
| --- | --- |
| ![首页](docs/screenshots/home.png) | ![新建小说](docs/screenshots/new-project.png) |

### 移动端章节编辑器

![移动端章节编辑器](docs/screenshots/mobile-chapter-editor.png)

## 使用方式

1. 在“设置”中填写自己的接口地址与 API Key，拉取该 Key 可用的模型并选择模型。
2. 新建小说，先建立世界观与作品设定，再创建总纲、章纲或正文。
3. 保存正文后确认章节记忆，后续章节会按固定资料、历史摘要与最近对话的顺序构建上下文。
4. 通过“设置 - 备份与同步”创建完整备份，在新设备上恢复同一份创作资料。

## 架构

```text
织章/
├── packages/contracts/      # 桌面、移动端与 Agent Runtime 共享 RPC 契约
├── packages/model-protocol/ # OpenAI/Anthropic 共享纯协议规则
├── desktop-app/             # React + TypeScript + Tauri 多端客户端
│   ├── src/domain/          # 项目、书库和技能领域模型
│   ├── src/features/        # 按功能组织的 UI 与会话模型
│   ├── src/services/        # Agent/原生能力端口
│   ├── src/platform/        # 移动书源与云同步适配器
│   └── src-tauri/           # Rust 原生能力与移动端工程
├── sidecars/agent-runtime/  # Node.js 写作智能体、上下文和本地存储
├── schema/                  # 本地数据结构
└── scripts/                 # 版本发布脚本
```

- **客户端**：React、TypeScript、Vite、Tauri 2，按 domain/features/services/platform 分层。
- **智能体运行时**：Node.js、TypeScript，RPC registry 按模型、内容、书库和写作职责分发。
- **共享契约**：`packages/contracts` 统一 RPC 方法、DTO、进度事件和运行时参数校验。
- **共享模型协议**：`packages/model-protocol` 统一认证、thinking/reasoning 和 Anthropic 消息转换。
- **本地数据**：项目资料保存在用户设备本地；同步由用户主动触发。

## 本地开发

### 环境要求

- Node.js 20+
- Rust stable 与 Tauri 对应平台依赖
- 平台构建工具：Xcode（iOS/macOS）、Android SDK（Android）、Windows 构建环境（Windows）

### 启动

```bash
npm install
npm install --prefix desktop-app
npm run tauri:dev --prefix desktop-app
```

### 构建

```bash
npm run tauri:build --prefix desktop-app
```

移动端构建步骤请查看 [desktop-app/MOBILE.md](desktop-app/MOBILE.md)。

## 隐私边界

- 模型渠道、余额、计费与风控由你自己配置的中转站或模型厂商负责，不在本仓库内。
- API Key、访问令牌、签名证书、个人小说内容和云端备份内容不随源码提交。
- 请勿在 Issue、Pull Request、日志或截图中提交任何 Key、Cookie、备份文件或私密作品资料。


## 贡献

欢迎提交 Bug 报告、功能建议与 Pull Request。开始前请阅读 [贡献指南](CONTRIBUTING.md) 与 [安全策略](SECURITY.md)。

## 许可证

本项目以 [GNU Affero General Public License v3.0 or later](LICENSE) 发布。第三方依赖仍受各自许可证约束。
