// 调试：构建发往 startDebugJava 的 CJavaCode（package 改写为 <pkg>.debug）+ 纯函数 buildDebugCode。
// startDebugJava 的轮询/结果在 services.ts 的 sdk.debug.start 里（allocUuidWithUnderline 复用 commit.ts）。

/** 把源码的 package 行改写为调试包名；返回改写后的代码。无 package 行则首位插入。 */
export function buildDebugCode(code: string, debugPackage: string): string {
  const re = /^\s*package\s+[^;]+;\s*/;
  if (re.test(code)) return code.replace(re, `package ${debugPackage};\n`);
  return `package ${debugPackage};\n\n${code}`;
}
