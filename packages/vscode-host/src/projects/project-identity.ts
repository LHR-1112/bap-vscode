// 后端工程身份：从 `.develop` 读 projectUuid + server URI，供重复检出与身份漂移判定。
import { loadDevelop } from '@bap/sdk';
import { normalizeServerUri } from './project-paths';

export interface ProjectIdentity {
  projectUuid: string;
  serverUri: string;
  /** `<归一化 server>|<小写 uuid>` */
  fingerprint: string;
}

/** 读取工程身份；`.develop` 缺失/无法解析时返回 undefined（不抛）。 */
export function readProjectIdentity(projectRoot: string): ProjectIdentity | undefined {
  try {
    const d = loadDevelop(projectRoot);
    const uuid = (d.projectUuid ?? '').trim();
    const uri = (d.uri ?? '').trim();
    if (!uuid || !uri) return undefined;
    return {
      projectUuid: uuid,
      serverUri: uri,
      fingerprint: `${normalizeServerUri(uri)}|${uuid.toLowerCase()}`,
    };
  } catch {
    return undefined;
  }
}

export function sameIdentity(a: ProjectIdentity | undefined, b: ProjectIdentity | undefined): boolean {
  return !!a && !!b && a.fingerprint === b.fingerprint;
}
