// 激活 BAP SCM：创建 SCM provider + 云端原版 provider + 文件角标 + 注册命令。
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { BapSdk, CJavaProjectDto, Change, LvProblem, RelocateProfile } from '@bap/sdk';
import { addRelocateHistory, loadDevelop, loadRelocateHistory, removeRelocateHistory } from '@bap/sdk';
import { isToolCall, execTool, type McpToolCtx } from './mcp/tool-exec';
import { collectAgentProjectInfo, buildAgentFileContent } from './agent/agent-instructions';
import { mergeMcpJson, mergeCodexToml } from './agent/mcp-config';
import { createBapScmProvider, type BapScmProviderHandle } from './scm/bap-scm-provider';
import { registerOriginalProvider } from './scm/original-provider';
import { groupToStatus } from './scm/types';
import { BapFileDecorationProvider, registerFileDecoration } from './scm/file-decoration';
import { registerHistoryContentProvider } from './history/history-provider';
import { openHistoryView } from './history/history-view';

// 单类（云端）编译的诊断集合：把 LvProblem 标到编辑器对应行/区间
const compileDiag = vscode.languages.createDiagnosticCollection('bapCompile');
// 启动调试的独立输出通道（不混进 sdk 日志满的「BAP IDE」）
const debugChannel = vscode.window.createOutputChannel('BAP 调试');
// 单元测试的独立输出通道
const testChannel = vscode.window.createOutputChannel('BAP 单元测试');

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
  // MCP 工具执行上下文（tool 分支经 execTool 非交互直调 SDK/bapScm）
  const mcpCtx: McpToolCtx = { sdk, bapScm, workspaceRoot, log };
  log.debug('registerOriginalProvider...');
  const originalProvider = registerOriginalProvider(sdk);
  const historyContent = registerHistoryContentProvider(sdk);
  const fileDeco = new BapFileDecorationProvider();
  const fileDecoDisposable = registerFileDecoration(fileDeco);
  log.debug('providers 就绪');

  subscriptions.push(
    { dispose: () => bapScm.dispose() },
    originalProvider,
    historyContent,
    fileDecoDisposable,
  );

  // 初始刷新（手动：强制拉云端快照）
  void bapScm.refresh(true)
    .then((changes) => {
      fileDeco.setStatuses(new Map(changes.filter((c) => c.status !== 'NORMAL').map((c) => [c.absolutePath, c.status])));
      log.debug(`初始 refresh 完成，非 NORMAL=${changes.filter((c) => c.status !== 'NORMAL').length}`);
    })
    .catch((e) => log.error(`初始 refresh 失败: ${e instanceof Error ? e.message : String(e)}`));

  const safe = async (name: string, fn: () => Promise<unknown> | unknown): Promise<unknown> => {
    try {
      return await fn();
    } catch (e) {
      log.error(`命令 ${name} 执行失败: ${e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e)}`);
      void vscode.window.showErrorMessage(`BAP 命令 ${name} 失败，详见输出面板「BAP IDE」`);
      return undefined;
    }
  };

  /** 右下角进度框：SCM 每个干活的动作都用它呈现执行进度（与下载工程一致）。 */
  const runWithProgress = async <T = void>(
    title: string,
    message: string,
    fn: (prog: vscode.Progress<{ message?: string; increment?: number }>) => Promise<T>,
  ): Promise<T> =>
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title },
      async (prog) => {
        prog.report({ message });
        return fn(prog);
      },
    );

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
    vscode.commands.registerCommand('bapIde.scm.refresh', async (arg?: unknown) =>
      safe('bapIde.scm.refresh', async () => {
        const t = isToolCall(arg) ? arg : undefined;
        if (t) return execTool(mcpCtx, 'refresh', t);
        log.debug('触发 refresh');
        const changes = await runWithProgress('刷新', '刷新中…', async () => {
          const r = await bapScm.refresh(true);
          fileDeco.setStatuses(new Map(r.filter((c) => c.status !== 'NORMAL').map((c) => [c.absolutePath, c.status])));
          return r;
        });
        const dirty = changes.filter((c) => c.status !== 'NORMAL').length;
        log.debug(`[refresh] 完成，变更=${dirty}`);
        void vscode.window.setStatusBarMessage(`BAP: ${dirty} 个变更`, 3000);
      }),
    ),
    vscode.commands.registerCommand('bapIde.scm.commit', async (arg?: unknown) =>
      safe('bapIde.scm.commit', async () => {
        const t = isToolCall(arg) ? arg : undefined;
        if (t) return execTool(mcpCtx, 'commit', t);
        log.debug('触发 commit');
        const comment = bapScm.sourceControl.inputBox.value || '';
        await runWithProgress('提交', '提交中…', async () => {
          await bapScm.commit(comment);
          bapScm.sourceControl.inputBox.value = '';
        });
        log.debug('[commit] 完成');
        void vscode.window.setStatusBarMessage('BAP: 提交完成', 3000);
      }),
    ),
    vscode.commands.registerCommand('bapIde.scm.publish', async (arg?: unknown) =>
      safe('bapIde.scm.publish', async () => {
        const t = isToolCall(arg) ? arg : undefined;
        if (t) return execTool(mcpCtx, 'publish', t);
        log.debug('触发 publish');
        const msg = await vscode.window.showWarningMessage(
          '确定发布插件（全量）？将把当前工程发布给所有用户。',
          { modal: true },
          '发布',
        );
        if (msg !== '发布') return;
        await runWithProgress('发布插件（全量）', '发布中…', () => sdk.publish.full());
        log.debug('[publish] 完成');
        void vscode.window.setStatusBarMessage('BAP: 已发布插件（全量）', 3000);
      }),
    ),
    vscode.commands.registerCommand('bapIde.scm.openDiff', async (arg?: unknown) =>
      safe('bapIde.scm.openDiff', async () => {
        const change = resolveChange(arg);
        log.debug(`openDiff: change=${change ? `${change.relativePath}|${change.absolutePath}` : '(未找到)'}`);
        if (!change) return;
        await openDiff(change, workspaceRoot, log);
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
        const t = isToolCall(arg) ? arg : undefined;
        if (t) return execTool(mcpCtx, 'commitFile', t);
        const change = resolveChange(arg);
        log.debug(`commitFile: change=${change ? `${change.relativePath}|${change.absolutePath}` : '(未找到)'}`);
        if (!change) return;
        const comment = bapScm.sourceControl.inputBox.value || '';
        await runWithProgress('提交文件', '提交中…', async () => {
          await bapScm.commitFile(change, comment);
          bapScm.sourceControl.inputBox.value = '';
        });
        log.debug(`[commitFile] 完成，${change.relativePath}`);
        void vscode.window.setStatusBarMessage('BAP: 已提交该文件', 3000);
      }),
    ),
    vscode.commands.registerCommand('bapIde.scm.updateFile', async (arg?: unknown) =>
      safe('bapIde.scm.updateFile', async () => {
        const t = isToolCall(arg) ? arg : undefined;
        if (t) return execTool(mcpCtx, 'updateFile', t);
        const change = resolveChange(arg);
        log.debug(`updateFile: change=${change ? `${change.relativePath}|${change.absolutePath}` : '(未找到)'}`);
        if (!change) return;
        await runWithProgress('更新文件', '更新中…', () => bapScm.updateFile(change));
        log.debug(`[updateFile] 完成，${change.relativePath}`);
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
          if (c.absolutePath) await openDiff(c, workspaceRoot, log);
        }
        log.debug(`[openAllChanges] 完成，打开 ${list.length} 个`);
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
        await runWithProgress('更新组', '更新中…', () => bapScm.updateChanges(list));
        log.debug(`[updateGroup] 完成，${group.id} × ${list.length}`);
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
        await runWithProgress('提交组', '提交中…', () => bapScm.commitChanges(list, comment));
        bapScm.sourceControl.inputBox.value = '';
        log.debug(`[commitGroup] 完成，${group.id} × ${list.length}`);
        void vscode.window.setStatusBarMessage('BAP: 已提交该组', 3000);
      }),
    ),
    vscode.commands.registerCommand('bapIde.scm.updateAll', async (arg?: unknown) =>
      safe('bapIde.scm.updateAll', async () => {
        const t = isToolCall(arg) ? arg : undefined;
        if (t) return execTool(mcpCtx, 'updateAll', t);
        log.debug('触发 updateAll');
        const msg = await vscode.window.showWarningMessage(
          '确定更新所有文件到云端最新版？将覆盖本地改动，新增文件会被删除。',
          { modal: true },
          '更新',
        );
        if (msg !== '更新') return;
        await runWithProgress('更新全部文件', '更新中…', () => bapScm.updateAll());
        log.debug('[updateAll] 完成');
        void vscode.window.setStatusBarMessage('BAP: 已更新所有文件', 3000);
      }),
    ),
    vscode.commands.registerCommand('bapIde.scm.redirect', async (arg?: unknown) =>
      safe('bapIde.scm.redirect', async () => {
        const t = isToolCall(arg) ? arg : undefined;
        if (t) return execTool(mcpCtx, 'redirect', t);
        log.debug('触发 redirect');
        await runRedirect(sdk, bapScm, workspaceRoot, log);
        log.debug('[redirect] 完成');
      }),
    ),
    vscode.commands.registerCommand('bapIde.scm.projectHistory', async (arg?: unknown) =>
      safe('bapIde.scm.projectHistory', async () => {
        const t = isToolCall(arg) ? arg : undefined;
        if (t) return execTool(mcpCtx, 'projectHistory', t);
        log.debug('触发 projectHistory');
        await openHistoryView('project', sdk, context, undefined, (m) => log.debug(m));
        log.debug('[projectHistory] 完成');
      }),
    ),
    vscode.commands.registerCommand('bapIde.scm.fileHistory', async (arg?: unknown) =>
      safe('bapIde.scm.fileHistory', async () => {
        const t = isToolCall(arg) ? arg : undefined;
        if (t) return execTool(mcpCtx, 'fileHistory', t);
        const change = resolveChange(arg);
        log.debug(`fileHistory: change=${change ? `${change.relativePath}|${change.absolutePath}` : '(未找到)'}`);
        if (!change) return;
        const remoteKey = change.isResource ? change.relativePath : (change.fullClass ?? change.relativePath);
        await openHistoryView('file', sdk, context, remoteKey, (m) => log.debug(m));
        log.debug('[fileHistory] 完成');
      }),
    ),
    vscode.commands.registerCommand('bapIde.scm.updateLibs', async (arg?: unknown) =>
      safe('bapIde.scm.updateLibs', async () => {
        const t = isToolCall(arg) ? arg : undefined;
        if (t) return execTool(mcpCtx, 'updateLibs', t);
        log.debug('触发 updateLibs');
        const msg = await vscode.window.showWarningMessage(
          '确定更新依赖？将按云端 md5 更新本地 lib，并删除云端已不存在的本地 lib 包。',
          { modal: true },
          '更新',
        );
        if (msg !== '更新') return;
        let lastIncr = 0;
        const r = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: '更新依赖', cancellable: true },
          async (prog) => {
            const res = await sdk.syncLibs(
              (p) => {
                const inc = Math.max(0, Math.round((p.current / p.total) * 100) - lastIncr);
                lastIncr += inc;
                prog.report({ message: p.message, increment: inc });
              },
              (m) => log.debug(`[updateLibs] ${m}`),
            );
            return res;
          },
        );
        log.debug(`[updateLibs] 完成，更新=${r.updated} 删除=${r.deleted}`);
        void vscode.window.setStatusBarMessage(`BAP: 已更新依赖（${r.updated} 更新，${r.deleted} 删除）`, 5000);
      }),
    ),
    vscode.commands.registerCommand('bapIde.scm.compileProject', async (arg?: unknown) =>
      safe('bapIde.scm.compileProject', async () => {
        const t = isToolCall(arg) ? arg : undefined;
        if (t) return execTool(mcpCtx, 'compileProject', t);
        log.debug('触发 compileProject');
        const msg = await vscode.window.showWarningMessage(
          '确定编译项目（本地）？将用 JDK javac 编译当前工程 src/** 到 bin/（不连服务器）。',
          { modal: true },
          '编译',
        );
        if (msg !== '编译') return;
        const r = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: '编译项目（本地）' },
          async (prog) => {
            prog.report({ message: '编译中…' });
            return sdk.compile.project();
          },
        );
        if (r.success) {
          log.debug(`[compileProject] 完成，源码=${r.sourceFiles} 资源=${r.resourceFiles}`);
          void vscode.window.setStatusBarMessage(`BAP: 编译完成（${r.sourceFiles} 个源文件）`, 5000);
        } else {
          log.error(`compileProject 失败: ${r.errorCode}\n${r.compilerOutput}`);
          void vscode.window.showErrorMessage(`编译失败（${r.errorCode}）: ${r.compilerOutput || '未知原因'}`);
        }
      }),
    ),
    vscode.commands.registerCommand('bapIde.scm.compileFile', async (arg?: unknown) =>
      safe('bapIde.scm.compileFile', async () => {
        const t = isToolCall(arg) ? arg : undefined;
        if (t) return execTool(mcpCtx, 'compileFile', t);
        // SCM 文件项右键传 resource state；编辑器右键菜单传选中的 Uri。统一解析到文件绝对路径。
        const change = resolveChange(arg);
        const absPath = change?.absolutePath ?? extractFsPath(arg);
        log.debug(`compileFile: absPath=${absPath ?? '(未找到)'}`);
        if (!absPath) return;
        if (!absPath.toLowerCase().endsWith('.java')) {
          void vscode.window.showInformationMessage('BAP: 请选择 Java 源文件进行编译');
          return;
        }
        const fullClass = change?.fullClass ?? deriveFullClass(absPath, workspaceRoot);
        if (!fullClass) {
          void vscode.window.showInformationMessage('BAP: 无法解析类名，请在工作区 src/ 下的 .java 文件上操作');
          return;
        }
        const content = fs.readFileSync(absPath, 'utf8');
        const problems = await runWithProgress('编译单类', '编译中…', () => sdk.compile.singleCode(fullClass, content, false));
        const diags = problems.map((p) =>
          new vscode.Diagnostic(
            problemRange(content, p.line, p.startPosition, p.endPosition),
            p.message ?? '',
            p.isError ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
          ),
        );
        compileDiag.set(vscode.Uri.file(absPath), diags);
        const errors = problems.filter((p) => p.isError).length;
        const warns = problems.filter((p) => p.isWarn).length;
        log.debug(`[compileFile] 完成，error=${errors} warn=${warns}`);
        void vscode.window.setStatusBarMessage(
          errors || warns ? `BAP: 编译 ${errors} 错误 / ${warns} 警告` : 'BAP: 编译通过',
          5000,
        );
        // 打开该文件并聚焦（让诊断波浪线可见）
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(absPath), { preview: true });
      }),
    ),
    vscode.commands.registerCommand('bapIde.scm.debugClass', async (arg?: unknown) =>
      safe('bapIde.scm.debugClass', async () => {
        const t = isToolCall(arg) ? arg : undefined;
        if (t) return execTool(mcpCtx, 'debugClass', t);
        const change = resolveChange(arg);
        const absPath = change?.absolutePath ?? extractFsPath(arg);
        log.debug(`debugClass: absPath=${absPath ?? '(未找到)'}`);
        if (!absPath || !absPath.toLowerCase().endsWith('.java')) {
          void vscode.window.showInformationMessage('BAP: 请选择 Java 源文件进行调试');
          return;
        }
        const fullClass = change?.fullClass ?? deriveFullClass(absPath, workspaceRoot);
        if (!fullClass) {
          void vscode.window.showInformationMessage('BAP: 无法解析类名');
          return;
        }
        const code = fs.readFileSync(absPath, 'utf8');
        debugChannel.show(true);
        debugChannel.appendLine(`[debug] 运行 ${fullClass}（云端）…`);
        const r = await runWithProgress('调试（云端运行）', '运行中…', () =>
          sdk.debug.start(fullClass, code, (line) => debugChannel.appendLine(line)),
        );
        debugChannel.appendLine('--------------------');
        debugChannel.appendLine(`调试ID (DebugKey): ${r.debugKey}`);
        debugChannel.appendLine(`是否异常 (IsException): ${r.isError}`);
        debugChannel.appendLine(`返回对象 (Result Object): ${previewResult(r.result)}`);
        debugChannel.appendLine(`返回文本 (Result Text): ${r.resultText}`);
        void vscode.window.setStatusBarMessage(
          r.isError ? 'BAP: 调试运行异常' : 'BAP: 调试完成',
          5000,
        );
      }),
    ),
    vscode.commands.registerCommand('bapIde.scm.testProject', async (arg?: unknown) =>
      safe('bapIde.scm.testProject', async () => {
        const t = isToolCall(arg) ? arg : undefined;
        if (t) return execTool(mcpCtx, 'testProject', t);
        const change = resolveChange(arg);
        const absPath = change?.absolutePath ?? extractFsPath(arg);
        let selectClass: string | undefined;
        if (absPath && absPath.toLowerCase().endsWith('.java')) {
          selectClass = change?.fullClass ?? deriveFullClass(absPath, workspaceRoot) ?? undefined;
        }
        log.debug(`testProject: selectClass=${selectClass ?? '(全部)'}`);
        testChannel.show(true);
        testChannel.appendLine(`[test] 开始编译 + 运行单元测试（${selectClass ?? '全部'}）…`);
        const r = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: '单元测试' },
          async (prog) => {
            prog.report({ message: '编译中…' });
            const res = await sdk.test.project({ selectClass, onOutput: (line) => testChannel.appendLine(line) });
            return res;
          },
        );
        testChannel.appendLine('--------------------');
        testChannel.appendLine(`Total: ${r.total} | Passed: ${r.passed} | Failed: ${r.failed} | Skipped: ${r.skipped} | Exit code: ${r.exitCode}`);
        log.debug(`[testProject] 完成，pass=${r.passed} fail=${r.failed} skip=${r.skipped}`);
        void vscode.window.setStatusBarMessage(
          r.failed ? `BAP: 单元测试 ${r.failed} 失败 / ${r.passed} 通过` : `BAP: 单元测试通过（${r.passed}）`,
          5000,
        );
      }),
    ),
  );

  // 独立能力命令：查看项目列表 / 取云端当前文件（主要作为 MCP 工具，命令面板亦可调）
  subscriptions.push(
    vscode.commands.registerCommand('bapIde.listProjects', async (arg?: unknown) =>
      safe('bapIde.listProjects', async () => {
        const t = isToolCall(arg) ? arg : undefined;
        const list = (await execTool(mcpCtx, 'listProjects', t ?? { __tool: true })) as CJavaProjectDto[];
        if (t) return list;
        void vscode.window.setStatusBarMessage(`BAP: 当前环境 ${list.length} 个工程`, 5000);
      }),
    ),
    vscode.commands.registerCommand('bapIde.fetchCurrent', async (arg?: unknown) =>
      safe('bapIde.fetchCurrent', async () => {
        const t = isToolCall(arg) ? arg : undefined;
        if (!t) {
          void vscode.window.showInformationMessage('BAP: fetchCurrent 需提供 fullClass 或 path');
          return;
        }
        return execTool(mcpCtx, 'fetchCurrent', t);
      }),
    ),
    vscode.commands.registerCommand('bapIde.resetAgentInstructions', async () =>
      safe('bapIde.resetAgentInstructions', async () => {
        const msg = await vscode.window.showWarningMessage(
          `重建 ${workspaceRoot}/CLAUDE.md、AGENTS.md，并为 Claude Code（.mcp.json）与 Codex（.codex/config.toml）写入 MCP 配置？`,
          { modal: true },
          '重建',
        );
        if (msg !== '重建') return;
        // 1) Agent 指令文件
        const info = collectAgentProjectInfo(workspaceRoot);
        const content = buildAgentFileContent(info);
        fs.writeFileSync(path.join(workspaceRoot, 'CLAUDE.md'), content);
        fs.writeFileSync(path.join(workspaceRoot, 'AGENTS.md'), content);
        // 2) Claude Code MCP 配置（工程级 .mcp.json）
        const mcpServerPath = path.join(context.extensionPath, 'dist', 'mcp-server.js');
        const mcpJsonFile = path.join(workspaceRoot, '.mcp.json');
        const mcpJson = mergeMcpJson(fs.existsSync(mcpJsonFile) ? fs.readFileSync(mcpJsonFile, 'utf8') : undefined, mcpServerPath);
        fs.writeFileSync(mcpJsonFile, mcpJson);
        // 3) Codex MCP 配置（工程级 .codex/config.toml）
        const codexDir = path.join(workspaceRoot, '.codex');
        const codexFile = path.join(codexDir, 'config.toml');
        const codexToml = mergeCodexToml(fs.existsSync(codexFile) ? fs.readFileSync(codexFile, 'utf8') : undefined, mcpServerPath);
        fs.mkdirSync(codexDir, { recursive: true });
        fs.writeFileSync(codexFile, codexToml);
        log.debug('[resetAgentInstructions] 已写入 CLAUDE.md / AGENTS.md / .mcp.json / .codex/config.toml');
        void vscode.window.setStatusBarMessage('BAP: 已重建 Agent 指令与 MCP 配置（重启 Claude Code / 重载 Codex 生效）', 8000);
      }),
    ),
  );

  return subscriptions;
}

/** 计算诊断在编辑器中的 range：行/列基于源码绝对偏移换算。 */
function problemRange(code: string, line?: number, start?: number, end?: number): vscode.Range {
  const row = Math.max(0, (line ?? 1) - 1);
  const lines = code.split(/\r?\n/);
  let lineStart = 0;
  for (let i = 0; i < row && i < lines.length; i++) lineStart += lines[i].length + 1;
  const chStart = start !== undefined ? Math.max(0, start - lineStart) : 0;
  const chEnd = end !== undefined ? Math.max(chStart, end - lineStart) : (lines[row]?.length ?? chStart);
  const pos = (ch: number): vscode.Position => new vscode.Position(row, ch);
  return new vscode.Range(pos(Math.min(chStart, chEnd)), pos(Math.max(chStart, chEnd)));
}

/** 从命令参数里提取文件绝对路径（兼容 Uri / {fsPath} / {resourceUri:{fsPath}} / {absolutePath}）。 */
function extractFsPath(arg: unknown): string | undefined {
  if (!arg || typeof arg !== 'object') return undefined;
  const a = arg as { fsPath?: unknown; resourceUri?: { fsPath?: unknown }; absolutePath?: unknown };
  if (typeof a.fsPath === 'string') return a.fsPath;
  if (a.resourceUri && typeof (a.resourceUri as { fsPath?: unknown }).fsPath === 'string') {
    return (a.resourceUri as { fsPath: string }).fsPath;
  }
  if (typeof a.absolutePath === 'string') return a.absolutePath;
  return undefined;
}

/** 把服务端返回值预览成字符串（Object → JSON；null/undefined 原样；超长截断）。 */
function previewResult(x: unknown): string {
  const s = x === undefined || x === null ? String(x) : typeof x === 'string' ? x : JSON.stringify(x);
  return s.length > 2000 ? `${s.slice(0, 2000)}…` : (s ?? '');
}

/** 从文件绝对路径推导 fullClass（src/<folder>/<pkg>/<Class>.java → 剥 src/ 与 folder → 包.类）。 */
function deriveFullClass(absPath: string, workspaceRoot: string): string | undefined {
  let rel = absPath.startsWith(workspaceRoot)
    ? absPath.slice(workspaceRoot.length).replace(/^[/\\]+/, '')
    : absPath.replace(/^[/\\]+/, '');
  rel = rel.split(path.sep).join('/');
  if (rel.startsWith('src/')) rel = rel.slice(4);
  const parts = rel.split('/').filter((p) => p && p !== '.');
  if (!parts.length) return undefined;
  // 第一段是 src 一级子目录（folder，如 core/res），不是包路径，剥掉
  const pkgParts = parts.length > 1 ? parts.slice(1) : parts;
  const segments = pkgParts.map((p) => p.replace(/\.java$/i, '')).filter(Boolean);
  return segments.length ? segments.join('.') : undefined;
}

/** 打开 diff：左侧 = bap-original（云端原版），右侧 = 本地文件。 */
async function openDiff(
  change: Change,
  workspaceRoot: string,
  log: { debug(msg: string): void } = { debug: () => {} },
): Promise<void> {
  log.debug(`[openDiff] 打开 ${change.relativePath}`);
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
