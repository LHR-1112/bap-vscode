// 后端工程根定位（纯函数，不依赖 vscode，便于单测）。
//
// VotaForge 体系中，BAP 是「体系外属主」，后端工程根靠 .develop 标记发现
// （docx/architecture/workspace-protocol.md §6.1）：一个 workspace 可含 0..N 个
// 后端工程，不能假设「第一个 workspace folder 就是工程根」。
import * as fs from 'fs';
import * as path from 'path';

/** 后端工程根标记（BAP 自有协议常量，勿改名）。 */
export const DEVELOP_MARKER = '.develop';

/** VotaForge 工程根标记文件。 */
export const VF_WORKSPACE_FILE = 'votaforge.workspace.json';

/** VotaForge 工程根私有目录（存在即视为 vf 工作区）。 */
export const VF_DIR = '.votaforge';

/** 扫描时默认跳过的目录：构建产物、依赖、缓存、工具目录。 */
const DEFAULT_EXCLUDE_DIRS: readonly string[] = [
  'node_modules',
  'target',
  'build',
  'out',
  'dist',
  'bin',
  'lib',
  'api',
  'coverage',
];

export interface BackendProjectRoot {
  /** 工程根绝对路径（含 .develop 的目录）。 */
  root: string;
  /** 目录名，仅用于展示，不是唯一键。 */
  name: string;
  /** 该工程所属的 workspace folder 绝对路径。 */
  workspaceFolder: string;
  /** 相对所属 workspace folder 的路径（POSIX 分隔符）；工程根即 folder 时为 '.'。 */
  relativePath: string;
}

export interface ScanOptions {
  /** 最大下探层数，workspace folder 自身为 0 层。默认 4。 */
  maxDepth?: number;
  /** 追加的排除目录名（大小写敏感）。 */
  excludeDirNames?: readonly string[];
}

/** 路径是否位于 dir 内（含相等）。 */
function isInside(dir: string, target: string): boolean {
  const rel = path.relative(dir, target);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

/** 是否为后端工程根：目录下存在 .develop 普通文件。 */
export function isBackendProjectRoot(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, DEVELOP_MARKER)).isFile();
  } catch {
    return false;
  }
}

/**
 * 扫描 workspace folders，返回所有含 .develop 的目录（深度受限、去重、确定性排序）。
 * 找到工程根后不再向下扫描，避免把工程内部的偶然同名文件当成嵌套工程。
 */
export function scanBackendProjectRoots(
  workspaceFolders: readonly string[],
  options: ScanOptions = {},
): BackendProjectRoot[] {
  const maxDepth = Math.max(0, options.maxDepth ?? 4);
  const excludes = new Set([...DEFAULT_EXCLUDE_DIRS, ...(options.excludeDirNames ?? [])]);
  const found: BackendProjectRoot[] = [];
  const seenProjects = new Set<string>();

  const walk = (dir: string, depth: number, workspaceFolder: string): void => {
    if (isBackendProjectRoot(dir)) {
      let real = dir;
      try {
        real = fs.realpathSync(dir);
      } catch {
        /* 保持原路径 */
      }
      if (!seenProjects.has(real)) {
        seenProjects.add(real);
        const rel = path.relative(workspaceFolder, dir);
        found.push({
          root: dir,
          name: path.basename(dir) || dir,
          workspaceFolder,
          relativePath: (rel ? rel.split(path.sep).join('/') : '.'),
        });
      }
      return;
    }
    if (depth >= maxDepth) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // 排序保证结果与文件系统枚举顺序无关。
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (!entry.isDirectory()) continue; // 符号链接目录 isDirectory() === false
      if (entry.name.startsWith('.')) continue;
      if (excludes.has(entry.name)) continue;
      walk(path.join(dir, entry.name), depth + 1, workspaceFolder);
    }
  };

  for (const folder of workspaceFolders) {
    if (!folder) continue;
    const abs = path.resolve(folder);
    try {
      if (!fs.statSync(abs).isDirectory()) continue;
    } catch {
      continue;
    }
    walk(abs, 0, abs);
  }

  found.sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
  return found;
}

/** 是否为 VotaForge 工作区根：存在 votaforge.workspace.json 或 .votaforge/ 目录（不解析其内容）。 */
export function isVfWorkspaceRoot(root: string): boolean {
  try {
    if (fs.statSync(path.join(root, VF_WORKSPACE_FILE)).isFile()) return true;
  } catch {
    /* ignore */
  }
  try {
    if (fs.statSync(path.join(root, VF_DIR)).isDirectory()) return true;
  } catch {
    /* ignore */
  }
  return false;
}

/** 把云端工程名转成安全的单层目录名。 */
export function sanitizeProjectDirName(name: string): string {
  let s = (name ?? '').trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
  s = s.replace(/^\.+/, '').replace(/[. ]+$/g, '');
  if (!s || s === '.' || s === '..') return 'bap-project';
  if (s.length > 80) s = s.slice(0, 80).replace(/[. ]+$/g, '');
  return s || 'bap-project';
}

/**
 * 解析下载目标目录。
 * - 独立 BAP 工作区：默认下载到工作区根（保持既有行为）；
 * - VotaForge 工作区：默认下载到 <root>/<工程名>，禁止落到工作区根；
 * - requested 为相对工作区根的路径，必须位于工作区内。
 */
export function resolveDownloadTargetDir(
  workspaceRoot: string,
  projectName: string,
  requested?: string,
): string {
  const root = path.resolve(workspaceRoot);
  const vf = isVfWorkspaceRoot(root);
  const trimmed = requested?.trim();

  let target: string;
  if (trimmed) {
    if (path.isAbsolute(trimmed)) {
      throw new Error('目标目录必须是相对工作区根的路径');
    }
    target = path.resolve(root, trimmed);
    if (!isInside(root, target)) {
      throw new Error('目标目录必须位于工作区内');
    }
  } else {
    target = vf ? path.join(root, sanitizeProjectDirName(projectName)) : root;
  }

  if (vf && target === root) {
    throw new Error('VotaForge 工作区中请把工程下载到子目录，避免污染工作区根');
  }
  return target;
}

/** 目录内是否已有条目（目录不存在或不可读时返回 false）。 */
export function directoryHasEntries(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}
