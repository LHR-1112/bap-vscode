# BAP IDE MCP 工具索引

本文档只提供导航。每个 MCP 工具的参数、工作流与返回，见 `references/tools/` 下的独立文件。

共 20 个工具：`workspaceInfo` / `listProjects` / `downloadProject` 为**工作区级**，其余 17 个为**工程级**。

## 工具说明

- [workspaceInfo](./tools/workspaceInfo.md)
- [refresh](./tools/refresh.md)
- [commit](./tools/commit.md)
- [commitFile](./tools/commitFile.md)
- [updateFile](./tools/updateFile.md)
- [updateAll](./tools/updateAll.md)
- [publish](./tools/publish.md)
- [projectHistory](./tools/projectHistory.md)
- [fileHistory](./tools/fileHistory.md)
- [updateLibs](./tools/updateLibs.md)
- [compileProject](./tools/compileProject.md)
- [compileFile](./tools/compileFile.md)
- [debugClass](./tools/debugClass.md)
- [testProject](./tools/testProject.md)
- [registerClassRuleFunctions](./tools/registerClassRuleFunctions.md)
- [registerMethodRuleFunction](./tools/registerMethodRuleFunction.md)
- [redirect](./tools/redirect.md)
- [downloadProject](./tools/downloadProject.md)
- [listProjects](./tools/listProjects.md)
- [fetchCurrent](./tools/fetchCurrent.md)

## 通用说明

- 工具入参均用 JSON 对象。
- 工程级工具接受可选 `project` 参数，取值按以下顺序解析（命中即停）：`projectId` 精确 → `projectUuid`（忽略大小写）→ `displayName` 精确 → `displayName`（忽略大小写）。任一类别多命中即返回 `AMBIGUOUS`（附候选），不会降级到下一类别。
- 窗口内只有 1 个后端工程时可省略 `project`；多工程省略会返回 `AMBIGUOUS` + 候选，先调用 `workspaceInfo` 获取候选，再显式传 `project`，不要盲目重试。省略 `project` 时**不会**回退到活动编辑器或上次使用的工程。
- 工程级工具的结果统一包为 `{ "project": { "projectId": "...", "displayName": "...", "root": "..." }, "result": <原结果> }`（单工程时同样包）。
- 工作区级工具（`workspaceInfo` / `listProjects` / `downloadProject`）返回原始结果，不包该 envelope。
- 引导模式：窗口有 workspace folder 但没有 `.develop` 时，只暴露 `workspaceInfo` / `listProjects` / `downloadProject`；调用其它工具返回 `BOOTSTRAP_MODE`。先 `downloadProject`，把目录加入工作区并重载窗口后，才扩展为完整工具集（工具列表在 MCP 进程启动时固定；重载后宿主会通知刷新，外部客户端自动重连并重新拉取）。注册表与实时扫描不一致（有工程未注册 / 已移除），或调用方进程模式与当前窗口推断不一致时，`workspaceInfo.mcp.reloadRequired` 为 true，通常需重载窗口。
- 错误文本在含 code / 候选工程时，末尾追加一行 `BAP_MCP_ERROR_META: {"code":"...","candidates":[...]}`，便于 AI 解析；读取候选后再显式指定目标，不要盲目重试。
- 连接类字段：仅 `listProjects` 的 `uri` / `user` / `pwd` 可整体省略（有后端工程时复用其连接），提供时三者必须齐全；`redirect` / `downloadProject` 的 `uri` / `user` / `pwd` 必填。`project` 参数不做任何隐式回退。
- 交互式操作（打开 Diff / 文件 / 历史视图）不暴露为工具。
