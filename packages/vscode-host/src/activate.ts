// 激活 BAP SCM：创建 SCM provider + 云端原版 provider + 文件角标 + 注册命令。
import * as vscode from 'vscode';
import * as path from 'path';
import type { BapSdk, CJavaProjectDto, Change, RelocateProfile } from '@bap/sdk';
import { addRelocateHistory, loadDevelop, loadRelocateHistory, removeRelocateHistory } from '@bap/sdk';
import { createBapScmProvider, type BapScmProviderHandle } from './scm/bap-scm-provider';
import { registerOriginalProvider } from './scm/original-provider';
import { groupToStatus } from './scm/types';
import { BapFileDecorationProvider, registerFileDecoration } from './scm/file-decoration';

export interface ActivateScmOptions {
  autoRefresh?: boolean;
  /** 输出通道，用于把激活/命令的日志与错误打到「输出 → BAP IDE」。 */
  log?: vscode.OutputChannel;
}

function makeLog(opts: ActivateScmOptions): { debug(msg: string): void; error(msg: string): void } {
  const channel = opts.log;
  return {
    debug: (msg) => {
      if (channel) channel.appendLine(`[activate.scm] ${msg}`);
    },
    error: (msg) => {
      if (channel) {
        channel.appendLine(`[activate.scm][ERROR] ${msg}`);
      }
      console.error(msg);
    },
  };
}

/** 激活并返回需要 push 到 context.subscriptions 的 Disposable 数组。 */
export function activateScm(
  context: vscode.ExtensionContext,
  sdk: BapSdk,
  workspaceRoot: string,
  opts: ActivateScmOptions = {},
): vscode.Disposable[] {
  const log = makeLog(opts);
  const subscriptions: vscode.Disposable[] = [];

  log.debug('createBapScmProvider...');
  const iconDir = path.join(context.extensionPath, 'resources', 'scm-icons');
  const bapScm = createBapScmProvider(sdk, workspaceRoot, { autoRefresh: opts.autoRefresh, iconDir });
  log.debug('registerOriginalProvider...');
  const originalProvider = registerOriginalProvider(sdk);
  const fileDeco = new BapFileDecorationProvider();
  const fileDecoDisposable = registerFileDecoration(fileDeco);
  log.debug('providers 就绪');

  subscriptions.push(
    { dispose: () => bapScm.dispose() },
    originalProvider,
    fileDecoDisposable,
  );

  // 初始刷新
  void bapScm.refresh()
    .then((changes) => {
      fileDeco.setStatuses(new Map(changes.filter((c) => c.status !== 'NORMAL').map((c) => [c.absolutePath, c.status])));
      log.debug(`初始 refresh 完成，非 NORMAL=${changes.filter((c) => c.status !== 'NORMAL').length}`);
    })
    .catch((e) => log.error(`初始 refresh 失败: ${e instanceof Error ? e.message : String(e)}`));

  const safe = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      log.error(`命令 ${name} 执行失败: ${e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e)}`);
      void vscode.window.showErrorMessage(`BAP 命令 ${name} 失败，详见输出面板「BAP IDE」`);
    }
  };

  /** SCM context 菜单（右键/内联单个 resource）传给命令的是 resourceUri 或 resource state，而非 Change。
   *  这里统一解析回 provider 里的 Change（按 fsPath 精确匹配）。 */
  function resolveChange(arg: unknown): Change | undefined {
    if (!arg || typeof arg !== 'object') return undefined;
    const a = arg as { fsPath?: unknown; resourceUri?: { fsPath?: unknown }; absolutePath?: unknown };
    let fsPath: string | undefined;
    if (typeof a.fsPath === 'string') fsPath = a.fsPath;
    else if (a.resourceUri && typeof (a.resourceUri as { fsPath?: unknown }).fsPath === 'string') {
      fsPath = (a.resourceUri as { fsPath: string }).fsPath;
    } else if (typeof a.absolutePath === 'string') {
      fsPath = a.absolutePath;
    }
    if (!fsPath) return undefined;
    return bapScm.getChangeByPath(fsPath);
  }

  // --- 命令 ---
  subscriptions.push(
    vscode.commands.registerCommand('bapIde.scm.refresh', async () =>
      safe('bapIde.scm.refresh', async () => {
        log.debug('触发 refresh');
        void vscode.window.showInformationMessage('BAP: refresh 已触发');
        const changes = await bapScm.refresh();
        fileDeco.setStatuses(new Map(changes.filter((c) => c.status !== 'NORMAL').map((c) => [c.absolutePath, c.status])));
        void vscode.window.setStatusBarMessage(`BAP: ${changes.filter((c) => c.status !== 'NORMAL').length} 个变更`, 3000);
      }),
    ),
    vscode.commands.registerCommand('bapIde.scm.commit', async () =>
      safe('bapIde.scm.commit', async () => {
        log.debug('触发 commit');
        void vscode.window.showInformationMessage('BAP: commit 已触发');
        const comment = bapScm.sourceControl.inputBox.value || '';
        await bapScm.commit(comment);
        bapScm.sourceControl.inputBox.value = '';
        void vscode.window.setStatusBarMessage('BAP: 提交完成', 3000);
      }),
    ),
    vscode.commands.registerCommand('bapIde.scm.publish', async () =>
      safe('bapIde.scm.publish', async () => {
        log.debug('触发 publish');
        const msg = await vscode.window.showWarningMessage(
          '确定发布插件（全量）？将把当前工程发布给所有用户。',
          { modal: true },
          '发布',
        );
        if (msg !== '发布') return;
        await sdk.publish.full();
        void vscode.window.setStatusBarMessage('BAP: 已发布插件（全量）', 3000);
      }),
    ),
    vscode.commands.registerCommand('bapIde.scm.openDiff', async (arg?: unknown) =>
      safe('bapIde.scm.openDiff', async () => {
        const change = resolveChange(arg);
        log.debug(`openDiff: change=${change ? `${change.relativePath}|${change.absolutePath}` : '(未找到)'}`);
        if (!change) return;
        await openDiff(change, workspaceRoot);
      }),
    ),
    vscode.commands.registerCommand('bapIde.scm.openFile', async (arg?: unknown) =>
      safe('bapIde.scm.openFile', async () => {
        const change = resolveChange(arg);
        log.debug(`openFile: change=${change ? `${change.relativePath}|${change.absolutePath}` : '(未找到)'}`);
        if (!change) return;
        // 已删除的本地文件无法打开
        if (change.status === 'DELETED_LOCALLY') {
          void vscode.window.showInformationMessage(`BAP: 文件已删除，无法打开：${change.relativePath}`);
          return;
        }
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(change.absolutePath));
      }),
    ),
    vscode.commands.registerCommand('bapIde.scm.commitFile', async (arg?: unknown) =>
      safe('bapIde.scm.commitFile', async () => {
        const change = resolveChange(arg);
        log.debug(`commitFile: change=${change ? `${change.relativePath}|${change.absolutePath}` : '(未找到)'}`);
        if (!change) return;
        const comment = bapScm.sourceControl.inputBox.value || '';
        await bapScm.commitFile(change, comment);
        bapScm.sourceControl.inputBox.value = '';
        void vscode.window.setStatusBarMessage('BAP: 已提交该文件', 3000);
      }),
    ),
    vscode.commands.registerCommand('bapIde.scm.updateFile', async (arg?: unknown) =>
      safe('bapIde.scm.updateFile', async () => {
        const change = resolveChange(arg);
        log.debug(`updateFile: change=${change ? `${change.relativePath}|${change.absolutePath}` : '(未找到)'}`);
        if (!change) return;
        await bapScm.updateFile(change);
        void vscode.window.setStatusBarMessage('BAP: 已从云端更新该文件', 3000);
      }),
    ),
    vscode.commands.registerCommand('bapIde.scm.openAllChanges', async () =>
      safe('bapIde.scm.openAllChanges', async () => {
        const list = bapScm.getChanges();
        log.debug(`openAllChanges: ${list.length} 个`);
        if (list.length === 0) {
          void vscode.window.showInformationMessage('BAP: 没有更改');
          return;
        }
        // 逐份打开「更改」组每个文件的 diff（左=云端原版，右=本地）
        for (const c of list) {
          if (c.absolutePath) await openDiff(c, workspaceRoot);
        }
      }),
    ),
    vscode.commands.registerCommand('bapIde.scm.updateGroup', async (group?: vscode.SourceControlResourceGroup) =>
      safe('bapIde.scm.updateGroup', async () => {
        if (!group?.id) {
          void vscode.window.showWarningMessage('BAP: 请在资源组上点击此操作');
          return;
        }
        const status = groupToStatus(group.id);
        if (!status) return;
        const list = bapScm.getChanges().filter((c) => c.status === status);
        log.debug(`updateGroup[${group.id}]: ${list.length} 个`);
        if (list.length === 0) {
          void vscode.window.showInformationMessage('BAP: 该组没有更改');
          return;
        }
        const msg = await vscode.window.showWarningMessage(
          `确定更新「${group.label}」组这 ${list.length} 个文件到云端最新版？将覆盖本地改动，新增文件会被删除。`,
          { modal: true },
          '更新',
        );
        if (msg !== '更新') return;
        await bapScm.updateChanges(list);
        void vscode.window.setStatusBarMessage('BAP: 已更新该组', 3000);
      }),
    ),
    vscode.commands.registerCommand('bapIde.scm.commitGroup', async (group?: vscode.SourceControlResourceGroup) =>
      safe('bapIde.scm.commitGroup', async () => {
        if (!group?.id) {
          void vscode.window.showWarningMessage('BAP: 请在资源组上点击此操作');
          return;
        }
        const status = groupToStatus(group.id);
        if (!status) return;
        const list = bapScm.getChanges().filter((c) => c.status === status);
        log.debug(`commitGroup[${group.id}]: ${list.length} 个`);
        if (list.length === 0) {
          void vscode.window.showInformationMessage('BAP: 该组没有可提交的更改');
          return;
        }
        const comment = bapScm.sourceControl.inputBox.value || '';
        await bapScm.commitChanges(list, comment);
        bapScm.sourceControl.inputBox.value = '';
        void vscode.window.setStatusBarMessage('BAP: 已提交该组', 3000);
      }),
    ),
    vscode.commands.registerCommand('bapIde.scm.updateAll', async () =>
      safe('bapIde.scm.updateAll', async () => {
        log.debug('触发 updateAll');
        const msg = await vscode.window.showWarningMessage(
          '确定更新所有文件到云端最新版？将覆盖本地改动，新增文件会被删除。',
          { modal: true },
          '更新',
        );
        if (msg !== '更新') return;
        await bapScm.updateAll();
        void vscode.window.showInformationMessage('BAP: 已更新所有文件');
      }),
    ),
    vscode.commands.registerCommand('bapIde.scm.redirect', async () =>
      safe('bapIde.scm.redirect', async () => {
        log.debug('触发 redirect');
        await runRedirect(sdk, bapScm, workspaceRoot, log);
      }),
    ),
  );

  return subscriptions;
}

/** 打开 diff：左侧 = bap-original（云端原版），右侧 = 本地文件。 */
async function openDiff(change: Change, workspaceRoot: string): Promise<void> {
  const q = new URLSearchParams();
  q.set('folder', change.folder);
  q.set('res', String(change.isResource));
  q.set('rel', change.relativePath);
  const rel = change.absolutePath.startsWith(workspaceRoot)
    ? change.absolutePath.slice(workspaceRoot.length).replace(/^[/\\]+/, '')
    : change.absolutePath;
  const left = vscode.Uri.parse(`bap-original://bap/${encodeURIComponent(rel)}?${q.toString()}`);
  const right = vscode.Uri.file(change.absolutePath);
  const title = change.isResource
    ? `${change.relativePath} (BAP)`
    : `${change.fullClass ?? change.relativePath} (BAP)`;

  await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
}

// ---- 重定向（redirect）----

type RedirectDecision =
  | { type: 'pick'; profile: RelocateProfile }
  | { type: 'new' }
  | { type: 'edit'; profile: RelocateProfile }
  | { type: 'cancel' };

/** 入口：先展示重定向历史，选一条直达；可编辑；底部新增。 */
async function runRedirect(
  sdk: BapSdk,
  bapScm: BapScmProviderHandle,
  workspaceRoot: string,
  log: { debug(msg: string): void; error(msg: string): void },
): Promise<void> {
  ensureCurrentInHistory(workspaceRoot);
  const history = loadRelocateHistory(workspaceRoot);
  const decision = await showHistoryQuickPick(history, workspaceRoot);
  log.debug(`redirect decision=${decision.type}`);

  if (decision.type === 'cancel') return;
  if (decision.type === 'pick') {
    await applyRedirect(sdk, bapScm, decision.profile);
    return;
  }
  if (decision.type === 'new') {
    await collectAndRedirect(sdk, bapScm, log);
    return;
  }
  if (decision.type === 'edit') {
    await editAndRedirect(sdk, bapScm, decision.profile);
  }
}

/** QuickPick：历史列表（每条带编辑/删除按钮）+ 底部「新增地址」。返回选择。 */
async function showHistoryQuickPick(history: RelocateProfile[], workspaceRoot: string): Promise<RedirectDecision> {
  const EDIT_BTN = { iconPath: new vscode.ThemeIcon('edit'), tooltip: '编辑' };
  const DEL_BTN = { iconPath: new vscode.ThemeIcon('trash'), tooltip: '删除' };
  const profileByItem = new Map<vscode.QuickPickItem, RelocateProfile | 'NEW'>();
  const items: vscode.QuickPickItem[] = history.map((h) => {
    const item: vscode.QuickPickItem = {
      label: `${h.uri} - ${h.user}`,
    };
    item.buttons = [DEL_BTN, EDIT_BTN];
    profileByItem.set(item, h);
    return item;
  });
  const newItem: vscode.QuickPickItem = {
    label: '$(add) 新增地址',
    description: '输入 ws 地址 / 账号 / 密码，并选择目标工程',
  };
  profileByItem.set(newItem, 'NEW');
  items.push(newItem);

  return new Promise<RedirectDecision>((resolve) => {
    const qp = vscode.window.createQuickPick();
    qp.items = items;
    qp.placeholder = '选择重定向历史（可直接重定向 / 编辑 / 删除），或新增地址';
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    let done = false;
    const finish = (d: RedirectDecision): void => {
      if (done) return;
      done = true;
      qp.hide();
      resolve(d);
    };
    qp.onDidTriggerItemButton((e) => {
      const rec = profileByItem.get(e.item);
      if (!rec || rec === 'NEW') return;
      if (e.button === DEL_BTN) {
        // 就地删除：更新文件并刷新列表（不离开弹窗）
        removeRelocateHistory(workspaceRoot, rec);
        profileByItem.delete(e.item);
        qp.items = qp.items.filter((i) => i !== e.item);
        return;
      }
      if (e.button === EDIT_BTN) finish({ type: 'edit', profile: rec });
    });
    qp.onDidAccept(() => {
      const sel = qp.selectedItems[0];
      const rec = sel ? profileByItem.get(sel) : undefined;
      if (rec === 'NEW') finish({ type: 'new' });
      else if (rec) finish({ type: 'pick', profile: rec });
    });
    qp.onDidHide(() => finish({ type: 'cancel' }));
    qp.show();
  });
}

/** 把当前 .develop 地址也写进历史（首次重定向时避免历史为空、方便选回当前 server）。 */
function ensureCurrentInHistory(workspaceRoot: string): void {
  try {
    const cfg = loadDevelop(workspaceRoot);
    addRelocateHistory(workspaceRoot, {
      uri: cfg.uri,
      user: cfg.user,
      pwd: cfg.pwd,
      projectUuid: cfg.projectUuid,
      projectName: '',
      adminTool: cfg.adminTool,
    });
  } catch {
    // .develop 缺失等情况忽略
  }
}

/** 直接重定向：用历史配置改写 .develop + 立即重连刷新。 */
async function applyRedirect(sdk: BapSdk, bapScm: BapScmProviderHandle, profile: RelocateProfile): Promise<void> {
  await sdk.redirect.apply(profile);
  await bapScm.refresh();
  void vscode.window.setStatusBarMessage(`BAP: 已重定向到 ${profile.projectName || profile.uri}`, 3000);
}

/** 新增地址：依次输入 ws / 账号 / 密码 → 连接列出工程 → 选目标工程 → 应用。 */
async function collectAndRedirect(
  sdk: BapSdk,
  bapScm: BapScmProviderHandle,
  log: { debug(msg: string): void; error(msg: string): void },
): Promise<void> {
  const uri = await vscode.window.showInputBox({
    prompt: 'BAP Server ws 地址', placeHolder: 'ws://host:port', ignoreFocusOut: true,
    validateInput: (v) => (v && v.trim() ? undefined : '必填'),
  });
  if (!uri) return;
  const user = await vscode.window.showInputBox({
    prompt: '账号', ignoreFocusOut: true,
    validateInput: (v) => (v && v.trim() ? undefined : '必填'),
  });
  if (!user) return;
  const pwd = await vscode.window.showInputBox({
    prompt: '密码', password: true, ignoreFocusOut: true,
    validateInput: (v) => (v ? undefined : '必填'),
  });
  if (!pwd) return;

  let projects: CJavaProjectDto[];
  try {
    projects = await sdk.redirect.probe(uri.trim(), user.trim(), pwd);
  } catch (e) {
    await resetConnection(sdk);
    const msg = e instanceof Error ? e.message : String(e);
    log.error(`redirect probe 失败: ${msg}`);
    void vscode.window.showErrorMessage(`BAP: 连接失败 - ${msg}`);
    return;
  }
  if (projects.length === 0) {
    await resetConnection(sdk);
    void vscode.window.showInformationMessage('BAP: 该服务器上没有工程');
    return;
  }

  const byItem = new Map<vscode.QuickPickItem, CJavaProjectDto>();
  const items = projects.map((p) => {
    const item: vscode.QuickPickItem = { label: p.name, description: p.uuid, detail: p.uuid };
    byItem.set(item, p);
    return item;
  });
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: '选择要重定向到的目标工程', matchOnDescription: true, matchOnDetail: true,
  });
  if (!picked) {
    await resetConnection(sdk);
    return;
  }
  const dto = byItem.get(picked);
  if (!dto) {
    await resetConnection(sdk);
    return;
  }

  await applyRedirect(sdk, bapScm, {
    uri: uri.trim(), user: user.trim(), pwd,
    projectUuid: dto.uuid, projectName: dto.name,
  });
}

/** 编辑历史：改 ws / 账号 / 密码（保留原工程），应用。 */
async function editAndRedirect(sdk: BapSdk, bapScm: BapScmProviderHandle, profile: RelocateProfile): Promise<void> {
  const uri = await vscode.window.showInputBox({
    prompt: 'ws 地址', value: profile.uri, ignoreFocusOut: true,
    validateInput: (v) => (v && v.trim() ? undefined : '必填'),
  });
  if (!uri) return;
  const user = await vscode.window.showInputBox({
    prompt: '账号', value: profile.user, ignoreFocusOut: true,
    validateInput: (v) => (v && v.trim() ? undefined : '必填'),
  });
  if (!user) return;
  const pwd = await vscode.window.showInputBox({
    prompt: '密码', password: true, value: profile.pwd, ignoreFocusOut: true,
  });
  if (!pwd) return;
  await applyRedirect(sdk, bapScm, { ...profile, uri: uri.trim(), user: user.trim(), pwd });
}

/** 探测/重定向取消或失败后，把当前连接复位（下次 refresh 按现有 .develop 重建）。 */
async function resetConnection(sdk: BapSdk): Promise<void> {
  try {
    await sdk.disconnect();
  } catch {
    // 忽略
  }
}
