// bootstrap 服务器探测：参数校验、连接生命周期、密码不泄漏（P1-8）。
import { describe, it, expect } from 'vitest';
import type { BridgeLaunchConfig } from '@bap/rpc';
import { probeServerProjects, type ProbeConnection } from '../src/projects/server-probe';

const LAUNCH = {} as BridgeLaunchConfig;
const CONN: ProbeConnection = { uri: 'ws://h:1', user: 'root', pwd: 'secret' };

function fakeRpc(over: { list?: unknown; callError?: Error; closeError?: Error } = {}) {
  const calls = { connect: 0, callArg: '', close: 0 };
  return {
    calls,
    rpc: {
      async connect(uri: string, user: string, pwd: string) {
        calls.connect++;
        expect(uri).toBe('ws://h:1');
        expect(user).toBe('root');
        expect(pwd).toBe('secret');
      },
      async call(method: string) {
        calls.callArg = method;
        if (over.callError) throw over.callError;
        return over.list ?? [{ uuid: 'u1', name: 'P1' }];
      },
      async close() {
        calls.close++;
        if (over.closeError) throw over.closeError;
      },
    },
  };
}

describe('probeServerProjects', () => {
  it('uri/user/pwd 必须同时提供，缺失时不创建 RPC', async () => {
    let created = 0;
    const createRpc = () => {
      created++;
      return fakeRpc().rpc;
    };
    await expect(
      probeServerProjects(LAUNCH, { uri: 'ws://h:1', user: 'root', pwd: '' }, { createRpc }),
    ).rejects.toThrow(/同时提供/);
    expect(created).toBe(0);
  });

  it('成功：调用 getAllProjects 并关闭连接', async () => {
    const { rpc, calls } = fakeRpc();
    const list = await probeServerProjects(LAUNCH, CONN, { createRpc: () => rpc });
    expect(list).toEqual([{ uuid: 'u1', name: 'P1' }]);
    expect(calls).toMatchObject({ connect: 1, callArg: 'getAllProjects', close: 1 });
  });

  it('uri/user 会 trim，密码原样传递', async () => {
    const { rpc } = fakeRpc();
    let seen: { uri?: string; user?: string; pwd?: string } = {};
    rpc.connect = async (uri, user, pwd) => {
      seen = { uri, user, pwd };
    };
    await probeServerProjects(LAUNCH, { uri: '  ws://h:1  ', user: ' root ', pwd: ' p ' }, { createRpc: () => rpc });
    expect(seen).toEqual({ uri: 'ws://h:1', user: 'root', pwd: ' p ' });
  });

  it('调用失败也会关闭连接，且错误不含密码', async () => {
    const { rpc, calls } = fakeRpc({ callError: new Error('网络断开') });
    const p = probeServerProjects(LAUNCH, CONN, { createRpc: () => rpc });
    await expect(p).rejects.toThrow('网络断开');
    await expect(p).rejects.not.toThrow('secret');
    expect(calls.close).toBe(1);
  });

  it('close 失败被忽略，不覆盖原始结果', async () => {
    const { rpc } = fakeRpc({ closeError: new Error('close boom') });
    await expect(probeServerProjects(LAUNCH, CONN, { createRpc: () => rpc })).resolves.toEqual([
      { uuid: 'u1', name: 'P1' },
    ]);
  });

  it('非数组结果 → 空列表', async () => {
    const { rpc } = fakeRpc({ list: { nope: true } });
    await expect(probeServerProjects(LAUNCH, CONN, { createRpc: () => rpc })).resolves.toEqual([]);
  });
});
