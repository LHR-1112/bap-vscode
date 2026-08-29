// 指数退避 + 完全抖动（full jitter），AWS 风格。
// 纯函数式，无副作用，可脱离网络单测。

export interface BackoffOptions {
  initialMs: number;
  maxMs: number;
  factor: number;
  jitter: boolean;
}

export class Backoff {
  private _attempt = 0;
  private readonly _opts: BackoffOptions;

  constructor(opts: BackoffOptions) {
    this._opts = opts;
  }

  get attempt(): number {
    return this._attempt;
  }

  /** 返回本次延迟（毫秒）并推进 attempt。 */
  nextDelayMs(): number {
    const n = this._attempt;
    this._attempt += 1;
    const { initialMs, maxMs, factor, jitter } = this._opts;
    const base = Math.min(initialMs * Math.pow(factor, n), maxMs);
    return jitter ? Math.random() * base : base;
  }

  reset(): void {
    this._attempt = 0;
  }
}
