import type { ConnectionOptions, Logger, ResolvedConnectionOptions } from './types';

const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export const DEFAULT_CONNECTION_OPTIONS: ResolvedConnectionOptions = {
  url: 'ws://127.0.0.1:2020',
  connectTimeoutMs: 10_000,
  heartbeatIntervalMs: 10_000,
  heartbeatTimeoutMs: 5_000,
  reconnect: true,
  maxReconnectAttempts: Infinity,
  reconnectInitialDelayMs: 1_000,
  reconnectMaxDelayMs: 30_000,
  reconnectFactor: 2,
  reconnectJitter: true,
  rpcTimeoutMs: 120_000,
  wsOptions: { perMessageDeflate: false },
  logger: noopLogger,
};

/** 合并默认值并校验不变量。 */
export function normalizeOptions(partial: ConnectionOptions = {}): ResolvedConnectionOptions {
  const opts: ResolvedConnectionOptions = {
    ...DEFAULT_CONNECTION_OPTIONS,
    ...partial,
    wsOptions: { ...DEFAULT_CONNECTION_OPTIONS.wsOptions, ...partial.wsOptions },
    logger: partial.logger ?? DEFAULT_CONNECTION_OPTIONS.logger,
  };

  if (opts.connectTimeoutMs <= 0) {
    throw new Error('connectTimeoutMs must be > 0');
  }
  if (opts.heartbeatIntervalMs <= 0) {
    throw new Error('heartbeatIntervalMs must be > 0');
  }
  if (opts.heartbeatTimeoutMs >= opts.heartbeatIntervalMs) {
    throw new Error(
      `heartbeatTimeoutMs (${opts.heartbeatTimeoutMs}) must be < heartbeatIntervalMs (${opts.heartbeatIntervalMs})`,
    );
  }
  return opts;
}
