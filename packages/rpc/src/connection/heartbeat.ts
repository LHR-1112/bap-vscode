// 心跳管理：自调度 setTimeout 发 ping，pong 超时判定连接死亡。
// sendPing 可注入——本阶段注入 ws.ping()，后续可替换为应用层 CRpcPing。

export interface HeartbeatOptions {
  intervalMs: number;
  timeoutMs: number;
  sendPing: () => void;
  onTimeout: () => void;
  onPing?: () => void;
}

export class HeartbeatManager {
  private readonly _intervalMs: number;
  private readonly _timeoutMs: number;
  private readonly _sendPing: () => void;
  private readonly _onTimeout: () => void;
  private readonly _onPing?: () => void;

  private _intervalTimer?: NodeJS.Timeout;
  private _pongTimer?: NodeJS.Timeout;
  private _active = false;

  constructor(opts: HeartbeatOptions) {
    this._intervalMs = opts.intervalMs;
    this._timeoutMs = opts.timeoutMs;
    this._sendPing = opts.sendPing;
    this._onTimeout = opts.onTimeout;
    this._onPing = opts.onPing;
  }

  get active(): boolean {
    return this._active;
  }

  start(): void {
    this.stop();
    this._active = true;
    this._scheduleNext();
  }

  stop(): void {
    this._active = false;
    if (this._intervalTimer) {
      clearTimeout(this._intervalTimer);
      this._intervalTimer = undefined;
    }
    if (this._pongTimer) {
      clearTimeout(this._pongTimer);
      this._pongTimer = undefined;
    }
  }

  /** 收到 pong：清 pong 超时并调度下一次 ping。 */
  handlePong(): void {
    if (!this._active) return;
    if (this._pongTimer) {
      clearTimeout(this._pongTimer);
      this._pongTimer = undefined;
    }
    this._scheduleNext();
  }

  private _scheduleNext(): void {
    if (!this._active) return;
    if (this._intervalTimer) clearTimeout(this._intervalTimer);
    this._intervalTimer = setTimeout(() => {
      this._intervalTimer = undefined;
      if (!this._active) return;
      this._sendPing();
      this._onPing?.();
      this._armPongTimer();
    }, this._intervalMs);
    this._intervalTimer.unref?.();
  }

  private _armPongTimer(): void {
    this._pongTimer = setTimeout(() => {
      this._pongTimer = undefined;
      if (!this._active) return;
      this._active = false;
      if (this._intervalTimer) {
        clearTimeout(this._intervalTimer);
        this._intervalTimer = undefined;
      }
      this._onTimeout();
    }, this._timeoutMs);
    this._pongTimer.unref?.();
  }
}
