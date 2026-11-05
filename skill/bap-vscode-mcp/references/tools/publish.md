# publish

发布插件（全量）到所有用户。

## 参数

| 参数 | 类型 | 说明 | 必需 |
|------|------|------|------|
| `project` | string | 目标工程：projectId 精确 → projectUuid（忽略大小写）→ displayName 精确 → displayName（忽略大小写）；可用 `workspaceInfo` 查询 | 否（单工程可省略；多工程必填） |
| `ignoreErrors` | boolean | 编译有错是否仍发布 | 否（缺省 false：有错则失败） |

## 示例

```json
{ "name": "publish", "arguments": { "project": "gpf_demo" } }
```

## 返回

结果包为 `{ "project": { "projectId", "displayName", "root" }, "result": <原结果> }`；`result` 为成功/失败信息，失败时含错误原因（发布/全量导出为长耗时，已放宽超时，等待更久）。

## 注意

- `publish` 是不可逆、面向所有用户的操作，必须先让用户明确确认。
- 默认 `ignoreErrors=false`：若编译报错会失败并返回原因，不会静默发布。
- 窗口内多工程时省略 `project` 会返回 `AMBIGUOUS` 并附候选；先调用 `workspaceInfo` 获取候选，再显式指定。
