# VotaForge_Modeling — PanelX-API 主建模插件（暂缓）

> 状态：**暂缓**（建模体系的主体方向，只立边界，不建空插件）
> 体系总览：[plugin-split.md](./plugin-split.md) · 兄弟插件：[VotaForge_Lite](./votaforge-lite.md) · [VotaForge_Frontend](./votaforge-frontend.md) · [VotaForge_BAP](./votaforge-bap.md) · 共享组件：[CDP 布局器](./votaforge-layout-designer.md)

## 定位

后厂「建模」的**主体插件**：**走 PanelX-API 的建模插件**。

以 PanelX SDK 的 PanelXProApi 通道直接操作 GPF 面板设计定义（`getPanelDesignDefinition(List)` 的对称面），
在本地完成面板定义的**编辑与推送/保存**，把「云端建模器」的能力搬进 IDE。
同时**拥有 [CDP 布局器](./votaforge-layout-designer.md)** 可视化编辑云端页面（designer/kit，页面级），
布局器**直接读写云上数据**（决策 D9），不经其他插件中转。

它与 [VotaForge_Lite](./votaforge-lite.md) 同为「建模」，但通道不同：

| | 通道 | 模型载体 | 现状 |
|---|---|---|---|
| VotaForge_Lite | 业务建模器记录行（业务建模器_保存 / 操作_流程设计面板生效） | `.votalite` 文件（flow/form） | 已实现并验收 |
| **VotaForge_Modeling** | PanelX SDK 面板设计定义 API | 面板设计定义（PanelXProApi） | **暂缓** |

两插件共享 [CDP 布局器](./votaforge-layout-designer.md) 内核包编辑云端页面（代码共享、数据各自直达云端）。

## 能力描述（目标形态）

### 1. 面板定义拉取与本地编辑

- 拉取：`getPanelDesignDefinition(List)` 已具备（当前由 Frontend 同步链消费，见边界说明）
- 本地编辑：面板设计定义的 IDE 化编辑体验（字段/动作/事件/流程状态），形态待定

### 2. 面板定义推送/保存（核心，暂缓）

- 把本地编辑后的面板设计定义推回 GPF 平台，与「云端为源、契约驱动」互补——建模的修改闭环从云端前移到本地
- 历史说明：早期 `model-import` / `model-publish` 包曾移植 CDP 设计器的 `publishTransform`
  （toPanel 转换 + 逆向转换 `flowModelToFlowDoc` / `formModelToFormDesignDoc`），已随旧架构删除（git c9c9aaf 之前）；
  如立项可从中找回参考

### 3. 版本管理

- 面板定义的版本对比与回滚（PanelX 通道侧能力，视平台 API 而定）

### 4. CDP 布局器（共享组件，内嵌）

- 内嵌 [CDP 布局器](./votaforge-layout-designer.md) 编辑云端页面（designer/kit，页面级），与 VotaForge_Lite 共享同一内核包
- 数据通道**直接读写云上数据**（经 PanelX SDK，决策 D9），待集成

## 边界说明（决策 D2）

**拉取 → 提取 Contract → 生成 API 的交付链归 VotaForge_Frontend**，不归本插件：

- 该链的唯一消费者是前端工程；codegen 产物 import `@votaforge/sdk`，与 Frontend 同属一个插件可消除跨插件版本漂移
- 本插件负责的是「编辑与推送」这一模型维护侧；Frontend 负责「契约交付」这一消费侧
- 因此本插件立项前，`getPanelDesignDefinition` 的现有用法（Frontend 同步链）保持不动

## CLI

未来预留独立 CLI（名字待定，见 plugin-split.md Q2），命令形态预计围绕面板定义的拉取/编辑/推送/版本。

## 组件（立项时新建）

- packages：`panel-modeling` 类新包（面板定义编辑与推送编排）；布局器内核包（与 Lite 共享，见 [CDP 布局器](./votaforge-layout-designer.md)）
- 共享依赖：`@votaforge/connection`（GPF 会话）+ `@votaforge/panelx-sdk-adapter`（`getPanelDesignDefinition(List)` 已具备）
- skill：`votaforge-panel-modeling` 类领域 skill

## 与其他插件的关系

- **VotaForge_Lite**：并列的两种建模形态，业务对象同一（GPF 面板），通道不同；共享 [CDP 布局器](./votaforge-layout-designer.md) 内核包编辑云端页面；未来可共用「建模」心智与部分 UI 模式
- **VotaForge_Frontend**：推送/编辑闭环后，Frontend 同步链拉到的就是本插件保存后的面板定义——两者经云端衔接
- **VotaForge_BAP**：无直接关系

## 状态与路线

- **暂缓**。触发立项的信号：出现「本地编辑面板定义再推送」的真实需求，或平台侧 PanelXProApi 推送能力就绪
- 立项时按本边界起步，复用共享连接层与 adapter，不重复造会话/SDK 设施；布局器（designer/kit）真挂载纳入立项范围
