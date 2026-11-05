# updateFile

更新单个文件：从云端拉取最新版覆盖本地（新增文件删除本地），即「回退到云端」。

## 参数

| 参数 | 类型 | 说明 | 必需 |
|------|------|------|------|
| `project` | string | 目标工程：projectId 精确 → projectUuid（忽略大小写）→ displayName 精确 → displayName（忽略大小写）；可用 `workspaceInfo` 查询 | 否（单工程可省略；多工程必填） |
| `fullClass` | string | Java 文件点分全类名 | 与 `path` 二选一 |
| `path` | string | 资源文件相对 `src/res/` 的路径 | 与 `fullClass` 二选一 |

## 示例

```json
{ "name": "updateFile", "arguments": { "project": "gpf_demo", "fullClass": "cell.demo.Test" } }
```

## 返回

结果包为 `{ "project": { "projectId", "displayName", "root" }, "result": <原结果> }`；`result` 为更新完成信息。

## 注意

- 该操作会**覆盖本地改动**（本地 MODIFIED → 云端版；本地新增 → 删除），执行前让用户确认。
- 窗口内多工程时省略 `project` 会返回 `AMBIGUOUS` 并附候选；先调用 `workspaceInfo` 获取候选，再显式指定。
