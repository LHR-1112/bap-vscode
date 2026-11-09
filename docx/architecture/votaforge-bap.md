# VotaForge_BAP — 后端 Java 工程插件（外部现有）

> 状态：**外部现有插件**（不动本体，独立发版）
> 体系总览：[plugin-split.md](./plugin-split.md) · 兄弟插件：[VotaForge_Lite](./votaforge-lite.md) · [VotaForge_Modeling](./votaforge-modeling.md) · [VotaForge_Frontend](./votaforge-frontend.md)
> 工程位置：`/Users/lihongrui/Documents/bap-vscode/`（VS Code 插件 monorepo，独立于本仓库）

## 定位

后厂「后端工程」：**BAP 云工程 Java 开发插件**。

面向 BAP 云工程提供 Java 后端的 IDE 集成开发体验：Java 桥复用 `com.leavay.nio.crpc` RPC 连接 BAP Server，
把云端工程当基线做 SCM（提交/发布/更新/历史）、重定向工程、整包下载、依赖同步、编译、云端调试、单元测试，
并把云工程能力暴露为 17 个 MCP 工具，供 AI Coding Agent 直接调用。

## 能力描述

### 1. 云端工程 SCM

- 以 BAP 云端工程为基线：提交 / 发布 / 更新 / 历史 / 重定向工程
- 整包下载、依赖同步

### 2. 编译与运行

- 编译（单文件 / 工程级）、云端调试、单元测试

### 3. MCP 工具（17 个）

`commit` / `commitFile` / `compileFile` / `compileProject` / `debugClass` / `downloadProject` / `fetchCurrent` /
`fileHistory` / `listProjects` / `projectHistory` / `publish` / `redirect` / `refresh` / `testProject` /
`updateAll` / `updateFile` / `updateLibs`

（本仓库开发环境已接入该 MCP server，可直接调用。）

### 4. 配套 Skill

`bap-vscode-mcp`：指导 Coding Agent 通过 BAP MCP 对云工程执行云端操作（刷新差异、提交、发布、编译、测试、调试、
历史查询、获取云端当前代码、更新依赖、重定向等）。

## CLI

**不强行再造**。BAP 已有自己的 CLI/MCP 体系；如出现终端/CI 自动化需求，再补独立 CLI 入口即可（不必为四插件形式对称而造）。

## 接入方式（本体系只做三件事）

1. **workspace 引用**：`votaforge.workspace.json` 增加可选 `backend` 段（`projects: [{ name, bapProject }]` 数组，可多个，由编排层 workspace 编辑 skill 写入——决策 D12），
   使「面板 → 前端 API → Java 后端」链路可追溯（决策 D6：单文件演进，不另立 workspace 文件）。
   只记云工程引用，**不记本地检出路径**（机器相关的私有状态，不进契约；需要本地代码走 BAP MCP）；
   **不记 `.develop` 标记字段**——`.develop` 是协议常量，后端工程根由标记扫描发现（workspace-protocol.md §6.1，决策 D13）
2. **skill 编排**：场景编排 skill 在需要后端时路由到 `bap-vscode-mcp` 与 BAP MCP 工具
3. **不集成代码**：crpc / 云端工程逻辑不进本仓库扩展代码，避免原生依赖与 RPC 污染共享层打包

## 公共层纪律（重要）

- BAP 连接 BAP Server 的 RPC **不**强行放进共享 GPF 连接层（`@votaforge/connection`）——两者是不同服务器、不同协议、不同鉴权
- 共享层只抽真正通用的东西；BAP 的通用性边界在于 workspace 引用段与 skill 约定，而非运行时设施

## 与其他插件的关系

- **VotaForge_Frontend**：业务上通过面板动作 → 后端服务衔接（HTTP 接口 / 规则函数 / Cell）；工程上仅 workspace 引用关联
- **VotaForge_Lite / VotaForge_Modeling**：建模插件定义业务对象与面板，BAP 实现其背后的 Java 服务；无运行时关系
- 依赖方向：其余插件可引用 BAP 工程（`backend` 段），BAP 不依赖任何 VotaForge 插件

## 状态与路线

- **现状**：独立插件，独立发布与维护
- **路线**：维持现状；需要时增加 workspace `backend` 引用段 + 场景编排 skill 中的路由
