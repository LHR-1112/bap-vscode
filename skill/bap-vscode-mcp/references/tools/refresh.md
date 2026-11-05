# refresh

对比本地与云端，重新计算变更列表。

## 参数

| 参数 | 类型 | 说明 | 必需 |
|------|------|------|------|
| `project` | string | 目标工程：projectId 精确 → projectUuid（忽略大小写）→ displayName 精确 → displayName（忽略大小写）；可用 `workspaceInfo` 查询 | 否（单工程可省略；多工程必填） |

## 示例

```json
{ "name": "refresh", "arguments": { "project": "gpf_demo" } }
```

## 返回

结果包为 `{ "project": { "projectId", "displayName", "root" }, "result": <原结果> }`；`result` 为非 NORMAL 变更数（按分组）。AI 先据此确定本地与云端差异，再决定提交 / 更新。

## 注意

- `refresh` 是只读计算，不改动本地或云端文件；确认差异后再做后续动作。
- 窗口内多工程时省略 `project` 会返回 `AMBIGUOUS` 并附候选；先调用 `workspaceInfo` 获取候选，再显式指定。
