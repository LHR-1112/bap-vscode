# BAP IDE 适配 VotaForge 体系改造清单 V1.0

> 日期：2026-11-05
> 依据：`docs/architecture/` 下 7 篇体系文档（plugin-split、workspace-protocol、votaforge-bap/lite/frontend/modeling/layout-designer）
> 范围：本仓库 `apps/vscode` + `packages/vscode-host` + `packages/sdk`
> 状态：**M2 实施完成**（本文件随实施更新）

## 一、结论

1. 文档对 BAP 的定位是「外部现有插件，不动本体，独立发版」。协议层只要求三件事：workspace 的 `backend` 引用段（由编排层写）、skill 编排、不集成代码。
2. 本插件当前已满足大部分「负向约束」：不写 `votaforge.workspace.json`、不写 `.votaforge/`、RPC 不进共享层、无 CLI、无跨插件依赖、扩展 ID 未变。
3. 真正的缺口是**工程根定位**：整条激活链路假设「打开的第一个 workspace folder 就是后端工程根」。在 vf 容器工作区（根有 `votaforge.workspace.json`，Java 工程在子目录）打开时，SCM 不注册、MCP 不启动，插件在体系内等于不可见。
4. 因此改造分三层：
   - **P0**：让插件能在 vf 容器工作区启动并正确下载后端工程；
   - **P1**：让一个 workspace 内的多个后端工程各自正确工作；
   - **P2**：协议对齐、安全与发布卫生。

## 二、已拍板决策（2026-11-05）

| # | 问题 | 决定 |
| --- | --- | --- |
| 1 | SCM 可见性公式 | **发现 `.develop` 即显示**；不要求 `votaforge.workspace.json` 存在；后续增加 `bapIde.scmMode`（auto/always/never）时保持该语义。 |
| 2 | 是否读 `votaforge.workspace.json` 的 `capabilities.backend` | **暂时不读**。BAP 只用 `.develop` 标记发现；不把 workspace.json 作为激活前提。 |
| 3 | 多后端 SCM 形态 | **每工程一个 provider**：id `bap:<projectId>`，label 带工程名，rootUri 为后端工程根。 |
| 4 | Skill 安装位置 | **`<vf根>/.votaforge/skill/`**。注意后续可能增加多个 skill，安装器按目录整体复制、可枚举，不写死单个 skill 名。 |
| 5 | 无 `.develop` 时 MCP | **启动但只暴露引导工具**（`workspaceInfo` / `listProjects` / `downloadProject`），检出 `.develop` 后扩展为完整工具集。M2 落地为：仅当窗口至少打开一个 workspace folder 时启动；完全无文件夹不启动。 |
| 6 | `.develop` 明文 Password | **本次不动**。`.develop` 是 BAP 自有协议常量，改格式会波及 Java 桥与 bapdev-cli；另立 SecretStorage 双读/版本化项目。 |
| 7 | MCP `pwd` 参数 | **降为可选 legacy**，宿主从已保存连接/SecretStorage 解析；旧参数继续可用。 |

## 三、红线（明确不做）

| 不做 | 依据 |
| --- | --- |
| 不写 `votaforge.workspace.json`（包括 `backend` 段） | D12 / workspace-protocol §4.1、§9 |
| 不写 `.votaforge/server-profiles.json`、`runtime.json`、`snapshots/`、`votalite/`、`api/` | workspace-protocol §三 owner-writes |
| `.votaforge/skill/` 只在用户显式触发时写入 | Q7 / §8.2；所有权待与编排层确认 |
| 不把 crpc/RPC 抽进 `@votaforge/connection`，不新增 `@votaforge/*` 运行时依赖 | `votaforge-bap.md` 公共层纪律 |
| 不复用 GPF Token/账号做 BAP RPC | 不同服务器/协议/鉴权 |
| 不新建 BAP CLI | `votaforge-bap.md`「不强行再造」 |
| 不做跨插件运行时依赖；不改 `.develop` 名称/位置/语义 | 外部插件、独立发版 |
| 不改既有 MCP 工具名与既有参数（只做增量；M2 新增 `workspaceInfo` 与可选 `project`） | MCP schema 是机器接口 |
| 不把自动安装的 skill 目录当工程存在/变更信号 | workspace-protocol §8.2 刻意排除 |
| 不改 publisher/name/displayName/扩展 ID | 独立发版；品牌对齐另议 |

## 四、改造清单

### P0 — 不做就在 vf 工作区不可用

#### P0-1 按 `.develop` 标记发现后端工程根

- 新增纯函数定位器 `packages/vscode-host/src/backend-projects.ts` + VS Code 包装 `backend-projects-vscode.ts`。
- 对每个 workspace folder 做受限深度扫描（默认 4 层），凡含 `.develop` 文件的目录即一个后端工程根，返回 0/1/N。
- 排除 `node_modules`、`.git`、`target`、`build`、`out`、`dist`、`bin`、`.gradle`、`.idea`、`.vscode`、`.votaforge`、`api` 等；跳过符号链接与隐藏目录。
- `apps/vscode/src/extension.ts` 激活门禁、`packages/vscode-host/src/mcp/host.ts` 的 `resolveMcpServerDefinition` 复用同一结果。
- 验收：vf 根 + `backend/.develop` 能出 SCM/MCP；单工程（根/.develop）行为不变；无 `.develop` 时不启动。

#### P0-2 下载工程落到后端工程子目录

- `apps/vscode/src/extension.ts` 的 MCP 路径与交互路径统一解析目标目录：
  - 工作区根存在 `votaforge.workspace.json` 或 `.votaforge/` 时，默认下载到 `<工作区根>/<工程名>`，也允许用户输入相对子目录；
  - 独立 BAP 工作区保持「下载到工作区根」的既有行为；
  - 目标目录必须在工作区内，且不能是工作区根（vf 模式下）。
- `.develop` 与 `.vscode/settings.json` 写入目标子目录；MCP 路径也补写 Java 设置。
- vf 工作区不调用 `vscode.openFolder` 替换窗口；下载完成后提示「添加到工作区 / 重新加载」。
- MCP `downloadProject` 增加可选 `projectName`、`targetDir` 参数。
- 验收：vf 夹具下载后只产生 `<root>/<projectName>/{.develop,src,lib,.vscode/settings.json}`；vf 根无新增工程文件；独立单工程行为不变。

### P1 — 多后端工程正确性

#### P1-1 无后端工程时菜单/命令不崩

- `bapIde.scm.*` 当前只在 `activateScm` 内注册，但 `editor/context` 的 Java 菜单没有 `.develop` 门禁。
- 增加 `bapIde.hasBackendProject` 上下文键控制菜单，或把命令注册与工程上下文解耦并返回明确提示。

#### P1-2 后端工程注册表与稳定 projectId

- `BackendProjectRegistry`：realpath 规范化 + `.develop` 的 Project uuid 为主键；对外 `projectId` 用 workspace 相对路径（POSIX 分隔符）。
- 去重「既是 workspace folder 又是子目录」的同一工程；同一 uuid 两份检出标记歧义并要求显式选择。
- 禁止用目录 basename 或云端工程名作为键。

#### P1-3 每工程独立 SDK/SCM/RPC，命令按工程路由

- 把激活期单例 `sdk` / `mcpCtx` 改为 `BackendProjectContext[]`（root、projectId、sdk、scm、rpc，懒创建）。
- `bapIde.*` 命令集中注册一次，按 resourceUri/change 或显式 `project` 参数路由。
- 某工程首次被操作时才创建 Java 桥；dispose 时回收全部 RPC。
- 配置按工程根读取，或明确声明窗口级唯一并提示限制。

#### P1-4 SCM provider 绑定后端工程根

- 每工程一个 provider：`createSourceControl('bap:' + projectId, 'BAP · ' + name, projectRootUri)`。
- 菜单 `when`：`scmProvider =~ /^bap($|:)/`；资源组条件同步调整。
- 保留三组语义：新增 / 更改 / 删除。

#### P1-5 `bap-original` 与 QuickDiff 多工程隔离

- `Change` 增加 `projectId` / `projectRoot`；`bap-original://` URI 增加 project 段并纳入缓存键。
- 相对路径按该 change 所属工程根计算，而不是激活时捕获的单一 workspaceRoot。

#### P1-6 无资源上下文的 SCM 命令定义「当前工程」

- 标题栏 commit/refresh/publish/updateAll/projectHistory/updateLibs 解析到具体工程。
- 跨多个云工程的操作先列出目标工程并确认，逐工程执行、逐工程汇总结果。

#### P1-7 MCP 工具增加工程维度

- 工程级工具增加可选 `project` 参数；单工程可省略，多工程缺省时拒绝歧义并返回候选工程。
- 新增只读 `workspaceInfo`：扫描到的 `.develop` 根、projectUuid/name、server URI，绝不返回 pwd。
- 工具结果带解析到的工程标识；工具名与既有参数保持兼容。

#### P1-8 无 `.develop` 的 vf 窗口：MCP 自举

- MCP server 仍启动，只暴露 `workspaceInfo` / `listProjects` / `downloadProject`。
- 检出 `.develop` 后扩展为完整工具集（必要时提示重载）。

#### P1-9 Agent 指令与 MCP 配置写到后端工程根

- `CLAUDE.md` / `AGENTS.md` 写到定位器解析出的后端工程根，不写 vf 根。
- 已有内容用标记段落合并；`.mcp.json` 解析失败时跳过并警告，不重建丢原内容。
- 生成的指令在 vf 场景声明「路由由顶层 routing skill 负责」。

#### P1-10 重定向历史按后端工程存放

- `<workspaceRoot>/.bap/relocate-history.json` 改为后端工程根下的 `.bap/`（或 globalStorage 按 projectId 分区）。
- 旧位置迁移一次；文件权限 0600。

#### P1-11 领域 skill 纳入 VSIX 分发并可安装

- 把 `skill/bap-vscode-mcp/**` 复制进扩展打包资产（vsce 只打包 `apps/vscode` 内文件）。
- 增加显式安装命令：按目录整体复制到 `<vf根>/.votaforge/skill/`，支持后续多个 skill（枚举目录、不写死单个 skill 名）。
- README / agent 指令引用安装后的路径。

#### P1-12 Skill / README / agent 文档去掉单工程假设

- 前提从「工作区根目录有 `.develop`」改为「workspace 内按 `.develop` 标记发现一个或多个后端工程」。
- 补充多工程 `project` 参数、下载落点、vf 由顶层 routing skill 指定目标工程。
- 与 P0/P1 代码同版发布。

### P2 — 健壮性与发布卫生

#### P2-1 MCP IPC 端点按工作区/工程隔离

- `~/.bap/mcp-ipc` 全局文件改为 `<globalStorage>/mcp-ipc/<workspaceKey>`（0600）。
- 生成的配置写入 `BAP_IPC_FILE` / `BAP_PROJECT_ROOT`；mcp-server 握手校验；保留全局文件过渡回退。

#### P2-2 响应 workspace folder 变化

- 监听 `vscode.workspace.onDidChangeWorkspaceFolders`，增量 attach/detach 工程上下文。
- 可选 `FileSystemWatcher` 监听 `.develop` 新增/删除。

#### P2-3 SCM 自动刷新只监听本工程根

- 去掉 `isInWorkspace` 的 `|| u.scheme === 'file'`，按路径段比较。
- 排除 `.git`、`node_modules`、`.votaforge`、`api`；多工程各自 debounce。

#### P2-4 MCP `pwd` 参数可选化

- `redirect` / `downloadProject` 的 `pwd` 从 required 改为可选 legacy。
- 宿主从已保存连接/SecretStorage 解析；skill 明确 Agent 不得询问、回显或记录密码。

#### P2-5 增加 `bapIde.scmMode`

- `auto`（默认）：发现 `.develop` 即显示；`always`：任意窗口显示（空态提示下载）；`never`：不创建 provider 并联动菜单。

#### P2-6 统一版本来源

- `apps/vscode/package.json` 为真源；`@bap/core` 常量、MCP `serverInfo.version`、README、skill 版本说明由构建注入或发版校验。

#### P2-7 生成 workspace `backend` 引用片段（只输出不写）

- 命令或 `workspaceInfo` 输出 `capabilities.backend.projects[] = [{ name, bapProject }]`。
- 绝不写 `votaforge.workspace.json`；输出不含本地路径、`.develop` 字段或密码。

#### P2-8 vf 容器与多工程回归夹具

- 矩阵：standalone BAP / vf 根 + 后端子目录 / vf 根 + 两个后端 / vf 根无后端 / 多根工作区 / 嵌套或重复检出。
- 断言：激活不退化、SCM provider id 与分组、MCP resolve 与工具作用域、下载落点、`.vscode/settings.json` 位置、`bap-original` URI 隔离、不写 `.votaforge`。

## 五、实施顺序

| 阶段 | 内容 | 目标 |
| --- | --- | --- |
| **M0** | P0-1、P0-2、定位器单测 | 插件能在 vf 容器工作区启动并下载后端工程 |
| **M1** | P1-1 ~ P1-6 | 多后端工程下 SCM/命令正确 |
| **M2** | P1-7 ~ P1-12 | AI 编排链可用，skill 随插件分发 |
| **M3** | P2-1 ~ P2-8 | 健壮性与发版卫生 |

## 六、M0 实施记录

- [x] 清单落盘
- [x] P0-1 定位器 + 单测
- [x] P0-1 激活门禁 / MCP resolve 接入
- [x] P0-2 下载落点 / 窗口行为 / MCP 参数
- [x] 文档（README / skill downloadProject 参考）同步
- [x] typecheck / 单测 / compile 通过

### 新增 / 修改文件

| 文件 | 变更 |
| --- | --- |
| `packages/vscode-host/src/backend-projects.ts` | 新增：`.develop` 扫描、vf 根判定、目录名清洗、下载目标解析（纯函数，无 vscode 依赖） |
| `packages/vscode-host/src/backend-projects-vscode.ts` | 新增：基于当前 workspace folders 的 `discoverBackendProjects()` |
| `packages/vscode-host/test/backend-projects.test.ts` | 新增：17 个单测（根/子目录/排除/深度/去重/落点/越界） |
| `packages/vscode-host/src/index.ts` | 导出定位器与目标解析函数 |
| `packages/vscode-host/src/mcp/host.ts` | MCP resolve 改用 `discoverBackendProjects()`，不再只看第一个 folder 根 |
| `packages/vscode-host/src/mcp/tools.ts` | `downloadProject` 增加可选 `projectName`、`targetDir` |
| `apps/vscode/src/extension.ts` | 激活门禁改为标记扫描；下载统一走目标解析、写 Java 设置、vf 不替换窗口 |
| `README.md` / `skill/bap-vscode-mcp/SKILL.md` / `references/tools/downloadProject.md` | 同步发现规则与下载落点 |

### 行为速查

- **发现**：扫描每个 workspace folder（含根）最多 4 层；目录下存在 `.develop` 普通文件即工程根；找到后不再下探；跳过隐藏目录、符号链接、依赖与构建产物；按绝对路径排序、realpath 去重。
- **激活**：0 个工程 → 不注册 SCM；1 个 → 使用该根；多个 → 记日志并使用第一个（M1 改为每工程一个 provider）。
- **MCP 启动**：窗口内发现任意 `.develop` 即启动；未发现时仍按旧行为不启动。
- **下载 · 独立工作区**：默认仍下载到工作区根，下载完 `vscode.openFolder` 替换窗口（旧行为）。
- **下载 · vf 工作区**：默认 `<根>/<工程名>`，可改相对子目录；禁止落到根与越界；子目录非空需确认（交互）或拒绝（MCP）；不替换窗口，提示「添加到工作区并重新加载」。
- **MCP 下载**：新增 `projectName`（缺省时登录后按 uuid 反查）、`targetDir`（相对路径）；成功后写 `.develop` 与 `.vscode/settings.json`，返回目标绝对路径。

### 已知边界（留待后续里程碑）

- 多后端工程目前只用第一个根（P1-2 ~ P1-6，M1）。
- 决策 5「无 `.develop` 时启动 MCP、只暴露引导工具」按 P1-8 在 M2 实施；M0 未改变「无工程不启动」。
- 下载目标固定取第一个 workspace folder；多根工作区的工程选择随 P1-3 一起改。
- `.develop` 明文 Password 不动（决策 6）；MCP `pwd` 仍为必填（决策 7 的可选化在 P2-4）。

## 七、M1 实施记录

> M1 范围：P1-1 ~ P1-6（多后端工程下 SCM / 命令正确），并按拍板意见**同版实现跨工程批量**、下载严格校验、重复检出写保护。

### 7.1 完成项

- [x] P1-1 无后端工程时菜单/命令不崩
- [x] P1-2 工程注册表与稳定 `projectId`
- [x] P1-3 每工程独立 SDK/RPC/SCM，命令按工程路由
- [x] P1-4 每工程一个 SCM provider（`bap:<projectId>`）
- [x] P1-5 `bap-original` / QuickDiff / 历史 URI 按工程隔离
- [x] P1-6 无资源命令的「当前工程」定义 + 跨工程批量
- [x] 下载目标严格校验（UI 确认 / MCP 拒绝）
- [x] 重复检出：拒绝隐式写（显式选择/SCM/路径定位允许）
- [x] MCP 工具名与既有参数保持兼容
- [x] typecheck / 单测（17 文件 111 例）/ compile 通过

### 7.2 关键设计

- **稳定标识**：`projectId = ${workspaceFolderSlug}-${sha1(realRoot 的 POSIX 路径).slice(0, 8)}:${相对路径或 '.'}`。以 realpath 规范化，不以目录 basename 或云端工程名为键；同一 uuid 的多份检出互为 `peerProjectIds`。
- **工程上下文**：`BackendProjectContext` 持有 root / projectId / 懒创建 SDK（对应一个 Java 桥 RPC）；`BackendProjectRegistry` 负责解析、批量、重复检出判定与写保护。
- **当前工程解析顺序**：显式 `projectId` → 资源 URI 的 `pid`（虚拟 URI）→ SCM 对象反查 → 资源路径（取最深工程根）→ 活动编辑器 → 唯一工程 → QuickPick。显式路径落在任何工程外时报 `OUTSIDE_PROJECT`，不回退。
- **命令注册**：`bapIde.*` 统一由 `registerProjectCommands` 注册一次；非交互/MCP 调用禁止弹 QuickPick，歧义时抛 `AMBIGUOUS` 并返回候选工程。
- **批量**：无资源上下文的 UI 命令（refresh/commit/publish/updateAll/updateLibs/projectHistory/resetAgentInstructions 等）多工程时多选 QuickPick，按勾选顺序逐工程执行并汇总 `{projectId, hasBackendProject, ok, value|error}`；破坏性操作仅一次模态确认。`redirect` 仍限单工程（避免误建重复检出）。
- **写保护**：所有隐式解析的写操作（commit/update/redirect 等）校验 `.develop` 身份并拒绝「同一 uuid 的另一份检出」；用户显式点击 SCM 资源、指定路径或批量勾选时视为显式授权。
- **SCM 隔离**：provider id `bap:<projectId>`，`when` 条件为 `scmProvider =~ /^bap($|:)/`；分组 id 追加 projectId 段；文件装饰按 projectId 分区，多个 provider 刷新互不覆盖。
- **虚拟文档**：`bap-original://` / `bap-history://` URI 带 `pid`；共享 provider 按 pid 找到工程 SDK，单工程旧 URI 无 pid 时回退唯一工程。
- **连接一致性**：SDK 增加 epoch 与 single-flight 连接；`disconnect` / `redirect.apply` 递增 epoch 并清空快照，连接过程中产生的旧结果不再写回；RPC 增加 `close()`/`closeSync()` 与 `BRIDGE_CLOSED` 保护，工程销毁时回收子进程。
- **MCP 兼容**：17 个工具名与参数不变；命令实现可接收内部路由键（`__tool`、`projectId`、`pid` 等），`toArgs` 统一剔除；命令返回 `{error}` 时 IPC 层转为 error 响应。

### 7.3 新增 / 修改文件

| 文件 | 变更 |
| --- | --- |
| `packages/vscode-host/src/projects/discovery.ts` | 新增：扫描结果 → 稳定描述（projectId、displayName、重复检出分组） |
| `packages/vscode-host/src/projects/project-id.ts` | 新增：`projectId` 生成与 slug/哈希 |
| `packages/vscode-host/src/projects/project-paths.ts` | 新增：路径归一化、包含判断、最深根查找 |
| `packages/vscode-host/src/projects/project-identity.ts` | 新增：`.develop` 身份读取与变更检测 |
| `packages/vscode-host/src/projects/project-context.ts` | 新增：单工程上下文（SDK 懒创建、写队列、身份采用） |
| `packages/vscode-host/src/projects/project-registry.ts` | 新增：解析顺序、批量、QuickPick、重复检出写保护、SCM 反查 |
| `packages/vscode-host/src/projects/project-errors.ts` | 新增：`AMBIGUOUS` / `OUTSIDE_PROJECT` / `UNKNOWN_PROJECT` / `DUPLICATE_CHECKOUT` / `CANCELLED` 等 |
| `packages/vscode-host/src/projects/refresh-scheduler.ts` | 新增：刷新并发调度（默认 1，串行；dispose 拒绝排队任务） |
| `packages/vscode-host/src/projects/activate.ts` | 新增：多工程激活编排（SCM、命令、共享虚拟文档 provider、上下文键、工作区变化提示、dispose） |
| `packages/vscode-host/src/commands/command-router.ts` | 新增：`bapIde.*` 全量命令（UI/MCP 双通道）、批量执行、重定向 UI 移植 |
| `packages/vscode-host/src/history/history-uri.ts` | 新增：`bap-original` / `bap-history` URI 构建与解析（含 pid） |
| `packages/vscode-host/src/index.ts` | 导出多工程 API |
| `packages/vscode-host/src/backend-projects.ts` | `validateDownloadTarget`：工作区内、禁止 vf 根、禁止与已有工程重叠、目标自身不能是工程 |
| `packages/vscode-host/src/history/history-provider.ts` / `history-view.ts` | 按 pid 解析 SDK，历史面板按工程打开 |
| `packages/vscode-host/src/scm/bap-scm-provider.ts` / `file-decoration.ts` / `original-provider.ts` / `scm/types.ts` | 每工程 provider、分组 id、装饰分区、`bap-original` 带 pid |
| `packages/vscode-host/src/mcp/tool-exec.ts` / `tools.ts` / `host.ts` | 写操作串行化与身份校验、参数清洗、`{error}` 转 IPC 错误 |
| `packages/sdk/src/services.ts` / `types.ts` | `projectId` 标记 Change、连接 epoch、redirect 断开旧连接 |
| `packages/rpc/src/index.ts` | `disconnect` / `close` / `closeSync` / `closed` 语义 |
| `apps/vscode/src/extension.ts` | 激活改为 `activateBackendProjects`；下载严格校验与「加入工作区 + 重载」 |
| `apps/vscode/package.json` | SCM 菜单 `when` 支持多 provider；`java8Path` / `refreshTtlMs` 改为 resource scope |
| `packages/vscode-host/test/project-*.test.ts` / `history-uri.test.ts` / `refresh-scheduler.test.ts` / `backend-projects.test.ts` / `scm-types.test.ts` | 新增/扩展单测 |

### 7.4 行为速查

- **激活**：扫描到 0 个工程 → 不创建 SCM，`bapIde.hasBackendProject=false`；1 个 → 自动使用；N 个 → 每工程一个 provider，命令按上下文路由。
- **SCM**：每个工程独立 provider（label 含工程名）；同一 uuid 多份检出时 label 带工作区/相对路径区分，并在激活日志与 QuickPick 中提示。
- **无资源命令**：能从 SCM 标题栏、活动编辑器或唯一工程确定目标就直接执行；多工程则多选；取消不报错。
- **下载（UI）**：目标必须在工作区内；vf 根不可作为目标；不能与已有工程重叠；非空目录二次确认；完成后提示加入工作区并重载。
- **下载（MCP）**：同上前三项；非空目录直接拒绝；返回目标绝对路径。
- **重复检出**：只读操作允许；隐式写操作拒绝并提示显式选择；显式点击/勾选/指定路径允许写入。
- **工程失效**：`.develop` 被删除/改写后，写操作返回 `PROJECT_STALE`；重定向成功后自动采用新身份并刷新 SCM。
- **MCP**：工具列表与参数不变；多工程下的工程选择在 M2（P1-7）加入 `project` 参数前，按活动编辑器/最近使用工程解析。

### 7.5 已知边界（M2 前，已在 §八 处理）

- P1-7 ~ P1-12 未实施：MCP 工具尚无 `project` 参数与 `workspaceInfo`；无 `.develop` 时 MCP 仍不启动（决策 5 待 P1-8）。
- Skill 尚未随 VSIX 分发，安装器与文档单工程假设待 P1-11 / P1-12。
- 多根工作区的下载默认目标仍取第一个 workspace folder（M0 遗留），交互路径可由 `targetDir` 覆盖。
- 工作区 folder 增删目前只提示重载窗口，未做增量 attach/detach（P2-2）。
- `.develop` 明文 Password 与 MCP `pwd` 必填保持不变（决策 6/7，P2-4）。

## 八、M2 实施记录

> M2 范围：P1-7 ~ P1-12（AI 编排链、引导模式、Agent 配置安全写入、skill 分发/安装、文档去单工程假设）。版本 `1.0.5`。

### 8.1 完成项

- [x] P1-7 MCP 工具增加工程维度：15 个工程级工具可选 `project`，新增只读 `workspaceInfo`（第 18 个工具），结果包 `{ project, result }`
- [x] P1-8 无 `.develop` 的 vf 窗口：MCP 以 bootstrap 模式启动，只暴露 `workspaceInfo` / `listProjects` / `downloadProject`；宿主调用侧二次校验
- [x] P1-9 Agent 指令与 MCP 配置写到后端工程根：`CLAUDE.md` / `AGENTS.md` 标记段合并；损坏 `.mcp.json` 跳过并警告，不重建
- [x] P1-10 重定向历史位置：M1 已落在工程根 `.bap/relocate-history.json`；按用户决策保持现状（不加 0600、不做迁移）
- [x] P1-11 领域 skill 纳入 VSIX：`stage-skills.js` 打包全部 skill；`BAP: Install Skills` 枚举安装到 `<vf根>/.votaforge/skill/`，覆盖前模态确认
- [x] P1-12 README / SKILL / references / 生成指令去掉单工程假设；根 README 与 `apps/vscode/README.md` 同步
- [x] typecheck / 单测（25 文件 213 例）/ compile / build 通过

### 8.2 关键设计

- **project 解析优先级**：projectId 精确 → projectUuid（忽略大小写）→ displayName 精确 → displayName 忽略大小写；任一类别多命中即 `AMBIGUOUS`，只返回该类别候选，不降级到下一类别。空值 → `INVALID_PROJECT`，无命中 → `UNKNOWN_PROJECT`。
- **不回退**：MCP 工具调用不带 `project` 时，不做活动编辑器 / 上次使用回退。0 个工程 → `NO_PROJECTS`；1 个 → 直接使用；多个 → `AMBIGUOUS` + 候选 + `suggestProjectParam` 提示。
- **结果 envelope**：工程级工具统一 `{ project: { projectId, displayName, root }, result }`（`undefined` → `null`）；工作区级工具原样返回。`project` 参数不进入 `execTool` 业务参数，但保留在 `toArgs` 中交给命令路由；内部路由键 `__project*` 等仍被清洗。
- **引导模式**：`shouldStartMcp(folderCount>0)` 控制是否启动；`computeMcpMode(registered>0 && live>0 ? full : bootstrap)` 计算实时模式。模式按**每条 IPC 连接（每个 MCP 进程）首次 listTools/invoke 时固定**，不依赖 VS Code 的 `resolveMcpServerDefinition`（外部 Claude Code / Codex 不经过该钩子）；`effectiveMcpMode` 只在工程集合消失时允许降级。`.develop` watcher 比较实时工程集合，变化时提示重载窗口。mcp-server 在 IPC 断开（窗口重载）后自动重连、重读 `~/.bap/mcp-ipc`、重拉工具列表，并通过 `notifications/tools/list_changed` 通知外部客户端刷新。
- **bootstrap `listProjects`**：无 `.develop` 时必须同时提供 `uri/user/pwd`，用一次性 RPC 直连 `getAllProjects` 后立即关闭；有工程时复用注册表连接（允许活动编辑器 / 上次使用回退）。
- **workspaceInfo**：数据仅来自扫描描述符与注册表；`serverUri` 去掉 userinfo（正常 URI 只在 authority 段剥离，保留 path/query 中的 `@`；畸形 URI 兜底删除到最后一个 `@`，异常输入也不泄漏凭据）；输出不含 `pwd`/`Password`/`user`。MCP 调用时由宿主注入调用方进程实际生效的 `mode`；该模式与窗口推断不一致、`registered:false` 或注册表有而实时扫描无 → `reloadRequired:true`。
- **Agent 配置**：`mergeMarkedSection` 只替换 BAP 标记段，保留用户内容、重复段合并、CRLF/BOM 保持、幂等；`mergeMcpJson` 对非法 JSON / 非对象根 / 非对象 `mcpServers` 返回 `ok:false`，调用方跳过写入；Codex TOML 读写异常降级为警告。
- **skill 安装**：枚举含 `SKILL.md` 的直接子目录（不写死名称）；目标必须是已存在的 VF 根（不创建 `.votaforge`）；同父临时目录 + 备份 rename 原子替换；跳过符号链接与 `.DS_Store` 等，并拒绝 `.votaforge` / `.votaforge/skill` 父级为符号链接（防止写到 VF 根之外）；仅在显式命令时执行。
- **IPC 错误协议**：宿主把异常规范化为 `{ message, code?, candidates? }`；子进程还原为 `IpcToolCallError`，文本附候选清单与 `BAP_MCP_ERROR_META`。超时按工具分级：下载/发布/单测 30 分钟，编译/依赖 10 分钟，重定向/列表/提交/更新全部 5 分钟，其余 30 秒。
- **IPC 端点安全删除**：宿主退出时仅当 `~/.bap/mcp-ipc` 内容仍等于本窗口 endpoint 才删除，避免误删其它窗口文件。

### 8.3 新增 / 修改文件

| 文件 | 变更 |
| --- | --- |
| `packages/vscode-host/src/mcp/mode.ts` | 新增：启动门禁与 full/bootstrap 模式计算 |
| `packages/vscode-host/src/mcp/ipc-protocol.ts` | 新增：结构化 IPC 错误、候选清洗、`BAP_MCP_ERROR_META`、按工具超时 |
| `packages/vscode-host/src/mcp/tools.ts` | 新增 `workspaceInfo`；15 个工程级工具加可选 `project`；导出模式裁剪与工具分类 |
| `packages/vscode-host/src/mcp/tool-exec.ts` | `isToolCall` 收紧；新增 `ProjectToolEnvelope` / `wrapProjectResult` |
| `packages/vscode-host/src/mcp/host.ts` | 启动门禁、模式裁剪、调用侧模式校验、结构化错误、`.develop` 监听提示重载、安全删除端点 |
| `packages/vscode-host/src/mcp/mcp-server.ts` | 解析结构化错误、按工具超时、断线自动重连并刷新工具列表（`tools/list_changed`）、版本 1.0.5 |
| `packages/vscode-host/src/projects/project-errors.ts` | 新增 `INVALID_PROJECT` |
| `packages/vscode-host/src/projects/project-registry.ts` | `projectRef` 解析（id/uuid/name）、`suggestProjectParam`、显式 ref 源 |
| `packages/vscode-host/src/projects/workspace-info.ts` | 新增：workspaceInfo 数据构建与 URI 去凭据 |
| `packages/vscode-host/src/projects/server-probe.ts` | 新增：bootstrap 直连探测服务器工程列表 |
| `packages/vscode-host/src/backend-projects.ts` | 新增 `findVfWorkspaceRoots` / `findVfWorkspaceRoot` |
| `packages/vscode-host/src/agent/markdown-merge.ts` | 新增：CLAUDE.md/AGENTS.md 标记段合并 |
| `packages/vscode-host/src/agent/mcp-config.ts` | `mergeMcpJson` 返回 `MergeMcpJsonResult`，损坏文件拒绝重建 |
| `packages/vscode-host/src/agent/agent-instructions.ts` | 生成上下文（兄弟工程/vf 根/skill 路径）；18 工具、project、bootstrap、envelope、routing 声明 |
| `packages/vscode-host/src/skill/skill-installer.ts` | 新增：skill 枚举、VF 根校验、原子安装/覆盖 |
| `packages/vscode-host/src/commands/command-router.ts` | 工具 `project` 路由与 envelope；`workspaceInfo` 命令；bootstrap `listProjects`；Agent 指令合并与警告汇总 |
| `packages/vscode-host/src/projects/activate.ts` | 传入 `launch` |
| `packages/vscode-host/src/activate.ts` | legacy：适配 `mergeMcpJson` 返回值 |
| `packages/vscode-host/src/index.ts` | 导出新模块与类型 |
| `apps/vscode/src/extension.ts` | 激活后注册 MCP（带工程数）；`bapIde.installSkills`；下载成功提示重载 |
| `apps/vscode/package.json` | 新增 `bapIde.installSkills`；版本 1.0.5；build 接入 stage-skills |
| `apps/vscode/scripts/stage-skills.js` | 新增：打包全部 skill 到 `assets/skill/` |
| `apps/vscode/.vscodeignore` | 排除 `scripts/**`，保留 `assets/**` |
| `packages/core/src/index.ts` | `BAP_IDE_VERSION` → 1.0.5 |
| `README.md` / `apps/vscode/README.md` | 18 工具、project/envelope/bootstrap、skill 安装、vf routing、projectId 哈希说明；两份同步 |
| `CHANGELOG.md` / `apps/vscode/CHANGELOG.md` | 1.0.5（并同步 1.0.4） |
| `skill/bap-vscode-mcp/**` | SKILL / commands / 17 份工具文档更新 + 新增 `workspaceInfo.md` |
| `packages/vscode-host/test/mcp-*.test.ts` / `ipc-protocol.test.ts` / `workspace-info.test.ts` / `markdown-merge.test.ts` / `agent-instructions.test.ts` / `skill-installer.test.ts` / `server-probe.test.ts` / `project-registry.test.ts` / `backend-projects.test.ts` / `mcp-config.test.ts` | 新增/扩展单测 |

### 8.4 行为速查

- **无文件夹窗口**：不启动 MCP（`resolve` 返回 undefined）。
- **有文件夹、无 `.develop`**：bootstrap；`workspaceInfo` 返回空工程；`commit` 等返回 `BOOTSTRAP_MODE`；`listProjects` 需显式 `uri/user/pwd`；`downloadProject` 可用。
- **单工程**：省略 `project` 直接执行，结果带 envelope。
- **多工程**：省略 `project` → `AMBIGUOUS` + 候选；按 projectId / projectUuid（忽略大小写）/ 工程名指定均可用；同一 uuid 多份检出时按 uuid 解析为歧义，改用 projectId。
- **下载/检出 `.develop` 后**：提示重载窗口；重载后 MCP 从 bootstrap 扩展为 18 个工具；外部客户端自动重连并刷新工具列表。
- **Agent 指令**：已有用户内容保留；重复 BAP 段合并；损坏 `.mcp.json` 原样保留并警告。
- **Install Skills**：仅 VF 根可装；枚举全部 skill；二次安装模态确认后覆盖；符号链接跳过。

### 8.5 已知边界（不在 M2 范围）

- P2-1 IPC 端点仍为全局 `~/.bap/mcp-ipc`（M2 仅做安全删除 + 文档提示多窗口限制）。
- P2-2 workspace folder 增删仍提示重载，未做增量 attach/detach。
- P2-4 MCP `pwd` 仍为必填；`.develop` 明文 Password 不变（决策 6/7）。
- P2-6 版本源未统一；M2 手动同步 `package.json` / `BAP_IDE_VERSION` / `mcp-server` 三处。
- P1-10 的 0600 权限与历史迁移按用户决策保持现状。
- 多根工作区下载默认目标仍取第一个 workspace folder（可被 `targetDir` 覆盖）。
