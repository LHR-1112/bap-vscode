// MCP 工具执行器：一个 tool ↔ 一个 bapIde.* 命令，但工具路径走这里——非交互、直接调 SDK/bapScm，
// 返回可 JSON 序列化的结果（不开弹窗/通道/视图）。宿主 dispatch 仍是 executeCommand(command, {__tool, ...})。
import type { BapSdk, Change } from '@bap/sdk';
import type { BapScmProviderHandle } from '../scm/bap-scm-provider';

export interface McpToolCtx {
  sdk: BapSdk;
  bapScm: BapScmProviderHandle;
  workspaceRoot: string;
  log: { debug(msg: string): void; error(msg: string): void };
}

/** 工具调用参数（用 __tool 标记区别于 UI 调用）。 */
export interface ToolArg {
  __tool: true;
  [k: string]: unknown;
}

export const isToolCall = (a: unknown): a is ToolArg =>
  !!a && typeof a === 'object' && '__tool' in (a as Record<string, unknown>);

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

/** 执行一个 MCP 工具，返回可直接 JSON 序列化的结果。 */
export async function execTool(ctx: McpToolCtx, name: string, a: ToolArg): Promise<unknown> {
  const { sdk, bapScm } = ctx;
  switch (name) {
    case 'refresh': {
      const changes = await bapScm.refresh(true);
      const dirty = changes.filter((c) => c.status !== 'NORMAL');
      return {
        nonNormal: dirty.length,
        changes: dirty.map((c) => ({ relativePath: c.relativePath, status: c.status, folder: c.folder })),
      };
    }
    case 'commit': {
      await bapScm.commit((a.comment as string) || '');
      return '已提交全部变更';
    }
    case 'commitFile': {
      const c = resolveChange(ctx, a);
      await bapScm.commitFile(c, (a.comment as string) || '');
      return `已提交 ${c.relativePath}`;
    }
    case 'updateFile': {
      const c = resolveChange(ctx, a);
      await bapScm.updateFile(c);
      return `已回退到云端 ${c.relativePath}`;
    }
    case 'updateAll': {
      await bapScm.updateAll();
      return '已全部回退到云端';
    }
    case 'publish': {
      await sdk.publish.full({ ignoreErrors: (a.ignoreErrors as boolean) ?? false });
      return '已发布插件（全量）';
    }
    case 'projectHistory': {
      return await sdk.history.queryVersionList();
    }
    case 'fileHistory': {
      return await sdk.history.queryFileHistory(a.remoteKey as string);
    }
    case 'updateLibs': {
      const r = await sdk.syncLibs();
      return { updated: r.updated, deleted: r.deleted };
    }
    case 'compileProject': {
      return await sdk.compile.project({ clean: (a.clean as boolean) ?? false });
    }
    case 'compileFile': {
      return await sdk.compile.singleCode(a.fullClass as string, a.code as string, false);
    }
    case 'debugClass': {
      const r = await sdk.debug.start(a.fullClass as string, a.code as string, (line) =>
        ctx.log.debug(`[debug] ${line}`),
      );
      return { status: r.status, isError: r.isError, resultText: r.resultText, traceCount: r.traceCount };
    }
    case 'testProject': {
      const r = await sdk.test.project({ selectClass: a.selectClass as string | undefined });
      return { total: r.total, passed: r.passed, failed: r.failed, skip: r.skipped, exitCode: r.exitCode };
    }
    case 'redirect': {
      await sdk.redirect.apply({
        uri: a.uri as string,
        user: a.user as string,
        pwd: a.pwd as string,
        projectUuid: a.projectUuid as string,
        projectName: (a.projectName as string) || '',
      });
      return '已重定向';
    }
    case 'listProjects': {
      return await sdk.project.list();
    }
    case 'fetchCurrent': {
      if (a.fullClass) {
        const r = await sdk.code.getRemote(a.fullClass as string);
        return { fullClass: a.fullClass, code: r?.code ?? null };
      }
      const p = a.path as string;
      const r = await sdk.code.getRes(p);
      return { path: p, base64: r?.fileBin ?? null };
    }
    default:
      throw new Error(`未知 MCP 工具: ${name}`);
  }
}
