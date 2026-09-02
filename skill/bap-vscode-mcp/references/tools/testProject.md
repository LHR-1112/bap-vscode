# testProject

先本地编译、再运行 JUnit 单元测试。

## 参数

| 参数 | 类型 | 说明 | 必需 |
|------|------|------|------|
| `selectClass` | string | 只跑指定类 | 否（缺省跑全部） |

## 示例

```json
{ "name": "testProject", "arguments": { "selectClass": "cell.demo.Test" } }
```

## 返回

`{ total, passed, failed, skip, exitCode }`。有 failed 则把失败数反馈用户。

## 注意

- 本工具会先 `javac` 编译再跑测试，耗时较长。
- 单测通过的判定以 `failed === 0` 为准。
