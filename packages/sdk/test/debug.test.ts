import { describe, it, expect } from 'vitest';
import { buildDebugCode } from '../src/debug';

describe('buildDebugCode', () => {
  it('改写已有 package 行为 <pkg>.debug', () => {
    const code = 'package cell.practicalTool.expr;\n\npublic class Foo {}\n';
    const out = buildDebugCode(code, 'cell.practicalTool.expr.debug');
    expect(out).toContain('package cell.practicalTool.expr.debug;');
    expect(out).not.toContain('package cell.practicalTool.expr;');
    expect(out).toContain('public class Foo {}');
  });

  it('无 package 行则在首位插入 debug 包名', () => {
    const code = 'public class Foo {}\n';
    const out = buildDebugCode(code, 'debug');
    expect(out).toMatch(/^package debug;/);
    expect(out).toContain('public class Foo {}');
  });
});
