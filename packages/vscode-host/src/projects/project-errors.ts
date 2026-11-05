// 工程解析错误（独立模块，避免 registry ↔ context 循环依赖）。
export type ProjectResolutionCode =
  | 'NO_PROJECTS'
  | 'AMBIGUOUS'
  | 'UNKNOWN_PROJECT'
  | 'INVALID_PROJECT'
  | 'OUTSIDE_PROJECT'
  | 'PROJECT_STALE'
  | 'DUPLICATE_CHECKOUT'
  | 'CANCELLED'
  | 'DISPOSED';

export interface ProjectCandidate {
  projectId: string;
  displayName: string;
  root?: string;
}

export class ProjectResolutionError extends Error {
  constructor(
    message: string,
    readonly code: ProjectResolutionCode,
    readonly candidates: ProjectCandidate[] = [],
  ) {
    super(message);
    this.name = 'ProjectResolutionError';
  }
}

export function isProjectResolutionError(e: unknown): e is ProjectResolutionError {
  return e instanceof ProjectResolutionError;
}

/** 把候选工程拼成可读列表（用于歧义错误与提示）。 */
export function formatCandidates(candidates: readonly ProjectCandidate[]): string {
  return candidates.map((c) => `· ${c.displayName}（${c.projectId}）`).join('\n');
}
