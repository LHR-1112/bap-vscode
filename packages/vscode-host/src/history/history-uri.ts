// 虚拟 URI（bap-original / bap-history）的构造与解析（纯函数，不依赖 vscode，便于单测）。
//
// 多工程隔离：query 里的 pid = projectId，content provider 据此选择对应工程的 SDK。
// 旧 URI（无 pid）仍可解析，由宿主在「窗口内只有一个工程」时兜底。

export function parseQueryString(query: string): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = query.startsWith('?') ? query.slice(1) : query;
  try {
    new URLSearchParams(raw).forEach((v, k) => {
      out[k] = v;
    });
  } catch {
    /* 非法 query 忽略 */
  }
  return out;
}

/** `true`/`1` 为真，`false`/`0`/缺省为假（兼容历史 URI 的 res=1/0）。 */
export function parseBoolParam(value: string | undefined): boolean {
  return value === 'true' || value === '1';
}

export function queryString(params: Record<string, string | undefined | false>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === false || v === '') continue;
    q.set(k, v);
  }
  return q.toString();
}

/** 从任意虚拟 URI 字符串的 query 中取 projectId。 */
export function projectIdFromUriString(uri: string): string | undefined {
  const q = uri.indexOf('?');
  if (q < 0) return undefined;
  return parseQueryString(uri.slice(q + 1)).pid;
}

function pathnameAfterHost(uriPath: string, scheme: string): string {
  let p = uriPath;
  const prefix = `${scheme}://bap/`;
  if (p.startsWith(prefix)) p = p.slice(prefix.length);
  else {
    const schemeIdx = p.indexOf('://');
    if (schemeIdx >= 0) {
      const after = p.slice(schemeIdx + 3);
      const slash = after.indexOf('/');
      p = slash >= 0 ? after.slice(slash + 1) : '';
    }
  }
  p = p.replace(/^\/+/, '');
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

export interface OriginalUriOptions {
  projectId?: string;
  /** 相对工程根的路径，如 src/core/a/B.java；仅作 path 段唯一标识。 */
  workspaceRel: string;
  /** 相对 src/<folder> 的权威路径（写入 query.rel）。 */
  relativePath: string;
  folder: string;
  isResource: boolean;
}

/** 构造 bap-original 虚拟 URI 字符串。 */
export function bapOriginalUriString(opts: OriginalUriOptions): string {
  const q = queryString({
    pid: opts.projectId,
    folder: opts.folder,
    res: opts.isResource ? 'true' : 'false',
    rel: opts.relativePath,
  });
  return `bap-original://bap/${encodeURIComponent(opts.workspaceRel)}?${q}`;
}

export interface ParsedOriginalUri {
  projectId?: string;
  folder: string;
  isResource: boolean;
  relativePath: string;
}

/** 解析 bap-original URI（path 段可能是 workspace 相对路径，query.rel 才是云端定位路径）。 */
export function parseOriginalUri(uriPath: string, query: string): ParsedOriginalUri {
  const q = parseQueryString(query);
  const rel = q.rel || pathnameAfterHost(uriPath, 'bap-original');
  return {
    projectId: q.pid || undefined,
    folder: q.folder || '',
    isResource: parseBoolParam(q.res),
    relativePath: rel.replace(/^\/+/, ''),
  };
}

/** 构造 bap-history 虚拟 URI 字符串。 */
export function bapHistoryUriString(uuid: string, isResource: boolean, projectId?: string): string {
  const q = queryString({ pid: projectId, res: isResource ? 'true' : 'false' });
  return `bap-history://bap/${encodeURIComponent(uuid)}?${q}`;
}

export interface ParsedHistoryUri {
  projectId?: string;
  uuid: string;
  isResource: boolean;
}

export function parseHistoryUri(uriPath: string, query: string): ParsedHistoryUri {
  const q = parseQueryString(query);
  return {
    projectId: q.pid || undefined,
    uuid: q.uuid || pathnameAfterHost(uriPath, 'bap-history'),
    isResource: parseBoolParam(q.res),
  };
}
