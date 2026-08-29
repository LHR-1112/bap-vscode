// @bap/rpc —— 与 Java 桥进程的 stdin/stdout JSON 通信类型定义。
// 本包不依赖 VS Code；由 apps/vscode（或 vscode-host）注入 BridgeLaunchConfig。

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [k: string]: JsonValue };

export type BridgeMethod = 'connect' | 'call' | 'disconnect' | 'ping' | 'shutdown';

export interface RpcRequest {
  id: number;
  method: BridgeMethod;
  params: JsonValue[];
}

export interface RpcError {
  name: string;
  message: string;
}

export interface RpcResponse {
  id: number;
  ok: boolean;
  result?: JsonValue;
  error?: RpcError;
}

/** 拉起 Java 桥子进程的配置。classpath 允许单元素 "…/lib/*"（JVM 自身展开，不走 shell）。 */
export interface BridgeLaunchConfig {
  /** Java 可执行文件的路径；缺省由 resolveJavaBin() 探测。 */
  javaBin?: string;
  /** JVM classpath（`-cp` 参数值，多个元素用 path.delimiter 连接）。 */
  classpath: string[];
  /** 主类全限定名，默认 com.bap.dev.BridgeMain。 */
  mainClass?: string;
  /** 请求默认超时（毫秒），默认 30_000。 */
  timeoutMs?: number;
  /** 进程工作目录（可选）。 */
  cwd?: string;
}

/** Java 侧登录返回的会话（CSession 的 JSON 子集）。 */
export interface SessionDto {
  userGid?: { className?: string; uuid?: string } | null;
  userCode?: string;
  userAlias?: string;
  pwd?: string;
}

/** 一次请求带超时的 pending 条目。 */
export interface PendingEntry {
  resolve: (value: JsonValue) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

// 供 index.ts 使用的事件映射
export interface RpcClientEvents {
  exit: (code: number | null) => void;
  log: (line: string) => void;
}
