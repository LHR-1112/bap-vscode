// refresh：云端基线（queryCodeFile/queryAllFileMap）MD5 对比本地，得出变更列表。
// 复刻生产插件 ProjectRefresher 的判定逻辑。
import * as fs from 'fs';
import * as path from 'path';
import { scanFolder } from './file-scanner';
import { computeJavaStatus, computeResourceStatus, md5Bytes, md5String } from './status';
import type { Change, FileDto, JavaDto, RpcInvoker } from './types';

/** 云端无该 folder 时 queryCodeFile/queryAllFileMap 抛 NoFolderException，视为空。 */
export function isNoFolderException(e: unknown): boolean {
  const err = e as { code?: string; name?: string; message?: string };
  const s = `${err?.code ?? ''} ${err?.name ?? ''} ${err?.message ?? ''}`;
  return s.includes('NoFolderException') || s.includes('NoFolder');
}

function normalizeKeys(raw: Record<string, unknown>): Record<string, FileDto> {
  const out: Record<string, FileDto> = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    out[k.split(path.sep).join('/').replace(/\\/g, '/')] = (v ?? {}) as FileDto;
  }
  return out;
}

/**
 * 计算变更列表。
 * @param projectUuid 云工程 ID
 * @param srcRoot <workspaceRoot>/src
 * @param invoker RPC 能力
 */
export async function refreshChanges(projectUuid: string, srcRoot: string, invoker: RpcInvoker): Promise<Change[]> {
  const changes: Change[] = [];
  if (!fs.existsSync(srcRoot)) return changes;

  const folderDirs = fs
    .readdirSync(srcRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'));

  for (const dir of folderDirs) {
    const folderName = dir.name;
    const isResource = folderName === 'res';
    const folderDir = path.join(srcRoot, folderName);

    // 1) 云端快照
    let cloudMap: Record<string, FileDto | JavaDto> = {};
    try {
      const raw = isResource
        ? await invoker.call('queryAllFileMap', projectUuid, folderName)
        : await invoker.call('queryCodeFile', projectUuid, folderName);
      cloudMap = normalizeKeys((raw ?? {}) as Record<string, unknown>);
    } catch (e) {
      if (isNoFolderException(e)) cloudMap = {};
      else throw e;
    }

    // 2) 本地扫描 + 判定
    const local = scanFolder(folderDir, folderName);
    const seen = new Set<string>();

    for (const lf of local) {
      seen.add(lf.relativePath);
      const cloudDto = cloudMap[lf.relativePath];

      if (!cloudDto) {
        // 云无本地有 -> ADDED
        const localMd5 = lf.isResource
          ? md5Bytes(fs.readFileSync(lf.absolutePath))
          : md5String(fs.readFileSync(lf.absolutePath, 'utf8'));
        changes.push({ ...lf, folder: folderName, status: 'ADDED', md5: localMd5 });
        continue;
      }

      if (lf.isResource) {
        const bytes = fs.readFileSync(lf.absolutePath);
        const localMd5 = md5Bytes(bytes);
        const status = computeResourceStatus({ localMd5, bytesLength: bytes.length, cloudMd5: cloudDto.md5 });
        changes.push({ ...lf, folder: folderName, status, md5: localMd5 });
        continue;
      }

      // Java 文件
      const content = fs.readFileSync(lf.absolutePath, 'utf8');
      const remoteCode = await remoteJavaCode(projectUuid, cloudDto as JavaDto, lf.fullClass!, invoker);
      const status = computeJavaStatus({ local: content, cloudMd5: cloudDto.md5, remoteCode });
      changes.push({ ...lf, folder: folderName, status, md5: md5String(content) });
    }

    // 3) 云有本地无 -> DELETED_LOCALLY
    for (const rel of Object.keys(cloudMap)) {
      if (seen.has(rel)) continue;
      changes.push({
        relativePath: rel,
        absolutePath: path.join(folderDir, rel.split('/').join(path.sep)),
        folder: folderName,
        status: 'DELETED_LOCALLY',
        isResource,
        fullClass: isResource ? undefined : rel.replace(/\.java$/i, '').split('/').join('.'),
        md5: cloudMap[rel].md5 ?? '',
      });
    }
  }
  return changes;
}

/** 取云端 Java 原文用于 loose 兜底；失败返回 undefined。 */
async function remoteJavaCode(
  projectUuid: string,
  cloudDto: JavaDto,
  fallbackClass: string,
  invoker: RpcInvoker,
): Promise<string | undefined> {
  const fullClass = cloudDto.fullClass ?? fallbackClass;
  try {
    const remote = (await invoker.call('getJavaCode', projectUuid, fullClass)) as { code?: string } | null;
    return remote?.code;
  } catch {
    return undefined;
  }
}
