---
name: bap-vscode-mcp
description: 使用 BAP IDE（VS Code 插件）注册的 MCP server，对窗口内 0..N 个 BAP 云工程执行云端操作——workspaceInfo 工作区/工程概览、刷新差异、提交、发布、编译、单元测试、调试、历史查询、获取云端当前代码、更新依赖、重定向、下载工程等。适用于当前工作区包含一个或多个 BAP 云工程（存在 .develop），或尚无后端工程、需要通过 MCP 下载工程自举（引导模式）的场景；多工程时用可选 project 参数（projectId / projectUuid / 工程名）选择目标。不适用于规则函数开发、HTTP 接口开发、平台部署、或纯 CLI 场景（应改用 bapdev-cli 技能），也不适用于 IDE 菜单操作说明。
---

# BAP IDE MCP 技能

在 VS Code 工作区中，BAP IDE 插件会注册一个 MCP server（id=`bap`），把窗口内 0..N 个 BAP 后端云工程的能力暴露成 MCP 工具（共 18 个），供 Claude Code / Codex / Copilot 调用。本技能说明如何用这些工具，包括多工程目标选择与引导模式自举。

## 适用范围

适用：

- 当前工作区包含一个或多个 BAP 云工程（任意 workspace folder 的根或其子目录存在 `.develop`），用户要求做云端操作（刷新 / 提交 / 发布 / 编译 / 单测 / 调试 / 历史 / 取当前代码 / 同步依赖）。
- 窗口已打开工作区但还没有后端工程（引导模式），用户要求查看工作区、列出服务器工程或下载 BAP 工程。
- 用户明确要求 "通过 MCP / 让 AI 调用 BAP 能力"。
- 需要组合多个云工程操作完成一个上层目标（如：先 refresh 看差异，再提交，再发布）。
- VotaForge 工作区中的任务需要落到 BAP 后端：跨前后端 / 多工程的编排由**顶层 routing skill**负责，本技能只描述后端云工程能力。

不适用：

- 用户要求开发规则函数、HTTP 接口、数据库结构、权限矩阵、微服务——用对应的 `gpf-*` 开发技能。
- 用户要求平台部署、启动停止服务——用 `gpf-platform-deploy`。
- 用户要求纯命令行的云工程操作（无 VS Code / 无 MCP）——用 `bapdev-cli` 技能。
- 用户只是在聊 BAP 概念，没有明确要通过 AI 操作云工程。

## 前提

用 MCP 工具前应确认：

1. 窗口至少打开一个 workspace folder（完全无 folder 时 MCP 不启动）。插件扫描每个 workspace folder 及其子目录（最多 4 层），发现 `.develop` 普通文件即视为后端工程根；一个窗口可发现 0..N 个工程。
2. 窗口内 0 个后端工程时，MCP 以**引导模式**启动，只暴露 `workspaceInfo` / `listProjects` / `downloadProject`；调用其它工具返回 `BOOTSTRAP_MODE` 错误。
3. 已连接：`.develop` 已配置 ws 地址、账号、工程；引导模式下没有 `.develop`，`listProjects` / `downloadProject` 需显式提供 `uri` / `user` / `pwd`。
4. 插件版本 ≥ 1.0.5（MCP 集成自 1.0.3 起；`project` 参数、`workspaceInfo`、引导模式自 1.0.5 起）。

若 AI 发现工具列表只有 3 个工具，通常是引导模式而非故障。若工具列表为空或调用报 `server not found`，先引导用户：打开含 workspace folder 的窗口（或包含后端子目录的 VotaForge 工作区）、确认插件已激活、重载窗口。

## 多工程工作区

- 一个窗口内可能有 0..N 个后端工程（每个含 `.develop`）；每个工程有独立的 SCM 与云端连接，互不影响。
- 15 个工程级工具都接受**可选** `project` 参数，取值按以下顺序解析（命中即停）：
  1. `projectId` 精确匹配；
  2. `projectUuid` 匹配（忽略大小写）；
  3. `displayName` 精确匹配；
  4. `displayName` 忽略大小写匹配。
  任一类别命中多个工程即返回 `AMBIGUOUS`（附候选），**不会降级到下一类别**。
- 窗口内只有 1 个后端工程时可省略 `project`；多个工程时省略会返回 `AMBIGUOUS` + 候选，必须先调用 `workspaceInfo` 获取候选，再显式传 `project`，不要盲目重试。
- 省略 `project` 时**不会**回退到活动编辑器所属工程或上次使用的工程。
- 工程级工具的结果统一包为 `{ "project": { "projectId": "...", "displayName": "...", "root": "..." }, "result": <原结果> }`；单工程时同样包。`workspaceInfo` / `listProjects` / `downloadProject` 是工作区级工具，不包 envelope。
- 批量操作（一次作用于多个工程）仅在 VS Code 界面提供；一次 MCP 调用只作用于一个工程。
- 同一云端工程存在多份本地检出时，隐式写操作会被拒绝；可用显式 `project` 选择具体检出，或从对应 SCM 资源 / 文件触发。
- `downloadProject` 的目标目录不能是 vf 工作区根，也不能与已有后端工程重叠（详见工具文档）。

## 引导模式

窗口至少打开一个 workspace folder、但没有任何 `.develop` 时：

- MCP 只暴露 `workspaceInfo` / `listProjects` / `downloadProject` 三个工具；调用其它工具返回 `BOOTSTRAP_MODE`。
- 自举流程：
  1. 调用 `workspaceInfo` 确认 `workspaceFolders` 与 `mcp.mode`（应为 `bootstrap`）。
  2. 需要选工程时，用 `listProjects` 显式传 `uri` / `user` / `pwd` 连接服务器，取得 `projectUuid`。
  3. 调用 `downloadProject` 把工程下载到工作区（写入 `.develop`）。
  4. 把下载目录加入工作区并重载窗口。
  5. 重载后 MCP 扩展为完整工具集，SCM 同样生效。
- 工具列表在 MCP 进程启动时固定；重载窗口后宿主会通知刷新，外部客户端（Claude Code / Codex）会自动重连并重新拉取工具列表。下载后不重载窗口，仍然只有 3 个工具。
- 工程已在窗口扫描范围内但尚未被激活期注册表收录，或注册表与实时扫描不一致时，`workspaceInfo.mcp.reloadRequired` 为 true（通常需要重载窗口）。

## 返回结构

- 工程级工具（15 个）：成功结果为 `{ "project": { "projectId", "displayName", "root" }, "result": <原结果> }`；各工具文档「返回」描述的内容都在 `result` 内，无返回值时为 `null`。
- 工作区级工具（`workspaceInfo` / `listProjects` / `downloadProject`）：返回原始结果，不包 envelope。
- 错误：返回可读错误文本；当含错误码或候选工程时，末尾追加一行机器可读 meta：
  `BAP_MCP_ERROR_META: {"code":"...","candidates":[...]}`
  常见 `code`：`AMBIGUOUS` / `UNKNOWN_PROJECT` / `NO_PROJECTS` / `BOOTSTRAP_MODE` / `DUPLICATE_CHECKOUT` / `INVALID_PROJECT`。
- 工具不会返回 `pwd` / `user`；`workspaceInfo` 中的 `serverUri` 已去掉 userinfo。

## 调用方式

MCP 工具通过 **工具名 + 参数对象** 调用（不是 shell 命令）。一个 MCP 工具 ↔ 一个插件命令（`bapIde.*`），AI 面向工具名使用即可，无需知道底层命令。

调用前先向用户确认，然后明确：

- 将要调用的工具名
- 传入的参数（缺省字段用插件当前的连接信息，即 `.develop`；仅限 `listProjects` 的 `uri/user/pwd`，且三者要么全省略、要么同时提供。`redirect` / `downloadProject` 的 `uri/user/pwd` 必填；`project` 参数不做任何隐式回退）
- 期望的返回

工具只暴露**非交互**能力（参数化、无弹窗确认）；打开 Diff / 打开文件 / 暂存等交互式操作不在 MCP 中暴露。

## 工具清单

共 18 个：工作区级 3 个 + 工程级 15 个。下表工程级工具均另含可选 `project` 参数（规则见「多工程工作区」）。

| MCP 工具 | 用途 | 主要参数 |
|----------|------|---------|
| [workspaceInfo](./references/tools/workspaceInfo.md) | 工作区 / 工程概览（多工程选 project、判断引导模式） | (无) |
| [refresh](./references/tools/refresh.md) | 对比本地与云端，得出变更列表 | (无) |
| [commit](./references/tools/commit.md) | 提交全部变更到云端 | `comment` |
| [commitFile](./references/tools/commitFile.md) | 提交单个文件到云端 | `fullClass`/`path`, `comment` |
| [updateFile](./references/tools/updateFile.md) | 更新单个文件（回退到云端原版） | `fullClass`/`path` |
| [updateAll](./references/tools/updateAll.md) | 更新全部（回退到云端，删除本地新增） | (无) |
| [publish](./references/tools/publish.md) | 发布插件（全量） | `ignoreErrors` |
| [projectHistory](./references/tools/projectHistory.md) | 项目历史版本列表 | (无) |
| [fileHistory](./references/tools/fileHistory.md) | 某文件的历史版本 | `remoteKey` |
| [updateLibs](./references/tools/updateLibs.md) | 同步依赖 `lib` 到云端 | (无) |
| [compileProject](./references/tools/compileProject.md) | 本地编译工程 | `clean` |
| [compileFile](./references/tools/compileFile.md) | 云端编译单个类（返回诊断） | `fullClass`, `code` |
| [debugClass](./references/tools/debugClass.md) | 云端运行单个类 | `fullClass`, `code` |
| [testProject](./references/tools/testProject.md) | 编译并运行单元测试 | `selectClass` |
| [redirect](./references/tools/redirect.md) | 把目标工程重定向到另一 BAP 服务器（改写 `.develop` 并重连刷新） | `uri`, `user`, `pwd`, `projectUuid` |
| [downloadProject](./references/tools/downloadProject.md) | 连接服务器并下载 BAP 工程到工作区（引导模式自举入口；VotaForge 工作区默认落到 `<工作区>/<工程名>` 子目录；拒绝与已有工程重叠） | `uri`, `user`, `pwd`, `projectUuid`, `projectName`(可选), `targetDir`(可选) |
| [listProjects](./references/tools/listProjects.md) | 登录后在当前环境列出可操作的项目列表 | `uri`, `user`, `pwd`(可选；无 `.develop` 时必填) |
| [fetchCurrent](./references/tools/fetchCurrent.md) | 获取云端当前某个文件的内容 | `fullClass` 或 `path` |

参数与工作流细节见 `references/`。

## 执行原则

1. 多工程场景先调用 `workspaceInfo`，确认工程数量、目标工程与 `project` 取值；不要凭猜测传 `project`。
2. 省略 `project` 返回 `AMBIGUOUS` 时，读取候选（文本「候选工程」与 `BAP_MCP_ERROR_META` 行），再显式指定 `project`；不要盲目重试。
3. 先用 `refresh` 看清本地与云端的差异，再决定后续动作（提交 / 发布 / 更新）。
4. 取"云端当前代码"用 `fetchCurrent`，不要用 `history`（那是历史版本）或 `download`（那是整包下载）。
5. `commit` 前先 `refresh`；确认差异符合预期再提交。
6. `compileFile` / `debugClass` 需要同时提供 `fullClass`（点分全类名）与 `code`（该文件当前内容）。
7. 资源文件（非 `.java`）用参数 `path`（相对 `src/res/` 的路径）而非 `fullClass`。
8. 工具调用结果若含错误，先阅读返回的错误消息与 `BAP_MCP_ERROR_META`（发布超时场景已用长超时处理，等待更久）。
9. 不通过本 MCP 做交互式操作（打开 diff / 文件 / 历史视图），这类需求直接走 VS Code 原生功能。

## 技能安装与分工

- 命令面板 `BAP: Install Skills` 会把随扩展打包的全部 skill 复制到 `<VotaForge 根>/.votaforge/skill/<skill名>`；安装后的本技能路径为 `<vf根>/.votaforge/skill/bap-vscode-mcp`。
- 不会自动安装；覆盖同名目录前会弹模态确认。
- VotaForge 工作区中，跨前后端 / 多工程的任务路由由**顶层 routing skill**负责；本技能只描述 BAP 后端云工程能力，不修改 `votaforge.workspace.json`。
- `projectId` 的哈希段由 workspace folder **真实路径**计算（sha1 前 8 位），相对路径以 `:` 后缀明文拼接（如 `oa-a1b2c3d4:backend/gpf_demo`）；移动/重命名 workspace folder 后哈希可能变化。

## 文件导航

- 工具索引：`references/commands.md`
- 逐工具说明：`references/tools/*.md`
