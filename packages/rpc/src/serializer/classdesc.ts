import type { ClassDescSpec, FieldSpec, JTypeCode } from './types';

/** FQCN → ClassDescSpec 注册表。 */
const REGISTRY = new Map<string, ClassDescSpec>();

function register(spec: ClassDescSpec): void {
  REGISTRY.set(spec.fqcn, spec);
}

/**
 * ObjectStreamField 排序规则：primitive 在前，引用在后；同组内按字段名字典序。
 * 这是 JDK 默认序列化的字段写入顺序，不可用声明顺序替代。
 */
export function orderFields(fields: FieldSpec[]): FieldSpec[] {
  const prim = fields.filter((f) => !isRefType(f.typeCode));
  const ref = fields.filter((f) => isRefType(f.typeCode));
  prim.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  ref.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return [...prim, ...ref];
}

function isRefType(tc: JTypeCode): boolean {
  return tc === 'L' || tc === '[';
}

/**
 * 关键：Java 序列化时，classdesc 的 super 链只保留到「最近的可 Serializable 祖先」。
 * 非 Serializable 的中间类（如 AbstractMap、AbstractList、Number 除外——Number 实现了 Serializable）
 * 会被跳过，direct super 写 TC_NULL。这些 SUID 由本机 JDK 生成确认。
 */

// String（序列化时走 TC_STRING，不进 classdesc；此处仅占位）
register({ fqcn: 'java.lang.String', serialVersionUID: -6849794470754667710n, flags: 0x02, fields: [], superName: null });

// boxed primitives：字段 value，super = java.lang.Number（Number 实现 Serializable）
const NUMBER_SUID = -8742448824652078965n;
register({ fqcn: 'java.lang.Number', serialVersionUID: NUMBER_SUID, flags: 0x02, fields: [], superName: null });
function registerBoxed(fqcn: string, suid: bigint, typeCode: JTypeCode): void {
  register({ fqcn, serialVersionUID: suid, flags: 0x02, fields: orderFields([{ typeCode, name: 'value' }]), superName: 'java.lang.Number' });
}
registerBoxed('java.lang.Byte', -7183698231559129828n, 'B');
registerBoxed('java.lang.Short', 7515723908773894738n, 'S');
registerBoxed('java.lang.Integer', 1360826667806852920n, 'I');
registerBoxed('java.lang.Long', 4290774380558885855n, 'J');
registerBoxed('java.lang.Float', -2671257302660747028n, 'F');
registerBoxed('java.lang.Double', -9172774392245257468n, 'D');
registerBoxed('java.lang.Boolean', -3665804199014368530n, 'Z');
registerBoxed('java.lang.Character', 3786198910865385080n, 'C');

// HashMap：loadFactor/threshold 两 primitive 字段 + blockdata；super = TC_NULL（AbstractMap 非 Serializable）
register({
  fqcn: 'java.util.HashMap',
  serialVersionUID: 362498820763181265n,
  flags: 0x03,
  fields: orderFields([
    { typeCode: 'F', name: 'loadFactor' },
    { typeCode: 'I', name: 'threshold' },
  ]),
  superName: null,
  hasWriteMethod: true,
});

// ArrayList：有一个 size(int) 字段 + blockdata；super = TC_NULL
register({
  fqcn: 'java.util.ArrayList',
  serialVersionUID: 8683452581122892189n,
  flags: 0x03,
  fields: orderFields([{ typeCode: 'I', name: 'size' }]),
  superName: null,
  hasWriteMethod: true,
});
// HashSet：fields=[] + blockdata；super = TC_NULL
register({
  fqcn: 'java.util.HashSet',
  serialVersionUID: -5024744406713321676n,
  flags: 0x03,
  fields: [],
  superName: null,
  hasWriteMethod: true,
});

// —— RPC 消息类 ——
register({
  fqcn: 'com.leavay.nio.crpc.CRpcRequest',
  serialVersionUID: -1633332440464342459n,
  flags: 0x02,
  fields: orderFields([
    { typeCode: 'J', name: 'reqID' },
    { typeCode: 'L', name: 'className', typeString: 'Ljava.lang.String;' },
    { typeCode: 'L', name: 'context', typeString: 'Ljava.util.Map;' },
    { typeCode: 'L', name: 'function', typeString: 'Ljava.lang.String;' },
    { typeCode: '[', name: 'params', typeString: '[Ljava.lang.Object;' },
    { typeCode: 'L', name: 'reqType', typeString: 'Ljava.lang.Byte;' },
  ]),
  superName: null,
});
register({ fqcn: 'com.leavay.nio.crpc.CRpcPing', serialVersionUID: -8138770142334216875n, flags: 0x02, fields: [], superName: 'com.leavay.nio.crpc.CRpcRequest' });
register({
  fqcn: 'com.leavay.nio.crpc.CRpcResponse',
  serialVersionUID: -7372457506299215092n,
  flags: 0x02,
  fields: orderFields([
    { typeCode: 'J', name: 'reqID' },
    { typeCode: 'L', name: 'err', typeString: 'Ljava.lang.Throwable;' },
    { typeCode: 'L', name: 'result', typeString: 'Ljava.lang.Object;' },
  ]),
  superName: null,
});
register({ fqcn: 'com.leavay.nio.crpc.CRpcCallbackResponse', serialVersionUID: 3365497898153568705n, flags: 0x02, fields: [], superName: 'com.leavay.nio.crpc.CRpcResponse' });
register({
  fqcn: 'com.leavay.nio.crpc.CRpcCallbackReq',
  serialVersionUID: 5719747337106040652n,
  flags: 0x02,
  fields: orderFields([
    { typeCode: 'J', name: 'reqID' },
    { typeCode: 'L', name: 'callbackUuid', typeString: 'Ljava.lang.String;' },
    { typeCode: 'L', name: 'context', typeString: 'Ljava.util.Map;' },
    { typeCode: 'L', name: 'function', typeString: 'Ljava.lang.String;' },
    { typeCode: '[', name: 'params', typeString: '[Ljava.lang.Object;' },
  ]),
  superName: null,
});
// Throwable —— 本期只支持 err=null；注册以防解析崩溃（非 null 次期处理）
register({ fqcn: 'java.lang.Throwable', serialVersionUID: -3042686055658047285n, flags: 0x03, fields: [], superName: null, hasWriteMethod: true });

/** 获取已注册的 classdesc，未注册则返回 null。 */
export function classDescOf(fqcn: string): ClassDescSpec | null {
  return REGISTRY.get(fqcn) ?? null;
}

/** 数组描述符 SUID（由 Java golden fixture 钉死，Node 转有符号 BigInt 确认）。 */
const ARRAY_SUID: Record<string, bigint> = {
  '[I': 5600894804908749477n,
  '[B': -5984413125824719648n,
  '[C': 3492n,
  '[J': 3799162683273846916n,
  '[S': -3945975600557744189n,
  '[F': -2787785338863876491n,
  '[D': 8150038009621994760n,
  '[Z': -8665363611838762962n,
  '[Ljava.lang.Object;': -8012369246846506644n,
};

/** 生成数组的 classdesc。 */
export function arrayClassDesc(desc: string): ClassDescSpec {
  return {
    fqcn: desc,
    serialVersionUID: ARRAY_SUID[desc] ?? 0n,
    flags: 0x02,
    fields: [],
    superName: null,
  };
}
