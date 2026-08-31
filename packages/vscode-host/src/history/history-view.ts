// 历史 webview 面板：createWebviewPanel 打开编辑器标签页 + IPC。复刻 GitLens commit details 布局。
import * as vscode from 'vscode';
import type { BapSdk, VersionNode } from '@bap/sdk';
import { bapHistoryUri } from './history-provider';

export type HistoryKind = 'project' | 'file';

/** 打开历史 diff：左侧 = 选中版本内容（bap-history），右侧 = 该文件前一版本内容。 */
export async function openHistoryDiff(sdk: BapSdk, node: VersionNode): Promise<void> {
  if (!node.uuid || !node.key) return;
  const isRes = (node.key ?? '').includes('/');
  const history = await sdk.history.queryFileHistory(node.key ?? '');
  const prev = history
    .filter((v) => (v.versionNo ?? 0) < (node.versionNo ?? 0))
    .sort((a, b) => (b.versionNo ?? 0) - (a.versionNo ?? 0))[0];
  if (!prev?.uuid) {
    void vscode.window.showInformationMessage('BAP: 无前一版本，无法对比');
    return;
  }
  const left = bapHistoryUri(node.uuid, isRes);
  const right = bapHistoryUri(prev.uuid, isRes);
  await vscode.commands.executeCommand(
    'vscode.diff',
    left,
    right,
    `${node.key} @#${node.versionNo} vs #${prev.versionNo}`,
    { preview: true },
  );
}

/** 打开历史 webview（编辑器标签页）。kind=project 显示全部版本；file 显示该文件版本。 */
export async function openHistoryView(
  kind: HistoryKind,
  sdk: BapSdk,
  context: vscode.ExtensionContext,
  remoteKey?: string,
): Promise<void> {
  const title = kind === 'project' ? '项目历史' : `文件历史 ${remoteKey ?? ''}`;
  const panel = vscode.window.createWebviewPanel('bapIde.historyView', title, vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });

  const scriptUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(vscode.Uri.file(context.extensionPath), 'dist', 'history-view.js'),
  );
  const nonce = getNonce();
  panel.webview.html = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>html,body,#app{height:100%;margin:0}body{background:var(--vscode-editor-background)}</style>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;

  panel.webview.onDidReceiveMessage(async (msg: { type?: string; commit?: VersionNode; file?: VersionNode }) => {
    try {
      if (msg.type === 'init') {
        const commits =
          kind === 'project'
            ? await sdk.history.queryVersionList()
            : await sdk.history.queryFileHistory(remoteKey ?? '');
        await panel.webview.postMessage({ type: 'commits', commits });
        return;
      }
      if (msg.type === 'select') {
        if (kind === 'project' && msg.commit) {
          const files = await sdk.history.queryVersionDetail(msg.commit.versionNo ?? 0);
          await panel.webview.postMessage({ type: 'files', files });
        } else if (kind === 'file' && msg.commit) {
          await openHistoryDiff(sdk, msg.commit);
        }
        return;
      }
      if (msg.type === 'openDiff' && msg.file) {
        await openHistoryDiff(sdk, msg.file);
      }
    } catch (e) {
      void vscode.window.showErrorMessage(`历史查询失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 24; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}
