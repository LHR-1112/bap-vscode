// 稳定 projectId 与展示名分配（纯函数）。
//
// projectId 约束（整改清单 P1-2）：不能用目录 basename 或云端工程名做主键。
// 组成：<workspace 目录 slug>-<workspace 真实路径 sha1 前 8 位>:<相对 workspace 的路径>
// 例：`oa-a1b2c3d4:backend/gpf_demo`、`oa-a1b2c3d4:.`。
import * as path from 'path';
import { createHash } from 'crypto';
import { sanitizeProjectDirName } from '../backend-projects';
import { normalizeServerUri, pathKey } from './project-paths';

/** workspace 目录名 → 展示用短 slug（最长 40）。 */
export function workspaceFolderSlug(folderRealRoot: string): string {
  const base = path.basename(path.resolve(folderRealRoot)) || 'workspace';
  const slug = sanitizeProjectDirName(base).slice(0, 40).replace(/[. ]+$/g, '');
  return slug || 'workspace';
}

/** 由 workspace 真实根 + 工程相对路径计算稳定 projectId。 */
export function computeProjectId(folderRealRoot: string, relativePath: string): string {
  const real = path.resolve(folderRealRoot);
  const hash = createHash('sha1').update(pathKey(real)).digest('hex').slice(0, 8);
  const rel =
    !relativePath || relativePath === '.'
      ? '.'
      : relativePath.split(path.sep).join('/').replace(/^\/+|\/+$/g, '');
  return `${workspaceFolderSlug(real)}-${hash}:${rel || '.'}`;
}

export interface DisplayNameCandidate {
  name: string;
  workspaceFolder: string;
  relativePath: string;
  projectId: string;
  displayName: string;
}

/**
 * 就地分配唯一展示名。
 * 同名工程依次尝试：`<name> · <workspace 目录>`、`<name> · <相对路径>`、`<name> · <projectId 后缀>`。
 * SourceControl.label 创建后不可改，所以必须在创建 provider 前算好。
 */
export function assignUniqueDisplayNames(candidates: DisplayNameCandidate[]): void {
  const baseCount = new Map<string, number>();
  for (const c of candidates) baseCount.set(c.name, (baseCount.get(c.name) ?? 0) + 1);

  const used = new Set<string>();
  for (const c of candidates) {
    const base = c.name || 'BAP 工程';
    const options: string[] = [base];
    if ((baseCount.get(c.name) ?? 0) > 1) {
      const folder = path.basename(c.workspaceFolder) || 'workspace';
      options.push(`${base} · ${folder}`);
      if (c.relativePath && c.relativePath !== '.') options.push(`${base} · ${c.relativePath}`);
      options.push(`${base} · ${c.projectId.split(':').pop() || c.projectId}`);
    }
    let chosen = options.find((o) => !used.has(o));
    if (!chosen) {
      let i = 2;
      while (used.has(`${base} (${i})`)) i++;
      chosen = `${base} (${i})`;
    }
    used.add(chosen);
    c.displayName = chosen;
  }
}

export interface DuplicateCandidate {
  projectId: string;
  projectUuid?: string;
  serverUri?: string;
  fingerprint?: string;
  duplicateProjectUuid?: string;
  peerProjectIds: string[];
}

/**
 * 就地标记「同一云端工程被检出多份」：fingerprint = 归一化 server URI | 小写 projectUuid。
 * 仅在 uid + server 都可用时判定；同目录重复扫描已在上游去重。
 */
export function assignDuplicateFingerprints(candidates: DuplicateCandidate[]): void {
  const groups = new Map<string, DuplicateCandidate[]>();
  for (const c of candidates) {
    c.peerProjectIds = [];
    c.duplicateProjectUuid = undefined;
    if (!c.projectUuid || !c.serverUri) continue;
    const fp = `${normalizeServerUri(c.serverUri)}|${c.projectUuid.trim().toLowerCase()}`;
    c.fingerprint = fp;
    const list = groups.get(fp);
    if (list) list.push(c);
    else groups.set(fp, [c]);
  }
  for (const [fp, list] of groups) {
    if (list.length < 2) continue;
    for (const c of list) {
      c.fingerprint = fp;
      c.duplicateProjectUuid = c.projectUuid;
      c.peerProjectIds = list.filter((o) => o.projectId !== c.projectId).map((o) => o.projectId);
    }
  }
}
