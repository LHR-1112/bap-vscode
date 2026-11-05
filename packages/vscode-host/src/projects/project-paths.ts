// 多后端工程的路径工具（纯函数，不依赖 vscode，便于单测）。
import * as path from 'path';

/** 路径身份键：绝对化 + 大小写归一（macOS / Windows 文件系统默认不区分大小写）。 */
export function pathKey(p: string): string {
  const abs = path.resolve(p);
  return process.platform === 'darwin' || process.platform === 'win32' ? abs.toLowerCase() : abs;
}

/** 两个路径是否指向同一位置（按平台大小写规则）。 */
export function isSamePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

/** child 是否位于 parent 内（含相等）。按路径段比较，`/ws/p1` 不会匹配 `/ws/p10`。 */
export function isPathInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

/** 相对工程根的路径（POSIX 分隔符）；不在工程内返回 undefined。 */
export function projectRelativePath(projectRoot: string, fsPath: string): string | undefined {
  if (!isPathInside(projectRoot, fsPath)) return undefined;
  const rel = path.relative(path.resolve(projectRoot), path.resolve(fsPath));
  return rel === '' ? '' : rel.split(path.sep).join('/');
}

/** 文件是否位于工程根的 src/ 下。 */
export function isInProjectSrc(projectRoot: string, fsPath: string): boolean {
  return isPathInside(path.join(projectRoot, 'src'), fsPath);
}

const IGNORED_SEGMENTS = new Set([
  'node_modules',
  'target',
  'build',
  'out',
  'dist',
  'bin',
  'lib',
  'api',
  'coverage',
  '.git',
  '.svn',
  '.idea',
  '.vscode',
  '.votaforge',
  '.bap',
]);

/**
 * 工程内的路径是否应被自动刷新忽略（隐藏目录、依赖、构建产物、vf/bap 私有目录）。
 * 不在工程内也算忽略。
 */
export function isIgnoredProjectPath(projectRoot: string, fsPath: string): boolean {
  const rel = projectRelativePath(projectRoot, fsPath);
  if (rel === undefined) return true;
  if (rel === '') return false;
  return rel
    .split('/')
    .some((seg) => seg.startsWith('.') || IGNORED_SEGMENTS.has(seg));
}

/**
 * 从工程内文件绝对路径推导 fullClass：
 * `<root>/src/<folder>/<pkg...>/<Class>.java` → `<pkg...>.<Class>`（剥掉 src 与一级 folder）。
 * 不在 src/ 下、不是 .java、或缺少类名时返回 undefined。
 */
export function deriveFullClass(projectRoot: string, absPath: string): string | undefined {
  const rel = projectRelativePath(projectRoot, absPath);
  if (rel === undefined || !rel) return undefined;
  const parts = rel.split('/');
  if (parts[0] !== 'src' || parts.length < 3) return undefined;
  const file = parts[parts.length - 1];
  if (!/\.java$/i.test(file)) return undefined;
  const classes = parts.slice(2).map((p, i, arr) => (i === arr.length - 1 ? p.replace(/\.java$/i, '') : p));
  const full = classes.filter(Boolean).join('.');
  return full || undefined;
}

/** 归一化服务器地址（用于重复检出判定）：小写 scheme/host、去查询与尾斜杠。 */
export function normalizeServerUri(raw: string): string {
  const s = (raw ?? '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    u.hash = '';
    u.search = '';
    const p = u.pathname.replace(/\/+$/, '');
    return `${u.protocol}//${u.host}${p}`.toLowerCase();
  } catch {
    return s.replace(/\/+$/, '').toLowerCase();
  }
}

/** 绝对路径转工作区相对路径（POSIX）；不在根内时返回绝对路径的 POSIX 形式。 */
export function workspaceRelative(root: string, absPath: string): string {
  const rel = projectRelativePath(root, absPath);
  return rel === undefined ? absPath.split(path.sep).join('/') : rel;
}
