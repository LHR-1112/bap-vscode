import { WebSocketServer, WebSocket } from 'ws';
import type { AddressInfo } from 'net';

export interface MockWsServer {
  url: string;
  received: Buffer[];
  pingCount: number;
  respondToPing: boolean;
  echo: boolean;
  closeClients(code?: number): void;
  close(): Promise<void>;
}

/** 起一个随机端口的 ws mock server，用于离线集成测试。 */
export function createMockWsServer(opts?: {
  respondToPing?: boolean;
  echo?: boolean;
}): Promise<MockWsServer> {
  const wss = new WebSocketServer({ port: 0 });
  const clients = new Set<WebSocket>();

  const mock: MockWsServer = {
    url: '',
    received: [],
    pingCount: 0,
    respondToPing: opts?.respondToPing ?? true,
    echo: opts?.echo ?? true,
    closeClients(code = 1000) {
      for (const c of Array.from(clients)) {
        try {
          c.close(code);
        } catch {
          /* ignore */
        }
      }
    },
    close() {
      for (const c of Array.from(clients)) {
        try {
          c.terminate();
        } catch {
          /* ignore */
        }
      }
      return new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };

  wss.on('connection', (socket) => {
    clients.add(socket);
    socket.on('message', (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      mock.received.push(buf);
      if (mock.echo) socket.send(buf);
    });
    socket.on('ping', () => {
      mock.pingCount += 1;
      if (mock.respondToPing) socket.pong();
    });
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => {
      /* ignore */
    });
  });

  return new Promise((resolve, reject) => {
    wss.on('listening', () => {
      const addr = wss.address() as AddressInfo;
      mock.url = `ws://127.0.0.1:${addr.port}`;
      resolve(mock);
    });
    wss.on('error', reject);
  });
}
