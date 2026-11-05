# Changelog

## [1.0.5] - 2026-11-05

### 新增

- **MCP 工具按工程路由（P1-7）**
  - 新增工作区级工具 `workspaceInfo`（第 18 个工具）：列出 workspace folders、后端工程（projectId / 工程名 / 路径 / 云端 uuid / 注册状态）、MCP 模式与可用工具；不返回任何密码。
  - 15 个工程级工具新增可选 `project` 参数：projectId 精确 → projectUuid（忽略大小写）→ 工程名（先精确、后忽略大小写）；任一类别多命中即 `AMBIGUOUS` 并附候选。只有一个工程时可省略；多工程省略不会回退到活动编辑器 / 上次使用，而是返回歧义错误。
  - 工程级工具结果统一为 `{ project: { projectId, displayName, root }, result }`；`workspaceInfo` / `listProjects` / `downloadProject` 为工作区级工具，不包 envelope。
  - 错误载荷支持 `code` / `candidates`，MCP 返回文本末尾附 `BAP_MCP_ERROR_META`，便于 AI 解析候选工程。
- **MCP 引导模式（P1-8）**
  - 窗口至少打开一个 workspace folder、但没有 `.develop` 时，MCP 以 bootstrap 模式启动，仅暴露 `workspaceInfo` / `listProjects` / `downloadProject`；宿主侧同时校验模式（`BOOTSTRAP_MODE`），不只依赖工具列表。
  - `downloadProject` 作为自举入口；下载后加入工作区并重载窗口，完整工具集才生效。`.develop` 出现 / 消失时提示重载；重载后外部 AI 客户端会自动重连并刷新工具列表。
  - 引导模式下 `listProjects` 支持用显式 `uri/user/pwd` 直连服务器。
- **Agent 配置安全写入（P1-9）**
  - `CLAUDE.md` / `AGENTS.md` 改为按 BAP 标记段合并：只替换插件生成的段落，保留用户手写内容；支持重复段清理、CRLF/BOM 保持、幂等。
  - 损坏的 `.mcp.json`（非法 JSON / 根或 `mcpServers` 非对象）会跳过写入并警告，**不再重建或覆盖**；`.codex/config.toml` 读写异常同样降级为警告。
- **技能安装（P1-11）**
  - 新增命令 `BAP: Install Skills`：枚举随扩展打包的全部 skill，复制到 `<VotaForge 根>/.votaforge/skill/<skill名>`；覆盖同名目录前模态确认，符号链接与构建产物跳过。
  - `build` 阶段新增 `stage-skills.js`，把仓库根 `skill/` 打进 VSIX；F5 开发时回退到仓库 `skill/`。
- **多工程文档与生成内容（P1-12）**
  - README / `skill/bap-vscode-mcp` / 生成的 Agent 指令去掉单工程假设，说明 `project` 参数、引导模式、返回结构、技能安装路径与 VotaForge 顶层 routing skill 的职责边界。

### 优化

- `mcp-server` 子进程按工具类型设置 IPC 超时：下载 / 发布 / 单测 30 分钟，编译 / 同步依赖 10 分钟，重定向 / 项目列表 / 提交 / 更新全部 5 分钟，其余 30 秒。
- `mcp-server` 在宿主 IPC 断开（窗口重载 / 重启）后自动重连：重读 `~/.bap/mcp-ipc`、重新拉取工具列表并发送 `notifications/tools/list_changed`，外部客户端无需重启。
- MCP 工具参数清洗不再剔除 `project`（内部路由键 `__project*` 仍会剔除）。
- `listProjects` 在无工程时给出明确的下载 / 直连指引；下载成功提示补充重载窗口说明。
- 扩展激活失败时仍注册 MCP provider（回退 bootstrap），保留自举能力。

### 修复

- 修复 `Reset Agent Instructions` 整文件覆盖 `CLAUDE.md` / `AGENTS.md` 导致用户内容丢失的问题。
- 修复损坏 `.mcp.json` 被静默重建的问题。
- 修复多窗口退出时可能误删其它窗口 IPC 端点文件的问题（仅当内容仍指向本窗口时删除）。

## [1.0.4] - 2026-09-15

### 修复

- **【严重】提交二进制资源文件时内容被静默破坏（res 文件损坏 / 重新拉取变乱码）**
  - 现象：提交 `src/res` 下的资源文件后，云端存下来的字节与本地不一致——二进制文件
    （如 zip）无法解压，含中文的文本文件（如 json/js）重新拉取后变乱码；该文件同时
    会一直显示「有修改」。
  - 根因：**Java 桥所用 Gson（Leavay fork）对 `byte[]` 采用 URL-safe base64 变体
    （`-` `_`，且不带 `=` 填充），而 TS 侧 Node 的 `Buffer.toString('base64')` 产生的是
    标准 base64（`+` `/` 带填充）**。字母表不一致使桥在反序列化请求时把 `+` `/` 解错，
    上传的字节在**客户端就已经被破坏**，服务端只是忠实存下。实测 242 KB 的 res 文件有
    7.44% 的字节被改写，且「只增位不丢位」（纯按位 OR）。
    读取方向原本正常纯属侥幸：Node 的解码器宽松，同时接受两种字母表。
    参考实现（Eclipse / IDEA 版）不受影响——它们在进程内直接传 `byte[]`，从不经过 base64。
  - 修复：在桥中为 `byte[]` 注册**标准 base64** 的 `TypeAdapter`（编解码均走
    `java.util.Base64`），与 TS 侧默认行为对齐；读取时兼容两种字母表与缺失填充。
  - 验证：用真实构建产物 + 真实 242 KB 文件做双向实测，上传/下载均 0 字节差异。
  - ⚠️ **此前用旧版插件提交过的资源文件，云端已存的副本仍是损坏的，需在升级后重新提交一次。**
- **提交后仍显示修改（刷新队列丢 force 标志）**
  - 根因：刷新串行化队列合并「排队中的刷新」时丢弃了 `force` 标志——提交后的
    `refresh(true)` 若撞上在途的自动刷新（编辑触发 debounce），会退化为 `refresh(false)`，
    复用 TTL 内的旧云端快照，导致刚提交的文件仍显示修改（概率性）。
  - 修复：排队合并时保留 `force`（`queuedForce ||= force`），排队刷新按合并后的 force 执行。
- **Java 桥 stdout/stderr 平台默认字符集问题**
  - 根因：`BridgeMain` 的协议输出 `PrintStream` 未指定字符集，在中文 Windows（JVM 默认 GBK）
    下输出 GBK 字节，TS 侧 `readline` 固定按 UTF-8 解码 → 含中文的响应帧（代码内容、报错、
    进度）全链路乱码。
  - 修复：stdout / stderr 重定向均显式 UTF-8（Java 8 兼容写法：`PrintStream(..., "UTF-8")`）。

### 新增

- **提交后回读验证（提交内容一致性检查）**
  - 每次提交成功后立即从云端读回刚提交的文件，与**提交包里实际上传的内容**比对（基准是上传的
    字节/文本，不是重新读本地文件——否则 build 产物/编辑器在提交往返期间改写本地文件会误报）；
    资源按字节、Java 按 CRLF 归一，均跳过 >1MB 的条目。
  - 不一致时弹出警告并列出文件，附**字节差异特征**（首个差异偏移 / 差异字节数 / 长度差，
    以及差异处是否全为 `?`），让这类「提交内容与云端不符」的问题当场可见、可定位。
  - 另单独检测「本地文件在提交往返期间被改写」（构建产物 / 编辑器热保存），与「云端存坏」
    区分开——两者现象相似但根因完全不同。
- **下载工程时写入的 `.vscode/settings.json` 补齐 BAP 开发所需的 Java / 编辑器设置**
  - Java：`compile.nullAnalysis.mode=automatic`、`completion.guessMethodArguments=insertBestGuessedArguments`、
    `completion.postfix.enabled`、`updateImportsOnPaste.enabled`、`inlayHints.parameterNames.enabled=none`。
  - 编辑器：`editor.suggestSelection=recentlyUsedByPrefix`、`editor.tabCompletion=on`。
  - `[java]` 语言级：Tab 缩进 4 空格（`insertSpaces=true`）、保存时整理 import
    （`codeActionsOnSave.source.organizeImports=explicit`）。
  - **改为「读取已有内容再合并」**：目标目录若已有 `settings.json`，用户自己的其它设置原样保留
    （`[java]` 块也逐层合并），只有同名的插件托管键以本次为准（否则换 JDK 后旧 runtime 路径会残留）。
    已有文件无法解析时（含注释的 JSONC、根不是对象）**放弃写入**并在输出面板与提示中说明——
    宁可少配，也不损坏用户文件。

## [1.0.3] - 2026-09-02

### 修复

- **修复发布插件（全量 / 灰度）吞掉报错并报超时**
  - 根因：发布走 RPC 默认 30s 超时，`rebuildAll` / `exportProject2Plugin` / `grayPublish`
    通常远超该时限；TS 侧 30s 定时器先触发产生 TIMEOUT，晚到的真实成功 / 服务端报错被丢弃。
  - 修复：SDK 对发布相关调用改用 `callWithTimeout`（30min 长超时）；Java 桥对
    `rebuildAll` / `grayPublish` 一并放宽服务端 temp timeout（`export*` 已有）。

### 优化

- **命令标题改为英文**：`contributes.commands` 标题由中文改为英文（命令 `category` 仍为 `BAP`），
  命令面板 / 菜单显示为 `BAP: Refresh`、`BAP: Commit` 等。

### 新增

- **MCP 集成**：插件注册 MCP server（id=`bap`），把云工程能力暴露为 AI 工具（Claude Code / Codex / Copilot 可直接调用）。
  - 基于官方 `@modelcontextprotocol/sdk`；`mcp-server` 独立子进程 + 宿主本地 IPC 转发，严格命令映射（一个 MCP tool ↔ 一个 `bapIde.*` 命令）。
  - 首批 **17 个工具**：刷新 / 提交全部 / 提交单文件 / 更新文件（回退云端）/ 更新全部 / 发布插件 / 项目历史 / 文件历史 / 更新依赖 / 编译项目 / 编译单类 / 启动调试 / 单元测试 / 重定向 / 下载工程 / 项目列表 / 取云端当前文件。
  - 新增命令 `bapIde.listProjects`（查看项目列表）、`bapIde.fetchCurrent`（取云端当前文件）。
  - 附带技能 `skill/bap-vscode-mcp/`，说明 AI 如何调用这些 MCP 工具。
  - **Reset Agent Instructions 命令**：`bapIde.resetAgentInstructions` 重建工程根 `CLAUDE.md` / `AGENTS.md`，内容依据插件实际 MCP 工具与 `skill/bap-vscode-mcp` 生成。
  - **MCP 配置自动写入**：`Reset Agent Instructions` 同时生成 Claude Code（工程根 `.mcp.json`）与 Codex（工程根 `.codex/config.toml`）的 MCP 配置；IPC 端点写入 `~/.bap/mcp-ipc`，配置中不含 token，插件重载后无需改配置。

## [1.0.2] - 2026-09-01

### 修复

- **修复刷新误报海量变更**（云快照 Map 被序列化成字符串）
  - 根因：Java 桥 `safeSerialize` 把 `queryCodeFile` / `queryAllFileMap` 返回的
    `Map`（包名 `java.util`）误判为 JDK 内部类，整张 map 被 `toString` 成 `{path=...}`
    字符串；TS 侧按字符拆索引，本地路径全对不上 → 文件全被判为新增（曾出现上万变更）。
  - 桥改为：对异常之外的对象先正常 Gson 序列化，仅序列化失败（JDK 非 opened 模块类）才
    `toString` 兜底。

### 优化

- **云端快照归一化加固**：`queryCodeFile` / `queryAllFileMap` 无论返回对象还是数组，统一用元素自身 `path` 作为云端相对路径对齐本地，避免 key 为索引时错位。
- 移除刷新时的临时诊断日志（`[refresh] 云端快照 ...`）。
- **SCM 动作统一改为右下角进度框提示**：移除「刷新 / 提交已触发」等即时 toast；刷新、提交、发布、提交 / 更新（文件 / 组 / 全部）、编译单类、云端调试等动作，改为点击后立即在右下角显示进度框（与下载工程一致）。
- **SCM 按需显示**：插件激活时检测工程根目录 `.develop`，存在才启用 Source Control 存储库（非 BAP 工程不显示，也避免打开普通文件夹时误连服务器）。

## [1.0.1] - 2026-08-31

### 新增

- **检查更新（感知更新）**
  - 启动后台检查 + 命令面板「检查更新」，从 GitHub Release 检测新版本并提示下载。
  - 适用于**手动 `.vsix` 安装**（VS Code 不会对手动安装的扩展自动更新）。
  - 配 `bapIde.updateFeedUrl` / `bapIde.checkUpdateOnStartup` 设置项。

## [1.0.0] - 2026-08-31

BAP IDE（VS Code）首个发布版。面向 **BAP 云工程**：复用官方 Java 桥连 BAP Server，把云端工程当作基线做源码管理、调试、编译与测试。

### 新增

- **源代码管理（SCM）**
  - 云端为基线，资源分组：`新增 / 更改 / 删除`，空组自动隐藏。
  - 刷新、提交全部 / 单文件 / 分组、发布插件（全量）、更新（全部 / 单文件 / 分组）、打开 Diff、打开文件。
  - 文件项右键菜单：打开文件、更新、提交、编译单类（云端）、启动调试、单元测试。
  - 自动刷新带云端快照缓存（`refreshTtlMs`）与串行化，降低频繁刷新开销。

- **查看历史**
  - 项目历史 / 文件历史：编辑器标签页 Webview，复刻 git view history（过滤栏 + 提交列表 + 选中版本的改动文件）。
  - 选中版本可回看与前一版本的 diff。

- **重定向工程**
  - 切换到其它 BAP Server（ws 地址 + 账号 + 密码），本地历史（`<工程>/.bap/relocate-history.json`），一键 / 编辑 / 新增。

- **下载工程**
  - 命令行入口，流式下载整包到当前工作区根，自动解压、写 `.develop`、写 `.vscode/settings.json`（JDK 1.8），随后替换窗口打开并注册 SCM。

- **更新依赖**
  - 同步 `<工程>/lib` 到云端（服务端 md5 比对），增量更新并删除云端已无的本地 lib 包。

- **编译**
  - 编译项目（本地）：用 JDK `javac` 编译 `src/**` → `bin/`，并拷贝资源。
  - 编译单类（云端）：调 `compileSingleCode`，把诊断标记到编辑器对应行（波浪线 + 问题面板）。

- **启动调试**
  - 把当前类发到云端运行（`startDebugJava`），在「BAP 调试」输出通道逐行显示运行 trace 与执行结果（调试 ID / 是否异常 / 返回对象 / 返回文本）。

- **单元测试**
  - 先本地 `javac` 编译、再用 JUnit Platform（`junit-platform-console-standalone`）运行 `bin/` 下的测试类。
  - 输出到「BAP 单元测试」通道，并给测试类透传 `BAP_*` / `SILENT_BAP_*` 属性，供测试基类连服务器。

### 使用前提

- 本机需安装 **JDK**（编译 / 本地单测使用 `javac` / `java`；默认用设置里的 JDK 1.8 路径）。
- 工程需含 `.develop`，用于定位服务器地址 / 账号 / 工程。

### 配置项

- `bapIde.java8Path`：JDK 1.8 安装路径（编译 / 下载工程 / 单测采用其 javac 与 java）。
- `bapIde.refreshTtlMs`：自动刷新复用云端快照的间隔（默认 `30000` ms）。
