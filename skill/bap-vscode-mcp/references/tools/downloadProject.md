# downloadProject

连接 BAP 服务器、选择并下载整包到当前工作区根（并写 `.develop` 与 `.vscode/settings.json`）。

## 参数

| 参数 | 类型 | 说明 | 必需 |
|------|------|------|------|
| `uri` | string | 服务器 ws 地址，如 `ws://host:port` | 是 |
| `user` | string | 账号 | 是 |
| `pwd` | string | 密码 | 是 |
| `projectUuid` | string | 要下载的工程 ID | 是 |

## 示例

```json
{ "name": "downloadProject", "arguments": { "uri": "ws://127.0.0.1:8090", "user": "a", "pwd": "b", "projectUuid": "<uuid>" } }
```

## 返回

下载完成的目录。下载后工作区根有 `.develop`，可用于后续 `refresh`/`commit` 等工具。

## 注意

- 这是**建立连接 + 落地工程**的入口（连接、登录、选择工程、下载、写配置一步到位）。连接信息会写入工程 `.develop`。
- 首次用某个服务器时先走本工具，把工程拉到本地；之后多数工具复用 `.develop` 里的连接。
- 下载为长耗时（流式 + 解压），已放宽超时。
