// 云端原版内容 provider：供 vscode.diff 左栏/行内 quick-diff 使用。
// 用虚拟 scheme `bap-original` + TextDocumentContentProvider 返回 BAP 云端原版。
// 多工程：URI 带 pid（projectId），由宿主注入的 resolver 选择对应工程的 SDK。
// 同一个 scheme 在一个窗口内只注册一次，避免多工程重复注册互相覆盖。
import * as vscode from 'vscode';
import type { BapSdk } from '@bap/sdk';
import { parseBapOriginalUri, relToResPath } from './types';
import { parseQueryString } from '../history/history-uri';

export type OriginalSdkResolver = (projectId?: string) => BapSdk | undefined;

let resolver: OriginalSdkResolver | undefined;
let registration: vscode.Disposable | undefined;
let refCount = 0;

class OriginalContentProvider implements vscode.TextDocumentContentProvider {
  private _cache = new Map<string, { t: number; content: string }>();
  private static readonly TTL_MS = 10_000;

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const key = uri.toString();
    const hit = this._cache.get(key);
    if (hit && Date.now() - hit.t < OriginalContentProvider.TTL_MS) return hit.content;

    const parsed = parseBapOriginalUri(uri.path, parseQueryString(uri.query));
    const sdk = resolver?.(parsed.projectId);
    if (!sdk) return '';

    let content = '';
    try {
      if (parsed.isResource) {
        const res = await sdk.code.getRes(relToResPath(parsed.relativePath));
        // fileBin 是 base64 -> 转文本
        content = res?.fileBin ? Buffer.from(res.fileBin, 'base64').toString('utf8') : '';
      } else {
        const fullClass = parsed.relativePath.replace(/\.java$/i, '').split('/').join('.');
        const remote = await sdk.code.getRemote(fullClass);
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

/**
 * 注册 bap-original provider。
 * - 传函数：多工程解析器（pid → SDK）；
 * - 传 SDK：单工程兼容路径。
 * 多次调用共享同一个 provider，最后一个 resolver 生效；全部 dispose 后注销。
 */
export function registerOriginalProvider(source: BapSdk | OriginalSdkResolver): vscode.Disposable {
  if (typeof source === 'function') {
    resolver = source;
  } else {
    const sdk = source;
    resolver = () => sdk;
  }

  if (!registration) {
    const provider = new OriginalContentProvider();
    registration = vscode.workspace.registerTextDocumentContentProvider('bap-original', provider);
    refCount = 1;
  } else {
    refCount++;
  }

  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      refCount--;
      if (refCount <= 0) {
        registration?.dispose();
        registration = undefined;
        resolver = undefined;
        refCount = 0;
      }
    },
  };
}
