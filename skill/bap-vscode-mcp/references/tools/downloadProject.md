# downloadProject

连接 BAP 服务器、下载整包并解压到工作区（写 `.develop` 与 `.vscode/settings.json`）。

## 参数

| 参数 | 类型 | 说明 | 必需 |
| --- | --- | --- | --- |
| `uri` | string | 服务器 ws 地址，如 `ws://host:port` | 是 |
| `user` | string | 账号 | 是 |
| `pwd` | string | 密码 | 是 |
| `projectUuid` | string | 要下载的工程 ID | 是 |
| `projectName` | string | 工程名；用于确定默认目录名（缺省时插件登录后按 uuid 反查） | 否 |
| `targetDir` | string | 相对工作区根的下载目录；必须位于工作区内 | 否 |

## 落点规则

- 基准目录是**第一个 workspace folder**；`targetDir` 按 `path.resolve(基准目录, targetDir)` 解析。
- **独立 BAP 工作区**（工作区根无 `votaforge.workspace.json` / `.votaforge/`）：不传 `targetDir` 时下载到工作区根（保持旧行为）。
- **VotaForge 容器工作区**：不传 `targetDir` 时下载到 `<工作区根>/<projectName>`；不允许落到工作区根，避免污染 vf 根。
- 目标必须满足，否则调用返回错误：
  - 位于工作区内，且解析后不是工作区根（vf 模式）；
  - 不是已存在的普通文件；
  - 目标自身不能已含 `.develop`（即已是一个后端工程）；
  - 不能包含任一已有后端工程根，也不能位于任一已有后端工程内。
- 目标目录已存在且非空时 **MCP 直接拒绝**（不覆盖）；如需重新下载，先清理目录或换一个 `targetDir`。交互式下载会改为二次确认。

## 示例

```json
{
  "name": "downloadProject",
  "arguments": {
    "uri": "ws://127.0.0.1:8090",
    "user": "a",
    "pwd": "b",
    "projectUuid": "<uuid>",
    "projectName": "gpf_demo"
  }
}
```

## 返回

成功返回下载目标目录的绝对路径（如 `已下载到 /work/oa/backend/gpf_demo`）；失败返回 `{ "error": "..." }`。

## 注意

- 这是**建立连接 + 落地工程**的入口（连接、登录、下载、写配置一步到位）。连接信息会写入工程 `.develop`。
- 首次用某个服务器时先走本工具，把工程拉到本地；之后多数工具复用 `.develop` 里的连接。
- vf 工作区下载完成后，需要把新目录加入工作区并重载窗口，插件才会扫描到新的 `.develop` 并注册 SCM/MCP 工具。
- 下载为长耗时（流式 + 解压），已放宽超时。
