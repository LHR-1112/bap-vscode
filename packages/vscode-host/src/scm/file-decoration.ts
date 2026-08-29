// 文件资源管理器角标：把 BAP 变更状态（M/A/D）显示在文件树里。
import * as vscode from 'vscode';
import type { Status } from '@bap/sdk';
import { fileDecoFor } from './types';

export class BapFileDecorationProvider implements vscode.FileDecorationProvider {
  private _statuses = new Map<string, Status>();
  private _onDidChange = new vscode.EventEmitter<undefined | vscode.Uri | vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;

  setStatuses(map: Map<string, Status>): void {
    this._statuses = map;
    this._onDidChange.fire(undefined);
  }

  clear(): void {
    this._statuses.clear();
    this._onDidChange.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.ProviderResult<vscode.FileDecoration> {
    const status = this._statuses.get(uri.fsPath);
    if (!status) return undefined;
    const spec = fileDecoFor(status);
    if (!spec) return undefined;
    const deco = new vscode.FileDecoration(spec.badge, spec.tooltip, new vscode.ThemeColor(spec.color));
    return deco;
  }
}

export function registerFileDecoration(provider: BapFileDecorationProvider): vscode.Disposable {
  return vscode.window.registerFileDecorationProvider(provider);
}
