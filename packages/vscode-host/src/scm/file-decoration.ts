// 文件资源管理器角标：把 BAP 变更状态（M/A/D）显示在文件树里。
// 多工程：按 owner（projectId）分别保存状态，provider 展示并集；某工程刷新不会清掉其他工程的角标。
import * as vscode from 'vscode';
import type { Status } from '@bap/sdk';
import { fileDecoFor } from './types';

export class BapFileDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly _byOwner = new Map<string, Map<string, Status>>();
  private _merged = new Map<string, Status>();
  private _onDidChange = new vscode.EventEmitter<undefined | vscode.Uri | vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;

  /** 设置某工程（owner）的状态表；缺省 owner 兼容单工程调用。 */
  setStatuses(map: Map<string, Status>, owner = 'default'): void {
    this._byOwner.set(owner, map);
    this.rebuild();
    this._onDidChange.fire(undefined);
  }

  /** 清除某工程状态；不传 owner 清全部。 */
  clear(owner?: string): void {
    if (owner) this._byOwner.delete(owner);
    else this._byOwner.clear();
    this.rebuild();
    this._onDidChange.fire(undefined);
  }

  removeOwner(owner: string): void {
    this.clear(owner);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.ProviderResult<vscode.FileDecoration> {
    const status = this._merged.get(uri.fsPath);
    if (!status) return undefined;
    const spec = fileDecoFor(status);
    if (!spec) return undefined;
    const deco = new vscode.FileDecoration(spec.badge, spec.tooltip, new vscode.ThemeColor(spec.color));
    return deco;
  }

  dispose(): void {
    this._onDidChange.dispose();
  }

  private rebuild(): void {
    this._merged = new Map();
    for (const map of this._byOwner.values()) {
      for (const [path, status] of map) this._merged.set(path, status);
    }
  }
}

export function registerFileDecoration(provider: BapFileDecorationProvider): vscode.Disposable {
  return vscode.window.registerFileDecorationProvider(provider);
}
