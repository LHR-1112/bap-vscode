# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目是什么

BAP IDE —— 面向 BAP 云工程的 VS Code 插件。通过 WebSocket RPC 连接 BAP Server，提供登录 / 拉取 / 同步 / 提交 / 发布 / 编译 / 单元测试 / 历史 / 重定位 / 依赖同步 / Jar 扫描等云工程能力。

权威开发规划：`docx/BAP IDE（VS Code）开发规划 V1.0.md`（标题为 V1.1）。

参考实现（Java 版 IDEA/Eclipse 插件源码，RPC 协议以此为准）：`/Users/lihongrui/SynologyDrive/kwaidoo/eclipse_plugin/Plugin`。

## 常用命令

```bash
npm install         # 安装依赖（npm workspaces）
npm run compile     # 构建插件（esbuild → apps/vscode/dist/extension.js）
npm run watch       # 监听构建
npm run typecheck   # TypeScript 类型检查（tsc --noEmit）
npm run package     # 打包 .vsix（vsce）
```

调试：VS Code 打开仓库根目录，按 F5（配置在 `.vscode/launch.json`），以开发模式加载 `apps/vscode` 插件。

## 架构

npm workspaces monorepo，四层（自下而上，数据流单向 `UI → Host → SDK → RPC → Server`）：

- `packages/core`（`@bap/core`）—— 公共模型 DTO / Event / Model / Utils
- `packages/rpc`（`@bap/rpc`）—— RPC Runtime：WebSocket / 协议 / 序列化 / 连接生命周期，**不依赖 VS Code**
- `packages/sdk`（`@bap/sdk`）—— 业务封装，不暴露 RPC（对外是 `sdk.login()` 而非 `rpc.invoke()`）
- `packages/vscode-host`（`@bap/vscode-host`）—— VS Code 宿主：SCM / TreeView / Command / StatusBar / MCP
- `apps/vscode`（`bap-ide-vscode`）—— 插件入口 + 打包

关键机制：

- 内部包 `main`/`types` 直指 `src/index.ts`，**不预编译**；由 esbuild 在 `apps/vscode` 打包时统一 bundle 进 `dist/extension.js`。改内部包源码后直接 `npm run compile` 即可，无需逐包 build。
- esbuild 设了 `external: ['vscode']`，运行时的 `vscode` 模块由扩展宿主注入。

## RPC 迁移（最重要约束）

RPC 协议需从 Java 版迁到 TypeScript，核心约束：

- **服务端不变，Serializer 必须与 Java 完全兼容**（二进制协议，非 JSON）。
- Java 侧：`com.leavay.nio.crpc`（Netty 4.1.36），远程接口 `CJavaCenterIntf`，`CRpcAdapter.setGlobalContext(CDaoConst.CTX_SESSION, session)` 传会话，`CRpcAdapter.setTempTimeout(...)` 设超时。
- 实现顺序（见规划 §六）：Connection（WebSocket/重连/Ping/Timeout）→ Codec（Header：Magic/Version/Type/ReqID）→ Serializer → RpcClient（invoke/wait/callback/context）。

## 产品决策（勿推翻）

- 不引入任何前端框架（无 React / Vue / Vite / Zustand）。UI 全用 VS Code 原生：SCM / TreeView / Command / StatusBar / QuickPick / InputBox / 原生 JS Webview。
- 代码变更主界面 = VS Code 原生 SCM（`vscode.scm.createSourceControl`），语义映射「基线 = 云端」（Staged = 相对云端的本地变更，Original = 云端版本，Commit = 提交到 BAP）。
- MCP 集成：`contributes.mcpServerDefinitionProviders` + `vscode.lm.registerMcpServerDefinitionProvider`；一个 MCP tool ↔ 一个 `bapIde.*` 命令。

## 工作约定

- **尽量使用 subagent**：独立任务、搜索、多文件阅读，优先派发给 subagent（Agent 工具）并行执行，把结论带回主会话，不要在主会话里逐个翻文件。
- **代码修改尽量先 plan mode**：非平凡的代码改动，先用 EnterPlanMode 探索并给出方案，经用户确认后再动手写代码。
