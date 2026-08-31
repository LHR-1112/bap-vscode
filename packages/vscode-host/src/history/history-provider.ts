// bap-history：按历史版本 uuid 返回该版本文件内容（供 diff 左侧/右侧只读使用）。
import * as vscode from 'vscode';
import type { BapSdk } from '@bap/sdk';

function parseQuery(uri: vscode.Uri): Record<string, string> {
  const out: Record<string, string> = {};
  uri.query.split('&').forEach((kv) => {
    const [k, v] = kv.split('=');
    if (k && v !== undefined) out[k] = decodeURIComponent(v);
  });
  return out;
}

export function registerHistoryContentProvider(sdk: BapSdk): vscode.Disposable {
  const provider: vscode.TextDocumentContentProvider = {
    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
      const query = parseQuery(uri);
      const uuid = query.uuid || decodeURIComponent(uri.path.replace(/^bap-history:\/\/bap\//, ''));
      const isRes = query.res === 'true';
      if (isRes) {
        const dto = await sdk.history.getHistoryFile(uuid);
        return dto?.fileBin ? Buffer.from(dto.fileBin, 'base64').toString('utf8') : '';
      }
      const code = await sdk.history.getHistoryCode(uuid);
      return code?.code ?? '';
    },
  };
  return vscode.workspace.registerTextDocumentContentProvider('bap-history', provider);
}

/** 构造 bap-history 虚拟 URI（历史版本内容）。 */
export function bapHistoryUri(uuid: string, isRes: boolean): vscode.Uri {
  return vscode.Uri.parse(`bap-history://bap/${encodeURIComponent(uuid)}?res=${isRes ? 1 : 0}`);
}
