# 织章桌面端

织章桌面端是基于 **Tauri 2、React、TypeScript 和 Node.js Agent Runtime** 的本地优先长篇小说创作应用。它提供项目写作、书籍管理、拆书、扫榜、文风、技能、记忆、知识图谱、项目 Agent、批量审查和本地备份等功能。

## 当前工作区

打开一本小说后，编辑器顶部提供三个视图：

- **写作**：章节目录、正文编辑和章节操作。
- **资料**：本章资料、章纲、信息边界、承诺账、卡片、图谱、文风、技能和记忆。
- **任务**：连续创作、重写旧章、旧章审查和批量修订。

右上角的「项目 Agent」支持讨论、计划和执行模式。执行前会生成待确认变更，应用后才写入项目；「更多」菜单包含历史、通读、统计、格式化、导出和快捷键。

## 开发环境

- Node.js 20+
- Rust stable
- Windows 需要 WebView2 和 Rust 的 Windows 构建环境
- macOS/iOS 需要 Xcode；Android 需要 Android SDK

## 安装依赖

从仓库根目录执行：

```bash
npm install
npm install --prefix desktop-app
```

## 开发模式

```bash
npm run tauri:dev --prefix desktop-app
```

该命令会准备 Agent Runtime、启动 Vite 和 Tauri 窗口。需要单独调试前端时，也可以在 `desktop-app` 目录执行：

```bash
npm run dev
```

## 构建

构建桌面端：

```bash
npm run tauri:build --prefix desktop-app
```

构建脚本会先编译共享契约和 Agent Runtime，再执行前端构建和 Rust release 构建。桌面产物位于 `desktop-app/src-tauri/target/release/`；带安装包的构建产物位于其 `bundle/` 子目录。

移动端构建见 [MOBILE.md](MOBILE.md)。

## 目录结构

```text
desktop-app/
├── src/
│   ├── domain/       # 作品、章节、书库、技能和导出模型
│   ├── features/     # 章节、记忆、Agent、书库等功能逻辑
│   ├── platform/     # 移动端书源与同步适配
│   ├── services/     # Agent、原生存储和平台能力端口
│   ├── App.tsx       # 当前桌面工作区组合与页面交互
│   └── App.css       # 应用样式
├── src-tauri/
│   ├── src/           # Rust IPC、资源存储、备份和 Agent 生命周期
│   └── tauri.conf.json
├── scripts/           # Agent Runtime 准备脚本
└── package.json
```

Agent Runtime 位于仓库根目录的 `sidecars/agent-runtime`，共享 RPC 契约位于 `packages/contracts`，模型协议位于 `packages/model-protocol`。

## 验证

Agent Runtime 类型检查：

```bash
npm run typecheck --prefix sidecars/agent-runtime
```

桌面端类型检查和 lint：

```bash
npm run typecheck --prefix desktop-app
npm run lint --prefix desktop-app
```

完整构建会自动执行共享包构建、Agent Runtime 准备、Vite 构建和 Tauri 构建。

## 数据和安全

Tauri 负责把项目、书籍、拆书和文风保存到本机应用数据目录，正文和较大的资料会拆成独立文件。备份与同步由用户主动触发。

不要把 API Key、访问令牌、Cookie、个人小说正文、备份包或构建产物提交到 Git。仓库许可证见根目录 [LICENSE](../LICENSE)，贡献规范见 [CONTRIBUTING.md](../CONTRIBUTING.md)。
