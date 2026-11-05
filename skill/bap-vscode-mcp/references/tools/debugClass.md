# debugClass

把单个类放到云端运行（`startDebugJava`），行级 trace 输出到「BAP 调试」通道。

## 参数

| 参数 | 类型 | 说明 | 必需 |
|------|------|------|------|
| `project` | string | 目标工程：projectId 精确 → projectUuid（忽略大小写）→ displayName 精确 → displayName（忽略大小写）；可用 `workspaceInfo` 查询 | 否（单工程可省略；多工程必填） |
| `fullClass` | string | 点分全类名 | 是 |
| `code` | string | 该类当前源码 | 是 |

## 示例

```json
{ "name": "debugClass", "arguments": { "project": "gpf_demo", "fullClass": "cell.demo.Main", "code": "..." } }
```

## 返回

结果包为 `{ "project": { "projectId", "displayName", "root" }, "result": <原结果> }`；`result` 为 `{ status, isError, result, resultText, traceCount }`。

## 注意

- 运行 trace 在独立输出通道，结果以 `resultText` / `result` 为主。
- `isError=true` 表示运行异常，把 `resultText` 反馈用户。
- 窗口内多工程时省略 `project` 会返回 `AMBIGUOUS` 并附候选；先调用 `workspaceInfo` 获取候选，再显式指定。
