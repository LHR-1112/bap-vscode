# fileHistory

查询某个文件的历史版本。

## 参数

| 参数 | 类型 | 说明 | 必需 |
|------|------|------|------|
| `project` | string | 目标工程：projectId 精确 → projectUuid（忽略大小写）→ displayName 精确 → displayName（忽略大小写）；可用 `workspaceInfo` 查询 | 否（单工程可省略；多工程必填） |
| `remoteKey` | string | 资源用相对路径；Java 用点分 fullClass | 是 |

## 示例

```json
{ "name": "fileHistory", "arguments": { "project": "gpf_demo", "remoteKey": "cell.demo.Test" } }
```

## 返回

结果包为 `{ "project": { "projectId", "displayName", "root" }, "result": <原结果> }`；`result` 为 `VersionNode[]`。如需某版本内容，再用历史取内容能力回取。

## 注意

- 窗口内多工程时省略 `project` 会返回 `AMBIGUOUS` 并附候选；先调用 `workspaceInfo` 获取候选，再显式指定。
