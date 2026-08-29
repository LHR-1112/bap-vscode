import { ConnectionError } from '../connection/errors';

/** 序列化层错误基类。复用连接层「带稳定 code」的模式，便于上层统一按 code 分派。 */
export class SerializerError extends ConnectionError {
  constructor(message: string, code = 'SERIALIZER', cause?: unknown) {
    super(message, code, cause);
  }
}

export class UnsupportedTypeError extends SerializerError {
  constructor(message = 'unsupported value for java serialization', cause?: unknown) {
    super(message, 'SERIALIZER_UNSUPPORTED', cause);
  }
}

export class CorruptStreamError extends SerializerError {
  constructor(message = 'corrupt java serialization stream', cause?: unknown) {
    super(message, 'SERIALIZER_CORRUPT_STREAM', cause);
  }
}

export class UnknownClassDescError extends SerializerError {
  constructor(message = 'unknown class descriptor', cause?: unknown) {
    super(message, 'SERIALIZER_UNKNOWN_CLASS', cause);
  }
}

export class MalformedUtf8Error extends SerializerError {
  constructor(message = 'malformed modified-utf-8', cause?: unknown) {
    super(message, 'SERIALIZER_MALFORMED_UTF8', cause);
  }
}

export class HandleTableError extends SerializerError {
  constructor(message = 'invalid handle reference', cause?: unknown) {
    super(message, 'SERIALIZER_HANDLE', cause);
  }
}
