import { describe, it, expect } from 'vitest';
import { parseTestSummary } from '../src/test';

describe('parseTestSummary', () => {
  it('解析 ConsoleLauncher 摘要行', () => {
    const out =
      '+-----\nTest run finished after 10 ms\n[         3 tests found      ]\n[         2 tests successful ]\n[         1 tests failed      ]\n[         1 tests skipped     ]\n';
    // ConsoleLauncher 的实际行（另一种）：
    const out2 = 'tests found: 5, tests successful: 4, tests failed: 1, tests skipped: 0';
    const r = parseTestSummary(out2, 1);
    expect(r.total).toBe(5);
    expect(r.passed).toBe(4);
    expect(r.failed).toBe(1);
    expect(r.skipped).toBe(0);
    expect(r.exitCode).toBe(1);
  });

  it('解析 ConsoleLauncher [ N ... ] 块格式', () => {
    const out =
      '[         4 containers found      ]\n[         4 containers started    ]\n[         4 containers successful ]\n[         4 containers aborted    ]\n[         1 tests successful       ]\n[         1 tests failed           ]\n';
    // 注意 ConsoleLauncher 用 "tests found"/"tests successful" 等；
    const out2 = '[ 4 tests found ]\n[ 3 tests successful ]\n[ 1 tests failed ]\n[ 0 tests skipped ]\n';
    const r = parseTestSummary(out2, 1);
    expect(r.total).toBe(4);
    expect(r.passed).toBe(3);
    expect(r.failed).toBe(1);
  });

  it('无摘要时用退出码示意（total 0）', () => {
    const r = parseTestSummary('java.lang.RuntimeException: oops', 2);
    expect(r.total).toBe(0);
    expect(r.exitCode).toBe(2);
  });
});
