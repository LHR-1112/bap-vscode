// 激活 BAP SCM：创建 SCM provider + 云端原版 provider + 文件角标 + 注册命令。
import * as vscode from 'vscode';
import * as path from 'path';
import type { BapSdk, Change } from '@bap/sdk';
import { createBapScmProvider } from './scm/bap-scm-provider';
import { registerOriginalProvider } from './scm/original-provider';
import { BapFileDecorationProvider, registerFileDecoration } from './scm/file-decoration';

export interface ActivateScmOptions {
  autoRefresh?: boolean;
  /** 输出通道，用于把激活/命令的日志与错误打到「输出 → BAP IDE」。 */
  log?: vscode.OutputChannel;
}

function makeLog(opts: ActivateScmOptions): { debug(msg: string): void; error(msg: string): void } {
  const channel = opts.log;
  return {
    debug: (msg) => {
      if (channel) channel.appendLine(`[activate.scm] ${msg}`);
    },
    error: (msg) => {
      if (channel) {
        channel.appendLine(`[activate.scm][ERROR] ${msg}`);
      }
      console.error(msg);
    },
  };
}

/** 激活并返回需要 push 到 context.subscriptions 的 Disposable 数组。 */
export function activateScm(
  context: vscode.ExtensionContext,
  sdk: BapSdk,
  workspaceRoot: string,
  opts: ActivateScmOptions = {},
): vscode.Disposable[] {
  const log = makeLog(opts);
  const subscriptions: vscode.Disposable[] = [];

  log.debug('createBapScmProvider...');
  const iconDir = path.join(context.extensionPath, 'resources', 'scm-icons');
  const bapScm = createBapScmProvider(sdk, workspaceRoot, { autoRefresh: opts.autoRefresh, iconDir });
  log.debug('registerOriginalProvider...');
  const originalProvider = registerOriginalProvider(sdk);
  const fileDeco = new BapFileDecorationProvider();
  const fileDecoDisposable = registerFileDecoration(fileDeco);
  log.debug('providers 就绪');

  subscriptions.push(
    { dispose: () => bapScm.dispose() },
    originalProvider,
    fileDecoDisposable,
  );

  // 初始刷新
  void bapScm.refresh()
    .then((changes) => {
      fileDeco.setStatuses(new Map(changes.filter((c) => c.status !== 'NORMAL').map((c) => [c.absolutePath, c.status])));
      log.debug(`初始 refresh 完成，非 NORMAL=${changes.filter((c) => c.status !== 'NORMAL').length}`);
    })
    .catch((e) => log.error(`初始 refresh 失败: ${e instanceof Error ? e.message : String(e)}`));

  const safe = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      log.error(`命令 ${name} 执行失败: ${e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e)}`);
      void vscode.window.showErrorMessage(`BAP 命令 ${name} 失败，详见输出面板「BAP IDE」`);
    }
  };

  /** SCM context 菜单（右键/内联单个 resource）传给命令的是 resourceUri 或 resource state，而非 Change。
   *  这里统一解析回 provider 里的 Change（按 fsPath 精确匹配）。 */
  function resolveChange(arg: unknown): Change | undefined {
    if (!arg || typeof arg !== 'object') return undefined;
    const a = arg as { fsPath?: unknown; resourceUri?: { fsPath?: unknown }; absolutePath?: unknown };
    let fsPath: string | undefined;
    if (typeof a.fsPath === 'string') fsPath = a.fsPath;
    else if (a.resourceUri && typeof (a.resourceUri as { fsPath?: unknown }).fsPath === 'string') {
      fsPath = (a.resourceUri as { fsPath: string }).fsPath;
    } else if (typeof a.absolutePath === 'string') {
      fsPath = a.absolutePath;
    }
    if (!fsPath) return undefined;
    return bapScm.getChangeByPath(fsPath);
  }

  // --- 命令 ---
  subscriptions.push(
    vscode.commands.registerCommand('bapIde.scm.refresh', async () =>
      safe('bapIde.scm.refresh', async () => {
        log.debug('触发 refresh');
        void vscode.window.showInformationMessage('BAP: refresh 已触发');
        const changes = await bapScm.refresh();
        fileDeco.setStatuses(new Map(changes.filter((c) => c.status !== 'NORMAL').map((c) => [c.absolutePath, c.status])));
        void vscode.window.setStatusBarMessage(`BAP: ${changes.filter((c) => c.status !== 'NORMAL').length} 个变更`, 3000);
      }),
    ),
    vscode.commands.registerCommand('bapIde.scm.commit', async () =>
      safe('bapIde.scm.commit', async () => {
        log.debug('触发 commit');
        void vscode.window.showInformationMessage('BAP: commit 已触发');
        const comment = bapScm.sourceControl.inputBox.value || '';
        await bapScm.commit(comment);
        bapScm.sourceControl.inputBox.value = '';
        void vscode.window.setStatusBarMessage('BAP: 提交完成', 3000);
      }),
    ),
    vscode.commands.registerCommand('bapIde.scm.publish', async () =>
      safe('bapIde.scm.publish', async () => {
        log.debug('触发 publish');
        const msg = await vscode.window.showWarningMessage(
          '确定发布插件（全量）？将把当前工程发布给所有用户。',
          { modal: true },
          '发布',
        );
        if (msg !== '发布') return;
        await sdk.publish.full();
        void vscode.window.setStatusBarMessage('BAP: 已发布插件（全量）', 3000);
      }),
    ),
    vscode.commands.registerCommand('bapIde.scm.openDiff', async (arg?: unknown) =>
      safe('bapIde.scm.openDiff', async () => {
        const change = resolveChange(arg);
        log.debug(`openDiff: change=${change ? `${change.relativePath}|${change.absolutePath}` : '(未找到)'}`);
        if (!change) return;
        await openDiff(change, workspaceRoot);
      }),
    ),
    vscode.commands.registerCommand('bapIde.scm.commitFile', async (arg?: unknown) =>
      safe('bapIde.scm.commitFile', async () => {
        const change = resolveChange(arg);
        log.debug(`commitFile: change=${change ? `${change.relativePath}|${change.absolutePath}` : '(未找到)'}`);
        if (!change) return;
        const comment = bapScm.sourceControl.inputBox.value || '';
        await bapScm.commitFile(change, comment);
        bapScm.sourceControl.inputBox.value = '';
        void vscode.window.setStatusBarMessage('BAP: 已提交该文件', 3000);
      }),
    ),
    vscode.commands.registerCommand('bapIde.scm.updateFile', async (arg?: unknown) =>
      safe('bapIde.scm.updateFile', async () => {
        const change = resolveChange(arg);
        log.debug(`updateFile: change=${change ? `${change.relativePath}|${change.absolutePath}` : '(未找到)'}`);
        if (!change) return;
        await bapScm.updateFile(change);
        void vscode.window.setStatusBarMessage('BAP: 已从云端更新该文件', 3000);
      }),
    ),
    vscode.commands.registerCommand('bapIde.scm.openAllChanges', async () =>
      safe('bapIde.scm.openAllChanges', async () => {
        const list = bapScm.getChanges();
        log.debug(`openAllChanges: ${list.length} 个`);
        if (list.length === 0) {
          void vscode.window.showInformationMessage('BAP: 没有更改');
          return;
        }
        // 逐份打开「更改」组每个文件的 diff（左=云端原版，右=本地）
        for (const c of list) {
          if (c.absolutePath) await openDiff(c, workspaceRoot);
        }
      }),
    ),
    vscode.commands.registerCommand('bapIde.scm.updateAll', async () =>
      safe('bapIde.scm.updateAll', async () => {
        log.debug('触发 updateAll');
        const msg = await vscode.window.showWarningMessage(
          '确定更新所有文件到云端最新版？将覆盖本地改动，新增文件会被删除。',
          { modal: true },
          '更新',
        );
        if (msg !== '更新') return;
        await bapScm.updateAll();
        void vscode.window.showInformationMessage('BAP: 已更新所有文件');
      }),
    ),
  );

  return subscriptions;
}

/** 打开 diff：左侧 = bap-original（云端原版），右侧 = 本地文件。 */
async function openDiff(change: Change, workspaceRoot: string): Promise<void> {
  const q = new URLSearchParams();
  q.set('folder', change.folder);
  q.set('res', String(change.isResource));
  q.set('rel', change.relativePath);
  const rel = change.absolutePath.startsWith(workspaceRoot)
    ? change.absolutePath.slice(workspaceRoot.length).replace(/^[/\\]+/, '')
    : change.absolutePath;
  const left = vscode.Uri.parse(`bap-original://bap/${encodeURIComponent(rel)}?${q.toString()}`);
  const right = vscode.Uri.file(change.absolutePath);
  const title = change.isResource
    ? `${change.relativePath} (BAP)`
    : `${change.fullClass ?? change.relativePath} (BAP)`;

  await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
}
