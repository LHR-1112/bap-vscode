import { CRPC_HEADER_LENGTH, encodeHeader, decodeHeader, isBinaryType } from './header';
import type { MessageType, RpcHeader } from './header';
import { messageTypeOf } from './messages';
import type { RpcEncodeInput, RpcMessage } from './messages';
import { CodecError } from './errors';

/**
 * body 序列化器（第三阶段注入 Java 序列化兼容实现）。
 * 本阶段缺省 → body 为空占位。
 */
export type BodySerializer = (msg: RpcMessage) => Buffer;

export interface EncodeOptions {
  /** 二进制路径（Buffer）需要显式 reqID；消息路径缺省时取 msg.getReqID()。 */
  reqID?: number;
  /** 第三阶段传入；缺省 body 为空。 */
  serialize?: BodySerializer;
}

export interface DecodeOptions {
  /** 第三阶段传入；本阶段不反序列化。 */
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
  if (opts.serialize && !Buffer.isBuffer(input)) {
    body = opts.serialize(input);
  } else {
    body = Buffer.isBuffer(input) ? input : Buffer.alloc(0);
  }

  return Buffer.concat([header, body]);
}

/** 解码整帧：读 13 字节 header + 其余为 body（原样透传）。 */
export function decode(buf: Buffer, _opts: DecodeOptions = {}): RpcFrame {
  const header = decodeHeader(buf);
  const body = buf.subarray(CRPC_HEADER_LENGTH);
  return { header, body };
}

/** body 是否需要交给反序列化（非二进制类型即需要）。 */
export function needsDeserialization(type: MessageType | number): boolean {
  return !isBinaryType(type);
}
