import { describe, it, expect } from 'vitest';
import { Backoff } from '../connection/backoff';

describe('Backoff', () => {
  it('grows exponentially and caps at max', () => {
    const b = new Backoff({ initialMs: 1000, maxMs: 30000, factor: 2, jitter: false });
    expect(b.nextDelayMs()).toBe(1000);
    expect(b.nextDelayMs()).toBe(2000);
    expect(b.nextDelayMs()).toBe(4000);
    expect(b.nextDelayMs()).toBe(8000);
    expect(b.nextDelayMs()).toBe(16000);
    expect(b.nextDelayMs()).toBe(30000); // capped
    expect(b.nextDelayMs()).toBe(30000);
  });

  it('reset() clears attempt', () => {
    const b = new Backoff({ initialMs: 1000, maxMs: 30000, factor: 2, jitter: true });
    b.nextDelayMs();
    b.nextDelayMs();
    expect(b.attempt).toBe(2);
    b.reset();
    expect(b.attempt).toBe(0);
  });

  it('jitter stays within [0, base]', () => {
    const b = new Backoff({ initialMs: 1000, maxMs: 1000, factor: 2, jitter: true });
    for (let i = 0; i < 200; i++) {
      const d = b.nextDelayMs();
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(1000);
    }
  });
});
