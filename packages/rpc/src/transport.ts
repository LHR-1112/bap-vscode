// BridgeProcess：spawn Java 桥进程，经 stdin/stdout JSON-lines 与它通信。
// 核心：readline 按行解析 stdout 的 JSON 帧；id 与 Promise 匹配；超时；stdin 背压；进程生命周期。
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as readline from 'readline';
import * as path from 'path';
import * as fsp from 'fs';
import { EventEmitter } from 'events';
import type { BridgeLaunchConfig, JsonValue, PendingEntry, RpcRequest, RpcResponse } from './types';

export class BridgeRpcError extends Error {
  readonly code: string;
  constructor(name: string, message: string) {
    super(`${name}: ${message}`);
    this.code = name;
  }
}

export class BridgeProcess extends EventEmitter<{ exit: [number | null]; log: [string]; progress: [{ percent: number; message: string }] }> {
  private _child: ChildProcessWithoutNullStreams | null = null;
  private _pending = new Map<number, PendingEntry>();
  private _writeQueue: Buffer[] = [];
  private _nextId = 1;
  private _config: BridgeLaunchConfig;
  private _settled = false;

  constructor(config: BridgeLaunchConfig) {
    super();
    this._config = config;
  }

  get active(): boolean {
    return this._child !== null;
  }

  /** 启动子进程（若已启动则忽略）。 */
  start(): void {
    if (this._child) return;
    const javaBin = this._config.javaBin ?? resolveJavaBin();
    const classpath = this._config.classpath.join(path.delimiter);
    const mainClass = this._config.mainClass ?? 'com.bap.dev.BridgeMain';

    const child = spawn(javaBin, ['-cp', classpath, mainClass], {
      cwd: this._config.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this._child = child;
    this._settled = false;

    child.on('error', (err) => {
      this._failAll(new BridgeRpcError('SPAWN_ERROR', err.message));
      this._settle(null);
    });

    child.on('exit', (code) => {
      this._failAll(new BridgeRpcError('BRIDGE_EXIT', `java bridge exited with code ${code}`));
      this._settle(code);
    });

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => this._onLine(line));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      for (const l of chunk.split(/\r?\n/)) {
        if (l.trim().length) this.emit('log', l);
      }
    });
  }

  /** 发送一条请求并返回匹配的 Promise（id 自增、超时）。 */
  request(method: RpcRequest['method'], params: JsonValue[], timeoutMs?: number): Promise<JsonValue> {
    if (!this._child || this._settled) {
      return Promise.reject(new BridgeRpcError('BRIDGE_NOT_RUNNING', 'bridge process is not running'));
    }
    const id = this._nextId++;
    const timeout = timeoutMs ?? this._config.timeoutMs ?? 30_000;

    return new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new BridgeRpcError('TIMEOUT', `request ${method} (id=${id}) timed out after ${timeout}ms`));
      }, timeout);

      const entry: PendingEntry = { resolve, reject, timer };
      this._pending.set(id, entry);

      const frame: RpcRequest = { id, method, params };
      this._write(JSON.stringify(frame) + '\n');
    });
  }

  /** 终止进程（killSIG）。避免进程残留。 */
  kill(): void {
    if (this._child) {
      try {
        this._child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
    this._settle(null);
  }

  // --- 内部 ---

  private _onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let resp: RpcResponse;
    try {
      resp = JSON.parse(trimmed);
    } catch {
      // 非 JSON 行 -> 当作日志处理（防御），丢给 log
      this.emit('log', trimmed);
      return;
    }
    // 进度帧：无 id、带 progress 字段（Java 桥 download 期间推送）
    const prog = (resp as unknown as { id?: unknown; progress?: { percent?: unknown; message?: unknown } }).progress;
    if (resp.id === undefined && prog) {
      this.emit('progress', { percent: Number(prog.percent ?? 0), message: String(prog.message ?? '') });
      return;
    }
    if (resp.id === undefined) {
      // 可能是第三方意外输出，当作日志
      this.emit('log', trimmed);
      return;
    }
    const entry = this._pending.get(resp.id);
    if (!entry) return; // 迟到/未知帧，忽略
    this._pending.delete(resp.id);
    clearTimeout(entry.timer);
    if (resp.ok) {
      entry.resolve(resp.result ?? null);
    } else {
      const err = resp.error ?? { name: 'UNKNOWN', message: 'unknown bridge error' };
      entry.reject(new BridgeRpcError(err.name, err.message));
    }
  }

  private _write(chunk: Buffer | string): void {
    if (!this._child) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    // stdin 背压：write 返回 false 表示内核缓冲满，等 drain 后再继续。
    const ok = this._child.stdin.write(buf);
    if (!ok) {
      this._child.stdin.once('drain', () => void 0);
    }
  }

  private _failAll(err: BridgeRpcError): void {
    for (const [, entry] of this._pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this._pending.clear();
  }

  private _settle(code: number | null): void {
    if (this._settled) return;
    this._settled = true;
    this._child = null;
    this.emit('exit', code);
  }
}

/** 解析 Java 可执行文件：BAP_JAVA_BIN -> JAVA_HOME/bin/java -> PATH 的 java。 */
export function resolveJavaBin(env: Record<string, string | undefined> = process.env): string {
  if (env.BAP_JAVA_BIN) return env.BAP_JAVA_BIN;
  if (env.JAVA_HOME) {
    const bin = path.join(env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    if (fsp.existsSync(bin)) return bin;
  }
  return 'java';
}
