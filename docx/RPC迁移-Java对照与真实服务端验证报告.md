# BAP IDE RPC 迁移 —— Java 版对照与真实服务端验证报告

> 日期：2026-08-29
> 目的：① 对比 Java 版 CRPC 完整实现，找出 TypeScript 版 `@bap/rpc` 还缺什么；② 用真实 BAP Server 验证连接/登录链路；③ 记录验证中发现的缺陷。
> 参考 Java 端：`/Users/lihongrui/SynologyDrive/kwaidoo/eclipse_plugin/Plugin`（源码）+ `com.leavay.nio.crpc`（JAR，`tcmcat-srvcommon.jar` 等）。

---

## 一、现状：我们已经完成了什么

`@bap/rpc`（`packages/rpc`）四阶段已全部落地并带单测（55 tests 全绿）：

| 阶段 | 模块 | 状态 |
|---|---|---|
| ① Connection | WebSocket 连接 / 重连 / 心跳 / 超时 | ✅ |
| ② Codec | 13 字节 Header 编解码 + 消息体建模 | ✅ |
| ③ Serializer | Java 序列化复刻器（ObjectOutputStream 字节级） | ✅（golden 验证） |
| ④ RpcClient | invoke / wait / callback / context / 超时 | ✅ |

客户端侧「invoke 发请求 → 等响应」的**主链路已完整**：`RpcClient.invoke(className, method, params)` → `Codec.encode`（13B header + `serializeBody`）→ `Connection.send` → 服务端 → 响应 `decode` → `deserializeBody` → 按 reqID resolve。

---

## 二、对照 Java：我们缺什么

用 `javap` 反编译 Java CRPC 全类，把「完整能力」与我们现有实现逐项对照。分三类：**已做但需补强**、**完全缺失**。

### 2.1 已做但需补强

| 能力 | Java 位置 | 我们现状 | 差距 |
|---|---|---|---|
| context 会话注入 | `CRpcAdapter.getGlobalContext/setGlobalContext` + `_ctxThreadLocal` | 有 `setGlobalContext` + 深拷贝注入每个 request | **缺「线程级」二级语义**（Java 是 global + thread 两级，请求时 thread 覆盖 global），目前仅一级。 |
| 临时超时覆盖 | `CRpcAdapter.setTempTimeout(long)`（ThreadLocal，单次生效） | 有 `setTempTimeout`（one-shot） | 已对齐，但未实现 Java 的 `IgnoreTmpTimeout` 集合（如 `ping` 忽略临时超时）。 |
| 错误体系 | `CRpcMsgException`（携带 reqID/type）、`CRpcDisconnectException` 等十多个 | 有 `CRpcError/CRpcTimeoutException/CRpcNotConnectedError` | 错误类型偏少、未携带 reqID/type 元数据；未对齐 `CRpcMsgExceptionIntf`。 |
| 心跳保活 | `CRpcClientFactory._pingThread` 应用层 Ping + `CRpcChecker.checkHealth` | 有协议层 ping（`ws.ping`）+ pong 超时 | **缺应用层 CRpcPing**（Java 发 `CRpcPing` 消息帧，我们只发 WS ping 帧）；缺健康检查。 |
| 连接池 + 复用 | `CRpcClientFactory._clientCache`（按 URI 缓存 client） | 有静态 URI 缓存（`CONN_CACHE`，RpcClient 内） | 我们缓存的是「Promise<RpcConnection>」，但未做**主动 remove/惰性回收**，断连后不会从缓存剔除。 |
| 分片帧 | `AbstractWsPocessor.handleContinueFrame`（body > 65000 分 Continuation 帧） | 未做 | 大消息（byte[] 导出）会触发分片，`ws` 库虽能自动重组部分，但我们的 mock/测试未覆盖。 |

### 2.2 完全缺失（TS 客户端不会用到，但属 Java 完整实现）

| 缺失块 | 说明 | 是否需要 |
|---|---|---|
| **服务端（CRpcServer）** | 反射分发 + `registService` 注册服务 + 线程池执行 | TS 是客户端，**不需要**做服务端。 |
| **双向 callback 下发链路** | `CallbackCache` 服务端导出回调 + `CallbackUtil` 主动调客户端 | 目前只做了「基础 callback」（客户端收 CALLBACK_REQ、回 CALLBACK_RSP）。**复杂 callback 未做**：`CRpcCallbackStub` 参数/返回值透传、服务端主动推送。 |
| 动态代理生成 | Java 运行时生成 `_CRpcProxy` 源码 + ECJ 编译 | TS 用 `invoke(className, method, params)` 直调，**不需要**复刻。 |
| TinyService 专用通道 | `TsRequest`/`TsRpcExecuter`（`EXT_TINY_SERVICE` 字节标记） | 服务端侧，客户端不直接涉及（除非对接 TinyService 方法）。 |
| cson/Flutter 第二编解码通道 | `CWsCsonRpcHandler`/`flutter.rpc.*` | 若服务端实际启用 cson 通道而非 ObjectStream，则需确认。**待实测确认走哪条通道**。 |
| 会话级 KV 缓存 | `CWsChannelCache` | 服务端侧。 |
| 进度回调 | `IProgress`/`CRpcProgressClient/Server` | BAP 长任务（编译/下载）可能用到，属 callback 的扩展，暂缓。 |

### 2.3 值得一提的实现差异（TS 侧更优 / 已规避）

- **代理**：Java 动态生成源码+编译代理类；TS 直接 `invoke(className,...)`，无此复杂度。✅ 已规避。
- **字段序列化顺序**：Java 默认序列化按 `ObjectStreamField` 排序（primitive 前、引用按字典序）；TS 复刻已按此实现并通过 golden 验证。✅
- **reqID 精度**：TS 公共 API 用 `number` + 底层 BigInt，`|reqID| > 2^53` 抛 `ReqIdRangeError`，比 Java 的 long 更防御。✅

---

## 三、真实 BAP Server 验证实证

**目标地址**：`ws://175.178.82.117:2020`，`root` 账号。

### 3.1 结果摘要

| 步骤 | 结果 |
|---|---|
| WebSocket 连接 | ✅ **成功**（`CONNECTED: connected 175.178.82.117`，握手完成） |
| 发送 RPC 请求 | ✅ **成功**（login 请求打包 13B header + Java 序列化 body，reqID=1 发出） |
| 收到服务端响应 | ✅ **成功**（收到 451 字节，type=2 RPC_RSP） |
| 反序列化响应 | ❌ **失败**（`SERIALIZER_HANDLE: reference to unknown handle 0x7e0005`） |

**关键判断**：连接、握手、发请求、服务端理解并返回响应这四步**全部走通**——说明我们的 Header 编解码、WebSocket、请求封装与 Java 服务端**基本协议兼容**。唯一断点落在「**反序列化服务端返回的复杂 bean（CSession）**」这一步。

### 3.2 反序列化缺陷详情（真实响应暴露的 bug）

服务端返回的是 `CRpcResponse{ reqID=1, err=null, result=com.cdao.mgr.CSession }`。我们用 trace 工具逐 handle 解析真实 451 字节，得到的 handle 分配：

```
com.leavay.nio.crpc.CRpcResponse  cd assign=0x7e0000
  err  typeString "Ljava/lang/Throwable;" assign=0x7e0001
  result typeString "Ljava/lang/Object;" assign=0x7e0002
com.cdao.mgr.CSession  cd assign=0x7e0003
  pwd      typeString "Ljava/lang/String;" assign=0x7e0004
  userAlias typeString REF(0x7e0005)   ← 引用尚未被我们登记
  userCode  typeString REF(0x7e0005)   ← 同上
  userGid   typeString "Lcom/cdao/impl/entity/field/GID;" assign=0x7e0005 ← 我们 assign 覆盖了 0x7e0005
```

**比对 Java 侧**（用 `javac` 现场生成等价 bean 场景 golden，得到权威 handle 分配）：

```
（单 bean，3 个 String 字段）H3$DTO cd assign=0x7e0000
  pwd      typeString "Ljava/lang/String;" assign=0x7e0001
  userAlias typeString REF(0x7e0001)   ← 正确引用 pwd 的 String
  userCode  typeString REF(0x7e0001)
```

**根因**：Java 的 `writeTypeString` 对 `"Ljava/lang/String;"` 这类**类型描述符字符串按内容去重**（同一值复用同一个 handle）。一个 bean 内 `pwd`/`userAlias`/`userCode` 都是 `String` 字段 → 它们的 typeString **全是同一句柄** `0x7e0001`，后两者用 `TC_REFERENCE` 引用。

而我们的 reader 在 `readTypeString` 处（`packages/rpc/src/serializer/reader.ts`）**没有对「同样内容的 typeString 字符串」做去重登记**，导致：
- `pwd` 的 `"Ljava/lang/String;"` assign 0x7e0004（正确）
- `userAlias` 读到 `TC_REFERENCE 0x7e0005`，但 0x7e0005 在我们表里尚未登记 → **抛 `HandleTableError`**

同样，我们的 writer（`writer.ts` 的 `writeTypeString` → `writeString`）理论上会对相同字符串 lookup 后写 REF，**但 readTypeString/readClassDesc 的 handle 计数与 Java 不完全对齐**（尤其嵌套 bean 时）。

### 3.3 修复方向

对齐 Java 的 handle 语义：
1. **reader 的 `readTypeString`**：遇到 `TC_STRING` 时，先查 handle 表是否已有同内容字符串（`java/lang/String` 等），若有则 `register(value, handle)`（登记到当前 handle 但不新建句柄），否则 assign。保证同一 typeString 内容复用同一 handle。
2. **writer 的 `writeTypeString`**：确认对内容去重（`writeString` 已 lookup，需验证它记录的是「String 对象」而非「值」的句柄，与 reader 对称）。
3. **`readClassDesc`** 的 classdesc 自身 handle 分配顺序：确认与 Java 的 `writeNonProxyDesc`（先 super 后子类、className 用 writeUTF 不占 handle）完全一致。
4. 用 Java `javac` 生成的 golden（H3 场景：bean 多 String 字段，typeString 去重引用）补一条 **round-trip 单测**，确保修完不再回归。

目前 `packages/rpc/src/serializer/handle-table.ts` 已具备 `assign/lookup/register/resolve`，`reader.ts`/`writer.ts` 已分离，修复点是局部算法调整，不涉及协议层改动。

---

## 四、结论与下一步

### 4.1 总体判断

1. **RPC 主链路已通**：WebSocket 连接、13 字节 Header 编解码、请求封装、服务端响应接收 —— 与 Java 服务端**基本兼容**，方向正确。
2. **达标基线的单一阻塞项**：反序列化服务端返回的**复杂 bean**（`CSession`、多 `String` 字段 typeString 去重）时 handle 计数偏离 Java，导致 `SERIALIZER_HANDLE`。**修复此点即可达成「能 `sdk.login()`」的第一阶段验证目标。**
3. **完整性缺口**：相对 Java 完整实现，不缺客户端主链路；缺的是**应用层保活（CRpcPing)/健康检查、context 二级语义、完整 callback（含 Stub 透传）、错误元数据、分片帧**。服务端、TinyService、cson 通道、会话缓存等属服务端职责，客户端不需要。

### 4.2 建议下一步（按优先级）

1. **修复序列化 handle 去重**（3.3），补 round-trip 单测，复连真实 server 验证 `login` 拿到 `CSession`。
2. **补应用层心跳**：发 `CRpcPing`（type=1 的 CRpcRequest）替代/补充协议层 ping，对齐 Java `_pingThread`。
3. **补 context 两级语义** + `CRpcError` 携带 reqID/type 元数据。
4. **完整 callback**（`CRpcCallbackStub` 透传，供服务端主动回调 / 进度回调）—— 视 BAP 长任务需求决定优先级。
5. **确认服务端编解码通道**：ObjectStream vs cson，避免 channel 错配（目前 ObjectStream 已收到合法响应，暂判主通道是 ObjectStream）。

### 4.3 待办清单（供后续开发排期）

- [ ] `reader.ts`/`writer.ts`：typeString 内容去重 handle 对齐 + `readClassDesc` 顺序校准
- [ ] 新增 Java golden（多 String 字段 bean）round-trip 单测，全量回归
- [ ] 复连真实 server（`ws://175.178.82.117:2020`, root）验证 `sdk.login()` 返回 `CSession`
- [ ] 应用层 `CRpcPing` + `CRpcChecker.checkHealth` 健康检查
- [ ] `CRpcAdapter` 级 context（global + thread）两级语义
- [ ] 完整 callback：`CRpcCallbackStub` 序列化 + 服务端主动回调
- [ ] 分片帧（body > 65000 的 Continuation 帧）测试覆盖
