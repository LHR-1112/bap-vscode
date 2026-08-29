import WebSocket from 'ws';
import { TypedEmitter } from './emitter';
import { normalizeOptions } from './defaults';
import { Backoff } from './backoff';
import { HeartbeatManager } from './heartbeat';
import { ConnectionError, ConnectTimeoutError, HeartbeatTimeoutError } from './errors';
import { ConnectionState as State } from './types';
import type {
  CloseInfo,
  ConnectionEventMap,
  ConnectionOptions,
  ResolvedConnectionOptions,
} from './types';

/** 发送背压阈值：bufferedAmount 超过该值视为拥塞，send() 返回 false。 */
const MAX_BUFFERED_AMOUNT = 16 * 1024 * 1024;

export class RpcConnection extends TypedEmitter<ConnectionEventMap> {
  private _state: State = State.Idle;
  private readonly _options: ResolvedConnectionOptions;
  private _ws: WebSocket | null = null;
  private _heartbeat: HeartbeatManager | null = null;
  private readonly _backoff: Backoff;

  private _connectTimer?: NodeJS.Timeout;
  private _reconnectTimer?: NodeJS.Timeout;
  private _manualClose = false;
  private _connectPromise: Promise<void> | null = null;
  private _resolveConnect?: () => void;
  private _rejectConnect?: (err: Error) => void;
  private _lastError?: ConnectionError;
  private _connectTimedOut = false;

  constructor(options?: ConnectionOptions) {
    super();
    this._options = normalizeOptions(options);
    this._backoff = new Backoff({
      initialMs: this._options.reconnectInitialDelayMs,
      maxMs: this._options.reconnectMaxDelayMs,
      factor: this._options.reconnectFactor,
      jitter: this._options.reconnectJitter,
    });
  }

  get state(): State {
    return this._state;
  }

  get isConnected(): boolean {
    return this._state === State.Connected;
  }

  get options(): Readonly<ResolvedConnectionOptions> {
    return this._options;
  }

  get remoteAddress(): string {
    if (this._state === State.Connected && this._ws) {
      const socket = (this._ws as unknown as { _socket?: { remoteAddress?: string } })._socket;
      return socket?.remoteAddress ?? '';
    }
    return '';
  }

  /** 建立连接。首次进入 Connected 时 resolve；终态（耗尽/主动 close）时 reject。 */
  connect(): Promise<void> {
    if (this._state === State.Connected) return Promise.resolve();
    if (this._connectPromise) return this._connectPromise;

    if (this._state === State.Closed) {
      // 允许从 Closed 复位重新开始。
      this._manualClose = false;
      this._lastError = undefined;
      this._backoff.reset();
      this._setState(State.Idle);
    }

    this._manualClose = false;
    this._lastError = undefined;
    this._connectPromise = new Promise<void>((resolve, reject) => {
      this._resolveConnect = resolve;
      this._rejectConnect = reject;
    });
    this._open();
    return this._connectPromise;
  }

  /** 主动关闭。终止重连，进入 Closed（幂等）。 */
  close(code = 1000, reason = 'client close'): void {
    if (this._state === State.Closed) return;
    this._manualClose = true;
    this._clearReconnectTimer();
    this._clearConnectTimer();
    this._stopHeartbeat();

    const ws = this._ws;
    if (ws) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(code, reason);
      } else {
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
      }
    } else {
      // 无底层 socket（Idle 或已清理）——直接终态。
      this._failPending(new ConnectionError('connection closed by user', 'CLOSED'));
      this._setState(State.Closed);
    }
  }

  /** 发送二进制消息。仅 Connected 可发；返回是否已入队（false 表示未连接或拥塞）。 */
  send(data: Buffer): boolean {
    if (!this._ws || this._state !== State.Connected) return false;
    if (this._ws.bufferedAmount > MAX_BUFFERED_AMOUNT) return false;
    this._ws.send(data);
    return true;
  }

  // ---- 内部：建立连接 ----

  private _open(): void {
    this._clearConnectTimer();
    this._connectTimedOut = false;
    this._setState(State.Connecting);

    const ws = new WebSocket(this._options.url, this._options.wsOptions);
    this._ws = ws;

    ws.on('open', () => {
      this._clearConnectTimer();
      this._backoff.reset();
      this._setState(State.Connected);
      this._startHeartbeat();
      this.emit('connect');
      this._resolveConnect?.();
      this._resolveConnect = undefined;
      this._rejectConnect = undefined;
      this._connectPromise = null;
    });

    ws.on('message', (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      this.emit('message', buf);
    });

    ws.on('pong', () => {
      this._heartbeat?.handlePong();
    });

    ws.on('close', (code, reasonBuf) => {
      this._onSocketClose(code, reasonBuf?.toString() ?? '');
    });

    ws.on('error', (err) => {
      const cerr = new ConnectionError(err.message ?? 'websocket error', 'WS_ERROR', err);
      // terminate() 在 CONNECTING 阶段会触发「WebSocket was closed before...」的 error，
      // 不应覆盖更具体的 ConnectTimeoutError。
      if (!this._connectTimedOut) {
        this._lastError = cerr;
      }
      this.emit('error', cerr);
    });

    ws.on('unexpected-response', (_req, res) => {
      const cerr = new ConnectionError(`Unexpected HTTP ${res.statusCode} during handshake`, 'HANDSHAKE_FAILED');
      this._lastError = cerr;
      this.emit('error', cerr);
    });

    this._connectTimer = setTimeout(() => {
      if (this._state !== State.Connecting) return;
      this._clearConnectTimer();
      const err = new ConnectTimeoutError(`connect timeout after ${this._options.connectTimeoutMs}ms`);
      this._lastError = err;
      this._connectTimedOut = true;
      this.emit('error', err);
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
    }, this._options.connectTimeoutMs);
    this._connectTimer.unref?.();
  }

  // ---- 内部：关闭与重连 ----

  private _onSocketClose(code: number, reason: string): void {
    if (this._state === State.Closed) return;

    const initiatedByUs = this._manualClose;
    const wasClean = code === 1000 || code === 1001;
    const info: CloseInfo = { code, reason, wasClean, initiatedByUs };

    this._clearConnectTimer();
    this._stopHeartbeat();
    this._ws = null;
    this.emit('close', info);

    if (initiatedByUs || !this._options.reconnect) {
      this._failPending(this._lastError ?? new ConnectionError(`connection closed (code ${code})`, 'CLOSED'));
      this._setState(State.Closed);
      return;
    }

    this._scheduleReconnect();
  }

  private _scheduleReconnect(): void {
    if (this._state === State.Closed) return;

    if (this._backoff.attempt >= this._options.maxReconnectAttempts) {
      const err = new ConnectionError('max reconnect attempts exceeded', 'MAX_RECONNECT');
      this._lastError = err;
      this.emit('error', err);
      this._failPending(err);
      this._setState(State.Closed);
      return;
    }

    const delay = this._backoff.nextDelayMs();
    this._setState(State.Reconnecting);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = undefined;
      if (this._manualClose || this._state === State.Closed) return;
      this._open();
    }, delay);
    this._reconnectTimer.unref?.();
  }

  // ---- 内部：心跳 ----

  private _startHeartbeat(): void {
    this._stopHeartbeat();
    const hb = new HeartbeatManager({
      intervalMs: this._options.heartbeatIntervalMs,
      timeoutMs: this._options.heartbeatTimeoutMs,
      sendPing: () => {
        try {
          this._ws?.ping();
        } catch {
          /* ignore */
        }
      },
      onTimeout: () => this._onHeartbeatTimeout(),
    });
    this._heartbeat = hb;
    hb.start();
  }

  private _stopHeartbeat(): void {
    this._heartbeat?.stop();
    this._heartbeat = null;
  }

  private _onHeartbeatTimeout(): void {
    const err = new HeartbeatTimeoutError();
    this._lastError = err;
    this.emit('error', err);
    const ws = this._ws;
    if (ws) {
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
    }
    // terminate → 'close'(1006) → _onSocketClose → 重连。
  }

  // ---- 内部：状态 / 定时器 / 工具 ----

  private _setState(next: State): void {
    if (this._state === next) return;
    const prev = this._state;
    this._state = next;
    this._options.logger.debug(`[rpc] connection state: ${prev} -> ${next}`);
    queueMicrotask(() => this.emit('stateChange', prev, next));
  }

  private _failPending(err: Error): void {
    this._rejectConnect?.(err);
    this._resolveConnect = undefined;
    this._rejectConnect = undefined;
    this._connectPromise = null;
  }

  private _clearConnectTimer(): void {
    if (this._connectTimer) {
      clearTimeout(this._connectTimer);
      this._connectTimer = undefined;
    }
  }

  private _clearReconnectTimer(): void {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = undefined;
    }
  }
}
