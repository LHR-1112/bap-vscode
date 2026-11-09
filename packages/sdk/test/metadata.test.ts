import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { JsonValue } from '@bap/rpc';
import {
  listMetadataDomains,
  listMetadataFunctions,
  registerMetadataFunction,
  registerMetadataFunctions,
  METADATA_CONNECT_TIMEOUT_MS,
  METADATA_READ_TIMEOUT_MS,
  METADATA_REGISTER_TIMEOUT_MS,
} from '../src/metadata';
import { createBapSdk } from '../src/services';
import { loadDevelop } from '../src/develop';
import type { RpcInvoker } from '../src/types';

// 密码用占位符，避免把真实凭据写进仓库。
const PWD_TOKEN = 'test-pwd-token';

const tmpDirs: string[] = [];
function mkTmp(): string {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'bap-metadata-'));
  tmpDirs.push(p);
  return p;
}
afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

function writeDevelopFile(root: string, extraAttrs = ''): void {
  fs.writeFileSync(
    path.join(root, '.develop'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<Development Project="proj_1" Uri="ws://h:1" AdminTool="bap.client.BapMainFrame" User="root" Password="${PWD_TOKEN}" LocalNioPort="-1"${extraAttrs}/>`,
    'utf8',
  );
}

interface RecordedRequest {
  method: string;
  params: JsonValue[];
  timeoutMs?: number;
}

type MetadataHandler = (op: string, method: string, args: JsonValue[]) => unknown;

/** 假 RpcInvoker：记录 request 调用；connect/disconnect 计数。 */
function makeRpc(handler?: MetadataHandler) {
  const requests: RecordedRequest[] = [];
  const counters = { connects: 0, disconnects: 0 };
  const rpc: RpcInvoker = {
    async connect() {
      counters.connects++;
      return { userCode: 'root' };
    },
    async call() {
      throw new Error('unexpected call()');
    },
    async request(method, params, timeoutMs) {
      requests.push({ method, params, timeoutMs });
      const op = String(params[0] ?? '');
      const name = String(params[1] ?? '');
      const args = Array.isArray(params[2]) ? (params[2] as JsonValue[]) : [];
      const value = handler ? await handler(op, name, args) : null;
      return (value === undefined ? null : value) as JsonValue;
    },
    async disconnect() {
      counters.disconnects++;
    },
    async close() {},
  };
  return { rpc, requests, counters };
}

function makeRpcWithoutRequest(): RpcInvoker {
  return {
    async connect() {
      return { userCode: 'root' };
    },
    async call() {
      throw new Error('unexpected call()');
    },
    async disconnect() {},
    async close() {},
  };
}

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
  } catch (e) {
    expect((e as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`预期抛出 ${code}，但没有抛错`);
}

describe('metadata 协议与超时', () => {
  it('listMetadataDomains 走 metadata/call/listDomains，超时 150s', async () => {
    const { rpc, requests } = makeRpc(() => []);
    const domains = await listMetadataDomains(rpc);
    expect(domains).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('metadata');
    expect(requests[0].params).toEqual(['call', 'listDomains', []]);
    expect(requests[0].timeoutMs).toBe(METADATA_READ_TIMEOUT_MS);
  });

  it('listMetadataDomains 过滤非对象/无 code/非字符串 code 条目', async () => {
    const { rpc } = makeRpc(() => [
      { code: 'D1' },
      null,
      'x',
      [1],
      { code: 123 },
      { code: '   ' },
      { name: 'no code' },
    ]);
    const domains = await listMetadataDomains(rpc);
    expect(domains).toEqual([{ code: 'D1' }]);
  });

  it('listMetadataFunctions 走 metadata/call/listFunctions，超时 150s', async () => {
    const fnMeta = { ruleCode: 'r1', name: 'bar' };
    const { rpc, requests } = makeRpc(() => ({ functions: [fnMeta], functionNames: ['bar'], totalCount: 1 }));
    const result = await listMetadataFunctions(rpc, 'D1');
    expect(result.functions).toEqual([fnMeta]);
    expect(result.totalCount).toBe(1);
    expect(requests[0].params).toEqual(['call', 'listFunctions', ['D1']]);
    expect(requests[0].timeoutMs).toBe(METADATA_READ_TIMEOUT_MS);
  });

  it('registerMetadataFunction 参数与 12 分钟超时', async () => {
    const fnMeta = { ruleCode: 'r1', name: 'bar' };
    const { rpc, requests } = makeRpc(() => ({ success: true, message: 'ok', functions: [fnMeta] }));
    const result = await registerMetadataFunction(rpc, 'D1', 'com.x.Foo', 'bar');
    expect(result.success).toBe(true);
    expect(result.functions).toEqual([fnMeta]);
    expect(requests[0].method).toBe('metadata');
    expect(requests[0].params).toEqual(['call', 'registerFunction', ['D1', 'com.x.Foo', 'bar']]);
    expect(requests[0].timeoutMs).toBe(METADATA_REGISTER_TIMEOUT_MS);
  });

  it('registerMetadataFunctions 参数与 12 分钟超时', async () => {
    const { rpc, requests } = makeRpc(() => ({ success: true, functions: [] }));
    const result = await registerMetadataFunctions(rpc, 'D1', 'com.x.Foo');
    expect(result.success).toBe(true);
    expect(requests[0].params).toEqual(['call', 'registerFunctions', ['D1', 'com.x.Foo']]);
    expect(requests[0].timeoutMs).toBe(METADATA_REGISTER_TIMEOUT_MS);
  });

  it('success:false 原样返回，不抛错', async () => {
    const { rpc } = makeRpc(() => ({ success: false, message: 'domain not allowed' }));
    const result = await registerMetadataFunction(rpc, 'D1', 'com.x.Foo', 'bar');
    expect(result.success).toBe(false);
    expect(result.message).toBe('domain not allowed');
  });
});

describe('metadata 错误映射', () => {
  it('缺少 request 通道 -> METADATA_UNAVAILABLE', async () => {
    await expectCode(listMetadataDomains(makeRpcWithoutRequest()), 'METADATA_UNAVAILABLE');
  });

  it('unknown_method -> METADATA_UNAVAILABLE', async () => {
    const { rpc } = makeRpc(() => {
      throw Object.assign(new Error('unknown_method: 未知方法 metadata'), { code: 'unknown_method' });
    });
    await expectCode(listMetadataDomains(rpc), 'METADATA_UNAVAILABLE');
  });

  it('BRIDGE_CLOSED -> METADATA_UNAVAILABLE', async () => {
    const { rpc } = makeRpc(() => {
      throw Object.assign(new Error('BRIDGE_CLOSED: RPC client has been closed'), { code: 'BRIDGE_CLOSED' });
    });
    await expectCode(registerMetadataFunction(rpc, 'D1', 'com.x.Foo', 'bar'), 'METADATA_UNAVAILABLE');
  });

  it('服务未暴露/未找到 -> METADATA_SERVICE_UNAVAILABLE', async () => {
    const { rpc } = makeRpc(() => {
      throw Object.assign(new Error('RpcException: IPanelMetadataService not found'), { code: 'RpcException' });
    });
    await expectCode(listMetadataDomains(rpc), 'METADATA_SERVICE_UNAVAILABLE');
  });

  it('普通远端业务错误（domain not found）不应误判为服务缺失', async () => {
    const { rpc } = makeRpc(() => {
      throw Object.assign(new Error('domain not found: D9'), { code: 'RemoteException' });
    });
    await expectCode(listMetadataDomains(rpc), 'METADATA_RPC_FAILED');
  });

  it('普通远端异常 -> METADATA_RPC_FAILED，消息保留原异常名', async () => {
    const { rpc } = makeRpc(() => {
      throw Object.assign(new Error('RemoteException: boom'), { code: 'RemoteException' });
    });
    const err = (await listMetadataDomains(rpc).catch((e: unknown) => e)) as {
      code?: string;
      message?: string;
    };
    expect(err.code).toBe('METADATA_RPC_FAILED');
    expect(err.message).toContain('RemoteException');
  });

  it('listDomains 返回非数组 -> METADATA_BAD_RESPONSE', async () => {
    await expectCode(listMetadataDomains(makeRpc(() => ({ domains: [] })).rpc), 'METADATA_BAD_RESPONSE');
    await expectCode(listMetadataDomains(makeRpc(() => 'oops').rpc), 'METADATA_BAD_RESPONSE');
  });

  it('listFunctions 返回非对象/functions 非数组 -> METADATA_BAD_RESPONSE', async () => {
    await expectCode(listMetadataFunctions(makeRpc(() => 'oops').rpc, 'D1'), 'METADATA_BAD_RESPONSE');
    await expectCode(
      listMetadataFunctions(makeRpc(() => ({ functions: {} })).rpc, 'D1'),
      'METADATA_BAD_RESPONSE',
    );
  });

  it('register 返回非对象/success 非 boolean/functions 非数组 -> METADATA_BAD_RESPONSE', async () => {
    await expectCode(registerMetadataFunction(makeRpc(() => []).rpc, 'D1', 'c', 'm'), 'METADATA_BAD_RESPONSE');
    await expectCode(registerMetadataFunction(makeRpc(() => null).rpc, 'D1', 'c', 'm'), 'METADATA_BAD_RESPONSE');
    await expectCode(
      registerMetadataFunction(makeRpc(() => ({ success: 'true' })).rpc, 'D1', 'c', 'm'),
      'METADATA_BAD_RESPONSE',
    );
    await expectCode(
      registerMetadataFunction(makeRpc(() => ({ success: true, functions: {} })).rpc, 'D1', 'c', 'm'),
      'METADATA_BAD_RESPONSE',
    );
  });
});

describe('Sdk.metadata.configuredDomain（只读回退）', () => {
  it('有 .develop 域时直接返回，不发起 RPC，文件不变', () => {
    const root = mkTmp();
    writeDevelopFile(root, ' MetadataDomain="D9"');
    const before = fs.readFileSync(path.join(root, '.develop'), 'utf8');
    const { rpc, requests, counters } = makeRpc();
    const sdk = createBapSdk({ rpc, workspaceRoot: root });

    expect(sdk.metadata.configuredDomain()).toBe('D9');
    expect(requests).toHaveLength(0);
    expect(counters.connects).toBe(0);
    expect(fs.readFileSync(path.join(root, '.develop'), 'utf8')).toBe(before);
  });

  it('.develop 无域/缺失/非法 -> undefined，不抛错', () => {
    const noDomain = mkTmp();
    writeDevelopFile(noDomain);
    const { rpc, requests } = makeRpc();
    expect(createBapSdk({ rpc, workspaceRoot: noDomain }).metadata.configuredDomain()).toBeUndefined();

    const emptyDomain = mkTmp();
    writeDevelopFile(emptyDomain, ' MetadataDomain=""');
    expect(createBapSdk({ rpc, workspaceRoot: emptyDomain }).metadata.configuredDomain()).toBeUndefined();

    const missing = mkTmp();
    expect(createBapSdk({ rpc, workspaceRoot: missing }).metadata.configuredDomain()).toBeUndefined();

    const invalid = mkTmp();
    fs.writeFileSync(path.join(invalid, '.develop'), '<properties><entry key="user">root</entry></properties>');
    expect(createBapSdk({ rpc, workspaceRoot: invalid }).metadata.configuredDomain()).toBeUndefined();

    // 控制字符属于非法域：SDK 只读回退也必须返回 undefined，而不是把非法值交给调用方。
    const control = mkTmp();
    writeDevelopFile(control, ' MetadataDomain="D\u0001"');
    expect(createBapSdk({ rpc, workspaceRoot: control }).metadata.configuredDomain()).toBeUndefined();

    expect(requests).toHaveLength(0);
  });

  it('register 前做域校验：非法域不发起任何 RPC', async () => {
    const root = mkTmp();
    writeDevelopFile(root);
    const { rpc, requests } = makeRpc(() => ({ success: true }));
    const sdk = createBapSdk({ rpc, workspaceRoot: root });
    await expectCode(sdk.metadata.registerFunction('   ', 'com.x.Foo', 'bar'), 'METADATA_DOMAIN_INVALID');
    await expectCode(sdk.metadata.registerFunctions('D\u0000', 'com.x.Foo'), 'METADATA_DOMAIN_INVALID');
    expect(requests).toHaveLength(0);
  });
});

describe('日志与密码', () => {
  it('listDomains/registerFunction 日志不包含密码', async () => {
    const root = mkTmp();
    writeDevelopFile(root);
    const logs: string[] = [];
    const { rpc } = makeRpc((op, method) => {
      if (op === 'connect') return {};
      if (op === 'call' && method === 'listDomains') return [{ code: 'D1' }];
      if (op === 'call' && method === 'registerFunction') return { success: true, functions: [] };
      throw new Error(`unexpected ${op}/${method}`);
    });
    const sdk = createBapSdk({ rpc, workspaceRoot: root, onLog: (m) => logs.push(m) });

    await sdk.metadata.listDomains();
    await sdk.metadata.registerFunction('D1', 'com.x.Foo', 'bar');

    const all = logs.join('\n');
    expect(all).toContain('metadata.listDomains');
    expect(all).toContain('metadata.registerFunction');
    expect(all).not.toContain(PWD_TOKEN);
  });
});

describe('域缓存与连接生命周期', () => {
  it('TTL 内复用缓存；refresh:true 强制重查', async () => {
    const root = mkTmp();
    writeDevelopFile(root);
    const { rpc, requests, counters } = makeRpc((op, method) => {
      if (op === 'connect') return {};
      if (op === 'call' && method === 'listDomains') return [{ code: 'D1', name: 'Domain 1' }];
      throw new Error(`unexpected ${op}/${method}`);
    });
    const sdk = createBapSdk({ rpc, workspaceRoot: root });

    const first = await sdk.metadata.listDomains();
    expect(first).toEqual([{ code: 'D1', name: 'Domain 1' }]);
    expect(requests).toHaveLength(2);
    expect(requests[0].method).toBe('metadata');
    expect(requests[0].params).toEqual(['connect', 'ws://h:1', 'root', PWD_TOKEN]);
    expect(requests[0].timeoutMs).toBe(METADATA_CONNECT_TIMEOUT_MS);
    expect(requests[1].params).toEqual(['call', 'listDomains', []]);

    const second = await sdk.metadata.listDomains();
    expect(second).toBe(first);
    expect(requests).toHaveLength(2); // TTL 内命中缓存，不重复 RPC
    expect(counters.connects).toBe(1);

    await sdk.metadata.listDomains({ refresh: true });
    expect(requests).toHaveLength(3); // refresh 强制重查；metadata 连接仍复用
    expect(requests[2].params).toEqual(['call', 'listDomains', []]);
    expect(counters.connects).toBe(1);
  });

  it('缓存超过 TTL 后重新拉取（仍复用 metadata 连接）', async () => {
    const root = mkTmp();
    writeDevelopFile(root);
    const { rpc, requests } = makeRpc((op, method) => {
      if (op === 'connect') return {};
      if (op === 'call' && method === 'listDomains') return [];
      throw new Error(`unexpected ${op}/${method}`);
    });
    const sdk = createBapSdk({ rpc, workspaceRoot: root });
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      await sdk.metadata.listDomains();
      await sdk.metadata.listDomains();
      expect(requests).toHaveLength(2);

      spy.mockReturnValue(now + 61_000);
      await sdk.metadata.listDomains();
      expect(requests).toHaveLength(3); // 过期后重新 listDomains，但不重新 connect
    } finally {
      spy.mockRestore();
    }
  });

  it('redirect.apply 后缓存失效；.develop 的既有 MetadataDomain 保留', async () => {
    const root = mkTmp();
    writeDevelopFile(root, ' MetadataDomain="KEEP"');
    const { rpc, requests, counters } = makeRpc((op, method) => {
      if (op === 'connect') return {};
      if (op === 'call' && method === 'listDomains') return [{ code: 'D1' }];
      throw new Error(`unexpected ${op}/${method}`);
    });
    const sdk = createBapSdk({ rpc, workspaceRoot: root });

    await sdk.metadata.listDomains();
    expect(requests).toHaveLength(2);

    await sdk.redirect.apply({
      uri: 'ws://h:2',
      user: 'root',
      pwd: 'new-pwd-token',
      projectUuid: 'proj_2',
      projectName: 'P2',
    });

    // 缓存已失效：重新 connect + listDomains，而不是命中 redirect 前的缓存。
    await sdk.metadata.listDomains();
    expect(requests).toHaveLength(4);
    expect(counters.connects).toBe(2);
    expect(requests[2].params).toEqual(['connect', 'ws://h:2', 'root', 'new-pwd-token']);

    const cfg = loadDevelop(root);
    expect(cfg.projectUuid).toBe('proj_2');
    expect(cfg.uri).toBe('ws://h:2');
    expect(cfg.metadataDomain).toBe('KEEP');
    expect(sdk.metadata.configuredDomain()).toBe('KEEP');
  });

  it('disconnect 后缓存失效（下次调用重新 connect）', async () => {
    const root = mkTmp();
    writeDevelopFile(root);
    const { rpc, requests, counters } = makeRpc((op, method) => {
      if (op === 'connect') return {};
      if (op === 'call' && method === 'listDomains') return [{ code: 'D1' }];
      throw new Error(`unexpected ${op}/${method}`);
    });
    const sdk = createBapSdk({ rpc, workspaceRoot: root });

    await sdk.metadata.listDomains();
    expect(requests).toHaveLength(2);

    await sdk.disconnect();
    await sdk.metadata.listDomains();
    expect(requests).toHaveLength(4);
    expect(counters.connects).toBe(2);
    expect(counters.disconnects).toBe(1);
  });

  it('metadata.connect 期间 disconnect -> CONNECTION_SUPERSEDED，不把旧连接标记为当前', async () => {
    const root = mkTmp();
    writeDevelopFile(root);
    let releaseMetadataConnect!: (value: unknown) => void;
    const gate = new Promise<unknown>((resolve) => {
      releaseMetadataConnect = resolve;
    });
    const { rpc, requests } = makeRpc((op, method) => {
      if (op === 'connect') return gate;
      if (op === 'call' && method === 'listDomains') return [{ code: 'D1' }];
      throw new Error(`unexpected ${op}/${method}`);
    });
    const sdk = createBapSdk({ rpc, workspaceRoot: root });

    const pending = sdk.metadata.listDomains().catch((e: unknown) => e);
    await vi.waitFor(() => {
      expect(
        requests.some((r) => r.method === 'metadata' && r.params[0] === 'connect'),
      ).toBe(true);
    });
    await sdk.disconnect();
    releaseMetadataConnect(true);

    const err = (await pending) as { code?: string };
    expect(err.code).toBe('CONNECTION_SUPERSEDED');

    // 之后仍能重新建立 metadata 连接（没有被错误地当成已连接）。
    const domains = await sdk.metadata.listDomains();
    expect(domains).toEqual([{ code: 'D1' }]);
    const connectCount = requests.filter(
      (r) => r.method === 'metadata' && r.params[0] === 'connect',
    ).length;
    expect(connectCount).toBe(2);
  });

  it('listDomains 在途结果在 disconnect 后不写回缓存', async () => {
    const root = mkTmp();
    writeDevelopFile(root);
    let releaseList!: (value: unknown) => void;
    const gate = new Promise<unknown>((resolve) => {
      releaseList = resolve;
    });
    let listCalls = 0;
    const { rpc, requests } = makeRpc((op, method) => {
      if (op === 'connect') return {};
      if (op === 'call' && method === 'listDomains') {
        listCalls++;
        return listCalls === 1 ? gate : [{ code: 'NEW' }];
      }
      throw new Error(`unexpected ${op}/${method}`);
    });
    const sdk = createBapSdk({ rpc, workspaceRoot: root });

    const pending = sdk.metadata.listDomains().catch((e: unknown) => e);
    await vi.waitFor(() => {
      expect(requests.some((r) => r.params[0] === 'call' && r.params[1] === 'listDomains')).toBe(true);
    });
    await sdk.disconnect();
    releaseList([{ code: 'OLD' }]);

    const err = (await pending) as { code?: string };
    expect(err.code).toBe('CONNECTION_SUPERSEDED');

    const domains = await sdk.metadata.listDomains();
    expect(domains).toEqual([{ code: 'NEW' }]);
    const connectCount = requests.filter(
      (r) => r.method === 'metadata' && r.params[0] === 'connect',
    ).length;
    expect(connectCount).toBe(2);
  });
});
