# testProject

先本地编译、再运行 JUnit 单元测试。

## 参数

| 参数 | 类型 | 说明 | 必需 |
|------|------|------|------|
| `project` | string | 目标工程：projectId 精确 → projectUuid（忽略大小写）→ displayName 精确 → displayName（忽略大小写）；可用 `workspaceInfo` 查询 | 否（单工程可省略；多工程必填） |
| `selectClass` | string | 只跑指定类 | 否（缺省跑全部） |

## 示例

```json
{ "name": "testProject", "arguments": { "project": "gpf_demo", "selectClass": "cell.demo.Test" } }
```

## 返回

结果包为 `{ "project": { "projectId", "displayName", "root" }, "result": <原结果> }`；`result` 为 `{ total, passed, failed, skip, exitCode }`。有 failed 则把失败数反馈用户。

## 注意

- 本工具会先 `javac` 编译再跑测试，耗时较长。
- 单测通过的判定以 `failed === 0` 为准。
- 窗口内多工程时省略 `project` 会返回 `AMBIGUOUS` 并附候选；先调用 `workspaceInfo` 获取候选，再显式指定。
