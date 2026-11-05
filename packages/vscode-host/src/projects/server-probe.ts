// 引导模式下的服务器探测：没有 .develop 时，用调用方显式提供的 uri/user/pwd 建一次连接，
// 列出云端工程后立即关闭。仅供 bootstrap listProjects 使用。
import { createRpcClient, type BridgeLaunchConfig } from '@bap/rpc';
import type { CJavaProjectDto } from '@bap/sdk';

export interface ProbeConnection {
  uri: string;
  user: string;
  pwd: string;
}

interface ProbeRpc {
  connect(uri: string, user: string, pwd: string): Promise<void>;
  call(method: string, ...args: unknown[]): Promise<unknown>;
  close(): Promise<void>;
}

export interface ProbeDeps {
  createRpc?: (launch: BridgeLaunchConfig) => ProbeRpc;
}

/** 校验直连参数：三者必须同时提供（避免用半套凭据连到意外服务器）。 */
function validateConnection(conn: ProbeConnection): ProbeConnection {
  const uri = typeof conn?.uri === 'string' ? conn.uri.trim() : '';
  const user = typeof conn?.user === 'string' ? conn.user.trim() : '';
  const pwd = typeof conn?.pwd === 'string' ? conn.pwd : '';
  if (!uri || !user || !pwd) {
    throw new Error('直连服务器需要同时提供 uri、user、pwd');
  }
  return { uri, user, pwd };
}

/**
 * 连接服务器并返回工程列表；无论成功失败都会关闭 RPC（不泄漏 Java 桥进程）。
 * 错误消息不含密码。
 */
export async function probeServerProjects(
  launch: BridgeLaunchConfig,
  conn: ProbeConnection,
  deps: ProbeDeps = {},
): Promise<CJavaProjectDto[]> {
  const safe = validateConnection(conn);
  const rpc = deps.createRpc ? deps.createRpc(launch) : createRpcClient({ launch });
  try {
    await rpc.connect(safe.uri, safe.user, safe.pwd);
    const list = await rpc.call('getAllProjects');
    return Array.isArray(list) ? (list as CJavaProjectDto[]) : [];
  } finally {
    try {
      await rpc.close();
    } catch {
      /* 连接失败时 close 也可能失败；忽略 */
    }
  }
}
