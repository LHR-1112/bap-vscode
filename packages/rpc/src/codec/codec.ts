import { CRPC_HEADER_LENGTH, encodeHeader, decodeHeader, isBinaryType } from './header';
import type { MessageType, RpcHeader } from './header';
import { messageTypeOf } from './messages';
import type { RpcEncodeInput, RpcMessage } from './messages';
import { CodecError } from './errors';
import { serializeBody, deserializeBody } from '../serializer/serializer';

/**
 * body 序列化器（默认接 Java 序列化兼容实现）。
 */
export type BodySerializer = (msg: RpcMessage) => Buffer;

export interface EncodeOptions {
  /** 二进制路径（Buffer）需要显式 reqID；消息路径缺省时取 msg.getReqID()。 */
  reqID?: number;
  /** 第三阶段传入；缺省用 serializeBody。 */
  serialize?: BodySerializer;
}

export interface DecodeOptions {
  /** 第三阶段传入；缺省用 deserializeBody。 */
  deserialize?: (frame: RpcFrame) => RpcMessage;
}

export interface RpcFrame {
  header: RpcHeader;
  body: Buffer;
}

/** 编码为整帧 `[13B header][body]`。 */
export function encode(input: RpcEncodeInput, opts: EncodeOptions = {}): Buffer {
  const type = messageTypeOf(input);

  let reqID: number;
  if (typeof opts.reqID === 'number') {
    reqID = opts.reqID;
  } else if (Buffer.isBuffer(input)) {
    throw new CodecError('binary frame requires a reqID (pass EncodeOptions.reqID)');
  } else {
    reqID = input.getReqID();
  }

  const header = encodeHeader({ magic: 'LV', verBig: 1, verSmall: 0, type, reqID });

  let body: Buffer;
  if (Buffer.isBuffer(input)) {
    body = input;
  } else if (opts.serialize) {
    body = opts.serialize(input);
  } else if (type >= 100) {
    body = Buffer.alloc(0);
  } else {
    body = serializeBody(input as RpcMessage);
  }

  return Buffer.concat([header, body]);
}

/** 解码整帧：读 13 字节 header + 其余为 body。 */
export function decode(buf: Buffer, opts: DecodeOptions = {}): RpcFrame {
  const header = decodeHeader(buf);
  const body = buf.subarray(CRPC_HEADER_LENGTH);
  return { header, body };
}

/** 解码整帧为一个 RPC 消息（默认走 Java 反序列化）。 */
export function decodeMessage(buf: Buffer, opts: DecodeOptions = {}): RpcMessage {
  const frame = decode(buf, opts);
  if (opts.deserialize) return opts.deserialize(frame);
  return deserializeBody(frame.body);
}

/** body 是否需要交给反序列化（非二进制类型即需要）。 */
export function needsDeserialization(type: MessageType | number): boolean {
  return !isBinaryType(type);
}
