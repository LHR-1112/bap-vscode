# BAP IDE（VS Code）

面向 **BAP 云工程**的 VS Code 插件：通过 Java 桥复用官方 `com.leavay.nio.crpc` 连 BAP Server，
把云端工程当作「基线」做源码管理、调试、编译与测试。版本 `1.0.0`。

## 功能

- **源代码管理（SCM）**：云端为基线，分组「新增/更改/删除」；刷新、提交（全部/单个/分组）、发布插件（全量）、更新（全部/单个/分组）、打开 Diff / 文件；文件项右键菜单（打开文件/更新/提交/编译/调试/单测）。
- **查看历史**：项目历史 / 文件历史——编辑器标签页 Webview（Lit），复刻 git view history；选中版本可回看前一版本 diff。
- **重定向工程**：切换 BAP Server（ws 地址 + 账号 + 密码），带本地历史（`<工程>/.bap/relocate-history.json`），可一键/编辑/新增。
- **下载工程**：从命令行按流式方式下载整包到当前工作区根，解压、写 `.develop`、写 `.vscode/settings.json`（JDK8），替换窗口打开。
- **更新依赖**：同步 `<工程>/lib` 到云端（服务端 md5 比对），更新 + 删除云端已无的本地 lib。
- **编译**：「编译项目（本地）」用 JDK javac 编译 `src/**`→`bin/`；「编译单类（云端）」调 `compileSingleCode` 并以诊断标记到编辑器行（波浪线 + 问题面板）。
- **启动调试**：把当前类发到云端运行（`startDebugJava`），在「BAP 调试」输出通道逐行显示 trace 与执行结果。
- **单元测试**：先 javac 编译、再 JUnit Platform（`junit-platform-console-standalone`）跑 `bin/` 下的测试类；输出到「BAP 单元测试」通道，并给测试类透传 `BAP_*`/`SILENT_BAP_*` 属性以连服务器。
- 全部数据流单向 `UI → Host → SDK → RPC → Server`。

## 目录结构

```
packages/
  core/          公共常量（BAP_IDE_NAME / BAP_IDE_VERSION）
  rpc/           Java 桥通信面：spawn 桥子进程，stdin/stdout JSON-lines，id/超时/进度
  sdk/           业务封装（.develop 读写、refresh/commit/publish/redirect/history/download/syncLibs/compile/debug/test），不暴露 RPC
  vscode-host/   VS Code 宿主（SCM、历史 Webview、命令、工具函数）
  java-bridge/   Java 桥源码（BridgeMain + BapRpcClient）与 jar 构建
apps/
  vscode/        插件本体（入口 + esbuild 打包 + vsix 资源）
```

## 关键机制 / 依赖

- **内置包不预编译**：`main`/`types` 直指 `src/index.ts`，由 esbuild 统一 bundle 进 `dist/extension.js`。
- **Java 桥**：`java-bridge` 复用生产 IDEA 插件的官方客户端，只做原子转发；运行时 jar 在 `apps/vscode/assets/bridge/lib/`（`build`/`package` 自动同步）。
- **运行时依赖**：本地编译/单测需本机 **JDK**（`javac`/`java`）；单测需 `apps/vscode/resources/junit/junit-platform-console-standalone-1.11.0.jar`（随插件打包）。

## 配置项

设置 → BAP IDE：
- `bapIde.java8Path` — JDK 1.8 路径（编译/下载工程/单测用其 javac 与 java）。
- `bapIde.refreshTtlMs` — 自动刷新复用云端快照的间隔（默认 `30000`ms）。

## 开发 / 构建 / 打包

```bash
npm install                  # 安装依赖（workspaces）
npm run compile              # esbuild → apps/vscode/dist/extension.js
npm run watch                # 监听构建
npm run typecheck            # TypeScript 类型检查（tsc --noEmit）
npm run build                # 完整构建（Java 桥 + stage 到 assets + esbuild --production）
npm run package              # 打包 .vsix → 根 dist/（bap-ide-vscode-<version>.vsix）
```

## 调试

在 VS Code 打开本仓库根目录，按 `F5`（`.vscode/launch.json`）会以开发模式启动一个新窗口加载 `apps/vscode` 插件。
> 注意：SCM / 连服务器等依赖工作区目录含 `.develop`，请在扩展宿主窗口（File → Open Folder）打开如
> `gpf_dc_practicalTool` 这类 BAP 工程；仓库根自身没有 `.develop`，仅能看到命令面板命令。
