# commitFile

提交单个文件到云端。

## 参数

| 参数 | 类型 | 说明 | 必需 |
|------|------|------|------|
| `fullClass` | string | Java 文件点分全类名 | 与 `path` 二选一 |
| `path` | string | 资源文件相对 `src/res/` 的路径 | 与 `fullClass` 二选一 |
| `comment` | string | 提交说明 | 否 |

## 示例

```json
{ "name": "commitFile", "arguments": { "fullClass": "cell.demo.Test", "comment": "改修复" } }
```

## 返回

提交结果摘要。

## 注意

- 只提交这一个文件（而非全部）；提交前应让用户确认。
