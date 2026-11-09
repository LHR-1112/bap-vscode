// MCP 工具执行器：一个 tool ↔ 一个 bapIde.* 命令，但工具路径走这里——非交互、直接调 SDK/bapScm，
// 返回可 JSON 序列化的结果（不开弹窗/通道/视图）。宿主 dispatch 仍是 executeCommand(command, {__tool, ...})。
// 多工程：宿主为解析出的工程构造 McpToolCtx（带 runWrite/runExclusive），写操作先过工程身份校验。
import { validateMetadataDomainCode, type BapSdk, type Change } from '@bap/sdk';
import type { BapScmProviderHandle } from '../scm/bap-scm-provider';
import { findVfWorkspaceRoot } from '../backend-projects';
import { readActiveBusDomainCode } from '../projects/server-profiles';
import { isValidFullClassName, isValidMethodName } from '../java-source';

export interface McpToolCtx {
  sdk: BapSdk;
  bapScm: BapScmProviderHandle;
  workspaceRoot: string;
  /**
   * 窗口内 file scheme 的 workspace folder 绝对路径（由命令路由注入）。
   * 用于定位 VotaForge 根；MCP 路径不直接依赖 vscode，便于单测。
   */
  workspaceFolders?: readonly string[];
  log: { debug(msg: string): void; error(msg: string): void };
  /** 解析出的工程 ID / 展示名（用于工具结果的 project envelope）。 */
  projectId?: string;
  displayName?: string;
  /** 写操作：工程身份校验 + 串行执行（重定向等改 .develop 的操作也走这里）。 */
  runWrite?<T>(fn: () => Promise<T>): Promise<T>;
  /** 独占操作：编译/测试/调试等重任务，避免同工程并发。 */
  runExclusive?<T>(fn: () => Promise<T>): Promise<T>;
  /** 重定向成功后更新宿主的工程身份基线（由命令路由注入）。 */
  afterRedirect?(): Promise<void> | void;
}

/** 工具调用参数（用 __tool 标记区别于 UI 调用）。 */
export interface ToolArg {
  __tool: true;
  [k: string]: unknown;
}

export const isToolCall = (a: unknown): a is ToolArg =>
  !!a && typeof a === 'object' && (a as Record<string, unknown>).__tool === true;

/** 工程级工具的统一返回结构（P1-7）：调用方总能知道实际作用到了哪个工程。 */
export interface ProjectToolEnvelope<T> {
  project: { projectId: string; displayName: string; root: string };
  result: T;
}

/** 把工程级工具的执行结果包一层；undefined 统一转 null（JSON 友好）。 */
export function wrapProjectResult<T>(ctx: McpToolCtx, result: T): ProjectToolEnvelope<T | null> {
  const projectId = ctx.projectId ?? ctx.workspaceRoot;
  return {
    project: {
      projectId,
      displayName: ctx.displayName ?? projectId,
      root: ctx.workspaceRoot,
    },
    result: result === undefined ? null : result,
  };
}

/** 按 fullClass/path 从当前变更里解析 Change（commitFile/updateFile 需要）。 */
function resolveChange(ctx: McpToolCtx, a: ToolArg): Change {
  const fullClass = a.fullClass as string | undefined;
  const resPath = a.path as string | undefined;
  const rel = fullClass ? `${fullClass.split('.').join('/')}.java` : resPath;
  if (!rel) throw new Error('缺少 fullClass 或 path');
  const c = ctx.bapScm.getChanges().find((x) => x.relativePath === rel);
  if (!c) throw new Error(`未找到变更：${rel}`);
  return c;
}

const exclusive = <T>(ctx: McpToolCtx, fn: () => Promise<T>): Promise<T> =>
  ctx.runExclusive ? ctx.runExclusive(fn) : fn();
const write = <T>(ctx: McpToolCtx, fn: () => Promise<T>): Promise<T> =>
  ctx.runWrite ? ctx.runWrite(fn) : fn();

function requireString(a: ToolArg, key: string): string {
  const v = typeof a[key] === 'string' ? (a[key] as string).trim() : '';
  if (!v) throw new Error(`缺少参数 ${key}`);
  return v;
}

/** 校验域 code；非法时记 debug（不含密码）并返回 undefined，由调用方回退。 */
function tryMetadataDomainForTool(
  ctx: McpToolCtx,
  code: string | undefined,
  source: string,
): string | undefined {
  if (!code) return undefined;
  try {
    return validateMetadataDomainCode(code);
  } catch (e) {
    ctx.log.debug(`[metadata] ${source} 域非法，忽略: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

/**
 * MCP 路径的域解析（只读，不弹 QuickPick、不写 .develop）：
 * 显式 domainCode > VF active profile busDomainCode > .develop MetadataDomain；
 * 都没有时读取候选域并抛错，让 AI 带 domainCode 重试。
 */
async function resolveMetadataDomainForTool(ctx: McpToolCtx, a: ToolArg): Promise<string> {
  const explicit = typeof a.domainCode === 'string' ? a.domainCode.trim() : '';
  if (explicit) return validateMetadataDomainCode(explicit);

  const vfRoot = findVfWorkspaceRoot(ctx.workspaceRoot, ctx.workspaceFolders ?? []);
  const vfDomain = tryMetadataDomainForTool(
    ctx,
    vfRoot ? readActiveBusDomainCode(vfRoot) : undefined,
    'VF busDomainCode',
  );
  if (vfDomain) return vfDomain;

  const configured = tryMetadataDomainForTool(
    ctx,
    ctx.sdk.metadata.configuredDomain(),
    '.develop MetadataDomain',
  );
  if (configured) return configured;

  const domains = await exclusive(ctx, () => ctx.sdk.metadata.listDomains());
  const codes =
    domains
      .map((d) => d.code)
      .filter((code): code is string => typeof code === 'string' && code.trim().length > 0)
      .join('、') || '（服务器未返回）';
  throw new Error(
    `缺少 domainCode，且 VotaForge server-profiles.json / .develop 均未提供；可用业务域：${codes}`,
  );
}

/** 执行一个 MCP 工具，返回可直接 JSON 序列化的结果。 */
export async function execTool(ctx: McpToolCtx, name: string, a: ToolArg): Promise<unknown> {
  const { sdk, bapScm } = ctx;
  switch (name) {
    case 'refresh': {
      // 工具路径需要真实失败（不能吞错成「0 个变更」）。
      const changes = await exclusive(ctx, () => bapScm.refresh(true, { throwOnError: true }));
      const dirty = changes.filter((c) => c.status !== 'NORMAL');
      return {
        nonNormal: dirty.length,
        changes: dirty.map((c) => ({ relativePath: c.relativePath, status: c.status, folder: c.folder })),
      };
    }
    case 'commit': {
      await write(ctx, () => bapScm.commit((a.comment as string) || ''));
      return '已提交全部变更';
    }
    case 'commitFile': {
      const c = resolveChange(ctx, a);
      await write(ctx, () => bapScm.commitFile(c, (a.comment as string) || ''));
      return `已提交 ${c.relativePath}`;
    }
    case 'updateFile': {
      const c = resolveChange(ctx, a);
      await write(ctx, () => bapScm.updateFile(c));
      return `已回退到云端 ${c.relativePath}`;
    }
    case 'updateAll': {
      await write(ctx, () => bapScm.updateAll());
      return '已全部回退到云端';
    }
    case 'publish': {
      await write(ctx, () => sdk.publish.full({ ignoreErrors: (a.ignoreErrors as boolean) ?? false }));
      return '已发布插件（全量）';
    }
    case 'projectHistory': {
      return await exclusive(ctx, () => sdk.history.queryVersionList());
    }
    case 'fileHistory': {
      return await exclusive(ctx, () => sdk.history.queryFileHistory(a.remoteKey as string));
    }
    case 'updateLibs': {
      const r = await write(ctx, () => sdk.syncLibs());
      return { updated: r.updated, deleted: r.deleted };
    }
    case 'compileProject': {
      return await exclusive(ctx, () => sdk.compile.project({ clean: (a.clean as boolean) ?? false }));
    }
    case 'compileFile': {
      return await exclusive(ctx, () => sdk.compile.singleCode(a.fullClass as string, a.code as string, false));
    }
    case 'debugClass': {
      const r = await exclusive(ctx, () =>
        sdk.debug.start(a.fullClass as string, a.code as string, (line) =>
          ctx.log.debug(`[debug] ${line}`),
        ),
      );
      return { status: r.status, isError: r.isError, resultText: r.resultText, traceCount: r.traceCount };
    }
    case 'testProject': {
      const r = await exclusive(ctx, () =>
        sdk.test.project({ selectClass: a.selectClass as string | undefined }),
      );
      return { total: r.total, passed: r.passed, failed: r.failed, skip: r.skipped, exitCode: r.exitCode };
    }
    case 'registerClassRuleFunctions': {
      const fullClass = requireString(a, 'fullClass');
      if (!isValidFullClassName(fullClass)) throw new Error(`非法全类名：${fullClass}`);
      const domain = await resolveMetadataDomainForTool(ctx, a);
      const r = await write(ctx, () => sdk.metadata.registerFunctions(domain, fullClass));
      if (!r.success) throw new Error(r.message || '注册失败');
      return { domain, success: true, count: r.functions?.length ?? 0, functions: r.functions ?? [] };
    }
    case 'registerMethodRuleFunction': {
      const fullClass = requireString(a, 'fullClass');
      const methodName = requireString(a, 'methodName');
      if (!isValidFullClassName(fullClass)) throw new Error(`非法全类名：${fullClass}`);
      if (!isValidMethodName(methodName)) throw new Error(`非法方法名：${methodName}`);
      const domain = await resolveMetadataDomainForTool(ctx, a);
      const r = await write(ctx, () => sdk.metadata.registerFunction(domain, fullClass, methodName));
      if (!r.success) throw new Error(r.message || '注册失败');
      return { domain, success: true, count: r.functions?.length ?? 0, functions: r.functions ?? [] };
    }
    case 'redirect': {
      await write(ctx, async () => {
        await sdk.redirect.apply({
          uri: a.uri as string,
          user: a.user as string,
          pwd: a.pwd as string,
          projectUuid: a.projectUuid as string,
          projectName: (a.projectName as string) || '',
        });
        // .develop 已改写：立即刷新身份基线，避免下一次写操作被判成 PROJECT_STALE。
        await ctx.afterRedirect?.();
      });
      return '已重定向';
    }
    case 'listProjects': {
      return await exclusive(ctx, () => sdk.project.list());
    }
    case 'fetchCurrent': {
      if (a.fullClass) {
        const r = await exclusive(ctx, () => sdk.code.getRemote(a.fullClass as string));
        return { fullClass: a.fullClass, code: r?.code ?? null };
      }
      const p = a.path as string;
      const r = await exclusive(ctx, () => sdk.code.getRes(p));
      return { path: p, base64: r?.fileBin ?? null };
    }
    default:
      throw new Error(`未知 MCP 工具: ${name}`);
  }
}
