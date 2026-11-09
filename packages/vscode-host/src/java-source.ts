// Java 源码的轻量解析（纯函数，不依赖 vscode，便于单测）。
//
// VS Code 没有 IDEA 的 PSI：注册规则函数时用 package 声明 + 文件 stem + DocumentSymbol
// + 光标单词/InputBox 兜底来推导「全类名 / 方法名」。这里只做与编辑器无关的部分。
import * as path from 'path';
import { deriveFullClass } from './projects/project-paths';

/** 单个 Java 标识符段（ASCII；`$` 在 Java 中合法）。 */
const JAVA_IDENT = '[A-Za-z_$][A-Za-z0-9_$]*';
const IDENT_RE = new RegExp(`^${JAVA_IDENT}$`);
const PACKAGE_RE = new RegExp(`^\\s*package\\s+(${JAVA_IDENT}(?:\\.${JAVA_IDENT})*)\\s*;`, 'm');
const FULL_CLASS_RE = new RegExp(`^${JAVA_IDENT}(?:\\.${JAVA_IDENT})*$`);

/** Java 关键字 + 字面量：不能作为标识符/全类名段。 */
const JAVA_KEYWORDS = new Set<string>([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const',
  'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float',
  'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native',
  'new', 'package', 'private', 'protected', 'public', 'return', 'short', 'static', 'strictfp',
  'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'try', 'void',
  'volatile', 'while', 'true', 'false', 'null',
]);

/** 去掉行注释与块注释（用于 package 声明识别）。 */
function stripJavaComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\r\n]*/g, '');
}

/**
 * 解析 package 声明；注释里的 package 不参与匹配，无声明返回 undefined。
 * 例：`package com.x;` → `com.x`。
 */
export function parseJavaPackage(source: string): string | undefined {
  if (!source) return undefined;
  const stripped = stripJavaComments(source);
  const m = PACKAGE_RE.exec(stripped);
  return m ? m[1] : undefined;
}

/** 文件路径 → 顶层类名（文件名去 `.java`）；拒绝 module-info / package-info。 */
export function classStemFromPath(absPath: string): string | undefined {
  const base = path.basename(absPath);
  if (!/\.java$/i.test(base)) return undefined;
  const stem = base.slice(0, -'.java'.length);
  if (!stem) return undefined;
  const lower = stem.toLowerCase();
  if (lower === 'module-info' || lower === 'package-info') return undefined;
  return stem;
}

/**
 * 由源码推导全类名：
 * 1) 优先 `package + '.' + 文件 stem`（多 source root / .classpath 工程也可靠）；
 * 2) 没有 package 时退回 `deriveFullClass(projectRoot, absPath)`（src/<folder>/... 布局）；
 * 3) 仍无则返回 undefined（由调用方 InputBox 兜底，绝不再用裸 stem 猜测，避免虚拟文档/异常布局误注册）。
 */
export function deriveFullClassFromSource(
  projectRoot: string,
  absPath: string,
  source: string,
): string | undefined {
  const stem = classStemFromPath(absPath);
  if (!stem) return undefined;

  const pkg = parseJavaPackage(source);
  if (pkg) {
    const full = `${pkg}.${stem}`;
    if (isValidFullClassName(full)) return full;
  }

  const fromPath = deriveFullClass(projectRoot, absPath);
  if (fromPath && isValidFullClassName(fromPath)) return fromPath;

  return undefined;
}

/** 合法的 Java 点分全类名（每段为标识符，非关键字）。 */
export function isValidFullClassName(value: string): boolean {
  if (!value || !FULL_CLASS_RE.test(value)) return false;
  return value.split('.').every((seg) => !JAVA_KEYWORDS.has(seg));
}

/** 合法的方法名；额外拒绝 `<init>` / `<clinit>`（构造器/静态初始化块）。 */
export function isValidMethodName(value: string): boolean {
  if (!value) return false;
  if (value === '<init>' || value === '<clinit>') return false;
  return IDENT_RE.test(value) && !JAVA_KEYWORDS.has(value);
}

/**
 * 把嵌套类链拼到全类名后：`com.x.Outer` + `['Inner','Deep']` → `com.x.Outer.Inner.Deep`。
 * 任何一段非法返回 undefined；空链返回 base（校验通过时）。
 */
export function appendNestedClass(base: string, nestedChain: string[]): string | undefined {
  if (!isValidFullClassName(base)) return undefined;
  if (nestedChain.length === 0) return base;
  const segments: string[] = [];
  for (const seg of nestedChain) {
    if (typeof seg !== 'string' || !IDENT_RE.test(seg) || JAVA_KEYWORDS.has(seg)) return undefined;
    segments.push(seg);
  }
  const full = `${base}.${segments.join('.')}`;
  return isValidFullClassName(full) ? full : undefined;
}
