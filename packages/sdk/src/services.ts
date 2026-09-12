// BapSdk 工厂 + 高层业务方法（面向业务，不暴露 RPC）。
import * as fs from 'fs';
import * as path from 'path';
import { loadDevelop, writeDevelop } from './develop';
import { refreshChanges, listSrcFolders, normalizeCloudMap, isNoFolderException } from './refresh';
import { buildCommitPackage, commitCode, allocUuidWithUnderline } from './commit';
import { addRelocateHistory, type RelocateProfile } from './relocate';
import { syncLibs, type SyncProgress, type SyncResult } from './libs';
import { compileLocalProject, resolveProjectLayout, resolveJava, type CompileResult } from './compile';
import { buildDebugCode } from './debug';
import { runUnitTests, type TestOptions, type TestResult } from './test';
import type {
  Change,
  CJavaCode,
  CJavaFolderDto,
  CJavaProjectDto,
  CommitPackage,
  CommitResult,
  CResFileDto,
  DebugResult,
  DevelopConfig,
  FileDto,
  JavaDto,
  LvProblem,
  RpcInvoker,
  VersionNode,
} from './types';
import type { JsonValue, SessionDto as SDto } from '@bap/rpc';

export interface BapSdkOptions {
  /** RPC 能力（由宿主注入；apps/vscode 传 createRpcClient() 即可，结构兼容）。 */
  rpc: RpcInvoker;
  /** BAP 工程根目录（含 .develop）。 */
  workspaceRoot: string;
  /** 业务日志回调（宿主接到「BAP IDE」输出通道）。 */
  onLog?: (msg: string) => void;
  /** JDK 根目录（本地编译用其 javac，来自 bapIde.java8Path 设置项）。 */
  javaHome?: string;
  /** junit-platform-console-standalone.jar 路径（单元测试用）。 */
  junitJarPath?: string;
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
  /** 编译：本地 javac 编译当前工程；或云端单类编译（返回诊断）。 */
  compile: {
    project(opts?: { clean?: boolean }): Promise<CompileResult>;
    singleCode(fullClass: string, code: string, useCache?: boolean): Promise<LvProblem[]>;
  };
  /** 启动调试：云端运行单个 Java 类（trace 经 onTrace 逐行回调）。 */
  debug: {
    start(fullClass: string, code: string, onTrace?: (line: string) => void): Promise<DebugResult>;
  };
  /** 单元测试：先本地 javac 编译，再用 JUnit 跑 bin/ 下的测试类。 */
  test: {
    project(opts?: TestOptions): Promise<TestResult>;
  };
  disconnect(): Promise<void>;
}

/** 发布 / 全量导出是长耗时操作，放宽 TS 侧超时（与 lib 同步 / 下载一致）。
 * 默认 call 只有 30s，发布中途会被掐断成 TIMEOUT，真实成功/报错被吞掉。 */
const PUBLISH_TIMEOUT_MS = 30 * 60 * 1000;

/** 长耗时原子调用：优先 callWithTimeout，缺省回退 call。 */
async function rpcLong(rpc: RpcInvoker, method: string, ...args: JsonValue[]): Promise<unknown> {
  if (rpc.callWithTimeout) return rpc.callWithTimeout(PUBLISH_TIMEOUT_MS, method, ...args);
  return rpc.call(method, ...args);
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
        await rpcLong(rpc, 'grayPublish', projectUuid, opts?.requireCompile ?? true);
        log('[publish.gray] 完成');
      },
      async full(opts) {
        log('[publish.full] 开始');
        const projectUuid = await ensureProjectUuid();
        await rpcLong(rpc, 'rebuildAll', projectUuid);
        await rpcLong(rpc, 'exportProject2Plugin', projectUuid, null, true, opts?.ignoreErrors ?? false);
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

    compile: {
      async project(opts) {
        log(`[compile.project] 开始（本地 javac）`);
        const result = await compileLocalProject({ workspaceRoot, ...opts, jdkPath: options.javaHome, onLog: log });
        log(`[compile.project] ${result.success ? '成功' : '失败'}，源码=${result.sourceFiles}`);
        return result;
      },
      async singleCode(fullClass, code, useCache = false) {
        log(`[compile.singleCode] 开始，fullClass=${fullClass}`);
        const projectUuid = await ensureProjectUuid();
        const lastDot = fullClass.lastIndexOf('.');
        const mainClass = lastDot > 0 ? fullClass.slice(lastDot + 1) : fullClass;
        const javaPackage = lastDot > 0 ? fullClass.slice(0, lastDot) : '';
        // 注意：compileSingleCode 的 CJavaCode 需 masterKey（=projectUuid），
        // 发 "projectUuid" 键会被桥 Gson 丢弃（getter-only）。返回诊断数组。
        const problems = (await rpc.call('compileSingleCode', {
          masterKey: projectUuid,
          mainClass,
          javaPackage,
          code,
        }, useCache)) as LvProblem[];
        log(`[compile.singleCode] 完成，诊断=${problems.length}`);
        return problems ?? [];
      },
    },

    debug: {
      async start(fullClass, code, onTrace) {
        log(`[debug.start] 开始，fullClass=${fullClass}`);
        const { develop } = await ensureConnected();
        const lastDot = fullClass.lastIndexOf('.');
        const className = lastDot > 0 ? fullClass.slice(lastDot + 1) : fullClass;
        const origPackage = lastDot > 0 ? fullClass.slice(0, lastDot) : '';
        const debugPackage = origPackage ? `${origPackage}.debug` : 'debug';
        const debugCode = buildDebugCode(code, debugPackage);

        // 注意：不设 projectUuid/masterKey（服务端纯靠 package+name+code 编译运行）
        const debugKey = (await rpc.call(
          'startDebugJava',
          { javaPackage: debugPackage, name: className, mainClass: className, code: debugCode, uuid: allocUuidWithUnderline() },
          develop.uri,
        )) as string;
        log(`[debug.start] debugKey=${debugKey}`);

        let status = 0;
        let traceCount = 0;
        const maxPollMs = 60_000;
        const startedAt = Date.now();
        while (Date.now() - startedAt < maxPollMs) {
          const traces = (await rpc.call('popTrace', debugKey)) as string[];
          traceCount += traces.length;
          traces.forEach((t) => onTrace?.(t));
          status = (await rpc.call('getStatus', debugKey)) as number;
          if (status === 2 || status === 3) break;
          await new Promise((r) => setTimeout(r, 300));
        }
        if (status !== 2 && status !== 3) {
          try { await rpc.call('terminateDebug', debugKey, 5000); } catch { /* ignore */ }
          throw new Error(`调试超时（${maxPollMs}ms 未完成）`);
        }
        const traces = (await rpc.call('popTrace', debugKey)) as string[];
        traceCount += traces.length;
        traces.forEach((t) => onTrace?.(t));
        const result = await rpc.call('getResult', debugKey);
        const resultText = (await rpc.call('getResultText', debugKey)) as string;
        log(`[debug.start] 完成，status=${status} trace=${traceCount}`);
        return { debugKey, status, isError: status === 3, result, resultText, traceCount };
      },
    },

    test: {
      async project(opts) {
        log('[test.project] 开始（先编译，再 JUnit）');
        if (!options.junitJarPath) throw new Error('缺少 junit-platform-console-standalone.jar（应在扩展 resources/junit 下）');
        // 1) 编译出 bin/
        const compile = await compileLocalProject({ workspaceRoot, jdkPath: options.javaHome, onLog: log });
        if (!compile.success) {
          log(`[test.project] 编译失败，需先编译通过`);
          throw new Error(`编译失败（${compile.errorCode ?? ''}）: ${compile.compilerOutput || ''}`);
        }
        // 2) 布局（bin + libs）
        const layout = resolveProjectLayout(workspaceRoot);
        const projectUuid = await ensureProjectUuid();
        const { develop } = await ensureConnected();
        const javaBin = resolveJava(options.javaHome);
        const bapProps = {
          BAP_URI: develop.uri,
          BAP_USER: develop.user,
          BAP_PASSWORD: develop.pwd,
          BAP_PROJECT: projectUuid,
          SILENT_BAP_PROJECT_PATH: workspaceRoot,
          SILENT_BAP_USER_PASSWORD: develop.pwd,
        };
        const result = await runUnitTests({
          workspaceRoot,
          binDir: layout.outputDir,
          libFiles: layout.libraryFiles,
          junitJarPath: options.junitJarPath,
          javaBin,
          bapProps,
          test: opts,
          onLog: log,
        });
        log(`[test.project] 完成，total=${result.total} pass=${result.passed} fail=${result.failed} skip=${result.skipped} exit=${result.exitCode}`);
        return result;
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
  const verifyWarnings = await verifyCommitted(projectUuid, pkg, rpc, dirty);
  return { changes, pkg, verifyWarnings };
}

/** 字节差异摘要：首个差异偏移 / 差异字节数 / 差异处是否全为 '?'（字符集转换损坏的特征）。 */
function diffSummary(sent: Buffer, remote: Buffer): string {
  const n = Math.min(sent.length, remote.length);
  let first = -1;
  let count = 0;
  let question = 0;
  for (let i = 0; i < n; i++) {
    if (sent[i] !== remote[i]) {
      if (first < 0) first = i;
      count++;
      if (remote[i] === 0x3f) question++; // '?'
    }
  }
  const lenDiff = remote.length - sent.length;
  const parts = [`首个差异偏移=${first}`, `差异字节=${count}`];
  if (lenDiff !== 0) parts.push(`长度差=${lenDiff}`);
  if (count > 0 && question === count) parts.push('差异处云端全为 "?"（疑似字符集转换损坏）');
  return parts.join('，');
}

/**
 * 提交后回读验证：把**提交包里实际上传的内容**与云端读回比对。
 * 基准取提交包而非重新读本地文件——否则 build/编辑器在提交往返期间改写本地文件会误报。
 * 同时单独检查「本地文件是否在提交往返期间被改写」，与「云端损坏」区分开。
 */
async function verifyCommitted(
  projectUuid: string,
  pkg: CommitPackage,
  rpc: RpcInvoker,
  changes: Change[],
): Promise<string[]> {
  const warnings: string[] = [];
  // 大文件（图片/二进制等）跳过：验证需要整文件回读，不值得
  const MAX_VERIFY_BYTES = 1024 * 1024;
  const norm = (s: string): string => s.replace(/\r\n/g, '\n');

  // 提交包索引：相对路径 / 全类名 -> 实际上传的内容
  const resPath = (pkgName: string, fileName: string): string =>
    pkgName ? `${pkgName.split('.').join('/')}/${fileName}` : fileName;
  const sentRes = new Map<string, Buffer>();
  for (const f of Object.values(pkg.mapFolder2Files).flat()) {
    sentRes.set(resPath(f.filePackage, f.fileName), Buffer.from(f.fileBin, 'base64'));
  }
  const sentJava = new Map<string, string>();
  for (const c of Object.values(pkg.mapFolder2Codes).flat()) {
    sentJava.set(c.javaPackage ? `${c.javaPackage}.${c.mainClass}` : c.mainClass, c.code);
  }

  // 1) 云端内容 vs 提交内容（真正回答「服务端有没有存坏」）
  for (const [path, bytes] of sentRes) {
    if (bytes.length > MAX_VERIFY_BYTES) continue;
    try {
      const remote = (await rpc.call('getResFile', projectUuid, path, false)) as CResFileDto | null;
      const remoteBytes = remote?.fileBin ? Buffer.from(remote.fileBin, 'base64') : null;
      if (!remoteBytes) warnings.push(`资源 ${path}：提交后云端读不到该文件`);
      else if (!remoteBytes.equals(bytes)) {
        warnings.push(`资源 ${path}：云端内容与提交内容不一致（${diffSummary(bytes, remoteBytes)}）`);
      }
    } catch {
      // 回读失败不阻塞提交结果
    }
  }
  for (const [fullClass, code] of sentJava) {
    if (code.length > MAX_VERIFY_BYTES) continue;
    try {
      const remote = (await rpc.call('getJavaCode', projectUuid, fullClass)) as CJavaCode | null;
      if (remote?.code == null) warnings.push(`Java ${fullClass}：提交后云端读不到该类`);
      else if (norm(remote.code) !== norm(code)) {
        warnings.push(
          `Java ${fullClass}：云端内容与提交内容不一致（${diffSummary(Buffer.from(code, 'utf8'), Buffer.from(remote.code, 'utf8'))}）`,
        );
      }
    } catch {
      // 回读失败不阻塞提交结果
    }
  }

  // 2) 本地文件是否在提交往返期间被改写（build 产物/编辑器热保存）——与「云端损坏」是两个问题
  for (const ch of changes) {
    if (ch.status === 'DELETED_LOCALLY') continue;
    try {
      if (ch.isResource) {
        const now = fs.readFileSync(ch.absolutePath);
        const sent = sentRes.get(ch.relativePath.replace(/^\//, ''));
        if (sent && now.length <= MAX_VERIFY_BYTES && !sent.equals(now)) {
          warnings.push(`资源 ${ch.relativePath}：本地文件在提交期间被改写（云端存的是提交时的版本）`);
        }
      } else {
        const fullClass = ch.fullClass ?? '';
        const sent = sentJava.get(fullClass);
        if (sent && norm(fs.readFileSync(ch.absolutePath, 'utf8')) !== norm(sent)) {
          warnings.push(`Java ${fullClass}：本地文件在提交期间被改写（云端存的是提交时的版本）`);
        }
      }
    } catch {
      // 读不到就跳过
    }
  }
  return warnings;
}
