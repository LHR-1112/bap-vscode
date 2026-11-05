// bap-history：按历史版本 uuid 返回该版本文件内容（供 diff 左侧/右侧只读使用）。
// 多工程：URI 带 pid，resolver 按工程选择 SDK；同 scheme 只注册一次。
import * as vscode from 'vscode';
import type { BapSdk } from '@bap/sdk';
import { bapHistoryUriString, parseHistoryUri } from './history-uri';

export type HistorySdkResolver = (projectId?: string) => BapSdk | undefined;

let resolver: HistorySdkResolver | undefined;
let registration: vscode.Disposable | undefined;
let refCount = 0;

export function registerHistoryContentProvider(source: BapSdk | HistorySdkResolver): vscode.Disposable {
  if (typeof source === 'function') {
    resolver = source;
  } else {
    const sdk = source;
    resolver = () => sdk;
  }

  if (!registration) {
    const provider: vscode.TextDocumentContentProvider = {
      async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const parsed = parseHistoryUri(uri.path, uri.query);
        const sdk = resolver?.(parsed.projectId);
        if (!sdk) return '';
        if (parsed.isResource) {
          const dto = await sdk.history.getHistoryFile(parsed.uuid);
          return dto?.fileBin ? Buffer.from(dto.fileBin, 'base64').toString('utf8') : '';
        }
        const code = await sdk.history.getHistoryCode(parsed.uuid);
        return code?.code ?? '';
      },
    };
    registration = vscode.workspace.registerTextDocumentContentProvider('bap-history', provider);
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

/** 构造 bap-history 虚拟 URI（历史版本内容）。res 写 true/false，读兼容 1/0。 */
export function bapHistoryUri(uuid: string, isRes: boolean, projectId?: string): vscode.Uri {
  return vscode.Uri.parse(bapHistoryUriString(uuid, isRes, projectId));
}
