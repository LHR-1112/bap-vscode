# VS Code Webview 官方组件与能力确认

> 确认日期：2026-07-02  
> 目的：确认 VS Code 官方在 Webview 中到底提供了哪些 UI/集成能力，避免把 HTML 自绘控件、系统原生控件、VS Code 原生命令菜单混在一起。

## 结论

VS Code Webview 本身不是一套内置组件库。Webview 内容仍然是扩展自己渲染的 HTML/CSS/JS/React。

VS Code 官方真正直接提供给 Webview 的，主要是这些集成能力：

- VS Code 原生 `webview/context` 菜单。
- VS Code 主题类名和主题 CSS 变量。
- Webview 与扩展宿主之间的消息通信。
- Webview 状态持久化 API。
- 本地资源加载、安全边界和 CSP 能力。

另外，Microsoft 曾提供过 `@vscode/webview-ui-toolkit` 组件库，但该库已声明将于 2025-01-01 弃用，因此不建议在 BAP IDE 新增依赖使用。

## Webview 官方能力表

| 能力 | 是否属于 VS Code 官方 | 是否是 Webview 内组件 | 使用方式 | 说明 | BAP IDE 建议 |
|---|---:|---:|---|---|---|
| Webview Context Menu | 是 | 是，菜单由 VS Code 原生渲染 | `contributes.menus["webview/context"]` + `data-vscode-context` | 可在 Webview 指定区域右键显示 VS Code 原生菜单；也可在按钮点击时派发 `contextmenu` 事件来打开菜单。 | 提交按钮右侧的更多操作应使用这个方案。 |
| Webview 主题类名 | 是 | 不是控件，是样式集成 | `body.vscode-light`、`body.vscode-dark`、`body.vscode-high-contrast` | VS Code 会按当前主题给 Webview body 加类名。 | 用于大范围主题差异。 |
| VS Code 主题变量 | 是 | 不是控件，是样式集成 | CSS 变量，例如 `var(--vscode-editor-foreground)` | Webview 可直接使用 VS Code theme color 对应变量。 | 所有自绘 HTML 控件都应优先使用这些变量。 |
| 编辑器字体变量 | 是 | 不是控件，是样式集成 | `--vscode-editor-font-family`、`--vscode-editor-font-size`、`--vscode-editor-font-weight` | 可让 Webview 字体跟随 VS Code 编辑器设置。 | 代码、列表、输入区域可按需使用。 |
| Extension -> Webview 消息 | 是 | 不是控件，是通信能力 | `webview.postMessage(...)` | 扩展宿主向 Webview 推送状态。 | 当前 changes/history 状态刷新继续使用。 |
| Webview -> Extension 消息 | 是 | 不是控件，是通信能力 | `acquireVsCodeApi().postMessage(...)` | Webview 将用户操作发给扩展宿主。 | 当前提交、打开 diff、刷新等继续使用。 |
| Webview 本地状态 | 是 | 不是控件，是状态能力 | `vscode.getState()` / `vscode.setState()` | Webview 可保存 JSON 可序列化状态，隐藏后恢复。 | 可用于保存 UI 展开状态、历史条数等轻量状态。 |
| Webview 保活 | 是 | 不是控件，是生命周期能力 | `retainContextWhenHidden` | 隐藏 Webview 时保留 DOM 和 JS 状态，但内存开销高。 | 仅在必要时使用；轻量状态优先 `getState/setState`。 |
| 本地资源访问控制 | 是 | 不是控件，是资源能力 | `localResourceRoots`、`asWebviewUri(...)` | 限制 Webview 可加载的本地资源范围。 | 当前 dist/ui 资源加载应继续保持最小根目录。 |
| CSP 安全策略 | 是 | 不是控件，是安全能力 | `<meta http-equiv="Content-Security-Policy" ...>` | 限制脚本、样式、图片等资源来源。 | 当前 Webview HTML 必须继续带 CSP。 |

## Webview UI Toolkit 组件库

`@vscode/webview-ui-toolkit` 是 Microsoft 官方仓库里的 Webview 组件库，但官方 README 已标记弃用：`The Webview UI Toolkit for VS Code will be deprecated on January 1, 2025.`

| 组件 | 说明 | 当前建议 |
|---|---|---|
| `badge` | 徽标 | 不建议新增使用 |
| `button` | 按钮 | 不建议新增使用 |
| `checkbox` | 复选框 | 不建议新增使用 |
| `data-grid` | 数据表格 | 不建议新增使用 |
| `divider` | 分割线 | 不建议新增使用 |
| `dropdown` | 下拉框 | 不建议新增使用 |
| `link` | 链接 | 不建议新增使用 |
| `option` | 下拉选项 | 不建议新增使用 |
| `panels` | 面板/标签页 | 不建议新增使用 |
| `progress-ring` | 加载环 | 不建议新增使用 |
| `radio` | 单选按钮 | 不建议新增使用 |
| `radio-group` | 单选组 | 不建议新增使用 |
| `tag` | 标签 | 不建议新增使用 |
| `text-area` | 多行文本框 | 不建议新增使用 |
| `text-field` | 单行文本框 | 不建议新增使用 |

结论：它曾经能解决“Webview 控件长得像 VS Code”的问题，但现在不适合作为新实现基础。

## 容易混淆但不是 Webview 内组件的 VS Code 原生 UI

这些是 VS Code 扩展宿主 API 提供的原生 UI，不是在 Webview DOM 内渲染的组件。

| 能力 | 典型 API | 出现位置 | 是否适合提交按钮旁菜单 |
|---|---|---|---:|
| Quick Pick | `vscode.window.showQuickPick` | VS Code 顶部选择器 | 否 |
| Input Box | `vscode.window.showInputBox` | VS Code 顶部输入器 | 否 |
| Message | `showInformationMessage` / `showWarningMessage` / `showErrorMessage` | VS Code 通知区/弹窗 | 否 |
| Progress | `withProgress` | 通知区或窗口进度 | 否 |
| View Title Menu | `menus.view/title` | View 标题栏右侧 | 适合刷新、发布、baseline 等全局操作 |
| Tree Item Context Menu | `menus.view/item/context` | TreeView 节点右键菜单 | 适合 TreeView，不适合 React Webview 内列表 |

## 对 BAP IDE 当前实现的建议

| 场景 | 推荐实现 |
|---|---|
| 侧边栏顶栏按钮 | `menus.view/title` |
| 提交按钮右侧更多操作 | `menus.webview/context` + `data-vscode-context` + click 派发 `contextmenu` |
| 输入框、主提交按钮、文件列表 | React/HTML 自绘，但样式使用 VS Code theme variables |
| 提交确认、取消、结果提示 | VS Code `showWarningMessage` / `showInformationMessage` |
| 长任务进度 | 后续可考虑 `withProgress` 或 Webview 内 loading 状态，按交互位置决定 |

## 参考来源

- VS Code Webview Guide: https://code.visualstudio.com/api/extension-guides/webview
- VS Code Webview Context Menus: https://code.visualstudio.com/api/extension-guides/webview#context-menus
- VS Code Webview UI Toolkit README: https://github.com/microsoft/vscode-webview-ui-toolkit
- VS Code Webview UI Toolkit Components: https://github.com/microsoft/vscode-webview-ui-toolkit/blob/main/docs/components.md
