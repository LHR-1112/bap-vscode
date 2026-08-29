# BAP IDE（VS Code）开发规划 V1.1

> 版本说明（相对 V1.0 的变更）：
>
> - 定位从「多宿主开发运行时（Core + Host）」改为「**完整的 VS Code 插件**」。
> - 移除 Electron、独立 CLI 等未来宿主，不再面向多宿主。
> - 命令面即 VS Code 命令（`bapIde.*`）；并通过 **MCP** 自动暴露给 Claude Code、Codex、Copilot 等 AI 工具。
> - 参考实现：IDEA/Eclipse 插件 Java 源码（`/Users/lihongrui/SynologyDrive/kwaidoo/eclipse_plugin/Plugin`）。

---

## 一、项目定位

### 1.1 愿景

BAP IDE 是一个**完整的 VS Code 插件**，面向 BAP 云工程提供开发全流程能力：

登录、拉取、同步、编辑、提交、发布、编译、单元测试、历史查询、重定位、依赖同步、Jar 扫描等。

通过 WebSocket RPC 连接 BAP Server。

内部代码仍按 `rpc / sdk / core` 分层组织，保证可维护性与可测试性；

但**只面向 VS Code 一个宿主**，不做 Electron，不做独立 CLI。

### 1.2 UI 路线：VS Code 原生

整体 UI 全部采用 VS Code 原生能力，**不引入任何前端框架**（不用 React / Vue / Vite / Zustand 等）。

理由：

- SCM Provider（`vscode.scm.createSourceControl`）是 VS Code 官方为「非 Git 版本控制系统」预留的标准扩展点，
  可直接获得：改动清单、暂存/取消暂存、提交输入框（Enter 提交）、行内快速 diff、文件角标、`scm/title` 与 `scm/resourceState/context` 菜单等能力。
- 对以代码为中心的开发工具，原生列表 + 快捷键（Ctrl+Enter 提交、空格暂存）+ 编辑器内 diff 的手感，远优于自绘 UI。
- 复杂交互优先使用 VS Code 原生 UI：`QuickPick`、`InputBox`、`showInformationMessage/WarningMessage/ErrorMessage`、`withProgress`。
- 仅当需要展示富内容（日志、AI 对话、差异/发布预览）时，才用轻量原生 JS 的 Webview，**不引入前端框架**。

边界与约束：

- 不引入任何前端框架；不单独建设 UI 包，界面由插件本身以原生方式实现。
- BAP 无 Git HEAD，**语义映射：基线 = 云端**。即：Staged = 相对云端的本地待提交变更；Original（diff 左栏）= 云端版本；Commit = 提交到 BAP。
- 需要本地同步镜像目录（resourceUri 必须指向可打开的真实文件），并以 `TextDocumentContentProvider` 提供云端原版内容。
- 多工程：一个 BAP 工程一个 SCM provider（id / 角标 / 输入框独立）。
- SCM 视图塞不下表单，发布/部署等复杂流程由 SCM 触发生成原生对话框（QuickPick / InputBox）或原生 JS Webview。

### 1.3 AI 集成路线：MCP

插件向 Claude Code、Codex、Copilot 等 AI 工具**自动注册一个 MCP server**，
把命令面（`bapIde.*`）暴露为 MCP tools。

**一个 MCP tool ↔ 一个 VS Code 命令。**

这样 AI 无需为 BAP 各自编写 skill，即可直接驱动云工程操作。

---

## 二、总体架构

```
                    BAP Server
                        │
                WebSocket RPC
                        │
                 bap-rpc（TS）
                        │
                 bap-sdk（TS）
                        │
                   core（TS）
                        │
                 vscode-host
                        │
               命令面（bapIde.*）
                  │         │
          VS Code 原生 UI   MCP Server
          （SCM/TreeView/     │
            Command/Webview） │
                           AI 工具
                  （Claude Code / Codex / Copilot）
```

整个插件内部划分为四层：

### 第一层：RPC Runtime（bap-rpc）

负责：

- WebSocket
- RPC 协议
- 请求发送
- 请求等待
- 超时控制
- 回调
- Context
- Connection 生命周期

完全不依赖 VS Code。

---

### 第二层：BAP SDK（bap-sdk）

负责：

- 登录
- 项目管理
- 代码管理
- 提交
- 发布
- 调试
- 资源管理

SDK 不暴露 RPC。

SDK 面向业务。

例如：

```
sdk.login()

sdk.publish.gray()

sdk.project.list()

sdk.code.save()
```

而不是：

```
rpc.invoke(...)
```

---

### 第三层：Core（core）

公共模型：

```
DTO

Event

Model

Utils
```

避免业务与宿主之间重复。

---

### 第四层：VS Code Host（vscode-host）

插件本体，负责所有 VS Code 原生能力：

- SCM（代码变更主界面）
- TreeView（左侧导航）
- Command（命令面）
- StatusBar
- QuickPick / InputBox（表单与向导）
- Webview（日志、AI、预览等富内容）
- MCP Server（把命令面暴露给 AI 工具）

这里不写 RPC 细节，只编排 SDK 并呈现 UI。

---

## 三、技术栈

## Runtime

- TypeScript
- Node.js

---

## RPC

- WebSocket
- Promise
- Async/Await

---

## UI

- VS Code 原生 UI（SCM / TreeView / Command / StatusBar / QuickPick / InputBox / Webview）
- 仅日志、AI 等富内容使用原生 JS Webview，不引入前端框架

---

## AI 集成

- MCP（Model Context Protocol）
- 一个 MCP tool ↔ 一个 `bapIde.*` 命令

---

## 状态管理

无需前端状态管理库。

---

## UI 风格

尽量遵循 VS Code 原生设计。

颜色全部使用 VS Code Theme Variables。

避免与编辑器整体风格割裂。

---

# 四、目录规划

```
bap-ide/

    packages/

        rpc/

        sdk/

        core/

        vscode-host/

    apps/

        vscode
```

说明：

## rpc

RPC Runtime。

WebSocket 连接、协议编解码、序列化。

不依赖 VS Code。

---

## sdk

业务能力封装。

例如：

```
ProjectService

PublishService

CodeService

ResourceService
```

所有业务均调用 SDK。

---

## core

公共模型（DTO / Event / Model / Utils）。

避免业务与宿主之间重复。

---

## vscode-host

插件本体，唯一依赖 VS Code Extension API。

包括：

```
SCM

TreeView

Command

StatusBar

QuickPick / InputBox

Webview

MCP Server
```

这里不写 RPC 细节，只做编排与呈现。

---

# 五、RPC 迁移方案（参考 Java 源码）

现有 IDEA/Eclipse 插件（`/Users/lihongrui/SynologyDrive/kwaidoo/eclipse_plugin/Plugin`）已有一版实现，关键事实：

- RPC 核心为 `com.leavay.nio.crpc`，基于 **Netty 4.1.36** 的自研 CRPC 框架（位于 `tcmcat-*.jar` 依赖，不在插件源码内）。
- 远程服务接口：`CJavaCenterIntf`。
- 客户端包装：`CRpcClientWrapper<T>(T.class, uri)`。
- 会话上下文：`CRpcAdapter.setGlobalContext(CDaoConst.CTX_SESSION, _session)`。
- 单次调用超时：`CRpcAdapter.setTempTimeout(...)`。

现有 Java 调用链：

```
Service

↓

Proxy

↓

CRpcProxyCaller

↓

CRpcClient

↓

CRpcCodec

↓

CNioSerializer

↓

WebSocket
```

迁移到 TypeScript 后：

```
Service

↓

RpcClient

↓

RpcCodec

↓

Serializer

↓

WebSocket
```

动态代理无需迁移。

TypeScript 可直接封装：

```
sdk.project.create()

sdk.publish.gray()

sdk.code.save()
```

底层统一调用：

```
rpc.invoke(...)
```

目标：

Serializer 与 Java 完全兼容，**无需修改服务端**。

---

# 六、RPC 工作拆分

建议优先完成：

## 第一阶段

Connection

- WebSocket
- 重连
- Ping
- Timeout

---

## 第二阶段

Codec

实现：

Header

```
Magic

Version

Type

ReqID
```

Header 完全按照现有 Java 协议实现。

---

## 第三阶段

Serializer

按照 Java Serializer 实现。

目标：

TypeScript 与 Java 完全兼容。

无需修改服务端。

---

## 第四阶段

RpcClient

实现：

```
invoke()

wait()

callback

context
```

至此即可完成 Runtime。

---

# 七、VS Code 插件规划

## 代码变更主界面（SCM）

采用 VS Code 原生 Source Control（SCM）视图。

绑定 `vscode.scm.createSourceControl`，提供：

- 改动 / 已暂存 分组
- 提交输入框（Enter 提交）
- 行内快速 diff 与 Diff 视图（原版 = 云端，via `QuickDiffProvider` + `TextDocumentContentProvider`）
- `scm/title`、`scm/resourceState/context` 菜单（刷新 / 提交 / 发布 / 放弃更改 / 暂存 / 取消暂存）
- 文件角标装饰

---

## 表单 / 向导（原生 UI）

登录、发布配置、灰度量、日志、AI、设置等优先使用 VS Code 原生 UI：
`QuickPick`、`InputBox`、`showInformationMessage/WarningMessage/ErrorMessage`、`withProgress`；
仅当展示富内容（日志、AI 对话、差异 / 发布预览）时才使用轻量原生 JS Webview。

---

## 命令（命令面）

统一通过 Command 注册，命令面即 `bapIde.*`。

例如：

```
BAP: Login

BAP: Publish

BAP: Sync

BAP: Open Project

BAP: Commit
```

命令面同时是 MCP tool 的来源（见下）。

---

## MCP 集成

插件自动注册一个 MCP server，把命令面暴露给 AI 工具（Claude Code / Codex / Copilot）。

要点：

- **注册方式**：贡献点 `contributes.mcpServerDefinitionProviders`（package.json，声明 id + label）＋
  `vscode.lm.registerMcpServerDefinitionProvider(id, provider)`（activate 时注册实现）——两步配套，缺一不可。
  AI 工具无需手工配置即可发现。（API 以 VS Code 1.135 的 `vscode.d.ts` 为准。）
- **server 定义**：`provideMcpServerDefinitions()` 返回 `McpStdioServerDefinition`（本地子进程）或 `McpHttpServerDefinition`（Streamable HTTP 端点）。
  BAP 优先用 stdio（`node mcp-server.js`）。
- **登录钩子**：`resolveMcpServerDefinition(server, token)` 在 server 真正启动前被调用，可在此做登录校验、注入 session；返回 undefined 可中止启动。
- **映射**：一个 MCP tool ↔ 一个 `bapIde.*` 命令；tool 的输入 schema 由命令参数声明派生。
- **执行**：MCP server 进程在扩展宿主之外，不能直接调命令；经本地 IPC 把 tool call 转发回扩展宿主，由宿主执行 `vscode.commands.executeCommand(commandId, ...args)` 并回传结果。
- **命令分类**：
  - 可暴露为 tool（非交互）：download / commit / publish / compile / history / fetch-current / relocate / sync-libs / unit-test / scan-jars / login 等。
  - 不暴露为 tool（交互式）：打开 diff、打开文件、SCM 暂存等——需要编辑器 UI 参与，MCP 只做「触发」并回「已打开」，或干脆不暴露。

---

# 八、开发阶段

## 第一阶段

目标：

RPC Runtime。

验证：

```
sdk.login()
```

能够正常登录。

此阶段无需任何 UI。

---

## 第二阶段

完成 SDK。

实现：

项目

代码

资源

提交

发布

全部迁移。

---

## 第三阶段

实现 VS Code Host。

包括：

SCM Provider（改动清单 / 提交 / diff / 发布菜单）

TreeView

Command

StatusBar

Workspace

Editor

---

## 第四阶段

UI（VS Code 原生）。

完成：

- SCM：改动清单、暂存、提交、diff、发布菜单
- 原生 UI：登录、发布、日志、AI、配置（QuickPick / InputBox / 原生 JS Webview）

---

## 第五阶段

MCP 集成。

完成：

- 自动注册 MCP server
- 命令面 → MCP tools 自动生成
- 非交互命令可被 Claude Code / Codex / Copilot 调用

---

## 第六阶段

完成完整开发闭环。

开发者（人）能够：

登录

↓

打开项目

↓

同步代码

↓

编辑

↓

提交

↓

发布

↓

查看日志

同时 AI（经 MCP）能够执行同一套云工程操作。

---

# 九、长期规划

BAP IDE 就是一个**完整的 VS Code 插件**，不再规划多宿主。

长期目标收敛为：

1. **人可操作**：通过 VS Code 原生 UI（SCM / TreeView / Command）完成云工程全流程。
2. **AI 可操作**：通过 MCP 把同一套命令面暴露给 Claude Code / Codex / Copilot。
3. **协议稳定**：RPC 层（WebSocket + 序列化）与 Java 服务端兼容、无侵入，长期无需改服务端。

业务能力、RPC Runtime、SDK 保持平台无关，以便未来若需要可复用；

但 UI 与集成以 VS Code 为主，不做 Electron、不做独立 CLI。
