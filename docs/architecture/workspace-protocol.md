# VotaForge 工程层协议（workspace-protocol）

> 状态：协议定义（2026-11-02），实施 = plugin-split.md 迁移阶段 P0；2026-11-05 增补 SCM 约定（D10）、能力编排与根配置编辑权（D11/D12）、工程根定位（D13）
> 体系总览：[plugin-split.md](./plugin-split.md)
> 本文是**工程层协议**（插件之间通过工程文件与产物协作）；Agent 层协议（CLI `--json` 信封、MCP schema）见 plugin-split.md 四层职责

## 一、定位

四个插件不直接相互调用，它们通过**工程文件契约**协作。`.votaforge/` 目录、`votaforge.workspace.json`、
`api/` 就是插件之间的协议载体。独立发版之后，任何一方都不能单边改格式——所以这份协议必须先行定义（决策 D7）。

## 二、总原则

1. **单一写入者（owner-writes）**：每个文件/目录只有一个插件负责写入；其他插件一律只读。跨插件不抢写，是消除「最后一写者赢」混乱的根本规则。
2. **schemaVersion + 向前兼容**：所有共享 JSON 带 `schemaVersion`；读者**忽略未知字段**（新增字段默认可选）；破坏性变更由写入方先行发版、读者做双读过渡。
3. **文件是产物，不是通道**：插件间不靠文件系统事件通信；文件代表稳定状态，读取方在任何时点读取都应得到可解析的结构。
4. **凭据永不落盘**：Token 只在 SecretStorage（扩展，按扩展 ID 隔离）或环境变量（CLI）。`server-profiles.json` 只存端点，不存凭据。
5. **单一工作区根标记**：`votaforge.workspace.json` 是 VotaForge 插件的工程发现根（决策 D6，不另立上层 workspace 文件）；BAP 以 `.develop` 为后端工程根标记（协议常量，见 §6.1），互不冲突。
6. **根配置插件只读**：`votaforge.workspace.json` 对全部插件（含 CLI）**只读**——它是整个项目的根配置文件；编辑权归编排层的 workspace 编辑 skill 与用户（决策 D12）。

## 三、文件清单与所有权

| 路径 | 写入方（Owner） | 读取方 | 可再生 | 版本现状 |
|------|----------------|--------|--------|----------|
| `votaforge.workspace.json` | 编排层（workspace 编辑 skill）+ 用户；全部插件只读（D12） | 全部插件（工程发现 + `capabilities` 能力声明）、编排 skill | 否 | ✅ `kind` + `schemaVersion: '2.0'` |
| `.votaforge/server-profiles.json` | Frontend（脚手架/新建环境） | Frontend、Lite | 否 | ✅ `schemaVersion: '1.0'`（P0 完成；save 自动补写，load 容忍缺失） |
| `.votaforge/runtime.json` | Frontend（DevelopmentController / RuntimeStateService） | Frontend | 是（瞬时状态） | ✅ `kind` + `schemaVersion: '1.0'` |
| `.votaforge/snapshots/<environmentId>/` | Frontend（同步链） | Frontend（codegen/网关） | 是 | ✅ `schemaVersion: '1.0'`（P0 完成；读端容忍旧 manifest） |
| `.votaforge/votalite/` | Lite（store/baseline） | Lite | 否（用户源文件） | ✅ `.vfl` 内 `schemaVersion: '1.0'` 严格校验 |
| `.votaforge/raw-definitions/` | Frontend（原始拉取数据） | Frontend | 是 | 诊断用途 |
| `api/`（apiDir） | Frontend（codegen） | 应用工程（import） | 是 | 生成物，由 `api/meta/workspace.json` 自描述 |

关键点：**Lite 与 Frontend 之间没有直接文件交换**——Lite 发布生效写到云端，Frontend 同步链从云端拉取。
两者共享的只有 `server-profiles.json`（读）与 workspace 发现（读）。这使耦合面极小。

## 四、各文件契约

### 4.1 `votaforge.workspace.json`（工程根）

现行字段（`packages/model/src/workspace.ts`）：

```jsonc
{
  "kind": "votaforge.workspace",
  "schemaVersion": "2.0",
  "name": "oa-workbench",
  "apiDir": "api",
  "applications": [{ "id": "app", "name": "...", "rootDir": "app", "type": "vite" }],
  "serverProfilesFile": ".votaforge/server-profiles.json",
  "sync": { "onLogin": true, "onWorkspaceOpen": true, "autoGenerateOnCompatible": true, "blockBreakingAutoSync": true }
}
```

**演进提案（可选能力段，新增字段默认可选）**：

```jsonc
{
  // ...现行字段
  "capabilities": {
    "backend": { "projects": [{ "name": "gpf_xxx", "bapProject": "BAP 云工程名" }] },  // 可选：BAP 引用段，链路可追溯（决策 D6/D13）
    "modeling": { "votalite": true }                                                     // Lite 能力声明（SCM 可见性信号，§8.2）
  }
}
```

- **能力声明**：`capabilities` 是插件能力的声明清单——编排 skill 据此路由，插件据此激活/降级（§8.2 的 SCM 可见性判定即其一例）
- **编辑权（决策 D12）**：全部插件（含 CLI）只读本文件，绝不编辑；编辑由编排层的 workspace 编辑 skill 或用户手写完成
- **路径锚点**：所有路径字段（`apiDir`、`applications[].rootDir`、`serverProfilesFile`）均以 workspace 根（本文件所在目录）为锚；`.votaforge/` 固定位于该根下
- **前端工程根 = `applications[].rootDir`**（配置声明，见 §6）：平铺形态（`rootDir: "."`，纯前端独立工程）与容器形态（`rootDir: "web"`，多工程 workspace：资料 / Java 工程 / 前端）均合法；前端工程文件一律在 rootDir 下，workspace 根不出现前端脚手架文件
- **后端不记本地检出路径**：`backend` 段只声明云工程引用（可选、可多个，`projects` 数组）；本地检出位置是机器相关的私有状态，不进契约；后端工程根由 `.develop` 标记发现（§6.1），无需路径字段
- 能力段只声明**引用与标记**，不承载各插件私有配置（私有配置走各插件自己的状态文件）
- 所有插件按原则 2 读：不认识的能力段忽略

### 4.2 `.votaforge/server-profiles.json`（环境定义，双插件共享读）

```jsonc
{
  "schemaVersion": "1.0",        // P0 新增
  "activeProfileId": "oa-dev",
  "profiles": [
    {
      "id": "oa-dev",                    // profile 选择键（CLI --environment、activeProfileId）
      "name": "OA 开发",
      "baseUrl": "https://office.kwaidoo.com/biam_dev",
      "busDomainCode": "GroupChat_Inst_17790942612666",
      "appCode": "...",
      "environmentId": "oa-dev-env",     // 快照命名空间，可与 id 不同（双身份，见 §5）
      "apiDir": "api"                    // 与 workspace.json apiDir 可能分叉（现状问题，见 §6）
    }
  ]
}
```

- 解析逻辑收敛到 `@votaforge/connection`（P0 合并两份 `serverProfile.ts` 副本，禁止 fork）
- `activeProfileId` 语义：文件值是 CLI/新进程的默认环境；插件内切换环境回写文件的策略见 §6-3

### 4.3 `.votaforge/snapshots/<environmentId>/`（契约快照）

```
snapshots/<environmentId>/
├── incoming/
│   ├── manifest.json          # P0 补 schemaVersion
│   └── panels/<panelCode>.json
└── active/
    ├── manifest.json
    └── panels/<panelCode>.json
```

- 两阶段：`incoming`（候选，刚拉取待确认）/ `active`（基线，生成 API 与启动网关只读它）
- 命名空间 = `environmentId`（**不是 profile id**，见 §5）
- 读者仅 Frontend；Lite 不读此目录

### 4.4 `.votaforge/votalite/`（Lite 私有）

```
votalite/
├── panel/<busDomainCode>/<panelCode>.vfl   # 用户源文件（可编辑）
└── baseline/<environmentId>/               # 云端基线（三方状态之一）
```

- `.vfl` 是**用户源文件**：`schemaVersion` 严格校验（不认识的版本报错，不静默忽略）——与生成物的容忍策略不同，源文件的严格是有意的
- 目录对 Lite 之外的一切插件是黑盒

### 4.5 `api/`（生成物，可再生）

- 由 codegen 原子生成（临时目录 → 替换 → 清理清单外旧文件）；内容自描述（`api/meta/workspace.json`）
- 任何插件/工具不得手改 `api/`；变更的合法入口只有「重新生成」

## 五、跨插件业务标识

三个标识贯穿建模 → 面板 → 前端：

| 标识 | 含义 | 出现位置 |
|------|------|----------|
| `busDomainCode` | 业务域 | server-profiles、votalite 目录、面板定义 |
| `panelCode` | 面板编号（如 `IML_00146`） | 快照、api/panels/<code>、云端记录关联面板 |
| `environmentId` | 环境命名空间（快照/基线隔离） | snapshots、votalite/baseline |

注意**双身份**：profile 的 `id` 是选择键，`environmentId` 是数据命名空间，两者可不同（现网即如此）。
插件之间以 `environmentId` 对齐数据、以 `id` 对齐用户选择，协议文档中二者不得混用。

## 六、工程根定位：配置声明 vs 标记发现（决策 D13）

前端/后端工程根如何被 vf 体系内任何一方（插件、CLI、skill）定位，遵循一条原则：

**体系内属主 → 配置声明；体系外属主 → 标记发现。**

| | 前端工程根 | 后端工程根 |
|---|---|---|
| 属主 | Frontend（在体系内） | BAP（在体系外，不读不写本协议） |
| 定位方式 | 配置声明：`applications[].rootDir` | 标记发现：`.develop` 协议常量 |
| 理由 | 属主是 workspace.json 能力声明的一方，路径随配置演进 | 标记的价值在「无先验知识即可发现」；可配置标记要求先读配置且易漂移 |

### 6.1 `.develop` 后端工程根标记（协议常量）

- 后端工程根 = workspace 根下含 `.develop` 标记的目录；一个 workspace 可有多个后端工程（每个 Java 工程各带一个）
- `.develop` 是**协议常量**，不是配置字段：任何 vf 插件/skill 无需先验配置即可扫描发现后端工程
- 属主：BAP（标记是其自身产品机制）；BAP 变更标记时，本协议随其版本化演进
- workspace.json 的 `backend` 段（§4.1）只是可选的显式引用（云工程名 ↔ 本地工程名，可多个），用于链路可追溯；没有该段时标记扫描照样工作

## 七、现状偏离与 P0 收敛清单

| # | 现状问题 | 收敛动作 |
|---|----------|----------|
| 1 | `server-profiles.json`、快照 manifest 无 schemaVersion | ✅ 已完成（P0，2026-11-02）：connection 写端自动补写、panel-sync manifest 总是写入，读端均容忍缺失 |
| 2 | profile 解析有两份副本（`packages/cli/src/serverProfile.ts` / 扩展 `src/serverProfile.ts`） | ✅ 已完成（P0，2026-11-02）：合并为 `@votaforge/connection`，两份副本已删除；凭据提供者与版本读取上提 `@votaforge/cli-core` |
| 3 | 插件「切换环境」只改 globalState，不回写文件 `activeProfileId` | 协议明确策略（推荐：回写文件；或明确声明「文件仅 CLI 默认值」并在文档固定） |
| 4 | `apiDir` 双源（workspace.json 与 profile 均含）可能分叉 | 协议固定优先级（CLI 已按 workspace.json 优先 + 告警；Profile 中字段标注 deprecated） |
| 5 | `examples/oa-workbench/snapshots/`（根级）旧布局残留 | 清理，仅保留 `.votaforge/snapshots/` |

## 八、SCM 约定（变更管理统一走 SCM，决策 D10）

### 8.1 方向与通用模式

建模（Lite）、前端拉面板（Frontend）、后端工程（BAP）三域的变更管理，统一以 **VS Code Source Control（SCM provider）** 承载：

- 每个域一个 SCM provider（独立 `scm.createSourceControl` id，互不冲突），三域并列出现在「源代码管理」视图
- 分组/状态语义各域自定（如 Lite 的三方状态：云端变更/本地变更/冲突）；跨域不改写对方状态

可见性通用判定模式（各域一致）：

```
可见 = 当前窗口是 VotaForge 工程（votaforge.workspace.json 存在）
       &&（能力声明（workspace.json capabilities 段）|| 产物信号（目录/文件存在））
```

- 每域配 `scmMode` 设置：`auto`（默认，按上式判定）/ `always`（调试用，任意窗口都显示）/ `never`
- 产物信号必须由**真正产生数据**的操作创建——读取路径不建目录，保证信号无假阳性
- 自动安装的 skill 目录**刻意不作为信号**：它对每个 VotaForge 工程常量存在，作为信号等于常显

### 8.2 VotaLite SCM 可见性契约（已在 Lite 实现一版）

`auto` 模式下同时满足「当前窗口是 VotaForge 工程」和「检出 VotaLite 使用痕迹」（任一信号即检出）：

| 信号 | 来源 | 说明 |
|------|------|------|
| 显式声明 | `votaforge.workspace.json` 的 `capabilities.modeling.votalite: true` | 协议 §4.1 的能力声明；全部插件只读，由编排层 workspace 编辑 skill 写入（决策 D12）。声明位于 workspace.json 内，命中它即隐含「是 VotaForge 工程」 |
| 强信号 | `.votaforge/votalite/` 目录存在 | 只有真正拉取/新建过模型才会创建；读取路径不建目录 |
| 弱信号 | 工程内存在任意 VotaLite 模型文件（`.vfl`） | 覆盖模型目录被手工搬走的极端情况；建议仅在声明与强信号均不满足时做一次扫描，并尊重 `.gitignore` |
| 刻意排除 | `.votaforge/skill/votalite-modeling/` | 对每个 VotaForge 工程自动安装，用它判定等于恢复常显 |

设置：`votaforge.votalite.scmMode` = `auto`（默认）/ `always` / `never`；插件独立发版后，设置段随各插件自身的配置命名空间。

### 8.3 预留

- **Frontend 面板 SCM**：方向为面板变更走 SCM（incoming/active 两阶段快照的变更视图）；能力声明预留 `capabilities.frontend.*`，立项时按 7.1 模式接入
- **BAP SCM**：BAP 已自带云工程 SCM（提交/发布/历史），作为后端变更视图保留；workspace 层只加 `capabilities.backend` 引用段（§4.1），不改 BAP 本体

## 九、演进纪律

- **破坏性变更**：写入方插件先发版（新格式 + 读旧格式双读期）→ 观察期 → 停止写旧格式；读方随后跟进
- **新增字段**：一律可选；读者忽略未知字段
- **私有状态 vs 协议**：插件私有状态（如网络捕获配置、窗口布局）不得写入 §三 清单中的共享文件，避免把私有状态升级成协议
- **根配置编辑权**：workspace.json 只经编排层（workspace 编辑 skill）或用户编辑；插件写入根配置视为协议违规（决策 D12）
