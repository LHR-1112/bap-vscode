// MCP 规则函数注册工具的执行分支：域解析优先级、错误路径与返回结构（P1）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execTool, type McpToolCtx, type ToolArg } from '../src/mcp/tool-exec';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bap-mcp-meta-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface SdkStubs {
  configuredDomain?: () => string | undefined;
  listDomains?: () => Promise<{ code?: string; name?: string }[]>;
  registerFunction?: (...args: unknown[]) => Promise<unknown>;
  registerFunctions?: (...args: unknown[]) => Promise<unknown>;
}

/** 只构造 metadata 相关的最小 SDK 桩；其它命名空间由 execTool 的 metadata 分支忽略。 */
function makeCtx(over: Partial<McpToolCtx> & { sdkStubs?: SdkStubs } = {}): McpToolCtx {
  const stubs = over.sdkStubs ?? {};
  const sdk = {
    metadata: {
      configuredDomain: stubs.configuredDomain ?? (() => undefined),
      listDomains: stubs.listDomains ?? (async () => []),
      registerFunction: stubs.registerFunction ?? (async () => ({ success: true, functions: [] })),
      registerFunctions: stubs.registerFunctions ?? (async () => ({ success: true, functions: [] })),
    },
  };
  const { sdkStubs: _ignored, ...rest } = over;
  return {
    sdk: sdk as unknown as McpToolCtx['sdk'],
    bapScm: {} as McpToolCtx['bapScm'],
    workspaceRoot: path.join(tmp, 'proj'),
    workspaceFolders: [tmp],
    log: { debug: () => {}, error: () => {} },
    ...rest,
  };
}

const call = (name: string, args: Record<string, unknown>): ToolArg =>
  ({ __tool: true, ...args }) as ToolArg;

describe('execTool: registerMethodRuleFunction', () => {
  it('显式 domainCode 优先，且返回 cloud 结果摘要', async () => {
    const registerFunction = vi.fn(async () => ({
      success: true,
      functions: [{ ruleCode: 'D_EXPLICIT_hello', invokeMethod: 'hello' }],
    }));
    const listDomains = vi.fn(async () => [{ code: 'SHOULD_NOT_USE' }]);
    const ctx = makeCtx({ sdkStubs: { registerFunction, listDomains } });

    const r = await execTool(
      ctx,
      'registerMethodRuleFunction',
      call('registerMethodRuleFunction', {
        fullClass: 'com.x.Foo',
        methodName: 'hello',
        domainCode: 'D_EXPLICIT',
      }),
    );

    expect(r).toEqual({
      domain: 'D_EXPLICIT',
      success: true,
      count: 1,
      functions: [{ ruleCode: 'D_EXPLICIT_hello', invokeMethod: 'hello' }],
    });
    expect(registerFunction).toHaveBeenCalledWith('D_EXPLICIT', 'com.x.Foo', 'hello');
    expect(listDomains).not.toHaveBeenCalled();
  });

  it('缺省 domainCode 时用 VF active profile 的 busDomainCode', async () => {
    const project = path.join(tmp, 'proj');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'votaforge.workspace.json'), '{}');
    fs.mkdirSync(path.join(tmp, '.votaforge'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.votaforge', 'server-profiles.json'),
      JSON.stringify({
        activeProfileId: 'p1',
        profiles: [
          { id: 'p0', busDomainCode: 'D_OTHER' },
          { id: 'p1', busDomainCode: 'D_VF' },
        ],
      }),
    );

    const registerFunction = vi.fn(async () => ({ success: true, functions: [] }));
    const ctx = makeCtx({
      workspaceRoot: project,
      workspaceFolders: [tmp],
      sdkStubs: { registerFunction, configuredDomain: () => 'D_DEVELOP_SHOULD_NOT_WIN' },
    });

    const r = await execTool(
      ctx,
      'registerMethodRuleFunction',
      call('registerMethodRuleFunction', { fullClass: 'com.x.Foo', methodName: 'hello' }),
    );

    expect((r as { domain: string }).domain).toBe('D_VF');
    expect(registerFunction).toHaveBeenCalledWith('D_VF', 'com.x.Foo', 'hello');
  });

  it('无 VF 配置时只读回退 .develop 的 MetadataDomain', async () => {
    const registerFunction = vi.fn(async () => ({ success: true, functions: [] }));
    const ctx = makeCtx({
      sdkStubs: { registerFunction, configuredDomain: () => 'D_DEVELOP' },
    });

    const r = await execTool(
      ctx,
      'registerMethodRuleFunction',
      call('registerMethodRuleFunction', { fullClass: 'com.x.Foo', methodName: 'hello' }),
    );

    expect((r as { domain: string }).domain).toBe('D_DEVELOP');
    expect(registerFunction).toHaveBeenCalledWith('D_DEVELOP', 'com.x.Foo', 'hello');
  });

  it('都没有域时报错并列出候选，不发起注册', async () => {
    const registerFunction = vi.fn(async () => ({ success: true, functions: [] }));
    const ctx = makeCtx({
      sdkStubs: {
        registerFunction,
        listDomains: async () => [{ code: 'D_A' }, { code: 'D_B' }],
      },
    });

    await expect(
      execTool(
        ctx,
        'registerMethodRuleFunction',
        call('registerMethodRuleFunction', { fullClass: 'com.x.Foo', methodName: 'hello' }),
      ),
    ).rejects.toThrow('可用业务域：D_A、D_B');
    expect(registerFunction).not.toHaveBeenCalled();
  });

  it('success=false 转成真实错误，消息保留服务端业务提示', async () => {
    const ctx = makeCtx({
      sdkStubs: {
        registerFunction: async () => ({ success: false, message: '缺少 @MethodDeclare 注解' }),
      },
    });

    await expect(
      execTool(
        ctx,
        'registerMethodRuleFunction',
        call('registerMethodRuleFunction', {
          fullClass: 'com.x.Foo',
          methodName: 'hello',
          domainCode: 'D_X',
        }),
      ),
    ).rejects.toThrow('缺少 @MethodDeclare 注解');
  });

  it('非法全类名/方法名在域解析前失败', async () => {
    const listDomains = vi.fn(async () => [{ code: 'D_A' }]);
    const ctx = makeCtx({ sdkStubs: { listDomains } });

    await expect(
      execTool(
        ctx,
        'registerMethodRuleFunction',
        call('registerMethodRuleFunction', { fullClass: 'com.x..Foo', methodName: 'hello' }),
      ),
    ).rejects.toThrow('非法全类名');
    await expect(
      execTool(
        ctx,
        'registerMethodRuleFunction',
        call('registerMethodRuleFunction', { fullClass: 'com.x.Foo', methodName: 'a b' }),
      ),
    ).rejects.toThrow('非法方法名');
    expect(listDomains).not.toHaveBeenCalled();
  });
});

describe('execTool: registerClassRuleFunctions', () => {
  it('注册整类并返回 count/functions', async () => {
    const registerFunctions = vi.fn(async () => ({
      success: true,
      functions: [{ ruleCode: 'D_X_a' }, { ruleCode: 'D_X_b' }],
    }));
    const ctx = makeCtx({ sdkStubs: { registerFunctions } });

    const r = await execTool(
      ctx,
      'registerClassRuleFunctions',
      call('registerClassRuleFunctions', { fullClass: 'com.x.Foo', domainCode: 'D_X' }),
    );

    expect(r).toEqual({
      domain: 'D_X',
      success: true,
      count: 2,
      functions: [{ ruleCode: 'D_X_a' }, { ruleCode: 'D_X_b' }],
    });
    expect(registerFunctions).toHaveBeenCalledWith('D_X', 'com.x.Foo');
  });

  it('缺少 fullClass 直接报错', async () => {
    const ctx = makeCtx();
    await expect(
      execTool(ctx, 'registerClassRuleFunctions', call('registerClassRuleFunctions', {})),
    ).rejects.toThrow('缺少参数 fullClass');
  });
});
