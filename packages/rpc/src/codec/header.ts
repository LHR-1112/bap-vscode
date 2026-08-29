import { HeaderFormatError, ReqIdRangeError } from './errors';

/** CRPC 线头长度：13 字节，大端。 */
export const CRPC_HEADER_LENGTH = 13;

export const MAGIC_BYTE_0 = 0x4c; // 'L'
export const MAGIC_BYTE_1 = 0x56; // 'V'

export enum MessageType {
  REQ = 1,
  RSP = 2,
  CALLBACK_REQ = 3,
  CALLBACK_RSP = 4,
  BIN_RPC = 100,
  BIN_RPC_RSP = 101,
  BIN_RPC_CALLBACK_REQ = 102,
  BIN_RPC_CALLBACK_RSP = 103,
}

export interface RpcHeader {
  magic: 'LV';
  verBig: number;
  verSmall: number;
  type: MessageType;
  reqID: number;
}

function isKnownType(type: number): type is MessageType {
  switch (type) {
    case MessageType.REQ:
    case MessageType.RSP:
    case MessageType.CALLBACK_REQ:
    case MessageType.CALLBACK_RSP:
    case MessageType.BIN_RPC:
    case MessageType.BIN_RPC_RSP:
    case MessageType.BIN_RPC_CALLBACK_REQ:
    case MessageType.BIN_RPC_CALLBACK_RSP:
      return true;
    default:
      return false;
  }
}

/** 二进制类型：body 为原始 byte[]，不经过序列化。 */
export function isBinaryType(type: MessageType | number): boolean {
  return type >= 100;
}

export function isCallbackType(type: MessageType | number): boolean {
  return (
    type === MessageType.CALLBACK_REQ ||
    type === MessageType.CALLBACK_RSP ||
    type === MessageType.BIN_RPC_CALLBACK_REQ ||
    type === MessageType.BIN_RPC_CALLBACK_RSP
  );
}

const TYPE_NAMES: Record<number, string> = {
  [MessageType.REQ]: 'REQ',
  [MessageType.RSP]: 'RSP',
  [MessageType.CALLBACK_REQ]: 'CALLBACK_REQ',
  [MessageType.CALLBACK_RSP]: 'CALLBACK_RSP',
  [MessageType.BIN_RPC]: 'BIN_RPC',
  [MessageType.BIN_RPC_RSP]: 'BIN_RPC_RSP',
  [MessageType.BIN_RPC_CALLBACK_REQ]: 'BIN_RPC_CALLBACK_REQ',
  [MessageType.BIN_RPC_CALLBACK_RSP]: 'BIN_RPC_CALLBACK_RSP',
};

export function typeName(type: number): string {
  return TYPE_NAMES[type] ?? `UNKNOWN(${type})`;
}

/** 生成 13 字节大端线头。入参校验：type 白名单 + reqID 安全整数。 */
export function encodeHeader(header: RpcHeader): Buffer {
  if (!isKnownType(header.type)) {
    throw new HeaderFormatError(`invalid message type ${header.type}`);
  }
  if (!isValidVer(header.verBig) || !isValidVer(header.verSmall)) {
    throw new HeaderFormatError(`invalid version ${header.verBig}.${header.verSmall}`);
  }
  if (!Number.isSafeInteger(header.reqID)) {
    throw new ReqIdRangeError(`reqID ${header.reqID} exceeds safe integer range`);
  }

  const buf = Buffer.allocUnsafe(CRPC_HEADER_LENGTH);
  buf[0] = MAGIC_BYTE_0;
  buf[1] = MAGIC_BYTE_1;
  buf[2] = header.verBig;
  buf[3] = header.verSmall;
  buf[4] = header.type;
  buf.writeBigInt64BE(BigInt(header.reqID), 5);
  return buf;
}

function isValidVer(v: number): boolean {
  return Number.isInteger(v) && v >= 0 && v <= 255;
}

/** 解析 13 字节线头。任一校验失败抛 HeaderFormatError / ReqIdRangeError。 */
export function decodeHeader(buf: Buffer): RpcHeader {
  if (buf.length < CRPC_HEADER_LENGTH) {
    throw new HeaderFormatError(
      `header too short: need ${CRPC_HEADER_LENGTH} bytes, got ${buf.length}`,
    );
  }
  if (buf[0] !== MAGIC_BYTE_0 || buf[1] !== MAGIC_BYTE_1) {
    throw new HeaderFormatError(
      `bad magic 0x${buf[0].toString(16)}${buf[1].toString(16)}, expected 'L''V' (0x4c 0x56)`,
    );
  }
  const verBig = buf[2];
  const verSmall = buf[3];
  if (verBig !== 1) {
    throw new HeaderFormatError(
      `unsupported protocol version ${verBig}.${verSmall}, expected 1.0`,
    );
  }
  const type = buf[4];
  if (!isKnownType(type)) {
    throw new HeaderFormatError(`unknown message type ${type}`);
  }
  const reqIDBig = buf.readBigInt64BE(5);
  const reqID = Number(reqIDBig);
  if (!Number.isSafeInteger(reqID)) {
    throw new ReqIdRangeError(`reqID ${reqIDBig.toString()} exceeds safe integer range`);
  }
  return { magic: 'LV', verBig, verSmall, type, reqID };
}
