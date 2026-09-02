# compileFile

云端编译单个 Java 类（`compileSingleCode`），返回诊断列表。

## 参数

| 参数 | 类型 | 说明 | 必需 |
|------|------|------|------|
| `fullClass` | string | 点分全类名，如 `cell.demo.Test` | 是 |
| `code` | string | 该文件当前内容（源码） | 是 |

## 示例

```json
{ "name": "compileFile", "arguments": { "fullClass": "cell.demo.Test", "code": "package cell.demo; public class Test {}" } }
```

## 返回

诊断数组 `LvProblem[]`：`isError` / `isWarn`、`line`、`message` 等。有 error 则编译未过，把诊断反馈给用户。

## 注意

- `fullClass` 与 `code` 必须同时提供；`code` 用本地当前内容。
- 诊断的 `line` 为 1-based。
