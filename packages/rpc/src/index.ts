// @bap/rpc —— Java 桥 TS 通信面。
// RpcClient 门面：懒启动 bridge 子进程，提供 connect/request/call/ping/disconnect/close。
import { BridgeProcess, BridgeRpcError } from './transport';
import type { BridgeLaunchConfig, JsonValue, SessionDto } from './types';

export { BridgeProcess, BridgeRpcError, resolveJavaBin } from './transport';
export type {
  JsonValue,
  BridgeMethod,
  RpcRequest,
  RpcResponse,
  RpcError,
  BridgeLaunchConfig,
  SessionDto,
  PendingEntry,
  RpcClientEvents,
} from './types';

export interface RpcClientOptions {
  launch: BridgeLaunchConfig;
  /** connect 专用超时（毫秒，较长的默认，给 ECJ 编译代理 + 首次握手留时间），默认 60_000。 */
  connectTimeoutMs?: number;
}

export class RpcClient {
  private _proc: BridgeProcess;
  private _connectTimeoutMs: number;
  private _exitHandlers: Array<(code: number | null) => void> = [];
  private _progressHandlers: Array<(p: { percent: number; message: string }) => void> = [];

  constructor(options: RpcClientOptions) {
    this._proc = new BridgeProcess(options.launch);
    this._connectTimeoutMs = options.connectTimeoutMs ?? 60_000;
    this._proc.on('exit', (code) => {
      for (const h of this._exitHandlers) h(code);
    });
    this._proc.on('progress', (p) => {
      for (const h of this._progressHandlers) h(p);
    });
  }

  get active(): boolean {
    return this._proc.active;
  }

  /** 懒启动：首次调用会 spawn Java 桥。 */
  private ensureStarted(): void {
    if (!this._proc.active) this._proc.start();
  }

  /** 连接并登录（返回会话），若失败 reject。 */
  async connect(uri: string, user: string, pwd: string): Promise<SessionDto> {
    this.ensureStarted();
    const result = await this._proc.request('connect', [uri, user, pwd], this._connectTimeoutMs);
    const obj = (result ?? {}) as { connected?: boolean; session?: SessionDto };
    if (!obj.connected) throw new BridgeRpcError('CONNECT_FAILED', 'bridge connect returned not connected');
    return obj.session ?? {};
  }

  /** 发送任意请求。 */
  request(method: Parameters<BridgeProcess['request']>[0], params: JsonValue[], timeoutMs?: number): Promise<JsonValue> {
    this.ensureStarted();
    return this._proc.request(method, params, timeoutMs);
  }

  /** 原子方法转发：call("getAllProjects") 等。 */
  call<T = JsonValue>(method: string, ...args: JsonValue[]): Promise<T> {
    this.ensureStarted();
    return this._proc.request('call', [method, args]) as Promise<T>;
  }

  /** 带显式超时的原子方法转发（下载整包等长耗时调用）。 */
  callWithTimeout<T = JsonValue>(timeoutMs: number, method: string, ...args: JsonValue[]): Promise<T> {
    this.ensureStarted();
    return this._proc.request('call', [method, args], timeoutMs) as Promise<T>;
  }

  /** 订阅进度事件（Java 桥 download 期间推送）。返回退订函数。 */
  onProgress(cb: (p: { percent: number; message: string }) => void): () => void {
    this._progressHandlers.push(cb);
    return () => {
      const i = this._progressHandlers.indexOf(cb);
      if (i >= 0) this._progressHandlers.splice(i, 1);
    };
  }

  ping(): Promise<boolean> {
    this.ensureStarted();
    return this._proc.request('ping', []) as Promise<boolean>;
  }

  /** 断开连接（Java 桥进程不退出，可复用）。 */
  async disconnect(): Promise<void> {
    await this._proc.request('disconnect', []);
  }

  /** 彻底关闭：发 shutdown + 兜底 kill。 */
  async close(): Promise<void> {
    if (this._proc.active) {
      try {
        await this._proc.request('shutdown', [], 3000);
      } catch {
        // 可能已退出
      }
    }
    this._proc.kill();
  }

  onExit(cb: (code: number | null) => void): void {
    this._exitHandlers.push(cb);
  }
}

/** 便捷工厂。 */
export function createRpcClient(options: RpcClientOptions): RpcClient {
  return new RpcClient(options);
}
