// commit：组装 CommitPackage（复刻生产插件 CommitAllAction/CommitFileAction），并调用 commitCode 原子提交。
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { dirToPackage, toFullClass } from './file-scanner';
import type { Change, CJavaCode, CJavaFolderDto, CommitPackage, CResFileDto, RpcInvoker } from './types';
import type { JsonValue as JV } from '@bap/rpc';

export function allocUuidWithUnderline(): string {
  return crypto.randomUUID().replace(/-/g, '_');
}

function basename(p: string): string {
  return p.split('/').pop() ?? p;
}

/**
 * 组装 CommitPackage。
 * @param opts.projectUuid 云工程 ID
 * @param opts.changes refresh 产出的变更（仅非 NORMAL）
 * @param opts.folders 工程 folder 列表（查询 owner uuid）
 * @param opts.invoker RPC 能力
 */
export async function buildCommitPackage(opts: {
  projectUuid: string;
  changes: Change[];
  comments: string;
  folders: CJavaFolderDto[];
  invoker: RpcInvoker;
}): Promise<CommitPackage> {
  const { projectUuid, changes, comments, folders, invoker } = opts;
  const folderUuid = new Map(folders.map((f) => [f.name, f.uuid]));

  const mapFolder2Codes: Record<string, CJavaCode[]> = {};
  const deleteCodeMap: Record<string, string[]> = {};
  const mapFolder2Files: Record<string, CResFileDto[]> = {};
  const deleteFileMap: Record<string, string[]> = {};

  const pushCode = (folder: string, code: CJavaCode) => (mapFolder2Codes[folder] ??= []).push(code);
  const pushFile = (folder: string, f: CResFileDto) => (mapFolder2Files[folder] ??= []).push(f);
  const add = (m: Record<string, string[]>, folder: string, v: string) => {
    (m[folder] ??= []).push(v);
  };

  for (const ch of changes) {
    if (ch.status === 'NORMAL') continue;

    if (ch.isResource) {
      const folder = 'res';
      if (ch.status === 'DELETED_LOCALLY') {
        add(deleteFileMap, folder, '/' + ch.relativePath);
        continue;
      }
      const bytes = fs.readFileSync(ch.absolutePath);
      const dto: CResFileDto = {
        projectUuid,
        filePackage: dirToPackage(ch.relativePath),
        fileName: basename(ch.relativePath),
        fileBin: bytes.toString('base64'),
        size: bytes.length,
        owner: folderUuid.get(folder),
      };
      const existing = (await invoker.call('getResFile', projectUuid, ch.relativePath, false)) as CResFileDto | null;
      if (existing?.uuid) dto.uuid = existing.uuid;
      pushFile(folder, dto);
      continue;
    }

    // Java
    const folder = ch.folder;
    const fullClass = ch.fullClass ?? toFullClass(ch.relativePath);
    if (ch.status === 'DELETED_LOCALLY') {
      add(deleteCodeMap, folder, fullClass);
      continue;
    }

    const content = fs.readFileSync(ch.absolutePath, 'utf8');
    const lastDot = fullClass.lastIndexOf('.');
    const code: CJavaCode = {
      projectUuid,
      mainClass: lastDot > 0 ? fullClass.slice(lastDot + 1) : fullClass,
      javaPackage: lastDot > 0 ? fullClass.slice(0, lastDot) : '',
      code: content,
      owner: folderUuid.get(folder),
    };
    if (ch.status === 'MODIFIED') {
      const remote = (await invoker.call('getJavaCode', projectUuid, fullClass)) as CJavaCode | null;
      code.uuid = remote?.uuid ?? undefined;
    } else if (ch.status === 'ADDED') {
      code.uuid = allocUuidWithUnderline();
    }
    pushCode(folder, code);
  }

  return { comments, mapFolder2Codes, deleteCodeMap, mapFolder2Files, deleteFileMap };
}

/** 调用 atomic commitCode。 */
export async function commitCode(projectUuid: string, pkg: CommitPackage, invoker: RpcInvoker): Promise<void> {
  await invoker.call('commitCode', projectUuid, pkg as unknown as JV);
}
