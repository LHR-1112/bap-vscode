// @bap/rpc —— RPC Runtime（第一层）。
// 第一阶段：Connection（WebSocket / 重连 / Ping / Timeout）。
// 第二阶段：Codec（Header 编解码 / 消息体建模）。
// 后续阶段：Serializer（Java 序列化兼容）、RpcClient。

export { RpcConnection } from './connection/connection';
export { ConnectionState } from './connection/types';
export { ConnectionError, ConnectTimeoutError, HeartbeatTimeoutError } from './connection/errors';
export { Backoff } from './connection/backoff';
export { HeartbeatManager } from './connection/heartbeat';
export { TypedEmitter } from './connection/emitter';
export { normalizeOptions, DEFAULT_CONNECTION_OPTIONS } from './connection/defaults';

export type {
  ConnectionOptions,
  ResolvedConnectionOptions,
  ConnectionEventMap,
  CloseInfo,
  Logger,
} from './connection/types';

export * from './codec';
