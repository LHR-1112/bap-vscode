import { describe, it, expect } from 'vitest';
import { RefreshScheduler } from '../src/projects/refresh-scheduler';

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('RefreshScheduler', () => {
  it('默认串行执行，顺序与入队一致', async () => {
    const scheduler = new RefreshScheduler();
    const order: number[] = [];
    const run = (i: number): Promise<number> =>
      scheduler.run(async () => {
        order.push(i);
        await tick(1);
        order.push(i);
        return i;
      });
    const results = await Promise.all([run(1), run(2), run(3)]);
    expect(results).toEqual([1, 2, 3]);
    expect(order).toEqual([1, 1, 2, 2, 3, 3]);
    scheduler.dispose();
  });

  it('前一个任务失败不阻断后续', async () => {
    const scheduler = new RefreshScheduler();
    const p1 = scheduler.run(async () => {
      throw new Error('boom');
    });
    const p2 = scheduler.run(async () => 42);
    await expect(p1).rejects.toThrow('boom');
    await expect(p2).resolves.toBe(42);
    scheduler.dispose();
  });

  it('dispose 后拒绝新任务与排队任务', async () => {
    const scheduler = new RefreshScheduler(1);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const running = scheduler.run(async () => {
      await gate;
      return 'done';
    });
    const queued = scheduler.run(async () => 'queued');
    await tick();
    scheduler.dispose();
    await expect(queued).rejects.toThrow(/DISPOSED/);
    release();
    await expect(running).resolves.toBe('done');
    await expect(scheduler.run(async () => 1)).rejects.toThrow(/DISPOSED/);
  });
});
