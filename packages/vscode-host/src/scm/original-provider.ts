// 云端原版内容 provider：供 vscode.diff 左栏/行内 quick-diff 使用。
// 用虚拟 scheme `bap-original` + TextDocumentContentProvider 返回 BAP 云端原版。
import * as vscode from 'vscode';
import type { BapSdk } from '@bap/sdk';
import { parseBapOriginalUri, relToResPath } from './types';

class OriginalContentProvider implements vscode.TextDocumentContentProvider {
  private _cache = new Map<string, { t: number; content: string }>();
  private static readonly TTL_MS = 10_000;

  constructor(private sdk: BapSdk) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const key = uri.toString();
    const hit = this._cache.get(key);
    if (hit && Date.now() - hit.t < OriginalContentProvider.TTL_MS) return hit.content;

    const query: Record<string, string> = {};
    uri.query.split('&').forEach((kv) => {
      const [k, v] = kv.split('=');
      if (k && v !== undefined) query[k] = decodeURIComponent(v);
    });
    const parsed = parseBapOriginalUri(uri.path, query);

    let content = '';
    try {
      if (parsed.isResource) {
        const res = await this.sdk.code.getRes(relToResPath(parsed.relativePath));
        // fileBin 是 base64 -> 转文本
        content = res?.fileBin ? Buffer.from(res.fileBin, 'base64').toString('utf8') : '';
      } else {
        const fullClass = parsed.relativePath.replace(/\.java$/i, '').split('/').join('.');
        const remote = await this.sdk.code.getRemote(fullClass);
        content = remote?.code ?? '';
      }
    } catch {
      content = '';
    }

    this._cache.set(key, { t: Date.now(), content });
    return content;
  }

  clearCache(uri?: vscode.Uri): void {
    if (uri) this._cache.delete(uri.toString());
    else this._cache.clear();
  }
}

export function registerOriginalProvider(sdk: BapSdk): vscode.Disposable {
  const provider = new OriginalContentProvider(sdk);
  return vscode.workspace.registerTextDocumentContentProvider('bap-original', provider);
}
