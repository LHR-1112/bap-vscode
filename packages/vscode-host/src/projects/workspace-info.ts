// workspaceInfo 的数据构建（纯函数）：给 AI 一个只读的窗口/工程全景，用于选择 project 参数。
// 数据只来自扫描描述符与注册表，绝不读取 .develop 的 user/pwd。
import type { BackendProjectDescriptor } from './discovery';
import { isVfWorkspaceRoot } from '../backend-projects';
import { computeMcpMode, type McpMode } from '../mcp/mode';
import { toolsForMode } from '../mcp/tools';

export interface WorkspaceFolderInfo {
  name: string;
  path: string;
  scheme: string;
  vf: boolean;
}

export interface WorkspaceProjectInfo {
  projectId: string;
  displayName: string;
  root: string;
  workspaceFolder: string;
  relativePath: string;
  projectUuid?: string;
  serverUri?: string;
  /** 激活期注册表是否已包含该工程（false = 需要重载窗口才能操作）。 */
  registered: boolean;
  duplicateProjectUuid?: string;
  peerProjectIds: string[];
}

export interface WorkspaceInfoResult {
  schemaVersion: 1;
  workspaceFolders: WorkspaceFolderInfo[];
  vfRoots: string[];
  projects: WorkspaceProjectInfo[];
  mcp: {
    mode: McpMode;
    tools: string[];
    liveProjectCount: number;
    registeredProjectCount: number;
    reloadRequired: boolean;
  };
}

/**
 * 去掉 URI 中的 userinfo（`ws://u:p@host` → `ws://host`）。
 * 不用 URL 解析，避免改变原始 URI 的写法（尾斜杠/路径/查询串）。
 * 正常 URI 只在 authority 段（`//` 后到第一个 `/`、`?`、`#` 之前）剥离，避免误伤
 * path/query 里的 `@`；畸形 URI（凭据含 `/`、单斜杠、缺 scheme）回退为「删到最后一个
 * `@`」的保守策略，保证异常输入也不泄漏账号密码。
 */
export function sanitizeServerUri(uri?: string): string | undefined {
  const raw = uri?.trim();
  if (!raw) return undefined;

  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*:)?\/\//.exec(raw);
  if (scheme) {
    const prefix = scheme[0];
    const rest = raw.slice(prefix.length);
    const sep = firstSeparator(rest);
    const authority = sep >= 0 ? rest.slice(0, sep) : rest;
    const tail = sep >= 0 ? rest.slice(sep) : '';
    const at = authority.lastIndexOf('@');
    if (at >= 0) return prefix + authority.slice(at + 1) + tail;
    return stripMalformedUserinfo(raw, prefix.length);
  }

  // 无 `//`：缺 scheme（user:pass@host）、单斜杠（ws:/u:p@host）或纯 authority。
  const sep = firstSeparator(raw);
  const head = sep >= 0 ? raw.slice(0, sep) : raw;
  const at = head.lastIndexOf('@');
  if (at >= 0) return raw.slice(at + 1);
  return stripMalformedUserinfo(raw, 0);
}

/** 字符串中第一个 `/`、`?`、`#` 的位置；没有返回 -1。 */
function firstSeparator(s: string): number {
  let idx = -1;
  for (const ch of ['/', '?', '#']) {
    const i = s.indexOf(ch);
    if (i >= 0 && (idx < 0 || i < idx)) idx = i;
  }
  return idx;
}

/**
 * 保守兜底：authority 内没有 `@` 但整串有 `@` 时（多因凭据里含 `/`），
 * 删除到最后一个 `@`。`@` 落在 `?` / `#` 之后更像 path/query 内容（如邮箱），不动。
 */
function stripMalformedUserinfo(raw: string, prefixLength: number): string {
  const lastAt = raw.lastIndexOf('@');
  if (lastAt < prefixLength) return raw;
  const queryIndex = firstSeparator(raw);
  const queryAt = Math.min(
    ...[raw.indexOf('?'), raw.indexOf('#')].filter((i) => i >= 0),
  );
  if (queryIndex >= 0 && lastAt > queryAt) return raw;
  return raw.slice(0, prefixLength) + raw.slice(lastAt + 1);
}

export interface BuildWorkspaceInfoInput {
  workspaceFolders: readonly { name: string; fsPath: string; scheme?: string }[];
  descriptors: readonly BackendProjectDescriptor[];
  /** 激活期注册表中的 projectId；缺省视为全部已注册。 */
  registeredProjectIds?: ReadonlySet<string>;
  /** 显式指定 MCP 模式；缺省按注册/实时工程数推断。 */
  mode?: McpMode;
}

export function buildWorkspaceInfo(input: BuildWorkspaceInfoInput): WorkspaceInfoResult {
  const workspaceFolders: WorkspaceFolderInfo[] = input.workspaceFolders.map((f) => ({
    name: f.name,
    path: f.fsPath,
    scheme: f.scheme ?? 'file',
    vf: isVfWorkspaceRoot(f.fsPath),
  }));

  const liveIds = new Set(input.descriptors.map((d) => d.projectId));
  const registeredIds = input.registeredProjectIds ?? new Set(liveIds);
  const registeredProjectCount = registeredIds.size;
  const liveProjectCount = input.descriptors.length;

  const inferredMode = computeMcpMode(registeredProjectCount, liveProjectCount);
  const mode = input.mode ?? inferredMode;
  const reloadRequired =
    // 调用方进程实际生效的模式与当前窗口推断不一致时，也必须重载。
    (input.mode !== undefined && input.mode !== inferredMode) ||
    input.descriptors.some((d) => !registeredIds.has(d.projectId)) ||
    [...registeredIds].some((id) => !liveIds.has(id));

  return {
    schemaVersion: 1,
    workspaceFolders,
    vfRoots: workspaceFolders.filter((f) => f.vf).map((f) => f.path),
    projects: input.descriptors.map((d) => ({
      projectId: d.projectId,
      displayName: d.displayName,
      root: d.root,
      workspaceFolder: d.workspaceFolder,
      relativePath: d.relativePath,
      ...(d.projectUuid ? { projectUuid: d.projectUuid } : {}),
      ...(sanitizeServerUri(d.serverUri) ? { serverUri: sanitizeServerUri(d.serverUri) } : {}),
      registered: registeredIds.has(d.projectId),
      ...(d.duplicateProjectUuid ? { duplicateProjectUuid: d.duplicateProjectUuid } : {}),
      peerProjectIds: [...d.peerProjectIds],
    })),
    mcp: {
      mode,
      tools: toolsForMode(mode).map((t) => t.name),
      liveProjectCount,
      registeredProjectCount,
      reloadRequired,
    },
  };
}
