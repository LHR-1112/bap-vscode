# BAP IDE（VS Code）

面向 BAP 云工程的 VS Code 插件。开发规划见 `docx/BAP IDE（VS Code）开发规划 V1.1.md`。

## 目录结构

```
packages/
  core/         公共模型（DTO / Event / Model / Utils）
  rpc/          RPC Runtime（WebSocket / 协议 / 序列化）
  sdk/          业务能力封装（不暴露 RPC）
  vscode-host/  VS Code 宿主（SCM / TreeView / Command / MCP）
apps/
  vscode/       插件本体（入口 + 打包）
```

## 开发

```bash
npm install          # 安装依赖（workspaces）
npm run compile      # 构建插件（esbuild → apps/vscode/dist）
npm run watch        # 监听构建
npm run typecheck    # TypeScript 类型检查
```

## 调试

在 VS Code 打开本仓库根目录，按 `F5`（配置见 `.vscode/launch.json`），
会以开发模式启动一个新窗口并加载 `apps/vscode` 插件。
