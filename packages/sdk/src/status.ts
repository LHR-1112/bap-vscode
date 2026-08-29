// 状态计算纯函数（复刻生产插件 ProjectRefresher 的 MD5 判定）。
// 无 IO：只做字符串/字节的 MD5 与状态判定。
import * as crypto from 'crypto';
import type { Status } from './types';

export function md5String(s: string): string {
  return crypto.createHash('md5').update(s, 'utf8').digest('hex');
}

export function md5Bytes(b: Buffer): string {
  return crypto.createHash('md5').update(b).digest('hex');
}

/** Java loose-md5：去所有空白后算。 */
export function looseMd5(s: string): string {
  return md5String(s.replace(/\s+/g, ''));
}

/** Java 文件状态判定（复刻 verifyModification）。 */
export function computeJavaStatus(p: {
  local: string; // 本地原始内容
  cloudMd5?: string; // 云端 JavaDto.md5
  remoteCode?: string; // 云端原文（getJavaCode().code），用于 loose 兜底
}): Status {
  const local = p.local;
  if (local.length === 0 || local.trim().length === 0) return 'DELETED_LOCALLY';
  const stdLocal = md5String(local.replace(/\r\n/g, '\n'));
  if (p.cloudMd5 && p.cloudMd5.toLowerCase() === stdLocal) return 'NORMAL';
  // loose 兜底：容忍格式化差异
  if (p.remoteCode != null && looseMd5(local) === looseMd5(p.remoteCode)) return 'NORMAL';
  return 'MODIFIED';
}

/** 资源文件状态判定（复刻 checkResourceModified）。 */
export function computeResourceStatus(p: {
  localMd5: string; // 本地字节 md5
  bytesLength: number;
  cloudMd5?: string;
}): Status {
  if (p.bytesLength === 0) return 'DELETED_LOCALLY';
  if (p.cloudMd5 && p.cloudMd5.toLowerCase() === p.localMd5.toLowerCase()) return 'NORMAL';
  return 'MODIFIED';
}
