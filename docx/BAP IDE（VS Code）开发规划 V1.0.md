# BAP IDE（VS Code）开发规划 V1.2

> 版本说明（相对 V1.1 的变更）：
>
> - **通信路线改为「Java 桥」**：不再用 TS 字节级复刻 Java 序列化，而是插件 bundle 一个 Java 进程（jar），
>   Java 侧复用官方 `com.leavay.nio.crpc` 客户端直接连 BAP Server；TS 与 Java 之间用 `stdin/stdout + JSON` 薄接口转接，避免在 JS 里复刻 Java 二进制序列化。
> - **Java 侧只暴露「原子化能力」**：即 `CJavaCenterIntf` 的方法集（连接/会话 + 原子方法转发），不含 MD5 对比、CommitPackage 组装、状态判断等业务逻辑——那些归 TS 侧 SDK/SCM。
> - **新增「SCM ↔ 原子化能力」桥接设计**：VS Code 原生 SCM 视图 ↔ BAP 原子能力，经 `bap-sdk` 中间层打通（基线 = 云端）。
> - **参考实现为生产级 IDEA 插件**：`/Users/lihongrui/IdeaProjects/PluginDemo`（`com.bap.dev.BapRpcClient`、`BapConnectionManager`、`ProjectRefresher`、`BapFileStatusService` 等）。
> - **Java 运行时依赖用户已装的 JDK**（BAP 开发者通常已有），插件只 bundle 几百 KB 的 jar，不捎带 JRE。
> - 保留 V1.1 的其他定位：完整 VS Code 插件、VS Code 原生 UI、一个 MCP tool ↔ 一个 `bapIde.*` 命令。

---

## 一、项目定位

### 1.1 愿景

BAP IDE 是一个**完整的 VS Code 插件**，面向 BAP 云工程提供开发全流程能力：

登录、拉取、同步、编辑、提交、发布、编译、单元测试、历史查询、重定位、依赖同步、Jar 扫描等。

通过 **Java 桥进程（经 WebSocket RPC）** 连接 BAP Server。

内部代码仍按 `rpc / sdk / core` 分层组织，保证可维护性与可测试性；

但**只面向 VS Code 一个宿主**，不做 Electron，不做独立 CLI。

### 1.2 UI 路线：VS Code 原生

整体 UI 全部采用 VS Code 原生能力，**不引入任何前端框架**（不用 React / Vue / Vite / Zustand 等）。

理由：

- SCM Provider（`vscode.scm.createSourceControl`）是 VS Code 官方为「非 Git 版本控制系统」预留的标准扩展点，
  可直接获得：改动清单、暂存/取消暂存、提交输入框（Enter 提交）、行内快速 diff、文件角标、`scm/title` 与 `scm/resourceState/context` 菜单等能力。
- 对以代码为中心的开发工具，原生列表 + 快捷键（Ctrl+Enter 提交、空格暂存）+ 编辑器内 diff 的手感，远优于自绘 UI。
- 复杂交互优先使用 VS Code 原生 UI：`QuickPick`、`InputBox`、`showInformationMessage/WarningMessage/ErrorMessage`、`withProgress`。
- 仅当需要展示富内容（日志、AI 对话、差异/发布预览）时，才用轻量原生 JS 的 Webview，**不引入前端框架**。

边界与约束：

- 不引入任何前端框架；不单独建设 UI 包，界面由插件本身以原生方式实现。
- BAP 无 Git HEAD，**语义映射：基线 = 云端**。即：Staged = 相对云端的本地待提交变更；Original（diff 左栏）= 云端版本；Commit = 提交到 BAP。
- 需要本地同步镜像目录（resourceUri 必须指向可打开的真实文件），并以 `TextDocumentContentProvider` 提供云端原版内容。
- 多工程：一个 BAP 工程一个 SCM provider（id / 角标 / 输入框独立）。
- SCM 视图塞不下表单，发布/部署等复杂流程由 SCM 触发生成原生对话框（QuickPick / InputBox）或原生 JS Webview。

### 1.3 AI 集成路线：MCP

插件向 Claude Code、Codex、Copilot 等 AI 工具**自动注册一个 MCP server**，
把命令面（`bapIde.*`）暴露为 MCP tools。

**一个 MCP tool ↔ 一个 VS Code 命令。**

这样 AI 无需为 BAP 各自编写 skill，即可直接驱动云工程操作。

### 1.4 通信路线：Java 桥

RPC 与 BAP Server 的通信**复用一个 Java 桥进程**，而不是在 TS 里字节级复刻 Java 序列化。

背景：BAP CRPC（`com.leavay.nio.crpc`）基于 Netty，消息体是 **Java 原生序列化**（`ObjectOutputStream`）包裹的自定义二进制协议。
用 TS 1:1 复刻需要精确还原 `classdesc`、字段排序、对象引用表（handle）、modified-UTF-8、集合类 `blockdata` 等细节，
字节级极易出错（真实服务端反序列化 `CSession` 时即出现 handle 越界），且难以维护。

因此改为「**让真正的 Java 去做序列化**」：

```
VS Code 插件（TS）
   │  stdin/stdout + JSON（薄接口，类 HTTP）
   ▼
Java 桥进程（bundle 的 jar，常驻）
   │  复用官方 com.leavay.nio.crpc 客户端（WebSocket + 序列化 + 心跳，全在 Java 侧）
   ▼
BAP Server（ws://<host>:<port>）
```

- **Java 侧**：直接用 `com.leavay.nio.crpc` 连 Server，持有 WebSocket 长连接 + 心跳 + 会话上下文，序列化完全交给官方实现（协议 100% 正确）。
- **TS 侧**：只通过 `stdin/stdout` 用 JSON 发 `{ method, params }`，收 `{ result | error }`。TS 拿到的是普通 JSON，处理方式接近 HTTP REST。
- **Java 运行时**：依赖用户已装的 JDK（BAP 开发者通常已有）。插件只 bundle 几百 KB 的 jar，不捎带 JRE；检测不到 Java 时给出明确安装提示。

取舍：代价是**依赖 JVM**、需管理桥进程生命周期；换来的是**协议零风险、开发量大幅下降、维护容易**。
之前用 TS 复刻的 Connection/Codec/Serializer 保留为「不依赖 JVM 的降级方案」，不作主路径。

---

## 二、总体架构

```
                    BAP Server
                        │
                WebSocket RPC
                        │
              Java 桥进程（bundle 的 jar）
                        │  com.leavay.nio.crpc
                        │
                   bap-rpc（TS）
                        │  stdin/stdout + JSON
                        │
                 bap-sdk（TS）
                        │
                   core（TS）
                        │
                 vscode-host
                        │
               命令面（bapIde.*）
                  │         │
          VS Code 原生 UI   MCP Server
          （SCM/TreeView/     │
            Command/Webview） │
                           AI 工具
                  （Claude Code / Codex / Copilot）
```

> 说明：`bap-rpc`（TS）与 BAP Server 之间隔了一个 **Java 桥进程**。TS 不再直接连 WebSocket、不做字节编解码/序列化，
> 只经 JSON IPC 与 Java 桥通信；真正的 WebSocket、协议、序列化、心跳全部在 Java 侧（复用官方 CRPC）。

整个插件内部划分为四层：

### 第一层：RPC Runtime（bap-rpc）

负责与 **Java 桥进程**通信（TS 侧部分）：

- 拉起 Java 桥子进程（`java -jar <bridge>.jar`）
- `stdin/stdout` JSON 文本协议（请求 / 响应 / 事件）
- 请求发送与等待（Promise 化）
- 超时控制、进程生命周期管理
- Java 侧：WebSocket、RPC 协议、序列化、心跳、会话上下文（全部复用官方 `com.leavay.nio.crpc`）

TS 侧不依赖 VS Code。Java 桥是随插件分发的 jar 资产。

---

### 第二层：BAP SDK（bap-sdk）

负责：

- 登录
- 项目管理
- 代码管理
- 提交
- 发布
- 调试
- 资源管理

SDK 不暴露 RPC。

SDK 面向业务。

例如：

```
sdk.login()

sdk.publish.gray()

sdk.project.list()

sdk.code.save()
```

而不是：

```
rpc.invoke(...)
```

---

### 第三层：Core（core）

公共模型：

```
DTO

Event

Model

Utils
```

避免业务与宿主之间重复。

---

### 第四层：VS Code Host（vscode-host）

插件本体，负责所有 VS Code 原生能力：

- SCM（代码变更主界面）
- TreeView（左侧导航）
- Command（命令面）
- StatusBar
- QuickPick / InputBox（表单与向导）
- Webview（日志、AI、预览等富内容）
- MCP Server（把命令面暴露给 AI 工具）

这里不写 RPC 细节，只编排 SDK 并呈现 UI。

---

## 三、技术栈

## Runtime

- TypeScript
- Node.js

---

## RPC

- **通信面（TS）**：子进程 + `stdin/stdout` JSON-lines，Promise / Async-Await
- **传输面（Java）**：官方 `com.leavay.nio.crpc`（WebSocket + Java 原生序列化 + 心跳）
- 运行时依赖：用户 Java（运行时触达 `java` 可执行）

---

## UI

- VS Code 原生 UI（SCM / TreeView / Command / StatusBar / QuickPick / InputBox / Webview）
- 仅日志、AI 等富内容使用原生 JS Webview，不引入前端框架

---

## AI 集成

- MCP（Model Context Protocol）
- 一个 MCP tool ↔ 一个 `bapIde.*` 命令

---

## 状态管理

无需前端状态管理库。

---

## UI 风格

尽量遵循 VS Code 原生设计。

颜色全部使用 VS Code Theme Variables。

避免与编辑器整体风格割裂。

---

# 四、目录规划

```
bap-ide/

    packages/

        rpc/

        sdk/

        core/

        vscode-host/

    apps/

        vscode
```

说明：

## rpc

RPC Runtime（TS 侧通信面）。

负责：

- 拉起 Java 桥子进程
- `stdin/stdout` JSON 协议（请求 / 响应 / 事件）
- 请求等待与超时、进程生命周期

不依赖 VS Code。

---

## sdk

业务能力封装。

例如：

```
ProjectService

PublishService

CodeService

ResourceService
```

所有业务均调用 SDK。

---

## core

公共模型（DTO / Event / Model / Utils）。

避免业务与宿主之间重复。

---

## vscode-host

插件本体，唯一依赖 VS Code Extension API。

包括：

```
SCM

TreeView

Command

StatusBar

QuickPick / InputBox

Webview

MCP Server
```

这里不写 RPC 细节，只做编排与呈现。

---

# 五、RPC 迁移方案（Java 桥，参考生产插件）

生产级 IDEA 插件（`/Users/lihongrui/IdeaProjects/PluginDemo`）已实现整套链路，关键事实：

- RPC 核心为 `com.leavay.nio.crpc`，基于 **Netty 4.1.36** 的自研 CRPC 框架（位于 `tcmcat-*.jar` 依赖，随 IDE 插件库分发）。
- 远程服务接口：`CJavaCenterIntf`（BAP Server 的所有**原子化能力**）。
- 客户端包装：`CRpcClientWrapper<T>(T.class, uri)`。
- 会话上下文：`CRpcAdapter.setGlobalContext(CDaoConst.CTX_SESSION, _session)`。
- 单次调用超时：`CRpcAdapter.setTempTimeout(...)`。

现有 Java 调用链：

```
Service

↓

Proxy

↓

CRpcProxyCaller

↓

CRpcClient

↓

CRpcCodec

↓

CNioSerializer

↓

WebSocket
```

迁移到 TypeScript 时，**不做字节级复刻**。

上面调用链中最棘手的部分是 `CNioSerializer`（Java 原生序列化格式）：需要字节级还原 `classdesc`、
字段排序（primitive 前、引用按字典序）、对象引用表（handle）、modified-UTF-8、`HashMap`/集合类 `blockdata` 等。
任何一位 handle 或一个字节差异，都会让服务端 `ObjectInputStream.readObject()` 抛
`InvalidClassException` / `ClassCastException`。

**实测结论**（见「RPC迁移-Java对照与真实服务端验证报告」）：TS 复刻的序列化器在解析真实服务端返回的
`com.cdao.mgr.CSession`（嵌套 bean、多 String 字段 `typeString` 复用同一 handle）时，
出现 `SERIALIZER_HANDLE: reference to unknown handle 0x7e0005` —— 证明字节级复刻成本高且易错。

## Java 桥方案（原子化转发）

让**真正的 Java 去做序列化**，且 **Java 侧只暴露「原子化能力」**（即 `CJavaCenterIntf` 的方法集），
不含任何业务逻辑（不算 MD5、不组装提交包、不判状态）。

### 参考实现（生产级 IDEA 插件）

生产插件源码：`/Users/lihongrui/IdeaProjects/PluginDemo/src/main/java`。核心：
`com.bap.dev.BapRpcClient`（连接 + 会话管理），`com.bap.dev.service.BapConnectionManager`（共享长连接），
`com.bap.dev.handler.ProjectRefresher`（变更计算），`com.bap.dev.service.BapFileStatusService`（状态表）。

`BapRpcClient.java`（权威）：
```java
public class BapRpcClient {
    CRpcClientWrapper<CJavaCenterIntf> rpcWrapper;
    public void connect(String uri, String user, String pwd) { // 建 wrapper → login(user,pwd) → setGlobalContext(CTX_SESSION, session)
    }
    public CJavaCenterIntf getService() { return rpcWrapper.getIntf(true); } // 原子能力入口
    public void shutdown();
    public boolean ping();
}
```

### 架构

```
TS（bap-rpc：原子化能力转发 + 会话句柄）
  │  stdin/stdout JSON-lines
  ▼
Java 桥进程（bundle jar，常驻）
  │  BapRpcClient.connect(uri,user,pwd) → login → 会话入全局 context
  │  call(method, args) → 反射转发到 CJavaCenterIntf（原子方法）→ DTO 转 JSON 回传
  ▼  com.leavay.nio.crpc（WebSocket + Java 原生序列化 + 心跳）
BAP Server
```

### 原子化定位（关键约束）

**Java 桥只做两件事**：
1. **连接/会话**：`connect(uri,user,pwd)`（含 login + 会话入全局）、`disconnect()`、`ping()`。
2. **原子调用转发**：`call(method, args)` —— 把 `CJavaCenterIntf` 的某个方法（如 `commitCode`、`queryCodeFile`）用反射调用，返回结果转 JSON。

**Java 桥不做**（这些属于 TS 侧 SDK/SCM 的职责）：
- 不算本地/云端 MD5、不判 NORMAL/MODIFIED/ADDED/DELETED —— 那是 TS 侧 `refresh()` 的逻辑。
- 不组装 `CommitPackage` —— TS 侧把勾选文件组织成 JSON，Java 桥只负责转发。
- 不管理 `.develop`、不解析工程配置 —— TS 侧读配置文件。

这样 Java 桥能复用官方序列化，但保持「薄、透明、无业务」，便于长期维护。

### JSON 协议（stdin/stdout，JSON-lines）

**请求（TS → Java）**：
```jsonc
{ "id": 1, "method": "connect",    "params": { "uri": "ws://...", "user": "root", "pwd": "..." } }
{ "id": 2, "method": "call",       "params": { "method": "commitCode", "args": [ "<projectUuid>", { "...CommitPackage JSON..." } ] } }
{ "id": 3, "method": "call",       "params": { "method": "queryCodeFile", "args": [ "<projectUuid>", "core" ] } }
{ "id": 4, "method": "disconnect" }
{ "id": 5, "method": "ping" }
```

**响应（Java → TS）**：
```jsonc
{ "id": 2, "ok": true,  "result": { /* DTO 转 JSON */ } }
{ "id": 2, "ok": false, "error": { "type": "NoFolderException", "message": "..." } }
```

**事件（Java → TS 主动）**：长任务进度 / callback 回调（预留）：
```jsonc
{ "event": "progress", "payload": { ... } }
```

**DTO 序列化规则**：Java 侧用 JDK 反射把返回值（`CJavaProjectDto`/`CJavaCode`/`Map<...>`/`List<...>`/`CSession`）转成 JSON 对象；
参数同理把 TS JSON 反序列化成方法所需类型。只透传返回给 TS，参与序列化的 DTO 字段由反射枚举（Getter + 字段）。

### SDK 对外接口（不变）

无论底层是 TS 复刻还是 Java 桥，`bap-sdk` 面向业务的接口保持一致：

```
sdk.login()          → 登录，返回会话句柄
sdk.project.list()   → 项目列表
sdk.code.save()      → 保存代码
sdk.publish.gray()   → 灰度发布
```

底层统一调用（TS 侧封装）：

```
rpc.invoke(className, method, params) → JSON RPC 到 Java 桥
```

目标：

Java 桥复用官方客户端，**序列化与 Java 服务端天然兼容，无需修改服务端**。

---

## SCM ↔ 原子化能力 桥接设计

VS Code 的**原生 SCM（Source Control）**视图 + BAP 的**原子化能力**，通过中间层 `bap-sdk` 打通。
映射关系参考生产 IDEA 插件（`ProjectRefresher`/`BapFileStatusService`/`CommitAllAction`/`PublishProjectAction`）。

> 本小节是 §五 下的桥接设计，独立于上方「Java 桥方案（原子化转发）」，但二者配套：
> Java 桥负责**原子化转发**（§五上），本小节负责**语义映射**（把 VS Code SCM 概念映射到这些原子能力）。

### 语义映射（基线 = 云端）

BAP 无 Git HEAD，**「云端」就是唯一真相源**。对应到 VS Code SCM：

| VS Code SCM 概念 | BAP 能力 | 实现 |
|---|---|---|
| 资源组（Changes 列表） | 变更状态集 | `refresh()`：`queryCodeFile`+`queryAllFileMap` 取云端 MD5 快照 → 遍历本地 `src/*` 算 MD5 对比 → M/A/D 集合 |
| 状态 M/A/D | `BapFileStatus` | `MODIFIED`=本地与云端 MD5 不同；`ADDED`=本地有云端无；`DELETED_LOCALLY`=云端有本地无（0 字节/空内容标记） |
| `originalUri`（diff 左栏/行内 diff） | 云端原版 | `getJavaCode`/`getResFile` 取云端内容 → 写临时文件作为 `TextDocumentContentProvider` |
| 提交（Commit） | `commitCode` | 勾选文件组织成 `CommitPackage` JSON → `commitCode(projectUuid, pkg)` |
| 发布（Publish） | `rebuildAll`+`exportProject2Plugin` | 单独命令/SCM 按钮，二者串行 |
| 还原/更新（discard/update） | `getJavaCode`/`getResFile` | 取云端内容覆盖本地 |
| 文件历史 | `queryFileHistory`/`getHistoryCode` | 命令触发 |
| 工程历史 | `queryVersionList` | 命令触发 |

### 关键点

- **`src/` 一级子目录 = 云端 folder**：本地 `src/<folder>/<包路径>/*.java`，Java 文件全类名 = folder 剥掉后的包路径 + 类名；`src/res/*` = 资源。
- **`.develop` 配置**：workspace folder 下的工程标识文件，含 `Project`(UUID)/`Uri`/`User`/`Password`/`AdminTool`。TS 侧 SDK 解析，作为 `refresh`/`commit` 的上下文。
- **提交是「增删改」四合一**：`CommitPackage{ comments, mapFolder2Codes, deleteCodeMap, mapFolder2Files, deleteFileMap }`，一次 `commitCode` 原子提交。SCM「暂存区」= 用户在 SCM 视图勾选的文件集合，服务端无两阶段。
- **`refresh` 复刻**：`workspace.onDidChangeTextDocument` + `onDidCreateFiles/onDidDeleteFiles` → debounce → 重新 diff → SCM provider `fireDidChange`。

### 变更状态判定的 MD5 规则（复刻 ProjectRefresher）

- Java：本地内容 `\r\n`→`\n` 后算标准 MD5 == 云端 md5 → NORMAL；不等再取云端原文做 **loose MD5**（去所有空白）比对，等则 NORMAL（容忍格式化差异）；否则 MODIFIED。
- 资源：字节 MD5 直接比对。
- 本地 0 字节/空白 → DELETED_LOCALLY。

---

# 六、RPC 工作拆分（Java 桥，原子化转发）

建议按「先原子、后桥接」的顺序完成：

## 第一阶段：Java 桥骨架（原子化）+ TS 通信面

- Java 侧：`BapRpcClient`（connect/login/shutdown/ping）+ `call(method, args)` 反射转发到 `CJavaCenterIntf`
- TS 侧：子进程拉起 + `stdin/stdout` JSON-lines 协议（请求/响应）
- 验证：`rpc.call("login", [user, pwd])` 经 Java 桥登录成功（拿到会话句柄）
- **不做**：MD5 对比、CommitPackage 组装、状态判断（均留给 TS）

无需 TS 复刻字节协议。

---

## 第二阶段：TS SDK 业务层（负责「原子化之外」逻辑）

- TS 侧封装 `sdk.project.list()` / `sdk.code.save()` / `sdk.publish.gray()`
- TS 侧实现：读 `.develop` 配置、MD5 对比（refresh 变更计算）、组装 `CommitPackage` JSON
- Java 桥保持透明：只转发 `call(method, args)`
- 验证：`refresh()` 能算出 M/A/D 状态集；`commitCode` 能提交本地变更

---

## 第三阶段：SCM 桥接

- `vscode.scm.createSourceControl` + SCM 资源组映射 M/A/D
- `originalUri` ← 云端原版（`getJavaCode`/`getResFile` 写临时文件）driving 行内 diff
- 提交（Commit）→ `commitCode`；发布（Publish）→ `rebuildAll`+`exportProject2Plugin`
- 验证：VS Code SCM 视图能展示云端基线差分，文件能提交/发布/对比/还原

---

## 第四阶段：进程生命周期与稳定

- Java 桥启动/关闭/崩溃重启
- 连接、心跳、超时由 Java 侧官方实现
- 验证：进程异常后能重启，连接能重连

至此 Runtime 完成（以 Java 桥形式）。

---

# 七、VS Code 插件规划

## 代码变更主界面（SCM）

采用 VS Code 原生 Source Control（SCM）视图。

绑定 `vscode.scm.createSourceControl`，提供：

- 改动 / 已暂存 分组
- 提交输入框（Enter 提交）
- 行内快速 diff 与 Diff 视图（原版 = 云端，via `QuickDiffProvider` + `TextDocumentContentProvider`）
- `scm/title`、`scm/resourceState/context` 菜单（刷新 / 提交 / 发布 / 放弃更改 / 暂存 / 取消暂存）
- 文件角标装饰

---

## 表单 / 向导（原生 UI）

登录、发布配置、灰度量、日志、AI、设置等优先使用 VS Code 原生 UI：
`QuickPick`、`InputBox`、`showInformationMessage/WarningMessage/ErrorMessage`、`withProgress`；
仅当展示富内容（日志、AI 对话、差异 / 发布预览）时才使用轻量原生 JS Webview。

---

## 命令（命令面）

统一通过 Command 注册，命令面即 `bapIde.*`。

例如：

```
BAP: Login

BAP: Publish

BAP: Sync

BAP: Open Project

BAP: Commit
```

命令面同时是 MCP tool 的来源（见下）。

---

## MCP 集成

插件自动注册一个 MCP server，把命令面暴露给 AI 工具（Claude Code / Codex / Copilot）。

要点：

- **注册方式**：贡献点 `contributes.mcpServerDefinitionProviders`（package.json，声明 id + label）＋
  `vscode.lm.registerMcpServerDefinitionProvider(id, provider)`（activate 时注册实现）——两步配套，缺一不可。
  AI 工具无需手工配置即可发现。（API 以 VS Code 1.135 的 `vscode.d.ts` 为准。）
- **server 定义**：`provideMcpServerDefinitions()` 返回 `McpStdioServerDefinition`（本地子进程）或 `McpHttpServerDefinition`（Streamable HTTP 端点）。
  BAP 优先用 stdio（`node mcp-server.js`）。
- **登录钩子**：`resolveMcpServerDefinition(server, token)` 在 server 真正启动前被调用，可在此做登录校验、注入 session；返回 undefined 可中止启动。
- **映射**：一个 MCP tool ↔ 一个 `bapIde.*` 命令；tool 的输入 schema 由命令参数声明派生。
- **执行**：MCP server 进程在扩展宿主之外，不能直接调命令；经本地 IPC 把 tool call 转发回扩展宿主，由宿主执行 `vscode.commands.executeCommand(commandId, ...args)` 并回传结果。
- **命令分类**：
  - 可暴露为 tool（非交互）：download / commit / publish / compile / history / fetch-current / relocate / sync-libs / unit-test / scan-jars / login 等。
  - 不暴露为 tool（交互式）：打开 diff、打开文件、SCM 暂存等——需要编辑器 UI 参与，MCP 只做「触发」并回「已打开」，或干脆不暴露。

---

# 八、开发阶段

## 第一阶段

目标：

RPC Runtime（Java 桥形态）。

验证：

```
sdk.login()
```

经 Java 桥（子进程 + JSON IPC）能够正常登录，拿到会话句柄。

此阶段无需任何 UI。

---

## 第二阶段

完成 SDK。

实现：

项目

代码

资源

提交

发布

全部迁移。

---

## 第三阶段

实现 VS Code Host。

包括：

SCM Provider（改动清单 / 提交 / diff / 发布菜单）

TreeView

Command

StatusBar

Workspace

Editor

---

## 第四阶段

UI（VS Code 原生）。

完成：

- SCM：改动清单、暂存、提交、diff、发布菜单
- 原生 UI：登录、发布、日志、AI、配置（QuickPick / InputBox / 原生 JS Webview）

---

## 第五阶段

MCP 集成。

完成：

- 自动注册 MCP server
- 命令面 → MCP tools 自动生成
- 非交互命令可被 Claude Code / Codex / Copilot 调用

---

## 第六阶段

完成完整开发闭环。

开发者（人）能够：

登录

↓

打开项目

↓

同步代码

↓

编辑

↓

提交

↓

发布

↓

查看日志

同时 AI（经 MCP）能够执行同一套云工程操作。

---

# 九、长期规划

BAP IDE 就是一个**完整的 VS Code 插件**，不再规划多宿主。

长期目标收敛为：

1. **人可操作**：通过 VS Code 原生 UI（SCM / TreeView / Command）完成云工程全流程。
2. **AI 可操作**：通过 MCP 把同一套命令面暴露给 Claude Code / Codex / Copilot。
3. **协议稳定**：RPC 由 Java 桥（复用官方 `com.leavay.nio.crpc`）承载，序列化与 Java 服务端天然兼容、无侵入，长期无需改服务端。

业务能力、RPC 通信面（TS）、SDK 保持平台无关，以便未来若需要可复用；

但 UI 与集成以 VS Code 为主，不做 Electron、不做独立 CLI。Java 桥是唯一引入的 JVM 依赖（BAP 开发者通常已有 JDK）。
