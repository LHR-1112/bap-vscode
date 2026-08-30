// BapSdk 工厂 + 高层业务方法（面向业务，不暴露 RPC）。
import * as fs from 'fs';
import * as path from 'path';
import { loadDevelop, writeDevelop } from './develop';
import { refreshChanges } from './refresh';
import { buildCommitPackage, commitCode } from './commit';
import { addRelocateHistory, type RelocateProfile } from './relocate';
import type {
  Change,
  CJavaCode,
  CJavaFolderDto,
  CJavaProjectDto,
  CommitPackage,
  CommitResult,
  CResFileDto,
  DevelopConfig,
  RpcInvoker,
} from './types';
import type { SessionDto as SDto } from '@bap/rpc';

export interface BapSdkOptions {
  /** RPC 能力（由宿主注入；apps/vscode 传 createRpcClient() 即可，结构兼容）。 */
  rpc: RpcInvoker;
  /** BAP 工程根目录（含 .develop）。 */
  workspaceRoot: string;
}

export interface BapSdk {
  login(): Promise<{ develop: DevelopConfig; session: SDto; project: CJavaProjectDto }>;
  refresh(): Promise<Change[]>;
  project: {
    list(): Promise<CJavaProjectDto[]>;
    get(): Promise<CJavaProjectDto>;
    getFolders(): Promise<CJavaFolderDto[]>;
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
  disconnect(): Promise<void>;
}

export function createBapSdk(options: BapSdkOptions): BapSdk {
  const { rpc, workspaceRoot } = options;
  const srcRoot = path.join(workspaceRoot, 'src');
  let develop: DevelopConfig | null = null;
  let session: SDto | null = null;

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
      const { develop: d, session: s } = await ensureConnected();
      const project = (await rpc.call('getProject', d.projectUuid)) as CJavaProjectDto;
      return { develop: d, session: s, project };
    },

    async refresh() {
      const projectUuid = await ensureProjectUuid();
      return refreshChanges(projectUuid, srcRoot, rpc);
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

    code: {
      async save(comment = '') {
        const projectUuid = await ensureProjectUuid();
        const changes = await refreshChanges(projectUuid, srcRoot, rpc);
        return doSave(projectUuid, changes, comment, rpc);
      },
      async saveChanges(changes, comment = '') {
        const projectUuid = await ensureProjectUuid();
        return doSave(projectUuid, changes, comment, rpc);
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
        const projectUuid = await ensureProjectUuid();
        await rpc.call('grayPublish', projectUuid, opts?.requireCompile ?? true);
      },
      async full(opts) {
        const projectUuid = await ensureProjectUuid();
        await rpc.call('rebuildAll', projectUuid);
        await rpc.call('exportProject2Plugin', projectUuid, null, true, opts?.ignoreErrors ?? false);
      },
    },

    redirect: {
      /** 用给定 uri/user/pwd 连接并列出该 server 上所有工程（探测用）。 */
      async probe(uri, user, pwd) {
        await rpc.connect(uri, user, pwd);
        return rpc.call('getAllProjects') as Promise<CJavaProjectDto[]>;
      },
      /** 改写 .develop + 更新历史 + 断开；下次 refresh 按新配置重连。 */
      async apply(profile) {
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
      },
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
