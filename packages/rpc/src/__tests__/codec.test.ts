import { describe, it, expect } from 'vitest';
import {
  CRPC_HEADER_LENGTH,
  MessageType,
  encodeHeader,
  decodeHeader,
  encode,
  decode,
  needsDeserialization,
  messageTypeOf,
  RpcRequest,
  RpcPing,
  RpcResponse,
  RpcCallbackResponse,
  RpcCallbackReq,
  HeaderFormatError,
  ReqIdRangeError,
  CodecError,
} from '../codec';

describe('encodeHeader / decodeHeader', () => {
  it('encodes the 13-byte golden header', () => {
    const buf = encodeHeader({ magic: 'LV', verBig: 1, verSmall: 0, type: MessageType.REQ, reqID: 1 });
    expect(buf).toEqual(Buffer.from([0x4c, 0x56, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 0, 0x01]));
    expect(buf.length).toBe(CRPC_HEADER_LENGTH);
  });

  it('round-trips a header', () => {
    const h = { magic: 'LV' as const, verBig: 1, verSmall: 0, type: MessageType.RSP, reqID: 99 };
    expect(decodeHeader(encodeHeader(h))).toEqual(h);
  });

  it('rejects bad magic', () => {
    const buf = Buffer.from([0x4c, 0x4c, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 0, 0x01]);
    expect(() => decodeHeader(buf)).toThrow(HeaderFormatError);
    expect(() => decodeHeader(buf)).toThrow(/bad magic/);
  });

  it('rejects short header', () => {
    const buf = Buffer.from([0x4c, 0x56, 0x01, 0x00, 0x01]); // < 13
    expect(() => decodeHeader(buf)).toThrow(HeaderFormatError);
    expect(() => decodeHeader(buf)).toThrow(/header too short/);
  });

  it('rejects unsupported version', () => {
    const buf = Buffer.from([0x4c, 0x56, 0x02, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 0, 0x01]);
    expect(() => decodeHeader(buf)).toThrow(/unsupported protocol version/);
  });

  it('rejects unknown message type', () => {
    const buf = Buffer.from([0x4c, 0x56, 0x01, 0x00, 0x63, 0, 0, 0, 0, 0, 0, 0, 0x01]); // type=99
    expect(() => decodeHeader(buf)).toThrow(HeaderFormatError);
    expect(() => decodeHeader(buf)).toThrow(/unknown message type 99/);
  });

  it('rejects reqID out of safe integer range', () => {
    expect(() =>
      encodeHeader({ magic: 'LV', verBig: 1, verSmall: 0, type: MessageType.REQ, reqID: Number.MAX_SAFE_INTEGER + 1 }),
    ).toThrow(ReqIdRangeError);
  });

  it('round-trips boundary reqID including negatives', () => {
    for (const reqID of [0, -1, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]) {
      const h = { magic: 'LV' as const, verBig: 1, verSmall: 0, type: MessageType.REQ, reqID };
      expect(decodeHeader(encodeHeader(h)).reqID).toBe(reqID);
    }
  });
});

describe('encode / decode (full frame)', () => {
  it('encodes a request with empty body (no serializer)', () => {
    const req = new RpcRequest('com.foo.X', 'ping');
    const frame = encode(req);
    expect(frame.length).toBe(CRPC_HEADER_LENGTH);
    expect(frame[4]).toBe(MessageType.REQ);
  });

  it('decodes a golden frame with a body', () => {
    const buf = Buffer.from([0x4c, 0x56, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 0, 0x01, 0xaa, 0xbb, 0xcc]);
    const frame = decode(buf);
    expect(frame.header).toEqual({ magic: 'LV', verBig: 1, verSmall: 0, type: MessageType.REQ, reqID: 1 });
    expect(frame.body).toEqual(Buffer.from([0xaa, 0xbb, 0xcc]));
  });

  it('handles binary frames (type 100) end-to-end', () => {
    const frame = encode(Buffer.from([0xaa, 0xbb]), { reqID: 7 });
    expect(frame[4]).toBe(MessageType.BIN_RPC);
    const decoded = decode(frame);
    expect(decoded.header.reqID).toBe(7);
    expect(decoded.body).toEqual(Buffer.from([0xaa, 0xbb]));
  });

  it('binary frame without reqID throws', () => {
    expect(() => encode(Buffer.from([1]))).toThrow(CodecError);
  });

  it('returns an empty body for a header-only frame', () => {
    const frame = decode(Buffer.from([0x4c, 0x56, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 0, 0x01]));
    expect(frame.body.length).toBe(0);
  });
});

describe('needsDeserialization', () => {
  it('returns true for non-binary types and false for binary', () => {
    expect(needsDeserialization(MessageType.REQ)).toBe(true);
    expect(needsDeserialization(MessageType.RSP)).toBe(true);
    expect(needsDeserialization(MessageType.BIN_RPC)).toBe(false);
    expect(needsDeserialization(MessageType.BIN_RPC_RSP)).toBe(false);
  });
});

describe('messageTypeOf (instanceof order regression)', () => {
  it('maps each message class to the correct wire type', () => {
    expect(messageTypeOf(new RpcRequest('a', 'b'))).toBe(MessageType.REQ);
    expect(messageTypeOf(new RpcPing())).toBe(MessageType.REQ);
    expect(messageTypeOf(new RpcResponse())).toBe(MessageType.RSP);
    expect(messageTypeOf(new RpcCallbackResponse())).toBe(MessageType.CALLBACK_RSP);
    expect(messageTypeOf(new RpcCallbackReq('uuid', 'fn'))).toBe(MessageType.CALLBACK_REQ);
    expect(messageTypeOf(Buffer.from([1]))).toBe(MessageType.BIN_RPC);
    expect(messageTypeOf(null)).toBe(MessageType.REQ);
  });
});

describe('invariant: callback response is not mistaken for response', () => {
  it('CallbackResponse produces type 4, not 2', () => {
    const frame = encode(new RpcCallbackResponse().setReqID(5));
    expect(frame[4]).toBe(MessageType.CALLBACK_RSP);
  });
});
