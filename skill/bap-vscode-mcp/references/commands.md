# BAP IDE MCP 工具索引

本文档只提供导航。每个 MCP 工具的参数、工作流与返回，见 `references/tools/` 下的独立文件。

## 工具说明

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
- [redirect](./tools/redirect.md)
- [downloadProject](./tools/downloadProject.md)
- [listProjects](./tools/listProjects.md)
- [fetchCurrent](./tools/fetchCurrent.md)

## 通用说明

- 工具入参均用 JSON 对象。
- 未提供的可选字段，回退到插件连接信息（`.develop`）。
- 交互式操作（打开 Diff / 文件 / 历史视图）不暴露为工具。
