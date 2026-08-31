import { describe, it, expect } from 'vitest';
import { isNewer, DEFAULT_FEED } from '../src/update-check';

describe('isNewer', () => {
  it('新版本大于当前', () => {
    expect(isNewer('1.1.0', '1.0.0')).toBe(true);
    expect(isNewer('1.0.1', '1.0.0')).toBe(true);
    expect(isNewer('2.0.0', '1.9.9')).toBe(true);
  });

  it('v 前缀可容忍', () => {
    expect(isNewer('v1.1.0', '1.0.0')).toBe(true);
  });

  it('等于或低于返回 false', () => {
    expect(isNewer('1.0.0', '1.0.0')).toBe(false);
    expect(isNewer('1.0.0', '1.1.0')).toBe(false);
    expect(isNewer('0.9.0', '1.0.0')).toBe(false);
  });

  it('默认更新源存在', () => {
    expect(DEFAULT_FEED).toContain('api.github.com');
  });
});
