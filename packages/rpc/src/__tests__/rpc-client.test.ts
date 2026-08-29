import { describe, it, expect, afterEach } from 'vitest';
import { RpcClient, setGlobalContext, clearGlobalContext } from '../rpc-client';
import { RpcConnection } from '../connection/connection';
import { CRpcError, CRpcTimeoutException, CRpcNotConnectedError } from '../rpc-client/errors';
import { RpcRequest, RpcCallbackReq } from '../codec';
import { createMockRpcServer, MockRpcServer } from './helpers/mock-rpc-server';

const servers: MockRpcServer[] = [];
const clients: RpcClient[] = [];

afterEach(async () => {
  clearGlobalContext();
  for (const c of clients) c.close();
  clients.length = 0;
  for (const s of servers) await s.close();
  servers.length = 0;
});

async function makePair(): Promise<{ server: MockRpcServer; client: RpcClient }> {
  const server = await createMockRpcServer();
  servers.push(server);
  const conn = new RpcConnection({ url: server.url, reconnect: false });
  await conn.connect();
  const client = new RpcClient({ connection: conn, defaultTimeoutMs: 2000 });
  clients.push(client);
  return { server, client };
}

describe('RpcClient', () => {
  it('invokes and resolves the result', async () => {
    const { server, client } = await makePair();
    server.reply = { result: 42 };
    const out = await client.invoke('bap.java.CJavaCenterIntf', 'getNumber', [1, 2]);
    expect(out).toBe(42);
    const req = server.lastRequest as RpcRequest;
    expect(req.className).toBe('bap.java.CJavaCenterIntf');
    expect(req.function).toBe('getNumber');
    expect(req.params).toEqual([1, 2]);
  });

  it('rejects with CRpcError when server err is non-null', async () => {
    const { server, client } = await makePair();
    server.reply = { result: null, err: 'boom' };
    await expect(client.invoke('X', 'f')).rejects.toBeInstanceOf(CRpcError);
    await expect(client.invoke('X', 'f')).rejects.toMatchObject({ code: 'CRPC_REMOTE' });
  });

  it('times out and cleans up pending', async () => {
    const { client } = await makePair();
    // 不回复（reply null 默认）→ 超时
    const p = client.invoke('X', 'f', [], { timeoutMs: 30 });
    await expect(p).rejects.toBeInstanceOf(CRpcTimeoutException);
  });

  it('injects global context into request.context', async () => {
    const { server, client } = await makePair();
    setGlobalContext('CTX_SESSION', 'abc');
    server.reply = { result: true };
    await client.invoke('X', 'f');
    const req = server.lastRequest as RpcRequest;
    expect(req.context).not.toBeNull();
    expect(req.context?.get('CTX_SESSION')).toBe('abc');
  });

  it('consumes temp timeout one-shot', async () => {
    const { client } = await makePair();
    client.setTempTimeout(30);
    // 第一次：temp=30 不回复 → 超时
    await expect(client.invoke('X', 'f', [], { timeoutMs: 30 })).rejects.toBeInstanceOf(CRpcTimeoutException);
  });

  it('dispatches inbound CALLBACK_REQ and replies with CALLBACK_RSP', async () => {
    const { server, client } = await makePair();
    let called = false;
    let result = 0;
    client.registerCallback('uuid', (params) => {
      called = true;
      result = (params?.[0] as number) * 2;
      return result;
    });
    // 服务端主动向客户端发起回调
    server.sendCallbackReq(new RpcCallbackReq('uuid', 'f', 21));
    await new Promise((r) => setTimeout(r, 80));
    expect(called).toBe(true);
    expect(result).toBe(42);
  });

  it('rejects pending invokes on disconnect', async () => {
    const { server, client } = await makePair();
    // 不回复使 invoke 挂起
    const p = client.invoke('X', 'f', [], { timeoutMs: 5000 });
    server.closeClients(1011);
    await expect(p).rejects.toBeInstanceOf(CRpcNotConnectedError);
  });

  it('supports concurrent invokes independently', async () => {
    const { client } = await makePair();
    const p1 = client.invoke('X', 'a', [], { timeoutMs: 30 });
    const p2 = client.invoke('X', 'b', [], { timeoutMs: 30 });
    await expect(p1).rejects.toBeInstanceOf(CRpcTimeoutException);
    await expect(p2).rejects.toBeInstanceOf(CRpcTimeoutException);
  });
});
