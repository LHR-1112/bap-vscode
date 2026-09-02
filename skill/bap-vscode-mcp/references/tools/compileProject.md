# compileProject

本地编译整个工程（用 JDK `javac` 编译 `src/**` → `bin/`）。

## 参数

| 参数 | 类型 | 说明 | 必需 |
|------|------|------|------|
| `clean` | boolean | 编译前清理 | 否 |

## 示例

```json
{ "name": "compileProject", "arguments": { "clean": true } }
```

## 返回

`{ success, sourceFiles, resourceFiles, compilerOutput }`。`success=false` 时读取 `compilerOutput` 定位错误。

## 注意

- 本地编译不连服务器，速度较快。
- 失败时把 `compilerOutput` 反馈给用户，不要吞掉。
