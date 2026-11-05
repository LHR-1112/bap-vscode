import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { BAP_IDE_NAME, BAP_IDE_VERSION } from '@bap/core';
import { createRpcClient, type BridgeLaunchConfig } from '@bap/rpc';
import { downloadProject, detectJdk8, writeJavaSettings, type CJavaProjectDto } from '@bap/sdk';
import {
  activateBackendProjects,
  checkLatestRelease,
  isNewer,
  DEFAULT_FEED,
  registerMcpServerProvider,
  isToolCall,
  discoverBackendProjects,
  isVfWorkspaceRoot,
  sanitizeProjectDirName,
  resolveDownloadTargetDir,
  validateDownloadTarget,
} from '@bap/vscode-host';

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

  /** 下载/重定位后写 Java 配置用的 JDK 路径：设置优先（按目标目录的资源作用域读取），其次自动探测。 */
  const resolveJdk = (destDir?: string): string | undefined => {
    const scope = destDir ? vscode.Uri.file(destDir) : undefined;
    const configured = vscode.workspace.getConfiguration('bapIde', scope).get<string>('java8Path');
    return configured && configured.trim() ? configured.trim() : detectJdk8();
  };

  /** 写 .vscode/settings.json 并记录结果（下载路径共用；quiet 用于 MCP 非交互路径）。 */
  const applyJavaSettings = (destDir: string, opts: { quiet?: boolean } = {}): void => {
    const jdk = resolveJdk(destDir);
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

  /** 把下载目录加入工作区：等 onDidChangeWorkspaceFolders 落地（或 3s 兜底）后再重载。 */
  const addFolderAndReload = async (dir: string, name: string): Promise<void> => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        sub.dispose();
        clearTimeout(timer);
        resolve();
      };
      const sub = vscode.workspace.onDidChangeWorkspaceFolders(() => finish());
      const timer = setTimeout(finish, 3000);
      void vscode.workspace.updateWorkspaceFolders(folders.length, 0, {
        uri: vscode.Uri.file(dir),
        name,
      });
    });
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
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
            // 严格校验落点：工作区内 / vf 根禁止 / 不与已有工程重叠 / 目标不能已是工程。
            let target: { destDir: string; existsNonEmpty: boolean };
            try {
              target = validateDownloadTarget(root, destDir, {
                vf: isVfWorkspaceRoot(root),
                existingProjectRoots: discoverBackendProjects().map((p) => p.root),
              });
            } catch (e) {
              return { error: e instanceof Error ? e.message : String(e) };
            }
            if (target.existsNonEmpty) {
              return { error: `目标目录已存在且非空：${target.destDir}（MCP 下载不会覆盖非空目录）` };
            }
            fs.mkdirSync(target.destDir, { recursive: true });
            await downloadProject({
              rpc,
              uri: t.uri as string,
              user: t.user as string,
              pwd: t.pwd as string,
              projectUuid: t.projectUuid as string,
              destDir: target.destDir,
              onLog: (m) => log.appendLine(`[downloadProject] ${m}`),
            });
            applyJavaSettings(target.destDir, { quiet: true });
            return `已下载到 ${target.destDir}（重新加载窗口后可在 SCM 中操作）`;
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
                  const d = resolveDownloadTargetDir(root, picked.label, s);
                  validateDownloadTarget(root, d, {
                    vf: true,
                    existingProjectRoots: discoverBackendProjects().map((p) => p.root),
                  });
                  return undefined;
                } catch (e) {
                  return e instanceof Error ? e.message : String(e);
                }
              },
            });
            if (!input) return;
            destDir = resolveDownloadTargetDir(root, picked.label, input);
          }
          // 严格校验落点（UI 对「非空目录」保留二次确认；已有工程/越界一律拒绝）。
          let target: { destDir: string; existsNonEmpty: boolean };
          try {
            target = validateDownloadTarget(root, destDir, {
              vf: isVfWorkspaceRoot(root),
              existingProjectRoots: discoverBackendProjects().map((p) => p.root),
            });
          } catch (e) {
            void vscode.window.showErrorMessage(`BAP: ${e instanceof Error ? e.message : String(e)}`);
            return;
          }
          destDir = target.destDir;
          if (target.existsNonEmpty) {
            const ok = await vscode.window.showWarningMessage(
              `目录已存在且非空：${destDir}。继续下载会覆盖同名文件。`,
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
              await addFolderAndReload(destDir, picked.label);
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
    // Java 桥子进程：用扩展内捆绑的 bridge jar 资产（每个后端工程各自懒启动一个桥）。
    log.appendLine(`[activate] launch bridge, classpath=${launch.classpath[0]}`);

    const mcpServerPath = path.join(context.extensionPath, 'dist', 'mcp-server.js');
    const activated = activateBackendProjects({
      context,
      launch,
      iconDir: path.join(context.extensionPath, 'resources', 'scm-icons'),
      junitJarPath: path.join(context.extensionPath, 'resources', 'junit', 'junit-platform-console-standalone-1.11.0.jar'),
      mcpServerPath,
      log: {
        debug: (m) => log.appendLine(m),
        error: (m) => log.appendLine(`[ERROR] ${m}`),
      },
    });
    context.subscriptions.push(...activated.disposables);

    if (activated.projectCount === 0) {
      // P1-1：无 .develop 时命令/菜单仍注册，调用时给提示而不是崩溃。
      log.appendLine('[activate] 未发现 .develop：命令已注册，下载/打开 BAP 工程后自动启用 SCM');
    } else {
      log.appendLine(`[activate] 多工程宿主就绪（${activated.projectCount} 个后端工程）`);
    }
    log.appendLine('[activate] 激活完成');
  } catch (e) {
    const msg = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
    log.appendLine(`[activate] 激活失败: ${msg}`);
    void vscode.window.showErrorMessage(`BAP IDE 激活失败，详见输出面板「BAP IDE」: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function deactivate(): void {}
