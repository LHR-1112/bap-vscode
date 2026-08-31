// 更新依赖（lib）：服务端 md5 比对 —— 发本地 md5 map，收「变更 zip + 删除列表」。
// 全部走原子 RPC（无需改 Java 桥）；TS 侧解压 + 删除。
import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { md5Bytes } from './status';
import type { RpcInvoker } from './types';
import type { JsonValue as JV } from '@bap/rpc';

const LIB_DIR = 'lib';
const SUB_PLATFORM = 'platform';
const SUB_PROJECT = 'project';
const SUB_PLUGIN = 'plugin';
const SUB_MODEL = 'model';

/** 大 lib zip 放宽超时。 */
export const LIB_TIMEOUT_MS = 30 * 60 * 1000;

export interface LibMd5 {
  platformMd5: Record<string, string>;
  projectMd5: Record<string, string>;
  pluginMd5: Record<string, string>;
  daoTag: number;
}

export interface SyncProgress {
  step: string;
  message: string;
  current: number;
  total: number;
}

export interface SyncResult {
  updated: number;
  deleted: number;
}

const emsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const IGNORED_NAMES = new Set(['.DS_Store', 'node_modules', '.git', '.svn', '.idea']);

function isIgnored(name: string): boolean {
  return name === '.DS_Store' || name.startsWith('.') || IGNORED_NAMES.has(name);
}

function walk(dir: string, relPrefix: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (isIgnored(ent.name)) continue;
    const abs = path.join(dir, ent.name);
    const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) walk(abs, rel, out);
    else out.push(abs);
  }
}

/** 递归扫描 <root>/lib 下的文件绝对路径（忽略隐藏/垃圾）。 */
function listFiles(libDir: string): string[] {
  const out: string[] = [];
  walk(libDir, '', out);
  return out;
}

/** 计算本地 lib 各子目录的 md5 map + dao_tag。 */
export function scanLibMd5(workspaceRoot: string): LibMd5 {
  const libDir = path.join(workspaceRoot, LIB_DIR);
  const platformMd5: Record<string, string> = {};
  const projectMd5: Record<string, string> = {};
  const pluginMd5: Record<string, string> = {};
  let daoTag = -1;

  const platformBase = path.join(libDir, SUB_PLATFORM);
  const projectBase = path.join(libDir, SUB_PROJECT);
  const pluginBase = path.join(libDir, SUB_PLUGIN);

  for (const abs of listFiles(libDir)) {
    const name = path.basename(abs);
    if (name === 'dao_model.tag') {
      try {
        daoTag = parseInt(fs.readFileSync(abs, 'utf8').trim(), 10) || -1;
      } catch {
        daoTag = -1;
      }
      continue;
    }
    if (abs.startsWith(platformBase + path.sep)) {
      platformMd5[toPosixRel(platformBase, abs)] = fileMd5(abs);
    } else if (abs.startsWith(projectBase + path.sep)) {
      projectMd5[toPosixRel(projectBase, abs)] = fileMd5(abs);
    } else if (abs.startsWith(pluginBase + path.sep)) {
      // plugin 用文件名（扁平，对齐 Java）
      pluginMd5[name] = fileMd5(abs);
    }
  }

  return { platformMd5, projectMd5, pluginMd5, daoTag };
}

function toPosixRel(base: string, abs: string): string {
  const rel = abs.startsWith(base) ? abs.slice(base.length) : abs;
  return rel.replace(/^[/\\]+/, '').split(path.sep).join('/');
}

function fileMd5(abs: string): string {
  try {
    // 对齐 Java calculateMD5：MD5 用「大写 hex」（%02X）。服务端按大写比对，
    // 若发小写会全部判为「变更」→ 返回全量而非增量。
    return md5Bytes(fs.readFileSync(abs)).toUpperCase();
  } catch {
    return '';
  }
}

/** 并发执行业务 RPC（大 zip 用 callWithTimeout）。 */
async function rpcCall(rpc: RpcInvoker, timeout: number, method: string, ...args: JV[]): Promise<JV> {
  if (rpc.callWithTimeout) return rpc.callWithTimeout(timeout, method, ...args);
  return rpc.call(method, ...args);
}

/** 解压 base64 zip 到 workspace 根（zip 内为相对工程根的路径，如 lib/platform/x.jar）。 */
function extractZip(b64: string, workspaceRoot: string): void {
  if (!b64) return;
  const buf = Buffer.from(b64, 'base64');
  if (buf.length === 0) return;
  new AdmZip(buf).extractAllTo(workspaceRoot, true);
}

/** 删除相对于 lib 子目录的本地文件（防路径穿越）。 */
function deleteLocal(base: string, del: string): boolean {
  const target = path.resolve(base, del);
  if (!target.startsWith(path.resolve(base) + path.sep)) return false; // 逃逸，拒绝
  try {
    if (fs.existsSync(target)) {
      fs.unlinkSync(target);
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * 同步 <root>/lib 与云端。步骤化进度：扫描 → 平台/项目/插件/模型/源码。
 * 返回更新的文件/目录数与删除数。
 */
export async function syncLibs(
  workspaceRoot: string,
  projectUuid: string,
  rpc: RpcInvoker,
  onProgress?: (p: SyncProgress) => void,
  onLog?: (msg: string) => void,
): Promise<SyncResult> {
  const total = 6;
  const report = (current: number, message: string, step: string): void => {
    onLog?.(`进度 ${current}/${total}: ${message}`);
    onProgress?.({ step, message, current, total });
  };
  const srcFolders = listSubFolders(path.join(workspaceRoot, 'src'));

  let updated = 0;
  let deleted = 0;
  let md5: LibMd5;

  await stepLog('扫描本地依赖', onLog, async () => {
    report(1, '扫描本地依赖…', 'scan');
    md5 = scanLibMd5(workspaceRoot);
    onLog?.(`扫描结果: platform=${Object.keys(md5.platformMd5).length} project=${Object.keys(md5.projectMd5).length} plugin=${Object.keys(md5.pluginMd5).length} daoTag=${md5.daoTag}`);
  });

  await stepLog('平台依赖', onLog, async () => {
    report(2, '更新平台依赖…', 'platform');
    const r = (await rpcCall(rpc, LIB_TIMEOUT_MS, 'exportPlatformJars', md5.platformMd5 as JV)) as {
      left?: string;
      right?: string[];
    } | null;
    onLog?.(`平台依赖返回: zip=${r?.left?.length ?? 0} 字符, delete=${r?.right?.length ?? 0}`);
    if (r?.left) {
      extractZip(r.left, workspaceRoot);
      updated += 1;
    }
    if (r?.right) for (const d of r.right) if (deleteLocal(path.join(workspaceRoot, LIB_DIR, SUB_PLATFORM), d)) deleted += 1;
  });

  await stepLog('项目依赖', onLog, async () => {
    report(3, '更新项目依赖…', 'project');
    const r = (await rpcCall(rpc, LIB_TIMEOUT_MS, 'exportProjectJars', projectUuid, md5.projectMd5 as JV)) as {
      left?: string;
      right?: string[];
    } | null;
    onLog?.(`项目依赖返回: zip=${r?.left?.length ?? 0} 字符, delete=${r?.right?.length ?? 0}`);
    if (r?.left) {
      extractZip(r.left, workspaceRoot);
      updated += 1;
    }
    if (r?.right) for (const d of r.right) if (deleteLocal(path.join(workspaceRoot, LIB_DIR, SUB_PROJECT), d)) deleted += 1;
  });

  await stepLog('插件依赖', onLog, async () => {
    report(4, '更新插件依赖…', 'plugin');
    const r = (await rpcCall(rpc, LIB_TIMEOUT_MS, 'exportPluginJars', md5.pluginMd5 as JV, projectUuid, srcFolders as JV)) as {
      zipContent?: string;
      deleteList?: string[];
    } | null;
    onLog?.(`插件依赖返回: zip=${r?.zipContent?.length ?? 0} 字符, delete=${r?.deleteList?.length ?? 0}`);
    if (r?.zipContent) {
      extractZip(r.zipContent, workspaceRoot);
      updated += 1;
    }
    if (r?.deleteList) for (const d of r.deleteList) if (deleteLocal(path.join(workspaceRoot, LIB_DIR, SUB_PLUGIN), d)) deleted += 1;
  });

  await stepLog('模型依赖', onLog, async () => {
    report(5, '更新模型依赖…', 'model');
    const zip = (await rpcCall(rpc, LIB_TIMEOUT_MS, 'exportModelFile', md5.daoTag as JV)) as string | null;
    onLog?.(`模型依赖返回: zip=${zip?.length ?? 0} 字符`);
    if (zip && Buffer.from(zip, 'base64').length > 0) {
      fs.rmSync(path.join(workspaceRoot, LIB_DIR, SUB_MODEL), { recursive: true, force: true });
      extractZip(zip, workspaceRoot);
      updated += 1;
    }
  });

  await stepLog('源码包', onLog, async () => {
    report(6, '更新源码包…', 'openSource');
    const zip = (await rpcCall(rpc, LIB_TIMEOUT_MS, 'exportOpenSource', null as JV)) as string | null;
    onLog?.(`源码包返回: zip=${zip?.length ?? 0} 字符`);
    if (zip && Buffer.from(zip, 'base64').length > 0) {
      const dst = path.join(workspaceRoot, 'openSource', 'src.zip');
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, Buffer.from(zip, 'base64'));
      updated += 1;
    }
  });

  return { updated, deleted };
}

/** 单步执行：记录开始/结束/耗时/异常（不再静默吞错，失败也会 push 日志）。 */
async function stepLog(
  name: string,
  onLog: ((msg: string) => void) | undefined,
  fn: () => Promise<void>,
): Promise<void> {
  const t = Date.now();
  onLog?.(`[${name}] 开始`);
  try {
    await fn();
    onLog?.(`[${name}] 完成，耗时 ${Date.now() - t}ms`);
  } catch (e) {
    onLog?.(`[${name}] 失败: ${emsg(e)}`);
  }
}

function listSubFolders(srcRoot: string): string[] {
  try {
    return fs
      .readdirSync(srcRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name);
  } catch {
    return [];
  }
}
