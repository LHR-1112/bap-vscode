# updateAll

更新全部变更：从云端取最新覆盖本地，删除本地新增文件，即「全部回退到云端」。

## 参数

| 参数 | 类型 | 说明 | 必需 |
|------|------|------|------|
| `project` | string | 目标工程：projectId 精确 → projectUuid（忽略大小写）→ displayName 精确 → displayName（忽略大小写）；可用 `workspaceInfo` 查询 | 否（单工程可省略；多工程必填） |

## 示例

```json
{ "name": "updateAll", "arguments": { "project": "gpf_demo" } }
```

## 返回

结果包为 `{ "project": { "projectId", "displayName", "root" }, "result": <原结果> }`；`result` 为更新完成信息。

## 注意

- 会覆盖本地所有改动，不可逆；执行前让用户确认。
- `updateAll` / `updateFile` / `updateGroup` 语义一致：都是回退到云端。
- 窗口内多工程时省略 `project` 会返回 `AMBIGUOUS` 并附候选；先调用 `workspaceInfo` 获取候选，再显式指定。
