# workspaceInfo

只读的工作区 / 后端工程概览：列出 workspace folders、已发现的后端工程、MCP 当前模式与可用工具。多工程时先用它获取 `project` 参数的可用值；引导模式下用它确认自举状态。

## 参数

无。

## 示例

```json
{ "name": "workspaceInfo", "arguments": {} }
```

## 返回

工作区级工具，返回原始结果（**不包** `{ project, result }` envelope）。结构如下：

```json
{
  "schemaVersion": 1,
  "workspaceFolders": [
    { "name": "oa", "path": "/work/oa", "scheme": "file", "vf": true }
  ],
  "vfRoots": ["/work/oa"],
  "projects": [
    {
      "projectId": "oa-a1b2c3d4:backend/gpf_demo",
      "displayName": "gpf_demo",
      "root": "/work/oa/backend/gpf_demo",
      "workspaceFolder": "/work/oa",
      "relativePath": "backend/gpf_demo",
      "projectUuid": "<uuid>",
      "serverUri": "ws://host:8090",
      "registered": true,
      "peerProjectIds": []
    }
  ],
  "mcp": {
    "mode": "full",
    "tools": ["workspaceInfo", "refresh", "commit"],
    "liveProjectCount": 1,
    "registeredProjectCount": 1,
    "reloadRequired": false
  }
}
```

（示例中 `mcp.tools` 仅截取前几项，实际按模式返回完整列表。）

字段说明：

| 字段 | 类型 | 说明 |
|------|------|------|
| `schemaVersion` | number | 结构版本，当前为 `1` |
| `workspaceFolders` | array | 窗口内的 workspace folders；每项含 `name`（显示名）、`path`（绝对路径）、`scheme`（通常 `file`）、`vf`（是否为 VotaForge 根） |
| `vfRoots` | string[] | 其中属于 VotaForge 根的工作区目录绝对路径 |
| `projects` | array | 已发现的后端工程（含 `.develop`），见下表 |
| `mcp.mode` | string | `full`（完整工具集）或 `bootstrap`（引导模式）；按调用时窗口状态推断，并优先采用调用方 MCP 进程实际生效的模式 |
| `mcp.tools` | string[] | 当前模式下可用的工具名 |
| `mcp.liveProjectCount` | number | 实时扫描到的后端工程数 |
| `mcp.registeredProjectCount` | number | 激活期注册表已注册的工程数 |
| `mcp.reloadRequired` | boolean | 有工程尚未注册 / 已注册工程已消失，或调用方 MCP 进程生效模式与当前窗口推断不一致时为 `true`；需重载窗口才能同步 SCM 与工具作用域 |

`projects[]` 字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `projectId` | string | 稳定主键，形如 `<workspace slug>-<hash>:<相对路径>`；`project` 参数首选值 |
| `displayName` | string | 唯一展示名；同名工程会追加 workspace / 相对路径消歧 |
| `root` | string | 工程根绝对路径 |
| `workspaceFolder` | string | 所属 workspace folder 的绝对路径 |
| `relativePath` | string | 相对所属 workspace folder 的路径；工程根即 folder 时为 `.` |
| `projectUuid` | string? | 云端工程 uuid（`.develop` 可解析时才有） |
| `serverUri` | string? | 云端 ws 地址（**已去掉 userinfo**，不含账号密码） |
| `registered` | boolean | 激活期注册表是否已包含该工程；`false` 表示需重载窗口后才能操作 |
| `duplicateProjectUuid` | string? | 同一云端工程被检出多份时，值为该 `projectUuid` |
| `peerProjectIds` | string[] | 同一云端工程的其他检出 `projectId` |

## 用途

- **多工程选 `project`**：`projects.length > 1` 时，从 `projects[].projectId` / `displayName` / `projectUuid` 中取值，显式传给工程级工具。优先用 `projectId`（最稳定）。
- **判断引导模式**：`mcp.mode === "bootstrap"`（或 `mcp.tools` 只含三个工作区级工具）时，先 `listProjects` / `downloadProject` 自举，不要调用工程级工具。
- **判断是否需要重载**：`mcp.reloadRequired === true` 时，提示用户重载窗口（若工程还不在工作区，先加入工作区），否则 MCP 工具作用域与 SCM 可能仍按旧工程集合运行。
- **取云端引用**：`serverUri` 只用于确认目标服务器；调用 `listProjects` 时要么省略全部 `uri/user/pwd` 复用已注册工程的连接，要么三者同时提供。`projectUuid` 可作为 `downloadProject` / `redirect` 的目标工程标识，这两个工具的 `uri/user/pwd` 必须显式提供。

## 注意

- 只读工具，不修改本地或云端。
- **绝不返回 `pwd` / `user`**；`serverUri` 已去掉 userinfo。不要把工具输出中的连接信息回显为账号密码。
- `projectId` 的哈希段由 workspace folder **真实路径**计算（sha1 前 8 位），相对路径以 `:` 后缀明文拼接；移动/重命名 workspace folder 后哈希可能变化。
- `registered=false` 或 `reloadRequired=true` 时，工程可能未被激活期注册表收录，或已从工作区移除；此时先引导用户重载窗口。
