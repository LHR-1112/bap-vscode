// JValue：TS 侧对「可序列化的 Java 值」的 AST 表示。
// writer 按 JValue.t 分派写字节；reader 产出的也是 JValue，再由 fromJava 转回 JS。

export type JTypeCode = 'B' | 'C' | 'D' | 'F' | 'I' | 'J' | 'S' | 'Z' | 'L' | '[';

export type JPrimitive =
  | { t: 'null' }
  | { t: 'int'; v: number }
  | { t: 'long'; v: bigint | number }
  | { t: 'short'; v: number }
  | { t: 'byte'; v: number }
  | { t: 'char'; v: number }
  | { t: 'float'; v: number }
  | { t: 'double'; v: number }
  | { t: 'boolean'; v: boolean };

export type JRef =
  | { t: 'string'; v: string }
  | { t: 'bean'; fqcn: string; values: Record<string, JValue> }
  | { t: 'array'; fqcn: string; elems: JValue[] }
  | { t: 'bytes'; v: Buffer }
  | { t: 'map'; entries: [JValue, JValue][] }
  | { t: 'list'; fqcn: string; elems: JValue[] }
  | { t: 'set'; fqcn: string; elems: JValue[] }
  | { t: 'bigint'; v: { signum: number; mag: number[] } }
  | { t: 'class'; fqcn: string };

export type JValue = JRef | JPrimitive;

/** classdesc 里的一个字段描述。 */
export interface FieldSpec {
  typeCode: JTypeCode;
  name: string;
  /** typeCode 为 'L' 或 '[' 时必填。'L' → FQCN（去前导 L 与分号）；'[' → 原样描述符。 */
  typeString?: string;
}

/** 一个类的序列化描述。 */
export interface ClassDescSpec {
  fqcn: string;
  serialVersionUID: bigint;
  flags: number;
  fields: FieldSpec[]; // 已按 ObjectStreamField 排序：primitive 在前、同名组按字典序
  superName: string | null;
  hasWriteMethod?: boolean;
}
