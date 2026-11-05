import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { BAP_IDE_NAME, BAP_IDE_VERSION } from '@bap/core';
import { createRpcClient, type BridgeLaunchConfig } from '@bap/rpc';
import { createBapSdk, downloadProject, detectJdk8, writeJavaSettings, type CJavaProjectDto } from '@bap/sdk';
import { activateScm, checkLatestRelease, isNewer, DEFAULT_FEED, registerMcpServerProvider, isToolCall, discoverBackendProjects, isVfWorkspaceRoot, sanitizeProjectDirName, resolveDownloadTargetDir, directoryHasEntries } from '@bap/vscode-host';

export function activate(context: vscode.ExtensionContext): void {
  // BAP IDE 输出通道：所有诊断日志写到「输出 → BAP IDE」，便于排查激活/命令/连接问题。
  const log = vscode.window.createOutputChannel('BAP IDE');
  context.subscriptions.push(log);
  log.appendLine(`[activate] ${BAP_IDE_NAME} v${BAP_IDE_VERSION} 开始激活`);

  context.subscriptions.push(
    vscode.commands.registerCommand('bapIde.showVersion', () => {
      log.appendLine('[showVersion] 已触发');
      void vscode.window.showInformationMessage(`${BAP_IDE_NAME} v${BAP_IDE_VERSION}`);
    }),
  );

  // MCP：注册 BAP MCP server 定义（VS Code 可发现；无 .develop 工作区时 resolve 钩子中止启动）
  void registerMcpServerProvider(context, {
    debug: (m) => log.appendLine(`[mcp] ${m}`),
    error: (m) => log.appendLine(`[mcp][ERROR] ${m}`),
  })
    .then((d) => context.subscriptions.push(d))
    .catch((e) => log.appendLine(`[activate][mcp] 注册失败: ${e instanceof Error ? e.message : String(e)}`));

  // 检查更新（手动 vsix 安装不支持自动更新，这里做「感知更新」）
  const cfg = vscode.workspace.getConfiguration('bapIde');
  context.subscriptions.push(
    vscode.commands.registerCommand('bapIde.checkUpdate', async () => {
      const feed = cfg.get<string>('updateFeedUrl') || DEFAULT_FEED;
      log.appendLine('[checkUpdate] 检查中…');
      const info = await checkLatestRelease(feed, BAP_IDE_VERSION);
      if (!info) {
        void vscode.window.showInformationMessage('BAP: 无法获取更新信息');
        return;
      }
      if (info.hasUpdate) {
        const go = await vscode.window.showInformationMessage(
          `发现新版本 ${info.latest}（当前 ${info.current}），是否前往下载？`,
          '前往下载',
        );
        if (go === '前往下载' && info.url) await vscode.env.openExternal(vscode.Uri.parse(info.url));
      } else {
        void vscode.window.showInformationMessage(`BAP: 已是最新版本（${info.current}）`);
      }
    }),
  );

  // 启动后台检查一次（仅在有新版时提示；可用设置关闭）
  if (cfg.get<boolean>('checkUpdateOnStartup') !== false) {
    const feed = cfg.get<string>('updateFeedUrl') || DEFAULT_FEED;
    void (async () => {
      const info = await checkLatestRelease(feed, BAP_IDE_VERSION);
      if (info?.hasUpdate) {
        void vscode.window.showInformationMessage(
          `BAP IDE 有新版本 ${info.latest}（当前 ${info.current}），在命令面板运行「检查更新」查看下载。`,
        );
      }
    })();
  }

  // Java 桥子进程 launch（下载工程在无打开的工作区时也可用）
  const launch: BridgeLaunchConfig = {
    classpath: [path.join(context.extensionPath, 'assets', 'bridge', 'lib', '*')],
    mainClass: 'com.bap.dev.BridgeMain',
  };

  /** 下载/重定位后写 Java 配置用的 JDK 路径：设置优先，其次自动探测。 */
  const resolveJdk = (): string | undefined => {
    const configured = vscode.workspace.getConfiguration('bapIde').get<string>('java8Path');
    return configured && configured.trim() ? configured.trim() : detectJdk8();
  };

  /** 写 .vscode/settings.json 并记录结果（下载路径共用；quiet 用于 MCP 非交互路径）。 */
  const applyJavaSettings = (destDir: string, opts: { quiet?: boolean } = {}): void => {
    const jdk = resolveJdk();
    const result = writeJavaSettings(destDir, jdk);
    log.appendLine(
      result === 'skipped'
        ? '[downloadProject] .vscode/settings.json 已存在但无法解析（可能含注释），为避免覆盖已跳过写入'
        : `[downloadProject] .vscode/settings.json ${result === 'merged' ? '已合并写入（保留了原有设置）' : '已新建'}`,
    );
    if (result === 'skipped' && !opts.quiet) {
      void vscode.window.showWarningMessage(
        'BAP: 目标目录已有 .vscode/settings.json 但无法解析（可能含注释），为免覆盖已跳过写入 BAP 推荐设置。',
      );
    }
    if (!jdk && !opts.quiet) void vscode.window.showWarningMessage('BAP: 未检测到 JDK 1.8，已写入 JavaSE-1.8 配置，请在插件设置中填 bapIde.java8Path 或手动补 path');
  };

  // 下载工程：命令行入口（不依赖当前打开的工作区）。流式下载 + 解压 + 写 .develop（Java 桥完成），
  // 再写 .vscode/settings.json（JDK1.8），最后替换窗口打开。
  context.subscriptions.push(
    vscode.commands.registerCommand('bapIde.downloadProject', async (arg?: unknown) => {
      const t = isToolCall(arg) ? arg : undefined;
      if (t) {
        // 非交互下载（MCP 工具路径）
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) return { error: '请先打开一个文件夹' };
        try {
          const rpc = createRpcClient({ launch });
          try {
            // 目录名：显式 projectName > 登录后按 uuid 反查 > uuid 兜底。
            let projectName = typeof t.projectName === 'string' ? t.projectName : '';
            if (!projectName) {
              try {
                await rpc.connect(t.uri as string, t.user as string, t.pwd as string);
                const projects = (await rpc.call('getAllProjects')) as CJavaProjectDto[];
                projectName = projects.find((p) => p.uuid === t.projectUuid)?.name ?? '';
              } catch {
                /* 反查失败不阻塞下载 */
              }
            }
            const destDir = resolveDownloadTargetDir(
              root,
              projectName || String(t.projectUuid),
              typeof t.targetDir === 'string' ? t.targetDir : undefined,
            );
            // 独立工作区沿用「下载到根目录」；vf 工作区默认落到工程子目录，非空则拒绝覆盖。
            if (destDir !== root && directoryHasEntries(destDir)) {
              return { error: `目标目录已存在且非空：${destDir}` };
            }
            fs.mkdirSync(destDir, { recursive: true });
            await downloadProject({
              rpc,
              uri: t.uri as string,
              user: t.user as string,
              pwd: t.pwd as string,
              projectUuid: t.projectUuid as string,
              destDir,
              onLog: (m) => log.appendLine(`[downloadProject] ${m}`),
            });
            applyJavaSettings(destDir, { quiet: true });
            return `已下载到 ${destDir}`;
          } finally {
            await rpc.close();
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          log.appendLine(`[downloadProject] 失败: ${msg}`);
          return { error: msg };
        }
      }
      try {
        log.appendLine('[downloadProject] 开始');
        const uri = await vscode.window.showInputBox({
          prompt: 'BAP Server ws 地址', placeHolder: 'ws://host:port', ignoreFocusOut: true,
          validateInput: (v) => (v && v.trim() ? undefined : '必填'),
        });
        if (!uri) return;
        const user = await vscode.window.showInputBox({
          prompt: '账号', ignoreFocusOut: true,
          validateInput: (v) => (v && v.trim() ? undefined : '必填'),
        });
        if (!user) return;
        const pwd = await vscode.window.showInputBox({
          prompt: '密码', password: true, ignoreFocusOut: true,
          validateInput: (v) => (v ? undefined : '必填'),
        });
        if (!pwd) return;

        const rpc = createRpcClient({ launch });
        try {
          await rpc.connect(uri.trim(), user.trim(), pwd);
          const projects = (await rpc.call('getAllProjects')) as CJavaProjectDto[];
          log.appendLine(`[downloadProject] 连接完成，工程=${projects.length}`);
          if (projects.length === 0) {
            void vscode.window.showInformationMessage('BAP: 该服务器上没有工程');
            return;
          }
          const picked = await vscode.window.showQuickPick(
            projects.map((p) => ({ label: p.name, description: p.uuid, detail: p.uuid })),
            { placeHolder: '选择要下载的工程', matchOnDescription: true, matchOnDetail: true },
          );
          if (!picked) return;
          const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          if (!root) {
            void vscode.window.showWarningMessage('BAP: 请先打开一个文件夹，再下载工程');
            return;
          }
          // 独立 BAP 工作区：仍下载到工作区根；VotaForge 工作区：默认落到 <根>/<工程名>，允许改子目录。
          let destDir = root;
          if (isVfWorkspaceRoot(root)) {
            const input = await vscode.window.showInputBox({
              prompt: '下载到工作区内的子目录（相对工作区根）',
              value: sanitizeProjectDirName(picked.label),
              ignoreFocusOut: true,
              validateInput: (v) => {
                const s = v?.trim();
                if (!s) return '必填（相对工作区根的路径）';
                try {
                  resolveDownloadTargetDir(root, picked.label, s);
                  return undefined;
                } catch (e) {
                  return e instanceof Error ? e.message : String(e);
                }
              },
            });
            if (!input) return;
            destDir = resolveDownloadTargetDir(root, picked.label, input);
          }
          if (destDir !== root && directoryHasEntries(destDir)) {
            const ok = await vscode.window.showWarningMessage(
              `目录已存在且非空：${destDir}`,
              { modal: true },
              '继续下载',
            );
            if (ok !== '继续下载') return;
          }
          fs.mkdirSync(destDir, { recursive: true });
          let last = 0;
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `下载工程 ${picked.label}`, cancellable: true },
            async (prog, token) => {
              token.onCancellationRequested(() => {
                void rpc.disconnect();
                // 取消时顺手清理临时 zip（Java 侧 finally 也会删，双保险）
                try {
                  fs.rmSync(path.join(destDir, 'checkout_temp.zip'), { force: true });
                } catch {
                  /* ignore */
                }
              });
              await downloadProject({
                rpc, uri: uri.trim(), user: user.trim(), pwd,
                projectUuid: picked.description, destDir,
                onProgress: (p) => {
                  const inc = Math.max(0, p.percent - last);
                  last = p.percent;
                  prog.report({ increment: inc, message: `已下载 ${p.percent}%` });
                },
                onLog: (m) => log.appendLine(`[downloadProject] ${m}`),
              });
            },
          );
          log.appendLine('[downloadProject] 下载完成，写 .vscode/settings.json');
          applyJavaSettings(destDir);
          if (isVfWorkspaceRoot(root)) {
            // vf 容器工作区：不能替换窗口（会丢掉 vf 根），提示加入工作区后重载。
            const rel = path.relative(root, destDir).split(path.sep).join('/') || '.';
            const action = await vscode.window.showInformationMessage(
              `BAP 工程已下载到 ${rel}`,
              '添加到工作区并重新加载',
              '稍后',
            );
            if (action === '添加到工作区并重新加载') {
              const folders = vscode.workspace.workspaceFolders ?? [];
              vscode.workspace.updateWorkspaceFolders(folders.length, 0, {
                uri: vscode.Uri.file(destDir),
                name: picked.label,
              });
              await vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
          } else {
            await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(destDir), false);
          }
          log.appendLine(`[downloadProject] 完成，destDir=${destDir}`);
        } finally {
          await rpc.close();
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.appendLine(`[downloadProject] 失败: ${msg}`);
        void vscode.window.showErrorMessage(`下载工程失败，详见输出面板「BAP IDE」: ${msg}`);
      }
    }),
  );

  try {
    // 无打开的 workspace folder -> 无法扫描后端工程根，SCM 不启用
    if (!vscode.workspace.workspaceFolders?.length) {
      log.appendLine('[activate] 无 workspace folder，跳过 SCM');
      void vscode.window.showWarningMessage('BAP: 请先打开一个含 .develop 的 BAP 工程文件夹');
      return;
    }

    // 后端工程根 = 含 .develop 的目录（可能在 vf 工作区的子目录里），不再假设 workspaceFolders[0]。
    const backendProjects = discoverBackendProjects();
    if (backendProjects.length === 0) {
      log.appendLine('[activate] 未发现 .develop，跳过 SCM 存储库');
      return;
    }
    if (backendProjects.length > 1) {
      log.appendLine(
        `[activate] 发现 ${backendProjects.length} 个后端工程，M1 前暂使用第一个：${backendProjects[0].root}`,
      );
    }
    const root = backendProjects[0].root;
    log.appendLine(`[activate] backendProjectRoot = ${root}（${backendProjects[0].relativePath}）`);

    // Java 桥子进程：用扩展内捆绑的 bridge jar 资产
    log.appendLine(`[activate] launch bridge, classpath=${launch.classpath[0]}`);

    const rpc = createRpcClient({ launch });
    const sdk = createBapSdk({
      rpc,
      workspaceRoot: root,
      onLog: (m) => log.appendLine(`[sdk] ${m}`),
      javaHome: vscode.workspace.getConfiguration('bapIde').get<string>('java8Path')?.trim() || undefined,
      junitJarPath: path.join(context.extensionPath, 'resources', 'junit', 'junit-platform-console-standalone-1.11.0.jar'),
      cloudSnapshotTtlMs: vscode.workspace.getConfiguration('bapIde').get<number>('refreshTtlMs') ?? 30000,
    });

    // 注册 SCM（createSourceControl + 资源组 + 云端 diff + 文件角标 + 命令）
    log.appendLine('[activate] 开始注册 SCM provider 与命令...');
    context.subscriptions.push(...activateScm(context, sdk, root, { log }));
    log.appendLine('[activate] SCM provider 与命令注册完成');

    // 关闭扩展时回收 Java 桥
    context.subscriptions.push({ dispose: () => void rpc.close() });
    log.appendLine('[activate] 激活完成');
  } catch (e) {
    const msg = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
    log.appendLine(`[activate] 激活失败: ${msg}`);
    void vscode.window.showErrorMessage(`BAP IDE 激活失败，详见输出面板「BAP IDE」: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function deactivate(): void {}
