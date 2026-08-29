import type { JValue } from './types';
import { RpcRequest, RpcPing, RpcResponse, RpcCallbackResponse, RpcCallbackReq } from '../codec/messages';

/** JS → JValue。number 歧义默认按范围映射 int/long/double。 */
export function toJava(x: unknown): JValue {
  if (x === null || x === undefined) return { t: 'null' };
  if (typeof x === 'string') return { t: 'string', v: x };
  if (typeof x === 'boolean') return { t: 'boolean', v: x };
  if (typeof x === 'bigint') return { t: 'long', v: x };
  if (Buffer.isBuffer(x)) return { t: 'bytes', v: x };
  if (typeof x === 'number') {
    if (!Number.isInteger(x)) return { t: 'double', v: x };
    if (x >= -2147483648 && x <= 2147483647) return { t: 'int', v: x };
    return { t: 'long', v: BigInt(x) };
  }
  if (Array.isArray(x)) {
    if (x.every((e) => typeof e === 'number' && Number.isInteger(e))) {
      return { t: 'array', fqcn: '[I', elems: x.map((e) => ({ t: 'int', v: e as number })) };
    }
    if (x.every((e) => typeof e === 'string')) {
      return {
        t: 'array',
        fqcn: '[Ljava.lang.Object;',
        elems: x.map((e) => ({ t: 'string', v: e as string })),
      };
    }
    return { t: 'array', fqcn: '[Ljava.lang.Object;', elems: x.map((e) => toJava(e)) };
  }
  if (x instanceof Map) {
    const entries: [JValue, JValue][] = [];
    for (const [k, v] of x) entries.push([toJava(k), toRef(v)]);
    return { t: 'map', entries };
  }
  if (x instanceof Date) return { t: 'bean', fqcn: 'java.util.Date', values: {} };
  // 普通对象 → map（需显式 asJava.bean 指定 FQCN 时才走 bean）
  if (typeof x === 'object') {
    const entries: [JValue, JValue][] = Object.entries(x as Record<string, unknown>).map(
      ([k, v]) => [toJava(k), toRef(v)],
    );
    return { t: 'map', entries };
  }
  throw new Error(`cannot convert ${typeof x} to java value`);
}

/** 引用位置（map value/list 元素/对象数组元素）的 primitive 转 boxed bean，符合 Java 语义。 */
export function toRef(x: unknown): JValue {
  const j = toJava(x);
  switch (j.t) {
    case 'null':
    case 'string':
    case 'bytes':
    case 'bean':
    case 'array':
    case 'map':
    case 'list':
    case 'set':
    case 'class':
    case 'bigint':
      return j;
    case 'int':
      return { t: 'bean', fqcn: 'java.lang.Integer', values: { value: { t: 'int', v: j.v } } };
    case 'long':
      return { t: 'bean', fqcn: 'java.lang.Long', values: { value: { t: 'long', v: j.v } } };
    case 'short':
      return { t: 'bean', fqcn: 'java.lang.Short', values: { value: { t: 'short', v: j.v } } };
    case 'byte':
      return { t: 'bean', fqcn: 'java.lang.Byte', values: { value: { t: 'byte', v: j.v } } };
    case 'char':
      return { t: 'bean', fqcn: 'java.lang.Character', values: { value: { t: 'char', v: j.v } } };
    case 'float':
      return { t: 'bean', fqcn: 'java.lang.Float', values: { value: { t: 'float', v: j.v } } };
    case 'double':
      return { t: 'bean', fqcn: 'java.lang.Double', values: { value: { t: 'double', v: j.v } } };
    case 'boolean':
      return { t: 'bean', fqcn: 'java.lang.Boolean', values: { value: { t: 'boolean', v: j.v } } };
  }
}

/** JValue → JS。long 默认转 number，超安全整数时转 bigint。 */
export function fromJava(j: JValue): unknown {
  switch (j.t) {
    case 'null':
      return null;
    case 'string':
      return j.v;
    case 'int':
    case 'short':
    case 'byte':
    case 'char':
    case 'float':
    case 'double':
      return j.v;
    case 'long':
      return typeof j.v === 'bigint' && j.v > BigInt(Number.MAX_SAFE_INTEGER)
        ? j.v.toString()
        : Number(j.v);
    case 'boolean':
      return j.v;
    case 'bytes':
      return j.v;
    case 'array':
      return j.elems.map((e) => fromJava(e));
    case 'map': {
      const m = new Map<unknown, unknown>();
      for (const [k, v] of j.entries) m.set(fromJava(k), fromJava(v));
      return m;
    }
    case 'list':
    case 'set':
      return j.elems.map((e) => fromJava(e));
    case 'bean':
      return fromJavaBean(j);
    case 'bigint':
    case 'class':
      return j;
  }
}

function fromJavaBean(b: { fqcn: string; values: Record<string, JValue> }): unknown {
  if (b.fqcn === 'java.lang.Integer' || b.fqcn === 'java.lang.Long' || b.fqcn === 'java.lang.Byte' || b.fqcn === 'java.lang.Double' || b.fqcn === 'java.lang.Float' || b.fqcn === 'java.lang.Boolean' || b.fqcn === 'java.lang.Short' || b.fqcn === 'java.lang.Character') {
    return fromJava(b.values.value);
  }
  const out: Record<string, unknown> = { __javaClass: b.fqcn };
  for (const [k, v] of Object.entries(b.values)) out[k] = fromJava(v);
  return out;
}

/** RPC 消息 → 顶层 JValue（bean, fqcn 精确为 Java FQCN）。 */
export function toJavaMessage(msg: RpcRequest | RpcResponse | RpcCallbackReq): JValue {
  if (msg instanceof RpcCallbackReq) {
    return {
      t: 'bean',
      fqcn: 'com.leavay.nio.crpc.CRpcCallbackReq',
      values: {
        reqID: { t: 'long', v: BigInt(msg.reqID) },
        callbackUuid: msg.callbackUuid === null ? { t: 'null' } : { t: 'string', v: msg.callbackUuid },
        context: msg.context === null ? { t: 'null' } : toJava(msg.context),
        function: msg.function === null ? { t: 'null' } : { t: 'string', v: msg.function },
        params: msg.params === null ? { t: 'null' } : { t: 'array', fqcn: '[Ljava.lang.Object;', elems: msg.params.map((p) => toRef(p)) },
      },
    };
  }
  if (msg instanceof RpcResponse) {
    const fqcn = msg instanceof RpcCallbackResponse ? 'com.leavay.nio.crpc.CRpcCallbackResponse' : 'com.leavay.nio.crpc.CRpcResponse';
    return {
      t: 'bean',
      fqcn,
      values: {
        reqID: { t: 'long', v: BigInt(msg.reqID) },
        err: msg.err === null || msg.err === undefined ? { t: 'null' } : toRef(msg.err),
        result: msg.result === null || msg.result === undefined ? { t: 'null' } : toRef(msg.result),
      },
    };
  }
  // RpcRequest / RpcPing
  const fqcn = msg instanceof RpcPing ? 'com.leavay.nio.crpc.CRpcPing' : 'com.leavay.nio.crpc.CRpcRequest';
  return {
    t: 'bean',
    fqcn,
    values: {
      reqID: { t: 'long', v: BigInt(msg.reqID) },
      className: msg.className === null ? { t: 'null' } : { t: 'string', v: msg.className },
      context: msg.context === null ? { t: 'null' } : toJava(msg.context),
      function: msg.function === null ? { t: 'null' } : { t: 'string', v: msg.function },
      params: msg.params === null ? { t: 'null' } : { t: 'array', fqcn: '[Ljava.lang.Object;', elems: msg.params.map((p) => toRef(p)) },
      reqType: msg.reqType === null || msg.reqType === undefined ? { t: 'null' } : { t: 'bean', fqcn: 'java.lang.Byte', values: { value: { t: 'byte', v: msg.reqType } } },
    },
  };
}

/** 顶层 JValue → RPC 消息（按 fqcn 分派）。 */
export function fromJavaToMessage(j: JValue): RpcRequest | RpcResponse | RpcCallbackReq {
  if (j.t !== 'bean') throw new Error('expected top-level bean message');
  const values = j.values;
  switch (j.fqcn) {
    case 'com.leavay.nio.crpc.CRpcRequest': {
      const r = new RpcRequest();
      r.setReqID(toNumber(values.reqID));
      r.className = values.className?.t === 'string' ? values.className.v : null;
      r.function = values.function?.t === 'string' ? values.function.v : null;
      r.params = values.params?.t === 'array' ? values.params.elems.map((e) => fromJava(e)) : null;
      r.context = values.context?.t === 'map' ? fromJava(values.context) as Map<string, unknown> : null;
      r.reqType = values.reqType?.t === 'bean' ? (fromJava(values.reqType) as number) : null;
      return r;
    }
    case 'com.leavay.nio.crpc.CRpcPing': {
      const r = new RpcPing();
      r.setReqID(toNumber(values.reqID));
      r.className = values.className?.t === 'string' ? values.className.v : null;
      r.function = values.function?.t === 'string' ? values.function.v : null;
      r.params = values.params?.t === 'array' ? values.params.elems.map((e) => fromJava(e)) : null;
      r.context = values.context?.t === 'map' ? fromJava(values.context) as Map<string, unknown> : null;
      r.reqType = values.reqType?.t === 'bean' ? (fromJava(values.reqType) as number) : null;
      return r;
    }
    case 'com.leavay.nio.crpc.CRpcResponse': {
      const r = new RpcResponse();
      r.setReqID(toNumber(values.reqID));
      r.result = values.result?.t === 'null' || !values.result ? null : fromJava(values.result);
      r.err = values.err?.t === 'null' || !values.err ? null : fromJava(values.err);
      return r;
    }
    case 'com.leavay.nio.crpc.CRpcCallbackResponse': {
      const r = new RpcCallbackResponse();
      r.setReqID(toNumber(values.reqID));
      r.result = values.result?.t === 'null' || !values.result ? null : fromJava(values.result);
      r.err = values.err?.t === 'null' || !values.err ? null : fromJava(values.err);
      return r;
    }
    case 'com.leavay.nio.crpc.CRpcCallbackReq': {
      const r = new RpcCallbackReq();
      r.setReqID(toNumber(values.reqID));
      r.callbackUuid = values.callbackUuid?.t === 'string' ? values.callbackUuid.v : null;
      r.function = values.function?.t === 'string' ? values.function.v : null;
      r.params = values.params?.t === 'array' ? values.params.elems.map((e) => fromJava(e)) : null;
      r.context = values.context?.t === 'map' ? fromJava(values.context) as Map<string, unknown> : null;
      return r;
    }
    default:
      throw new Error(`unknown message class ${j.fqcn}`);
  }
}

function toNumber(v: JValue | undefined): number {
  if (!v) return 0;
  if (v.t === 'long') return Number(v.v);
  if (v.t === 'int') return v.v;
  return 0;
}
