import * as vscode from 'vscode';
import * as path from 'path';
import { BAP_IDE_NAME, BAP_IDE_VERSION } from '@bap/core';
import { createRpcClient, type BridgeLaunchConfig } from '@bap/rpc';
import { createBapSdk } from '@bap/sdk';
import { activateScm } from '@bap/vscode-host';

export function activate(context: vscode.ExtensionContext): void {
  // BAP IDE 输出通道：所有诊断日志写到「输出 → BAP IDE」，便于排查激活/命令/连接问题。
  const log = vscode.window.createOutputChannel('BAP IDE');
  context.subscriptions.push(log);
  log.appendLine(`[activate] ${BAP_IDE_NAME} v${BAP_IDE_VERSION} 开始激活`);

  context.subscriptions.push(
    vscode.commands.registerCommand('bapIde.showVersion', () => {
      void vscode.window.showInformationMessage(`${BAP_IDE_NAME} v${BAP_IDE_VERSION}`);
    }),
  );

  try {
    // 无打开的 workspace folder -> 无法定位 BAP 工程根，SCM 不启用
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      log.appendLine('[activate] 无 workspace folder，跳过 SCM');
      void vscode.window.showWarningMessage('BAP: 请先打开一个含 .develop 的 BAP 工程文件夹');
      return;
    }
    log.appendLine(`[activate] workspaceRoot = ${root}`);

    // Java 桥子进程：用扩展内捆绑的 bridge jar 资产
    const launch: BridgeLaunchConfig = {
      classpath: [path.join(context.extensionPath, 'assets', 'bridge', 'lib', '*')],
      mainClass: 'com.bap.dev.BridgeMain',
    };
    log.appendLine(`[activate] launch bridge, classpath=${launch.classpath[0]}`);

    const rpc = createRpcClient({ launch });
    const sdk = createBapSdk({ rpc, workspaceRoot: root });

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
