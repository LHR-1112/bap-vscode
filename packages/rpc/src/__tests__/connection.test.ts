import { describe, it, expect, afterEach } from 'vitest';
import * as net from 'net';
import * as http from 'http';
import * as crypto from 'crypto';
import { RpcConnection } from '../connection/connection';
import { ConnectionState } from '../connection/types';
import { ConnectTimeoutError } from '../connection/errors';
import { createMockWsServer, MockWsServer } from './helpers/mock-ws-server';

interface RawServer {
  server: net.Server | http.Server;
  sockets: Set<net.Socket>;
}

const servers: MockWsServer[] = [];
const rawServers: RawServer[] = [];
const connections: RpcConnection[] = [];

afterEach(async () => {
  for (const c of connections) c.close();
  connections.length = 0;
  for (const s of servers) await s.close();
  servers.length = 0;
  for (const r of rawServers) {
    for (const sock of Array.from(r.sockets)) sock.destroy();
    await new Promise<void>((res) => r.server.close(() => res()));
  }
  rawServers.length = 0;
});

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** 接受 TCP 但从不完成 WS 握手的裸 server，用于测试 connect 超时。 */
function createHoldServer(): Promise<{ url: string }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      rawServers.push({ server, sockets });
      const port = (server.address() as net.AddressInfo).port;
      resolve({ url: `ws://127.0.0.1:${port}` });
    });
  });
}

/** 完成 WS 握手但从不回 pong 的裸 server，用于模拟「心跳无 pong」场景。 */
function createNoPongWsServer(): Promise<{ url: string }> {
  const sockets = new Set<net.Socket>();
  const server = http.createServer();
  server.on('upgrade', (req, socket) => {
    const sock = socket as net.Socket;
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      sock.destroy();
      return;
    }
    const accept = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    sock.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    // 保持 socket 打开，不响应 ping。
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      rawServers.push({ server, sockets });
      const port = (server.address() as net.AddressInfo).port;
      resolve({ url: `ws://127.0.0.1:${port}` });
    });
  });
}

describe('RpcConnection', () => {
  it('connects successfully', async () => {
    const server = await createMockWsServer();
    servers.push(server);
    const conn = new RpcConnection({ url: server.url, reconnect: false });
    connections.push(conn);
    let connectEvents = 0;
    conn.on('connect', () => connectEvents++);

    await conn.connect();

    expect(conn.state).toBe(ConnectionState.Connected);
    expect(conn.isConnected).toBe(true);
    expect(connectEvents).toBe(1);
  });

  it('sends and receives binary messages intact', async () => {
    const server = await createMockWsServer();
    servers.push(server);
    const conn = new RpcConnection({ url: server.url, reconnect: false });
    connections.push(conn);
    const messages: Buffer[] = [];
    conn.on('message', (m) => messages.push(m));
    await conn.connect();

    const payload = Buffer.from([0x4c, 0x56, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 0, 1, 0xaa, 0xbb, 0xcc]);
    expect(conn.send(payload)).toBe(true);
    await waitFor(() => messages.length === 1);
    expect(messages[0].equals(payload)).toBe(true);
  });

  it('rejects with ConnectTimeoutError when handshake never completes', async () => {
    const hold = await createHoldServer();
    const conn = new RpcConnection({ url: hold.url, reconnect: false, connectTimeoutMs: 200 });
    connections.push(conn);

    await expect(conn.connect()).rejects.toBeInstanceOf(ConnectTimeoutError);
    expect(conn.state).toBe(ConnectionState.Closed);
  });

  it('sends pings to keep the connection alive', async () => {
    const server = await createMockWsServer();
    servers.push(server);
    const conn = new RpcConnection({
      url: server.url,
      reconnect: false,
      heartbeatIntervalMs: 50,
      heartbeatTimeoutMs: 20,
    });
    connections.push(conn);
    await conn.connect();

    await waitFor(() => server.pingCount >= 1);
    expect(conn.state).toBe(ConnectionState.Connected);
  });

  it('reconnects after heartbeat timeout', async () => {
    const server = await createNoPongWsServer();
    const conn = new RpcConnection({
      url: server.url,
      heartbeatIntervalMs: 50,
      heartbeatTimeoutMs: 20,
      reconnectInitialDelayMs: 50,
      reconnectMaxDelayMs: 50,
      reconnectJitter: false,
    });
    connections.push(conn);
    await conn.connect();

    await waitFor(() => conn.state === ConnectionState.Reconnecting);
    await waitFor(() => conn.state === ConnectionState.Connected);
  });

  it('does not reconnect after manual close', async () => {
    const server = await createMockWsServer();
    servers.push(server);
    const conn = new RpcConnection({
      url: server.url,
      reconnectInitialDelayMs: 10,
      reconnectMaxDelayMs: 10,
      reconnectJitter: false,
    });
    connections.push(conn);
    await conn.connect();
    let closeEvents = 0;
    conn.on('close', () => closeEvents++);

    conn.close();
    await waitFor(() => closeEvents === 1);
    expect(conn.state).toBe(ConnectionState.Closed);

    // 给退避重连留时间，断言确实不再重连。
    await new Promise((r) => setTimeout(r, 100));
    expect(conn.state).toBe(ConnectionState.Closed);
  });

  it('isolates multiple connections', async () => {
    const s1 = await createMockWsServer();
    const s2 = await createMockWsServer();
    servers.push(s1, s2);
    const c1 = new RpcConnection({ url: s1.url, reconnect: false });
    const c2 = new RpcConnection({ url: s2.url, reconnect: false });
    connections.push(c1, c2);

    await c1.connect();
    await c2.connect();
    expect(c1.state).toBe(ConnectionState.Connected);
    expect(c2.state).toBe(ConnectionState.Connected);

    c1.close();
    await waitFor(() => c1.state === ConnectionState.Closed);
    expect(c2.state).toBe(ConnectionState.Connected);
  });
});
