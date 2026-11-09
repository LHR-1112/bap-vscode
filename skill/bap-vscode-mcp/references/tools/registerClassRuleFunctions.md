# registerClassRuleFunctions

把指定 Java 类的全部方法注册为 BAP 规则函数（云端写操作）。

## 参数

| 参数 | 类型 | 说明 | 必需 |
|------|------|------|------|
| `project` | string | 目标工程：projectId 精确 → projectUuid（忽略大小写）→ displayName 精确 → displayName（忽略大小写）；可用 `workspaceInfo` 查询 | 否（单工程可省略；多工程必填） |
| `fullClass` | string | Java 点分全类名（如 `com.example.demo.RuleExpr`） | 是 |
| `domainCode` | string | 业务域 code；缺省时依次使用 VotaForge active profile 的 `busDomainCode`、`.develop` 的 `MetadataDomain` | 否 |

## 示例

```json
{
  "name": "registerClassRuleFunctions",
  "arguments": { "project": "gpf_demo", "fullClass": "com.example.demo.RuleExpr" }
}
```

## 返回

结果包为 `{ "project": { "projectId", "displayName", "root" }, "result": <原结果> }`；`result` 结构：

```json
{
  "domain": "GroupChat_Inst_17790942612666",
  "success": true,
  "count": 2,
  "functions": [{ "ruleCode": "GroupChat_Inst_..._hello", "invokeMethod": "hello", "codePath": "com.example.demo.RuleExpr" }]
}
```

`count` / `functions` 为服务端本次返回的注册结果；不同服务器版本可能返回空数组。

## 工作流

1. 先 `refresh` 并 `commit`，确保目标类已提交到云端（服务端按**云端代码**扫描）。
2. 确认目标方法带 `@MethodDeclare` 与 `@FuncDeclare` 注解。
3. 调用 `registerClassRuleFunctions`；缺省 `domainCode` 时按 VF → `.develop` 解析。
4. 若返回“缺少 domainCode”错误，错误消息会列出可用业务域，带 `domainCode` 重试。

## 注意

- **写操作**：会修改云端规则函数注册表；调用前向用户确认目标类与业务域。
- 未提交到云端的方法不会生效；本地未保存改动同理。
- 服务端对缺少 `@MethodDeclare` / `@FuncDeclare` 的方法返回 `success=false`，工具会把服务端业务消息作为错误抛出。
- 构造器、匿名类、同名重载按服务端扫描规则处理；类注册会尝试注册全部方法。
- 本工具不修改 `.develop` / `server-profiles.json`；业务域只读解析。
- 长耗时：注册超时 12 分钟，MCP IPC 放宽到 30 分钟；不要因等待时间较长而重复调用。
