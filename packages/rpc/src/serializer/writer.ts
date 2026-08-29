import {
  STREAM_HEADER,
  TC_NULL,
  TC_REFERENCE,
  TC_CLASSDESC,
  TC_OBJECT,
  TC_STRING,
  TC_ARRAY,
  TC_BLOCKDATA,
  TC_BLOCKDATALONG,
} from './constants';
import { StreamWriter } from './stream-writer';
import { HandleTable } from './handle-table';
import { classDescOf, arrayClassDesc } from './classdesc';
import { UnsupportedTypeError } from './errors';
import type { ClassDescSpec, FieldSpec, JValue } from './types';

const TC_STRING_TOP = 0x74; // TC_STRING
const TC_ARRAY_TOP = 0x75; // TC_ARRAY

/** 对象输出流（复刻 Java ObjectOutputStream）。 */
export class ObjectOutputStream {
  private _sw: StreamWriter;
  private _handles: HandleTable;

  constructor(sw = new StreamWriter(), handles = new HandleTable()) {
    this._sw = sw;
    this._handles = handles;
  }

  writeHeader(): void {
    this._sw.writeBytes(STREAM_HEADER);
  }

  getBytes(): Buffer {
    return this._sw.toBytes();
  }

  writeObject(v: JValue): void {
    switch (v.t) {
      case 'null':
        this._sw.writeByte(TC_NULL);
        break;
      case 'string':
        this.writeString(v.v);
        break;
      case 'int':
        this._sw.writeInt(v.v);
        break;
      case 'long':
        this._sw.writeLong(v.v);
        break;
      case 'short':
        this._sw.writeShort(v.v);
        break;
      case 'byte':
        this._sw.writeByte(v.v);
        break;
      case 'char':
        this._sw.writeUint16(v.v);
        break;
      case 'float':
        this._sw.writeFloat(v.v);
        break;
      case 'double':
        this._sw.writeDouble(v.v);
        break;
      case 'boolean':
        this._sw.writeByte(v.v ? 1 : 0);
        break;
      case 'bytes':
        this.writeBytesValue(v.v);
        break;
      case 'array':
        this.writeArray(v.fqcn, v.elems);
        break;
      case 'bean':
        this.writeBean(v.fqcn, v.values);
        break;
      case 'map':
        this.writeHashMap(v.entries);
        break;
      case 'list':
        this.writeList(v.fqcn, v.elems);
        break;
      case 'set':
        this.writeSet(v.fqcn, v.elems);
        break;
      case 'bigint':
      case 'class':
        throw new UnsupportedTypeError(`unsupported JValue type '${v.t}'`);
    }
  }

  /** 写一个字符串对象（TC_STRING 或 TC_REFERENCE）。 */
  writeString(s: string): void {
    const existing = this._handles.lookup(s);
    if (existing !== undefined) {
      this.writeHandle(existing);
      return;
    }
    this._sw.writeByte(TC_STRING);
    this._sw.writeModifiedUtf8(s);
    this._handles.assign(s);
  }

  writeHandle(h: number): void {
    this._sw.writeByte(TC_REFERENCE);
    this._sw.writeInt(h);
  }

  /** 写字节数组 [B。 */
  writeBytesValue(b: Buffer): void {
    this.writeArray('[B', Array.from(b).map((x) => ({ t: 'byte', v: x } as JValue)));
  }

  /** 写数组（TC_ARRAY + classdesc + 4B 长度 + 元素）。 */
  writeArray(desc: string, elems: JValue[]): void {
    this._sw.writeByte(TC_ARRAY);
    this.writeClassDesc(arrayClassDesc(desc));
    this._sw.writeInt(elems.length);
    for (const e of elems) {
      if (this._handles.lookup(e) !== undefined) {
        this.writeHandle(this._handles.lookup(e)!);
      } else {
        this._handles.assign(e);
        this.writeObject(e);
      }
    }
  }

  /** 写一个普通字段 bean（TC_OBJECT + classdesc + 字段数据）。 */
  writeBean(fqcn: string, values: Record<string, JValue>): void {
    const spec = classDescOf(fqcn);
    if (!spec) throw new UnsupportedTypeError(`no classdesc registered for ${fqcn}`);
    this._sw.writeByte(TC_OBJECT);
    this.writeClassDesc(spec);
    this.writeFieldData(spec, values);
    this._handles.assign(values);
  }

  /** 写 HashMap（SC_WRITE_METHOD：defaultWriteObject 字段裸写 + writeInt 进 blockdata + 对象裸写主流）。 */
  writeHashMap(entries: [JValue, JValue][]): void {
    const spec = classDescOf('java.util.HashMap');
    if (!spec) throw new UnsupportedTypeError('no classdesc registered for java.util.HashMap');
    this._sw.writeByte(TC_OBJECT);
    this.writeClassDesc(spec);
    // defaultWriteObject：loadFactor(F) + threshold(I) 裸写主流
    this._sw.writeFloat(0.75);
    this._sw.writeInt(12);
    // writeInt(capacity) + writeInt(size)：自动 drain 成一个 blockdata 块（77 08 [cap][size]）
    const capBuf = Buffer.alloc(8);
    capBuf.writeInt32BE(16, 0);
    capBuf.writeInt32BE(entries.length, 4);
    this.writeBlockData(capBuf);
    // writeObject(key)/writeObject(value)：直接主流
    for (const [k, v] of entries) {
      this.writeBlockObject(k);
      this.writeBlockObject(v);
    }
    // 结束 SC_WRITE_METHOD 内容
    this._sw.writeByte(0x78); // TC_ENDBLOCKDATA
    this._handles.assign(entries);
  }

  /** 输出一段原始字节作为单个 blockdata 块（≤255 用 0x77，>255 用 0x7A）。 */
  private writeBlockData(buf: Buffer): void {
    if (buf.length <= 255) {
      this._sw.writeByte(TC_BLOCKDATA);
      this._sw.writeByte(buf.length);
      this._sw.writeBytes(buf);
    } else {
      this._sw.writeByte(TC_BLOCKDATALONG);
      this._sw.writeInt(buf.length);
      this._sw.writeBytes(buf);
    }
  }

  /** 写集合（ArrayList 等，SC_WRITE_METHOD：size 字段裸写 + blockdata + 元素裸写）。 */
  writeList(fqcn: string, elems: JValue[]): void {
    const spec = classDescOf(fqcn);
    if (!spec) throw new UnsupportedTypeError(`no classdesc registered for ${fqcn}`);
    this._sw.writeByte(TC_OBJECT);
    this.writeClassDesc(spec);
    // defaultWriteObject: size 字段裸写
    if (spec.fields.some((f) => f.name === 'size')) {
      this._sw.writeInt(elems.length);
    }
    // writeInt(size) 进 blockdata
    const sizeBuf = Buffer.alloc(4);
    sizeBuf.writeInt32BE(elems.length, 0);
    this.writeBlockData(sizeBuf);
    // 元素裸写主流
    for (const e of elems) this.writeBlockObject(e);
    this._sw.writeByte(0x78);
    this._handles.assign(elems);
  }

  writeSet(fqcn: string, elems: JValue[]): void {
    const spec = classDescOf(fqcn);
    if (!spec) throw new UnsupportedTypeError(`no classdesc registered for ${fqcn}`);
    this._sw.writeByte(TC_OBJECT);
    this.writeClassDesc(spec);
    const sizeBuf = Buffer.alloc(4);
    sizeBuf.writeInt32BE(elems.length, 0);
    this.writeBlockData(sizeBuf);
    for (const e of elems) this.writeBlockObject(e);
    this._sw.writeByte(0x78);
    this._handles.assign(elems);
  }

  /** 写 classdesc（handle 顺序：先 assign classdesc 自身，再 assign 字段 typeString，再 super）。 */
  writeClassDesc(spec: ClassDescSpec): void {
    this._sw.writeByte(TC_CLASSDESC);
    this._handles.assign(spec.fqcn); // 先分配 classdesc 自身 handle（Java 语义）
    this._sw.writeModifiedUtf8(spec.fqcn);
    this._sw.writeLong(spec.serialVersionUID);
    this._sw.writeByte(spec.flags);
    this._sw.writeUint16(spec.fields.length);
    for (const f of spec.fields) {
      this._sw.writeByte(typeCodeToByte(f.typeCode));
      this._sw.writeModifiedUtf8(f.name);
      if (f.typeCode === 'L' || f.typeCode === '[') {
        this.writeTypeString(f.typeString);
      }
    }
    this._sw.writeByte(0x78); // TC_ENDBLOCKDATA（类注解）
    if (spec.superName === null) {
      this._sw.writeByte(TC_NULL);
    } else {
      this.writeClassDesc(classDescOf(spec.superName)!);
    }
  }

  /** 写 typeString：String 对象，占一个 handle。typeString 为完整描述符（如 `Ljava.lang.String;`、`[Ljava.lang.Object;`）。 */
  private writeTypeString(typeString: string | undefined): void {
    if (!typeString) {
      this._sw.writeByte(TC_NULL);
      return;
    }
    this.writeString(typeString);
  }

  /** 按 classdesc 字段顺序写字段数据（primitive 先、引用后，已在 spec.fields 排序）。 */
  private writeFieldData(spec: ClassDescSpec, values: Record<string, JValue>): void {
    for (const f of spec.fields) {
      const v = values[f.name];
      if (isPrimitiveType(f.typeCode)) {
        this.writePrimitiveField(f, v);
      } else {
        this.writeRefField(v);
      }
    }
  }

  private writePrimitiveField(f: FieldSpec, v: JValue | undefined): void {
    const val = v ?? { t: 'null' };
    switch (f.typeCode) {
      case 'J':
        this._sw.writeLong(val.t === 'long' ? val.v : val.t === 'int' ? BigInt(val.v) : 0n);
        break;
      case 'I':
        this._sw.writeInt(val.t === 'int' ? val.v : 0);
        break;
      case 'S':
        this._sw.writeShort(val.t === 'short' ? val.v : 0);
        break;
      case 'B':
        this._sw.writeByte(val.t === 'byte' ? val.v : 0);
        break;
      case 'C':
        this._sw.writeUint16(val.t === 'char' ? val.v : val.t === 'int' ? val.v : 0);
        break;
      case 'F':
        this._sw.writeFloat(val.t === 'float' ? val.v : val.t === 'double' ? val.v : 0);
        break;
      case 'D':
        this._sw.writeDouble(val.t === 'double' ? val.v : 0);
        break;
      case 'Z':
        this._sw.writeByte(val.t === 'boolean' ? (val.v ? 1 : 0) : 0);
        break;
      default:
        throw new UnsupportedTypeError(`unexpected primitive typeCode ${f.typeCode}`);
    }
  }

  private writeRefField(v: JValue | undefined): void {
    if (!v || v.t === 'null') {
      this._sw.writeByte(TC_NULL);
      return;
    }
    const h = this._handles.lookup(v);
    if (h !== undefined) {
      this.writeHandle(h);
      return;
    }
    this._handles.assign(v);
    this.writeObject(v);
  }

  /** blockdata 模式里写一个对象：嵌套的是完整对象（引用或新写）。 */
  private writeBlockObject(v: JValue): void {
    if (v.t === 'null') {
      this._sw.writeByte(TC_NULL);
      return;
    }
    const h = this._handles.lookup(v);
    if (h !== undefined) {
      this.writeHandle(h);
      return;
    }
    this._handles.assign(v);
    this.writeObject(v);
  }
}

function typeCodeToByte(tc: string): number {
  const map: Record<string, number> = {
    B: 0x42, C: 0x43, D: 0x44, F: 0x46, I: 0x49, J: 0x4a, S: 0x53, Z: 0x5a,
    L: 0x4c, '[': 0x5b,
  };
  return map[tc] ?? 0x4c;
}

function isPrimitiveType(tc: string): boolean {
  return tc !== 'L' && tc !== '[';
}
