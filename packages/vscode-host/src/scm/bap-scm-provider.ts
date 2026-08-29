// BAP SCM Provider：把 VS Code 原生 Source Control 视图接到 BAP 云端工程。
// 数据源 = sdk.refresh() 的变更列表；提交 = sdk.code.save；发布 = sdk.publish；
// diff 云端原版 = sdk.code.getRemote/getRes（经 bap-original content provider）。
import * as vscode from 'vscode';
import * as path from 'path';
import type { BapSdk, Change } from '@bap/sdk';
import { scmDecoFor, stagedIdent, statusIconFile } from './types';

export interface BapScmProviderHandle {
  sourceControl: vscode.SourceControl;
  refresh(): Promise<Change[]>;
  getChanges(): Change[];
  getUnstaged(): Change[];
  getDecorations(): BapFileDecorationMap;
  stage(change: Change): void;
  unstage(change: Change): void;
  stageAll(): void;
  discardAll(): Promise<void>;
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

  // git 风格两组：更改（未暂存）+ 已暂存的更改（用户勾选要提交的）
  const changesGroup = sc.createResourceGroup('changes', '更改');
  const stagedGroup = sc.createResourceGroup('staged', '已暂存的更改');
  changesGroup.hideWhenEmpty = true;
  stagedGroup.hideWhenEmpty = true;

  // 用户暂存过的绝对路径集合（refresh 时保留；status 变 NORMAL 自动清除）
  const stagedPaths = new Set<string>();

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

    // NORMAL 的（曾暂存但已一致）从暂存集合清除
    for (const c of list) {
      if (c.status === 'NORMAL') stagedPaths.delete(stagedIdent(c));
    }

    // 按「是否已暂存」分成两组；A/M/D 状态靠 resource state 的图标/tooltip 及文件树角标区分
    const toStaged = dirty.filter((c) => stagedPaths.has(stagedIdent(c)));
    const toChanges = dirty.filter((c) => !stagedPaths.has(stagedIdent(c)));

    stagedGroup.resourceStates = toStaged.map((c) => toResourceState(c, workspaceRoot, true));
    changesGroup.resourceStates = toChanges.map((c) => toResourceState(c, workspaceRoot, false));
    sc.count = dirty.length;

    // 更新文件装饰表
    decoMap.clear();
    for (const c of list) {
      if (c.status !== 'NORMAL') decoMap.set(c.absolutePath, c.status);
    }
  }

  function toResourceState(c: Change, root: string, staged: boolean): vscode.SourceControlResourceState {
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
      // contextValue 专用于「是否已暂存」，供右键菜单 when 区分 stage/unstage；
      // A/M/D 由 iconPath 图标表达，不占用 contextValue。
      contextValue: staged ? 'staged' : 'unstaged',
    };
  }

  function stage(change: Change): void {
    stagedPaths.add(stagedIdent(change));
    applyToGroups(changes);
  }

  function unstage(change: Change): void {
    stagedPaths.delete(stagedIdent(change));
    applyToGroups(changes);
  }

  /** 「更改」组：未暂存的变更。 */
  const unstagedChanges = (): Change[] => lastChanges.filter((c) => !stagedPaths.has(stagedIdent(c)));

  /** 暂存「更改」组所有未暂存变更（stageAll 按钮）。 */
  function stageAll(): void {
    for (const c of unstagedChanges()) {
      stagedPaths.add(stagedIdent(c));
    }
    applyToGroups(changes);
  }

  /** 放弃「更改」组所有未暂存变更（discardAll 按钮）：从云端取原版覆盖本地，再刷新。 */
  async function discardAll(): Promise<void> {
    await sdk.discardAll(unstagedChanges()); // 只还原未暂存，不误伤已暂存待提交的文件
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
    // 只提交「已暂存」的变更；暂存区为空则提示，避免误提交全部。
    const toCommit = lastChanges.filter((c) => stagedPaths.has(stagedIdent(c)));
    if (toCommit.length === 0) {
      void vscode.window.showWarningMessage('BAP: 没有已暂存的更改。请先在 SCM 里暂存要提交的文件。');
      return;
    }
    await sdk.code.saveChanges(toCommit, comment);
    // 提交后这些文件回到一致（NORMAL），从暂存集合清除
    for (const c of toCommit) stagedPaths.delete(stagedIdent(c));
    await refresh();
  }

  return {
    sourceControl: sc,
    refresh,
    getChanges: () => lastChanges,
    getUnstaged: () => unstagedChanges(),
    getDecorations: () => decoMap,
    commit,
    stage,
    unstage,
    stageAll,
    discardAll,
    dispose() {
      for (const s of subscriptions) s.dispose();
      if (debounceTimer) clearTimeout(debounceTimer);
      changesGroup.dispose();
      stagedGroup.dispose();
      sc.dispose();
    },
  };
}

function toWorkspaceRel(root: string, abs: string): string {
  const rel = abs.startsWith(root) ? abs.slice(root.length) : abs;
  return rel.replace(/^[/\\]+/, '');
}
