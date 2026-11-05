# compileFile

云端编译单个 Java 类（`compileSingleCode`），返回诊断列表。

## 参数

| 参数 | 类型 | 说明 | 必需 |
|------|------|------|------|
| `project` | string | 目标工程：projectId 精确 → projectUuid（忽略大小写）→ displayName 精确 → displayName（忽略大小写）；可用 `workspaceInfo` 查询 | 否（单工程可省略；多工程必填） |
| `fullClass` | string | 点分全类名，如 `cell.demo.Test` | 是 |
| `code` | string | 该文件当前内容（源码） | 是 |

## 示例

```json
{ "name": "compileFile", "arguments": { "project": "gpf_demo", "fullClass": "cell.demo.Test", "code": "package cell.demo; public class Test {}" } }
```

## 返回

结果包为 `{ "project": { "projectId", "displayName", "root" }, "result": <原结果> }`；`result` 为诊断数组 `LvProblem[]`：`isError` / `isWarn`、`line`、`message` 等。有 error 则编译未过，把诊断反馈给用户。

## 注意

- `fullClass` 与 `code` 必须同时提供；`code` 用本地当前内容。
- 诊断的 `line` 为 1-based。
- 窗口内多工程时省略 `project` 会返回 `AMBIGUOUS` 并附候选；先调用 `workspaceInfo` 获取候选，再显式指定。
