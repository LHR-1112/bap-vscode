// 后端工程根定位（纯函数，不依赖 vscode，便于单测）。
//
// VotaForge 体系中，BAP 是「体系外属主」，后端工程根靠 .develop 标记发现
// （docs/architecture/workspace-protocol.md §6.1）：一个 workspace 可含 0..N 个
// 后端工程，不能假设「第一个 workspace folder 就是工程根」。
import * as fs from 'fs';
import * as path from 'path';

/** 后端工程根标记（BAP 自有协议常量，勿改名）。 */
export const DEVELOP_MARKER = '.develop';

/** VotaForge 工程根标记文件。 */
export const VF_WORKSPACE_FILE = 'votaforge.workspace.json';

/** VotaForge 工程根私有目录（存在即视为 vf 工作区）。 */
export const VF_DIR = '.votaforge';

/**
 * 硬排除：依赖 / VCS / vf / bap 私有目录。不检查 .develop、也不下探。
 * 这些目录下的 `.develop` 即使存在也不视为工程（避免依赖包、工具缓存污染发现结果）。
 */
const HARD_EXCLUDE_DIRS: readonly string[] = ['node_modules', '.git', '.svn', '.votaforge', '.bap'];

/**
 * 软排除：构建产物 / 依赖输出目录。只检查 `<dir>/.develop`，不再向下扫描。
 * 工程若恰好位于 target/ 等目录内仍能被发现，但不会把构建产物里的副本当成新工程。
 */
const SOFT_EXCLUDE_DIRS: readonly string[] = [
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
  /** 工程根绝对路径（含 .develop 的目录，保留 workspace folder 的原始写法）。 */
  root: string;
  /** 工程根 realpath（符号链接展开），用于去重。 */
  realRoot: string;
  /** 目录名，仅用于展示，不是唯一键。 */
  name: string;
  /** 该工程所属的 workspace folder 绝对路径。 */
  workspaceFolder: string;
  /** 所属 workspace folder 的 realpath，用于稳定 projectId。 */
  workspaceFolderRealRoot: string;
  /** 相对所属 workspace folder 的路径（POSIX 分隔符）；工程根即 folder 时为 '.'。 */
  relativePath: string;
  /** 工程根在 workspace folder 下的层数（folder 自身为 0）。 */
  depth: number;
}

export interface ScanOptions {
  /** 最大下探层数，workspace folder 自身为 0 层。默认 4。 */
  maxDepth?: number;
  /** 追加的硬排除目录名（不下探、不检查）。 */
  excludeDirNames?: readonly string[];
}

/** 路径是否位于 dir 内（含相等）。 */
function isInside(dir: string, target: string): boolean {
  const rel = path.relative(dir, target);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
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
  const hardExcludes = new Set([...HARD_EXCLUDE_DIRS, ...(options.excludeDirNames ?? [])]);
  const found: BackendProjectRoot[] = [];
  const seenProjects = new Set<string>();

  const walk = (dir: string, depth: number, workspaceFolder: string, workspaceReal: string): void => {
    if (isBackendProjectRoot(dir)) {
      const real = realpathOr(dir);
      if (!seenProjects.has(real)) {
        seenProjects.add(real);
        const rel = path.relative(workspaceFolder, dir);
        found.push({
          root: dir,
          realRoot: real,
          name: path.basename(dir) || dir,
          workspaceFolder,
          workspaceFolderRealRoot: workspaceReal,
          relativePath: rel ? rel.split(path.sep).join('/') : '.',
          depth,
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
      if (hardExcludes.has(entry.name)) continue;
      const child = path.join(dir, entry.name);
      // 软排除：只把该目录本身当候选工程根检查，不继续下探。
      if (SOFT_EXCLUDE_DIRS.includes(entry.name)) {
        if (isBackendProjectRoot(child)) walk(child, depth + 1, workspaceFolder, workspaceReal);
        continue;
      }
      walk(child, depth + 1, workspaceFolder, workspaceReal);
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
    walk(abs, 0, abs, realpathOr(abs));
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

/**
 * 从 workspace folders 中找出所有 VotaForge 根（存在 votaforge.workspace.json 或 .votaforge/）。
 * 按 realpath 去重并排序；返回原始路径写法。
 */
export function findVfWorkspaceRoots(workspaceFolders: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const folder of workspaceFolders) {
    if (!folder) continue;
    const abs = path.resolve(folder);
    if (!isVfWorkspaceRoot(abs)) continue;
    const real = realpathOr(abs);
    if (seen.has(real)) continue;
    seen.add(real);
    out.push(abs);
  }
  out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return out;
}

/** 找出包含指定后端工程的 VotaForge 根（嵌套时取最深者）。 */
export function findVfWorkspaceRoot(
  projectRoot: string,
  workspaceFolders: readonly string[],
): string | undefined {
  const realProject = realpathOr(path.resolve(projectRoot));
  let best: string | undefined;
  let bestLen = -1;
  for (const vf of findVfWorkspaceRoots(workspaceFolders)) {
    const realVf = realpathOr(vf);
    if (!isInside(realVf, realProject)) continue;
    if (realVf.length > bestLen) {
      best = vf;
      bestLen = realVf.length;
    }
  }
  return best;
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

export interface ValidateDownloadTargetOptions {
  /** 目标工作区是否为 VotaForge 工作区（禁止落到根）。 */
  vf?: boolean;
  /** 当前窗口已发现的工程根：目标不能与它们重叠。 */
  existingProjectRoots?: readonly string[];
}

export interface DownloadTargetValidation {
  destDir: string;
  /** 目标目录已存在且非空（调用方决定交互确认还是拒绝）。 */
  existsNonEmpty: boolean;
}

/**
 * 下载落点严格校验（P0-2 的严格化版本）：
 * - 必须在工作区内；
 * - vf 工作区不能落到工作区根；
 * - 目标不能是已有后端工程、不能包含已有工程、不能位于已有工程内；
 * - 目标自身不能已有 `.develop`；
 * - 目标若是文件则拒绝。
 * 返回 existsNonEmpty 供调用方决定「UI 二次确认 / MCP 直接拒绝」。
 */
export function validateDownloadTarget(
  workspaceRoot: string,
  destDir: string,
  options: ValidateDownloadTargetOptions = {},
): DownloadTargetValidation {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(destDir);

  if (!isInside(root, target)) {
    throw new Error('目标目录必须位于工作区内');
  }
  if (options.vf && target === root) {
    throw new Error('VotaForge 工作区中请把工程下载到子目录，避免污染工作区根');
  }
  try {
    if (fs.statSync(target).isFile()) throw new Error(`目标路径是文件：${target}`);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('目标路径是文件')) throw e;
    /* 不存在：继续 */
  }
  if (isBackendProjectRoot(target)) {
    throw new Error(`目标目录已是后端工程（含 .develop）：${target}`);
  }
  for (const projectRoot of options.existingProjectRoots ?? []) {
    if (!projectRoot) continue;
    const pr = path.resolve(projectRoot);
    if (isInside(target, pr)) {
      throw new Error(`目标目录包含已有后端工程：${target}`);
    }
    if (isInside(pr, target)) {
      throw new Error(`目标目录位于已有后端工程内：${target}`);
    }
  }
  return { destDir: target, existsNonEmpty: directoryHasEntries(target) };
}
