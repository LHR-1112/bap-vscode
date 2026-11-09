# BAP CLI 开发规划 V1.0

> 目标形态：**CLI 作为 AI 驱动的操作入口 + VS Code 插件作为配套前端**，两者共用同一套引擎与同一份状态。
>
> 本文只做方案设计，不含实现。所有引用的代码位置均为调研时的实际行号。
>
> 调研日期：2026-09-16

---

## 一、背景与目标

### 1.1 要解决的问题

现阶段 BAP 云工程的操作入口有两条，各有明显短板：

| 入口 | 问题 |
|---|---|
| Java 版 `bapdev-cli` | 纯 CLI。AI 驱动尚可，但**AI 失效时人无法接管**——只能继续敲命令。且每次调用重建进程与连接，执行效率低 |
| VS Code 插件 | 交互体验完整（SCM 视图 / 差异对比 / 历史面板），但**只能由人点击驱动**，AI 无法直接调用 |

此前曾尝试「把 Java CLI 桥进 VS Code 插件」（插件 shell 调 `java -jar`），效果很差，症状有三：

1. 每次执行都要启动 jar（短命进程，无状态复用）
2. 命令是一大坨字符串，人拼的，易错
3. 排错困难（只有 stderr 一堆文本）

### 1.2 目标形态

**不是**「把插件打包成 CLI」，**也不是**「二选一」，而是：

> CLI 提供 AI 可驱动的结构化入口；VS Code 插件提供人可接管的前端；**两者背后是同一个常驻引擎、同一份状态。**

关键验收标准（来自实际使用诉求）：

- AI 正常时：通过 CLI / MCP 结构化驱动，无需人介入
- **AI 失效时：人能在 GUI 里直接接管，不需要敲任何命令**
- CLI 侧不重复付出「启动 JVM + 登录握手 + 冷缓存」的代价

### 1.3 结论

**可行，且底座已完成约 90%。** 详见第三节。

---

## 二、可行性调研

### 2.1 分层耦合情况

全仓仅 **9 个文件** `import 'vscode'`，全部位于宿主层：

```
apps/vscode/src/extension.ts
packages/vscode-host/src/{index,activate}.ts
packages/vscode-host/src/scm/{bap-scm-provider,original-provider,file-decoration}.ts
packages/vscode-host/src/history/{history-provider,history-view}.ts
packages/vscode-host/src/mcp/host.ts
```

各层代码量与可复用性：

| 层 | 行数 | vscode 依赖 | CLI 下的处置 |
|---|---|---|---|
| `packages/core` | 5 | 无 | 原样复用 |
| `packages/rpc` | 356 | 无 | 原样复用 |
| `packages/sdk` | **2145** | **无** | **原样复用（业务核心）** |
| `packages/java-bridge` | Java | 无（独立子进程） | 原样复用（jar 资源） |
| `packages/vscode-host` | 2498 | 9 个文件 | 剥外壳后复用 |
| `apps/vscode` | 238 | 入口 | 保留（作为前端） |

分层当初做对的地方，直接构成本次方案的便利：

- **`RpcInvoker` 是干净的依赖注入接缝**（`packages/sdk/src/types.ts:9-18`）——SDK 不持有任何具体 RPC 类，由宿主注入
- **无 vscode 类型泄漏**——SDK 的「进度」是纯回调 `(p: {percent, message}) => void`，不是 `vscode.Progress`；全仓无 `vscode.Uri` / `CancellationToken` / `WorkspaceFolder` 漏到底层
- **文件系统全用 `node:fs`**，不是 `vscode.workspace.fs`
- **配置已是构造参数**——`javaHome` / `junitJarPath` / `cloudSnapshotTtlMs` / `onLog` 从 `apps/vscode/src/extension.ts:214-221` 传入 `createBapSdk`，CLI 改为命令行参数/环境变量即可，**SDK 一行不改**

### 2.2 运行时开销实测

在 macOS（Apple Silicon）实测，目标工程规模：306 个 Java 文件 / 3.5MB `src`，`lib` 310 个 jar / 324MB。

| 环节 | 实测耗时 | 结论 |
|---|---|---|
| node 启动 | 0.02s | — |
| JVM 启动（107 jar classpath） | 0.03s | 与 node 同量级 |
| bridge 进程启动 | 0.17s | 可接受 |
| 本地全量 MD5：`src/` 306 文件 | 0.01s | 可忽略 |
| 本地全量 MD5：`lib/` 310 jar | 0.78s | 唯一有分量的本地操作 |

**结论：运行时不是瓶颈。** node 与 JVM 的启动差距仅约 150ms，远小于一次网络往返。

真正的成本在**每次调用都要重新付出的、与语言无关的状态重建**：

| 每次调用重付的开销 | 插件中是否常驻 | 位置 |
|---|---|---|
| JVM bridge 冷启 | ✅ 常驻单例 | `packages/rpc/src/transport.ts:42` |
| WebSocket 连接 + login 握手 | ✅ 会话常驻 | `packages/java-bridge/.../BapRpcClient.java:44` |
| 本地 MD5 缓存 | ✅ 内存态跨调用复用 | `packages/sdk/src/refresh.ts:19-20` |
| 云端快照 TTL 缓存（30s） | ✅ 内存态跨调用复用 | `packages/sdk/src/services.ts:115-116` |
| 会话 CSession | ✅ 常驻 | `packages/sdk/src/services.ts:111` |

**插件的「快」来自常驻；CLI 的「慢」来自每次重建。** 因此方案的核心是：**让 CLI 复用插件的常驻状态，而不是另起一套短命进程。**

### 2.3 关键发现：现有 IPC 是通用 RPC 端点，非 MCP 专用

`packages/vscode-host/src/mcp/host.ts` 中已经存在一个本地 IPC server：

- `net.createServer()`，监听 `127.0.0.1` 随机端口
- 端点写入 `~/.bap/mcp-ipc`，格式 `host:port:token`（token 为 `randomUUID()`）
- 协议极简，**与 MCP 无关**：

```
客户端 → 服务端:  {token, type: 'listTools' | 'invoke', id, name, args}
服务端 → 客户端:  {type, id, result | error}
```

`packages/vscode-host/src/mcp/mcp-server.ts` 只是该端点的**一个客户端**（把 `listTools`/`invoke` 包装成 MCP stdio 协议）。

**即：CLI 可以是同一端点的第二个客户端，无需新设计任何传输层。**

更进一步，执行层也已备好。`packages/vscode-host/src/mcp/tool-exec.ts` 文件头注释：

> 一个 tool ↔ 一个 `bapIde.*` 命令，但工具路径走这里——**非交互、直接调 SDK/bapScm，返回可 JSON 序列化的结果（不开弹窗/通道/视图）**

**「非交互 + 可 JSON 序列化」正是 CLI 执行体的全部要求，且已有 17 个命令覆盖。**

### 2.4 现有命令清单

`packages/vscode-host/src/mcp/tools.ts` 的 `BAP_TOOLS` 定义了 17 个工具，含 name / description / JSON Schema（每个参数字段带中文说明）：

```
refresh  commit  commitFile  updateFile  updateAll  publish
projectHistory  fileHistory  updateLibs
compileProject  compileFile  debugClass  testProject
redirect  downloadProject  listProjects  fetchCurrent
```

这份定义可直接作为 CLI 子命令表的**单一来源**（见 4.4）。

---

## 三、目标架构

```
                        ┌────────────────────────────────┐
                        │        VS Code 插件             │
                        │   = 常驻引擎 + 配套前端          │
                        │                                │
                        │  bridge(JVM) 常驻    ← 只付一次  │
                        │  会话 / 缓存                     │
                        │  IPC server (127.0.0.1:port)   │
                        │  tool-exec.ts → sdk.*          │
                        │  ─────────────────────────     │
                        │  SCM 视图 / 差异 / 历史面板      │
                        └───────────────┬────────────────┘
                              ~/.bap/mcp-ipc
                 ┌──────────────────────┼──────────────────────┐
                 │                      │                      │
          ┌──────┴──────┐        ┌──────┴──────┐       ┌──────┴──────┐
          │    CLI      │        │ MCP server  │       │   GUI 操作   │
          │  薄客户端    │        │  （已存在）  │       │  人点鼠标     │
          └─────────────┘        └─────────────┘       └─────────────┘
             AI 敲命令              AI 结构化调用           人接管
```

**CLI 运行两种模式：**

| 模式 | 触发条件 | 行为 | 速度 |
|---|---|---|---|
| **A：附着（默认）** | 探测到插件 IPC 端点且工作区匹配 | 薄客户端，直连插件引擎 | 快（无 JVM 启动 / 无登录 / 无冷缓存） |
| **B：独立（降级）** | 无端点，或探测失败，或工作区不匹配 | 自带引擎（spawn bridge + sdk） | 慢（每次登录 + 冷缓存） |

**GUI 前端本次零新增开发**——直接复用现有 VS Code 插件。这符合项目既定决策（不引入任何前端框架，UI 全用 VS Code 原生）。

---

## 四、关键设计决策

### 4.1 工作区身份校验（必须有）

**这是最容易出错、后果最严重的一点。**

IPC 端点是**全局的**（`~/.bap/mcp-ipc`），但插件引擎**绑定在 VS Code 打开的那个工作区上**——`invoke` 最终走 `vscode.commands.executeCommand`，命令操作的是扩展上下文里的 `workspaceRoot`。

**若 CLI 在另一个 BAP 工程的目录下运行，却附着到了为工程 X 服务的端点，就会出现「在 A 目录执行 `bap commit`，实际提交到工程 B」的事故。**

处置方案：

1. CLI 从 `cwd` 向上查找 `.develop`，确定本地工程根
2. 附着前先发一条 `describe` 请求，取得引擎侧的 `{workspaceRoot, projectUuid, projectName}`
3. 与本地比对：
   - 一致 → 允许附着
   - 不一致 → **拒绝附着**，明确报错并提示可加 `--standalone` 强制独立模式

为此需给 IPC 协议**新增一条 `describe` 消息**（`packages/vscode-host/src/mcp/host.ts` 的 `dispatch`）。这是纯增量改动，不影响现有 MCP 客户端。

### 4.2 端点活性探测（必须有）

`~/.bap/mcp-ipc` 在插件 `deactivate` 时删除（`host.ts` 的 `deleteIpcFile`），但**插件崩溃退出时该清理不保证执行**，端点文件会残留一个死端口。

因此模式 A → B 的判定**不能只看文件是否存在**，必须实际探测：

- 读端点文件 → 建立连接（短超时，建议 1–2s）
- 连接失败 / 超时 / 认证失败 → 视为无端点，走模式 B
- 探测期间不发送任何业务请求

### 4.3 引擎模式必须显式可见

**降级不得静默发生。**

模式 A 与模式 B 的状态不共享——静默切换会让用户以为「复用的是插件那份状态」，实际是另一个引擎、另一份缓存、另一个会话，状态就此分叉。

要求：

- 每次调用都输出当前模式（人类可读输出在首行；`--json` 放在结果对象的 `engine.mode` 字段）
- 提供 `bap status` 子命令，显示：模式 / 端点 / 引擎工作区 / 工程名 / 连接状态
- 提供 `--attach` 与 `--standalone` 强制指定，用于消歧

### 4.4 命令表单一来源：`BAP_TOOLS`

CLI 的子命令定义**不另写一份**，直接从 `packages/vscode-host/src/mcp/tools.ts` 的 `BAP_TOOLS` 派生：

- 子命令名 ← `IpTool.name`
- `--help` 文本 ← `IpTool.description` + `inputSchema.properties[*].description`（已含中文说明）
- 参数解析规则 ← `inputSchema`（type: string/boolean → `--flag value` / `--flag`）
- required 校验 ← `inputSchema.required`

这样 CLI 与 MCP 的工具集**不可能漂移**。新增一个云工程能力时，只需在 `BAP_TOOLS` 加一项。

### 4.5 参数解析：不引入新依赖

现有仓库未使用 commander / yargs（`package-lock.json` 里的 `commander` 只是 `@vscode/vsce` 的传递依赖）。

由于参数规则可从 `inputSchema` 表驱动生成（4.4），**建议手写一个约 80 行的表驱动解析器**，保持依赖为零，同时保证与 MCP 定义一致。

### 4.6 引擎核心需从 SCM Provider 中抽出

`tool-exec.ts` 的实现依赖 `BapScmProviderHandle`（`packages/vscode-host/src/scm/bap-scm-provider.ts:9-23`）。该 handle 中真正被 CLI 用到的方法，业务逻辑都极薄：

| handle 方法 | 实现（`bap-scm-provider.ts`） | 实际业务 |
|---|---|---|
| `refresh(force)` | 87-118 | `sdk.refresh(force)` + 串行化 |
| `commit(comment)` | 250-260 | `sdk.code.saveChanges(changes, comment)` |
| `commitFile(change, comment)` | 184-188 | `sdk.code.saveChanges([change], comment)` |
| `updateFile(change)` | 191-194 | `sdk.discardAll([change])` |
| `updateChanges(changes)` | 208-211 | `sdk.discardAll(changes)` |
| `updateAll()` | 214-217 | `sdk.discardAll(lastChanges)` |

vscode 相关的部分（`createSourceControl`、三个 ResourceGroup、QuickDiffProvider、文件装饰、`showWarningMessage`、文件监听）都在**外壳**，与业务无关。

**处置：抽出 headless 的 SCM 业务核，`vscode-host` 与 CLI 共用，避免出现两份提交语义（这正是本次对话要解决的漂移问题本身）。**

推荐落点：**`packages/sdk` 新增模块**（如 `packages/sdk/src/scm.ts`，导出 `createBapScmCore(sdk)`）。

- 理由：SDK 定位是「业务封装」，而「哪些算变更」「提交全部意味着什么」属于业务语义
- 保持包数量不变（项目已有 5 个包，不宜为约 150 行再添一个）
- 依赖方向更干净：`vscode-host → sdk`，`cli → sdk`

改造后 `createBapScmProvider` 变为：`createBapScmCore(sdk)` + VS Code SCM 绑定层。

**需保留的语义：提交后的回读校验告警**（`warnVerify`，`bap-scm-provider.ts:171-181`，基于 `result.verifyWarnings`）。headless 下应通过：

- CLI：stderr 输出警告 + 结果对象携带 `verifyWarnings` 字段
- 保持非零退出码语义（有告警但提交成功时不判失败，需在文档中明确）

---

## 五、实施清单

### 阶段 0：前置重构（抽取 headless SCM 核）

| 动作 | 文件 |
|---|---|
| 新增 `createBapScmCore(sdk)`，含 refresh 串行化 + 提交/回退语义 + verifyWarnings 收集 | `packages/sdk/src/scm.ts`（新增） |
| 改造为「core + VS Code 绑定」，SCM 视图/装饰/监听逻辑保留原位 | `packages/vscode-host/src/scm/bap-scm-provider.ts` |
| 调整 `tool-exec.ts` 的 `McpToolCtx.bapScm` 类型为 core 类型 | `packages/vscode-host/src/mcp/tool-exec.ts:7-13` |

**风险控制**：此阶段纯重构，**行为必须完全不变**。改造后应先在现有插件里验证 SCM 视图行为与改造前一致。

### 阶段 1：CLI 骨架 + 模式 A（附着）

| 动作 | 说明 |
|---|---|
| 新建 `apps/cli` workspace | `package.json` 增加 `bin: { bap: "./dist/cli.js" }` |
| 实现 IPC 客户端 | 读 `~/.bap/mcp-ipc` → 建连接 → 发送 `{token, type, id, name, args}` |
| 实现表驱动参数解析 | 从 `BAP_TOOLS[].inputSchema` 生成（4.4） |
| 实现输出格式化 | 人类可读 + `--json` |
| 实现工作区解析与身份校验 | 向上查找 `.develop`；发送 `describe` 比对（4.1） |
| 实现活性探测与降级 | 短超时探测；显式提示模式（4.2 / 4.3） |
| esbuild 增加 cli 入口 | `apps/vscode/esbuild.js` 现有三个 entry 旁增一个；或 `apps/cli` 自带构建脚本 |

**此阶段结束即可验证核心假设**：附着模式下 CLI 是否真的免除了冷启动成本。

### 阶段 2：模式 B（独立引擎）

| 动作 | 说明 |
|---|---|
| 接入 `@bap/rpc` + `@bap/sdk` | `createRpcClient({launch})` → `createBapSdk({rpc, workspaceRoot, javaHome, junitJarPath, onLog})` 形态参照 `apps/vscode/src/extension.ts:213-221` |
| 解析 bridge 资源位置 | 见下方「资源分发」 |
| 实现 headless 执行层 | 复用阶段 0 的 core，逻辑同 `tool-exec.ts` |
| 日志/进度接到 stdout/stderr | `onLog` → stderr；进度回调 → stderr（保证 stdout 可被 JSON 消费） |

**资源分发决策（需确认）**：模式 B 需要 Java bridge（107 个 jar，约 98MB）与 junit jar。两个选项：

- **B1（推荐）**：复用已安装插件的 bridge 资源（`~/.vscode/extensions/bap.bap-ide-vscode-*/assets/bridge/lib`）。CLI 体积小；代价是要求插件已安装（但不要求运行）
- **B2**：CLI 自带一份 bridge 资源。完全独立；代价是分发体积增加约 98MB

### 阶段 3：协议增强

| 动作 | 文件 |
|---|---|
| IPC 协议新增 `describe` 消息，返回引擎工作区信息 | `packages/vscode-host/src/mcp/host.ts` 的 `dispatch` |

纯增量，MCP 客户端不受影响。

---

## 六、工作量与风险

### 6.1 工作量估计

| 阶段 | 内容 | 估计 |
|---|---|---|
| 0 | 抽取 headless SCM 核（纯重构） | 0.5–1 天 |
| 1 | CLI 骨架 + 模式 A | 1–2 天 |
| 2 | 模式 B 独立引擎 | 1–2 天 |
| 3 | 协议增强（`describe`） | 0.5 天 |

**总计约 3–5.5 天。**

阶段 0 与阶段 1 完成时即有可验证的中间成果；若阶段 1 验证不达预期，止损成本约 1.5–3 天。

### 6.2 风险清单

| 风险 | 影响 | 缓解 |
|---|---|---|
| **跨工程误提交** | 严重（数据事故） | 强制工作区身份校验（4.1），不匹配即拒绝附着 |
| **陈旧端点导致静默降级** | 中（状态分叉） | 活性探测（4.2）+ 模式显式可见（4.3） |
| 阶段 0 重构引入 SCM 行为回归 | 中 | 纯重构、行为不变；改造前后对照验证 SCM 视图 |
| 模式 B 与运行中插件并存 | 中 | 模式 B 仅在无端点时触发；`--standalone` 强制时明确警告 |
| 并发调用 | 低 | 模式 A 下所有调用经扩展宿主单线程事件循环天然串行 |
| CLI 与 MCP 工具集漂移 | 低 | 单一来源 `BAP_TOOLS`（4.4） |

### 6.3 已明确排除的做法

- ❌ **不做纯 CLI**——AI 失效时人无法接管，这是本次的根本前提
- ❌ **不做「插件 shell 调 jar」**——即此前失败的形态（短命进程 + 命令字符串 + 难排错）
- ❌ **不引入前端框架**——前端复用现有 VS Code 插件，符合项目既定决策

---

## 七、验收方式

### 7.1 功能验收

| 场景 | 预期 |
|---|---|
| VS Code 打开工程 A，在工程 A 目录执行 `bap refresh` | 附着成功，输出变更列表；SCM 视图同步反映 |
| 在工程 A 目录执行 `bap commit -m "..."` | 提交成功；SCM 视图变更清空（同一份状态） |
| VS Code 打开工程 A，在**工程 B** 目录执行 `bap refresh` | **拒绝附着**，明确报错 |
| 关闭 VS Code，执行 `bap refresh` | 降级到模式 B，**显式提示**；命令成功执行 |
| 强杀 VS Code 进程（端点文件残留），执行 `bap refresh` | 探测失败 → 降级模式 B，**不静默** |
| `bap status` | 显示模式 / 端点 / 引擎工作区 / 工程名 / 连接状态 |

### 7.2 性能验收（核心指标）

在目标工程上对比 `bap refresh` 的端到端耗时：

| 模式 | 预期量级 |
|---|---|
| A（附着） | 与插件内手动刷新相当；**不应出现 JVM 启动 + 登录握手**的固定开销 |
| B（独立） | 允许含 bridge 冷启（实测约 0.17s）+ 登录握手 + 冷缓存 |

**验收要点：模式 A 的耗时不应随调用次数增加而出现「每次都要重新登录」的特征曲线。** 这是本次方案成立与否的关键判据。

### 7.3 回归验收

阶段 0 完成后，须确认现有插件的 SCM 行为完全不变：

- 变更分组的 A/M/D 归类正确
- 单文件提交 / 单文件回退 / 全部回退行为一致
- `verifyWarnings` 告警仍能弹出
- 文件监听自动刷新仍生效

---

## 八、待确认事项

1. **bridge 资源分发方式**：B1（复用插件已安装资源，CLI 体积小）还是 B2（CLI 自带，完全独立）？
2. **独立模式的定位**：是否真的需要模式 B？若使用场景始终有 VS Code 在场，可只做模式 A，工作量与风险大幅下降（省去阶段 2 及资源分发问题）
3. **CLI 分发方式**：npm 包（`npm i -g`）还是随插件一起分发？
4. **退出码约定**：提交成功但存在 `verifyWarnings` 时，退出码应为 0 还是非 0？（建议 0 + stderr 警告，便于脚本消费）
