# BAP IDE 规则函数注册（MetadataDomain）移植方案 V1.0

> 状态：待实施（方案已完成可行性核验与对抗式复核）
> 日期：2026-11-09
> 参考实现：`/Users/lihongrui/IdeaProjects/PluginDemo`（IDEA 版插件）
> 适用仓库：BAP IDE（VS Code）插件（VotaForge_BAP 后端工程插件）
> 实施纪律：Java 序列化必须与服务端严格一致；代码改动经确认后实施；只 commit、不 push。

**仓库根**：仓库根目录（本文档中的仓库内路径均相对仓库根）
**参考实现**：`/Users/lihongrui/IdeaProjects/PluginDemo`
**结论**：可行，无设计级阻塞。IDEA 的 `RegisterClassRuleFunctionsAction` / `RegisterMethodRuleFunctionAction` 依赖的 `cell.panelxpro.metadata.IPanelMetadataService` 是独立 CRPC 服务；本插件 Java 桥已有的 `com.leavay.nio.crpc` runtime 完全够用，不需要新增 npm 依赖，也不需要改 VotaForge 协议。真正的前置条件是三件事：Java 桥新增 metadata 通道、DTO 序列化与服务器严格一致、`.develop` 的 `MetadataDomain` 闭环。三者落地后，UI 与 MCP 可共用同一套 SDK。

---

## 1. 结论、范围与工作量

### 1.1 可行性判断

| 问题 | 结论 | 依据 |
|---|---|---|
| 能否在 VS Code 插件里调用 `IPanelMetadataService` | 能 | `CRpcClientWrapper` / `CRpcAdapter` 在 `packages/java-bridge/lib/tcmcat-srvcommon.jar`；`CellIntf` / `Cells` 在 `tcmcat-msi_cmn.jar`；平台 jar 中没有 `cell/panelxpro`、`panelxpro/metadata`、`octo/cm/ruleengine`，不会类冲突 |
| 是否需要重新登录 | 否 | `MetadataRpcClient` 只 `getIntf(true)`；`getAdapter()` 返回 `CRpcAdapter.getInstance()`，复用 `BapRpcClient` 登录后写入的 `CTX_SESSION` 全局上下文 |
| 是否需要新端口/新协议 | 否 | 仍走同一条 WebSocket、同一个 `CRpcAdapter` 单例；只是多一个服务代理 |
| 是否有 Java 8 编译坑 | 有，已定位 | 匿名子类不能用钻石 `new CRpcClientWrapper<>(...)`；必须显式 `new CRpcClientWrapper<IPanelMetadataService>(...)`。`CRpcClientWrapper` 是抽象类，**必须实现 `getAdapter()`**（常见实现容易漏掉这一条） |
| 是否需要 PSI | 否，但不能 100% 复刻 IDEA | VS Code 无 PSI；用 `package` 声明 + `vscode.executeDocumentSymbolProvider` + 光标处单词/InputBox 兜底，覆盖方法/类注册的常用场景 |
| 服务端是否一定可用 | 未知（唯一外部依赖） | 需要真实服务器验证 `listDomains()`；本地只能验证编译、序列化和协议 |

### 1.2 新增/修改文件总览

**Java 桥（新增 10，修改 2）**

| 文件 | 动作 | 内容 |
|---|---|---|
| `packages/java-bridge/src/main/java/cell/panelxpro/metadata/IPanelMetadataService.java` | 新增 | 从 IDEA 逐字复制接口（含静态 `get()`，但桥内禁止调用） |
| `packages/java-bridge/src/main/java/panelxpro/metadata/dto/DomainInfoDto.java` | 新增 | `code/name/description`，`serialVersionUID=1L` |
| `packages/java-bridge/src/main/java/panelxpro/metadata/dto/DtoGenerateResultDto.java` | 新增 | `List<DtoFileEntry> files`；嵌套类 `fileName/packageName/sourceCode` |
| `packages/java-bridge/src/main/java/panelxpro/metadata/dto/ListFunctionsResult.java` | 新增 | `functions/functionNames/errorFunctions/totalCount` |
| `packages/java-bridge/src/main/java/panelxpro/metadata/dto/PanelFieldDto.java` | 新增 | `code/name/dataType/description/required/nestingFields/assocModelId` |
| `packages/java-bridge/src/main/java/panelxpro/metadata/dto/PanelInfoDto.java` | 新增 | `panelCode/panelName/mainModelId/nestingModelId` |
| `packages/java-bridge/src/main/java/panelxpro/metadata/dto/RegisterFunctionResult.java` | 新增 | `boolean success / String message / List<RuleFunctionMeta> functions` |
| `packages/java-bridge/src/main/java/octo/cm/ruleengine/RuleFunctionMeta.java` | 新增 | `ruleCode/nameSpace/name/tag/description/codePath/invokeMethod/inputParamMetas/returnType/useCase/customLabels` |
| `packages/java-bridge/src/main/java/octo/cm/ruleengine/InputParamMeta.java` | 新增 | `name/type/desc/nullable` |
| `packages/java-bridge/src/main/java/com/bap/dev/service/MetadataRpcClient.java` | 新增 | 第二个 `CRpcClientWrapper<IPanelMetadataService>`，不登录 |
| `packages/java-bridge/src/main/java/com/bap/dev/BridgeMain.java` | 修改 | `metadata` 顶层方法、生命周期、`writeErr` JSON 转义、`download` 可选域参数与 XML 转义 |
| `packages/java-bridge/scripts/build.sh` | 修改 | 递归编译全部 Java、清理 `out/`、UTF-8、argfile |

**RPC 包（修改 2）**

| 文件 | 动作 | 内容 |
|---|---|---|
| `packages/rpc/src/types.ts` | 修改 | `BridgeMethod` 补 `'download'`、`'metadata'` |
| `packages/rpc/src/index.ts` | 修改 | 可选：`metadataConnect/metadataCall/metadataDisconnect/metadataPing` 门面方法 |

**SDK（新增 1，修改 5）**

| 文件 | 动作 | 内容 |
|---|---|---|
| `packages/sdk/src/types.ts` | 修改 | `DevelopConfig.metadataDomain?`；metadata DTO 类型 |
| `packages/sdk/src/develop.ts` | 修改 | 解析 `MetadataDomain`；新增 `updateDevelopMetadataDomain`；`writeDevelop` 改为原地补丁 |
| `packages/sdk/src/metadata.ts` | 新增 | metadata 请求封装、超时、错误映射、DTO 校验 |
| `packages/sdk/src/services.ts` | 修改 | `BapSdk.metadata` 命名空间；`ensureMetadataConnected`；redirect/disconnect 清理 |
| `packages/sdk/src/index.ts` | 修改 | 导出 metadata 类型与函数 |
| `packages/sdk/src/download.ts` | 修改 | 可选 `metadataDomain` 参数，传给 Java `download` |

**宿主与扩展（新增 2，修改 4～6）**

| 文件 | 动作 | 内容 |
|---|---|---|
| `packages/vscode-host/src/projects/server-profiles.ts` | 新增 | 只读 `readActiveBusDomainCode(vfRoot)`，仅作 QuickPick 提示 |
| `packages/vscode-host/src/java-source.ts` | 新增 | 纯函数：包名、全类名、方法名校验、嵌套类拼接（可单测） |
| `packages/vscode-host/src/commands/command-router.ts` | 修改 | 3 个命令、域选择、编辑器/方法解析、`ctx.runWrite`/`runExclusive` |
| `packages/vscode-host/src/mcp/tools.ts` | 修改（P1） | 2 个 MCP 工具目录项 |
| `packages/vscode-host/src/mcp/tool-exec.ts` | 修改（P1） | 2 个工具执行分支 + 域解析 |
| `packages/vscode-host/src/agent/agent-instructions.ts` | 修改 | 工具数量与两条工具说明 |
| `apps/vscode/package.json` | 修改 | 3 个命令、菜单、可选 SCM 标题 |
| `apps/vscode/src/extension.ts` | 修改 | classpath 顺序；下载完成后提示切换域 |

**测试与文档**

| 文件 | 动作 |
|---|---|
| `packages/sdk/test/develop.test.ts` | 修改：MetadataDomain 解析/回写 |
| `packages/sdk/test/metadata.test.ts` | 新增：协议、超时、错误、域解析 |
| `packages/vscode-host/test/server-profiles.test.ts` | 新增 |
| `packages/vscode-host/test/java-source.test.ts` | 新增 |
| `packages/vscode-host/test/mcp-tools.test.ts` | 修改：动态数量 + 新工具 |
| `packages/vscode-host/test/workspace-info.test.ts` | 修改：动态数量 |
| `packages/vscode-host/test/agent-instructions.test.ts` | 修改：动态数量 + 新工具名 |
| `docs/architecture/metadata-rule-functions.md` | 可选：从本文档拆分的架构说明（协议、域生命周期、限制、排障） |
| `README.md` | 修改：功能说明、工具数量 |
| `skill/bap-vscode-mcp/SKILL.md` | 修改：工具数量、适用范围 |
| `skill/bap-vscode-mcp/references/commands.md` | 修改：索引与数量 |
| `skill/bap-vscode-mcp/references/tools/registerClassRuleFunctions.md` | 新增（P1） |
| `skill/bap-vscode-mcp/references/tools/registerMethodRuleFunction.md` | 新增（P1） |
| `packages/sdk/scripts/metadata-smoke.ts` | 新增：真实服务器只读/受控写入冒烟 |

### 1.3 工作量粗估

| 阶段 | 内容 | 人日 |
|---|---|---|
| P0 | Java metadata 通道 + DTO + build；SDK `.develop`/metadata；宿主 3 个命令；单测；文档 | 3.0～4.5 |
| P1 | MCP 2 个工具；下载时域选择；SCM 标题菜单；技能文档 | 1.0～1.5 |
| 联调 | 真实服务器 `listDomains`、注册、DTO 版本差异排查 | 0.5～1.5 |
| **合计** | 不含 MCP 约 3～5 人日；含 MCP 约 4.5～7 人日 | |

代码量：Java 约 700～900 行（大部分是逐字复制的 DTO）；TS 约 900～1200 行（含测试）。

---

## 2. 总体设计

### 2.1 调用链

```text
VS Code 命令 / MCP tool
  → vscode-host（解析工程、选域、串行执行、身份校验）
    → @bap/sdk（metadata 命名空间、.develop 读写）
      → @bap/rpc（request('metadata', ...) / request('download', ...)）
        → Java BridgeMain（单进程、单线程、stdin/stdout JSON）
          → MetadataRpcClient（第二个 CRpcClientWrapper<IPanelMetadataService>）
            → 同一 CRpcAdapter 单例 / 同一 WebSocket / 同一 CTX_SESSION
              → BAP Server 的 panelxpro metadata 服务
```

关键点：

- 主客户端 `BapRpcClient`（`CJavaCenterIntf`）负责登录和会话；metadata 客户端**不登录**，只复用全局会话。
- 两个 wrapper 共存：主 wrapper 的 `_intf` 代理自带主 client；metadata wrapper 的代理自带同一 `CRpcAdapter`。metadata 的 `openService` 不会破坏主 wrapper 的代理。
- 所有 metadata 调用必须先完成主连接；Java 侧在 `metadata.connect` 时强制检查 `client.getUri()`。
- 所有注册写操作走 `ctx.runWrite`（身份校验 + 串行）；只读列表走 `ctx.runExclusive`；QuickPick 不放在队列内。

### 2.2 桥协议

在现有顶层方法之外增加一个 `metadata` 方法，params 第 0 位是操作码：

```json
{"id":1,"method":"metadata","params":["connect","ws://host:port","user","pwd"]}
{"id":2,"method":"metadata","params":["call","listDomains",[]]}
{"id":3,"method":"metadata","params":["call","listFunctions",["DOMAIN_CODE"]]}
{"id":4,"method":"metadata","params":["call","registerFunction",["DOMAIN_CODE","com.x.Foo","bar"]]}
{"id":5,"method":"metadata","params":["call","registerFunctions",["DOMAIN_CODE","com.x.Foo"]]}
{"id":6,"method":"metadata","params":["disconnect"]}
{"id":7,"method":"metadata","params":["ping"]}
```

`BridgeMethod` 当前缺少 `'download'`（`download.ts` 用类型断言绕过），本次一并补上：

```ts
// packages/rpc/src/types.ts
export type BridgeMethod = 'connect' | 'call' | 'download' | 'disconnect' | 'ping' | 'shutdown' | 'metadata';
```

### 2.3 超时矩阵

| 操作 | TS 侧超时 | Java `setTempTimeout` | 说明 |
|---|---|---|---|
| `metadata connect` | 180 s | 不设置（`openService` 自身默认） | 首次生成代理/探测服务 |
| `listDomains` | 120 s | 120 000 ms | 服务器可能查询元数据 |
| `listFunctions` | 120 s | 120 000 ms | 同上 |
| `registerFunction` | 12 min | 600 000 ms | 服务端扫描类/方法 |
| `registerFunctions` | 12 min | 600 000 ms | 扫描全部方法 |
| `metadata ping/disconnect` | 15 s / 10 s | 不设置 | |
| `download` | 30 min（现有） | 30 天（现有） | 不变 |

铁律：**TS 超时必须大于 Java 超时**，否则 TS 先报 TIMEOUT，Java 的真实错误被丢弃。`setTempTimeout` 是 ThreadLocal 且只对下一次非 ping RPC 生效，必须紧邻目标调用；参数校验、`getService()` 都要放在它之前。

### 2.4 错误模型

新增 SDK 错误码（`SdkError.code`）：

| code | 触发条件 | 用户提示方向 |
|---|---|---|
| `METADATA_UNAVAILABLE` | 旧桥 `unknown_method`、`request` 缺失、桥已关闭 | 重新 `npm run build` 并重装扩展 |
| `METADATA_SERVICE_UNAVAILABLE` | 服务端未暴露 `IPanelMetadataService` / 账号无权 | 确认服务器启用 panelxpro 元数据服务、账号权限 |
| `METADATA_RPC_FAILED` | 其它传输/远程异常 | 原样包含远端异常名与消息 |
| `METADATA_BAD_RESPONSE` | 返回不是预期对象/数组 | 记录形状（不含密码），提示服务端版本不一致 |
| `METADATA_DOMAIN_INVALID` | 域 code 为空/含控制字符/非法 XML 字符 | 重新选择业务域 |

`BridgeRpcError` 的 `code` 即 Java 错误 `name`；`message` 形如 `name: message`。SDK 映射时保留原名，便于排障。

---

## 3. 分层改动清单

### 3.1 Java 桥层

#### 3.1.1 新增 DTO / 接口

**原则：逐字复制 IDEA 源码，不改包名、类名、字段名、字段类型、`serialVersionUID`。** Java 原生序列化按包名+类名+`serialVersionUID` 匹配；服务器端用 `ToolBasic.serializeEx`（`ObjectOutputStream`），客户端反序列化依赖 `ClassFactory.getValidClassLoader()`（`LvClassLoader` 的父加载器是应用类加载器，能加载 `bridge-main.jar` 中的类）。

字段清单（必须一致）：

| 类 | 字段 |
|---|---|
| `panelxpro.metadata.dto.DomainInfoDto` | `String code; String name; String description` |
| `panelxpro.metadata.dto.DtoGenerateResultDto` | `List<DtoFileEntry> files`；嵌套 `DtoFileEntry`：`String fileName; String packageName; String sourceCode` |
| `panelxpro.metadata.dto.ListFunctionsResult` | `List<RuleFunctionMeta> functions; List<String> functionNames; Map<String,String> errorFunctions; int totalCount` |
| `panelxpro.metadata.dto.PanelFieldDto` | `String code; String name; String dataType; String description; boolean required; List<PanelFieldDto> nestingFields; String assocModelId` |
| `panelxpro.metadata.dto.PanelInfoDto` | `String panelCode; String panelName; String mainModelId; String nestingModelId` |
| `panelxpro.metadata.dto.RegisterFunctionResult` | `boolean success; String message; List<RuleFunctionMeta> functions` |
| `octo.cm.ruleengine.RuleFunctionMeta` | `String ruleCode; String nameSpace; String name; String tag; String description; String codePath; String invokeMethod; List<InputParamMeta> inputParamMetas; String returnType; String useCase; List<String> customLabels` |
| `octo.cm.ruleengine.InputParamMeta` | `String name; String type; String desc; boolean nullable` |

每个类都要有 `private static final long serialVersionUID = 1L;`。getter/setter 的方法名不影响序列化，但为了与 IDEA 源码一致、减少 review 成本，建议原样复制。

`IPanelMetadataService` 也逐字复制。注意：**桥内绝对不要调用 `IPanelMetadataService.get()`**，它内部 `Cells.get(...)` 依赖 Cell 框架初始化，在纯 Java 桥进程中会失败。CRPC 代理生成只处理方法实例，静态方法不会被调用。

#### 3.1.2 `MetadataRpcClient.java`

IDEA 版本用的 `com.intellij.openapi.diagnostic.Logger` 不在桥的 classpath（已确认 `packages/java-bridge/lib/*.jar` 中没有），必须替换为 `java.util.logging.Logger`，与 `BapRpcClient` 一致。

关键代码形状：

```java
package com.bap.dev.service;

import cell.panelxpro.metadata.IPanelMetadataService;
import com.leavay.nio.crpc.CRpcAdapter;
import com.leavay.nio.crpc.CRpcClientWrapper;

import java.net.URI;
import java.util.logging.Logger;

public class MetadataRpcClient {
    private static final Logger LOG = Logger.getLogger(MetadataRpcClient.class.getName());

    private CRpcClientWrapper<IPanelMetadataService> rpcWrapper;
    private String currentUri;
    private String currentUser;
    private String currentPwd;

    public void connect(String uri, String user, String pwd) throws Exception {
        if (isConnected()) shutdown();

        LOG.info("MetadataRpcClient: connecting to " + uri);

        // 两个必须点：
        // 1) JDK 8 下匿名子类不能用钻石，必须显式写 <IPanelMetadataService>
        // 2) CRpcClientWrapper 是抽象类，必须实现 getAdapter()
        rpcWrapper = new CRpcClientWrapper<IPanelMetadataService>(
                IPanelMetadataService.class, URI.create(uri)) {
            @Override
            public CRpcAdapter getAdapter() {
                return CRpcAdapter.getInstance();
            }
        };

        this.currentUri = uri;
        this.currentUser = user;
        this.currentPwd = pwd;
    }

    public IPanelMetadataService getService() {
        if (rpcWrapper == null) {
            throw new IllegalStateException("metadata RPC client is not connected; call connect() first");
        }
        return rpcWrapper.getIntf(true);
    }

    public void shutdown() {
        if (rpcWrapper != null) {
            try { rpcWrapper.shutdown(); } catch (Exception e) { LOG.warning("metadata shutdown failed: " + e); }
            rpcWrapper = null;
        }
    }

    public boolean isConnected() { return rpcWrapper != null; }

    public boolean ping() {
        try { rpcWrapper.ping(); return true; } catch (Exception e) { return false; }
    }

    public String getUri() { return currentUri; }
    public String getUser() { return currentUser; }
    public String getPwd() { return currentPwd; }
}
```

说明：

- `connect` 不调用登录；会话由 `BapRpcClient.login` 写入 `CRpcAdapter.setGlobalContext(CDaoConst.CTX_SESSION, session)`。
- `getIntf(true)` 会缓存 `_intf`；首次调用触发 `openService`，后续廉价。桥内 `metadata.connect` 主动调用一次 `getService()`，把服务不可用错误提前到连接阶段。
- 不要调用 `CRpcAdapter.closeRemoteClient()`；不要在主连接断开时关闭共享 client。只 `rpcWrapper.shutdown()`。

#### 3.1.3 `BridgeMain.java`

`dispatch` 是静态方法，`client` 是 `main` 的局部变量。metadata 状态用静态字段：

```java
private static MetadataRpcClient metadata;

private static void resetMetadata() {
    if (metadata != null) {
        try { metadata.shutdown(); } catch (Throwable ignore) { }
        metadata = null;
    }
}
```

`main` 的 stdin EOF 路径：

```java
resetMetadata();
client.shutdown();
System.exit(0);
```

`dispatch` 的 `connect` 分支开头加 `resetMetadata()`；`disconnect` / `shutdown` 分支在 `client.shutdown()` 前加 `resetMetadata()`。

新增分支：

```java
case "metadata": {
    handleMetadata(client, req);
    break;
}
```

`handleMetadata` 形状：

```java
private static void handleMetadata(BapRpcClient client, Req req) throws Exception {
    String op = str(req.params, 0);
    if (op == null) { writeErr(req.id, "bad_params", "metadata op required"); return; }

    switch (op) {
        case "connect": {
            if (client.getUri() == null) {
                throw new IllegalStateException("bridge not connected; call connect() first");
            }
            String uri = str(req.params, 1);
            if (uri == null || uri.isEmpty()) uri = client.getUri();
            if (!uri.equals(client.getUri())) {
                throw new IllegalArgumentException("metadata uri must match main connection: " + client.getUri());
            }
            String user = str(req.params, 2);
            String pwd = str(req.params, 3);
            if (user == null) user = client.getUser();
            if (pwd == null) pwd = client.getPwd();

            resetMetadata();
            MetadataRpcClient m = new MetadataRpcClient();
            try {
                m.connect(uri, user, pwd);
                m.getService(); // 提前探测服务，失败即报错
                metadata = m;
            } catch (Throwable t) {
                try { m.shutdown(); } catch (Throwable ignore) { }
                throw t;
            }
            writeOk(req.id, "true");
            return;
        }
        case "call": {
            if (metadata == null) throw new IllegalStateException("metadata not connected");
            String method = str(req.params, 1);
            Object[] args = req.params.length > 2 ? asArray(req.params[2]) : new Object[0];
            IPanelMetadataService svc = metadata.getService(); // 先取代理，再设超时

            Object result;
            switch (method) {
                case "listDomains": {
                    CRpcAdapter.setTempTimeout(120_000L);
                    result = svc.listDomains();
                    break;
                }
                case "listFunctions": {
                    String domain = str(args, 0);
                    CRpcAdapter.setTempTimeout(120_000L);
                    result = svc.listFunctions(domain);
                    break;
                }
                case "registerFunction": {
                    String domain = str(args, 0);
                    String className = str(args, 1);
                    String methodName = str(args, 2);
                    CRpcAdapter.setTempTimeout(600_000L);
                    result = svc.registerFunction(domain, className, methodName);
                    break;
                }
                case "registerFunctions": {
                    String domain = str(args, 0);
                    String className = str(args, 1);
                    CRpcAdapter.setTempTimeout(600_000L);
                    result = svc.registerFunctions(domain, className);
                    break;
                }
                case "ping": {
                    result = svc.ping();
                    break;
                }
                default:
                    throw new IllegalArgumentException("unknown metadata method: " + method);
            }
            writeOk(req.id, safeSerialize(result));
            return;
        }
        case "ping": {
            writeOk(req.id, Boolean.toString(metadata != null && metadata.ping()));
            return;
        }
        case "disconnect": {
            resetMetadata();
            writeOk(req.id, "true");
            return;
        }
        default:
            writeErr(req.id, "bad_params", "unknown metadata op: " + op);
    }
}
```

同时修两个现有 JSON 输出问题（否则 Windows 路径/异常消息会破坏协议）：

```java
private static void writeErr(long id, String name, String message) {
    synchronized (OUT_LOCK) {
        String n = name == null ? "UNKNOWN" : name;
        String m = message == null ? "" : message;
        OUT.println("{\"id\":" + id + ",\"ok\":false,\"error\":{\"name\":"
                + GSON.toJson(n) + ",\"message\":" + GSON.toJson(m) + "}}");
    }
}
```

`download` 分支的 `writeOk(req.id, "{\"destDir\":\"" + destDir + "\"}")` 改为 `GSON.toJson(destDir)`。`.develop` 生成改为统一 XML 转义，并支持可选第 4 参数：

```java
String domain = str(req.params, 3); // 可空；来自 SDK/UI 的 MetadataDomain
...
StringBuilder xml = new StringBuilder("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\n<Development");
xml.append(" Project=\"").append(xmlAttr(uuid)).append("\"")
   .append(" Uri=\"").append(xmlAttr(client.getUri())).append("\"")
   .append(" AdminTool=\"").append(xmlAttr(at)).append("\"")
   .append(" User=\"").append(xmlAttr(client.getUser())).append("\"")
   .append(" Password=\"").append(xmlAttr(client.getPwd())).append("\"")
   .append(" LocalNioPort=\"-1\"");
if (domain != null && !domain.trim().isEmpty()) {
    xml.append(" MetadataDomain=\"").append(xmlAttr(domain.trim())).append("\"");
}
xml.append("/>");
```

`xmlAttr` 为 `& < > " '` 的最小转义。注意属性顺序：`MetadataDomain` 放在最后，与 IDEA 的写法兼容（IDEA 用 `replaceFirst("/>", " MetadataDomain=\"...\"/>")`，位置在末尾）。

#### 3.1.4 `build.sh`

当前脚本只编译两个固定文件，且不清理 `out/`。`out/` 中已存在没有源码的 `BridgeMain$StreamProgress.class`，会被 `jar -cfe ... -C out .` 打进 `bridge-main.jar`。必须修：

```bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! ls lib/*.jar >/dev/null 2>&1; then
  echo "ERROR: lib/ 下无 jar，请先运行 npm run sync-jars -w @bap/java-bridge（或在 packages/java-bridge 下运行 npm run sync-jars）" >&2
  exit 1
fi

# 清理旧产物，避免把已删除源码的 class 打进 jar
rm -rf out dist/lib
mkdir -p out dist/lib

JAVAC=javac
if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/javac" ]; then
  JAVAC="$JAVA_HOME/bin/javac"
fi

ARG_FILE="$(mktemp)"
trap 'rm -f "$ARG_FILE"' EXIT
find src/main/java -name '*.java' -print > "$ARG_FILE"

echo "compiling Java bridge (--release 8)..."
"$JAVAC" --release 8 -encoding UTF-8 -cp 'lib/*' -d out @"$ARG_FILE"

cp resources/log4j.properties out/log4j.properties 2>/dev/null || true

echo "packaging bridge-main.jar..."
jar cfe dist/lib/bridge-main.jar com.bap.dev.BridgeMain -C out .

echo "staging platform jars into dist/lib..."
for j in lib/*.jar; do
  cp -f "$j" dist/lib/
done
```

要点：`rm -rf out dist/lib`、`find` 递归、`-encoding UTF-8`（中文注释/字符串）、argfile 放在 `out` 外面（避免被打进 jar）。`dist/lib` 清空后 `bridge-main.jar` 仍是第一个被 `jar cfe` 创建，平台 jar 随后复制；`stage-bridge` 会整体重建 `apps/vscode/assets/bridge/lib`，不会有残留。

#### 3.1.5 classpath 顺序

`apps/vscode/src/extension.ts` 当前是：

```ts
classpath: [path.join(context.extensionPath, 'assets', 'bridge', 'lib', '*')],
```

改为显式把 `bridge-main.jar` 放第一位，避免未来平台 jar 中出现同名 `cell/panelxpro` 类时被通配符先加载：

```ts
const bridgeLib = path.join(context.extensionPath, 'assets', 'bridge', 'lib');
const launch: BridgeLaunchConfig = {
  classpath: [path.join(bridgeLib, 'bridge-main.jar'), path.join(bridgeLib, '*')],
  mainClass: 'com.bap.dev.BridgeMain',
};
```

同步更新 `packages/rpc/scripts/smoke.ts`、`packages/sdk/scripts/smoke.ts` 的 classpath（它们当前只有 `[path.join(distLib, '*')]`）。JVM 对 `-cp` 中通配符的展开顺序不保证，显式第一项是唯一可靠做法。

### 3.2 RPC 包

`packages/rpc/src/types.ts`：`BridgeMethod` 补 `'download'`、`'metadata'`。

`packages/rpc/src/index.ts`（可选，但建议）：加四个薄门面，集中超时：

```ts
metadataConnect(uri: string, user: string, pwd: string, timeoutMs = 180_000): Promise<JsonValue> {
  this.ensureStarted();
  return this._proc.request('metadata', ['connect', uri, user, pwd], timeoutMs);
}

metadataCall<T = JsonValue>(method: string, args: JsonValue[], timeoutMs: number): Promise<T> {
  this.ensureStarted();
  return this._proc.request('metadata', ['call', method, args], timeoutMs) as Promise<T>;
}

metadataPing(): Promise<boolean> {
  this.ensureStarted();
  return this._proc.request('metadata', ['ping'], [], 15_000) as Promise<boolean>;
}

async metadataDisconnect(): Promise<void> {
  if (this._closed || !this._proc.active) return;
  await this._proc.request('metadata', ['disconnect'], [], 10_000);
}
```

SDK 侧不依赖这些门面，只依赖 `RpcInvoker.request`（已存在，可选），这样 `@bap/sdk` 仍不绑定 `RpcClient` 具体类。

### 3.3 SDK 层

#### 3.3.1 `packages/sdk/src/types.ts`

```ts
export interface DevelopConfig {
  projectUuid: string;
  uri: string;
  user: string;
  pwd: string;
  adminTool?: string;
  localNioPort?: string;
  /** BAP MetadataDomain；缺失时不猜测，注册前由宿主引导选择。 */
  metadataDomain?: string;
}

export interface DomainInfoDto {
  code?: string;
  name?: string;
  description?: string;
}

export interface InputParamMeta {
  name?: string;
  type?: string;
  desc?: string;
  nullable?: boolean;
}

export interface RuleFunctionMeta {
  ruleCode?: string;
  nameSpace?: string;
  name?: string;
  tag?: string;
  description?: string;
  codePath?: string;
  invokeMethod?: string;
  inputParamMetas?: InputParamMeta[];
  returnType?: string;
  useCase?: string;
  customLabels?: string[];
}

export interface RegisterFunctionResult {
  success: boolean;
  message?: string;
  functions?: RuleFunctionMeta[];
}

export interface ListFunctionsResult {
  functions?: RuleFunctionMeta[];
  functionNames?: string[];
  errorFunctions?: Record<string, string>;
  totalCount?: number;
}

export interface MetadataDomainResolution {
  /** .develop 已配置的域；没有则为 undefined。 */
  domainCode?: string;
  /** 服务器返回的候选；已配置时为空数组（不发起 RPC）。 */
  candidates: DomainInfoDto[];
  source: 'develop' | 'unconfigured';
}
```

`RpcInvoker.request` 已经是可选方法，无需改动。

#### 3.3.2 `packages/sdk/src/develop.ts`

解析：

```ts
const ATTR_RE = /(?:^|[^A-Za-z])(Project|Uri|User|Password|AdminTool|LocalNioPort|MetadataDomain)\s*=\s*["']([^"']*)["']/gi;

const KEY_MAP: Record<string, keyof DevelopConfig> = {
  project: 'projectUuid',
  uri: 'uri',
  wsuri: 'uri',
  user: 'user',
  pwd: 'pwd',
  password: 'pwd',
  admintool: 'adminTool',
  tool: 'adminTool',
  localnioport: 'localNioPort',
  metadatadomain: 'metadataDomain',
};
```

`normalizeToConfig` 对空的 `MetadataDomain` 不入库：

```ts
if (key === 'metadataDomain' && !value.trim()) continue;
```

新增：

```ts
export function updateDevelopMetadataDomain(workspaceRoot: string, domainCode: string): void;
```

行为：

1. 校验 `domainCode`（trim、非空、无控制字符、无 `< > & " '`；非法抛 `SdkError(..., 'METADATA_DOMAIN_INVALID')`）。
2. 读取 `.develop`；不存在抛 `MISSING_DEVELOP`。
3. 格式识别：
   - 有 `<entry ...>`：按 entry-key 格式补丁；key 为 `MetadataDomain`（大小写不敏感）时替换值；没有则在 `</properties>` 前插入 `<entry key="MetadataDomain">...</entry>`。
   - 有根标签：用引号感知扫描找到第一个元素开始标签的 `>`（不是 `replaceFirst("/>")`，IDEA 的写法可能命中子标签），在 `/>` 或 `>` 前替换/插入 `MetadataDomain="..."`。
4. 原子写回：同目录临时文件 + `fs.renameSync`；POSIX 下 `chmod 0600`。
5. 不破坏注释、未知属性、缩进和换行风格（尽量只替换目标片段）。

`writeDevelop` 改为“原地补丁”，签名：

```ts
export function writeDevelop(
  workspaceRoot: string,
  cfg: {
    projectUuid: string;
    uri: string;
    user: string;
    pwd: string;
    adminTool?: string;
    localNioPort?: string;
    /** undefined=保留原值；null=删除；string=写入 */
    metadataDomain?: string | null;
  },
): void;
```

语义：

- 文件存在且可识别：补丁已知字段（`Project/Uri/User/Password/AdminTool/LocalNioPort/MetadataDomain`），未知属性/注释保留。
- 文件不存在：生成现有单标签属性格式；`adminTool` 缺省 `bap.client.BapMainFrame`，`localNioPort` 缺省 `-1`。
- 文件存在但格式无法识别：抛 `CONFIG_INCOMPLETE`，不要用全量重写覆盖用户文件。
- `metadataDomain`：`undefined` 不碰；`null` 删除；字符串写入（XML 转义）。
- `localNioPort` 不再硬编码 `-1`，优先 `cfg.localNioPort`，其次原值，最后 `-1`。

`redirect.apply` 的域策略（`packages/sdk/src/services.ts`）：

```ts
const old = (() => { try { return loadDevelop(workspaceRoot); } catch { return undefined; } })();
const keepDomain = old && sameServerUri(old.uri, profile.uri) ? old.metadataDomain : null;
writeDevelop(workspaceRoot, {
  projectUuid: profile.projectUuid,
  uri: profile.uri,
  user: profile.user,
  pwd: profile.pwd,
  adminTool: profile.adminTool,
  metadataDomain: keepDomain, // 同服务器保留；换服务器清空
});
```

`sameServerUri` 用最小归一化（trim、去尾部 `/`、小写 scheme/host）比较即可；不要引入 URL 第三方库。

#### 3.3.3 `packages/sdk/src/metadata.ts`（新增）

```ts
import type { JsonValue } from '@bap/rpc';
import { SdkError } from './develop';
import type {
  DevelopConfig, DomainInfoDto, ListFunctionsResult,
  MetadataDomainResolution, RegisterFunctionResult, RpcInvoker,
} from './types';

export const METADATA_CONNECT_TIMEOUT_MS = 180_000;
export const METADATA_READ_TIMEOUT_MS = 120_000;
export const METADATA_REGISTER_TIMEOUT_MS = 12 * 60_000;
export const METADATA_PING_TIMEOUT_MS = 15_000;
export const METADATA_DISCONNECT_TIMEOUT_MS = 10_000;

function requireRequest(rpc: RpcInvoker): NonNullable<RpcInvoker['request']> {
  if (!rpc.request) {
    throw new SdkError('当前 Java 桥不支持元数据调用（缺少 request 通道），请重新构建并重装扩展', 'METADATA_UNAVAILABLE');
  }
  return rpc.request.bind(rpc);
}

async function metadataRequest(
  rpc: RpcInvoker,
  op: 'connect' | 'call' | 'disconnect' | 'ping',
  args: JsonValue[],
  timeoutMs: number,
): Promise<JsonValue> {
  const request = requireRequest(rpc);
  try {
    return await request('metadata', [op, ...args], timeoutMs);
  } catch (e) {
    const name = e instanceof Error && 'code' in e ? String((e as { code?: unknown }).code) : '';
    const message = e instanceof Error ? e.message : String(e);
    if (name.includes('unknown_method') || name.includes('BRIDGE_CLOSED')) {
      throw new SdkError(`Java 桥不支持元数据调用（${name}），请重新构建并重装扩展`, 'METADATA_UNAVAILABLE', e);
    }
    if (/IPanelMetadataService|NoService|ServiceNotFound|not\s+found/i.test(message)) {
      throw new SdkError(`服务器未启用元数据服务或账号无权限：${message}`, 'METADATA_SERVICE_UNAVAILABLE', e);
    }
    throw new SdkError(`元数据调用失败（${op}）：${message}`, 'METADATA_RPC_FAILED', e);
  }
}

export async function metadataConnect(rpc: RpcInvoker, d: Pick<DevelopConfig, 'uri' | 'user' | 'pwd'>): Promise<void> {
  await metadataRequest(rpc, 'connect', [d.uri, d.user, d.pwd], METADATA_CONNECT_TIMEOUT_MS);
}

export async function metadataCall<T>(
  rpc: RpcInvoker, method: string, args: JsonValue[], timeoutMs: number,
): Promise<T> {
  return (await metadataRequest(rpc, 'call', [method, args], timeoutMs)) as T;
}

export async function listMetadataDomains(rpc: RpcInvoker): Promise<DomainInfoDto[]> {
  const raw = await metadataCall<unknown>(rpc, 'listDomains', [], METADATA_READ_TIMEOUT_MS);
  if (!Array.isArray(raw)) throw new SdkError('listDomains 返回格式异常', 'METADATA_BAD_RESPONSE');
  return raw.filter((x): x is DomainInfoDto => !!x && typeof x === 'object') as DomainInfoDto[];
}

export async function listMetadataFunctions(rpc: RpcInvoker, domain: string): Promise<ListFunctionsResult> {
  const raw = await metadataCall<unknown>(rpc, 'listFunctions', [domain], METADATA_READ_TIMEOUT_MS);
  return ensureResult<ListFunctionsResult>(raw);
}

export async function registerMetadataFunction(
  rpc: RpcInvoker, domain: string, fullClass: string, methodName: string,
): Promise<RegisterFunctionResult> {
  const raw = await metadataCall<unknown>(
    rpc, 'registerFunction', [domain, fullClass, methodName], METADATA_REGISTER_TIMEOUT_MS,
  );
  return ensureRegisterResult(raw);
}

export async function registerMetadataFunctions(
  rpc: RpcInvoker, domain: string, fullClass: string,
): Promise<RegisterFunctionResult> {
  const raw = await metadataCall<unknown>(
    rpc, 'registerFunctions', [domain, fullClass], METADATA_REGISTER_TIMEOUT_MS,
  );
  return ensureRegisterResult(raw);
}

export function validateMetadataDomainCode(code: string): string {
  const s = (code ?? '').trim();
  if (!s) throw new SdkError('业务域 code 不能为空', 'METADATA_DOMAIN_INVALID');
  if (/[<>&"'\u0000-\u001f]/.test(s)) {
    throw new SdkError(`业务域 code 含非法字符：${s}`, 'METADATA_DOMAIN_INVALID');
  }
  return s;
}
```

`ensureRegisterResult` / `ensureResult` 必须校验：

- 对象、非数组；
- `success` 必须是 boolean（缺失视为格式异常）；
- `functions` 若存在必须是数组；
- 列表函数返回对象而非数组/字符串。

#### 3.3.4 `packages/sdk/src/services.ts`

`BapSdk` 接口新增：

```ts
metadata: {
  /** 从 .develop 读取；不发起 RPC，不隐式猜测。 */
  configuredDomain(): string | undefined;
  /** 已配置则返回 develop；否则调 listDomains 返回候选。 */
  resolveDomain(opts?: { refresh?: boolean }): Promise<MetadataDomainResolution>;
  listDomains(opts?: { refresh?: boolean }): Promise<DomainInfoDto[]>;
  setDomain(code: string): Promise<void>;
  listFunctions(domain: string): Promise<ListFunctionsResult>;
  registerFunction(domain: string, fullClass: string, methodName: string): Promise<RegisterFunctionResult>;
  registerFunctions(domain: string, fullClass: string): Promise<RegisterFunctionResult>;
};
```

内部状态：

```ts
let metadataEpoch = -1;
let domainCache: { t: number; domains: DomainInfoDto[] } | null = null;
const DOMAIN_TTL_MS = 60_000;

async function ensureMetadataConnected(d: DevelopConfig): Promise<void> {
  if (metadataEpoch === epoch) return;
  await metadataConnect(rpc, d);
  metadataEpoch = epoch;
}

async function listDomainsImpl(refresh = false): Promise<DomainInfoDto[]> {
  if (!refresh && domainCache && Date.now() - domainCache.t < DOMAIN_TTL_MS) {
    return domainCache.domains;
  }
  const { develop: d } = await ensureConnected();
  await ensureMetadataConnected(d);
  const domains = await listMetadataDomains(rpc);
  domainCache = { t: Date.now(), domains };
  log(`[metadata.listDomains] 完成，候选=${domains.length}`);
  return domains;
}
```

`configuredDomain()`：

```ts
configuredDomain() {
  try {
    const domain = loadDevelop(workspaceRoot).metadataDomain?.trim();
    return domain || undefined;
  } catch {
    return undefined;
  }
}
```

`setDomain()`：

```ts
async setDomain(code: string) {
  const value = validateMetadataDomainCode(code);
  updateDevelopMetadataDomain(workspaceRoot, value);
  if (develop) develop.metadataDomain = value;
  log(`[metadata.setDomain] domain=${value}`);
}
```

`resolveDomain()`：

```ts
async resolveDomain(opts) {
  const configured = this.configuredDomain(); // 或闭包函数
  if (configured) return { domainCode: configured, candidates: [], source: 'develop' };
  return { candidates: await listDomainsImpl(opts?.refresh ?? false), source: 'unconfigured' };
}
```

`register*`：

```ts
async registerFunction(domain, fullClass, methodName) {
  const value = validateMetadataDomainCode(domain);
  const { develop: d } = await ensureConnected();
  await ensureMetadataConnected(d);
  const r = await registerMetadataFunction(rpc, value, fullClass, methodName);
  log(`[metadata.registerFunction] domain=${value} class=${fullClass} method=${methodName} success=${r.success} count=${r.functions?.length ?? 0}`);
  return r;
}
```

`registerFunctions` 同理。**日志绝不打印 `d.pwd`**；只打印 uri（可脱敏）、domain、class、method、结果。

`redirect.apply`：

- 调用 `writeDevelop` 时带 `metadataDomain` 策略（见 3.3.2）。
- `epoch++`、`cloudSnapshot = null`、`session = null`、`develop = null` 后，加 `metadataEpoch = -1; domainCache = null;`。

`disconnect()`：

- 清 `metadataEpoch = -1; domainCache = null;`，再 `rpc.disconnect()`。

注意：`metadataEpoch` 用 `epoch` 做键；`epoch` 在 `redirect`/`disconnect` 时递增，能覆盖“桥重启/换服务器”场景。若 metadata RPC 返回连接类错误，可把 `metadataEpoch = -1` 后抛错，用户重试时会重新 `metadata.connect`（MVP 不自动重试，避免隐藏错误）。

#### 3.3.5 `packages/sdk/src/index.ts`

导出：

```ts
export { loadDevelop, writeDevelop, updateDevelopMetadataDomain, SdkError } from './develop';
export {
  listMetadataDomains, listMetadataFunctions,
  registerMetadataFunction, registerMetadataFunctions,
  validateMetadataDomainCode,
  METADATA_CONNECT_TIMEOUT_MS, METADATA_READ_TIMEOUT_MS,
  METADATA_REGISTER_TIMEOUT_MS, METADATA_PING_TIMEOUT_MS, METADATA_DISCONNECT_TIMEOUT_MS,
} from './metadata';
```

类型导出补 `DomainInfoDto`、`InputParamMeta`、`RuleFunctionMeta`、`RegisterFunctionResult`、`ListFunctionsResult`、`MetadataDomainResolution`。

#### 3.3.6 `packages/sdk/src/download.ts`

`DownloadOptions` 加 `metadataDomain?: string`；调用改为：

```ts
await send.call(rpc, 'download',
  [projectUuid, destDir, adminTool ?? null, metadataDomain?.trim() || null],
  DOWNLOAD_TIMEOUT_MS);
```

旧桥忽略第 4 个参数，兼容。Java 侧若收到非空值，写入 `.develop` 的 `MetadataDomain`。

### 3.4 宿主命令层

#### 3.4.1 `server-profiles.ts`（新增）

```ts
import * as fs from 'fs';
import * as path from 'path';

/**
 * 读取 VotaForge 当前 profile 的 busDomainCode，仅用于 QuickPick 预选提示。
 * - 只读；绝不写回；绝不自动当成 MetadataDomain。
 * - 文件缺失/非法/过大/字段缺失一律返回 undefined，不抛错。
 */
export function readActiveBusDomainCode(vfRoot: string): string | undefined {
  const file = path.join(vfRoot, '.votaforge', 'server-profiles.json');
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 256 * 1024) return undefined;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const profiles = Array.isArray(raw.profiles)
      ? raw.profiles.filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
      : [];
    const activeId = typeof raw.activeProfileId === 'string' ? raw.activeProfileId : undefined;
    const active = activeId ? profiles.find((p) => p.id === activeId) : undefined;
    const legacy = raw.activeProfile && typeof raw.activeProfile === 'object'
      ? (raw.activeProfile as Record<string, unknown>)
      : undefined;
    const code = active?.busDomainCode ?? legacy?.busDomainCode;
    return typeof code === 'string' && code.trim() ? code.trim() : undefined;
  } catch {
    return undefined;
  }
}
```

兼容 `activeProfile` 对象是防御性的；以 `activeProfileId + profiles[]` 为主（与 `docs/architecture/workspace-protocol.md` §4.2 一致）。

#### 3.4.2 `java-source.ts`（新增，纯函数，可单测）

```ts
export function parseJavaPackage(source: string): string | undefined;
export function classStemFromPath(absPath: string): string | undefined;
export function deriveFullClassFromSource(projectRoot: string, absPath: string, source: string): string | undefined;
export function isValidFullClassName(value: string): boolean;
export function isValidMethodName(value: string): boolean;
export function appendNestedClass(base: string, nestedChain: string[]): string | undefined;
```

实现要点：

- `parseJavaPackage`：先去掉 `//` 行注释和 `/* ... */` 块注释，再匹配 `^\s*package\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;`（`m` 标志）。
- `classStemFromPath`：`path.basename(absPath, '.java')`；拒绝 `module-info` / `package-info`。
- `deriveFullClassFromSource`：优先 `package + '.' + stem`；没有包声明时退回 `deriveFullClass(projectRoot, absPath)`（现有 `project-paths.ts` 的实现）；仍无则 `undefined`。**不要只依赖 `src/<folder>/...` 路径推导**，`.classpath` 工程、多 source root 会失真。
- `isValidFullClassName` / `isValidMethodName`：Java 标识符正则；方法名额外拒绝 `<init>` / `<clinit>` / 构造器。
- `appendNestedClass`：`base + '.' + chain.join('.')`，逐段校验；任何一段非法返回 `undefined`。

#### 3.4.3 `command-router.ts`

导入新增：

```ts
import { readActiveBusDomainCode } from '../projects/server-profiles';
import {
  deriveFullClassFromSource, isValidFullClassName, isValidMethodName, appendNestedClass,
} from '../java-source';
```

内部辅助：

```ts
async function ensureMetadataDomain(
  ctx: BackendProjectContext,
  sdk: BapSdk,
  opts: { force?: boolean } = {},
): Promise<string | undefined> {
  const configured = sdk.metadata.configuredDomain();
  if (configured && !opts.force) return configured;

  // 网络调用放队列；QuickPick 不放队列。
  const domains = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'BAP: 读取业务域列表…' },
    () => ctx.runExclusive(() => sdk.metadata.listDomains({ refresh: true })),
  );
  if (domains.length === 0) {
    void vscode.window.showWarningMessage(
      'BAP: 服务器未返回任何业务域（MetadataDomain）。请确认服务器已启用 panelxpro 元数据服务、账号有权限。',
    );
    return undefined;
  }

  const vfRoot = findVfWorkspaceRoot(ctx.root, vscode.workspace.workspaceFolders ?? []);
  const hint = vfRoot ? readActiveBusDomainCode(vfRoot) : undefined;
  const suggested = hint && domains.some((d) => d.code === hint) ? hint : undefined;

  const items = domains
    .filter((d): d is DomainInfoDto & { code: string } => !!d.code)
    .map((d) => ({
      label: d.code,
      description: d.name || '',
      detail: [
        d.description || '',
        d.code === suggested ? 'VotaForge 当前业务域（仅提示，未自动写入）' : '',
      ].filter(Boolean).join(' · '),
      picked: d.code === (configured ?? suggested),
      code: d.code,
    }));

  const picked = await vscode.window.showQuickPick(items, {
    title: opts.force ? 'BAP: 切换 MetadataDomain' : 'BAP: 选择 MetadataDomain',
    placeHolder: hint && !suggested
      ? `VotaForge 当前业务域 ${hint} 不在服务器列表中，请手动选择`
      : '选择业务域（写入 .develop 的 MetadataDomain）',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked?.code) return undefined;
  if (picked.code !== configured) {
    await ctx.runWrite(() => sdk.metadata.setDomain(picked.code));
    log.debug(`[metadata] domain=${picked.code} 写入 .develop [${ctx.displayName}]`);
  }
  return picked.code;
}
```

类注册命令：

```ts
command(
  'bapIde.metadata.registerClassFunctions',
  toolCommand('registerClassRuleFunctions', async (arg) => {
    const ctx = await resolveOneForUi(arg, '注册类规则函数', true);
    const absPath = changePathOrArg(ctx, arg);
    if (!absPath || !absPath.toLowerCase().endsWith('.java')) {
      void vscode.window.showInformationMessage('BAP: 请选择 Java 源文件');
      return;
    }
    const sdk = ctx.ensureSdk();
    const source = readJavaSource(absPath);
    const fullClass =
      deriveFullClassFromSource(ctx.root, absPath, source) ??
      (await vscode.window.showInputBox({
        title: 'BAP: 输入 Java 全类名',
        prompt: '例如 com.example.Foo',
        validateInput: (v) => (isValidFullClassName(v.trim()) ? undefined : '非法全类名'),
      }))?.trim();
    if (!fullClass) return;

    const domain = await ensureMetadataDomain(ctx, sdk);
    if (!domain) return;

    const ok = await vscode.window.showWarningMessage(
      `将把 ${fullClass} 的全部方法注册到业务域 ${domain}。服务端按云端代码扫描；未提交/未保存的改动不会生效。继续？`,
      { modal: true },
      '注册',
    );
    if (ok !== '注册') return;

    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `BAP: 注册 ${fullClass} 的规则函数…`, cancellable: false },
      () => ctx.runWrite(() => sdk.metadata.registerFunctions(domain, fullClass)),
    );
    if (!result.success) throw new Error(result.message || '服务器返回 success=false');
    const count = result.functions?.length ?? 0;
    void vscode.window.showInformationMessage(
      `BAP: 已注册 ${fullClass} 的 ${count} 个规则函数（业务域 ${domain}）`,
    );
    log.debug(`[metadata.registerFunctions] ${fullClass} domain=${domain} count=${count}`);
  }),
),
```

方法注册命令：

```ts
command(
  'bapIde.metadata.registerMethodFunction',
  toolCommand('registerMethodRuleFunction', async (arg) => {
    const ctx = await resolveOneForUi(arg, '注册方法规则函数', true);
    const absPath = changePathOrArg(ctx, arg);
    if (!absPath || !absPath.toLowerCase().endsWith('.java')) {
      void vscode.window.showInformationMessage('BAP: 请选择 Java 源文件');
      return;
    }
    const target = await resolveMethodTarget(ctx, absPath, arg);
    if (!target) return;
    const { fullClass, methodName } = target;

    const sdk = ctx.ensureSdk();
    const domain = await ensureMetadataDomain(ctx, sdk);
    if (!domain) return;

    // 与 IDEA 一致：方法注册不弹确认框，直接进度提示。
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `BAP: 注册 ${fullClass}.${methodName}…`,
        cancellable: false,
      },
      () => ctx.runWrite(() => sdk.metadata.registerFunction(domain, fullClass, methodName)),
    );
    if (!result.success) throw new Error(result.message || '服务器返回 success=false');
    const count = result.functions?.length ?? 0;
    void vscode.window.showInformationMessage(
      `BAP: 已注册 ${fullClass}.${methodName} 为规则函数（业务域 ${domain}${count ? `，返回 ${count} 条` : ''}）`,
    );
  }),
),
```

切换域命令：

```ts
command('bapIde.metadata.switchDomain', async (arg) => {
  const ctx = await resolveOneForUi(arg, '切换 MetadataDomain');
  const code = await ensureMetadataDomain(ctx, ctx.ensureSdk(), { force: true });
  if (!code) return;
  void vscode.window.showInformationMessage(`BAP: MetadataDomain 已切换为 ${code}`);
}),
```

`resolveMethodTarget` 解析顺序：

1. **编辑器对齐**：如果 `arg` 是 URI，优先找 `document.uri.fsPath === absPath` 的可见编辑器；否则找活动编辑器匹配；都没有则 `openTextDocument(absPath)`。这样不会因分屏/活动编辑器漂移把方法注册到另一个文件。
2. **DocumentSymbol**：`vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', doc.uri)`，用 `Promise.race` 加 1500 ms 超时；递归查找包含光标位置的方法/构造器，记录类链。
   - 命中 `SymbolKind.Method` → 方法名 + 类链。
   - 命中 `SymbolKind.Constructor` → 提示“构造器不能注册为规则函数”，返回。
   - 命中 `SymbolKind.Class` 但不在方法内 → 走输入框。
3. **光标单词兜底**：`doc.getWordRangeAtPosition(selection.active)`，若 `isValidMethodName` 则用。
4. **InputBox 兜底**：标题“输入要注册的方法名”，`validateInput` 用 `isValidMethodName`。
5. **全类名**：`deriveFullClassFromSource` 得到顶层类；若 DocumentSymbol 给出嵌套类链，`appendNestedClass` 拼成 `pkg.Outer.Inner`。拿不到则 InputBox。
6. 文件有未保存改动（`doc.isDirty`）时，在方法注册的进度标题或警告里提示“服务端按云端代码注册，未提交改动不生效”；不阻断（与 IDEA 行为一致）。
7. 同名重载：DocumentSymbol 中同名的 `Method` 多于 1 个时，在成功消息后加一条警告“存在同名重载，服务端按方法名注册”；不阻断。

`runWrite` vs `runExclusive` 的边界：

| 操作 | 包装 | 原因 |
|---|---|---|
| `metadata.listDomains`（选域时） | `ctx.runExclusive` | 只读网络调用，避免与同工程长任务并发 |
| `metadata.setDomain`（写 `.develop`） | `ctx.runWrite` | 改工程文件，需身份校验 |
| `metadata.registerFunction(s)` | `ctx.runWrite` | 云端写操作，需身份校验 + 串行 |
| `metadata.listFunctions`（未来） | `ctx.runExclusive` | 只读 |
| QuickPick / 确认框 / 进度 UI | 队列外 | 不能阻塞队列 |

`bapIde.scm.refresh` 目前不走 `runExclusive`。metadata 注册不修改本地文件，不会触发 SCM 自动刷新；手动刷新或其它命令在注册期间仍可能排队到单线程 Java 桥，导致 TS 30 s 默认超时。建议顺手把 `bapIde.scm.refresh` 的 per-context handler 包进 `ctx.runExclusive`（小改动，统一串行语义）；若不改，至少在此文档中记录为已知限制。

### 3.5 `apps/vscode/package.json`

`contributes.commands` 追加：

```json
{ "command": "bapIde.metadata.switchDomain", "title": "Switch Metadata Domain", "category": "BAP" },
{ "command": "bapIde.metadata.registerClassFunctions", "title": "Register Class Rule Functions", "category": "BAP" },
{ "command": "bapIde.metadata.registerMethodFunction", "title": "Register Method Rule Function", "category": "BAP" }
```

`contributes.menus.editor/context` 追加（用独立的 `bap` 分组，避免与现有 `compile@1` 混在一起）：

```json
{
  "command": "bapIde.metadata.registerMethodFunction",
  "group": "bap@1",
  "when": "resourceLangId == java && bapIde.hasBackendProject"
},
{
  "command": "bapIde.metadata.registerClassFunctions",
  "group": "bap@2",
  "when": "resourceLangId == java && bapIde.hasBackendProject"
}
```

切换域默认出现在命令面板（无需显式 `commandPalette` 条目）。可选加入 SCM 标题栏：

```json
{
  "command": "bapIde.metadata.switchDomain",
  "group": "navigation@8",
  "when": "scmProvider =~ /^bap($|:)/"
},
{
  "command": "bapIde.metadata.switchDomain",
  "group": "2_main@9",
  "when": "scmProvider =~ /^bap($|:)/"
}
```

注意：`scm/title` 传入的是 `SourceControl` 对象，`resolveOneForUi` 的 `requestFromArg` 已支持；`resolveOneForUi(..., '切换 MetadataDomain')` 默认非写操作，`setDomain` 走 `runWrite` 时仍会校验身份。

### 3.6 MCP（P1，建议纳入）

新增 2 个工程级工具。若决定不做 MCP，本节整段跳过，且不需要改工具数量/测试/技能文档。

`packages/vscode-host/src/mcp/tools.ts`：

```ts
T(
  'registerClassRuleFunctions',
  '把指定 Java 类的全部方法注册为 BAP 规则函数（云端写操作）。domainCode 缺省时使用 .develop 的 MetadataDomain；两者都没有会报错并返回可用业务域。',
  obj({
    project: P,
    fullClass: S('Java 点分全类名'),
    domainCode: S('业务域 code；缺省用 .develop 的 MetadataDomain'),
  }, ['fullClass']),
  'bapIde.metadata.registerClassFunctions',
),
T(
  'registerMethodRuleFunction',
  '把指定 Java 类的某个方法注册为 BAP 规则函数（云端写操作）。domainCode 缺省时使用 .develop 的 MetadataDomain；两者都没有会报错并返回可用业务域。',
  obj({
    project: P,
    fullClass: S('Java 点分全类名'),
    methodName: S('方法名'),
    domainCode: S('业务域 code；缺省用 .develop 的 MetadataDomain'),
  }, ['fullClass', 'methodName']),
  'bapIde.metadata.registerMethodFunction',
),
```

`packages/vscode-host/src/mcp/tool-exec.ts`：

```ts
function requireString(a: ToolArg, key: string): string {
  const v = typeof a[key] === 'string' ? (a[key] as string).trim() : '';
  if (!v) throw new Error(`缺少参数 ${key}`);
  return v;
}

async function resolveMetadataDomainForTool(ctx: McpToolCtx, a: ToolArg): Promise<string> {
  const explicit = typeof a.domainCode === 'string' ? a.domainCode.trim() : '';
  const configured = ctx.sdk.metadata.configuredDomain();
  const code = explicit || configured;
  if (code) return validateMetadataDomainCode(code);
  const domains = await ctx.sdk.metadata.listDomains();
  const codes = domains.map((d) => d.code).filter(Boolean).join('、') || '（服务器未返回）';
  throw new Error(`缺少 domainCode，且 .develop 未配置 MetadataDomain；可用业务域：${codes}`);
}

case 'registerClassRuleFunctions': {
  const domain = await resolveMetadataDomainForTool(ctx, a);
  const fullClass = requireString(a, 'fullClass');
  if (!isValidFullClassName(fullClass)) throw new Error(`非法全类名：${fullClass}`);
  const r = await write(ctx, () => ctx.sdk.metadata.registerFunctions(domain, fullClass));
  if (!r.success) throw new Error(r.message || '注册失败');
  return { domain, success: true, count: r.functions?.length ?? 0, functions: r.functions ?? [] };
}
case 'registerMethodRuleFunction': {
  const domain = await resolveMetadataDomainForTool(ctx, a);
  const fullClass = requireString(a, 'fullClass');
  const methodName = requireString(a, 'methodName');
  if (!isValidFullClassName(fullClass)) throw new Error(`非法全类名：${fullClass}`);
  if (!isValidMethodName(methodName)) throw new Error(`非法方法名：${methodName}`);
  const r = await write(ctx, () => ctx.sdk.metadata.registerFunction(domain, fullClass, methodName));
  if (!r.success) throw new Error(r.message || '注册失败');
  return { domain, success: true, count: r.functions?.length ?? 0, functions: r.functions ?? [] };
}
```

两个命令同时用 `toolCommand` 注册（UI 分支保持上面的交互实现）：

```ts
command('bapIde.metadata.registerClassFunctions', toolCommand('registerClassRuleFunctions', registerClassUi)),
command('bapIde.metadata.registerMethodFunction', toolCommand('registerMethodRuleFunction', registerMethodUi)),
```

MCP 路径的域策略：`domainCode` 显式值 > `.develop` 配置值；都没有时**不弹 QuickPick**，直接 `listDomains()` 后抛错并列出可用 code，让 AI 带 `domainCode` 重试。MCP **绝不使用** VotaForge `busDomainCode` 提示。

### 3.7 测试

#### `packages/sdk/test/develop.test.ts`（扩展）

新增用例：

1. 属性格式解析 `MetadataDomain="D1"` → `cfg.metadataDomain === 'D1'`。
2. entry-key 格式 `<entry key="MetadataDomain">D2</entry>` 和 `<entry key="metadataDomain">D3</entry>` 大小写不敏感。
3. 空值 `MetadataDomain=""` → `undefined`。
4. 注释里的 `MetadataDomain="FAKE"` 不解析。
5. `updateDevelopMetadataDomain` 替换已有属性，保留其它属性、注释、CRLF、BOM。
6. 缺失时插入到根标签 `/>` 前；不是 `replaceFirst('/>')`，子标签存在时也只改根标签。
7. entry-key 格式替换/插入；保留其它 entry。
8. 幂等：连续调用两次结果一致。
9. XML 转义：值含 `&`、`"` 时正确编码，再 `loadDevelop` 能还原。
10. 非法域 code → `SdkError('METADATA_DOMAIN_INVALID')`。
11. `.develop` 缺失 → `MISSING_DEVELOP`。
12. `writeDevelop`：`metadataDomain` 为 `undefined` 保留、`null` 删除、字符串写入。
13. `writeDevelop` 保留未知属性/注释；`localNioPort` 尊重传入值。
14. `writeDevelop` 文件不存在时生成含 `MetadataDomain` 的规范 XML。
15. `writeDevelop` 在 entry-key 格式上不丢失其它 entry。

#### `packages/sdk/test/metadata.test.ts`（新增）

用假 `RpcInvoker` 记录 `request` 调用：

1. `listMetadataDomains` 参数为 `['metadata', ['call','listDomains',[]]]`，超时 120 s。
2. `registerMetadataFunction` 参数 `['metadata',['call','registerFunction',[domain,class,method]]]`，超时 12 min。
3. `registerMetadataFunctions` 同理。
4. `success:false` 原样返回，不抛。
5. `request` 缺失 → `METADATA_UNAVAILABLE`。
6. 远端 `unknown_method` → `METADATA_UNAVAILABLE`。
7. 远端普通异常 → `METADATA_RPC_FAILED`，消息含原异常名。
8. `listDomains` 返回非数组 → `METADATA_BAD_RESPONSE`。
9. `registerFunction` 返回非对象 / `success` 非 boolean → `METADATA_BAD_RESPONSE`。
10. `configuredDomain`：有 `.develop` 域直接返回，不发起 RPC。
11. `resolveDomain`：有配置 → `source:'develop'`、`candidates:[]`；无配置 → `source:'unconfigured'`、调用 `listDomains`。
12. `setDomain` 写 `.develop`，`configuredDomain` 能读回；不发起 `rpc.connect`。
13. `onLog` 不包含密码字符串。
14. 域缓存：TTL 内第二次 `listDomains` 不重复 RPC；`refresh:true` 强制 RPC。
15. `redirect.apply`：同 URI 保留域，不同 URI 清空域（需要临时目录 + 假 RPC）。

#### `packages/vscode-host/test/server-profiles.test.ts`（新增）

1. `activeProfileId` + `profiles[]` → 正确 `busDomainCode`。
2. 无 `activeProfileId` → `undefined`。
3. `profiles` 非数组 / JSON 非法 / 文件缺失 → `undefined`。
4. 文件超过 256 KiB → `undefined`。
5. 命中 profile 无 `busDomainCode` → `undefined`。
6. 不修改文件（读取前后内容一致）。

#### `packages/vscode-host/test/java-source.test.ts`（新增）

1. 正常 `package com.x;` + `Foo.java` → `com.x.Foo`。
2. 无 package → `Foo`。
3. 注释里的 package 不误判。
4. `package-info.java` / `module-info.java` → `undefined`。
5. `isValidFullClassName` / `isValidMethodName` 的合法/非法用例。
6. 嵌套类链拼接 `com.x.Outer.Inner`；非法链返回 `undefined`。
7. `src/<folder>` 布局与 `.classpath` 布局都能得到正确类名（后者依赖 package 声明）。

#### `mcp-tools.test.ts` / `workspace-info.test.ts` / `agent-instructions.test.ts`

- 去掉硬编码 18/15；改为 `BAP_TOOLS.length`、`BAP_TOOLS.length - WORKSPACE_LEVEL_TOOL_NAMES.length`、`toolsForMode('full').length`。
- 新工具断言：名称、`command` 映射、`fullClass`/`methodName` 在 `required`，`project` 不在 `required`，`domainCode` 可选。
- `agent-instructions.test.ts` 断言新工具名与 `String(BAP_TOOLS.length)`。
- 若不做 MCP，这些文件不需要改，但 `BAP_TOOLS` 仍为 18。

### 3.8 文档

1. 本文档（`docs/BAP IDE 规则函数注册（MetadataDomain）移植方案 V1.0.md`）已覆盖协议、域生命周期、限制与排障；实施时如需要面向使用者的独立架构说明，再从本文档拆分出 `docs/architecture/metadata-rule-functions.md`（不要原样复制，避免两份内容漂移）：
   - 背景与与 IDEA 的差异（无 PSI、无 SharedClient）。
   - 双 CRPC 客户端与全局会话。
   - `metadata` 桥协议与超时矩阵。
   - DTO 序列化契约与版本排查（`InvalidClassException` → 检查 `serialVersionUID`/字段）。
   - `MetadataDomain` 生命周期与 `.develop` 格式。
   - VotaForge `busDomainCode` 仅为提示的边界。
   - UI/MCP 用法与限制（构造器、匿名类、同名重载、未提交代码）。
   - 排障：`unknown_method`、服务不可用、无候选域、超时。
2. `README.md`：
   - 功能列表加“规则函数注册（类/方法，MetadataDomain 可选/切换）”。
   - 工具数量与“15 个工程级”按最终是否做 MCP 更新（18→20、15→17，或保持不变）。
   - Java 桥说明补 metadata 服务。
3. `skill/bap-vscode-mcp/SKILL.md` + `references/commands.md`（仅做 MCP 时）：
   - 18→20、15→17。
   - 索引加两条。
   - 描述里把“不适用于规则函数开发”改为“不适用于规则函数业务开发；**注册已有类/方法为规则函数**可用本技能”。
   - 新增 `references/tools/registerClassRuleFunctions.md`、`registerMethodRuleFunction.md`，说明 `domainCode` 缺省行为、返回 envelope、失败时先读候选。
4. `packages/vscode-host/src/agent/agent-instructions.ts`：
   - `共 18 个` → 动态 `共 ${BAP_TOOLS.length} 个`（从 `../mcp/tools` 导入）。
   - 工具清单加两行：
     - `registerClassRuleFunctions` 注册类的规则函数
     - `registerMethodRuleFunction` 注册方法的规则函数
   - 说明“需要 MetadataDomain；缺省用 `.develop`，没有则先报错返回可用业务域”。

---

## 4. MetadataDomain 获取、写回与 VotaForge `busDomainCode` 边界

### 4.1 权威来源与状态机

**权威来源只有两个**：

1. `.develop` 中的 `MetadataDomain`（本地配置，注册时直接使用）。
2. 服务器 `listDomains()` 返回的 `DomainInfoDto.code`（用户选择后写回 `.develop`）。

**VotaForge `server-profiles.json` 的 `busDomainCode` 不是权威来源**，只是 UI 提示。

状态机：

```text
读取 .develop
  ├─ 有 MetadataDomain → 直接使用（source=develop）
  └─ 无
       ├─ listDomains()
       │    ├─ 空 → 警告并中止（不注册、不写 .develop）
       │    └─ 非空 → QuickPick
       │         ├─ 取消 → 中止
       │         └─ 选中 → setDomain(code) 写回 .develop → 继续注册
       └─ RPC 失败 → 错误提示并中止

switchDomain 命令
  → listDomains(refresh=true)（无论是否已配置）
  → QuickPick（预选当前值）
  → 选中且与当前不同 → setDomain 写回
  → 相同/取消 → 不写
```

### 4.2 各入口流程

| 入口 | 域获取 | 写回 | 说明 |
|---|---|---|---|
| `bapIde.metadata.registerMethodFunction` | 已配置直接用；否则 listDomains + QuickPick | 选中后写 `.develop` | 写回后再注册；方法注册不弹确认框 |
| `bapIde.metadata.registerClassFunctions` | 同上 | 同上 | 注册前弹模态确认（类全量扫描影响面大） |
| `bapIde.metadata.switchDomain` | 强制 listDomains + QuickPick | 选中后写 `.develop` | 单独入口，不触发注册 |
| `bapIde.scm.redirect` | 不重新选择 | 同服务器保留；换服务器删除 | 防止把 A 服务器的域带到 B 服务器 |
| `bapIde.downloadProject`（UI） | P0：下载后提示“重新加载后运行 Switch Metadata Domain”；P1：下载前可选域并传给 Java | Java 写入（P1） | 新工程 `.develop` 默认无域 |
| `downloadProject`（MCP） | P1：可选 `domainCode` 参数 | Java 写入 | 不提供则下载后由用户切 |
| MCP `registerClassRuleFunctions` / `registerMethodRuleFunction` | `domainCode` 参数 > `.develop`；都没有 → 报错并列出候选 | 不写 `.develop`（MCP 非交互） | 绝不使用 VF 提示、绝不弹窗 |

### 4.3 `.develop` 写回格式

两种历史格式都要支持：

属性格式（当前 Java 桥/IDEA 主格式）：

```xml
<?xml version="1.0" encoding="UTF-8"?>

<Development Project="..." Uri="..." AdminTool="..." User="..." Password="..." LocalNioPort="-1" MetadataDomain="DOMAIN_CODE"/>
```

entry-key 格式（旧格式，`loadDevelop` 已支持）：

```xml
<properties>
  <entry key="Project">...</entry>
  <entry key="Uri">...</entry>
  <entry key="MetadataDomain">DOMAIN_CODE</entry>
</properties>
```

写回规则：

- 属性格式：只改根标签，不动子标签/注释；插入时放在根标签 `/>` 前。
- entry 格式：只改 `MetadataDomain` 对应 entry；没有则在 `</properties>` 前插入。
- 两种格式同时存在：都更新，保证 `loadDevelop` 的“后写覆盖”结果一致（当前实现先 entry 后 attribute，attribute 胜出）。
- 原子写：临时文件 + rename；POSIX `0600`。
- 不整文件重写；不丢未知属性/注释；不改换行风格。
- 写完后再用 `loadDevelop` 校验一次；解析不出 `metadataDomain` 视为写失败（防止静默损坏）。

### 4.4 VotaForge `busDomainCode` 的边界

- **语义不同**：`busDomainCode` 是 VotaForge 前端业务域（例如 `GroupChat_Inst_17790942612666`）；BAP `MetadataDomain` 是 panelxpro 元数据域。两者可能同名，也可能不同名；不能假设一一对应。
- **只读**：`readActiveBusDomainCode` 只读 `.votaforge/server-profiles.json`，不写任何文件。
- **只在 UI 提示**：仅在 `register*` 的 QuickPick 中，若 `busDomainCode` 与服务器候选**完全相等**，预选该项并在 `detail` 标注“仅提示，未自动写入”。
- **不自动写**：即使用户看到预选，也必须点击确认；`setDomain` 只在选择后调用。
- **不匹配不猜**：没有精确匹配时，不预选、不写回；`placeHolder` 提示“VotaForge 当前业务域 X 不在服务器列表中，请手动选择”。
- **MCP 不使用**：MCP 路径完全不读 VF 文件；只认 `domainCode` 参数或 `.develop`。
- **失败静默**：文件缺失/JSON 非法/超 256 KiB/字段缺失 → 返回 `undefined`，不影响注册流程。
- **不记录敏感信息**：只读 `id`/`busDomainCode` 两个字段用于提示；不打印整个 profile（可能含账号信息）。

---

## 5. 测试与验证

### 5.1 必跑命令

```bash
cd <仓库根>

# 1) TypeScript 类型检查（新增模块、导出、命令参数）
npm run typecheck

# 2) Java 桥编译（递归、干净构建）
npm run build:bridge

# 3) jar 内容校验：必须有 metadata 类，且不能有 stale class
jar tf packages/java-bridge/dist/lib/bridge-main.jar \
  | grep -E '^(cell/panelxpro/metadata/IPanelMetadataService|com/bap/dev/service/MetadataRpcClient|panelxpro/metadata/dto/|octo/cm/ruleengine/)'
jar tf packages/java-bridge/dist/lib/bridge-main.jar | grep 'BridgeMain\$StreamProgress.class' \
  && echo 'FAIL: stale class present' || echo 'OK: no stale class'

# 4) 完整构建 + 打包（stage-bridge / stage-skills / esbuild）
npm run build

# 5) 单测
npx vitest run packages/sdk/test packages/vscode-host/test
```

补充校验：

```bash
# 平台 jar 中不应出现同名 metadata 类（防止 classpath 遮蔽）
for j in packages/java-bridge/dist/lib/*.jar; do
  jar tf "$j" 2>/dev/null | grep -E '^(cell/panelxpro|panelxpro/metadata|octo/cm/ruleengine)' \
    && echo "CONFLICT: $j"
done

# 构建产物 classpath 顺序（extension.ts 应为 bridge-main.jar 在前）
grep -n "bridge-main.jar" apps/vscode/src/extension.ts
```

### 5.2 真实服务器冒烟（需用户授权）

新增 `packages/sdk/scripts/metadata-smoke.ts`，默认只读：

```bash
BAP_URI='ws://...' BAP_USER='...' BAP_PWD='...' \
  npx tsx packages/sdk/scripts/metadata-smoke.ts
```

脚本流程：

1. `createRpcClient` + `connect`。
2. `metadataConnect`。
3. `listDomains()`，只打印 `code/name`，不打印账号/密码。
4. 可选 `listFunctions(domain)`（只读）。
5. 受控写入（仅当显式设置环境变量）：

```bash
BAP_METADATA_WRITE=1 \
BAP_DOMAIN='TEST_DOMAIN' \
BAP_TEST_CLASS='com.example.TestRuleFunctions' \
BAP_TEST_METHOD='hello' \
BAP_URI='ws://...' BAP_USER='...' BAP_PWD='...' \
  npx tsx packages/sdk/scripts/metadata-smoke.ts
```

写入只针对测试工程/测试域，不提交、不发布；结束后 `metadataDisconnect` + `close`。

### 5.3 手工验收清单

1. 工程 `.develop` 无 `MetadataDomain`：在 Java 方法上右键 → `Register Method Rule Function` → 出现 QuickPick（不是死路）→ 选域 → `.develop` 出现 `MetadataDomain="..."` → 注册成功提示。
2. 再注册一次：不再弹 QuickPick，直接使用已配置域。
3. `Switch Metadata Domain`：无论是否已配置都列候选，当前值预选；选中新值后 `.develop` 更新；取消不写。
4. 类注册：弹模态确认；成功后提示注册数量；取消不发请求。
5. 重定向到另一服务器：`.develop` 的 `MetadataDomain` 被删除；再次注册会重新选域。
6. 下载新工程（VF 工作区）：下载完成后提示“重新加载后首次注册前运行 Switch Metadata Domain”。
7. VF `server-profiles.json` 的 `busDomainCode` 与服务器候选完全匹配时预选；不匹配时不预选，且不自动写。
8. MCP（若做）：带 `domainCode` 调用成功；不带且 `.develop` 无域 → 返回可用业务域列表；带错误类名 → 返回服务器 message，不崩溃。
9. 旧桥/旧扩展：调用 metadata 得到 `METADATA_UNAVAILABLE`，提示重建重装，不出现未捕获异常。
10. 密码不出现在输出面板、MCP 结果、异常消息中。

---

## 6. 风险、决策点与对抗式复核闭环

### 6.1 主要风险

| 风险 | 概率/影响 | 缓解 |
|---|---|---|
| 服务端未启用 metadata 服务或版本不兼容 | 中/阻塞 | 首次 `listDomains` 作为连通性验证；错误映射为 `METADATA_SERVICE_UNAVAILABLE`；文档给出排障 |
| DTO `serialVersionUID`/字段与服务器不一致 | 中/高 | 逐字复制 IDEA 源；不改包名/类名/字段；真实服务器冒烟；`InvalidClassException` 排障文档 |
| Java 8 匿名子类钻石/漏 `getAdapter()` | 高（若照抄不完整的示例代码）/编译失败 | 显式泛型 + `@Override getAdapter()`；`build:bridge` 作为 CI 门槛 |
| `out/`/`dist/lib` 残留旧 class | 高/运行时诡异 | `build.sh` 先 `rm -rf out dist/lib`；jar 内容校验 |
| `.develop` 被整文件重写导致域/注释丢失 | 中/高 | 原地补丁 + 原子写 + 解析回验；不 `replaceFirst("/>")` |
| 类/方法解析错误（多顶层类、嵌套类、分屏编辑器） | 中/中 | `package` + 文件 stem 优先；DocumentSymbol + 光标单词 + InputBox 兜底；editor 按 URI 对齐；注册前确认 |
| 未提交/未保存代码被注册 | 中/中 | 只在云端扫描；界面提示；文档说明 |
| 单线程 Java 桥被长注册阻塞，其它请求 30 s 超时 | 中/中 | `runWrite`/`runExclusive` 串行；建议 refresh 也入队；文档说明；批量操作避免并发 |
| VF `busDomainCode` 与 MetadataDomain 语义不同 | 高/中 | 仅精确匹配预选；绝不自动写；MCP 不用 |
| 重定向把旧域带到新服务器 | 中/高 | 换 URI 清空；同 URI 保留；单测覆盖 |
| 下载的新工程无域 | 高/UX | switchDomain 命令 + 下载后提示；P1 下载前选择 |
| `writeErr`/`destDir` JSON 转义缺陷 | 中/协议错乱 | GSON 序列化 name/message/destDir |
| `MetadataRpcClient` 误用 IntelliJ Logger | 高/编译失败 | 改用 `java.util.logging.Logger` |
| 误调 `IPanelMetadataService.get()` | 中/运行时失败 | 桥内禁止调用；只用 `getIntf(true)` |
| 只改 `tools.ts` 不加 `tool-exec.ts` | 高/功能缺失 | 两处都改；MCP 测试覆盖 |
| 硬编码 18/15 文档漂移 | 高/低 | 测试用 `BAP_TOOLS.length`；文档明确计数来源 |
| 密码泄漏到日志 | 中/高 | 只记录 domain/class/method/uri；错误消息不含 pwd；smoke 脚本不打印 |

### 6.2 待用户确认的决策点

1. **是否包含 `Switch Metadata Domain` 命令**：建议**是**，且放 P0。没有它，`.develop` 无域的新工程无法完成注册闭环；IDEA 也是独立 action。
2. **是否包含 MCP 两个工具**：建议**是**（P1）。注册是天然的非交互操作，AI 工作流价值高；成本约 0.5 人日，但会改工具数量与文档。若暂不需要，整段跳过，不影响 UI。
3. **是否允许真实服务器验证**：建议先只读 `listDomains`；写入验证使用测试工程/测试域，并显式授权。若不允许，交付时标注“编译/单测通过，服务端未联调”。
4. **重定向域策略**：换服务器清空、同服务器保留。建议**是**；如希望保留旧域，需要用户确认语义（可能误注册到错误域）。
5. **下载时的域选择**：P0 只做“下载后提示运行 Switch Metadata Domain”；P1 再做“下载前 QuickPick 并写入 Java 生成的 `.develop`”。建议先 P0，避免下载流程变复杂。
6. **嵌套类支持**：按 IDEA 的 `PsiClass.getQualifiedName()` 语义，用 `pkg.Outer.Inner` 点号形式。建议支持；若服务器拒绝，回退到顶层类 + InputBox，并在文档标注。
7. **菜单 placement**：编辑器右键用独立 `bap@1`/`bap@2`；是否加入 SCM 标题栏作为可选。建议 MVP 只做编辑器右键 + 命令面板，SCM 标题栏 P1。
8. **是否暴露 `listFunctions`**：MVP 不做 UI/MCP；P2 可加“查看已注册规则函数”。
9. **是否把 `metadataDomain` 加入 `workspaceInfo`**：MVP 不做（涉及返回结构/兼容）；P2 可选。
10. **`MetadataDomain` 属性名大小写**：写 `MetadataDomain`（与 IDEA/Java 桥一致）；读大小写不敏感。建议确认服务端/工具链没有强制其它拼写。

### 6.3 对抗式复核问题闭环

| 复核问题 | 本方案的处理 |
|---|---|
| 域从哪来、缺域是否死路 | `.develop` 为权威；缺失时 `listDomains` + QuickPick + 写回；取消才中止 |
| 集成点是否只写 UI | Java 接口/DTO/客户端、`BridgeMain`、`BridgeMethod`、SDK、宿主、MCP 全部列出 |
| 只加 `tools.ts` 没加 `tool-exec.ts` | 两处都列；MCP 测试断言 command 映射与执行分支 |
| 写操作用 `runExclusive` 不够 | 注册/`setDomain` 用 `runWrite`；只读用 `runExclusive`；UI 在队列外 |
| `DevelopConfig` 位置写错 | 明确在 `packages/sdk/src/types.ts` |
| 下载新工程没有域 | P0 下载后提示；P1 下载前选择 + Java 可选参数；switchDomain 兜底 |
| 硬编码 18/15 漂移 | 测试改 `BAP_TOOLS.length`；文档/技能同步 |
| metadata 前未 `ensureConnected` | SDK `ensureMetadataConnected` 前先 `ensureConnected` |
| 默认 30 s 超时 | TS/Java 双超时矩阵；注册 12 min / Java 10 min |
| 编辑器与参数 URI 不一致 | `resolveMethodTarget` 按 URI 对齐编辑器，必要时 `openTextDocument` |
| VF `busDomainCode` 无替代方案 | `server-profiles.json` 只读提示 + 精确匹配预选 + 服务器候选兜底 |
| 扫描器置信度 | 不实现完整 Java 扫描器；`package` + 文件 stem + DocumentSymbol + 单词/InputBox 兜底 |

---

## 7. 建议实施顺序

1. **P0-1 Java 桥**：复制 10 个 Java 文件 → 改 `build.sh` → 改 `BridgeMain`（metadata 分支 + `writeErr`）→ `npm run build:bridge` → jar 校验。
2. **P0-2 SDK**：`types.ts` → `develop.ts`（解析/补丁/测试）→ `metadata.ts` → `services.ts` → `index.ts`。
3. **P0-3 宿主 UI**：`java-source.ts` → `server-profiles.ts` → `command-router.ts` 三个命令 → `package.json` 菜单。
4. **P0-4 验证**：`npm run typecheck` → `npx vitest run ...` → `npm run build` → 手工验收（无域工程）。
5. **P1**：MCP 两工具 + `tool-exec.ts` + 测试/文档计数；下载前域选择；SCM 标题栏。
6. **联调**：真实服务器只读 `listDomains` → 测试域 `registerFunction` → `listFunctions` 验证；记录服务端版本与 DTO 差异。