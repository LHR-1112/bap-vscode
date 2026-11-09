# VotaForge 四插件体系（plugin-split 决策）

> 状态：已定方向（2026-11-02 初版五插件；2026-11-05 修订为四插件（D9），并增补 SCM 统一（D10）、能力编排模型（D11）、根配置编辑权（D12）、工程根定位（D13））
> 背景讨论：一体化 Workbench → 按「后厂」开发阶段拆分能力插件
> 相关文档：`docs/votalite/plan.md`（VotaLite 路线图）、`docs/votalite/p2-implementation.md`（设计器迁入）

## 一、总体判断

按**能力与开发阶段**拆分插件（而非按代码来源），形成四插件体系：

| 插件 | 定位 | 状态 |
|------|------|------|
| **VotaForge_Modeling** | 建模的**主体**插件：走 PanelX-API 的建模 + 内嵌 CDP 布局器可视化编辑云端页面 | **暂缓**（主体方向，边界预留，不建空插件） |
| **VotaForge_Lite** | 基于 CDP-VotaLite 的建模插件（可视化编辑器 + SCM + 云端同步）+ 同样内嵌 CDP 布局器编辑云端页面 | **活跃**（下一步从当前工程抽出） |
| **VotaForge_Frontend** | 当前工程延续：基于面板契约的独立前端工程生成（面板同步链 + codegen + SDK + 网关 + 脚手架） | **活跃** |
| **VotaForge_BAP** | 现有 BAP 插件（Java 后端工程） | 外部，不动 |

各插件定位与描述文档：[VotaForge_Modeling](./votaforge-modeling.md) · [VotaForge_Lite](./votaforge-lite.md) · [VotaForge_Frontend](./votaforge-frontend.md) · [VotaForge_BAP](./votaforge-bap.md)
共享组件文档：[CDP 布局器](./votaforge-layout-designer.md)

关键点：**插件提供能力，Skill 负责编排**（决策 D11：插件/CLI 是能力单元，顶层 routing skill 统一调度）。插件之间通过工程产物与文件契约协作，不直接相互依赖。

## 二、组件归属表（对照当前仓库）

### 归 VotaForge_Frontend（当前工程，修剪 VotaLite 后）

- packages：`panel-contract` / `panel-sync` / `codegen` / `sdk` / `runtime-gateway` / `cli` / `mcp-server`
- extension：PanelTreeProvider、DevelopmentController、RuntimeTreeProvider、DevSettings、NetworkPanel、PanelSyncService、WorkspaceDiscovery、RuntimeState、CliInstallation、LoginPanel、DependencySyncPanel（即删除 Votalite* 后的全部）
- tooling：`build-extension.mjs` / `build-sdk.mjs` / `pack-cli.mjs` / `build-skills.mjs` / `dev-extension.mjs`
- skills：`votaforge-frontend` / `votaforge-panel-integration` / `votaforge-panel-verification`
- CLI：保留 `vf`（`create` / `pull` / `status` / `diff` / `sync` / `generate` / `gateway` / `mcp`，删除 `votalite` 子命令）

### 归 VotaForge_Lite（抽出）

- packages：`votalite`
- webviews：`votalite/`
- extension：VotaliteModelEditorProvider、VotaliteScmProvider、VotaliteModelsViewProvider、VotaliteSyncService
- tooling：`build-votalite-webview.mjs` / `sync-cdp-votalite.mjs` / `cdp-sync-manifest.mjs` / `cdp-patches.mjs` / `annotate-cdp-vendor.mjs`（CDP 同步是 VotaLite 专属维护面）
- skills：`votalite-modeling`
- docs：`docs/votalite/*`
- CLI：新 CLI（名字待定，见 Open Questions），承接 `votalite pull/push/status/diff/new/validate/delete/doctor`；`vf votalite` 留 deprecation shim 一个过渡期

### CDP 布局器（共享组件，归 Modeling 与 Lite 两边）

不再立独立插件（决策 D9）。作为共享组件内嵌两个建模插件：

- packages：布局器内核包（从 CDP `src/designer/` 迁入的 vendor 层 + 适配层，立项时新建，两个宿主插件共享）
- webviews / 自定义编辑器：视布局器产品形态与宿主插件而定
- 同步机制：照搬 Lite 的 CDP 同步脚本模式（锚点 + 补丁重放 + `--check`）
- 数据通道：**直接读写 GPF 云端页面数据**（经 PanelX SDK），不经其他插件中转
- 描述文档：[votaforge-layout-designer.md](./votaforge-layout-designer.md)

### 共享层（不进任何插件，是 npm 包）

| 包 | 内容 | 动作 |
|----|------|------|
| `@votaforge/model` | workspace/runtime 类型与常量 | 加 `schemaVersion`，升为契约包 |
| `@votaforge/connection`（新） | GPF 环境/profile 解析、PanelSdkClient 生命周期、Token 存取接口、登录状态 | 从 ServerEnvironmentService + 两份 serverProfile.ts 副本（`packages/cli/src` 与 extension）合并抽取 |
| `@votaforge/panelx-sdk-adapter` | PanelX SDK worker + vendor + 网络捕获 | 已是共享包，Lite 云端通道与 Frontend 同步链都依赖 |
| `@votaforge/cli-core`（如建 Lite CLI） | 凭据解析、profile 读写、`--json` 信封、版本输出 | **凭据与 profile 逻辑禁止 fork** |

> 插件之间的**工程层协议**（`.votaforge/` 文件契约、所有权、业务标识、演进纪律）见 [workspace-protocol.md](./workspace-protocol.md)

### 编排层（不属于任何插件，决策 D11/D12）

| 件 | 职责 |
|----|------|
| 顶层 routing skill | 解析用户目标 → 读 workspace.json `capabilities` 能力声明 → 路由到领域 skill → 执行 → 验收；骨架通用化，场景差异参数化 |
| workspace 编辑 skill | workspace.json 的唯一自动化编辑入口（能力声明的维护者，D12） |

领域 skill（`votaforge-frontend` / `votalite-modeling` / `votaforge-panel-integration` / `votaforge-panel-verification` / `bap-vscode-mcp`）是各插件的能力说明书，随插件分发。

### 暂缓插件（只立边界，不建空插件）

- **VotaForge_Modeling**：PanelX-API 面板定义推送/编辑 + 布局器内嵌。当前推送暂缓，实现后从边界起步。
  注意 CDP 的能力按归属拆：flow/form designer 已随 VotaLite 在 Lite 侧；布局器（designer/kit）由 Modeling 与 Lite 共享（决策 D9）。

### VotaForge_BAP

不动插件本体。接入方式只做两件事：workspace.json 增加 `backend` 引用段（指向 BAP 云工程）；skill 编排（BAP 已有 17 个 MCP 工具 + 自有 CLI）。

## 三、关键决策记录

- **D1 按能力切，不按代码来源切**。CDP 的 Flow/Form Designer 属 Lite；布局器不立独立插件、由建模插件共享（见 D9）；一个 Git 仓库不是切分单位。
- **D2 sync 链归 Frontend**。`pull → 提取 Contract → 接受变更 → 生成 API` 的唯一消费者是前端；codegen 产物 import `@votaforge/sdk`，同属 Frontend 消除跨插件版本漂移。Modeling 插件预留的是推送/编辑，不是这条交付链。
- **D3 CLI 跟插件绑定**，各自构建、版本、打包 tgz、分发。暂不做统一 umbrella 入口（零逻辑 shim 随时可加，现在做只增加版本矩阵）；`vf` 名字保留给 Frontend。布局器不再有独立 CLI，命令随宿主插件 CLI。
- **D4 登录态**：SecretStorage 按扩展 ID 隔离，各插件各自登录；中期可选：Lite 注册 `AuthenticationProvider`，Frontend 用 `vscode.authentication.getSession()` 按需共享 GPF 会话（登录瞬间的按需激活耦合，可接受）。
- **D5 网关归 Frontend**，建议以 `vf gateway` 子进程形态运行（token 经环境变量传入），Frontend 插件不再内嵌 PanelX worker。
- **D6 workspace 单文件演进**。不另立上层 `vota.workspace.json`；在现有 `votaforge.workspace.json` 加 `schemaVersion` + 可选能力段（`backend` 等）。
- **D7 契约先行**。schemaVersion、cli-core、connection 层在拆分**之前**冻结——两个插件一旦共读一批文件，格式就不能单边改。
- **D8 命名沿用 VotaForge 品牌**，不新造品牌（marketplace 认知成本）。
- **D9 布局器并入建模插件、直接读云**（2026-11-05 修订）。CDP 布局器（designer/kit）不再是独立插件：作为共享组件内嵌 Modeling（主体）与 Lite 两个建模插件，两个插件都「拥有布局器编辑页面（云）」的能力。其数据通道**直接读写 GPF 云端页面数据**（经 PanelX SDK），不读其他插件本地的东西——插件间协作仍只经云端产物。布局器代码可共享，数据相互独立。
- **D10 SCM 统一**（2026-11-05）。建模（Lite）/ 前端拉面板（Frontend）/ 后端工程（BAP）三域变更管理统一走 VS Code SCM provider；可见性按「能力声明（workspace.json `capabilities` 段）或产物信号 + `scmMode`（auto/always/never）」判定，自动安装的 skill 目录不作为信号。VotaLite SCM 已在 Lite 侧实现一版，契约见 [workspace-protocol.md](./workspace-protocol.md) §8。
- **D11 能力编排模型**（2026-11-05）。vf 插件/CLI 体系由**顶层 skill 统一调度与编排**：插件与 CLI 是「能力」单元，用户在 workspace 内要完成某目标时，由顶层 routing 型 skill 解析目标、读 workspace.json 的 `capabilities` 能力声明、决定所需能力与顺序，路由到各领域 skill 再驱动 CLI/MCP/插件。编排骨架通用化（读声明 → 路由 → 执行 → 验收），场景差异参数化，避免 per-scenario skill 爆炸。领域 skill = 能力说明书；CLI `--json` 信封 / MCP schema = 能力的机器接口。
- **D12 workspace.json 单一编辑权**（2026-11-05）。workspace.json 是整个项目的根配置文件：**全部插件（含 CLI）只读、绝不编辑**；编辑权归编排层的 workspace 编辑 skill（+ 用户手写）。`capabilities` 段是编排层维护的能力声明，插件按声明激活/降级（如 SCM 可见性判定）。脚手架生成初始文件按「生成 ≠ 编辑」处理，随插件/CLI 重构一并明确。
- **D13 工程根定位原则**（2026-11-05）。**体系内属主 → 配置声明**（前端根 = `applications[].rootDir`，平铺/容器两种布局）；**体系外属主 → 标记发现**（后端根 = `.develop` 协议常量扫描，BAP 属主，多后端工程各带一个）。详见 workspace-protocol.md §6。

## 四、四层职责

| 层 | 职责 | 归属 |
|----|------|------|
| Skill | 顶层编排：routing skill（读能力声明 → 路由 → 执行 → 验收）+ workspace 编辑 skill；领域 skill 是能力说明书 | 编排层 skill 不属于任何插件；领域 skill 各归其插件（D11/D12） |
| MCP | Agent 工具：明确参数与返回 | 现有 `vf mcp` 9 工具随 Frontend；Lite 需要时再建 |
| CLI | 自动化执行：Agent/终端/CI | 每插件一个，各自分发 tgz |
| VS Code 插件 | 交互与工程体验：编辑器/树/Webview/登录 | 四个插件（workspace.json 只读，D12） |

## 五、迁移阶段

1. **P0 契约冻结**：`@votaforge/model` 加 schemaVersion；抽 `@votaforge/connection`（合并两份 serverProfile 副本）与 `@votaforge/cli-core`（凭据解析/`--json` 信封/版本输出），扩展与 CLI 切换消费并自切换验证；快照与 `api/` 目录布局写成契约文档。→ 已产出 [workspace-protocol.md](./workspace-protocol.md)（含 5 项现状偏离收敛清单），实施时按该文档落地。**✅ 已完成（2026-11-02）**：connection/cli-core 已抽取并双端切换，server-profiles 与快照 manifest 已补 schemaVersion，全仓 build/typecheck/test 通过。
2. **P0 附：worker bundle 随共享包分发**：`panel-sdk-worker.bundle.cjs` 改为 `packages/panelx-sdk-adapter` 构建产物（包资产，固定路径可定位），任何消费方（Frontend/Lite 扩展）随包拿到，不再依赖各扩展自行构建——为 Q1（monorepo vs 独立仓库）两可铺路，此条容易漏。**✅ 已完成（2026-11-02）**：bundle 已是 adapter 包资产（`files: ["dist"]` 含之），build-extension 复制缺失即构建失败（原静默跳过），扩展 build 链前置 connection 构建。
3. **P1 抽出 VotaForge_Lite**：迁 `packages/votalite`、`webviews/votalite`、Votalite* 扩展代码、CDP 同步 tooling、skill、docs；新 CLI + `vf votalite` deprecation shim。
4. **P2 Frontend 修剪**：`vf` 删 votalite 子命令；extension 删 Votalite*；两插件各自独立 VSIX 与发版。
5. **P3 暂缓插件**：Modeling 立项时按边界起步（PanelXProApi 推送/编辑 + 布局器真挂载）。
6. **P4 可选**：extensionPack 形态的 VotaForge Workbench 伞插件（纯打包，不承载业务逻辑）。在 D11 能力编排模型下，跨插件编排由顶层 skill 完成，伞插件的必要性进一步下降。

## 六、Open Questions

- **Q1 repo 策略**：monorepo 内多 app（`apps/votaforge-frontend-extension` + `apps/votaforge-lite-extension`）还是 Lite 独立仓库？推荐 monorepo（共享 packages 就近、CDP 同步脚本与 vendor 同仓），发版独立性由各自 app 的版本号保证。
- **Q2 CLI 命名**：Lite CLI 名字（`vfl`？`vota-lite`？）；未来 Modeling 的 CLI 命名一并预留（布局器无独立 CLI，命令随宿主插件）。
- **Q3 市场命名**：VotaForge_Lite 的扩展名用 `VotaForge Lite` 还是 `VotaLite`。
- **Q4 网络捕获**：DevSettings/NetworkPanel 随 Frontend；Lite 的云端通道（业务建模器读写）流量是否需要自己的捕获 UI。
- **Q5 skills 边界**：`votaforge-panel-integration` / `panel-verification` 横跨 Lite↔Frontend（Lite 发布生效 → Frontend 同步验收），归属 Frontend 还是升为共享 skill。
- **Q6 布局器工程形态**：布局器内核包以共享 npm 包还是一个独立小包（vendor + 适配层）分发，待立项时定；其页面产物与 Frontend 契约工程的衔接方式同步定义。
- **Q7 编排层 skill 分发**：顶层 routing skill 与 workspace 编辑 skill 不属于任何插件，其分发与维护归属待定（随某一 CLI tgz / 独立渠道）。

## 七、风险与纪律

1. **schema 漂移**：独立发版后格式变更需 forward-compat（读者容忍未知字段），破坏性变更建模类插件先发。
2. **双登录 UX**：短期接受，D4 中期方案兜底。
3. **凭据逻辑 fork**：cli-core 是硬约束，skill 只写一份兼容。
4. **P1 抽取期间**：建议冻结 VotaLite 功能迭代，移动 + 验证（回归清单 `docs/votalite/regression-checklist.md`）为唯一工作。
5. **布局器共享边界**：布局器代码共享但**数据不共享**——每个宿主插件经自己的会话直达云端，不引入插件间的运行时依赖；共享面只到包（npm）与契约文件为止。
6. **根配置写入纪律**：插件写 workspace.json 视为协议违规（D12）；新插件接入时以此为第一道审查。
