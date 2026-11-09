// MCP 宿主 ↔ mcp-server 子进程的错误协议（纯函数，可被两侧 bundle 共享）。
// 宿主把命令异常规范化为 { message, code?, candidates? }；子进程把它还原成可读文本，
// 并在有结构化信息时追加一行机器可读 meta，便于 AI 解析候选工程。
export interface IpcProjectCandidate {
  projectId: string;
  displayName: string;
  root?: string;
}

export interface IpcToolError {
  message: string;
  code?: string;
  candidates?: IpcProjectCandidate[];
}

export function isIpcToolError(x: unknown): x is IpcToolError {
  return (
    !!x &&
    typeof x === 'object' &&
    !Array.isArray(x) &&
    typeof (x as { message?: unknown }).message === 'string'
  );
}

function sanitizeCandidates(x: unknown): IpcProjectCandidate[] | undefined {
  if (!Array.isArray(x)) return undefined;
  const out: IpcProjectCandidate[] = [];
  for (const item of x) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    if (typeof c.projectId !== 'string' || !c.projectId) continue;
    out.push({
      projectId: c.projectId,
      displayName: typeof c.displayName === 'string' && c.displayName ? c.displayName : c.projectId,
      ...(typeof c.root === 'string' && c.root ? { root: c.root } : {}),
    });
  }
  return out.length ? out : undefined;
}

/** 把任意异常转成 IPC 错误载荷（不依赖 instanceof，跨 bundle 也安全）。 */
export function toIpcToolError(e: unknown): IpcToolError {
  if (isIpcToolError(e)) {
    const candidates = sanitizeCandidates(e.candidates);
    return {
      message: e.message,
      ...(e.code ? { code: e.code } : {}),
      ...(candidates ? { candidates } : {}),
    };
  }
  if (e instanceof Error) return { message: e.message || e.name };
  return { message: typeof e === 'string' ? e : String(e) };
}

/** 人类可读错误文本；含结构化信息时追加 BAP_MCP_ERROR_META 行。 */
export function formatIpcToolError(err: IpcToolError): string {
  const lines = [err.message];
  if (err.candidates?.length) {
    lines.push('候选工程：');
    for (const c of err.candidates) {
      lines.push(`· ${c.displayName}（${c.projectId}）${c.root ? ` — ${c.root}` : ''}`);
    }
  }
  if (err.code || err.candidates?.length) {
    const meta: Record<string, unknown> = {};
    if (err.code) meta.code = err.code;
    if (err.candidates?.length) {
      meta.candidates = err.candidates.map((c) => ({
        projectId: c.projectId,
        displayName: c.displayName,
      }));
    }
    lines.push(`BAP_MCP_ERROR_META: ${JSON.stringify(meta)}`);
  }
  return lines.join('\n');
}

/** 子进程侧：把 IPC 错误载荷还原成异常。 */
export class IpcToolCallError extends Error {
  constructor(readonly payload: IpcToolError) {
    super(payload.message);
    this.name = 'IpcToolCallError';
  }
}

const MINUTE = 60_000;

/** 按工具类型给出 IPC 调用超时；长耗时工具必须放宽，否则下载/发布会被 30s 掐断。 */
export function ipcTimeoutForTool(toolName: string): number {
  switch (toolName) {
    case 'downloadProject':
    case 'publish':
    case 'testProject':
    // 规则函数注册：SDK 超时 12 min（Java 10 min），加上可能的 listDomains 回退，
    // IPC 必须显著更长，否则 AI 调用会在宿主返回前被误判为超时。
    case 'registerClassRuleFunctions':
    case 'registerMethodRuleFunction':
      return 30 * MINUTE;
    case 'compileProject':
    case 'updateLibs':
      return 10 * MINUTE;
    case 'redirect':
    case 'listProjects':
    case 'commit':
    case 'updateAll':
      return 5 * MINUTE;
    default:
      return 30_000;
  }
}
