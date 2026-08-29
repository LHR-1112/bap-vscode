import { TC_BLOCKDATA, TC_BLOCKDATALONG, TC_ENDBLOCKDATA, BLOCK_DATA_MAX } from './constants';
import { MalformedUtf8Error } from './errors';

/** 写 modified UTF-8（CESU-8）。返回字节数。 */
export function encodeModifiedUtf8(s: string): Buffer {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      if (c === 0x00) {
        bytes.push(0xc0, 0x80); // U+0000 → CESU-8 双字节
      } else {
        bytes.push(c);
      }
    } else if (c < 0x800) {
      bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else {
      // BMP 外字符在 JS 里已是 surrogate pair（两个 code unit 各 0xE000..0xFFFF），
      // CESU-8 对每个 surrogate 单独编 3 字节，正好落在这个分支。
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return Buffer.from(bytes);
}

/** 读 modified UTF-8（CESU-8）。buf 从 pos 开始，返回解码字符串 + 消耗字节数。 */
export function decodeModifiedUtf8(buf: Buffer, pos: number): { str: string; bytes: number } {
  const len = buf.readUInt16BE(pos);
  let p = pos + 2;
  const end = p + len;
  let out = '';
  while (p < end) {
    const b0 = buf[p];
    let cp: number;
    let n: number;
    if ((b0 & 0x80) === 0) {
      cp = b0;
      n = 1;
    } else if ((b0 & 0xe0) === 0xc0) {
      if (p + 1 >= end) throw new MalformedUtf8Error();
      const b1 = buf[p + 1];
      cp = ((b0 & 0x1f) << 6) | (b1 & 0x3f);
      n = 2;
    } else if ((b0 & 0xf0) === 0xe0) {
      if (p + 2 >= end) throw new MalformedUtf8Error();
      const b1 = buf[p + 1];
      const b2 = buf[p + 2];
      cp = ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f);
      n = 3;
    } else {
      throw new MalformedUtf8Error();
    }
    if (cp === 0x00) throw new MalformedUtf8Error(); // 长格式零不在合法序列中出现
    out += String.fromCharCode(cp);
    p += n;
  }
  return { str: out, bytes: len + 2 };
}

/** 底层字节写入流。非 blockdata 模式下原始字节直接落流。 */
export class StreamWriter {
  private _chunks: Buffer[] = [];
  private _len = 0;

  // —— blockdata 缓冲（模拟 BlockDataOutputStream）——
  private _blockBuf: number[] = [];
  private _blocking = false;

  writeByte(b: number): void {
    this._rawWrite(Buffer.from([b & 0xff]));
  }

  writeBytes(b: Buffer): void {
    this._rawWrite(b);
  }

  writeInt(v: number): void {
    this._rawWrite(Buffer.from([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]));
  }

  writeUint16(v: number): void {
    this._rawWrite(Buffer.from([(v >>> 8) & 0xff, v & 0xff]));
  }

  writeShort(v: number): void {
    this.writeUint16(v & 0xffff);
  }

  writeLong(v: bigint | number): void {
    const b = Buffer.alloc(8);
    b.writeBigInt64BE(BigInt(v), 0);
    this._rawWrite(b);
  }

  writeFloat(v: number): void {
    const b = Buffer.alloc(4);
    b.writeFloatBE(v, 0);
    this._rawWrite(b);
  }

  writeDouble(v: number): void {
    const b = Buffer.alloc(8);
    b.writeDoubleBE(v, 0);
    this._rawWrite(b);
  }

  /** 写 modified UTF-8，前置 2 字节长度。 */
  writeModifiedUtf8(s: string): void {
    const enc = encodeModifiedUtf8(s);
    this.writeUint16(enc.length);
    this.writeBytes(enc);
  }

  // —— blockdata ——

  beginBlock(): void {
    this._blocking = true;
    this._blockBuf = [];
  }

  endBlock(): void {
    this.flushBlock();
    this._blocking = false;
    this.writeByte(TC_ENDBLOCKDATA);
  }

  /** 把当前 blockdata 缓冲写入流（<==0x77 或 >255 用 0x7A），并按需分块。 */
  flushBlock(): void {
    if (this._blockBuf.length === 0) return;
    const buf = this._blockBuf;
    this._blockBuf = [];
    const wasBlocking = this._blocking;
    this._blocking = false;
    const len = buf.length;
    if (len <= 255) {
      const header = Buffer.from([TC_BLOCKDATA, len]);
      this._rawWrite(header);
      this._rawWrite(Buffer.from(buf));
    } else {
      const b = Buffer.alloc(5);
      b[0] = TC_BLOCKDATALONG;
      b.writeInt32BE(len, 1);
      this._rawWrite(b);
      this._rawWrite(Buffer.from(buf));
    }
    this._blocking = wasBlocking;
  }

  /** blockdata 模式下写原始字节（进入缓冲）。 */
  writeBlockBytes(b: Buffer): void {
    for (const x of b) {
      this._blockBuf.push(x);
      if (this._blockBuf.length >= BLOCK_DATA_MAX) {
        // TCP 分块边界：900 字节左右符合 Java 行为；这里取一个安全上界
        if (this._blockBuf.length >= 900) {
          this.flushBlock();
        }
      }
    }
  }

  toBytes(): Buffer {
    return Buffer.concat(this._chunks);
  }

  private _rawWrite(b: Buffer): void {
    if (this._blocking) {
      this.writeBlockBytes(b);
    } else {
      this._chunks.push(b);
      this._len += b.length;
    }
  }
}
