# VotaForge_Frontend — 面板契约前端工程插件

> 状态：**活跃**（即当前 VotaForge Workbench 工程的延续形态）
> 体系总览：[plugin-split.md](./plugin-split.md) · 兄弟插件：[VotaForge_Lite](./votaforge-lite.md) · [VotaForge_Modeling](./votaforge-modeling.md) · [VotaForge_BAP](./votaforge-bap.md) · 共享组件：[CDP 布局器](./votaforge-layout-designer.md)

## 定位

后厂「前端工程」的第一形态：**基于面板契约的独立前端工程生成插件**。

以 GPF 云端面板设计定义为唯一事实源，拉取后提取 `PanelContract`，生成类型化前端 API，配套前端 SDK 与运行时网关，
支撑 React/Vite **独立前端工程**的脚手架、开发联调与交付。产物是标准的独立前端工程（`votaforge.workspace.json` + `app/` + `api/`），
可脱离插件独立运行与部署。

它是整个面板交付链的拥有者：`拉取面板定义 → 提取契约 → 快照确认 → 生成 API → 运行联调` 全部归本插件（决策 D2）。

## 能力描述

### 1. 面板契约同步链（核心）

```
插件「拉取面板变更」/ vf pull
  → PanelSdkClient.getPanelDesignDefinition(List)（按 busDomainCode）
  → extractContract（远端设计定义 → PanelContract：fields/actions/events/dependencies/statuses）
  → 写入 incoming 快照（.votaforge/snapshots/<environmentId>/incoming/）
  → diffContracts 对比 active（breaking 破坏性 / compatible 兼容性）
  → 用户确认（「接受变更」/ vf sync --yes；--panel 部分面板）
  → generate 生成 api/
  → promote：incoming → active
```

- **两阶段快照**：`incoming`（候选）与 `active`（基线）分离，只有 `active` 参与生成 API 与启动网关；接受失败时 `active` 不变
- **云端为源**：本地不保存可编辑的面板模型，云端「业务建模器」是建模处，本插件只做契约交付
- **多环境**：快照按 `environmentId` 命名空间隔离；`.votaforge/server-profiles.json` 管理 profiles

### 2. 代码生成（codegen）

从 `PanelContract[]` 原子生成类型化前端 API（先写临时目录再替换，清理不在清单里的旧文件）：

- `api/index.ts` — 命名空间导出（`export * as <panelCode> from './panels/<code>/index.js'`）
- `api/panels/<code>/<code>.api.ts` — fields/form/query/actions 调用方法
- `api/panels/<code>/<code>.types.ts` + `<code>.meta.json` — 数据类型与元数据
- `api/meta/workspace.json` — 面板编号清单

### 3. 前端 SDK 双形态（@votaforge/sdk）

- **浏览器直连**（`./browser`，脚手架默认形态）：`createBrowserPanelRuntime` 在浏览器内直接运行 PanelX SDK（bundled vendor），不经本地网关；登录/登出/会话事件/健康检查/附件 URL
- **网关模式**（主入口）：`configureVotaForge({ endpoint })` → `vf.call()` → HTTP POST 到本地运行时网关
- 辅助模块：表单运行时上下文与权限矩阵、附件行解析、会签实例解析、选项值处理

### 4. 运行时网关（runtime-gateway）

无状态 HTTP 服务器，接收应用层 `vf.call()` 请求转发到 PanelX SDK（不推进流程、不执行表达式、不保存实例）。
启动需 `active` 快照。拆分后建议以 `vf gateway` 子进程形态运行（token 经环境变量传入），插件不内嵌 PanelX worker（决策 D5）。

### 5. 脚手架（vf create）

生成标准前端工程：`votaforge.workspace.json` + `server-profiles.json` + React/Vite 应用 + vendor SDK 落地 + `api/` 目录。
前端工程根由 `applications[].rootDir` 配置声明，平铺（`rootDir: "."`，纯前端独立工程）与容器（`rootDir: "web"`，多工程 workspace）两种布局均合法——见 workspace-protocol.md §4.1/§6。

### 6. MCP Server（vf mcp）

面向 Coding Agent 的 stdio MCP：9 工具（`list_panels` / `get_panel_contract` / `check_updates` / `get_contract_diff` / `get_all_diffs` / `generate_api` / `sync_panels` / `get_generation_status` / `get_agent_tasks`）+ 3 资源。默认不返回业务数据、不暴露 Token。

## CLI

**`vf`**（本插件独占；拆分后删除 `votalite` 子命令）：

```
vf create | pull | status | diff | sync | generate | gateway | mcp | --version | --json
```

凭据：`VOTAFORGE_TOKEN` 或 `VOTAFORGE_USERNAME` + `VOTAFORGE_PASSWORD`；多环境 `--environment <id>`。

## 扩展侧体验

- **面板**视图：面板树（新增/契约变更/源变更/一致），右键查看契约/Diff/接受变更/依赖计划确认
- **运行**视图：开发环境（启动/停止/打开应用）+ 服务器环境（登录/登出/切换环境）
- **开发者设置**：PanelX SDK 请求捕获开关 → Network 面板（DevTools 风格请求列表 + 详情 + 环形缓冲 1000 条）
- 命令：拉取面板变更 / 接受变更并生成 API / 重新生成 API / 搜索面板 / 登录登出 / 安装 CLI / `vf create`

## 组件与仓库布局

| 层 | 组件 |
|----|------|
| packages | `panel-contract` `panel-sync` `codegen` `sdk` `runtime-gateway` `cli` `mcp-server` |
| extension | PanelTreeProvider / DevelopmentController / RuntimeTreeProvider / DevSettingsViewProvider / NetworkPanelProvider / PanelSyncService / ServerEnvironmentService / WorkspaceDiscoveryService / RuntimeStateService / CliInstallationService / LoginPanel / DependencySyncPanel |
| tooling | `build-extension.mjs` `build-sdk.mjs` `pack-cli.mjs` `build-skills.mjs` `dev-extension.mjs` |
| skills | `votaforge-frontend` `votaforge-panel-integration` `votaforge-panel-verification` |
| 共享依赖 | `@votaforge/model` `@votaforge/connection`（新抽） `@votaforge/panelx-sdk-adapter` |

## 与其他插件的关系

- **VotaForge_Lite**：Lite 的模型「发布生效」后，云端面板定义变更经本插件的同步链进入前端工程——两者通过云端产物衔接，无直接依赖
- **VotaForge_Modeling**（暂缓，建模主体）：面板定义的推送/编辑归它；本插件只做拉取与契约交付
- **VotaForge_BAP**：后端 Java 工程，与本插件无运行时关系；业务上通过面板动作 → 后端服务衔接
- **[CDP 布局器](./votaforge-layout-designer.md)**（共享组件，待集成）：布局器构造出的云端页面与契约驱动工程的应用如何衔接，立项时定义（open question Q6）

## 状态与路线

- 当前工程即本插件的实现体，功能完整（同步链 + 双 SDK + 网关 + 脚手架 + MCP）
- 路线：P0 契约冻结 → P2 修剪 VotaLite 相关组件 → 独立 VSIX 发版（见 plugin-split.md 迁移阶段）
