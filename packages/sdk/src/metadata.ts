// metadata 通道：规则函数注册（IPanelMetadataService）。
// 只封装桥的顶层方法 metadata，超时矩阵与错误映射见规划 §2.3/§2.4。
// 注意：任何日志/异常都不得包含密码；本模块只透传 uri/user/pwd 给 metadata connect。
import type { JsonValue } from '@bap/rpc';
import { SdkError } from './develop';
import type {
  DevelopConfig,
  DomainInfoDto,
  ListFunctionsResult,
  RegisterFunctionResult,
  RpcInvoker,
} from './types';

// TS 侧超时必须大于 Java setTempTimeout（铁律，见规划 §2.3）。
export const METADATA_CONNECT_TIMEOUT_MS = 180_000;
// Java 侧 listDomains/listFunctions 的 setTempTimeout 是 120s；TS 必须更大，
// 才能等到 Java 抛出的真实远端错误（见规划 §2.3 铁律）。
export const METADATA_READ_TIMEOUT_MS = 150_000;
export const METADATA_REGISTER_TIMEOUT_MS = 12 * 60_000;
export const METADATA_PING_TIMEOUT_MS = 15_000;
export const METADATA_DISCONNECT_TIMEOUT_MS = 10_000;

function requireRequest(rpc: RpcInvoker): NonNullable<RpcInvoker['request']> {
  if (!rpc.request) {
    throw new SdkError(
      '当前 Java 桥不支持元数据调用（缺少 request 通道），请重新构建并重装扩展',
      'METADATA_UNAVAILABLE',
    );
  }
  return rpc.request.bind(rpc);
}

async function metadataRequest(
  rpc: RpcInvoker,
  op: 'connect' | 'call' | 'disconnect' | 'ping',
  args: JsonValue[],
  timeoutMs: number,
): Promise<JsonValue> {
  const request = requireRequest(rpc);
  try {
    return await request('metadata', [op, ...args], timeoutMs);
  } catch (e) {
    // BridgeRpcError.code 即 Java 错误 name；message 形如 "name: message"。
    const name = e instanceof Error && 'code' in e ? String((e as { code?: unknown }).code) : '';
    const message = e instanceof Error ? e.message : String(e);
    if (name.includes('unknown_method') || name.includes('BRIDGE_CLOSED')) {
      throw new SdkError(
        `Java 桥不支持元数据调用（${name}），请重新构建并重装扩展`,
        'METADATA_UNAVAILABLE',
        e,
      );
    }
    // 只把「服务本身缺失」映射为 SERVICE_UNAVAILABLE；普通远端错误（如 domain not found、
    // class not found）必须保留为 RPC_FAILED，否则会掩盖真正的业务参数错误。
    if (/IPanelMetadataService|NoServiceSupport|NoService|ServiceNotFound/i.test(message)) {
      throw new SdkError(`服务器未启用元数据服务或账号无权限：${message}`, 'METADATA_SERVICE_UNAVAILABLE', e);
    }
    throw new SdkError(`元数据调用失败（${op}）：${message}`, 'METADATA_RPC_FAILED', e);
  }
}

function describeShape(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** 返回必须是对象（不能是数组/null/标量）。 */
function ensureObject(raw: unknown, what: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SdkError(
      `${what} 返回格式异常（预期对象，实际 ${describeShape(raw)}）`,
      'METADATA_BAD_RESPONSE',
    );
  }
  return raw as Record<string, unknown>;
}

function ensureFunctionsArray(obj: Record<string, unknown>, what: string): void {
  if (obj.functions !== undefined && !Array.isArray(obj.functions)) {
    throw new SdkError(
      `${what} 返回的 functions 不是数组（实际 ${describeShape(obj.functions)}）`,
      'METADATA_BAD_RESPONSE',
    );
  }
}

/** listFunctions 返回校验：对象、非数组；functions 若存在必须是数组。 */
function ensureResult<T>(raw: unknown): T {
  const obj = ensureObject(raw, 'listFunctions');
  ensureFunctionsArray(obj, 'listFunctions');
  return raw as T;
}

/** registerFunction(s) 返回校验：对象、非数组；success 必须是 boolean；functions 若存在必须是数组。 */
function ensureRegisterResult(raw: unknown): RegisterFunctionResult {
  const obj = ensureObject(raw, 'registerFunction');
  if (typeof obj.success !== 'boolean') {
    throw new SdkError(
      `registerFunction 返回格式异常（success 必须是 boolean，实际 ${describeShape(obj.success)}）`,
      'METADATA_BAD_RESPONSE',
    );
  }
  ensureFunctionsArray(obj, 'registerFunction');
  return raw as RegisterFunctionResult;
}

/** 连接 metadata 服务（复用主客户端会话，不重新登录）。 */
export async function metadataConnect(
  rpc: RpcInvoker,
  d: Pick<DevelopConfig, 'uri' | 'user' | 'pwd'>,
): Promise<void> {
  await metadataRequest(rpc, 'connect', [d.uri, d.user, d.pwd], METADATA_CONNECT_TIMEOUT_MS);
}

/** 通用 metadata RPC（errorFunctions 等后续扩展可直接复用）。 */
export async function metadataCall<T>(
  rpc: RpcInvoker,
  method: string,
  args: JsonValue[],
  timeoutMs: number,
): Promise<T> {
  return (await metadataRequest(rpc, 'call', [method, args], timeoutMs)) as T;
}

/** 列出服务器可用业务域。 */
export async function listMetadataDomains(rpc: RpcInvoker): Promise<DomainInfoDto[]> {
  const raw = await metadataCall<unknown>(rpc, 'listDomains', [], METADATA_READ_TIMEOUT_MS);
  if (!Array.isArray(raw)) {
    throw new SdkError(
      `listDomains 返回格式异常（预期数组，实际 ${describeShape(raw)}）`,
      'METADATA_BAD_RESPONSE',
    );
  }
  // 只保留带非空字符串 code 的对象，避免畸形响应在宿主/调用方触发 TypeError。
  return raw.filter((x): x is DomainInfoDto => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
    const code = (x as { code?: unknown }).code;
    return typeof code === 'string' && code.trim().length > 0;
  });
}

/** 列出某业务域下的规则函数。 */
export async function listMetadataFunctions(
  rpc: RpcInvoker,
  domain: string,
): Promise<ListFunctionsResult> {
  const raw = await metadataCall<unknown>(rpc, 'listFunctions', [domain], METADATA_READ_TIMEOUT_MS);
  return ensureResult<ListFunctionsResult>(raw);
}

/** 注册单个方法为规则函数。 */
export async function registerMetadataFunction(
  rpc: RpcInvoker,
  domain: string,
  fullClass: string,
  methodName: string,
): Promise<RegisterFunctionResult> {
  const raw = await metadataCall<unknown>(
    rpc,
    'registerFunction',
    [domain, fullClass, methodName],
    METADATA_REGISTER_TIMEOUT_MS,
  );
  return ensureRegisterResult(raw);
}

/** 注册整个类的所有方法为规则函数。 */
export async function registerMetadataFunctions(
  rpc: RpcInvoker,
  domain: string,
  fullClass: string,
): Promise<RegisterFunctionResult> {
  const raw = await metadataCall<unknown>(
    rpc,
    'registerFunctions',
    [domain, fullClass],
    METADATA_REGISTER_TIMEOUT_MS,
  );
  return ensureRegisterResult(raw);
}

/** 业务域 code 校验：必须是字符串，trim 后非空且不含控制字符；返回 trim 后的值。 */
export function validateMetadataDomainCode(code: string): string {
  if (typeof code !== 'string') {
    throw new SdkError('业务域 code 必须是字符串', 'METADATA_DOMAIN_INVALID');
  }
  const s = code.trim();
  if (!s) throw new SdkError('业务域 code 不能为空', 'METADATA_DOMAIN_INVALID');
  if (/[\u0000-\u001f\u007f]/.test(s)) {
    throw new SdkError(`业务域 code 含非法字符：${s}`, 'METADATA_DOMAIN_INVALID');
  }
  return s;
}
