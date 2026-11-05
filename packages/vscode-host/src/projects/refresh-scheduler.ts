// 多工程刷新调度器：限制并发（默认 1），dispose 时拒绝排队任务。
// 刷新会重连云端 / 全量读盘，多工程同时跑容易打满 Java 桥与磁盘，因此默认串行。
export class RefreshScheduler {
  private readonly queue: Array<{
    run: () => Promise<unknown>;
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  }> = [];
  private active = 0;
  private disposed = false;

  constructor(private readonly concurrency: number = 1) {
    this.concurrency = Math.max(1, Math.floor(concurrency));
  }

  /** 排队执行；dispose 后拒绝新任务，并拒绝尚未开始的任务。 */
  run<T>(task: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('DISPOSED: 刷新调度器已释放'));
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        run: task as () => Promise<unknown>,
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.pump();
    });
  }

  /** 排队 + 运行中的任务数。 */
  get pending(): number {
    return this.queue.length + this.active;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const pending = this.queue.splice(0);
    for (const item of pending) item.reject(new Error('DISPOSED: 刷新调度器已释放'));
  }

  private pump(): void {
    while (!this.disposed && this.active < this.concurrency && this.queue.length > 0) {
      const item = this.queue.shift()!;
      this.active++;
      Promise.resolve()
        .then(() => item.run())
        .then(item.resolve, item.reject)
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }
}
