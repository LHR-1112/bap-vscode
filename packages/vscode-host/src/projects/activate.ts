// 多后端工程激活：发现 0..N 个含 .develop 的工程 → 每工程一套 SDK/SCM → 共享内容 provider → 注册命令。
// 不假设 workspaceFolders[0] 就是工程根；0 个工程时命令仍注册（解析阶段给提示，不崩溃）。
import * as vscode from 'vscode';
import type { BapSdk } from '@bap/sdk';
import { createBapSdk } from '@bap/sdk';
import { createRpcClient, type BridgeLaunchConfig } from '@bap/rpc';
import { discoverBackendProjectDescriptors } from '../backend-projects-vscode';
import type { BackendProjectDescriptor } from './discovery';
import { BackendProjectRegistry, type ProjectPicker } from './project-registry';
import { BackendProjectContext } from './project-context';
import { RefreshScheduler } from './refresh-scheduler';
import { pathKey } from './project-paths';
import { createBapScmProvider } from '../scm/bap-scm-provider';
import { registerOriginalProvider } from '../scm/original-provider';
import { registerHistoryContentProvider } from '../history/history-provider';
import { BapFileDecorationProvider, registerFileDecoration } from '../scm/file-decoration';
import { registerProjectCommands } from '../commands/command-router';

export interface ActivateBackendProjectsOptions {
  context: vscode.ExtensionContext;
  launch: BridgeLaunchConfig;
  /** SCM 状态图标目录（resources/scm-icons）。 */
  iconDir: string;
  /** junit-platform-console-standalone.jar 路径。 */
  junitJarPath?: string;
  /** mcp-server.js 路径（resetAgentInstructions 写配置用）。 */
  mcpServerPath: string;
  autoRefresh?: boolean;
  maxDepth?: number;
  log?: { debug(msg: string): void; error(msg: string): void };
}

export interface ActivatedBackendProjects {
  registry: BackendProjectRegistry;
  disposables: vscode.Disposable[];
  projectCount: number;
}

const NOOP_LOG = { debug: (): void => {}, error: (): void => {} };

/** 当前窗口的工程上下文键（菜单 when 条件用）。 */
async function setContextKeys(projectCount: number): Promise<void> {
  await vscode.commands.executeCommand('setContext', 'bapIde.hasBackendProject', projectCount > 0);
  await vscode.commands.executeCommand('setContext', 'bapIde.projectCount', projectCount);
}

/** QuickPick 工程选择器（重复检出会标注，避免误选写操作目标）。 */
function createPicker(): ProjectPicker {
  interface PickItem extends vscode.QuickPickItem {
    ctx: BackendProjectContext;
  }
  const toItem = (ctx: BackendProjectContext, picked: boolean): PickItem => {
    const detail = [
      ctx.descriptor.projectUuid ? `云端工程 ${ctx.descriptor.projectUuid}` : '未解析 .develop',
      ctx.descriptor.serverUri ?? '',
      ctx.isDuplicateCheckout ? '⚠ 同一云端工程的多份检出' : '',
    ]
      .filter(Boolean)
      .join(' · ');
    return {
      label: ctx.displayName,
      description: ctx.root,
      detail,
      picked,
      ctx,
    };
  };

  return {
    async pickOne(candidates, purpose) {
      const items = candidates.map((c) => toItem(c, false));
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: purpose,
        matchOnDescription: true,
        matchOnDetail: true,
      });
      return picked?.ctx;
    },
    async pickMany(candidates, purpose, defaults) {
      const defaultSet = new Set(defaults.map((c) => c.projectId));
      const items = candidates.map((c) => toItem(c, defaultSet.has(c.projectId)));
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: purpose,
        matchOnDescription: true,
        matchOnDetail: true,
        canPickMany: true,
      });
      return picked?.map((i) => i.ctx);
    },
  };
}

/**
 * 激活多工程宿主。返回的 disposables 应由调用方 push 到 extension context。
 * 0 个工程时不创建 SCM，但命令仍注册（P1-1：无工程时菜单/命令不崩溃）。
 */
export function activateBackendProjects(opts: ActivateBackendProjectsOptions): ActivatedBackendProjects {
  const log = opts.log ?? NOOP_LOG;
  const descriptors = discoverBackendProjectDescriptors({ maxDepth: opts.maxDepth });
  log.debug(`[projects] 发现后端工程 ${descriptors.length} 个`);
  void setContextKeys(descriptors.length);

  const fileDeco = new BapFileDecorationProvider();
  const fileDecoDisposable = registerFileDecoration(fileDeco);

  /** 按工程读取资源级配置（bapIde.java8Path / refreshTtlMs 支持 workspace/文件夹级覆盖）。 */
  const configFor = (root: string): vscode.WorkspaceConfiguration =>
    vscode.workspace.getConfiguration('bapIde', vscode.Uri.file(root));

  let registry!: BackendProjectRegistry;
  registry = new BackendProjectRegistry(descriptors, {
    createContext: (descriptor: BackendProjectDescriptor) =>
      new BackendProjectContext(descriptor, {
        createSdk: (desc) => {
          const cfg = configFor(desc.root);
          const rpc = createRpcClient({ launch: opts.launch });
          const sdk: BapSdk = createBapSdk({
            rpc,
            workspaceRoot: desc.root,
            projectId: desc.projectId,
            onLog: (m) => log.debug(`[sdk][${desc.displayName}] ${m}`),
            javaHome: cfg.get<string>('java8Path')?.trim() || undefined,
            junitJarPath: opts.junitJarPath,
            cloudSnapshotTtlMs: cfg.get<number>('refreshTtlMs') ?? 30000,
          });
          return { sdk, close: () => rpc.close() };
        },
        createScm: (ctx, sdk) =>
          createBapScmProvider(sdk, ctx.root, {
            projectId: ctx.projectId,
            displayName: ctx.displayName,
            providerId: `bap:${ctx.projectId}`,
            iconDir: opts.iconDir,
            autoRefresh: opts.autoRefresh,
            ownsPath: (fsPath) => registry.ownsPath(ctx.projectId, fsPath),
            onChanges: (changes) => {
              fileDeco.setStatuses(
                new Map(
                  changes.filter((c) => c.status !== 'NORMAL').map((c) => [c.absolutePath, c.status]),
                ),
                ctx.projectId,
              );
            },
            onDispose: () => fileDeco.removeOwner(ctx.projectId),
            log,
          }),
        log,
        onStale: (ctx, reason) => {
          log.error(`[${ctx.displayName}] 工程失效：${reason}`);
          void vscode.window.setStatusBarMessage(`BAP: 工程「${ctx.displayName}」失效 - ${reason}`, 6000);
        },
      }),
    picker: createPicker(),
    getActiveEditorPath: () => vscode.window.activeTextEditor?.document.uri.fsPath,
    log,
  });

  // 每工程一个 SCM provider（SourceControl id = bap:<projectId>）。
  for (const ctx of registry.getAll()) {
    try {
      const scm = ctx.ensureScm();
      registry.registerScm(ctx.projectId, scm.sourceControl, scm.resourceGroups);
    } catch (e) {
      log.error(`[${ctx.displayName}] 创建 SCM 失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 共享内容 provider：同一 scheme 只注册一次，URI 里的 pid 决定用哪个工程的 SDK。
  const resolveSdk = (projectId?: string): BapSdk | undefined => {
    if (projectId) return registry.getById(projectId)?.sdk;
    const all = registry.getAll();
    return all.length === 1 ? all[0].sdk : undefined;
  };
  const originalProvider = registerOriginalProvider(resolveSdk);
  const historyProvider = registerHistoryContentProvider(resolveSdk);

  // 初始刷新串行执行：避免同时拉起多个 Java 桥/全量读盘。
  const scheduler = new RefreshScheduler(1);
  for (const ctx of registry.getAll()) {
    void scheduler
      .run(() => ctx.ensureScm().refresh(true))
      .catch((e) => log.error(`[${ctx.displayName}] 初始刷新失败：${e instanceof Error ? e.message : String(e)}`));
  }

  // 工作区 folder 变更：新工程/移除工程需要重新发现（SCM/命令绑定在激活时确定）。
  const knownRoots = new Set(descriptors.map((d) => pathKey(d.root)));
  const folderWatcher = vscode.workspace.onDidChangeWorkspaceFolders((e) => {
    if (!e.added.length && !e.removed.length) return;
    const current = discoverBackendProjectDescriptors({ maxDepth: opts.maxDepth });
    void setContextKeys(current.length);
    const currentRoots = new Set(current.map((d) => pathKey(d.root)));
    let changed = currentRoots.size !== knownRoots.size;
    if (!changed) {
      for (const r of currentRoots) {
        if (!knownRoots.has(r)) {
          changed = true;
          break;
        }
      }
    }
    if (!changed) return;
    void vscode.window
      .showInformationMessage('BAP: 工作区中的后端工程已变更，重新加载窗口后生效。', '重新加载')
      .then((a) => {
        if (a === '重新加载') void vscode.commands.executeCommand('workbench.action.reloadWindow');
      });
  });

  const commands = registerProjectCommands({
    context: opts.context,
    registry,
    log,
    mcpServerPath: opts.mcpServerPath,
  });

  const disposables: vscode.Disposable[] = [
    originalProvider,
    historyProvider,
    fileDecoDisposable,
    folderWatcher,
    {
      dispose: () => {
        scheduler.dispose();
        void registry.shutdown().catch(() => undefined);
      },
    },
    ...commands,
  ];

  return { registry, disposables, projectCount: descriptors.length };
}
