---
name: bap-vscode-mcp
description: 使用 BAP IDE（VS Code 插件）注册的 MCP server 对 BAP 云工程执行云端操作——刷新差异、提交、发布、编译、单元测试、调试、历史查询、获取云端当前代码、更新依赖、重定向等。适用于当前工作区打开的是 BAP 云工程（含 .develop）、且用户要求通过 AI 直接调用云工程能力，或在 VS Code 里以 MCP 工具方式操作云工程的场景。不适用于规则函数开发、HTTP 接口开发、平台部署、或纯 CLI 场景（应改用 bapdev-cli 技能），也不适用于 IDE 菜单操作说明。
---

# BAP IDE MCP 技能

在 VS Code 打开的 BAP 云工程里，BAP IDE 插件会注册一个 MCP server（id=`bap`），把云工程能力暴露成 MCP 工具，供 Claude Code / Codex / Copilot 调用。本技能说明如何用这些 MCP 工具。

## 适用范围

适用：

- 当前工作区是 BAP 云工程（根目录有 `.develop`），用户要求做云端操作（刷新 / 提交 / 发布 / 编译 / 单测 / 调试 / 历史 / 取当前代码 / 同步依赖）。
- 用户明确要求 "通过 MCP / 让 AI 调用 BAP 能力"。
- 需要组合多个云工程操作完成一个上层目标（如：先 refresh 看差异，再提交，再发布）。

不适用：

- 用户要求开发规则函数、HTTP 接口、数据库结构、权限矩阵、微服务——用对应的 `gpf-*` 开发技能。
- 用户要求平台部署、启动停止服务——用 `gpf-platform-deploy`。
- 用户要求纯命令行的云工程操作（无 VS Code / 无 MCP）——用 `bapdev-cli` 技能。
- 用户只是在聊 BAP 概念，没有明确要通过 AI 操作云工程。

## 前提

用 MCP 工具前应确认：

1. 当前工作区是 BAP 工程（根目录存在 `.develop`）；插件激活后 MCP server 才会启动（无 `.develop` 时 resolve 钩子中止启动）。
2. 用户在 VS Code 里已登录 / 连接（`.develop` 已配置 ws 地址、账号、工程）。
3. 插件版本 ≥ 1.0.3（MCP 集成自该版本起）。

若 AI 发现工具列表为空或调用报 `server not found`，先引导用户：打开含 `.develop` 的 BAP 工程根目录、确认插件已激活、重载窗口。

## 调用方式

MCP 工具通过 **工具名 + 参数对象** 调用（不是 shell 命令）。一个 MCP 工具 ↔ 一个插件命令（`bapIde.*`），AI 面向工具名使用即可，无需知道底层命令。

调用前先向用户确认，然后明确：

- 将要调用的工具名
- 传入的参数（缺省字段用插件当前的连接信息，即 `.develop`）
- 期望的返回

工具只暴露**非交互**能力（参数化、无弹窗确认）；打开 Diff / 打开文件 / 暂存等交互式操作不在 MCP 中暴露。

## 工具清单

| MCP 工具 | 用途 | 主要参数 |
|----------|------|---------|
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
| [redirect](./references/tools/redirect.md) | 把当前工程重定向到另一 BAP 服务器（改写 `.develop` 并重连刷新） | `uri`, `user`, `pwd`, `projectUuid` |
| [downloadProject](./references/tools/downloadProject.md) | 连接服务器、选择并下载 BAP 工程到工作区 | `uri`, `user`, `pwd`, `projectUuid` |
| [listProjects](./references/tools/listProjects.md) | 登录后在当前环境列出可操作的项目列表 | `uri`, `user`, `pwd`(可选) |
| [fetchCurrent](./references/tools/fetchCurrent.md) | 获取云端当前某个文件的内容 | `fullClass` 或 `path` |

参数与工作流细节见 `references/`。

## 执行原则

1. 先用 `refresh` 看清本地与云端的差异，再决定后续动作（提交 / 发布 / 更新）。
2. 取"云端当前代码"用 `fetchCurrent`，不要用 `history`（那是历史版本）或 `download`（那是整包下载）。
3. `commit` 前先 `refresh`；确认差异符合预期再提交。
4. `compileFile` / `debugClass` 需要同时提供 `fullClass`（点分全类名）与 `code`（该文件当前内容）。
5. 资源文件（非 `.java`）用参数 `path`（相对 `src/res/` 的路径）而非 `fullClass`。
6. 工具调用结果若含错误，先阅读返回的错误消息（发布超时场景已用长超时处理，等待更久）。
7. 不通过本 MCP 做交互式操作（打开 diff / 文件 / 历史视图），这类需求直接走 VS Code 原生功能。

## 文件导航

- 工具索引：`references/commands.md`
- 逐工具说明：`references/tools/*.md`
