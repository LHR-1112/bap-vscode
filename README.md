# BAP IDE（VS Code）

面向 **BAP 云工程**的 VS Code 插件：通过 Java 桥复用官方 `com.leavay.nio.crpc` 连 BAP Server，
把云端工程当作「基线」做源码管理、调试、编译与测试。版本 `1.0.5`。

## 功能

- **源代码管理（SCM）**：云端为基线，分组「新增/更改/删除」；刷新、提交（全部/单个/分组）、发布插件（全量）、更新（全部/单个/分组）、打开 Diff / 文件；文件项右键菜单（打开文件/更新/提交/编译/调试/单测）。窗口内有多个后端工程时**每个工程一个 SCM provider**（`bap:<projectId>`，标题带工程名），互不干扰。
- **查看历史**：项目历史 / 文件历史——编辑器标签页 Webview（Lit），复刻 git view history；选中版本可回看前一版本 diff。
- **重定向工程**：切换 BAP Server（ws 地址 + 账号 + 密码），带本地历史（`<工程>/.bap/relocate-history.json`），可一键/编辑/新增。
- **下载工程**：从命令行按流式方式下载整包、解压、写 `.develop` 与 `.vscode/settings.json`（JDK8）。独立 BAP 工作区下载到工作区根并替换窗口；VotaForge 容器工作区默认下载到 `<工作区>/<工程名>` 子目录，不污染工作区根，下载后可加入工作区并重载。目标必须是工作区内的新目录：不能是 vf 根、不能与已有工程重叠；非空目录在交互路径需确认、MCP 路径直接拒绝。
- **更新依赖**：同步 `<工程>/lib` 到云端（服务端 md5 比对），更新 + 删除云端已无的本地 lib。
- **编译**：「编译项目（本地）」用 JDK javac 编译 `src/**`→`bin/`；「编译单类（云端）」调 `compileSingleCode` 并以诊断标记到编辑器行（波浪线 + 问题面板）。
- **启动调试**：把当前类发到云端运行（`startDebugJava`），在「BAP 调试」输出通道逐行显示 trace 与执行结果。
- **单元测试**：先 javac 编译、再 JUnit Platform（`junit-platform-console-standalone`）跑 `bin/` 下的测试类；输出到「BAP 单元测试」通道，并给测试类透传 `BAP_*`/`SILENT_BAP_*` 属性以连服务器。
- **AI / MCP 集成**：注册 MCP server（id=`bap`），把云工程能力暴露为 **18 个工具**（工作区信息/刷新/提交/发布/编译/单测/调试/历史/依赖/下载/重定向/项目列表/取云端当前文件等），供 Claude Code / Codex / Copilot 调用；配套技能 `skill/bap-vscode-mcp/`。无 `.develop` 时以引导模式启动，仅暴露自举工具。
- **Reset Agent Instructions**：重建工程根 `CLAUDE.md` / `AGENTS.md`（内容依据插件实际 MCP 工具与技能），按 BAP 标记段合并、保留用户已有内容；同时为 Claude Code（`.mcp.json`）与 Codex（`.codex/config.toml`）写入 MCP 配置。损坏的 `.mcp.json` 会跳过并警告，不会重建或覆盖。
- **安装技能**：`BAP: Install Skills` 把随扩展打包的全部 skill 复制到 `<VotaForge 根>/.votaforge/skill/`（枚举目录，不写死技能名；覆盖前模态确认，绝不自动安装）。
- **检查更新**：启动时后台检查 + 命令面板「检查更新」，检测手动 `.vsix` 安装的新版本。
- 全部数据流单向 `UI → Host → SDK → RPC → Server`。

## 目录结构

```
packages/
  core/          公共常量（BAP_IDE_NAME / BAP_IDE_VERSION）
  rpc/           Java 桥通信面：spawn 桥子进程，stdin/stdout JSON-lines，id/超时/进度
  sdk/           业务封装（.develop 读写、refresh/commit/publish/redirect/history/download/syncLibs/compile/debug/test），不暴露 RPC
  vscode-host/   VS Code 宿主（SCM、历史 Webview、命令、工具函数）
  java-bridge/   Java 桥源码（BridgeMain + BapRpcClient）与 jar 构建
apps/
  vscode/        插件本体（入口 + esbuild 打包 + vsix 资源）
```

## 关键机制 / 依赖

- **内置包不预编译**：`main`/`types` 直指 `src/index.ts`，由 esbuild 统一 bundle 进 `dist/extension.js`。
- **Java 桥**：`java-bridge` 复用生产 IDEA 插件的官方客户端，只做原子转发；运行时 jar 在 `apps/vscode/assets/bridge/lib/`（`build`/`package` 自动同步）。
- **运行时依赖**：本地编译/单测需本机 **JDK**（`javac`/`java`）；单测需 `apps/vscode/resources/junit/junit-platform-console-standalone-1.11.0.jar`（随插件打包）。

## AI 集成（MCP）

- 插件注册 MCP server（id=`bap`），暴露 **18 个**云工程工具（一个 MCP tool ↔ 一个 `bapIde.*` 命令）；配套技能 `skill/bap-vscode-mcp/`（`SKILL.md` + `references/`，说明 AI 如何调用）。
- **工作区级 vs 工程级**：`workspaceInfo` / `listProjects` / `downloadProject` 是工作区级工具；其余 15 个是工程级，均接受可选 `project`（projectId / projectUuid（忽略大小写）/ 工程名）。窗口内只有一个后端工程时可省略；多工程省略返回 `AMBIGUOUS` 与候选，先调 `workspaceInfo` 再显式指定。**不会**回退到活动编辑器或上次使用的工程。
- **返回结构**：工程级工具统一返回 `{ project: { projectId, displayName, root }, result }`；工作区级工具不包。错误含 code / 候选时末尾附 `BAP_MCP_ERROR_META: {...}` 行。
- **引导模式**：窗口至少有一个 workspace folder、但没有 `.develop` 时，MCP 只暴露 `workspaceInfo` / `listProjects` / `downloadProject`；先 `downloadProject`，把目录加入工作区并重载窗口，完整工具集才生效（工具列表在 MCP 进程启动时固定；重载后宿主会通知刷新，外部客户端自动重连并重新拉取）。`workspaceInfo.mcp.reloadRequired` 为 true 时同样需要重载。
- **启用 AI 客户端**：在 BAP 工程（含 `.develop`）里执行命令面板 `BAP: Reset Agent Instructions` —— 按 BAP 标记段合并 `CLAUDE.md` / `AGENTS.md`（保留用户已有内容），并写入：
  - Claude Code：工程根 `.mcp.json`（`mcpServers.bap`；损坏的 JSON 会跳过并警告，不重建）；
  - Codex：工程根 `.codex/config.toml`（`[mcp_servers.bap]`，需项目被 Codex 信任）。
  重启 Claude Code / 重载 Codex 窗口后即可看到 `bap` 服务器。`.mcp.json` 写在**当前后端工程根**；若 AI 客户端从 VotaForge 根启动，可能读不到该配置，请在客户端项目根另行配置或从后端工程根启动。
- MCP server 由插件宿主经 `dist/mcp-server.js` 提供，使用前需保持插件激活、窗口至少打开一个文件夹；IPC 端点写入 `~/.bap/mcp-ipc`，配置中不含 token，插件重载后无需改配置。
- **技能安装**：`BAP: Install Skills` 把随 VSIX 打包的全部 skill 复制到 `<VotaForge 根>/.votaforge/skill/<skill名>`；本插件技能安装后位于 `.votaforge/skill/bap-vscode-mcp`。VotaForge 的跨前后端任务路由由**顶层 routing skill**负责，本技能只描述 BAP 后端能力，不修改 `votaforge.workspace.json`。
- 说明：VS Code 扩展注册的 MCP 遵循 VS Code MCP 通道（Copilot/Agent Mode 可见）；Claude Code 与 Codex 需经上述配置接入。

## 多后端工程工作区

一个窗口可以打开 0..N 个后端工程（每个是含 `.develop` 的目录）：

- **发现**：扫描每个 workspace folder 及其子目录（默认最多 4 层），发现 `.develop` 即视为工程根，并跳过依赖/构建产物/隐藏目录。VotaForge 容器工作区（根有 `votaforge.workspace.json`、后端工程在子目录）与独立 BAP 工作区行为一致。
- **SCM**：每个工程一个独立 provider，id 为 `bap:<projectId>`，标题带工程名；分组仍是新增/更改/删除。Diff / QuickDiff / 历史按工程从云端取对应版本。
- **命令路由**：点击 SCM 资源、文件或编辑器菜单时，按资源路径自动定位所属工程；SCM 标题栏等无资源命令在多工程时弹出**多选**，按勾选顺序逐工程执行并汇总结果；`redirect` 只针对单个工程，避免误建重复检出。
- **projectId**：`<workspace 目录名>-<workspace folder 真实路径哈希 8 位>:<相对路径或 .>`，用于 SCM id、虚拟文档 URI 和批量结果标识；哈希的是 workspace folder 真实路径（不是工程根），移动/重命名 workspace folder 后可能变化。
- **MCP 工程选择**：`workspaceInfo` 列出全部工程的 projectId / 工程名 / 路径 / 云端 uuid / 注册状态；工程级工具用可选 `project` 选择目标，多工程时省略会返回 `AMBIGUOUS` 与候选，不会隐式回退。
- **重复检出**：同一 `.develop` 工程 uuid 出现多份检出时会被标记。隐式写操作（如标题栏提交）会拒绝落到重复检出，需在 SCM/路径/多选中明确选择；只读操作不受限。

## 配置项

设置 → BAP IDE：
- `bapIde.java8Path` — JDK 1.8 路径（编译/下载工程/单测用其 javac 与 java）。
- `bapIde.refreshTtlMs` — 自动刷新复用云端快照的间隔（默认 `30000`ms）。
- `bapIde.updateFeedUrl` — 检查更新来源 URL（留空用 GitHub Release）。
- `bapIde.checkUpdateOnStartup` — 启动时后台检查更新（默认 `true`）。

## 开发 / 构建 / 打包

```bash
npm install                  # 安装依赖（workspaces）
npm run compile              # esbuild → apps/vscode/dist/extension.js（快）
npm run watch                # 监听构建
npm run typecheck            # TypeScript 类型检查（tsc --noEmit）
npm run build                # 完整构建 + 打包 .vsix → 根 dist/（bap-ide-vscode-<version>.vsix）
npm run package              # 同 build（构建 + 打包）
```

## 调试

在 VS Code 打开本仓库根目录，按 `F5`（`.vscode/launch.json`）会以开发模式启动一个新窗口加载 `apps/vscode` 插件。
> 注意：SCM / 连服务器依赖窗口内存在含 `.develop` 的后端工程（插件会扫描 workspace folder 及子目录，最多 4 层），
> 可直接打开 `gpf_dc_practicalTool` 这类 BAP 工程，也可打开 VotaForge 容器工作区（后端工程在子目录中）；
> 仓库根自身没有 `.develop`，仅能看到命令面板命令。
