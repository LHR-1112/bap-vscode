/** 一个等待响应的 pending 条目。 */
export interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  timer?: NodeJS.Timeout;
  startedAt: number;
}

/** 按 reqID 匹配请求/响应的注册表。 */
export class PendingRegistry {
  private _map = new Map<number, PendingEntry>();

  get size(): number {
    return this._map.size;
  }

  add(reqID: number, entry: PendingEntry): void {
    this._map.set(reqID, entry);
  }

  setTimer(reqID: number, timer: NodeJS.Timeout): void {
    const e = this._map.get(reqID);
    if (e) e.timer = timer;
  }

  /** 取出并从表移除；不存在返回 undefined（容忍乱序/迟到/重复）。 */
  remove(reqID: number): PendingEntry | undefined {
    const e = this._map.get(reqID);
    if (!e) return undefined;
    this._map.delete(reqID);
    return e;
  }

  get(reqID: number): PendingEntry | undefined {
    return this._map.get(reqID);
  }

  /** 断连/关闭：对所有存活 waiter 以同一错误 reject 并清空。 */
  failAll(err: unknown): void {
    for (const e of this._map.values()) {
      if (e.timer) clearTimeout(e.timer);
      e.reject(err);
    }
    this._map.clear();
  }
}
