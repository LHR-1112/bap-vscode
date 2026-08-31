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

// 本地扫描缓存（按 文件 mtimeMs + size 校验）。
// 刷新最贵的是全量读 src/** 算 md5；文件未变则复用缓存，不再读盘/算 hash（安全：未变=内容未变=md5 不变），
// 云端对比仍每次进行。
const bytesCache = new Map<string, { m: number; s: number; v: string }>(); // 资源文件 bytes md5
const textCache = new Map<string, { m: number; s: number; v: string }>(); // Java 文件 utf8 原文

function statOf(abs: string): { m: number; s: number } {
  const st = fs.statSync(abs);
  return { m: st.mtimeMs, s: st.size };
}

// 资源：文件字节 md5
function cachedBytesMd5(abs: string): string {
  const st = statOf(abs);
  const h = bytesCache.get(abs);
  if (h && h.m === st.m && h.s === st.s) return h.v;
  const v = md5Bytes(fs.readFileSync(abs));
  bytesCache.set(abs, { ...st, v });
  return v;
}

// Java：utf8 原文（md5 + loose 兜底都可用）
function cachedText(abs: string): string {
  const st = statOf(abs);
  const h = textCache.get(abs);
  if (h && h.m === st.m && h.s === st.s) return h.v;
  const v = fs.readFileSync(abs, 'utf8');
  textCache.set(abs, { ...st, v });
  return v;
}

function cachedTextMd5(abs: string): string {
  return md5String(cachedText(abs));
}

function sizeOf(abs: string): number {
  return statOf(abs).s;
}

export function normalizeCloudMap(raw: Record<string, unknown>): Record<string, FileDto> {
  const out: Record<string, FileDto> = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    out[k.split(path.sep).join('/').replace(/\\/g, '/')] = (v ?? {}) as FileDto;
  }
  return out;
}

/** 列出 <root>/src 下的 folder 目录名（res 及 Java 目录）。 */
export function listSrcFolders(srcRoot: string): string[] {
  try {
    return fs
      .readdirSync(srcRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/** 取单个 folder 的云端快照（归一化路径键 + NoFolder 兜底）。 */
async function fetchCloudMap(
  projectUuid: string,
  folderName: string,
  invoker: RpcInvoker,
): Promise<Record<string, FileDto | JavaDto>> {
  const isResource = folderName === 'res';
  try {
    const raw = isResource
      ? await invoker.call('queryAllFileMap', projectUuid, folderName)
      : await invoker.call('queryCodeFile', projectUuid, folderName);
    return normalizeCloudMap((raw ?? {}) as Record<string, unknown>);
  } catch (e) {
    if (isNoFolderException(e)) return {};
    throw e;
  }
}

/**
 * 计算变更列表。
 * @param projectUuid 云工程 ID
 * @param srcRoot <workspaceRoot>/src
 * @param invoker RPC 能力
 * @param snapshot 可选：预取的云端快照 { folder -> cloudMap }；缺省则逐 folder 查询
 */
export async function refreshChanges(
  projectUuid: string,
  srcRoot: string,
  invoker: RpcInvoker,
  snapshot?: Record<string, Record<string, FileDto | JavaDto>>,
): Promise<Change[]> {
  const changes: Change[] = [];
  if (!fs.existsSync(srcRoot)) return changes;

  const folderDirs = fs
    .readdirSync(srcRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'));

  for (const dir of folderDirs) {
    const folderName = dir.name;
    const isResource = folderName === 'res';
    const folderDir = path.join(srcRoot, folderName);

    // 1) 云端快照（优先用预取的 snapshot，省 RPC）
    const cloudMap: Record<string, FileDto | JavaDto> =
      snapshot?.[folderName] ?? (await fetchCloudMap(projectUuid, folderName, invoker));

    // 2) 本地扫描 + 判定
    const local = scanFolder(folderDir, folderName);
    const seen = new Set<string>();

    for (const lf of local) {
      seen.add(lf.relativePath);
      const cloudDto = cloudMap[lf.relativePath];

      if (!cloudDto) {
        // 云无本地有 -> ADDED
        const localMd5 = lf.isResource ? cachedBytesMd5(lf.absolutePath) : cachedTextMd5(lf.absolutePath);
        changes.push({ ...lf, folder: folderName, status: 'ADDED', md5: localMd5 });
        continue;
      }

      if (lf.isResource) {
        const localMd5 = cachedBytesMd5(lf.absolutePath);
        const status = computeResourceStatus({ localMd5, bytesLength: sizeOf(lf.absolutePath), cloudMd5: cloudDto.md5 });
        changes.push({ ...lf, folder: folderName, status, md5: localMd5 });
        continue;
      }

      // Java 文件
      const content = cachedText(lf.absolutePath);
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
