# VotaForge_Lite — 基于 CDP-VotaLite 的建模插件

> 状态：**活跃**（下一步从当前工程抽出，见 plugin-split.md 迁移阶段 P1）
> 体系总览：[plugin-split.md](./plugin-split.md) · 兄弟插件：[VotaForge_Frontend](./votaforge-frontend.md) · [VotaForge_Modeling](./votaforge-modeling.md) · [VotaForge_BAP](./votaforge-bap.md) · 共享组件：[CDP 布局器](./votaforge-layout-designer.md)

## 定位

后厂「建模」的第一形态：**基于 CDP-VotaLite 的建模插件**。

把 GPF 平台的流程/表单模型**本地化**：以 `.votalite` 文件承载模型（flow/form），提供可视化编辑器、云端双向同步、
三方状态冲突检测、SCM 差异列表与离线校验，模型保存/发布生效直达云端「业务建模器」。建模能力（编辑器前端）
1:1 迁自 CDP 工程的 flow-designer / form-designer，通过同步脚本跟随 CDP 上游演进。

同时**内嵌 [CDP 布局器](./votaforge-layout-designer.md)**（共享组件）可视化编辑云端页面，与 [VotaForge_Modeling](./votaforge-modeling.md)
（主体）共享同一布局器内核包；布局器**直接读写云上数据**（决策 D9），不经其他插件中转。

## 能力描述

### 1. `.votalite` 模型文件

- 文件类型 `votalite.model`（`*.votalite`，VS Code 自定义编辑器打开），含 `schemaVersion` / `meta` / `modelData` / `source`
- 本地存储：`.votaforge/votalite/panel/<busDomainCode>/<panelCode>.votalite`（原子写、重命名、删除）
- 云端基线：`.votaforge/votalite/baseline/<environmentId>/`

### 2. 可视化编辑器（Webview）

- CDP form-designer / flow-designer 全量 vendor 迁入，浏览器 dev 宿主实测通过（P2）
- 编辑即时写回 TextDocument（debounce，Ctrl+S 走 VS Code 原生保存）；推送由宿主执行，Token 不进 webview
- **设计器 SDK 调用原样透传**：宿主 `sdkCall` 走 `PanelSdkClient.rawInvoke()`，返回浏览器 SDK 原始响应（`{ state, data }` 信封）
- **提示与确认统一走宿主**：webview 内 sonner → `notifyBridge` 协议 → VS Code 通知；确认 → `showWarningMessage(..., { modal: true })`

### 3. 云端双向同步

- 云端通道：`resolveModelerPanelCode`（业务建模器名称 → 编号，回退 IML_00003）、`fetchCloudRecords`（Raw 分页）、
  `saveModel`（业务建模器_保存）、`publishModel`（操作_流程设计面板生效）、`deleteModel`（删除 + `buttonParam.rowCodes`）、
  `afterSave`（回写 recordId/panelCode + 重命名 + 基线）
- 三方状态（local / baseline / cloud）+ 稳定哈希 → 冲突检查；`pushModel` 编排（冲突检查 → 保存 → 回写 → 可选发布）
- 推送回写 panelCode 导致文件改名时：关闭旧标签页并打开新文件；「文档内容 == 磁盘基线」，状态徽章不残留

### 4. SCM 差异列表

`votalite.createSourceControl('votalite')`：

- 分组：云端变更 / 本地变更 / 冲突（三方状态分类）
- QuickDiff：`votalite-cloud:` 虚拟文档提供云端 modelData 原文
- 操作：拉取 / 推送 / 推送并发布 / 放弃本地修改 / 查看云端版本 / 刷新

### 5. 校验、模板与诊断

- `validateVotaliteFile` 离线结构自检：节点/连线/动作/角色/字段/权限/发布转换（不依赖云端）
- 默认文档模板：表单（标题/说明 + 保存）、流程（开始 → 审批 → 结束）
- `vf votalite doctor`：本地模型与云端基线的内容级漂移诊断

### 6. CDP 上游同步

- `tooling/sync-cdp-votalite.mjs`：锚点 v2 + 补丁重放 + `--check` 回归守卫；配套 `cdp-sync-manifest.mjs`（27 条拷贝清单）、
  `cdp-patches.mjs`（P1/P2/P3 补丁）、`annotate-cdp-vendor.mjs`
- 升级 SOP：`docs/votalite/cdp-sync.md`；回归清单：`docs/votalite/regression-checklist.md`
- 上游：CDP 工程 `/Users/lihongrui/SynologyDrive/kwaidoo/PanelXSdk_project/gpf_dc_Cdp_frontent`（本插件是其 votaforge 子项目的建模器演进形态）

### 7. CDP 布局器（共享组件，内嵌）

- 内嵌 [CDP 布局器](./votaforge-layout-designer.md) 编辑云端页面（designer/kit，页面级），与 flow/form designer（模型级）层级不同
- 数据通道**直接读写云上数据**（经 PanelX SDK，决策 D9）；布局器内核包与 VotaForge_Modeling 共享，待集成

## CLI

新 CLI（名字待定，见 plugin-split.md Q2），承接现有 `vf votalite` 子命令全集：

```
<cli> votalite pull | push | status | diff | new | validate | delete | doctor
```

- `push` 支持 `--publish`（保存 + 发布生效）；`new` 支持 `--panel-code` 指定本地文件键；`delete` 走云端删除
- 迁移期 `vf votalite` 保留 deprecation shim 提示切到新 CLI

## 组件与仓库布局（抽出清单）

| 层 | 组件 |
|----|------|
| packages | `votalite`（含 `@votaforge/votalite/doc` 纯文档层子路径，供 webview 打包） |
| webviews | `webviews/votalite/` |
| extension | VotaliteModelEditorProvider / VotaliteScmProvider / VotaliteModelsViewProvider / VotaliteSyncService |
| tooling | `build-votalite-webview.mjs` `sync-cdp-votalite.mjs` `cdp-sync-manifest.mjs` `cdp-patches.mjs` `annotate-cdp-vendor.mjs` |
| skills | `votalite-modeling`（含 6 篇 references） |
| docs | `docs/votalite/*`（plan / acceptance-m1 / acceptance-m2 / acceptance-p1 / acceptance-p2 / acceptance-p3 / cdp-sync / regression-checklist） |
| 共享依赖 | `@votaforge/model` `@votaforge/connection`（新抽） `@votaforge/panelx-sdk-adapter` |

## 与其他插件的关系

- **VotaForge_Frontend**：本插件模型「发布生效」后，云端面板定义变更经 Frontend 的同步链进入前端工程；两者通过云端产物衔接，无插件级依赖
- **VotaForge_Modeling**（暂缓，建模主体）：同为「建模」，通道不同——Lite 走业务建模器记录行（中文键映射、IML_00003），Modeling 走 PanelXProApi 面板设计定义；两插件共享 [CDP 布局器](./votaforge-layout-designer.md) 内核包（数据各自直达云端）
- **VotaForge_BAP**：无直接关系

## 关键设计

- **三方状态**：local（磁盘）/ baseline（最后同步的云端基线）/ cloud（30s 缓存快照），冲突按稳定哈希判定
- **宿主托管**：Token/推送/发布/提示/确认全部在扩展宿主，webview 无凭据
- **SDK 原样透传**：迁自 CDP 的代码按浏览器 SDK 原始响应形状解析，不经适配层归一化（历史坑：38fd35a、285ea55 两次修复）

## 状态与路线

- **已完成**：M1 模型记录闭环、M2 表单面板数据闭环、P0（路线图基座）、P1 可视化编辑器 MVP + SCM、P2 设计器 1:1 迁入 + 模型视图、P3 CDP 同步脚本 + doctor + 建模 Skill——均通过 biam_dev 真实验收
- **遗留**：新建空流程模板可保存但面板「生效」需更完整业务结构；导入为简化流程（无四阶段 UI）；布局器（designer/kit）内嵌待集成
- **路线**：P1 从当前工程抽出为独立插件 + 独立 CLI → 独立 VSIX 发版；抽出期间冻结功能迭代
