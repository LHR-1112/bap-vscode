# listProjects

登录后，列出当前登录环境里可操作的项目列表。

## 参数

| 参数 | 类型 | 说明 | 必需 |
|------|------|------|------|
| `uri` | string | 服务器 ws 地址（缺省用当前连接） | 否 |
| `user` | string | 账号（缺省用当前连接） | 否 |
| `pwd` | string | 密码（缺省用当前连接） | 否 |

## 示例

```json
{ "name": "listProjects", "arguments": {} }
```

## 返回

`CJavaProjectDto[]`（`uuid` / `name` 等）。

## 注意

- 用于确认当前环境有哪些工程、拿 `projectUuid` 做下一步（下载/重定向）。
- 需要已登录；连接信息回退到 `.develop`。
