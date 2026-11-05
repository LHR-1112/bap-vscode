# BAP IDE 适配 VotaForge 体系改造清单 V1.0

> 日期：2026-11-05
> 依据：`docx/architecture/` 下 7 篇体系文档（plugin-split、workspace-protocol、votaforge-bap/lite/frontend/modeling/layout-designer）
> 范围：本仓库 `apps/vscode` + `packages/vscode-host` + `packages/sdk`
> 状态：**M0 实施中**（本文件随实施更新）

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
| 5 | 无 `.develop` 时 MCP | **启动但只暴露引导工具**（`workspaceInfo` / `listProjects` / `downloadProject`），检出 `.develop` 后扩展为完整工具集。 |
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
| 不改 17 个 MCP 工具名与既有参数（只做增量） | MCP schema 是机器接口 |
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
