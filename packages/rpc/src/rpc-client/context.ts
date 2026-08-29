/** 全局 context 静态存储（镜像 Java CRpcAdapter._globalCtx）。 */
const globalContext = new Map<string, unknown>();

export const CTX_SESSION = 'CTX_SESSION';

export function setGlobalContext(key: string, value: unknown): void {
  globalContext.set(key, value);
}

export function deleteGlobalContext(key: string): void {
  globalContext.delete(key);
}

export function clearGlobalContext(): void {
  globalContext.clear();
}

export function getGlobalContext(): ReadonlyMap<string, unknown> {
  return globalContext;
}

/** 深拷贝 context，供注入每个 request.context。 */
export function cloneContext(src: ReadonlyMap<string, unknown>): Map<string, unknown> {
  return structuredClone(src) as Map<string, unknown>;
}
