# Changelog

## [1.0.3] - 2026-09-02

### 修复

- **修复发布插件（全量 / 灰度）吞掉报错并报超时**
  - 根因：发布走 RPC 默认 30s 超时，`rebuildAll` / `exportProject2Plugin` / `grayPublish`
    通常远超该时限；TS 侧 30s 定时器先触发产生 TIMEOUT，晚到的真实成功 / 服务端报错被丢弃。
  - 修复：SDK 对发布相关调用改用 `callWithTimeout`（30min 长超时）；Java 桥对
    `rebuildAll` / `grayPublish` 一并放宽服务端 temp timeout（`export*` 已有）。

### 优化

- **命令标题改为英文**：`contributes.commands` 标题由中文改为英文（命令 `category` 仍为 `BAP`），
  命令面板 / 菜单显示为 `BAP: Refresh`、`BAP: Commit` 等。

## [1.0.2] - 2026-09-01

### 修复

- **修复刷新误报海量变更**（云快照 Map 被序列化成字符串）
  - 根因：Java 桥 `safeSerialize` 把 `queryCodeFile` / `queryAllFileMap` 返回的
    `Map`（包名 `java.util`）误判为 JDK 内部类，整张 map 被 `toString` 成 `{path=...}`
    字符串；TS 侧按字符拆索引，本地路径全对不上 → 文件全被判为新增（曾出现上万变更）。
  - 桥改为：对异常之外的对象先正常 Gson 序列化，仅序列化失败（JDK 非 opened 模块类）才
    `toString` 兜底。

### 优化

- **云端快照归一化加固**：`queryCodeFile` / `queryAllFileMap` 无论返回对象还是数组，统一用元素自身 `path` 作为云端相对路径对齐本地，避免 key 为索引时错位。
- 移除刷新时的临时诊断日志（`[refresh] 云端快照 ...`）。
- **SCM 动作统一改为右下角进度框提示**：移除「刷新 / 提交已触发」等即时 toast；刷新、提交、发布、提交 / 更新（文件 / 组 / 全部）、编译单类、云端调试等动作，改为点击后立即在右下角显示进度框（与下载工程一致）。
- **SCM 按需显示**：插件激活时检测工程根目录 `.develop`，存在才启用 Source Control 存储库（非 BAP 工程不显示，也避免打开普通文件夹时误连服务器）。

## [1.0.1] - 2026-08-31

### 新增

- **检查更新（感知更新）**
  - 启动后台检查 + 命令面板「检查更新」，从 GitHub Release 检测新版本并提示下载。
  - 适用于**手动 `.vsix` 安装**（VS Code 不会对手动安装的扩展自动更新）。
  - 配 `bapIde.updateFeedUrl` / `bapIde.checkUpdateOnStartup` 设置项。

## [1.0.0] - 2026-08-31

BAP IDE（VS Code）首个发布版。面向 **BAP 云工程**：复用官方 Java 桥连 BAP Server，把云端工程当作基线做源码管理、调试、编译与测试。

### 新增

- **源代码管理（SCM）**
  - 云端为基线，资源分组：`新增 / 更改 / 删除`，空组自动隐藏。
  - 刷新、提交全部 / 单文件 / 分组、发布插件（全量）、更新（全部 / 单文件 / 分组）、打开 Diff、打开文件。
  - 文件项右键菜单：打开文件、更新、提交、编译单类（云端）、启动调试、单元测试。
  - 自动刷新带云端快照缓存（`refreshTtlMs`）与串行化，降低频繁刷新开销。

- **查看历史**
  - 项目历史 / 文件历史：编辑器标签页 Webview，复刻 git view history（过滤栏 + 提交列表 + 选中版本的改动文件）。
  - 选中版本可回看与前一版本的 diff。

- **重定向工程**
  - 切换到其它 BAP Server（ws 地址 + 账号 + 密码），本地历史（`<工程>/.bap/relocate-history.json`），一键 / 编辑 / 新增。

- **下载工程**
  - 命令行入口，流式下载整包到当前工作区根，自动解压、写 `.develop`、写 `.vscode/settings.json`（JDK 1.8），随后替换窗口打开并注册 SCM。

- **更新依赖**
  - 同步 `<工程>/lib` 到云端（服务端 md5 比对），增量更新并删除云端已无的本地 lib 包。

- **编译**
  - 编译项目（本地）：用 JDK `javac` 编译 `src/**` → `bin/`，并拷贝资源。
  - 编译单类（云端）：调 `compileSingleCode`，把诊断标记到编辑器对应行（波浪线 + 问题面板）。

- **启动调试**
  - 把当前类发到云端运行（`startDebugJava`），在「BAP 调试」输出通道逐行显示运行 trace 与执行结果（调试 ID / 是否异常 / 返回对象 / 返回文本）。

- **单元测试**
  - 先本地 `javac` 编译、再用 JUnit Platform（`junit-platform-console-standalone`）运行 `bin/` 下的测试类。
  - 输出到「BAP 单元测试」通道，并给测试类透传 `BAP_*` / `SILENT_BAP_*` 属性，供测试基类连服务器。

### 使用前提

- 本机需安装 **JDK**（编译 / 本地单测使用 `javac` / `java`；默认用设置里的 JDK 1.8 路径）。
- 工程需含 `.develop`，用于定位服务器地址 / 账号 / 工程。

### 配置项

- `bapIde.java8Path`：JDK 1.8 安装路径（编译 / 下载工程 / 单测采用其 javac 与 java）。
- `bapIde.refreshTtlMs`：自动刷新复用云端快照的间隔（默认 `30000` ms）。
