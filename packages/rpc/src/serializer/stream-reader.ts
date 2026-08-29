import { TC_BLOCKDATA, TC_BLOCKDATALONG, TC_ENDBLOCKDATA } from './constants';
import { decodeModifiedUtf8 } from './stream-writer';
import { CorruptStreamError, MalformedUtf8Error } from './errors';

/** 底层字节读取流。pos 从 0 起。 */
export class StreamReader {
  constructor(
    private _buf: Buffer,
    private _pos = 0,
  ) {}

  get position(): number {
    return this._pos;
  }

  set position(p: number) {
    this._pos = p;
  }

  get length(): number {
    return this._buf.length;
  }

  get remaining(): number {
    return this._buf.length - this._pos;
  }

  peekByte(): number {
    if (this._pos >= this._buf.length) throw new CorruptStreamError('stream overrun while peeking');
    return this._buf[this._pos];
  }

  readByte(): number {
    if (this._pos >= this._buf.length) throw new CorruptStreamError('stream overrun');
    return this._buf[this._pos++];
  }

  readUint16(): number {
    this._need(2);
    const v = this._buf.readUInt16BE(this._pos);
    this._pos += 2;
    return v;
  }

  readShort(): number {
    return this.readInt16();
  }

  readInt16(): number {
    this._need(2);
    const v = this._buf.readInt16BE(this._pos);
    this._pos += 2;
    return v;
  }

  readInt(): number {
    this._need(4);
    const v = this._buf.readInt32BE(this._pos);
    this._pos += 4;
    return v;
  }

  readLong(): bigint {
    this._need(8);
    const v = this._buf.readBigInt64BE(this._pos);
    this._pos += 8;
    return v;
  }

  readFloat(): number {
    this._need(4);
    const v = this._buf.readFloatBE(this._pos);
    this._pos += 4;
    return v;
  }

  readDouble(): number {
    this._need(8);
    const v = this._buf.readDoubleBE(this._pos);
    this._pos += 8;
    return v;
  }

  /** 读原始字节（会推进 pos）。 */
  readBytes(n: number): Buffer {
    this._need(n);
    const v = this._buf.subarray(this._pos, this._pos + n);
    this._pos += n;
    return v;
  }

  readModifiedUtf8(): string {
    const start = this._pos;
    const len = this.readUint16();
    this._need(len);
    const { str } = decodeModifiedUtf8(this._buf, start);
    this._pos += len; // 跳到内容末尾（内容长度 = len）
    return str;
  }

  // —— blockdata ——

  /** 读一个 blockdata 块（0x77 / 0x7A），返回原始内容并推进。 */
  readBlockData(): Buffer {
    const tag = this.readByte();
    if (tag === TC_BLOCKDATA) {
      const len = this.readByte();
      return this.readBytes(len);
    }
    if (tag === TC_BLOCKDATALONG) {
      const len = this.readInt();
      return this.readBytes(len);
    }
    throw new CorruptStreamError(`expected blockdata, got tag 0x${tag.toString(16)}`);
  }

  /** 读到 TC_ENDBLOCKDATA（0x78）。若下个字节是 0x78 则消费掉并返回 true。 */
  peekEndBlockData(): boolean {
    if (this._pos >= this._buf.length) return false;
    return this._buf[this._pos] === TC_ENDBLOCKDATA;
  }

  readEndBlockData(): void {
    this._need(1);
    const tag = this.readByte();
    if (tag !== TC_ENDBLOCKDATA) {
      throw new CorruptStreamError(`expected TC_ENDBLOCKDATA, got 0x${tag.toString(16)}`);
    }
  }

  private _need(n: number): void {
    if (this._pos + n > this._buf.length) {
      throw new CorruptStreamError('stream overrun');
    }
  }
}

export { CorruptStreamError, MalformedUtf8Error };
