import { ConnectionError } from '../connection/errors';

/** 服务端返回 err != null 时抛出。携带原服务端错误。 */
export class CRpcError extends ConnectionError {
  declare readonly cause: unknown;
  constructor(cause: unknown, message = 'remote rpc error') {
    super(message, 'CRPC_REMOTE', cause);
    this.cause = cause;
  }
}

export class CRpcTimeoutException extends ConnectionError {
  constructor(reqID: number, timeoutMs: number) {
    super(`rpc invoke reqID=${reqID} timed out after ${timeoutMs}ms`, 'CRPC_TIMEOUT');
  }
}

export class CRpcNotConnectedError extends ConnectionError {
  constructor(message = 'rpc client is not connected', cause?: unknown) {
    super(message, 'CRPC_NOT_CONNECTED', cause);
  }
}
