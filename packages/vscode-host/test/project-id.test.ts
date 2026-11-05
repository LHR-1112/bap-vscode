import { describe, it, expect } from 'vitest';
import * as path from 'path';
import {
  workspaceFolderSlug,
  computeProjectId,
  assignUniqueDisplayNames,
  assignDuplicateFingerprints,
} from '../src/projects/project-id';

describe('project-id', () => {
  it('projectId 由 workspace 真实路径 + 相对路径决定，稳定且可区分', () => {
    const a1 = computeProjectId('/ws/oa', '.');
    const a2 = computeProjectId('/ws/oa', '.');
    const b = computeProjectId('/ws/other', '.');
    const nested = computeProjectId('/ws/oa', 'backend/gpf_demo');

    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(nested.endsWith(':backend/gpf_demo')).toBe(true);
    expect(a1.split(':')[0]).toBe(nested.split(':')[0]); // 同一 workspace → 同一前缀
    expect(a1).toMatch(/^oa-[0-9a-f]{8}:\.$/);
  });

  it('workspaceFolderSlug 清理非法目录名', () => {
    expect(workspaceFolderSlug('/ws/oa')).toBe('oa');
    expect(workspaceFolderSlug('/ws/带 空格:目录')).not.toContain(':');
  });

  it('assignUniqueDisplayNames 同名工程依次消歧', () => {
    const candidates = [
      { name: 'gpf_demo', workspaceFolder: '/ws/oa', relativePath: 'backend/gpf_demo', projectId: 'oa-1:backend/gpf_demo', displayName: '' },
      { name: 'gpf_demo', workspaceFolder: '/ws/oa', relativePath: 'backend2/gpf_demo', projectId: 'oa-1:backend2/gpf_demo', displayName: '' },
      { name: 'gpf_demo', workspaceFolder: '/ws/other', relativePath: '.', projectId: 'other-2:.', displayName: '' },
    ];
    assignUniqueDisplayNames(candidates);
    const names = candidates.map((c) => c.displayName);
    expect(new Set(names).size).toBe(3);
    expect(names[0]).toBe('gpf_demo');
    expect(names[1]).toBe('gpf_demo · oa');
    expect(names[2]).toBe('gpf_demo · other');
  });

  it('assignDuplicateFingerprints 按 server+uuid 标记重复检出', () => {
    const candidates = [
      { projectId: 'a', projectUuid: 'UUID-1', serverUri: 'WS://h:1/', peerProjectIds: [] as string[] },
      { projectId: 'b', projectUuid: 'uuid-1', serverUri: 'ws://h:1', peerProjectIds: [] as string[] },
      { projectId: 'c', projectUuid: 'uuid-2', serverUri: 'ws://h:1', peerProjectIds: [] as string[] },
    ];
    assignDuplicateFingerprints(candidates);
    expect(candidates[0].duplicateProjectUuid).toBe('UUID-1');
    expect(candidates[0].peerProjectIds).toEqual(['b']);
    expect(candidates[1].peerProjectIds).toEqual(['a']);
    expect(candidates[2].duplicateProjectUuid).toBeUndefined();
    expect(candidates[2].peerProjectIds).toEqual([]);
  });

  it('assignDuplicateFingerprints 缺 server 或 uuid 不判定', () => {
    const candidates = [
      { projectId: 'a', projectUuid: 'u', peerProjectIds: [] as string[] },
      { projectId: 'b', serverUri: 'ws://h:1', peerProjectIds: [] as string[] },
    ];
    assignDuplicateFingerprints(candidates);
    expect(candidates.every((c) => c.peerProjectIds.length === 0)).toBe(true);
  });
});
