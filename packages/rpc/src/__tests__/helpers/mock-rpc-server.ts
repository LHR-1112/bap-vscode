import { WebSocketServer, WebSocket } from 'ws';
import type { AddressInfo } from 'net';
import { decodeMessage, encode, RpcResponse, RpcCallbackReq, RpcRequest } from '../../codec';
import type { RpcResponse as RpcResponseType } from '../../codec/messages';

export interface MockRpcServer {
  url: string;
  /** 收到的所有入站消息。 */
  received: Array<RpcRequest | RpcCallbackReq>;
  /** 最后收到的入站消息。 */
  lastRequest: RpcRequest | RpcCallbackReq | null;
  /** 配置下一个请求如何回复：自动回 RpcResponse(result)；
   *  传 true 且 err 设置则回 err；传 null 则不回复（用于超时）。 */
  reply: { result: unknown; err?: unknown } | null;
  /** 主动向客户端发一个 CALLBACK_REQ。 */
  sendCallbackReq(req: RpcCallbackReq): void;
  /** 主动向客户端发任意消息。 */
  send(msg: RpcResponseType): void;
  closeClients(code?: number): void;
  close(): Promise<void>;
}

/** 起一个能解码 RPC 消息并可配置回复的 mock server。 */
export function createMockRpcServer(): Promise<MockRpcServer> {
  const wss = new WebSocketServer({ port: 0 });
  const clients = new Set<WebSocket>();
  const received: Array<RpcRequest | RpcCallbackReq> = [];

  const mock: MockRpcServer = {
    url: '',
    received,
    lastRequest: null,
    reply: null,
    sendCallbackReq(req) {
      for (const c of clients) c.send(encode(req));
    },
    send(msg) {
      for (const c of clients) c.send(encode(msg));
    },
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
      let msg: unknown;
      try {
        msg = decodeMessage(buf);
      } catch {
        return;
      }
      if (msg instanceof RpcCallbackReq || (msg as { className?: unknown }).className !== undefined) {
        const m = msg as RpcRequest | RpcCallbackReq;
        received.push(m);
        mock.lastRequest = m;
      }
      if (msg instanceof RpcRequest && mock.reply) {
        const resp = new RpcResponse().setReqID(msg.reqID);
        if (mock.reply.err !== undefined && mock.reply.err !== null) resp.setError(mock.reply.err);
        else resp.setResult(mock.reply.result);
        socket.send(encode(resp));
      }
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
