# updateFile

更新单个文件：从云端拉取最新版覆盖本地（新增文件删除本地），即「回退到云端」。

## 参数

| 参数 | 类型 | 说明 | 必需 |
|------|------|------|------|
| `fullClass` | string | Java 文件点分全类名 | 与 `path` 二选一 |
| `path` | string | 资源文件相对 `src/res/` 的路径 | 与 `fullClass` 二选一 |

## 示例

```json
{ "name": "updateFile", "arguments": { "fullClass": "cell.demo.Test" } }
```

## 返回

更新完成信息。

## 注意

- 该操作会**覆盖本地改动**（本地 MODIFIED → 云端版；本地新增 → 删除），执行前让用户确认。
