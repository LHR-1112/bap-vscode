import type { RpcConnection } from '../connection/connection';
import type { ConnectionOptions, Logger } from '../connection/types';
import type { RpcFrame } from '../codec/codec';
import type {
  CRpcError,
  CRpcTimeoutException,
  CRpcNotConnectedError,
} from './errors';

/** invoke 可覆盖的参数。 */
export interface InvokeOptions {
  /** 单次调用超时（毫秒）。优先级：opts.timeoutMs > setTempTimeout > defaultTimeoutMs。 */
  timeoutMs?: number;
  /** 显式指定 reqID（极少用；缺省走 nextReqId()）。 */
  reqID?: number;
}

export interface RpcClientOptions {
  /** 注入现成连接（推荐测试/复用 mock）。指定了 url 时优先用 injected。 */
  connection?: RpcConnection;
  /** 未注入连接时用它自建（可选走静态 URI 缓存）。 */
  url?: string;
  /** 自建连接时透传。 */
  connectionOptions?: ConnectionOptions;
  /** 默认 per-call 超时（毫秒），缺省 120_000。 */
  defaultTimeoutMs?: number;
  /** 备用，供后续 ping 专用。 */
  pingTimeoutMs?: number;
  logger?: Logger;
  /** true 时 close() 会同时 close 底层连接（自建默认 true，injected 默认 false）。 */
  ownsConnection?: boolean;
}

/** 服务端回传的 callback handler。返回结果会包成 RpcCallbackResponse 发回。 */
export type CallbackHandler = (
  params: unknown[] | null,
  context: Map<string, unknown> | null,
) => unknown;

/** invoke 在失败时可能 reject 的错误类型。 */
export type RpcInvokeError =
  | CRpcError
  | CRpcTimeoutException
  | CRpcNotConnectedError
  | import('../connection/errors').ConnectionError
  | import('../codec/errors').CodecError
  | import('../serializer/errors').SerializerError;

export interface RpcClientEventMap {
  error: (err: RpcInvokeError) => void;
  message: (frame: RpcFrame) => void;
  disconnect: () => void;
}
