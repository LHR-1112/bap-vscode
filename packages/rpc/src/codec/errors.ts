import { ConnectionError } from '../connection/errors';

/** Codec 层错误基类。复用连接层「带稳定 code」的模式，便于上层统一按 code 分派。 */
export class CodecError extends ConnectionError {
  constructor(message: string, code = 'CODEC', cause?: unknown) {
    super(message, code, cause);
  }
}

export class HeaderFormatError extends CodecError {
  constructor(message: string, cause?: unknown) {
    super(message, 'HEADER_FORMAT', cause);
  }
}

export class ReqIdRangeError extends CodecError {
  constructor(message = 'reqID out of safe integer range', cause?: unknown) {
    super(message, 'REQID_RANGE', cause);
  }
}
