# redirect

把当前工程重定向到另一台 BAP 服务器（改写 `.develop` 并断开重连，下次刷新用新配置）。

## 参数

| 参数 | 类型 | 说明 | 必需 |
|------|------|------|------|
| `uri` | string | 目标服务器 ws 地址 | 是 |
| `user` | string | 账号 | 是 |
| `pwd` | string | 密码 | 是 |
| `projectUuid` | string | 目标工程 ID | 是 |

## 示例

```json
{ "name": "redirect", "arguments": { "uri": "ws://127.0.0.1:8091", "user": "a", "pwd": "b", "projectUuid": "<uuid>" } }
```

## 返回

重定向完成；之后工具的连接信息以新 `.develop` 为准。

## 注意

- 会改写本地 `.develop` 并写入重定向历史，执行前让用户确认。
- `downloadProject` 是从零把工程拉到本地；`redirect` 是**已打开的工程**切换到另一服务器的连接。
