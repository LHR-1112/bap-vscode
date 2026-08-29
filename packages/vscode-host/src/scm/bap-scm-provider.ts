// BAP SCM Provider：把 VS Code 原生 Source Control 视图接到 BAP 云端工程。
// 数据源 = sdk.refresh() 的变更列表；提交 = sdk.code.save；发布 = sdk.publish；
// diff 云端原版 = sdk.code.getRemote/getRes（经 bap-original content provider）。
import * as vscode from 'vscode';
import type { BapSdk, Change } from '@bap/sdk';
import { scmDecoFor } from './types';

export interface BapScmProviderHandle {
  sourceControl: vscode.SourceControl;
  refresh(): Promise<Change[]>;
  getChanges(): Change[];
  getDecorations(): BapFileDecorationMap;
  commit(comment?: string): Promise<void>;
  dispose(): void;
}

/** absolutePath -> Status 的映射（供文件装饰用）。 */
export type BapFileDecorationMap = Map<string, string>;

export interface BapScmProviderOptions {
  /** 是否监听文件变更自动 refresh。默认 true。 */
  autoRefresh?: boolean;
  /** 刷新节流（毫秒）。默认 500。 */
  debounceMs?: number;
}

export function createBapScmProvider(
  sdk: BapSdk,
  workspaceRoot: string,
  opts: BapScmProviderOptions = {},
): BapScmProviderHandle {
  const scc = vscode.scm;
  const sc = scc.createSourceControl('bap', 'BAP', vscode.Uri.file(workspaceRoot));

  const modifiedGroup = sc.createResourceGroup('modified', 'Changes');
  const deletedGroup = sc.createResourceGroup('deleted', 'Deleted');
  modifiedGroup.hideWhenEmpty = true;
  deletedGroup.hideWhenEmpty = true;

  let changes: Change[] = [];
  const decoMap: BapFileDecorationMap = new Map();

  const qdp: vscode.QuickDiffProvider = {
    provideOriginalResource(uri: vscode.Uri): vscode.ProviderResult<vscode.Uri> {
      const ch = changes.find((c) => c.absolutePath === uri.fsPath);
      if (!ch) return undefined;
      // 返回 bap-original 虚拟 URI：path 段用相对 workspace 的 rel，query 带 folder/res/rel
      const rel = toWorkspaceRel(workspaceRoot, ch.absolutePath);
      const q = new URLSearchParams();
      q.set('folder', ch.folder);
      q.set('res', String(ch.isResource));
      q.set('rel', ch.relativePath);
      return vscode.Uri.parse(`bap-original://bap/${encodeURIComponent(rel)}?${q.toString()}`);
    },
  };
  sc.quickDiffProvider = qdp;
  sc.inputBox.placeholder = '提交信息（可选）';
  sc.count = 0;

  let lastChanges: Change[] = [];

  async function refresh(): Promise<Change[]> {
    try {
      changes = await sdk.refresh();
      applyToGroups(changes);
    } catch (e) {
      // 不静默：把真实原因（.develop 缺失 / 连接失败 / folder 不匹配）展示给用户。
      // 保留上一次的 changes，避免因一次抖动清空整个 SCM。
      const msg = e instanceof Error ? e.message : String(e);
      void vscode.window.setStatusBarMessage(`BAP: 刷新失败 - ${msg}`, 6000);
      return changes;
    }
    return changes;
  }

  function applyToGroups(list: Change[]): void {
    const dirty = list.filter((c) => c.status !== 'NORMAL');
    lastChanges = dirty;
    modifiedGroup.resourceStates = dirty
      .filter((c) => c.status === 'MODIFIED' || c.status === 'ADDED')
      .map((c) => toResourceState(c, workspaceRoot));
    deletedGroup.resourceStates = dirty
      .filter((c) => c.status === 'DELETED_LOCALLY')
      .map((c) => toResourceState(c, workspaceRoot));
    sc.count = dirty.length;

    // 更新文件装饰表
    decoMap.clear();
    for (const c of list) {
      if (c.status !== 'NORMAL') decoMap.set(c.absolutePath, c.status);
    }
  }

  function toResourceState(c: Change, root: string): vscode.SourceControlResourceState {
    return {
      resourceUri: vscode.Uri.file(c.absolutePath),
      command: { command: 'bapIde.scm.openDiff', title: '打开 Diff', arguments: [c] },
      decorations: scmDecoFor(c.status) as vscode.SourceControlResourceDecorations,
      contextValue: c.status,
    };
  }

  // ---- 生命周期 ----
  const subscriptions: vscode.Disposable[] = [];

  let debounceTimer: NodeJS.Timeout | undefined;
  function scheduleRefresh(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      void refresh();
    }, opts.debounceMs ?? 500);
  }

  const isInWorkspace = (u: vscode.Uri): boolean =>
    u.fsPath.startsWith(workspaceRoot) || u.scheme === 'file';

  if (opts.autoRefresh !== false) {
    subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (isInWorkspace(e.document.uri)) scheduleRefresh();
      }),
      vscode.workspace.onDidCreateFiles((e) => {
        if (e.files.some(isInWorkspace)) scheduleRefresh();
      }),
      vscode.workspace.onDidDeleteFiles((e) => {
        if (e.files.some(isInWorkspace)) scheduleRefresh();
      }),
      vscode.workspace.onDidRenameFiles((e) => {
        if (e.files.some((f) => isInWorkspace(f.oldUri) || isInWorkspace(f.newUri))) scheduleRefresh();
      }),
    );
  }

  async function commit(comment = ''): Promise<void> {
    // 提交所有当前变更（或全部）；comment 从输入框来
    await sdk.code.save(comment);
    await refresh();
  }

  return {
    sourceControl: sc,
    refresh,
    getChanges: () => lastChanges,
    getDecorations: () => decoMap,
    commit,
    dispose() {
      for (const s of subscriptions) s.dispose();
      if (debounceTimer) clearTimeout(debounceTimer);
      modifiedGroup.dispose();
      deletedGroup.dispose();
      sc.dispose();
    },
  };
}

function toWorkspaceRel(root: string, abs: string): string {
  const rel = abs.startsWith(root) ? abs.slice(root.length) : abs;
  return rel.replace(/^[/\\]+/, '');
}
