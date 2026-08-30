// SCM 桥接的类型与纯映射函数（不依赖 vscode 运行时，便于单测）。
import type { Status } from '@bap/sdk';

export type ScmStatus = Status;

/** resource 组 id（createResourceGroup 的 id）→ 变更状态。 */
export function groupToStatus(id: string): Status | undefined {
  switch (id) {
    case 'added':
      return 'ADDED';
    case 'modified':
      return 'MODIFIED';
    case 'deleted':
      return 'DELETED_LOCALLY';
    default:
      return undefined;
  }
}

/** status → 资源管理器角标（badge + 颜色名 + tooltip）。 */
export interface FileDecoSpec {
  badge: string;
  color: string; // vscode.ThemeColor 的 id，如 'charts.yellow'
  tooltip: string;
}

export function fileDecoFor(status: ScmStatus): FileDecoSpec | undefined {
  switch (status) {
    case 'MODIFIED':
      return { badge: 'M', color: 'charts.yellow', tooltip: '已修改（本地与云端 MD5 不同）' };
    case 'ADDED':
      return { badge: 'A', color: 'charts.blue', tooltip: '新增（本地有，云端无）' };
    case 'DELETED_LOCALLY':
      return { badge: 'D', color: 'charts.red', tooltip: '缺失（云端有，本地已删）' };
    default:
      return undefined; // NORMAL 无角标
  }
}

/** status → SCM 行内装饰（iconPath 图标名 + strikeThrough/faded/tooltip，供 resource state 用）。 */
export interface ScmDecoSpec {
  icon?: string;          // ThemeIcon 名（codicon），如 'edit'/'add'/'circle-outline'
  strikeThrough?: boolean;
  faded?: boolean;
  tooltip?: string;
}

/** status → codicon 图标名（SCM 行内显示 M/A/D 语义图标；字母角标在文件树用 FileDecoration）。 */
export function iconFor(status: ScmStatus): string {
  switch (status) {
    case 'MODIFIED':
      return 'edit';
    case 'ADDED':
      return 'add';
    case 'DELETED_LOCALLY':
      return 'circle-outline';
    default:
      return 'info';
  }
}

export function scmDecoFor(status: ScmStatus): ScmDecoSpec | undefined {
  switch (status) {
    case 'MODIFIED':
      return { icon: 'edit', tooltip: 'M 已修改' };
    case 'ADDED':
      return { icon: 'add', faded: true, tooltip: 'A 新增' };
    case 'DELETED_LOCALLY':
      return { icon: 'circle-outline', strikeThrough: true, tooltip: 'D 已删除' };
    default:
      return undefined;
  }
}

// --- 带颜色 A/M/D 图标（git 同款 SVG 文件，位于插件 resources/scm-icons/）---
/** SCM 行内带颜色 A/M/D 图标文件名（status-*.svg，git 同款），供 Uri.file(iconDir/name) 引用。 */
export function statusIconFile(status: ScmStatus): string | undefined {
  switch (status) {
    case 'MODIFIED':
      return 'status-modified.svg';
    case 'ADDED':
      return 'status-added.svg';
    case 'DELETED_LOCALLY':
      return 'status-deleted.svg';
    default:
      return undefined;
  }
}

/** 相对路径（相对 src/<folder>）→ 全类名：com/foo/Bar.java → com.foo.Bar。 */
export function relToFullClass(rel: string, isResource: boolean): string | undefined {
  if (isResource) return undefined;
  return rel.replace(/\.java$/i, '').split('/').join('.');
}

/** 相对路径（相对 src/res）→ 传给 getResFile 的路径（保留 '/'）。 */
export function relToResPath(rel: string): string {
  return rel.startsWith('/') ? rel : '/' + rel;
}

/**
 * 构造 bap-original 虚拟 URI（供 QuickDiffProvider 返回）。
 * query 携带 folder + isResource + 相对路径，便于 content provider 反推并调 sdk 取云端原版。
 */
export function bapOriginalUriSpec(
  workspaceRoot: string,
  relativePath: string,
  folder: string,
  isResource: boolean,
): string {
  // 用相对 workspace 的路径做 path 段，folder/isResource 放 query
  const q = new URLSearchParams();
  q.set('folder', folder);
  q.set('res', String(isResource));
  q.set('rel', relativePath);
  // encodeURIComponent 相对路径（可能含斜杠）
  const relEnc = encodeURIComponent(relativePath);
  // 用固定 host + path（不含真实文件路径，避免 scheme 冲突）
  return `bap-original://bap/${relEnc}?${q.toString()}`;
}

/** 从 bap-original URI 反推（用于 content provider 恢复 folder/isResource/rel）。 */
export function parseBapOriginalUri(uriPath: string, query: Record<string, string>): {
  folder: string;
  isResource: boolean;
  relativePath: string;
} {
  // 优先用 query.rel（authority：Change.relativePath，相对 src/<folder> 或 src/res）。
  // uriPath 的 path 段只是 URI 唯一标识（相对 workspace），可能带 src/core / src/res 前缀，
  // 不能用于定位云端文件，否则资源/Java 会因路径多前缀而查不到云端原版、diff 整份变新增。
  const pathRel = decodeURIComponent(uriPath.replace(/^bap-original:\/\/bap\//, ''));
  const rel = (query.rel || pathRel).replace(/^\//, '');
  return {
    folder: query.folder || '',
    isResource: query.res === 'true',
    relativePath: rel,
  };
}
