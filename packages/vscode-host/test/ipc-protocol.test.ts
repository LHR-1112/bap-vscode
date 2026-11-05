// MCP IPC 错误协议（结构化错误 + 超时映射）。
import { describe, it, expect } from 'vitest';
import {
  isIpcToolError,
  toIpcToolError,
  formatIpcToolError,
  IpcToolCallError,
  ipcTimeoutForTool,
} from '../src/mcp/ipc-protocol';

describe('toIpcToolError', () => {
  it('普通 Error → message', () => {
    expect(toIpcToolError(new Error('boom'))).toEqual({ message: 'boom' });
  });

  it('字符串 / 非 Error 值', () => {
    expect(toIpcToolError('x')).toEqual({ message: 'x' });
    expect(toIpcToolError(42)).toEqual({ message: '42' });
  });

  it('保留 code 与候选工程，并清洗非法候选', () => {
    const e = {
      message: 'ambiguous',
      code: 'AMBIGUOUS',
      candidates: [
        { projectId: 'p1', displayName: 'A', root: '/w/p1' },
        { projectId: '', displayName: 'bad' },
        { displayName: 'no-id' },
        null,
        { projectId: 'p2', displayName: '', root: 3 },
      ],
    };
    expect(toIpcToolError(e)).toEqual({
      message: 'ambiguous',
      code: 'AMBIGUOUS',
      candidates: [
        { projectId: 'p1', displayName: 'A', root: '/w/p1' },
        { projectId: 'p2', displayName: 'p2' },
      ],
    });
  });

  it('候选全部非法时省略 candidates', () => {
    expect(
      toIpcToolError({ message: 'x', code: 'AMBIGUOUS', candidates: [null, { projectId: '' }] }),
    ).toEqual({ message: 'x', code: 'AMBIGUOUS' });
  });
});

describe('isIpcToolError', () => {
  it('只认带字符串 message 的普通对象', () => {
    expect(isIpcToolError({ message: 'x' })).toBe(true);
    expect(isIpcToolError(new Error('x'))).toBe(true);
    expect(isIpcToolError({ message: 1 })).toBe(false);
    expect(isIpcToolError([])).toBe(false);
    expect(isIpcToolError('x')).toBe(false);
    expect(isIpcToolError(null)).toBe(false);
  });
});

describe('formatIpcToolError', () => {
  it('附带候选清单与机器可读 meta', () => {
    const text = formatIpcToolError({
      message: '窗口内多工程',
      code: 'AMBIGUOUS',
      candidates: [
        { projectId: 'p1', displayName: 'A', root: '/w/p1' },
        { projectId: 'p2', displayName: 'B' },
      ],
    });
    expect(text).toContain('窗口内多工程');
    expect(text).toContain('候选工程：');
    expect(text).toContain('A（p1） — /w/p1');
    expect(text).toContain('B（p2）');
    const metaLine = text.split('\n').find((l) => l.startsWith('BAP_MCP_ERROR_META: '))!;
    expect(JSON.parse(metaLine.slice('BAP_MCP_ERROR_META: '.length))).toEqual({
      code: 'AMBIGUOUS',
      candidates: [
        { projectId: 'p1', displayName: 'A' },
        { projectId: 'p2', displayName: 'B' },
      ],
    });
  });

  it('只有 message 时保持纯文本（不追加 meta）', () => {
    expect(formatIpcToolError({ message: 'boom' })).toBe('boom');
  });

  it('只有 code 时追加 meta', () => {
    const text = formatIpcToolError({ message: 'boom', code: 'BOOTSTRAP_MODE' });
    expect(text).toContain('BAP_MCP_ERROR_META: {"code":"BOOTSTRAP_MODE"}');
  });
});

describe('IpcToolCallError', () => {
  it('保留结构化载荷', () => {
    const err = new IpcToolCallError({ message: 'x', code: 'C' });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('IpcToolCallError');
    expect(err.message).toBe('x');
    expect(err.payload).toEqual({ message: 'x', code: 'C' });
  });
});

describe('ipcTimeoutForTool', () => {
  it('长耗时工具放宽到 30 / 10 / 5 分钟', () => {
    for (const name of ['downloadProject', 'publish', 'testProject']) {
      expect(ipcTimeoutForTool(name)).toBe(30 * 60_000);
    }
    for (const name of ['compileProject', 'updateLibs']) {
      expect(ipcTimeoutForTool(name)).toBe(10 * 60_000);
    }
    for (const name of ['redirect', 'listProjects', 'commit', 'updateAll']) {
      expect(ipcTimeoutForTool(name)).toBe(5 * 60_000);
    }
  });

  it('其余默认 30 秒', () => {
    expect(ipcTimeoutForTool('refresh')).toBe(30_000);
    expect(ipcTimeoutForTool('workspaceInfo')).toBe(30_000);
    expect(ipcTimeoutForTool('unknown')).toBe(30_000);
  });
});
