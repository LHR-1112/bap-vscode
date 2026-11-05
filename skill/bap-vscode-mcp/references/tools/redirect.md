# redirect

把目标工程重定向到另一台 BAP 服务器（改写 `.develop` 并断开重连，下次刷新用新配置）。

## 参数

| 参数 | 类型 | 说明 | 必需 |
|------|------|------|------|
| `project` | string | 要重定向的本地工程：projectId 精确 → projectUuid（忽略大小写）→ displayName 精确 → displayName（忽略大小写）；可用 `workspaceInfo` 查询 | 否（单工程可省略；多工程必填） |
| `uri` | string | 目标服务器 ws 地址 | 是 |
| `user` | string | 账号 | 是 |
| `pwd` | string | 密码 | 是 |
| `projectUuid` | string | 目标云端工程 ID | 是 |
| `projectName` | string | 目标工程名（可选；写入重定向历史的展示名，也用于日志） | 否 |

## 示例

```json
{ "name": "redirect", "arguments": { "project": "gpf_demo", "uri": "ws://127.0.0.1:8091", "user": "a", "pwd": "b", "projectUuid": "<uuid>" } }
```

## 返回

结果包为 `{ "project": { "projectId", "displayName", "root" }, "result": <原结果> }`；`result` 为重定向完成信息。之后该工程的连接信息以新 `.develop` 为准。

## 注意

- `project` 选择的是**本地要重定向的工程**；`projectUuid` 是目标服务器上的云端工程，二者不同。
- 会改写本地 `.develop` 并写入重定向历史，执行前让用户确认。
- `downloadProject` 是从零把工程拉到本地；`redirect` 是**已打开的工程**切换到另一服务器的连接。
- 窗口内多工程时省略 `project` 会返回 `AMBIGUOUS` 并附候选；先调用 `workspaceInfo` 获取候选，再显式指定。
