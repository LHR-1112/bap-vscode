// 遍历本地 src/<folder>，产出文件描述（相对路径/全类名/资源判定）。
import * as fs from 'fs';
import * as path from 'path';

export interface LocalFile {
  /** 相对 folder 根的路径，统一 '/'。 */
  relativePath: string;
  absolutePath: string;
  isResource: boolean;
  fullClass?: string;
}

const IGNORED_NAMES = new Set(['.DS_Store', 'node_modules', '.git', '.svn', '.idea']);

function isIgnored(name: string): boolean {
  return name === '.DS_Store' || name.startsWith('.') || IGNORED_NAMES.has(name);
}

/** 相对路径转全类名：com/foo/Bar.java -> com.foo.Bar。 */
export function toFullClass(relativePath: string): string {
  const noExt = relativePath.replace(/\.java$/i, '');
  return noExt.replace(/\//g, '.');
}

/** 资源相对路径的目录段转包名：a/b/c.txt -> a.b（顶层 -> ''）。 */
export function dirToPackage(relativePath: string): string {
  const dir = relativePath.split('/').slice(0, -1).join('/');
  return dir.split('/').filter(Boolean).join('.');
}

/**
 * 扫描一个 folder 目录。
 * @param folderDir folder 绝对路径（如 <root>/src/core）
 * @param folderName folder 名（res 或普通 Java folder）
 * @returns 本地文件列表（.java 或 res 下所有文件）
 */
export function scanFolder(folderDir: string, folderName: string): LocalFile[] {
  const out: LocalFile[] = [];
  const isResource = folderName === 'res';
  walk(folderDir, '', folderDir, isResource, out);
  return out;
}

function walk(dir: string, relPrefix: string, folderDir: string, isResource: boolean, out: LocalFile[]): void {
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
    if (ent.isDirectory()) {
      walk(abs, rel, folderDir, isResource, out);
    } else if (ent.isFile()) {
      if (isResource) {
        out.push({ relativePath: toPosix(rel), absolutePath: abs, isResource: true });
      } else if (ent.name.toLowerCase().endsWith('.java')) {
        out.push({ relativePath: toPosix(rel), absolutePath: abs, isResource: false, fullClass: toFullClass(toPosix(rel)) });
      }
    }
  }
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}
