// 重定向历史持久化：存到 <workspaceRoot>/.bap/relocate-history.json。
// 含明文密码，仅在本地；仓库 .gitignore 已忽略 .bap/。
import * as fs from 'fs';
import * as path from 'path';

/** 一条重定向可选配置（对齐 Java RelocateProfile）。 */
export interface RelocateProfile {
  uri: string;
  user: string;
  pwd: string;
  projectUuid: string;
  projectName: string;
  adminTool?: string;
  remark?: string;
}

const FILE_NAME = 'relocate-history.json';
const MAX_HISTORY = 10;

function historyPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.bap', FILE_NAME);
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** 读取重定向历史；文件不存在/无法解析返回 []。 */
export function loadRelocateHistory(workspaceRoot: string): RelocateProfile[] {
  try {
    const raw = fs.readFileSync(historyPath(workspaceRoot), 'utf8');
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is RelocateProfile => Boolean(x && typeof x === 'object')).slice(0, MAX_HISTORY);
  } catch {
    return [];
  }
}

/** 覆盖写历史。 */
export function saveRelocateHistory(workspaceRoot: string, list: RelocateProfile[]): void {
  ensureDir(path.dirname(historyPath(workspaceRoot)));
  fs.writeFileSync(historyPath(workspaceRoot), JSON.stringify(list.slice(0, MAX_HISTORY), null, 2), 'utf8');
}

/** 去重 + 置顶 + 截断上限。同 uri+projectUuid 视为同一条。 */
export function addRelocateHistory(workspaceRoot: string, profile: RelocateProfile): RelocateProfile[] {
  const list = loadRelocateHistory(workspaceRoot);
  const deduped = list.filter((p) => !(p.uri === profile.uri && p.projectUuid === profile.projectUuid));
  const next = [profile, ...deduped].slice(0, MAX_HISTORY);
  saveRelocateHistory(workspaceRoot, next);
  return next;
}

/** 按 uri+projectUuid 移除一条历史。 */
export function removeRelocateHistory(workspaceRoot: string, profile: RelocateProfile): RelocateProfile[] {
  const next = loadRelocateHistory(workspaceRoot).filter(
    (p) => !(p.uri === profile.uri && p.projectUuid === profile.projectUuid),
  );
  saveRelocateHistory(workspaceRoot, next);
  return next;
}
