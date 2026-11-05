# listProjects

登录后，列出当前登录环境里可操作的项目列表。

**工作区级工具**，返回原始结果（不包 `{ project, result }` envelope）。

## 参数

| 参数 | 类型 | 说明 | 必需 |
|------|------|------|------|
| `uri` | string | 服务器 ws 地址（有后端工程时缺省复用其连接） | 否（无 `.develop` 时必填） |
| `user` | string | 账号（有后端工程时缺省复用其连接） | 否（无 `.develop` 时必填） |
| `pwd` | string | 密码（有后端工程时缺省复用其连接） | 否（无 `.develop` 时必填） |

## 示例

有后端工程、复用连接：

```json
{ "name": "listProjects", "arguments": {} }
```

引导模式（无 `.develop`）直连服务器：

```json
{ "name": "listProjects", "arguments": { "uri": "ws://127.0.0.1:8090", "user": "a", "pwd": "b" } }
```

## 返回

`CJavaProjectDto[]`（`uuid` / `name` 等），原始数组，不包 envelope。

## 注意

- 用于确认当前环境有哪些工程、拿 `projectUuid` 做下一步（`downloadProject` / `redirect`）。
- **有后端工程时**可整体省略 `uri` / `user` / `pwd`，复用已注册工程的连接；多工程且无法确定用哪个连接时，显式提供三者直连，或先打开目标工程的文件后重试。
- **引导模式**（窗口内没有 `.develop`）必须**同时**提供 `uri` / `user` / `pwd` 直连服务器；只给部分字段会失败（不会用 `.develop` 补齐），完全不给会返回 `NO_PROJECTS` 并提示先 `downloadProject` 或提供凭据。
- 本工具不接收 `project` 参数；它列出的是服务器上的云端工程，不是窗口内的本地工程。
