// 后端工程发现：扫描结果 → 带稳定 ID / 展示名 / 身份的描述符（纯函数）。
import {
  scanBackendProjectRoots,
  type BackendProjectRoot,
  type ScanOptions,
} from '../backend-projects';
import { computeProjectId, assignUniqueDisplayNames, assignDuplicateFingerprints } from './project-id';
import { readProjectIdentity } from './project-identity';

export interface BackendProjectDescriptor extends BackendProjectRoot {
  /** 稳定主键，形如 `<workspace slug>-<hash>:<相对路径>`。 */
  projectId: string;
  /** 唯一展示名（同名工程会追加 workspace / 相对路径消歧）。 */
  displayName: string;
  projectUuid?: string;
  serverUri?: string;
  /** `<归一化 server>|<小写 uuid>`，仅在 .develop 可解析时存在。 */
  fingerprint?: string;
  /** 若同一云端工程被检出多份，值为该 projectUuid。 */
  duplicateProjectUuid?: string;
  /** 同一云端工程的其他检出 projectId。 */
  peerProjectIds: string[];
}

/** 把扫描结果补齐为工程描述符（ID、展示名、身份、重复检出标记）。 */
export function buildProjectDescriptors(roots: readonly BackendProjectRoot[]): BackendProjectDescriptor[] {
  const usedIds = new Set<string>();
  const descriptors: BackendProjectDescriptor[] = roots.map((r) => {
    const folderReal = r.workspaceFolderRealRoot ?? r.workspaceFolder;
    let projectId = computeProjectId(folderReal, r.relativePath);
    if (usedIds.has(projectId)) {
      let i = 2;
      while (usedIds.has(`${projectId}~${i}`)) i++;
      projectId = `${projectId}~${i}`;
    }
    usedIds.add(projectId);
    const identity = readProjectIdentity(r.root);
    return {
      ...r,
      projectId,
      displayName: r.name,
      projectUuid: identity?.projectUuid,
      serverUri: identity?.serverUri,
      fingerprint: identity?.fingerprint,
      peerProjectIds: [],
    };
  });

  assignUniqueDisplayNames(descriptors);
  assignDuplicateFingerprints(descriptors);
  return descriptors;
}

/** 扫描 workspace folders 并构建描述符。 */
export function discoverProjectDescriptors(
  workspaceFolders: readonly string[],
  options?: ScanOptions,
): BackendProjectDescriptor[] {
  return buildProjectDescriptors(scanBackendProjectRoots(workspaceFolders, options));
}
