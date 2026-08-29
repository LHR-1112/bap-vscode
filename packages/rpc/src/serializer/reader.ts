import {
  STREAM_HEADER,
  TC_NULL,
  TC_REFERENCE,
  TC_CLASSDESC,
  TC_OBJECT,
  TC_STRING,
  TC_ARRAY,
  TC_CLASS,
  TC_LONGSTRING,
  TC_RESET,
} from './constants';
import { StreamReader } from './stream-reader';
import { HandleTable } from './handle-table';
import { MalformedUtf8Error, UnknownClassDescError, CorruptStreamError } from './errors';
import type { ClassDescSpec, FieldSpec, JValue, JTypeCode } from './types';

/** 对象输入流（复刻 Java ObjectInputStream）。 */
export class ObjectInputStream {
  private _sr: StreamReader;
  private _handles: HandleTable;

  constructor(sr = new StreamReader(Buffer.alloc(0)), handles = new HandleTable()) {
    this._sr = sr;
    this._handles = handles;
  }

  /** 校验并消费流头 AC ED 00 05。 */
  readHeader(): void {
    const b = this._sr.readBytes(4);
    if (!b.equals(STREAM_HEADER)) {
      throw new CorruptStreamError(`bad stream header ${b.toString('hex')}, expected aced0005`);
    }
  }

  get position(): number {
    return this._sr.position;
  }

  set position(p: number) {
    this._sr.position = p;
  }

  /** 读取一个对象，返回 JValue。 */
  readObject(): JValue {
    const tag = this._sr.peekByte();
    switch (tag) {
      case TC_NULL:
        this._sr.readByte();
        return { t: 'null' };
      case TC_REFERENCE:
        this._sr.readByte();
        return this._handles.resolve(this._sr.readInt()) as JValue;
      case TC_STRING:
      case TC_LONGSTRING:
        return this.readString();
      case TC_OBJECT:
        return this.readObjectValue();
      case TC_ARRAY:
        return this.readArrayValue();
      case TC_CLASS:
        this._sr.readByte();
        return { t: 'class', fqcn: this.readClassDesc().fqcn };
      case TC_RESET:
        this._sr.readByte();
        this._handles.setNext(0x7e0000);
        return this.readObject();
      default:
        throw new CorruptStreamError(`unexpected tag 0x${tag.toString(16)}`);
    }
  }

  readString(): { t: 'string'; v: string } {
    const tag = this._sr.readByte();
    if (tag === TC_REFERENCE) {
      return this._handles.resolve(this._sr.readInt()) as { t: 'string'; v: string };
    }
    let v: string;
    if (tag === TC_LONGSTRING) {
      const len = this._sr.readLong();
      const bytes = this._sr.readBytes(Number(len));
      v = decodeUtf8Content(bytes);
    } else {
      v = this._sr.readModifiedUtf8();
    }
    const result: { t: 'string'; v: string } = { t: 'string', v };
    this._handles.assign(v);
    return result;
  }

  /** 读 classdesc（TC_CLASSDESC + super 链），返回 ClassDescSpec。 */
  readClassDesc(): ClassDescSpec {
    const tag = this._sr.readByte();
    if (tag === TC_NULL) {
      return { fqcn: '', serialVersionUID: 0n, flags: 0, fields: [], superName: null };
    }
    if (tag === TC_REFERENCE) {
      return this._handles.resolve(this._sr.readInt()) as ClassDescSpec;
    }
    if (tag !== TC_CLASSDESC) {
      throw new CorruptStreamError(`expected TC_CLASSDESC, got 0x${tag.toString(16)}`);
    }
    const fqcn = this._sr.readModifiedUtf8();
    if (fqcn) this._handles.assign(fqcn); // 先分配 classdesc 自身 handle（与 writer 顺序对齐）
    const serialVersionUID = this._sr.readLong();
    const flags = this._sr.readByte();
    const fieldCount = this._sr.readUint16();
    const fields: FieldSpec[] = [];
    for (let i = 0; i < fieldCount; i++) {
      const tc = this._sr.readByte();
      const typeCode = byteToTypeCode(tc);
      const name = this._sr.readModifiedUtf8();
      let typeString: string | undefined;
      if (typeCode === 'L' || typeCode === '[') {
        typeString = this.readTypeString();
      }
      fields.push({ typeCode, name, typeString });
    }
    this._sr.readByte(); // 类注解 TC_ENDBLOCKDATA（0x78）
    const superCl = this.readClassDesc();
    const spec: ClassDescSpec = {
      fqcn,
      serialVersionUID,
      flags,
      fields,
      superName: superCl.fqcn === '' ? null : superCl.fqcn,
    };
    // 挂上完整 super spec（含其 fields/superName），供 readFieldsChain 递归取值。
    if (superCl.fqcn !== '') {
      (spec as unknown as { superSpec?: ClassDescSpec }).superSpec = superCl;
    }
    return spec;
  }

  private readTypeString(): string | undefined {
    const tag = this._sr.peekByte();
    if (tag === TC_NULL) {
      this._sr.readByte();
      return undefined;
    }
    // typeString 用 writeString 语义：TC_STRING(0x74) + UTF，或 TC_REFERENCE。
    if (tag === TC_REFERENCE) {
      this._sr.readByte(); // 消费 TC_REFERENCE
      const h = this._sr.readInt();
      const r = this._handles.resolve(h);
      return typeof r === 'string' ? r : String(r);
    }
    this._sr.readByte(); // TC_STRING
    const s = this._sr.readModifiedUtf8();
    this._handles.assign(s);
    return s;
  }

  /** 读一个 TC_OBJECT：classdesc + 字段数据；按 fqcn 解释集合类。 */
  private readObjectValue(): JValue {
    this._sr.readByte(); // TC_OBJECT
    const spec = this.readClassDesc();
    if (spec.fqcn === 'java.util.HashMap') return this.readHashMap(spec);
    if (spec.fqcn === 'java.util.ArrayList') return this.readList(spec);
    if (spec.fqcn === 'java.util.HashSet') return this.readSet(spec);
    return this.readBean(spec);
  }

  private readBean(spec: ClassDescSpec): JValue {
    // 读整条 classdesc 链的字段数据（子类先、super 后）。这里按子树展开。
    const values = this.readFieldsChain(spec);
    return { t: 'bean', fqcn: spec.fqcn, values };
  }

  /** 递归读 super 链上所有字段（子类字段先写，故先读子类再读 super）。 */
  private readFieldsChain(spec: ClassDescSpec): Record<string, JValue> {
    const all: Record<string, JValue> = {};
    const parent = (spec as unknown as { superSpec?: ClassDescSpec }).superSpec;
    if (parent) {
      Object.assign(all, this.readFieldsChain(parent));
    } else if (spec.superName) {
      // 无内嵌 spec 时的兜底：尝试从注册表取，否则忽略（消息类一般有内嵌 superSpec）。
      const parentSpec = this.getSuperSpec(spec.superName);
      if (parentSpec) Object.assign(all, this.readFieldsChain(parentSpec));
    }
    for (const f of spec.fields) {
      if (isPrimitiveType(f.typeCode)) {
        all[f.name] = this.readPrimitiveField(f);
      } else {
        all[f.name] = this.readRefField();
      }
    }
    return all;
  }

  private getSuperSpec(name: string): ClassDescSpec | null {
    // super 链完整 spec 依赖注册表；若读侧是通用解析（未知 RPC 类）则无法回退。
    // 仅在「无内嵌 superSpec 且确实要向上读」时用到。消息类均能靠内嵌 superSpec 覆盖。
    return null;
  }

  private readPrimitiveField(f: FieldSpec): JValue {
    switch (f.typeCode) {
      case 'J':
        return { t: 'long', v: this._sr.readLong() };
      case 'I':
        return { t: 'int', v: this._sr.readInt() };
      case 'S':
        return { t: 'short', v: this._sr.readInt16() };
      case 'B':
        return { t: 'byte', v: this._sr.readByte() };
      case 'C':
        return { t: 'char', v: this._sr.readUint16() };
      case 'F':
        return { t: 'float', v: this._sr.readFloat() };
      case 'D':
        return { t: 'double', v: this._sr.readDouble() };
      case 'Z':
        return { t: 'boolean', v: this._sr.readByte() !== 0 };
      default:
        throw new CorruptStreamError(`unexpected primitive typeCode ${f.typeCode}`);
    }
  }

  private readRefField(): JValue {
    return this.readObject();
  }

  /** 读 HashMap（SC_WRITE_METHOD：defaultWriteObject 2 字段裸读 + blockdata 后跟对象直到 78）。 */
  private readHashMap(spec: ClassDescSpec): JValue {
    // defaultWriteObject: loadFactor + threshold（裸读主流）
    this._sr.readFloat();
    this._sr.readInt();
    // 读一个 blockdata（capacity + size）
    const body = this._sr.readBlockData();
    const capSize = new StreamReader(body);
    capSize.readInt(); // capacity 丢弃
    const size = capSize.readInt();
    // 之后 key/value 在主流，直到 78 结束
    const entries: [JValue, JValue][] = [];
    for (let i = 0; i < size; i++) {
      const k = this.readObject();
      const v = this.readObject();
      entries.push([k, v]);
    }
    this.consumeEndBlockData();
    return { t: 'map', entries };
  }

  private readList(spec: ClassDescSpec): JValue {
    if (spec.fields.some((f) => f.name === 'size')) this._sr.readInt(); // defaultWriteObject size 裸读
    const body = this._sr.readBlockData();
    const sub = new StreamReader(body);
    const size = sub.readInt();
    const elems: JValue[] = [];
    for (let i = 0; i < size; i++) elems.push(this.readObject());
    this.consumeEndBlockData();
    return { t: 'list', fqcn: spec.fqcn, elems };
  }

  private readSet(spec: ClassDescSpec): JValue {
    const body = this._sr.readBlockData();
    const sub = new StreamReader(body);
    const size = sub.readInt();
    const elems: JValue[] = [];
    for (let i = 0; i < size; i++) elems.push(this.readObject());
    this.consumeEndBlockData();
    return { t: 'set', fqcn: spec.fqcn, elems };
  }

  /** 消费一个或多个 blockdata 之后的 TC_ENDBLOCKDATA（0x78）。 */
  private consumeEndBlockData(): void {
    // 若还有额外 blockdata 块（大集合分块），先读空；最后读 0x78。
    while (!this._sr.peekEndBlockData()) {
      this._sr.readBlockData();
    }
    this._sr.readEndBlockData();
  }

  private readArrayValue(): JValue {
    this._sr.readByte(); // TC_ARRAY
    const spec = this.readClassDesc();
    const desc = spec.fqcn.startsWith('[') ? spec.fqcn : '';
    const n = this._sr.readInt();
    const elemType = arrayElemType(desc);
    if (elemType === 'byte') {
      // [B 是原始字节
      return { t: 'bytes', v: this._sr.readBytes(n) };
    }
    if (isPrimitiveArray(desc)) {
      // 其它 primitive 数组：连续 primitive 值，不带对象 tag
      const elems: JValue[] = [];
      for (let i = 0; i < n; i++) elems.push(readPrimitiveArrayElem(this._sr, elemType));
      return { t: 'array', fqcn: desc, elems };
    }
    // 对象数组：逐个 readObject
    const elems: JValue[] = [];
    for (let i = 0; i < n; i++) elems.push(this.readObject());
    return { t: 'array', fqcn: desc, elems };
  }
}

function arrayElemType(desc: string): string {
  if (desc === '[B') return 'byte';
  if (desc === '[I') return 'int';
  if (desc === '[C') return 'char';
  if (desc === '[J') return 'long';
  if (desc === '[S') return 'short';
  if (desc === '[F') return 'float';
  if (desc === '[D') return 'double';
  if (desc === '[Z') return 'boolean';
  return 'ref';
}

function isPrimitiveArray(desc: string): boolean {
  const t = arrayElemType(desc);
  return t !== 'ref' && t !== 'byte';
}

function readPrimitiveArrayElem(sr: StreamReader, elemType: string): JValue {
  switch (elemType) {
    case 'int':
      return { t: 'int', v: sr.readInt() };
    case 'char':
      return { t: 'char', v: sr.readUint16() };
    case 'long':
      return { t: 'long', v: sr.readLong() };
    case 'short':
      return { t: 'short', v: sr.readInt16() };
    case 'float':
      return { t: 'float', v: sr.readFloat() };
    case 'double':
      return { t: 'double', v: sr.readDouble() };
    case 'boolean':
      return { t: 'boolean', v: sr.readByte() !== 0 };
    default:
      throw new CorruptStreamError(`unexpected primitive array elem '${elemType}'`);
  }
}

function byteToTypeCode(b: number): JTypeCode {
  const map: Record<number, JTypeCode> = {
    0x42: 'B', 0x43: 'C', 0x44: 'D', 0x46: 'F', 0x49: 'I', 0x4a: 'J', 0x53: 'S', 0x5a: 'Z',
    0x4c: 'L', 0x5b: '[',
  };
  return map[b] ?? 'L';
}

function isPrimitiveType(tc: string): boolean {
  return tc !== 'L' && tc !== '[';
}

function decodeUtf8Content(bytes: Buffer): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i];
    if ((b0 & 0x80) === 0) {
      out += String.fromCharCode(b0);
      i += 1;
    } else if ((b0 & 0xe0) === 0xc0) {
      out += String.fromCharCode(((b0 & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
      i += 2;
    } else if ((b0 & 0xf0) === 0xe0) {
      out += String.fromCharCode(((b0 & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f));
      i += 3;
    } else {
      throw new MalformedUtf8Error();
    }
  }
  return out;
}
