# updateLibs

同步 `<工程>/lib` 到云端（服务端 md5 比对，增量更新，删除云端已无的本地 lib 包）。

## 参数

| 参数 | 类型 | 说明 | 必需 |
|------|------|------|------|
| `project` | string | 目标工程：projectId 精确 → projectUuid（忽略大小写）→ displayName 精确 → displayName（忽略大小写）；可用 `workspaceInfo` 查询 | 否（单工程可省略；多工程必填） |

## 示例

```json
{ "name": "updateLibs", "arguments": { "project": "gpf_demo" } }
```

## 返回

结果包为 `{ "project": { "projectId", "displayName", "root" }, "result": <原结果> }`；`result` 为 `{ updated, deleted }`。

## 注意

- 会改动本地 `lib/`，执行前让用户确认。
- 窗口内多工程时省略 `project` 会返回 `AMBIGUOUS` 并附候选；先调用 `workspaceInfo` 获取候选，再显式指定。
