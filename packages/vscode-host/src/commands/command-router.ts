// 多工程命令路由：所有 bapIde.* 命令只注册一次，按调用参数解析目标后端工程。
// - 工具调用（__tool）：非交互，解析到单一工程后交给 execTool；
// - SCM/编辑器菜单：按 resource/group/sourceControl/projectId 显式定位；
// - 无资源命令：多工程时弹多选，串行执行并汇总结果。
// 写操作统一走 ctx.runWrite（.develop 身份校验 + 同工程串行）。
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { Change, CJavaProjectDto, RelocateProfile } from '@bap/sdk';
import type { BridgeLaunchConfig } from '@bap/rpc';
import {
  addRelocateHistory,
  loadDevelop,
  loadRelocateHistory,
  removeRelocateHistory,
} from '@bap/sdk';
import type { BackendProjectRegistry, ProjectRequest } from '../projects/project-registry';
import type { BackendProjectContext } from '../projects/project-context';
import { ProjectResolutionError, isProjectResolutionError } from '../projects/project-errors';
import { readProjectIdentity } from '../projects/project-identity';
import { deriveFullClass } from '../projects/project-paths';
import { isToolCall, execTool, wrapProjectResult, type McpToolCtx, type ToolArg } from '../mcp/tool-exec';
import { isProjectScopedTool } from '../mcp/tools';
import { collectAgentProjectInfo, buildAgentFileContent, type AgentGenerationContext } from '../agent/agent-instructions';
import { mergeMarkedSection } from '../agent/markdown-merge';
import { mergeMcpJson, mergeCodexToml } from '../agent/mcp-config';
import { groupToStatus, bapOriginalUriSpec } from '../scm/types';
import { openHistoryView } from '../history/history-view';
import { discoverBackendProjectDescriptors } from '../backend-projects-vscode';
import { findVfWorkspaceRoot } from '../backend-projects';
import { buildWorkspaceInfo } from '../projects/workspace-info';
import { probeServerProjects } from '../projects/server-probe';

export interface ProjectCommandOptions {
  context: vscode.ExtensionContext;
  registry: BackendProjectRegistry;
  log: { debug(msg: string): void; error(msg: string): void };
  /** MCP 配置里 mcp-server.js 的路径（resetAgentInstructions 用）。 */
  mcpServerPath: string;
  /** Java 桥 launch（bootstrap listProjects 直连服务器用）。 */
  launch: BridgeLaunchConfig;
}

interface BatchOk<T> {
  context: BackendProjectContext;
  ok: true;
  value: T;
}
interface BatchFail {
  context: BackendProjectContext;
  ok: false;
  error: string;
}
type BatchOutcome<T> = BatchOk<T> | BatchFail;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 从命令参数提取 URI（兼容 vscode.Uri / ResourceState / Change / {fsPath}）。 */
function uriFromArg(arg: unknown): vscode.Uri | undefined {
  if (!arg || typeof arg !== 'object') return undefined;
  const a = arg as {
    scheme?: unknown;
    fsPath?: unknown;
    resourceUri?: { fsPath?: unknown };
    absolutePath?: unknown;
  };
  if (typeof a.scheme === 'string' && typeof a.fsPath === 'string') return arg as vscode.Uri;
  if (a.resourceUri && typeof a.resourceUri.fsPath === 'string') return a.resourceUri as vscode.Uri;
  if (typeof a.fsPath === 'string' && a.fsPath) return vscode.Uri.file(a.fsPath);
  if (typeof a.absolutePath === 'string' && a.absolutePath) return vscode.Uri.file(a.absolutePath);
  return undefined;
}

/** 命令参数 → 工程定位请求。 */
function requestFromArg(arg: unknown): ProjectRequest {
  if (!arg || typeof arg !== 'object') return {};
  const a = arg as Record<string, unknown>;
  if (typeof a.projectId === 'string' && a.projectId) return { projectId: a.projectId };
  const uri = uriFromArg(arg);
  if (uri) return { resourceUri: uri };
  // 已构造好的 ProjectRequest 形状（内部调用：{ resourceGroup } / { sourceControl }）。
  if (a.resourceGroup && typeof a.resourceGroup === 'object') {
    return { resourceGroup: a.resourceGroup as vscode.SourceControlResourceGroup };
  }
  if (a.sourceControl && typeof a.sourceControl === 'object') {
    return { sourceControl: a.sourceControl as vscode.SourceControl };
  }
  if (Array.isArray(a.resourceStates)) return { resourceGroup: arg as vscode.SourceControlResourceGroup };
  if (typeof a.createResourceGroup === 'function' && a.rootUri) return { sourceControl: arg as vscode.SourceControl };
  return {};
}

/** 从参数里找绝对路径（SCM change / resource state / Uri）。 */
function fsPathFromArg(arg: unknown): string | undefined {
  return uriFromArg(arg)?.fsPath;
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

/** 把服务端返回值预览成字符串（Object → JSON；null/undefined 原样；超长截断）。 */
function previewResult(x: unknown): string {
  const s = x === undefined || x === null ? String(x) : typeof x === 'string' ? x : JSON.stringify(x);
  return s.length > 2000 ? `${s.slice(0, 2000)}…` : (s ?? '');
}

/**
 * 注册全部 SCM / 工程命令。返回的 Disposable 由激活器统一释放。
 * 命令在「0 个后端工程」时也可调用：解析阶段会给出 NO_PROJECTS 提示而不崩溃（P1-1）。
 */
export function registerProjectCommands(opts: ProjectCommandOptions): vscode.Disposable[] {
  const { context, registry, log } = opts;
  const compileDiag = vscode.languages.createDiagnosticCollection('bapCompile');
  const debugChannel = vscode.window.createOutputChannel('BAP 调试');
  const testChannel = vscode.window.createOutputChannel('BAP 单元测试');
  const subscriptions: vscode.Disposable[] = [
    compileDiag,
    debugChannel,
    testChannel,
  ];

  /** 本工程专用的工具执行上下文（写/独占操作走工程上下文队列）。 */
  function toolCtx(ctx: BackendProjectContext): McpToolCtx {
    return {
      sdk: ctx.ensureSdk(),
      bapScm: ctx.ensureScm(),
      workspaceRoot: ctx.root,
      log,
      projectId: ctx.projectId,
      displayName: ctx.displayName,
      runWrite: (fn) => ctx.runWrite(fn),
      runExclusive: (fn) => ctx.runExclusive(fn),
      afterRedirect: () => {
        ctx.adoptIdentity(readProjectIdentity(ctx.root));
        registry.recomputeDuplicates();
      },
    };
  }

  /** 工具调用的 project 参数：只接受字符串；其它类型直接判为非法。 */
  function projectRefFromArg(arg: unknown): string | undefined {
    if (!arg || typeof arg !== 'object') return undefined;
    const value = (arg as Record<string, unknown>).project;
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') {
      throw new ProjectResolutionError(
        'project 参数必须是字符串（projectId / projectUuid / 工程名）；可用 workspaceInfo 查询候选',
        'INVALID_PROJECT',
      );
    }
    return value;
  }

  /**
   * 工具调用：非交互解析到单一工程。
   * 指定 project 时按 projectId → projectUuid → 工程名解析；未指定时**不做**活动编辑器/
   * 上次使用回退：0 个工程 NO_PROJECTS、1 个直接用、多个 AMBIGUOUS。
   */
  async function resolveForTool(projectRef?: string): Promise<BackendProjectContext> {
    const res = await registry.resolve(projectRef !== undefined ? { projectRef } : {}, {
      interactive: false,
      suggestProjectParam: true,
      allowActiveEditor: false,
      allowLastUsed: false,
      purpose: '选择后端工程',
    });
    registry.markUsed(res.context.projectId);
    return res.context;
  }

  /** 命令包装：工具调用失败要抛给 MCP（真实错误）；UI 路径转成用户可读提示。 */
  function command(
    id: string,
    handler: (arg: unknown) => Promise<unknown>,
  ): vscode.Disposable {
    return vscode.commands.registerCommand(id, async (arg?: unknown) => {
      try {
        return await handler(arg);
      } catch (e) {
        if (isToolCall(arg)) throw e;
        const msg = errorMessage(e);
        if (isProjectResolutionError(e)) {
          if (e.code === 'CANCELLED') return undefined;
          log.debug(`命令 ${id} 未解析到工程: ${msg}`);
          void vscode.window.showWarningMessage(`BAP: ${msg}`);
          return undefined;
        }
        log.error(`命令 ${id} 执行失败: ${e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : msg}`);
        void vscode.window.showErrorMessage(`BAP 命令 ${id} 失败：${msg}`);
        return undefined;
      }
    });
  }

  /** 工具命令：{__tool} 走 execTool，否则走 UI 实现。 */
  function toolCommand(
    toolName: string,
    ui: (arg: unknown) => Promise<unknown>,
  ): (arg: unknown) => Promise<unknown> {
    return async (arg) => {
      if (!isToolCall(arg)) return ui(arg);
      const projectRef = projectRefFromArg(arg);
      // project 是路由参数，不进入 execTool 的业务参数。
      const rest: Record<string, unknown> = { ...(arg as Record<string, unknown>) };
      delete rest.project;
      const ctx = await resolveForTool(projectRef);
      const mcpCtx = toolCtx(ctx);
      const result = await execTool(mcpCtx, toolName, { __tool: true, ...rest } as ToolArg);
      // 工作区级工具（workspaceInfo/listProjects/downloadProject）保持原结果；工程级工具统一包 envelope。
      return isProjectScopedTool(toolName) ? wrapProjectResult(mcpCtx, result) : result;
    };
  }

  /** 顺序执行多个工程；单个失败不阻断后续，返回逐工程结果。 */
  async function runMany<T>(
    title: string,
    runs: readonly { context: BackendProjectContext }[],
    fn: (
      ctx: BackendProjectContext,
      prog: vscode.Progress<{ message?: string; increment?: number }>,
    ) => Promise<T>,
  ): Promise<BatchOutcome<T>[]> {
    const contexts = runs.map((r) => r.context);
    const results: BatchOutcome<T>[] = [];
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: contexts.length > 1 ? `${title}（${contexts.length} 个工程）` : title,
      },
      async (prog) => {
        for (let i = 0; i < contexts.length; i++) {
          const ctx = contexts[i];
          prog.report({
            message: contexts.length > 1 ? `${ctx.displayName}（${i + 1}/${contexts.length}）…` : `${title}…`,
          });
          try {
            const value = await fn(ctx, prog);
            results.push({ context: ctx, ok: true, value });
          } catch (e) {
            const msg = errorMessage(e);
            log.error(`[${ctx.displayName}] ${title} 失败: ${msg}`);
            results.push({ context: ctx, ok: false, error: msg });
          }
        }
      },
    );
    return results;
  }

  /** 汇总批量结果：有失败逐个列出；成功给状态栏提示。 */
  function finish(title: string, results: readonly BatchOutcome<unknown>[], successText?: string): void {
    const failed = results.filter((r): r is BatchFail => !r.ok);
    if (failed.length) {
      const okCount = results.length - failed.length;
      const detail = failed.map((f) => `${f.context.displayName}: ${f.error}`).join('\n');
      void vscode.window.showErrorMessage(
        `BAP: ${title}完成 ${okCount}/${results.length} 个工程；失败：\n${detail}`,
        { modal: false },
      );
      return;
    }
    void vscode.window.setStatusBarMessage(
      `BAP: ${successText ?? `${title}完成（${results.length} 个工程）`}`,
      4000,
    );
  }

  /** 无资源命令的工程选择（多工程多选；写操作默认只勾上次使用/当前文件所在工程）。 */
  async function resolveManyForUi(
    arg: unknown,
    purpose: string,
    forWrite: boolean,
  ): Promise<BackendProjectContext[]> {
    const res = await registry.resolveMany(requestFromArg(arg), {
      interactive: true,
      batch: true,
      forWrite,
      purpose,
    });
    return res.map((r) => r.context);
  }

  /** 单个工程（资源相关命令）。 */
  async function resolveOneForUi(arg: unknown, purpose: string, forWrite = false): Promise<BackendProjectContext> {
    return (await registry.resolve(requestFromArg(arg), { interactive: true, forWrite, purpose })).context;
  }

  /** 从参数解析对应工程的变更项。 */
  function findChange(ctx: BackendProjectContext, arg: unknown): Change | undefined {
    const fsPath = fsPathFromArg(arg);
    if (!fsPath) return undefined;
    return ctx.ensureScm().getChangeByPath(fsPath);
  }

  async function resolveChangeArg(
    arg: unknown,
    purpose: string,
    forWrite = false,
  ): Promise<{ ctx: BackendProjectContext; change: Change }> {
    const ctx = await resolveOneForUi(arg, purpose, forWrite);
    const change = findChange(ctx, arg);
    if (!change) throw new Error('未找到对应的变更，请从 BAP 源代码管理视图或文件上操作');
    return { ctx, change };
  }

  /** 打开 diff：左 = 云端原版（bap-original，带工程 pid），右 = 本地。 */
  async function openDiff(ctx: BackendProjectContext, change: Change): Promise<void> {
    const left = vscode.Uri.parse(
      bapOriginalUriSpec(ctx.root, change.relativePath, change.folder, change.isResource, ctx.projectId),
    );
    const right = vscode.Uri.file(change.absolutePath);
    const title = change.isResource
      ? `${change.relativePath} (BAP)`
      : `${change.fullClass ?? change.relativePath} (BAP)`;
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
  }

  // ---- 命令注册 ----

  subscriptions.push(
    command(
      'bapIde.scm.refresh',
      toolCommand('refresh', async (arg) => {
        const contexts = await resolveManyForUi(arg, '刷新', false);
        const results = await runMany('刷新', contexts.map((context) => ({ context })), async (ctx) => {
          const changes = await ctx.ensureScm().refresh(true);
          return changes.filter((c) => c.status !== 'NORMAL').length;
        });
        const total = results.reduce((n, r) => n + (r.ok ? r.value : 0), 0);
        finish('刷新', results, `${results.length} 个工程刷新完成，共 ${total} 个变更`);
      }),
    ),

    command(
      'bapIde.scm.commit',
      toolCommand('commit', async (arg) => {
        const contexts = await resolveManyForUi(arg, '提交', true);
        const results = await runMany('提交', contexts.map((context) => ({ context })), async (ctx) => {
          const scm = ctx.ensureScm();
          if (scm.getChanges().length === 0) return 0;
          const comment = scm.sourceControl.inputBox.value || '';
          await ctx.runWrite(() => scm.commit(comment));
          scm.sourceControl.inputBox.value = '';
          return 1;
        });
        finish('提交', results, `已提交（${results.reduce((n, r) => n + (r.ok ? r.value : 0), 0)} 个工程）`);
      }),
    ),

    command(
      'bapIde.scm.publish',
      toolCommand('publish', async (arg) => {
        const contexts = await resolveManyForUi(arg, '发布', true);
        const names = contexts.map((c) => `「${c.displayName}」`).join('、');
        const msg = await vscode.window.showWarningMessage(
          `确定发布插件（全量）？将把 ${names} 发布给所有用户。`,
          { modal: true },
          '发布',
        );
        if (msg !== '发布') return;
        const results = await runMany('发布插件（全量）', contexts.map((context) => ({ context })), (ctx) =>
          ctx.runWrite(() => ctx.ensureSdk().publish.full()),
        );
        finish('发布插件（全量）', results);
      }),
    ),

    command('bapIde.scm.openDiff', async (arg) => {
      const ctx = await resolveOneForUi(arg, '打开 Diff');
      const change = findChange(ctx, arg);
      if (!change) return;
      log.debug(`openDiff[${ctx.displayName}]: ${change.relativePath}`);
      await openDiff(ctx, change);
    }),

    command('bapIde.scm.openFile', async (arg) => {
      const ctx = await resolveOneForUi(arg, '打开文件');
      const change = findChange(ctx, arg);
      if (!change) return;
      if (change.status === 'DELETED_LOCALLY') {
        void vscode.window.showInformationMessage(`BAP: 文件已删除，无法打开：${change.relativePath}`);
        return;
      }
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(change.absolutePath));
    }),

    command(
      'bapIde.scm.commitFile',
      toolCommand('commitFile', async (arg) => {
        const { ctx, change } = await resolveChangeArg(arg, '提交文件', true);
        const scm = ctx.ensureScm();
        const comment = scm.sourceControl.inputBox.value || '';
        await ctx.runWrite(() => scm.commitFile(change, comment));
        scm.sourceControl.inputBox.value = '';
        log.debug(`[commitFile][${ctx.displayName}] 完成，${change.relativePath}`);
        void vscode.window.setStatusBarMessage('BAP: 已提交该文件', 3000);
      }),
    ),

    command(
      'bapIde.scm.updateFile',
      toolCommand('updateFile', async (arg) => {
        const { ctx, change } = await resolveChangeArg(arg, '更新文件', true);
        await ctx.runWrite(() => ctx.ensureScm().updateFile(change));
        log.debug(`[updateFile][${ctx.displayName}] 完成，${change.relativePath}`);
        void vscode.window.setStatusBarMessage('BAP: 已从云端更新该文件', 3000);
      }),
    ),

    command('bapIde.scm.openAllChanges', async (arg) => {
      const ctx = await resolveOneForUi(arg, '打开全部更改');
      const list = ctx.ensureScm().getChanges();
      log.debug(`openAllChanges[${ctx.displayName}]: ${list.length} 个`);
      if (list.length === 0) {
        void vscode.window.showInformationMessage('BAP: 没有更改');
        return;
      }
      for (const c of list) await openDiff(ctx, c);
    }),

    command('bapIde.scm.updateGroup', async (arg) => {
      const group = arg as vscode.SourceControlResourceGroup | undefined;
      if (!group?.id) {
        void vscode.window.showWarningMessage('BAP: 请在资源组上点击此操作');
        return;
      }
      const status = groupToStatus(group.id);
      if (!status) return;
      const ctx = await resolveOneForUi({ resourceGroup: group }, '更新组', true);
      const scm = ctx.ensureScm();
      const list = scm.getChanges().filter((c) => c.status === status);
      log.debug(`updateGroup[${ctx.displayName}][${group.id}]: ${list.length} 个`);
      if (list.length === 0) {
        void vscode.window.showInformationMessage('BAP: 该组没有更改');
        return;
      }
      const msg = await vscode.window.showWarningMessage(
        `确定更新「${ctx.displayName}」的「${group.label}」组这 ${list.length} 个文件到云端最新版？将覆盖本地改动，新增文件会被删除。`,
        { modal: true },
        '更新',
      );
      if (msg !== '更新') return;
      await ctx.runWrite(() => scm.updateChanges(list));
      void vscode.window.setStatusBarMessage('BAP: 已更新该组', 3000);
    }),

    command('bapIde.scm.commitGroup', async (arg) => {
      const group = arg as vscode.SourceControlResourceGroup | undefined;
      if (!group?.id) {
        void vscode.window.showWarningMessage('BAP: 请在资源组上点击此操作');
        return;
      }
      const status = groupToStatus(group.id);
      if (!status) return;
      const ctx = await resolveOneForUi({ resourceGroup: group }, '提交组', true);
      const scm = ctx.ensureScm();
      const list = scm.getChanges().filter((c) => c.status === status);
      log.debug(`commitGroup[${ctx.displayName}][${group.id}]: ${list.length} 个`);
      if (list.length === 0) {
        void vscode.window.showInformationMessage('BAP: 该组没有可提交的更改');
        return;
      }
      const comment = scm.sourceControl.inputBox.value || '';
      await ctx.runWrite(() => scm.commitChanges(list, comment));
      scm.sourceControl.inputBox.value = '';
      void vscode.window.setStatusBarMessage('BAP: 已提交该组', 3000);
    }),

    command(
      'bapIde.scm.updateAll',
      toolCommand('updateAll', async (arg) => {
        const contexts = await resolveManyForUi(arg, '更新全部文件', true);
        const names = contexts.map((c) => `「${c.displayName}」`).join('、');
        const msg = await vscode.window.showWarningMessage(
          `确定更新 ${names} 的所有文件到云端最新版？将覆盖本地改动，新增文件会被删除。`,
          { modal: true },
          '更新',
        );
        if (msg !== '更新') return;
        const results = await runMany('更新全部文件', contexts.map((context) => ({ context })), (ctx) =>
          ctx.runWrite(() => ctx.ensureScm().updateAll()),
        );
        finish('更新全部文件', results);
      }),
    ),

    command(
      'bapIde.scm.redirect',
      toolCommand('redirect', async (arg) => {
        // 重定向会改写 .develop 身份：只允许单个工程，避免把多个工程指向同一云端工程。
        const ctx = await resolveOneForUi(arg, '选择要重定向的工程', true);
        log.debug(`触发 redirect [${ctx.displayName}]`);
        await runRedirect(ctx);
      }),
    ),

    command(
      'bapIde.scm.projectHistory',
      toolCommand('projectHistory', async (arg) => {
        const contexts = await resolveManyForUi(arg, '项目历史', false);
        for (const ctx of contexts) {
          await openHistoryView('project', ctx.ensureSdk(), context, undefined, (m) => log.debug(m), {
            projectId: ctx.projectId,
            displayName: ctx.displayName,
          });
        }
      }),
    ),

    command(
      'bapIde.scm.fileHistory',
      toolCommand('fileHistory', async (arg) => {
        const { ctx, change } = await resolveChangeArg(arg, '文件历史');
        const remoteKey = change.isResource ? change.relativePath : (change.fullClass ?? change.relativePath);
        await openHistoryView('file', ctx.ensureSdk(), context, remoteKey, (m) => log.debug(m), {
          projectId: ctx.projectId,
          displayName: ctx.displayName,
        });
      }),
    ),

    command(
      'bapIde.scm.updateLibs',
      toolCommand('updateLibs', async (arg) => {
        const contexts = await resolveManyForUi(arg, '更新依赖', true);
        const names = contexts.map((c) => `「${c.displayName}」`).join('、');
        const msg = await vscode.window.showWarningMessage(
          `确定更新 ${names} 的依赖？将按云端 md5 更新本地 lib，并删除云端已不存在的本地 lib 包。`,
          { modal: true },
          '更新',
        );
        if (msg !== '更新') return;
        const results = await runMany('更新依赖', contexts.map((context) => ({ context })), (ctx, prog) => {
          let last = 0;
          return ctx.runWrite(() =>
            ctx.ensureSdk().syncLibs(
              (p) => {
                const inc = Math.max(0, Math.round((p.current / Math.max(1, p.total)) * 100) - last);
                last += inc;
                prog.report({ message: `${ctx.displayName}: ${p.message}`, increment: inc });
              },
              (m) => log.debug(`[updateLibs][${ctx.displayName}] ${m}`),
            ),
          );
        });
        finish('更新依赖', results);
      }),
    ),

    command(
      'bapIde.scm.compileProject',
      toolCommand('compileProject', async (arg) => {
        const contexts = await resolveManyForUi(arg, '编译项目', false);
        const names = contexts.map((c) => `「${c.displayName}」`).join('、');
        const msg = await vscode.window.showWarningMessage(
          `确定编译项目（本地）？将用 JDK javac 编译 ${names} 的 src/** 到 bin/（不连服务器）。`,
          { modal: true },
          '编译',
        );
        if (msg !== '编译') return;
        const results = await runMany('编译项目（本地）', contexts.map((context) => ({ context })), (ctx) =>
          ctx.runExclusive(async () => {
            const r = await ctx.ensureSdk().compile.project();
            if (!r.success) throw new Error(`编译失败（${r.errorCode}）: ${r.compilerOutput || '未知原因'}`);
            return r;
          }),
        );
        const total = results.reduce((n, r) => n + (r.ok ? r.value.sourceFiles : 0), 0);
        finish('编译项目', results, `编译完成（${total} 个源文件）`);
      }),
    ),

    command(
      'bapIde.scm.compileFile',
      toolCommand('compileFile', async (arg) => {
        const ctx = await resolveOneForUi(arg, '编译单类');
        const absPath = changePathOrArg(ctx, arg);
        if (!absPath) return;
        if (!absPath.toLowerCase().endsWith('.java')) {
          void vscode.window.showInformationMessage('BAP: 请选择 Java 源文件进行编译');
          return;
        }
        const fullClass = deriveFullClass(ctx.root, absPath);
        if (!fullClass) {
          void vscode.window.showInformationMessage('BAP: 无法解析类名，请在工作区 src/ 下的 .java 文件上操作');
          return;
        }
        const content = fs.readFileSync(absPath, 'utf8');
        const problems = await ctx.runExclusive(() => ctx.ensureSdk().compile.singleCode(fullClass, content, false));
        const diags = problems.map(
          (p) =>
            new vscode.Diagnostic(
              problemRange(content, p.line, p.startPosition, p.endPosition),
              p.message ?? '',
              p.isError ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
            ),
        );
        compileDiag.set(vscode.Uri.file(absPath), diags);
        const errors = problems.filter((p) => p.isError).length;
        const warns = problems.filter((p) => p.isWarn).length;
        log.debug(`[compileFile][${ctx.displayName}] 完成，error=${errors} warn=${warns}`);
        void vscode.window.setStatusBarMessage(
          errors || warns ? `BAP: 编译 ${errors} 错误 / ${warns} 警告` : 'BAP: 编译通过',
          5000,
        );
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(absPath), { preview: true });
      }),
    ),

    command(
      'bapIde.scm.debugClass',
      toolCommand('debugClass', async (arg) => {
        const ctx = await resolveOneForUi(arg, '调试（云端运行）');
        const absPath = changePathOrArg(ctx, arg);
        if (!absPath || !absPath.toLowerCase().endsWith('.java')) {
          void vscode.window.showInformationMessage('BAP: 请选择 Java 源文件进行调试');
          return;
        }
        const fullClass = deriveFullClass(ctx.root, absPath);
        if (!fullClass) {
          void vscode.window.showInformationMessage('BAP: 无法解析类名');
          return;
        }
        const code = fs.readFileSync(absPath, 'utf8');
        debugChannel.show(true);
        debugChannel.appendLine(`[debug][${ctx.displayName}] 运行 ${fullClass}（云端）…`);
        const r = await ctx.runExclusive(() =>
          ctx.ensureSdk().debug.start(fullClass, code, (line) => debugChannel.appendLine(line)),
        );
        debugChannel.appendLine('--------------------');
        debugChannel.appendLine(`调试ID (DebugKey): ${r.debugKey}`);
        debugChannel.appendLine(`是否异常 (IsException): ${r.isError}`);
        debugChannel.appendLine(`返回对象 (Result Object): ${previewResult(r.result)}`);
        debugChannel.appendLine(`返回文本 (Result Text): ${r.resultText}`);
        void vscode.window.setStatusBarMessage(r.isError ? 'BAP: 调试运行异常' : 'BAP: 调试完成', 5000);
      }),
    ),

    command(
      'bapIde.scm.testProject',
      toolCommand('testProject', async (arg) => {
        const uri = uriFromArg(arg);
        if (uri && /\.java$/i.test(uri.fsPath)) {
          const ctx = await resolveOneForUi(arg, '单元测试');
          const selectClass = deriveFullClass(ctx.root, uri.fsPath);
          await runTest(ctx, selectClass);
          return;
        }
        const contexts = await resolveManyForUi(arg, '单元测试', false);
        const results = await runMany('单元测试', contexts.map((context) => ({ context })), (ctx, prog) =>
          runTest(ctx, undefined, prog),
        );
        const passed = results.reduce((n, r) => n + (r.ok ? r.value.passed : 0), 0);
        const failed = results.reduce((n, r) => n + (r.ok ? r.value.failed : 0), 0);
        finish('单元测试', results, failed ? `单元测试 ${failed} 失败 / ${passed} 通过` : `单元测试通过（${passed}）`);
      }),
    ),

    command('bapIde.workspaceInfo', async (arg) => {
      const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => ({
        name: f.name,
        fsPath: f.uri.fsPath,
        scheme: f.uri.scheme,
      }));
      // MCP 宿主导入调用方进程实际生效的模式；UI 调用（无该字段）按当前窗口状态推断。
      const injected =
        arg && typeof arg === 'object' ? (arg as Record<string, unknown>).__mcpMode : undefined;
      const mode = injected === 'full' || injected === 'bootstrap' ? injected : undefined;
      const info = buildWorkspaceInfo({
        workspaceFolders: folders,
        descriptors: discoverBackendProjectDescriptors(),
        registeredProjectIds: new Set(registry.getAll().map((c) => c.projectId)),
        ...(mode ? { mode } : {}),
      });
      if (!isToolCall(arg)) {
        void vscode.window.showInformationMessage(
          `BAP: ${info.projects.length} 个后端工程，MCP ${info.mcp.mode === 'full' ? '完整工具集' : '引导模式（仅 workspaceInfo/listProjects/downloadProject）'}`,
        );
      }
      return info;
    }),

    command('bapIde.listProjects', async (arg) => {
      if (!isToolCall(arg)) {
        const ctx = await resolveOneForUi(arg, '列出项目');
        const list = (await ctx.runExclusive(() => ctx.ensureSdk().project.list())) as CJavaProjectDto[];
        void vscode.window.setStatusBarMessage(`BAP: [${ctx.displayName}] 当前环境 ${list.length} 个工程`, 5000);
        return undefined;
      }

      const a = arg as Record<string, unknown>;
      if (a.uri !== undefined || a.user !== undefined || a.pwd !== undefined) {
        // 引导模式：显式凭据直连服务器（三者必须齐全，probeServerProjects 会校验）。
        return probeServerProjects(opts.launch, {
          uri: typeof a.uri === 'string' ? a.uri : '',
          user: typeof a.user === 'string' ? a.user : '',
          pwd: typeof a.pwd === 'string' ? a.pwd : '',
        });
      }

      if (registry.getAll().length === 0) {
        const live = discoverBackendProjectDescriptors();
        const msg =
          live.length > 0
            ? '后端工程已在文件系统中，但尚未加入工作区/重载窗口；请重载后重试，或提供 uri/user/pwd 直连服务器'
            : '未发现后端工程；请先调用 downloadProject，或提供 uri/user/pwd 直连服务器';
        throw new ProjectResolutionError(
          msg,
          'NO_PROJECTS',
          live.map((d) => ({ projectId: d.projectId, displayName: d.displayName, root: d.root })),
        );
      }

      let ctx: BackendProjectContext;
      try {
        // 允许活动编辑器 / 上次使用回退（listProjects 只需一个可用连接）。
        ctx = (await registry.resolve({}, { interactive: false })).context;
      } catch (e) {
        if (isProjectResolutionError(e) && e.code === 'AMBIGUOUS') {
          throw new ProjectResolutionError(
            '窗口内有多个后端工程，无法确定用哪个连接；请提供 uri/user/pwd 直连服务器，或打开目标工程的文件后重试',
            'AMBIGUOUS',
            e.candidates,
          );
        }
        throw e;
      }
      return execTool(toolCtx(ctx), 'listProjects', { __tool: true });
    }),

    command(
      'bapIde.fetchCurrent',
      toolCommand('fetchCurrent', async () => {
        void vscode.window.showInformationMessage('BAP: fetchCurrent 需提供 fullClass 或 path');
        return undefined;
      }),
    ),

    command('bapIde.resetAgentInstructions', async (arg) => {
      const contexts = await resolveManyForUi(arg, '重建 Agent 指令', true);
      const names = contexts.map((c) => `「${c.displayName}」`).join('、');
      const msg = await vscode.window.showWarningMessage(
        `重建 ${names} 的 CLAUDE.md、AGENTS.md，并为 Claude Code（.mcp.json）与 Codex（.codex/config.toml）写入 MCP 配置？\n已有内容会按 BAP 标记段合并；损坏的 .mcp.json 会跳过并警告。`,
        { modal: true },
        '重建',
      );
      if (msg !== '重建') return;

      const warnings: string[] = [];
      const workspaceFolderPaths = (vscode.workspace.workspaceFolders ?? [])
        .filter((f) => f.uri.scheme === 'file')
        .map((f) => f.uri.fsPath);
      const allProjects = registry.getAll();
      const readIfExists = (file: string): string | undefined =>
        fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;

      const results = await runMany('重建 Agent 指令', contexts.map((context) => ({ context })), async (ctx) => {
        await ctx.runWrite(async () => {
          const info = collectAgentProjectInfo(ctx.root);
          const vfRoot = findVfWorkspaceRoot(ctx.root, workspaceFolderPaths);
          // skill 只在用户显式执行 BAP: Install Skills 后存在；未安装时不要把“已安装到”写进指令。
          // 判定口径与 skill-installer 一致：必须存在普通文件 SKILL.md，空目录/残缺残留视为未安装。
          const skillInstallPath = vfRoot
            ? path.join(vfRoot, '.votaforge', 'skill', 'bap-vscode-mcp')
            : undefined;
          const skillInstalled =
            !!skillInstallPath &&
            (() => {
              try {
                return fs.lstatSync(path.join(skillInstallPath, 'SKILL.md')).isFile();
              } catch {
                return false;
              }
            })();
          const generationCtx: AgentGenerationContext = {
            currentProjectId: ctx.projectId,
            currentDisplayName: ctx.displayName,
            projectCount: allProjects.length,
            siblings: allProjects.map((o) => ({
              projectId: o.projectId,
              displayName: o.displayName,
              root: o.root,
              current: o.projectId === ctx.projectId,
            })),
            ...(vfRoot ? { vfRoot } : {}),
            ...(skillInstalled ? { skillInstallPath } : {}),
          };
          const content = buildAgentFileContent(info, generationCtx);

          for (const filename of ['CLAUDE.md', 'AGENTS.md']) {
            const file = path.join(ctx.root, filename);
            try {
              const merged = mergeMarkedSection(readIfExists(file), content);
              if (merged.warning) warnings.push(`[${ctx.displayName}] ${filename}: ${merged.warning}`);
              fs.writeFileSync(file, merged.content);
            } catch (e) {
              warnings.push(
                `[${ctx.displayName}] ${filename} 读写失败，已跳过：${errorMessage(e)}`,
              );
            }
          }

          const mcpJsonFile = path.join(ctx.root, '.mcp.json');
          try {
            const merged = mergeMcpJson(readIfExists(mcpJsonFile), opts.mcpServerPath);
            if (merged.ok) fs.writeFileSync(mcpJsonFile, merged.content);
            else warnings.push(`[${ctx.displayName}] ${merged.message}`);
          } catch (e) {
            warnings.push(`[${ctx.displayName}] .mcp.json 读写失败，已跳过：${errorMessage(e)}`);
          }

          const codexDir = path.join(ctx.root, '.codex');
          const codexFile = path.join(codexDir, 'config.toml');
          try {
            const codexToml = mergeCodexToml(readIfExists(codexFile), opts.mcpServerPath);
            fs.mkdirSync(codexDir, { recursive: true });
            fs.writeFileSync(codexFile, codexToml);
          } catch (e) {
            warnings.push(
              `[${ctx.displayName}] .codex/config.toml 读写失败，已跳过：${errorMessage(e)}`,
            );
          }
        });
        return true;
      });
      finish('重建 Agent 指令', results, '已重建 Agent 指令与 MCP 配置（重启 Claude Code / 重载 Codex 生效）');
      if (warnings.length > 0) {
        const detail = warnings.length > 10 ? `${warnings.slice(0, 10).join('\n')}\n…` : warnings.join('\n');
        void vscode.window.showWarningMessage(`BAP: Agent 指令已重建，但有以下注意事项：\n${detail}`);
      }
    }),
  );

  // ---- 重定向 UI 流程（多工程：单个工程） ----

  type RedirectDecision =
    | { type: 'pick'; profile: RelocateProfile }
    | { type: 'new' }
    | { type: 'edit'; profile: RelocateProfile }
    | { type: 'cancel' };

  async function runRedirect(ctx: BackendProjectContext): Promise<void> {
    ensureCurrentInHistory(ctx.root);
    const history = loadRelocateHistory(ctx.root);
    const decision = await showHistoryQuickPick(history, ctx.root);
    log.debug(`redirect decision=${decision.type} [${ctx.displayName}]`);
    if (decision.type === 'cancel') return;
    if (decision.type === 'pick') {
      await applyRedirect(ctx, decision.profile);
      return;
    }
    if (decision.type === 'new') {
      await collectAndRedirect(ctx);
      return;
    }
    if (decision.type === 'edit') {
      await editAndRedirect(ctx, decision.profile);
    }
  }

  function showHistoryQuickPick(history: RelocateProfile[], projectRoot: string): Promise<RedirectDecision> {
    const EDIT_BTN = { iconPath: new vscode.ThemeIcon('edit'), tooltip: '编辑' };
    const DEL_BTN = { iconPath: new vscode.ThemeIcon('trash'), tooltip: '删除' };
    const profileByItem = new Map<vscode.QuickPickItem, RelocateProfile | 'NEW'>();
    const items: vscode.QuickPickItem[] = history.map((h) => {
      const item: vscode.QuickPickItem = { label: `${h.uri} - ${h.user}` };
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
          removeRelocateHistory(projectRoot, rec);
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

  function ensureCurrentInHistory(projectRoot: string): void {
    try {
      const cfg = loadDevelop(projectRoot);
      addRelocateHistory(projectRoot, {
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

  async function applyRedirect(ctx: BackendProjectContext, profile: RelocateProfile): Promise<void> {
    const scm = ctx.ensureScm();
    const sdk = ctx.ensureSdk();
    await ctx.runWrite(async () => {
      await sdk.redirect.apply(profile);
      // .develop 已改写：在本工程串行队列内立即采纳新身份，避免后续写操作被判 stale。
      ctx.adoptIdentity(readProjectIdentity(ctx.root));
    });
    registry.recomputeDuplicates();
    await scm.refresh(true, { throwOnError: true });
    void vscode.window.setStatusBarMessage(
      `BAP: [${ctx.displayName}] 已重定向到 ${profile.projectName || profile.uri}`,
      3000,
    );
  }

  async function collectAndRedirect(ctx: BackendProjectContext): Promise<void> {
    const sdk = ctx.ensureSdk();
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
      const msg = errorMessage(e);
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
    await applyRedirect(ctx, {
      uri: uri.trim(), user: user.trim(), pwd,
      projectUuid: dto.uuid, projectName: dto.name,
    });
  }

  async function editAndRedirect(ctx: BackendProjectContext, profile: RelocateProfile): Promise<void> {
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
    await applyRedirect(ctx, { ...profile, uri: uri.trim(), user: user.trim(), pwd });
  }

  async function resetConnection(sdk: { disconnect(): Promise<void> }): Promise<void> {
    try {
      await sdk.disconnect();
    } catch {
      // 忽略
    }
  }

  /** 编译/调试/测试用：优先取 SCM 变更的绝对路径，否则从参数解析。 */
  function changePathOrArg(ctx: BackendProjectContext, arg: unknown): string | undefined {
    return findChange(ctx, arg)?.absolutePath ?? fsPathFromArg(arg);
  }

  async function runTest(
    ctx: BackendProjectContext,
    selectClass: string | undefined,
    prog?: vscode.Progress<{ message?: string }>,
  ) {
    const sdk = ctx.ensureSdk();
    testChannel.show(true);
    testChannel.appendLine(`[test][${ctx.displayName}] 开始编译 + 运行单元测试（${selectClass ?? '全部'}）…`);
    prog?.report({ message: `${ctx.displayName}: 编译中…` });
    const r = await ctx.runExclusive(() =>
      sdk.test.project({
        selectClass,
        onOutput: (line) => testChannel.appendLine(`[${ctx.displayName}] ${line}`),
      }),
    );
    testChannel.appendLine('--------------------');
    testChannel.appendLine(
      `[${ctx.displayName}] Total: ${r.total} | Passed: ${r.passed} | Failed: ${r.failed} | Skipped: ${r.skipped} | Exit code: ${r.exitCode}`,
    );
    log.debug(`[testProject][${ctx.displayName}] 完成，pass=${r.passed} fail=${r.failed} skip=${r.skipped}`);
    return r;
  }

  return subscriptions;
}
