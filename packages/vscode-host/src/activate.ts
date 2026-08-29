// 激活 BAP SCM：创建 SCM provider + 云端原版 provider + 文件角标 + 注册命令。
import * as vscode from 'vscode';
import type { BapSdk, Change } from '@bap/sdk';
import { createBapScmProvider } from './scm/bap-scm-provider';
import { registerOriginalProvider } from './scm/original-provider';
import { BapFileDecorationProvider, registerFileDecoration } from './scm/file-decoration';

export interface ActivateScmOptions {
  autoRefresh?: boolean;
}

/** 激活并返回需要 push 到 context.subscriptions 的 Disposable 数组。 */
export function activateScm(
  context: vscode.ExtensionContext,
  sdk: BapSdk,
  workspaceRoot: string,
  opts: ActivateScmOptions = {},
): vscode.Disposable[] {
  const subscriptions: vscode.Disposable[] = [];

  const bapScm = createBapScmProvider(sdk, workspaceRoot, { autoRefresh: opts.autoRefresh });
  const originalProvider = registerOriginalProvider(sdk);
  const fileDeco = new BapFileDecorationProvider();
  const fileDecoDisposable = registerFileDecoration(fileDeco);

  subscriptions.push(
    { dispose: () => bapScm.dispose() },
    originalProvider,
    fileDecoDisposable,
  );

  // 初始刷新
  void bapScm.refresh().then((changes) => {
    fileDeco.setStatuses(new Map(changes.filter((c) => c.status !== 'NORMAL').map((c) => [c.absolutePath, c.status])));
  });

  // --- 命令 ---
  subscriptions.push(
    vscode.commands.registerCommand('bapIde.scm.refresh', async () => {
      const changes = await bapScm.refresh();
      fileDeco.setStatuses(new Map(changes.filter((c) => c.status !== 'NORMAL').map((c) => [c.absolutePath, c.status])));
      void vscode.window.setStatusBarMessage(`BAP: ${changes.filter((c) => c.status !== 'NORMAL').length} 个变更`, 3000);
    }),
    vscode.commands.registerCommand('bapIde.scm.commit', async () => {
      const comment = bapScm.sourceControl.inputBox.value || '';
      await bapScm.commit(comment);
      bapScm.sourceControl.inputBox.value = '';
      void vscode.window.setStatusBarMessage('BAP: 提交完成', 3000);
    }),
    vscode.commands.registerCommand('bapIde.scm.publish', async () => {
      await sdk.publish.gray();
      void vscode.window.setStatusBarMessage('BAP: 已发布', 3000);
    }),
    vscode.commands.registerCommand('bapIde.scm.openDiff', async (change?: Change) => {
      if (!change) return;
      await openDiff(change, workspaceRoot);
    }),
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
