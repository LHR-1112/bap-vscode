// 连接层错误类型。基类携带稳定 code，供上层按语义处理。

export class ConnectionError extends Error {
  readonly code: string;
  readonly cause?: unknown;

  constructor(message: string, code: string, cause?: unknown) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.cause = cause;
  }
}

export class ConnectTimeoutError extends ConnectionError {
  constructor(message = 'Connect timeout', cause?: unknown) {
    super(message, 'CONNECT_TIMEOUT', cause);
  }
}

export class HeartbeatTimeoutError extends ConnectionError {
  constructor(message = 'Heartbeat timeout', cause?: unknown) {
    super(message, 'HEARTBEAT_TIMEOUT', cause);
  }
}
