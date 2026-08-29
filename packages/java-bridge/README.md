# @bap/java-bridge

复用官方 `com.leavay.nio.crpc` 连 BAP Server 的 Java 桥子进程。
TS 侧经 `stdin/stdout` JSON-lines 与之通信（见 `packages/rpc/src/`）。

## 作用

只暴露「原子化能力」（`CJavaCenterIntf` 方法集 + 连接/会话/ping），不含业务逻辑。
MD5 对比、CommitPackage 组装、状态判断等属于 TS SDK/SCM 层。

## 依赖 jar 来源

这些 jar（`tcmcat-*.jar`、netty、ecj 等）是生产 IDEA 插件的本地文件，
位于 `/Users/lihongrui/IdeaProjects/PluginDemo/lib/platform/`，**不纳入 git**。

`lib/`（构建依赖）与 `dist/`（运行时产物）由脚本生成，已被 `.gitignore` 排除。

## 构建

```bash
npm run sync-jars   # 从 PluginDemo/lib/platform 拷贝最小 10 个 jar → lib/
npm run build:java  # javac --release 8 编译 + 打 bridge-main.jar + 组装 dist/lib
# 或一次完成：
npm run build
```

产物在 `dist/lib/`：`bridge-main.jar` + 10 个平台 jar。
运行（classpath 通配符，与生产插件一致）：

```bash
java -cp "<包>/dist/lib/*" com.bap.dev.BridgeMain
```

## 目录

```
src/main/java/com/bap/dev/
  BapRpcClient.java   复制生产类，仅替换 IntelliJ Logger
  BridgeMain.java     stdio JSON 主循环 + 反射 call + GsonUtil 序列化
resources/log4j.properties   日志走 stderr，避免污染 stdout JSON 帧
scripts/
  sync-jars.sh       拷贝 jar
  build.sh           编译 + 打包
```
