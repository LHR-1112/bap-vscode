// BAP SCM Provider：把 VS Code 原生 Source Control 视图接到 BAP 云端工程。
// 数据源 = sdk.refresh() 的变更列表；提交 = sdk.code.save；发布 = sdk.publish；
// diff 云端原版 = sdk.code.getRemote/getRes（经 bap-original content provider）。
// 多工程：每工程一个 provider（id=`bap:<projectId>`），组 id=`<projectId>:added|modified|deleted`。
import * as vscode from 'vscode';
import * as path from 'path';
import type { BapSdk, Change } from '@bap/sdk';
import { scmDecoFor, statusIconFile } from './types';
import { bapOriginalUriSpec } from './types';
import { isIgnoredProjectPath, isInProjectSrc, pathKey } from '../projects/project-paths';

export interface BapScmProviderHandle {
  sourceControl: vscode.SourceControl;
  resourceGroups: readonly vscode.SourceControlResourceGroup[];
  projectId: string;
  displayName: string;
  /** force=true 强制重拉云端快照（手动刷新）；false=自动刷新（TTL 内复用云端快照）。
   *  throwOnError=true 时不吞错（MCP/批量命令需要真实失败）。 */
  refresh(force?: boolean, opts?: { throwOnError?: boolean }): Promise<Change[]>;
  getChanges(): Change[];
  getChangeByPath(fsPath: string): Change | undefined;
  getDecorations(): BapFileDecorationMap;
  commitFile(change: Change, comment?: string): Promise<void>;
  updateFile(change: Change): Promise<void>;
  commitChanges(changes: Change[], comment?: string): Promise<void>;
  updateChanges(changes: Change[]): Promise<void>;
  updateAll(): Promise<void>;
  commit(comment?: string): Promise<void>;
  dispose(): void;
}

/** absolutePath -> Status 的映射（供文件装饰用）。 */
export type BapFileDecorationMap = Map<string, string>;

export interface BapScmProviderOptions {
  /** 工程稳定 ID；缺省 `legacy`（兼容旧的单工程激活入口）。 */
  projectId?: string;
  /** 展示名（创建 SourceControl 标签后不可改）。 */
  displayName?: string;
  /** SourceControl id；缺省 `bap`（legacy）或 `bap:<projectId>`。 */
  providerId?: string;
  /** 是否监听文件变更自动 refresh。默认 true。 */
  autoRefresh?: boolean;
  /** 刷新节流（毫秒）。默认 500。 */
  debounceMs?: number;
  /** 两次刷新之间的最小间隔（毫秒）。默认 1000。 */
  minRefreshIntervalMs?: number;
  /** 状态 SVG 图标目录（M/A/D 的 status-*.svg 所在，如 plugin/resources/scm-icons）。 */
  iconDir?: string;
  /** 路径是否归本工程所有（多工程 watcher 防跨工程刷新）。 */
  ownsPath?: (fsPath: string) => boolean;
  /** 自动刷新（保存/watcher）的串行入口；宿主注入工程队列，避免与长任务抢单线程 Java 桥。 */
  autoRefreshRunner?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** 刷新完成回调（宿主更新文件角标）。 */
  onChanges?: (changes: Change[]) => void;
  /** provider 释放回调（宿主清理角标 owner）。 */
  onDispose?: () => void;
  log?: { debug(msg: string): void; error(msg: string): void };
}

function groupId(projectId: string, name: 'added' | 'modified' | 'deleted'): string {
  return projectId === 'legacy' ? name : `${projectId}:${name}`;
}

export function createBapScmProvider(
  sdk: BapSdk,
  workspaceRoot: string,
  opts: BapScmProviderOptions = {},
): BapScmProviderHandle {
  const projectId = opts.projectId ?? 'legacy';
  const displayName = opts.displayName ?? 'BAP';
  const providerId = opts.providerId ?? (projectId === 'legacy' ? 'bap' : `bap:${projectId}`);
  const label = projectId === 'legacy' ? 'BAP' : `BAP · ${displayName}`;
  const scc = vscode.scm;
  const sc = scc.createSourceControl(providerId, label, vscode.Uri.file(workspaceRoot));

  // git "files changed" 风格三组：按文件状态分组（新增/更改/删除）
  const groups = {
    added: sc.createResourceGroup(groupId(projectId, 'added'), '新增'),
    modified: sc.createResourceGroup(groupId(projectId, 'modified'), '更改'),
    deleted: sc.createResourceGroup(groupId(projectId, 'deleted'), '删除'),
  };
  Object.values(groups).forEach((g) => (g.hideWhenEmpty = true));

  let changes: Change[] = [];
  const decoMap: BapFileDecorationMap = new Map();
  let disposed = false;

  const qdp: vscode.QuickDiffProvider = {
    provideOriginalResource(uri: vscode.Uri): vscode.ProviderResult<vscode.Uri> {
      const ch = getChangeByPath(uri.fsPath);
      if (!ch) return undefined;
      return vscode.Uri.parse(
        bapOriginalUriSpec(workspaceRoot, ch.relativePath, ch.folder, ch.isResource, projectId),
      );
    },
  };
  sc.quickDiffProvider = qdp;
  sc.inputBox.placeholder = '提交信息（可选）';
  // 「提交」大按钮 / 输入框回车触发提交（git 同款：acceptInputCommand → commit 命令）。
  // 带 projectId，确保点的是哪个 provider 就提交哪个工程（否则多工程标题栏无法区分）。
  sc.acceptInputCommand = {
    command: 'bapIde.scm.commit',
    title: '提交全部',
    arguments: [{ projectId }],
  };
  sc.count = 0;

  let lastChanges: Change[] = [];

  // 刷新合并：同一时刻只跑一个 sdk.refresh；期间所有请求合并成一轮，
  // 任一请求要求 force 则本轮 force；strict 调用方在失败时拿到 reject。
  interface RefreshWaiter {
    resolve: (v: Change[]) => void;
    reject: (e: unknown) => void;
    throwOnError: boolean;
  }
  let waiters: RefreshWaiter[] = [];
  let running: Promise<Change[]> | null = null;
  let queued = false;
  let queuedForce = false;

  function refresh(force = false, refreshOpts: { throwOnError?: boolean } = {}): Promise<Change[]> {
    if (disposed) return Promise.resolve(changes);
    return new Promise<Change[]>((resolve, reject) => {
      waiters.push({ resolve, reject, throwOnError: !!refreshOpts.throwOnError });
      if (running) {
        queued = true;
        queuedForce = queuedForce || force;
        return;
      }
      void drain();
    });
  }

  async function drain(): Promise<void> {
    if (running) return;
    do {
      queued = false;
      const force = queuedForce;
      queuedForce = false;
      const batch = waiters;
      waiters = [];
      running = (async () => {
        try {
          const next = await sdk.refresh(force);
          if (disposed) return next;
          changes = next;
          applyToGroups(changes);
          opts.log?.debug(`[${displayName}][refresh] 完成，变更=${lastChanges.length}`);
          return changes;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          opts.log?.error(`[${displayName}][refresh] 失败: ${msg}`);
          if (batch.every((w) => !w.throwOnError)) {
            void vscode.window.setStatusBarMessage(`BAP: ${displayName} 刷新失败 - ${msg}`, 6000);
          }
          throw e;
        } finally {
          running = null;
        }
      })();
      try {
        const result = await running;
        for (const w of batch) w.resolve(result);
      } catch (e) {
        for (const w of batch) {
          if (w.throwOnError) w.reject(e);
          else w.resolve(changes);
        }
      }
    } while (queued && !disposed);
    if (!running && waiters.length > 0 && !disposed) void drain();
  }

  function applyToGroups(list: Change[]): void {
    if (disposed) return;
    const dirty = list.filter((c) => c.status !== 'NORMAL');
    lastChanges = dirty;

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

    decoMap.clear();
    for (const c of dirty) decoMap.set(c.absolutePath, c.status);
    opts.onChanges?.(list);
  }

  function toResourceState(c: Change): vscode.SourceControlResourceState {
    const deco = scmDecoFor(c.status);
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
    const change: Change = {
      ...c,
      projectId,
      projectRoot: workspaceRoot,
    };
    return {
      resourceUri: vscode.Uri.file(c.absolutePath),
      command: { command: 'bapIde.scm.openDiff', title: '打开 Diff', arguments: [change] },
      decorations,
      contextValue: `bap:${projectId}`,
    };
  }

  /** 按本地绝对路径解析变更（SCM context 菜单把 resourceUri 而非 Change 传给命令）。 */
  function getChangeByPath(fsPath: string): Change | undefined {
    const exact = lastChanges.find((c) => c.absolutePath === fsPath);
    if (exact) return exact;
    const key = pathKey(fsPath);
    return lastChanges.find((c) => pathKey(c.absolutePath) === key);
  }

  /** 提交回读验证告警：云端内容与提交内容不一致（疑似服务端转码损坏）时弹出。 */
  function warnVerify(result: { verifyWarnings?: string[] }): void {
    if (result.verifyWarnings?.length) {
      const detail = result.verifyWarnings.slice(0, 5).join('\n');
      const more = result.verifyWarnings.length > 5 ? `\n…等 ${result.verifyWarnings.length} 个文件` : '';
      void vscode.window
        .showWarningMessage(
          `BAP: [${displayName}] 云端存下来的内容与提交的内容不一致，重新拉取可能得到乱码！`,
          { modal: true },
          '知道了',
        )
        .then(() => {
          void vscode.window.showInformationMessage(detail + more, { modal: true });
        });
    }
  }

  async function commitFile(change: Change, comment = ''): Promise<void> {
    const r = await sdk.code.saveChanges([change], comment);
    warnVerify(r);
    await refresh(true, { throwOnError: true });
  }

  async function updateFile(change: Change): Promise<void> {
    await sdk.discardAll([change]);
    await refresh(true, { throwOnError: true });
  }

  async function commitChanges(list: Change[], comment = ''): Promise<void> {
    if (list.length === 0) {
      void vscode.window.showWarningMessage('BAP: 没有更改可提交');
      return;
    }
    const r = await sdk.code.saveChanges(list, comment);
    warnVerify(r);
    await refresh(true, { throwOnError: true });
  }

  async function updateChanges(list: Change[]): Promise<void> {
    await sdk.discardAll(list);
    await refresh(true, { throwOnError: true });
  }

  async function updateAll(): Promise<void> {
    await sdk.discardAll(lastChanges);
    await refresh(true, { throwOnError: true });
  }

  async function commit(comment = ''): Promise<void> {
    const toCommit = lastChanges;
    if (toCommit.length === 0) {
      void vscode.window.showWarningMessage('BAP: 没有更改可提交。');
      return;
    }
    const r = await sdk.code.saveChanges(toCommit, comment);
    warnVerify(r);
    await refresh(true, { throwOnError: true });
  }

  // ---- 生命周期 ----
  const subscriptions: vscode.Disposable[] = [];
  let debounceTimer: NodeJS.Timeout | undefined;

  function scheduleRefresh(force = false): void {
    if (disposed) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      const run = () => refresh(force).catch(() => undefined);
      try {
        const pending = opts.autoRefreshRunner ? opts.autoRefreshRunner(run) : run();
        void pending.catch(() => undefined);
      } catch {
        // 工程上下文已释放/失效：自动刷新静默放弃。
      }
    }, opts.debounceMs ?? 500);
  }

  /** 该 URI 是否属于本工程的 src/（file scheme + 未被忽略 + 最深包含者）。 */
  const ownsUri = (u: vscode.Uri): boolean => {
    if (u.scheme !== 'file') return false;
    if (!isInProjectSrc(workspaceRoot, u.fsPath)) return false;
    if (isIgnoredProjectPath(workspaceRoot, u.fsPath)) return false;
    return opts.ownsPath ? opts.ownsPath(u.fsPath) : true;
  };

  if (opts.autoRefresh !== false) {
    // 保存：编辑器内改动落盘后刷新（比 onDidChangeTextDocument 安静得多）。
    subscriptions.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (ownsUri(doc.uri)) scheduleRefresh();
      }),
    );
    // 新建/删除/重命名：watcher 只看本工程 src/**，避免多工程互相触发。
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(workspaceRoot), 'src/**'),
    );
    subscriptions.push(
      watcher,
      watcher.onDidCreate((u) => {
        if (ownsUri(u)) scheduleRefresh();
      }),
      watcher.onDidChange((u) => {
        if (ownsUri(u)) scheduleRefresh();
      }),
      watcher.onDidDelete((u) => {
        if (ownsUri(u)) scheduleRefresh();
      }),
      vscode.workspace.onDidRenameFiles((e) => {
        if (e.files.some((f) => ownsUri(f.oldUri) || ownsUri(f.newUri))) scheduleRefresh();
      }),
    );
  }

  return {
    sourceControl: sc,
    resourceGroups: Object.values(groups),
    projectId,
    displayName,
    refresh,
    getChanges: () => lastChanges,
    getChangeByPath,
    getDecorations: () => decoMap,
    commitFile,
    updateFile,
    commitChanges,
    updateChanges,
    updateAll,
    commit,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = undefined;
      for (const s of subscriptions) s.dispose();
      for (const g of Object.values(groups)) g.dispose();
      sc.dispose();
      decoMap.clear();
      lastChanges = [];
      try {
        opts.onDispose?.();
      } catch {
        /* ignore */
      }
    },
  };
}
