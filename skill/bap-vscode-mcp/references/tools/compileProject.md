# compileProject

本地编译整个工程（用 JDK `javac` 编译 `src/**` → `bin/`）。

## 参数

| 参数 | 类型 | 说明 | 必需 |
|------|------|------|------|
| `project` | string | 目标工程：projectId 精确 → projectUuid（忽略大小写）→ displayName 精确 → displayName（忽略大小写）；可用 `workspaceInfo` 查询 | 否（单工程可省略；多工程必填） |
| `clean` | boolean | 编译前清理 | 否 |

## 示例

```json
{ "name": "compileProject", "arguments": { "project": "gpf_demo", "clean": true } }
```

## 返回

结果包为 `{ "project": { "projectId", "displayName", "root" }, "result": <原结果> }`；`result` 为 `{ success, sourceFiles, resourceFiles, compilerOutput }`。`success=false` 时读取 `compilerOutput` 定位错误。

## 注意

- 本地编译不连服务器，速度较快。
- 失败时把 `compilerOutput` 反馈给用户，不要吞掉。
- 窗口内多工程时省略 `project` 会返回 `AMBIGUOUS` 并附候选；先调用 `workspaceInfo` 获取候选，再显式指定。
