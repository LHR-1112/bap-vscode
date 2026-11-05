# fetchCurrent

获取云端当前某个文件的内容（"云端当前代码"）。

## 参数

| 参数 | 类型 | 说明 | 必需 |
|------|------|------|------|
| `project` | string | 目标工程：projectId 精确 → projectUuid（忽略大小写）→ displayName 精确 → displayName（忽略大小写）；可用 `workspaceInfo` 查询 | 否（单工程可省略；多工程必填） |
| `fullClass` | string | 点分全类名（Java 文件），如 `cell.demo.Test` | 与 `path` 二选一 |
| `path` | string | 资源文件相对 `src/res/` 的路径 | 与 `fullClass` 二选一 |

## 示例

```json
{ "name": "fetchCurrent", "arguments": { "project": "gpf_demo", "fullClass": "cell.demo.Test" } }
```

```json
{ "name": "fetchCurrent", "arguments": { "project": "gpf_demo", "path": "conf/app.properties" } }
```

## 返回

结果包为 `{ "project": { "projectId", "displayName", "root" }, "result": <原结果> }`；`result` 为云端文件内容（Java 源码或资源 base64/原文）。

## 注意

- 取"云端当前代码"只用 `fetchCurrent`；`history` 是历史版本，不是当前。
- 与本地代码比较差异时，以本地文件为准、用 `fetchCurrent` 作参照。
- 窗口内多工程时省略 `project` 会返回 `AMBIGUOUS` 并附候选；先调用 `workspaceInfo` 获取候选，再显式指定。
