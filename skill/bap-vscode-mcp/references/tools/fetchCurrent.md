# fetchCurrent

获取云端当前某个文件的内容（"云端当前代码"）。

## 参数

| 参数 | 类型 | 说明 | 必需 |
|------|------|------|------|
| `fullClass` | string | 点分全类名（Java 文件），如 `cell.demo.Test` | 与 `path` 二选一 |
| `path` | string | 资源文件相对 `src/res/` 的路径 | 与 `fullClass` 二选一 |

## 示例

```json
{ "name": "fetchCurrent", "arguments": { "fullClass": "cell.demo.Test" } }
```

```json
{ "name": "fetchCurrent", "arguments": { "path": "conf/app.properties" } }
```

## 返回

云端文件内容（Java 源码或资源 base64/原文）。

## 注意

- 取"云端当前代码"只用 `fetchCurrent`；`history` 是历史版本，不是当前。
- 与本地代码比较差异时，以本地文件为准、用 `fetchCurrent` 作参照。
