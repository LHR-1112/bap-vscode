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
}

/** 下载整包长耗时，放宽超时。 */
export const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * 下载并解压 BAP 工程到 destDir，写入 .develop（由 Java 桥完成）。
 * 调用前 rpc 已 connect（登录并发到全局会话）；这里复用同一 rpc 发起 download。
 */
export async function downloadProject(opts: DownloadOptions): Promise<void> {
  const { rpc, uri, user, pwd, projectUuid, destDir, adminTool, onProgress } = opts;
  if (rpc.onProgress && onProgress) rpc.onProgress(onProgress);
  // 'download' 是 Java 桥顶层方法（非 CJavaCenterIntf 反射方法），须经 request 而非 call。
  const send = (rpc as RpcInvoker & { request: (m: string, p: JV[], t?: number) => Promise<JV> }).request;
  if (!send) throw new Error('rpc does not support raw request (download)');
  await send.call(rpc, 'download', [projectUuid, destDir, adminTool ?? null], DOWNLOAD_TIMEOUT_MS);
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

/**
 * 写 <destDir>/.vscode/settings.json 声明 JavaSE-1.8；jdkPath 为空则 runtimes 项不带 path。
 */
export function writeJavaSettings(destDir: string, jdkPath?: string): void {
  const vscodeDir = path.join(destDir, '.vscode');
  fs.mkdirSync(vscodeDir, { recursive: true });
  const runtimes: Array<{ name: string; path?: string }> = [{ name: 'JavaSE-1.8' }];
  if (jdkPath) runtimes[0].path = jdkPath;
  const settings = {
    'java.configuration.runtimes': runtimes,
    'java.configuration.runtime': { default: 'JavaSE-1.8' },
  };
  fs.writeFileSync(path.join(vscodeDir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');
}
