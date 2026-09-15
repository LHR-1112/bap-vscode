// 下载工程：TS 侧只发起一次带长超时的流式调用，Java 桥内部完成
// streamExportProject（流式）+ ZipUtils.unzip + 写 .develop。
import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import type { RpcInvoker } from './types';
import type { JsonValue as JV } from '@bap/rpc';

export interface DownloadOptions {
  rpc: RpcInvoker;
  uri: string;
  user: string;
  pwd: string;
  projectUuid: string;
  destDir: string;
  adminTool?: string;
  onProgress?: (p: { percent: number; message: string }) => void;
  onLog?: (msg: string) => void;
}

/** 下载整包长耗时，放宽超时。 */
export const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * 下载并解压 BAP 工程到 destDir，写入 .develop（由 Java 桥完成）。
 * 调用前 rpc 已 connect（登录并发到全局会话）；这里复用同一 rpc 发起 download。
 */
export async function downloadProject(opts: DownloadOptions): Promise<void> {
  const { rpc, uri, user, pwd, projectUuid, destDir, adminTool, onProgress, onLog } = opts;
  onLog?.('[downloadProject] 开始');
  if (rpc.onProgress && onProgress) rpc.onProgress(onProgress);
  // 'download' 是 Java 桥顶层方法（非 CJavaCenterIntf 反射方法），须经 request 而非 call。
  const send = (rpc as RpcInvoker & { request: (m: string, p: JV[], t?: number) => Promise<JV> }).request;
  if (!send) throw new Error('rpc does not support raw request (download)');
  await send.call(rpc, 'download', [projectUuid, destDir, adminTool ?? null], DOWNLOAD_TIMEOUT_MS);
  onLog?.(`[downloadProject] 完成，destDir=${destDir}`);
}

/** 探测本机 JDK 1.8 安装路径。检测不到返回 undefined。 */
export function detectJdk8(): string | undefined {
  const candidates: string[] = [];

  const javahome = process.env.JAVA_HOME;
  if (javahome) candidates.push(javahome);

  try {
    // macOS
    const out = child_process.execFileSync('/usr/libexec/java_home', ['-v', '1.8'], { encoding: 'utf8' });
    const p = out.trim();
    if (p) candidates.push(p);
  } catch {
    /* ignore */
  }

  for (const c of candidates) {
    const javaBin = path.join(c, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    if (fs.existsSync(javaBin) && isJavaVersion8(javaBin)) return c;
  }
  return undefined;
}

const isJavaVersion8 = (javaBin: string): boolean => {
  try {
    const out = child_process.execFileSync(javaBin, ['-version'], { encoding: 'utf8' });
    return /1\.8|"1\.8|version "1\.8/.test(out);
  } catch {
    return false;
  }
};

/** writeJavaSettings 的结果。 */
export type JavaSettingsResult = 'created' | 'merged' | 'skipped';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 递归合并设置：同名键以 override 为准；双方都是对象时逐层合并，
 * 这样 `[java]` 块里用户自己的其它设置不会被整块覆盖。数组整体替换。
 */
function mergeSettings(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    const prev = out[k];
    out[k] = isPlainObject(prev) && isPlainObject(v) ? mergeSettings(prev, v) : v;
  }
  return out;
}

/**
 * 写 <destDir>/.vscode/settings.json：JDK 1.8 runtime + 一组适配 BAP 开发的 Java/编辑器设置。
 * jdkPath 为空则 runtimes 项不带 path。
 *
 * 目标目录已有 settings.json 时**先读出来再合并**：用户自己的其它设置原样保留，只有同名的
 * 插件托管键以本次为准（否则换 JDK 后旧的 runtime 路径会残留）。已存在但无法解析
 * （例如 VS Code 允许的 JSONC 注释、尾逗号）时**放弃写入**——宁可少配，也不要损坏用户文件。
 *
 * @returns 'created' 新建 / 'merged' 合并写入 / 'skipped' 因已有文件不可解析而跳过
 */
export function writeJavaSettings(destDir: string, jdkPath?: string): JavaSettingsResult {
  const vscodeDir = path.join(destDir, '.vscode');
  const settingsFile = path.join(vscodeDir, 'settings.json');

  let existing: Record<string, unknown> = {};
  let existed = false;
  if (fs.existsSync(settingsFile)) {
    existed = true;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      if (!isPlainObject(parsed)) return 'skipped';
      existing = parsed;
    } catch {
      return 'skipped';
    }
  }

  const runtimes: Array<{ name: string; path?: string; default?: boolean }> = [{ name: 'JavaSE-1.8', default: true }];
  if (jdkPath) runtimes[0].path = jdkPath;
  const bapSettings: Record<string, unknown> = {
    'java.configuration.runtimes': runtimes,
    'java.configuration.runtime': { default: 'JavaSE-1.8' },
    'java.compile.nullAnalysis.mode': 'automatic',
    'java.completion.guessMethodArguments': 'insertBestGuessedArguments',
    'java.completion.postfix.enabled': true,
    'java.updateImportsOnPaste.enabled': true,
    'java.inlayHints.parameterNames.enabled': 'none',
    'editor.suggestSelection': 'recentlyUsedByPrefix',
    'editor.tabCompletion': 'on',
    '[java]': {
      'editor.tabSize': 4,
      'editor.insertSpaces': true,
      'editor.codeActionsOnSave': { 'source.organizeImports': 'explicit' },
    },
  };

  fs.mkdirSync(vscodeDir, { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(mergeSettings(existing, bapSettings), null, 2), 'utf8');
  return existed ? 'merged' : 'created';
}
