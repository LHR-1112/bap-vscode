# commit

提交本地变更到云端。

## 参数

| 参数 | 类型 | 说明 | 必需 |
|------|------|------|------|
| `project` | string | 目标工程：projectId 精确 → projectUuid（忽略大小写）→ displayName 精确 → displayName（忽略大小写）；可用 `workspaceInfo` 查询 | 否（单工程可省略；多工程必填） |
| `comment` | string | 提交说明 | 否（缺省空） |

## 示例

```json
{ "name": "commit", "arguments": { "project": "gpf_demo", "comment": "修复登录问题" } }
```

## 返回

结果包为 `{ "project": { "projectId", "displayName", "root" }, "result": <原结果> }`；`result` 为提交结果的摘要（提交的文件 / 包体信息）。

## 工作流

1. 先 `refresh` 确认变更符合预期。
2. 调用 `commit` 提交全部非 NORMAL 变更。

## 注意

- `commit` 提交的是本地相对云端的改动（新增/修改/删除），云端是基线。
- 提交前应让用户确认变更范围与说明。
- 窗口内多工程时省略 `project` 会返回 `AMBIGUOUS` 并附候选；先调用 `workspaceInfo` 获取候选，再显式指定。
