# fileHistory

查询某个文件的历史版本。

## 参数

| 参数 | 类型 | 说明 | 必需 |
|------|------|------|------|
| `remoteKey` | string | 资源用相对路径；Java 用点分 fullClass | 是 |

## 示例

```json
{ "name": "fileHistory", "arguments": { "remoteKey": "cell.demo.Test" } }
```

## 返回

`VersionNode[]`。如需某版本内容，再用历史取内容能力回取。
