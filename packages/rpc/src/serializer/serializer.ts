import type { RpcRequest, RpcPing, RpcResponse, RpcCallbackReq } from '../codec/messages';
import { ObjectOutputStream } from './writer';
import { ObjectInputStream } from './reader';
import { StreamReader } from './stream-reader';
import { toJavaMessage, fromJavaToMessage } from './value';
import { CorruptStreamError } from './errors';

export type RpcMessage = RpcRequest | RpcPing | RpcResponse | RpcCallbackReq;

/** 序列化一个 RPC 消息为 body（含流头 0xACED0005）。 */
export function serializeBody(msg: RpcMessage): Buffer {
  const out = new ObjectOutputStream();
  out.writeHeader();
  const jv = toJavaMessage(msg);
  out.writeObject(jv);
  return out.getBytes();
}

/** 反序列化 body 为一个 RPC 消息。 */
export function deserializeBody(body: Buffer): RpcMessage {
  if (body.length < 4) throw new CorruptStreamError('body too short for stream header');
  const sr = new StreamReader(body);
  const in_ = new ObjectInputStream(sr);
  in_.readHeader();
  const jv = in_.readObject();
  return fromJavaToMessage(jv);
}
