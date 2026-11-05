// MCP 启动门禁与模式计算（P1-8）。
import { describe, it, expect } from 'vitest';
import { shouldStartMcp, computeMcpMode, effectiveMcpMode } from '../src/mcp/mode';

describe('shouldStartMcp', () => {
  it('至少一个 workspace folder 才启动', () => {
    expect(shouldStartMcp(0)).toBe(false);
    expect(shouldStartMcp(1)).toBe(true);
    expect(shouldStartMcp(5)).toBe(true);
  });
});

describe('computeMcpMode', () => {
  it('注册与实时扫描都 > 0 → full', () => {
    expect(computeMcpMode(1, 1)).toBe('full');
    expect(computeMcpMode(3, 2)).toBe('full');
  });

  it('任一为 0 → bootstrap', () => {
    expect(computeMcpMode(0, 0)).toBe('bootstrap');
    expect(computeMcpMode(1, 0)).toBe('bootstrap');
    expect(computeMcpMode(0, 1)).toBe('bootstrap');
  });
});

describe('effectiveMcpMode', () => {
  it('服务端与实时都为 full 才是 full', () => {
    expect(effectiveMcpMode('full', 'full')).toBe('full');
    expect(effectiveMcpMode('full', 'bootstrap')).toBe('bootstrap');
    expect(effectiveMcpMode('bootstrap', 'full')).toBe('bootstrap');
    expect(effectiveMcpMode(undefined, 'full')).toBe('bootstrap');
    expect(effectiveMcpMode(undefined, 'bootstrap')).toBe('bootstrap');
  });
});
