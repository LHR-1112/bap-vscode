// BAP SCM Provider：把 VS Code 原生 Source Control 视图接到 BAP 云端工程。
// 数据源 = sdk.refresh() 的变更列表；提交 = sdk.code.save；发布 = sdk.publish；
// diff 云端原版 = sdk.code.getRemote/getRes（经 bap-original content provider）。
import * as vscode from 'vscode';
import * as path from 'path';
import type { BapSdk, Change } from '@bap/sdk';
import { scmDecoFor, statusIconFile } from './types';

export interface BapScmProviderHandle {
  sourceControl: vscode.SourceControl;
  refresh(): Promise<Change[]>;
  getChanges(): Change[];
  getChangeByPath(fsPath: string): Change | undefined;
  getDecorations(): BapFileDecorationMap;
  commitFile(change: Change, comment?: string): Promise<void>;
  updateFile(change: Change): Promise<void>;
  updateAll(): Promise<void>;
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
  /** 状态 SVG 图标目录（M/A/D 的 status-*.svg 所在，如 plugin/resources/scm-icons）。 */
  iconDir?: string;
}

export function createBapScmProvider(
  sdk: BapSdk,
  workspaceRoot: string,
  opts: BapScmProviderOptions = {},
): BapScmProviderHandle {
  const scc = vscode.scm;
  const sc = scc.createSourceControl('bap', 'BAP', vscode.Uri.file(workspaceRoot));

  // git "files changed" 风格三组：按文件状态分组（新增/更改/删除）
  const groups = {
    added: sc.createResourceGroup('added', '新增'),
    modified: sc.createResourceGroup('modified', '更改'),
    deleted: sc.createResourceGroup('deleted', '删除'),
  };
  (Object.values(groups)).forEach((g) => (g.hideWhenEmpty = true));

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
  // 「提交」按钮 / 输入框回车触发提交（git 同款：acceptInputCommand → commit 命令）
  sc.acceptInputCommand = { command: 'bapIde.scm.commit', title: '提交' };
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

    // 按文件状态分成三组（新增/更改/删除）；A/M/D 之外不再有暂存/未暂存维度
    groups.added.resourceStates = dirty
      .filter((c) => c.status === 'ADDED')
      .map((c) => toResourceState(c));
    groups.modified.resourceStates = dirty
      .filter((c) => c.status === 'MODIFIED')
      .map((c) => toResourceState(c));
    groups.deleted.resourceStates = dirty
      .filter((c) => c.status === 'DELETED_LOCALLY')
      .map((c) => toResourceState(c));
    sc.count = dirty.length;

    // 更新文件装饰表
    decoMap.clear();
    for (const c of list) {
      if (c.status !== 'NORMAL') decoMap.set(c.absolutePath, c.status);
    }
  }

  function toResourceState(c: Change): vscode.SourceControlResourceState {
    const deco = scmDecoFor(c.status);
    // git 同款：带颜色 A/M/D 用插件 resources/scm-icons/ 下的 SVG 文件（Uri.file 引用，不用 data-URI）。
    const iconFile = statusIconFile(c.status);
    const iconUri = opts.iconDir && iconFile ? vscode.Uri.file(path.join(opts.iconDir, iconFile)) : undefined;
    const themed = iconUri ? { iconPath: iconUri } : undefined;
    const decorations: vscode.SourceControlResourceDecorations = {
      light: themed,
      dark: themed,
      strikeThrough: deco?.strikeThrough,
      faded: deco?.faded,
      tooltip: deco?.tooltip,
    };
    return {
      resourceUri: vscode.Uri.file(c.absolutePath),
      command: { command: 'bapIde.scm.openDiff', title: '打开 Diff', arguments: [c] },
      decorations,
      // A/M/D 由 iconPath 图标表达，不占用 contextValue。
    };
  }

  /** 按本地绝对路径解析变更（SCM context 菜单把 resourceUri 而非 Change 传给命令）。
   *  因为 toResourceState 里 resourceUri = Uri.file(c.absolutePath)，故可用 fsPath 精确匹配。 */
  function getChangeByPath(fsPath: string): Change | undefined {
    return lastChanges.find((c) => c.absolutePath === fsPath);
  }

  /** 提交单个文件到云端。 */
  async function commitFile(change: Change, comment = ''): Promise<void> {
    await sdk.code.saveChanges([change], comment);
    await refresh();
  }

  /** 更新单个文件：从云端拉取最新版覆盖本地（新增文件删除本地）。 */
  async function updateFile(change: Change): Promise<void> {
    await sdk.discardAll([change]);
    await refresh();
  }

  /** 一键更新所有变更：从云端取最新版覆盖本地/新增删除，再刷新。 */
  async function updateAll(): Promise<void> {
    await sdk.discardAll(lastChanges);
    await refresh();
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
    // 无暂存概念：提交所有变更（新增/更改/删除）。
    const toCommit = lastChanges;
    if (toCommit.length === 0) {
      void vscode.window.showWarningMessage('BAP: 没有更改可提交。');
      return;
    }
    await sdk.code.saveChanges(toCommit, comment);
    await refresh();
  }

  return {
    sourceControl: sc,
    refresh,
    getChanges: () => lastChanges,
    getChangeByPath,
    getDecorations: () => decoMap,
    commitFile,
    updateFile,
    updateAll,
    commit,
    dispose() {
      for (const s of subscriptions) s.dispose();
      if (debounceTimer) clearTimeout(debounceTimer);
      for (const g of Object.values(groups)) g.dispose();
      sc.dispose();
    },
  };
}

function toWorkspaceRel(root: string, abs: string): string {
  const rel = abs.startsWith(root) ? abs.slice(root.length) : abs;
  return rel.replace(/^[/\\]+/, '');
}
