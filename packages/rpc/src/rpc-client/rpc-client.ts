import { RpcConnection } from '../connection/connection';
import { ConnectionState as State } from '../connection/types';
import { RpcRequest, RpcPing, RpcResponse, RpcCallbackResponse, RpcCallbackReq } from '../codec/messages';
import { encode, decode } from '../codec/codec';
import type { RpcFrame } from '../codec/codec';
import { deserializeBody } from '../serializer/serializer';
import { TypedEmitter } from '../connection/emitter';
import { PendingRegistry } from './pending';
import { CallbackRegistry } from './callback';
import { CRpcError, CRpcTimeoutException, CRpcNotConnectedError } from './errors';
import { setGlobalContext as setCtx, getGlobalContext, cloneContext } from './context';
import type {
  RpcClientOptions,
  InvokeOptions,
  CallbackHandler,
  RpcClientEventMap,
} from './types';

export { setCtx as setGlobalContext };

// 静态 URI 缓存：同一 url 复用同一连接。
const CONN_CACHE = new Map<string, Promise<RpcConnection>>();

export class RpcClient extends TypedEmitter<RpcClientEventMap> {
  private _conn: RpcConnection;
  private _owns: boolean;
  private _pending = new PendingRegistry();
  private _callbacks = new CallbackRegistry();
  private _defaultTimeoutMs: number;
  private _tempTimeoutMs?: number;

  constructor(options: RpcClientOptions) {
    super();
    if (options.connection) {
      this._conn = options.connection;
      this._owns = options.ownsConnection ?? false;
    } else if (options.url) {
      this._conn = new RpcConnection({ url: options.url, ...options.connectionOptions });
      this._owns = true;
    } else {
      throw new Error('RpcClient requires connection or url');
    }
    this._defaultTimeoutMs = options.defaultTimeoutMs ?? 120_000;

    this._conn.on('message', (buf) => this._dispatch(buf));
    this._conn.on('close', () => this._onDisconnect());
    this._conn.on('error', (err) => this.emit('error', err as never));
  }

  // —— 生命周期 ——

  get connection(): RpcConnection {
    return this._conn;
  }

  get isConnected(): boolean {
    return this._conn.isConnected;
  }

  async connect(): Promise<void> {
    return this._conn.connect();
  }

  close(): void {
    this._failAllPending(new CRpcNotConnectedError());
    if (this._owns) this._conn.close();
  }

  // —— 调用 ——

  async invoke<T = unknown>(
    className: string,
    method: string,
    params?: unknown[],
    opts?: InvokeOptions,
  ): Promise<T> {
    await this._ensureReady();

    const req = new RpcRequest(className, method, ...(params ?? []));
    req.context = cloneContext(getGlobalContext());
    const reqID = opts?.reqID ?? req.reqID;
    req.setReqID(reqID);

    const timeoutMs = opts?.timeoutMs ?? this._consumeTempTimeout() ?? this._defaultTimeoutMs;
    const frame = encode(req);

    return new Promise<T>((resolve, reject) => {
      // 先注册 waiter 再 send，避免快速响应在注册前到达被丢弃。
      const entry = { resolve: resolve as (v: unknown) => void, reject, startedAt: Date.now() };
      this._pending.add(reqID, entry);

      const ok = this._conn.send(frame);
      if (!ok) {
        this._pending.remove(reqID);
        reject(new CRpcNotConnectedError());
        return;
      }

      const timer = setTimeout(() => {
        const e = this._pending.remove(reqID);
        if (e) e.reject(new CRpcTimeoutException(reqID, timeoutMs));
      }, timeoutMs);
      this._pending.setTimer(reqID, timer);
    });
  }

  // —— context ——

  setGlobalContext(key: string, value: unknown): void {
    setCtx(key, value);
  }

  // —— timeout ——

  setTempTimeout(ms: number | undefined): void {
    this._tempTimeoutMs = ms;
  }

  // —— callback ——

  registerCallback(uuid: string, handler: CallbackHandler): void {
    this._callbacks.register(uuid, handler);
  }

  unregisterCallback(uuid: string): boolean {
    return this._callbacks.unregister(uuid);
  }

  /** 客户端主动调用一个服务端回调（基础版）。 */
  invokeCallback(uuid: string, method: string, params?: unknown[]): Promise<unknown> {
    return this._invokeCallback(uuid, method, params ?? []);
  }

  // —— 内部：派发 ——

  private _dispatch(buf: Buffer): void {
    let frame: RpcFrame;
    try {
      frame = decode(buf);
      if (frame.header.type >= 100) {
        // 二进制类型（非消息对象），本期不处理。
        return;
      }
    } catch (err) {
      this.emit('error', err as never);
      return;
    }
    this.emit('message', frame);

    const msg = deserializeBody(frame.body);
    if (msg instanceof RpcCallbackResponse) return this._onCallbackRsp(msg);
    if (msg instanceof RpcResponse) return this._onResponse(msg);
    if (msg instanceof RpcCallbackReq) return this._onCallbackReq(msg);
    // RpcRequest / RpcPing（服务端主动请求 / ping）—— 仅记录，不处理。
  }

  private _onResponse(rsp: RpcResponse): void {
    const entry = this._pending.remove(rsp.reqID);
    if (!entry) return; // 乱序/迟到/已超时
    if (entry.timer) clearTimeout(entry.timer);
    if (rsp.err != null) entry.reject(new CRpcError(rsp.err));
    else entry.resolve(rsp.result);
  }

  private _onCallbackRsp(rsp: RpcCallbackResponse): void {
    const entry = this._pending.remove(rsp.reqID);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    if (rsp.err != null) entry.reject(new CRpcError(rsp.err));
    else entry.resolve(rsp.result);
  }

  private _onCallbackReq(req: RpcCallbackReq): void {
    const handler = this._callbacks.get(req.callbackUuid ?? '');
    let result: unknown = null;
    let err: unknown = null;
    if (handler) {
      try {
        result = handler(req.params, req.context);
      } catch (e) {
        err = e;
      }
    } else {
      err = new CRpcError(`no callback handler for uuid ${req.callbackUuid}`);
    }
    const resp = new RpcCallbackResponse()
      .setReqID(req.reqID)
      .setResult(result);
    if (err != null) resp.setError(err);
    this._conn.send(encode(resp));
  }

  private async _invokeCallback(uuid: string, method: string, params: unknown[]): Promise<unknown> {
    await this._ensureReady();
    const cb = new RpcCallbackReq(uuid, method, ...params);
    cb.context = cloneContext(getGlobalContext());
    const frame = encode(cb);
    return new Promise<unknown>((resolve, reject) => {
      const reqID = cb.reqID;
      const entry = { resolve, reject, startedAt: Date.now() };
      this._pending.add(reqID, entry);
      if (!this._conn.send(frame)) {
        this._pending.remove(reqID);
        reject(new CRpcNotConnectedError());
        return;
      }
      const timer = setTimeout(() => {
        const e = this._pending.remove(reqID);
        if (e) e.reject(new CRpcTimeoutException(reqID, this._defaultTimeoutMs));
      }, this._defaultTimeoutMs);
      this._pending.setTimer(reqID, timer);
    });
  }

  private _onDisconnect(): void {
    this.emit('disconnect');
    this._failAllPending(new CRpcNotConnectedError());
  }

  private _failAllPending(err: unknown): void {
    this._pending.failAll(err);
  }

  private _consumeTempTimeout(): number | undefined {
    const v = this._tempTimeoutMs;
    this._tempTimeoutMs = undefined;
    return v;
  }

  /** 等到连接就绪：isConnected 直接用；Closed reject；Connecting/Reconnecting 等待 connect 事件。 */
  private _ensureReady(): Promise<void> {
    if (this._conn.isConnected) return Promise.resolve();
    if (this._conn.state === State.Closed) return Promise.reject(new CRpcNotConnectedError());
    return new Promise<void>((resolve, reject) => {
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new CRpcNotConnectedError());
      };
      const onError = (e: unknown) => {
        cleanup();
        reject(e);
      };
      const cleanup = () => {
        this._conn.off('connect', onConnect);
        this._conn.off('close', onClose);
        this._conn.off('error', onError);
      };
      this._conn.once('connect', onConnect);
      this._conn.once('close', onClose);
      this._conn.once('error', onError);
    });
  }
}
