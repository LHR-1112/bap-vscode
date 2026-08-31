// BapSdk 工厂 + 高层业务方法（面向业务，不暴露 RPC）。
import * as fs from 'fs';
import * as path from 'path';
import { loadDevelop, writeDevelop } from './develop';
import { refreshChanges, listSrcFolders, normalizeCloudMap, isNoFolderException } from './refresh';
import { buildCommitPackage, commitCode } from './commit';
import { addRelocateHistory, type RelocateProfile } from './relocate';
import { syncLibs, type SyncProgress, type SyncResult } from './libs';
import type {
  Change,
  CJavaCode,
  CJavaFolderDto,
  CJavaProjectDto,
  CommitPackage,
  CommitResult,
  CResFileDto,
  DevelopConfig,
  FileDto,
  JavaDto,
  RpcInvoker,
  VersionNode,
} from './types';
import type { SessionDto as SDto } from '@bap/rpc';

export interface BapSdkOptions {
  /** RPC 能力（由宿主注入；apps/vscode 传 createRpcClient() 即可，结构兼容）。 */
  rpc: RpcInvoker;
  /** BAP 工程根目录（含 .develop）。 */
  workspaceRoot: string;
  /** 业务日志回调（宿主接到「BAP IDE」输出通道）。 */
  onLog?: (msg: string) => void;
  /** 云端快照 TTL（毫秒）：自动刷新在 TTL 内复用云端快照比对、不重查云端。默认 10000。 */
  cloudSnapshotTtlMs?: number;
}

export interface BapSdk {
  login(): Promise<{ develop: DevelopConfig; session: SDto; project: CJavaProjectDto }>;
  /** 刷新变更列表。force=true 强制重拉云端快照（手动刷新）；否则 TTL 内复用缓存快照。 */
  refresh(force?: boolean): Promise<Change[]>;
  project: {
    list(): Promise<CJavaProjectDto[]>;
    get(): Promise<CJavaProjectDto>;
    getFolders(): Promise<CJavaFolderDto[]>;
  };
  /** 历史：项目版本 / 某版本文件 / 文件版本 / 历史内容。 */
  history: {
    queryVersionList(): Promise<VersionNode[]>;
    queryVersionDetail(versionNo: number): Promise<VersionNode[]>;
    queryFileHistory(remoteKey: string): Promise<VersionNode[]>;
    getHistoryCode(uuid: string): Promise<CJavaCode | null>;
    getHistoryFile(uuid: string): Promise<CResFileDto | null>;
  };
  code: {
    save(comment?: string): Promise<CommitResult>;
    saveChanges(changes: Change[], comment?: string): Promise<CommitResult>;
    getRemote(fullClass: string): Promise<CJavaCode | null>;
    getRes(filePath: string): Promise<CResFileDto | null>;
  };
  publish: {
    gray(opts?: { requireCompile?: boolean }): Promise<void>;
    full(opts?: { ignoreErrors?: boolean }): Promise<void>;
  };
  /** 重定向：用给定的 server 连接列出工程 / 改写 .develop 并断开（下次 refresh 用新配置重连）。 */
  redirect: {
    probe(uri: string, user: string, pwd: string): Promise<CJavaProjectDto[]>;
    apply(profile: RelocateProfile): Promise<void>;
  };
  /** 丢弃变更：把变更还原到云端（MODIFIED/DELETED 用云端原版覆盖，ADDED 删除本地）。 */
  discardAll(changes: Change[]): Promise<void>;
  /** 更新依赖：同步 <workspaceRoot>/lib 到云端（按 md5 更新 + 删除云端无的本地 lib）。 */
  syncLibs(onProgress?: (p: SyncProgress) => void, onLog?: (msg: string) => void): Promise<SyncResult>;
  disconnect(): Promise<void>;
}

export function createBapSdk(options: BapSdkOptions): BapSdk {
  const { rpc, workspaceRoot } = options;
  const srcRoot = path.join(workspaceRoot, 'src');
  let develop: DevelopConfig | null = null;
  let session: SDto | null = null;
  const log = (msg: string): void => options.onLog?.(msg);

  // 云端快照缓存（自动刷新在 TTL 内复用，省 queryCodeFile/queryAllFileMap RPC）
  const SNAP_TTL_MS = options.cloudSnapshotTtlMs ?? 30000;
  let cloudSnapshot: { t: number; data: Record<string, Record<string, FileDto | JavaDto>> } | null = null;

  async function fetchCloudSnapshot(
    projectUuid: string,
    force: boolean,
  ): Promise<Record<string, Record<string, FileDto | JavaDto>>> {
    if (!force && cloudSnapshot && Date.now() - cloudSnapshot.t < SNAP_TTL_MS) {
      return cloudSnapshot.data;
    }
    const data: Record<string, Record<string, FileDto | JavaDto>> = {};
    for (const folderName of listSrcFolders(srcRoot)) {
      const isResource = folderName === 'res';
      try {
        const raw = isResource
          ? await rpc.call('queryAllFileMap', projectUuid, folderName)
          : await rpc.call('queryCodeFile', projectUuid, folderName);
        data[folderName] = normalizeCloudMap((raw ?? {}) as Record<string, unknown>);
      } catch (e) {
        if (isNoFolderException(e)) data[folderName] = {};
        else throw e;
      }
    }
    cloudSnapshot = { t: Date.now(), data };
    return data;
  }

  async function ensureConnected(): Promise<{ develop: DevelopConfig; session: SDto; projectUuid: string }> {
    if (!develop) develop = loadDevelop(workspaceRoot);
    if (!session) {
      session = await rpc.connect(develop.uri, develop.user, develop.pwd);
    }
    return { develop, session, projectUuid: develop.projectUuid };
  }

  async function ensureProjectUuid(): Promise<string> {
    return (await ensureConnected()).projectUuid;
  }

  return {
    async login() {
      log('[login] 开始');
      const { develop: d, session: s } = await ensureConnected();
      const project = (await rpc.call('getProject', d.projectUuid)) as CJavaProjectDto;
      log(`[login] 完成，project=${project.name}`);
      return { develop: d, session: s, project };
    },

    async refresh(force = false) {
      log('[refresh] 开始');
      const projectUuid = await ensureProjectUuid();
      const snapshot = await fetchCloudSnapshot(projectUuid, force);
      const changes = await refreshChanges(projectUuid, srcRoot, rpc, snapshot);
      log(`[refresh] 完成，变更=${changes.filter((c) => c.status !== 'NORMAL').length}`);
      return changes;
    },

    project: {
      async list() {
        await ensureProjectUuid();
        return rpc.call('getAllProjects') as Promise<CJavaProjectDto[]>;
      },
      async get() {
        const projectUuid = await ensureProjectUuid();
        return rpc.call('getProject', projectUuid) as Promise<CJavaProjectDto>;
      },
      async getFolders() {
        const projectUuid = await ensureProjectUuid();
        return rpc.call('getFolders', projectUuid) as Promise<CJavaFolderDto[]>;
      },
    },

    history: {
      async queryVersionList() {
        log('[history.queryVersionList] 开始');
        const projectUuid = await ensureProjectUuid();
        const list = (await rpc.call('queryVersionList', projectUuid)) as VersionNode[];
        log(`[history.queryVersionList] 完成，版本=${list.length}`);
        return list;
      },
      async queryVersionDetail(versionNo) {
        log(`[history.queryVersionDetail] 开始，versionNo=${versionNo}`);
        const projectUuid = await ensureProjectUuid();
        const list = (await rpc.call('queryVersionDetail', projectUuid, versionNo, true)) as VersionNode[];
        log(`[history.queryVersionDetail] 完成，文件=${list.length}`);
        return list;
      },
      async queryFileHistory(remoteKey) {
        log(`[history.queryFileHistory] 开始，key=${remoteKey}`);
        const projectUuid = await ensureProjectUuid();
        const list = (await rpc.call('queryFileHistory', projectUuid, remoteKey)) as VersionNode[];
        log(`[history.queryFileHistory] 完成，版本=${list.length}`);
        return list;
      },
      async getHistoryCode(uuid) {
        log(`[history.getHistoryCode] uuid=${uuid}`);
        try {
          const code = (await rpc.call('getHistoryCode', uuid)) as CJavaCode | null;
          log(`[history.getHistoryCode] ${code ? '命中' : '未命中'}`);
          return code;
        } catch {
          log(`[history.getHistoryCode] 失败`);
          return null;
        }
      },
      async getHistoryFile(uuid) {
        log(`[history.getHistoryFile] uuid=${uuid}`);
        try {
          const dto = (await rpc.call('getHistoryFile', uuid)) as CResFileDto | null;
          log(`[history.getHistoryFile] ${dto ? '命中' : '未命中'}`);
          return dto;
        } catch {
          log(`[history.getHistoryFile] 失败`);
          return null;
        }
      },
    },

    code: {
      async save(comment = '') {
        log('[code.save] 开始');
        const projectUuid = await ensureProjectUuid();
        const changes = await refreshChanges(projectUuid, srcRoot, rpc);
        const r = await doSave(projectUuid, changes, comment, rpc);
        log(`[code.save] 完成，提交文件=${changes.filter((c) => c.status !== 'NORMAL').length}`);
        return r;
      },
      async saveChanges(changes, comment = '') {
        log(`[code.saveChanges] 开始，文件=${changes.length}`);
        const projectUuid = await ensureProjectUuid();
        const r = await doSave(projectUuid, changes, comment, rpc);
        log(`[code.saveChanges] 完成，提交文件=${changes.length}`);
        return r;
      },
      async getRemote(fullClass) {
        const projectUuid = await ensureProjectUuid();
        try {
          return (await rpc.call('getJavaCode', projectUuid, fullClass)) as CJavaCode | null;
        } catch {
          return null;
        }
      },
      async getRes(filePath) {
        const projectUuid = await ensureProjectUuid();
        try {
          return (await rpc.call('getResFile', projectUuid, filePath, false)) as CResFileDto | null;
        } catch {
          return null;
        }
      },
    },

    async discardAll(changes) {
      log(`[discardAll] 开始，文件=${changes.length}`);
      const projectUuid = await ensureProjectUuid();
      for (const c of changes) {
        if (c.status === 'ADDED') {
          // 云端无此文件 -> 删除本地即回到一致态
          if (fs.existsSync(c.absolutePath)) fs.unlinkSync(c.absolutePath);
          continue;
        }
        // MODIFIED / DELETED_LOCALLY -> 用云端原版覆盖或重建本地文件
        let content: Buffer | string | null = null;
        if (c.isResource) {
          const resPath = c.relativePath.startsWith('/') ? c.relativePath : '/' + c.relativePath;
          try {
            const res = (await rpc.call('getResFile', projectUuid, resPath, false)) as CResFileDto | null;
            content = res?.fileBin ? Buffer.from(res.fileBin, 'base64') : null;
          } catch {
            content = null;
          }
        } else {
          const fullClass = c.fullClass ?? c.relativePath.replace(/\.java$/i, '').split('/').join('.');
          try {
            const java = (await rpc.call('getJavaCode', projectUuid, fullClass)) as CJavaCode | null;
            content = java?.code ?? null;
          } catch {
            content = null;
          }
        }
        if (content === null) continue; // 云端取不到 -> 不动本地，避免误删
        fs.mkdirSync(path.dirname(c.absolutePath), { recursive: true });
        fs.writeFileSync(c.absolutePath, content);
      }
    },
    publish: {
      async gray(opts) {
        log('[publish.gray] 开始');
        const projectUuid = await ensureProjectUuid();
        await rpc.call('grayPublish', projectUuid, opts?.requireCompile ?? true);
        log('[publish.gray] 完成');
      },
      async full(opts) {
        log('[publish.full] 开始');
        const projectUuid = await ensureProjectUuid();
        await rpc.call('rebuildAll', projectUuid);
        await rpc.call('exportProject2Plugin', projectUuid, null, true, opts?.ignoreErrors ?? false);
        log('[publish.full] 完成');
      },
    },

    redirect: {
      /** 用给定 uri/user/pwd 连接并列出该 server 上所有工程（探测用）。 */
      async probe(uri, user, pwd) {
        log(`[redirect.probe] 开始，uri=${uri}`);
        await rpc.connect(uri, user, pwd);
        const list = (await rpc.call('getAllProjects')) as CJavaProjectDto[];
        log(`[redirect.probe] 完成，工程=${list.length}`);
        return list;
      },
      /** 改写 .develop + 更新历史 + 断开；下次 refresh 按新配置重连。 */
      async apply(profile) {
        log(`[redirect.apply] 开始，project=${profile.projectName || profile.uri}`);
        writeDevelop(workspaceRoot, {
          projectUuid: profile.projectUuid,
          uri: profile.uri,
          user: profile.user,
          pwd: profile.pwd,
          adminTool: profile.adminTool,
        });
        addRelocateHistory(workspaceRoot, profile);
        // 清 develop/session 缓存并断开远端，避免残留旧 server 状态；下次 refresh 重读新 .develop
        await rpc.disconnect();
        session = null;
        develop = null;
        log('[redirect.apply] 完成');
      },
    },

    async syncLibs(onProgress, onLog) {
      const projectUuid = await ensureProjectUuid();
      return syncLibs(workspaceRoot, projectUuid, rpc, onProgress, onLog);
    },

    async disconnect() {
      await rpc.disconnect();
      session = null;
      develop = null;
    },
  };
}

async function doSave(
  projectUuid: string,
  changes: Change[],
  comment: string,
  rpc: RpcInvoker,
): Promise<CommitResult> {
  const folders = (await rpc.call('getFolders', projectUuid)) as CJavaFolderDto[];
  const dirty = changes.filter((c) => c.status !== 'NORMAL');
  const pkg: CommitPackage = await buildCommitPackage({
    projectUuid,
    changes: dirty,
    comments: comment,
    folders,
    invoker: rpc,
  });
  await commitCode(projectUuid, pkg, rpc);
  return { changes, pkg };
}
