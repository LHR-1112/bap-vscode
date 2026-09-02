# debugClass

把单个类放到云端运行（`startDebugJava`），行级 trace 输出到「BAP 调试」通道。

## 参数

| 参数 | 类型 | 说明 | 必需 |
|------|------|------|------|
| `fullClass` | string | 点分全类名 | 是 |
| `code` | string | 该类当前源码 | 是 |

## 示例

```json
{ "name": "debugClass", "arguments": { "fullClass": "cell.demo.Main", "code": "..." } }
```

## 返回

`{ status, isError, result, resultText, traceCount }`。

## 注意

- 运行 trace 在独立输出通道，结果以 `resultText` / `result` 为主。
- `isError=true` 表示运行异常，把 `resultText` 反馈用户。
