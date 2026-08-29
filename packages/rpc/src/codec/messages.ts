import { MessageType } from './header';

/** 模块级 reqID 自增器（Java 用 AtomicLong 从 1 起）。 */
let _seq = 1;

export function nextReqId(): number {
  return _seq++;
}

/** Java CRpcMsgIntf：统一契约只有 getReqID()。 */
export interface RpcMessageIntf {
  getReqID(): number;
}

export class RpcRequest implements RpcMessageIntf {
  reqID: number;
  className: string | null;
  reqType: number | null; // Byte；业务字段，与线头 type 无关，可 null
  function: string | null;
  params: unknown[] | null;
  context: Map<string, unknown> | null;

  constructor(className?: string, fn?: string, ...params: unknown[]) {
    this.reqID = nextReqId();
    this.className = className ?? null;
    this.function = fn ?? null;
    this.params = params.length > 0 ? params : null;
    this.reqType = null;
    this.context = null;
  }

  getReqID(): number {
    return this.reqID;
  }

  setReqID(id: number): this {
    this.reqID = id;
    return this;
  }
}

export class RpcPing extends RpcRequest {}

export class RpcResponse implements RpcMessageIntf {
  reqID: number = 0;
  result: unknown = null;
  err: unknown = null;

  getReqID(): number {
    return this.reqID;
  }

  setReqID(id: number): this {
    this.reqID = id;
    return this;
  }

  setResult(r: unknown): this {
    this.result = r;
    return this;
  }

  setError(e: unknown): this {
    this.err = e;
    return this;
  }
}

export class RpcCallbackResponse extends RpcResponse {}

export class RpcCallbackReq implements RpcMessageIntf {
  reqID: number;
  callbackUuid: string | null;
  function: string | null;
  params: unknown[] | null;
  context: Map<string, unknown> | null;

  constructor(callbackUuid?: string, fn?: string, ...params: unknown[]) {
    this.reqID = nextReqId();
    this.callbackUuid = callbackUuid ?? null;
    this.function = fn ?? null;
    this.params = params.length > 0 ? params : null;
    this.context = null;
  }

  getReqID(): number {
    return this.reqID;
  }

  setReqID(id: number): this {
    this.reqID = id;
    return this;
  }
}

export type RpcMessage =
  | RpcRequest
  | RpcPing
  | RpcResponse
  | RpcCallbackResponse
  | RpcCallbackReq;

/** 可编码的输入：消息或原始二进制（走 type=100 路径）。 */
export type RpcEncodeInput = RpcMessage | Buffer;

/**
 * 判定线头 type（镜像 Java writeHeader 的 instanceof 决策顺序）。
 * 注意：RpcCallbackResponse extends RpcResponse，必须判在 RpcResponse 前。
 */
export function messageTypeOf(msg: RpcEncodeInput | null | undefined): MessageType {
  if (msg == null) return MessageType.REQ;
  if (Buffer.isBuffer(msg)) return MessageType.BIN_RPC;
  if (msg instanceof RpcCallbackReq) return MessageType.CALLBACK_REQ;
  if (msg instanceof RpcCallbackResponse) return MessageType.CALLBACK_RSP;
  if (msg instanceof RpcResponse) return MessageType.RSP;
  return MessageType.REQ; // RpcRequest / RpcPing
}

export function isRpcRequest(m: unknown): m is RpcRequest {
  return m instanceof RpcRequest;
}
export function isRpcPing(m: unknown): m is RpcPing {
  return m instanceof RpcPing;
}
export function isRpcResponse(m: unknown): m is RpcResponse {
  return m instanceof RpcResponse;
}
export function isRpcCallbackResponse(m: unknown): m is RpcCallbackResponse {
  return m instanceof RpcCallbackResponse;
}
export function isRpcCallbackReq(m: unknown): m is RpcCallbackReq {
  return m instanceof RpcCallbackReq;
}
export function isRpcMessage(m: unknown): m is RpcMessage {
  return (
    isRpcRequest(m) ||
    isRpcResponse(m) ||
    isRpcCallbackResponse(m) ||
    isRpcCallbackReq(m)
  );
}
