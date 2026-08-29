import type { ClientOptions } from 'ws';
import type { ConnectionError } from './errors';

/** 连接状态机。closed 为终态。 */
export enum ConnectionState {
  Idle = 'idle',
  Connecting = 'connecting',
  Connected = 'connected',
  Reconnecting = 'reconnecting',
  Closed = 'closed',
}

export interface CloseInfo {
  code: number;
  reason: string;
  wasClean: boolean;
  initiatedByUs: boolean;
}

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

/** 用户可传入的（全部可选）连接配置。 */
export interface ConnectionOptions {
  url?: string;
  connectTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  reconnect?: boolean;
  maxReconnectAttempts?: number;
  reconnectInitialDelayMs?: number;
  reconnectMaxDelayMs?: number;
  reconnectFactor?: number;
  reconnectJitter?: boolean;
  rpcTimeoutMs?: number;
  wsOptions?: ClientOptions;
  logger?: Logger;
}

/** normalizeOptions 之后的全量配置（全部字段已填默认值）。 */
export interface ResolvedConnectionOptions {
  url: string;
  connectTimeoutMs: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  reconnect: boolean;
  maxReconnectAttempts: number;
  reconnectInitialDelayMs: number;
  reconnectMaxDelayMs: number;
  reconnectFactor: number;
  reconnectJitter: boolean;
  rpcTimeoutMs: number;
  wsOptions: ClientOptions;
  logger: Logger;
}

export interface ConnectionEventMap {
  message: (data: Buffer) => void;
  stateChange: (prev: ConnectionState, next: ConnectionState) => void;
  connect: () => void;
  close: (info: CloseInfo) => void;
  error: (err: ConnectionError) => void;
}
