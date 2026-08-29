import * as vscode from 'vscode';
import * as path from 'path';
import { BAP_IDE_NAME, BAP_IDE_VERSION } from '@bap/core';
import { createRpcClient, type BridgeLaunchConfig } from '@bap/rpc';
import { createBapSdk } from '@bap/sdk';
import { activateScm } from '@bap/vscode-host';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('bapIde.showVersion', () => {
      void vscode.window.showInformationMessage(`${BAP_IDE_NAME} v${BAP_IDE_VERSION}`);
    }),
  );

  // 无打开的 workspace folder -> 无法定位 BAP 工程根，SCM 不启用
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    void vscode.window.showWarningMessage('BAP: 请先打开一个含 .develop 的 BAP 工程文件夹');
    return;
  }

  // Java 桥子进程：用扩展内捆绑的 bridge jar 资产
  const launch: BridgeLaunchConfig = {
    classpath: [path.join(context.extensionPath, 'assets', 'bridge', 'lib', '*')],
    mainClass: 'com.bap.dev.BridgeMain',
  };
  const rpc = createRpcClient({ launch });
  const sdk = createBapSdk({ rpc, workspaceRoot: root });

  // 注册 SCM（createSourceControl + 资源组 + 云端 diff + 文件角标 + 命令）
  context.subscriptions.push(...activateScm(context, sdk, root));
  // 关闭扩展时回收 Java 桥
  context.subscriptions.push({ dispose: () => void rpc.close() });
}

export function deactivate(): void {}
