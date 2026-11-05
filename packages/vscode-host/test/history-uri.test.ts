import { describe, it, expect } from 'vitest';
import {
  parseQueryString,
  parseBoolParam,
  queryString,
  projectIdFromUriString,
  bapOriginalUriString,
  parseOriginalUri,
  bapHistoryUriString,
  parseHistoryUri,
} from '../src/history/history-uri';

/** 把完整 URI 拆成 parseXxx(uriPath, query) 的入参。 */
function split(uri: string): { path: string; query: string; full: URL } {
  const u = new URL(uri);
  return { path: u.pathname, query: u.searchParams.toString(), full: u };
}

describe('history-uri', () => {
  it('parseQueryString 兼容前导 ? 与非法输入', () => {
    expect(parseQueryString('?a=1&b=2')).toEqual({ a: '1', b: '2' });
    expect(parseQueryString('a=1')).toEqual({ a: '1' });
    expect(parseQueryString('')).toEqual({});
  });

  it('parseBoolParam 接受 true/1，其余为假', () => {
    expect(parseBoolParam('true')).toBe(true);
    expect(parseBoolParam('1')).toBe(true);
    expect(parseBoolParam('false')).toBe(false);
    expect(parseBoolParam('0')).toBe(false);
    expect(parseBoolParam(undefined)).toBe(false);
  });

  it('queryString 跳过空值', () => {
    expect(queryString({ a: '1', b: undefined, c: '', d: false })).toBe('a=1');
  });

  it('bapOriginalUriString 带 pid 并可由 parseOriginalUri 反推', () => {
    const uri = bapOriginalUriString({
      projectId: 'oa-1:backend',
      workspaceRel: 'backend/src/core/com/foo/Bar.java',
      relativePath: 'com/foo/Bar.java',
      folder: 'core',
      isResource: false,
    });
    const { path, query } = split(uri);
    const parsed = parseOriginalUri(path, query);
    expect(parsed.projectId).toBe('oa-1:backend');
    expect(parsed.folder).toBe('core');
    expect(parsed.isResource).toBe(false);
    expect(parsed.relativePath).toBe('com/foo/Bar.java');
    expect(projectIdFromUriString(uri)).toBe('oa-1:backend');
  });

  it('parseOriginalUri 优先 query.rel；无 query.rel 时回退 path 段', () => {
    const legacySplit = split('bap-original://bap/src%2Fcore%2FA.java?folder=core&res=1');
    const legacy = parseOriginalUri(legacySplit.path, legacySplit.query);
    expect(legacy.relativePath).toBe('src/core/A.java');
    expect(legacy.isResource).toBe(true);
    expect(legacy.projectId).toBeUndefined();

    const withRel = parseOriginalUri('/whatever', 'rel=pt%2Fa.json&folder=res&res=true');
    expect(withRel.relativePath).toBe('pt/a.json');
  });

  it('bapHistoryUriString 带 pid 并可反推，兼容 res=1/0 旧 URI', () => {
    const uri = bapHistoryUriString('uuid-1', true, 'oa-1:.');
    const { path, query } = split(uri);
    expect(parseHistoryUri(path, query)).toEqual({
      projectId: 'oa-1:.',
      uuid: 'uuid-1',
      isResource: true,
    });
    const legacy = split('bap-history://bap/uuid-2?res=0');
    expect(parseHistoryUri(legacy.path, legacy.query)).toEqual({
      projectId: undefined,
      uuid: 'uuid-2',
      isResource: false,
    });
  });

  it('parseHistoryUri 优先 query.uuid', () => {
    expect(parseHistoryUri('/bap/path-uuid', 'uuid=query-uuid')).toMatchObject({ uuid: 'query-uuid' });
  });
});
