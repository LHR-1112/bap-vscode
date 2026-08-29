import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HeartbeatManager } from '../connection/heartbeat';

describe('HeartbeatManager', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends ping after interval', () => {
    const sendPing = vi.fn();
    const onTimeout = vi.fn();
    const hb = new HeartbeatManager({ intervalMs: 100, timeoutMs: 50, sendPing, onTimeout });
    hb.start();
    expect(sendPing).not.toHaveBeenCalled();
    vi.advanceTimersByTime(99);
    expect(sendPing).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(sendPing).toHaveBeenCalledTimes(1);
  });

  it('fires onTimeout when no pong within timeout', () => {
    const sendPing = vi.fn();
    const onTimeout = vi.fn();
    const hb = new HeartbeatManager({ intervalMs: 100, timeoutMs: 50, sendPing, onTimeout });
    hb.start();
    vi.advanceTimersByTime(100); // ping sent, pong timer armed
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50); // pong timer expires
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('pong clears timeout and schedules next ping', () => {
    const sendPing = vi.fn();
    const onTimeout = vi.fn();
    const hb = new HeartbeatManager({ intervalMs: 100, timeoutMs: 50, sendPing, onTimeout });
    hb.start();
    vi.advanceTimersByTime(100); // 1st ping
    hb.handlePong(); // pong before timeout
    vi.advanceTimersByTime(50);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50); // next interval -> 2nd ping
    expect(sendPing).toHaveBeenCalledTimes(2);
  });

  it('stop() cancels all timers', () => {
    const sendPing = vi.fn();
    const onTimeout = vi.fn();
    const hb = new HeartbeatManager({ intervalMs: 100, timeoutMs: 50, sendPing, onTimeout });
    hb.start();
    hb.stop();
    vi.advanceTimersByTime(10_000);
    expect(sendPing).not.toHaveBeenCalled();
    expect(onTimeout).not.toHaveBeenCalled();
  });
});
