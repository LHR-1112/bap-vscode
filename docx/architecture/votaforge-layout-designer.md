# CDP 布局器 — 建模插件共享组件

> 状态：**待集成**（真挂载仍归独立工作流；2026-11-05 起不再是独立插件，作为共享组件内嵌建模插件，见决策 D9）
> 体系总览：[plugin-split.md](./plugin-split.md) · 宿主插件：[VotaForge_Modeling](./votaforge-modeling.md) · [VotaForge_Lite](./votaforge-lite.md)

## 定位

CDP（Custom Design Platform，GPF 低代码设计器前端）的**布局器**能力——`src/designer/` 设计器内核（kit / ai / layout / report / shared），
用于在 IDE 内可视化构造与编辑**云端页面**。

2026-11-05 修订（决策 D9）：布局器**不再立独立插件**，作为共享组件内嵌
[VotaForge_Modeling](./votaforge-modeling.md)（建模主体）与 [VotaForge_Lite](./votaforge-lite.md) 两个建模插件，
两个插件都「拥有布局器编辑页面（云）」的能力。不再有独立的布局器 CLI 与 VSIX，工程形态随宿主插件。

## 数据通道（决策 D9 核心）

**布局器直接读写云上数据**：经 PanelX SDK 直达 GPF 服务器（页面设计定义），不读其他插件本地的东西，插件之间不存在数据中转。

- 每个宿主插件持有自己的会话与 SDK client，布局器只消费宿主的连接
- 布局器代码可共享（同一内核包），数据相互独立——不存在「Lite 的布局器读 Modeling 插件的东西」这类耦合
- 插件间协作仍只经云端产物（页面保存 → 云端 → 其他插件按需拉取）

## 与 flow/form designer 的层级区别

两者同出 CDP，但设计层级不同：

- **flow-designer / form-designer**：模型级设计器，已 1:1 迁入 VotaLite 编辑器，属 **VotaForge_Lite**（P2 已完成，浏览器 dev 宿主实测通过）
- **布局器（designer/kit）**：页面级设计器，本组件，待集成，Modeling 与 Lite 共享

## 能力描述（目标形态）

### 1. CDP 布局器真挂载（核心，待集成）

CDP 工程 `src/designer/` 设计器内核在 VS Code 内的挂载与工作流化（webview / 自定义编辑器形态，视宿主插件而定）。

### 2. CDP 工程面板能力对接

CDP 工程自带的面板侧能力（按归属原则评估）：

- `src/cdp_sdk/panelx-sdk-proxy.ts` — 个性化页面 PanelX SDK 代理
- `src/services/panel/` — 面板服务（查询/动作/配置）

对接时以本仓库 `packages/panelx-sdk-adapter/vendor/` 的 PanelX SDK（v1.5.0）为准，不与 CDP 工程 `public/` 下的构建产物混用。

### 3. 与 CDP 上游的同步机制（立项时建）

参照 Lite 的成熟做法：同步脚本 + 锚点 + 补丁重放 + `--check` 回归守卫（`tooling/sync-cdp-votalite.mjs` 同款模式），
保证 CDP 上游演进可跟踪、可回归。

## 组件（立项时新建，两宿主共享）

- packages：布局器内核包（从 CDP `src/designer/` 迁入的 vendor 层 + 适配层）
- webviews / 自定义编辑器：视布局器产品形态与宿主插件而定
- 共享依赖：`@votaforge/connection` + `@votaforge/panelx-sdk-adapter`（云上数据通道）
- skill：`cdp-layout` 类领域 skill（或并入宿主插件的建模 skill，立项时定）

## 与各插件的关系

- **VotaForge_Modeling / VotaForge_Lite**：宿主。布局器随宿主插件的 CLI 提供命令，不单独发版
- **VotaForge_Frontend**：布局器构造出的页面与契约驱动工程的应用如何衔接，立项时定义（open question Q6）
- **VotaForge_BAP**：无直接关系

## 状态与路线

- **待集成**。触发立项的信号：布局器（designer/kit）真挂载进入实施计划
- 立项时按本边界起步：CDP 同步机制照搬 Lite 模式，PanelX 对接以仓库 vendor 为准，数据通道直接读云
