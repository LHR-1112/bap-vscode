import * as vscode from 'vscode';
import { BAP_IDE_NAME, BAP_IDE_VERSION } from '@bap/core';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('bapIde.showVersion', () => {
      void vscode.window.showInformationMessage(`${BAP_IDE_NAME} v${BAP_IDE_VERSION}`);
    }),
  );
}

export function deactivate(): void {}
