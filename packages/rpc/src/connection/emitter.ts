// 类型安全的事件总线，替代裸 EventEmitter。
// 目的：避开 EventEmitter 的 'error' 事件「无监听器即 throw」的特殊语义，
// 让 error 只是普通事件。

type AnyFn = (...args: any[]) => void;

export class TypedEmitter<Events extends Record<keyof Events, AnyFn>> {
  private _listeners = new Map<keyof Events, Set<AnyFn>>();

  on<K extends keyof Events>(event: K, listener: Events[K]): this {
    let set = this._listeners.get(event);
    if (!set) {
      set = new Set();
      this._listeners.set(event, set);
    }
    set.add(listener);
    return this;
  }

  once<K extends keyof Events>(event: K, listener: Events[K]): this {
    const wrapper = (...args: Parameters<Events[K]>) => {
      this.off(event, wrapper as Events[K]);
      listener(...args);
    };
    return this.on(event, wrapper as Events[K]);
  }

  off<K extends keyof Events>(event: K, listener: Events[K]): this {
    this._listeners.get(event)?.delete(listener as AnyFn);
    return this;
  }

  emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): void {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const listener of Array.from(set)) listener(...args);
  }

  removeAllListeners(): void {
    this._listeners.clear();
  }
}
