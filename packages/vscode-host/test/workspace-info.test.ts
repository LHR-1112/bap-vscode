// workspaceInfo 数据构建：多工程、注册/实时差异、凭据脱敏（P1-7）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { BackendProjectDescriptor } from '../src/projects/discovery';
import { buildWorkspaceInfo, sanitizeServerUri } from '../src/projects/workspace-info';
import { BOOTSTRAP_TOOL_NAMES } from '../src/mcp/tools';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bap-wsinfo-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function descriptor(over: Partial<BackendProjectDescriptor> = {}): BackendProjectDescriptor {
  const root = over.root ?? path.join(tmp, 'p1');
  return {
    root,
    realRoot: root,
    name: path.basename(root),
    workspaceFolder: tmp,
    workspaceFolderRealRoot: tmp,
    relativePath: path.basename(root),
    depth: 1,
    projectId: `wf-hash:${path.basename(root)}`,
    displayName: path.basename(root),
    peerProjectIds: [],
    ...over,
  };
}

describe('sanitizeServerUri', () => {
  it('去掉 userinfo，保留其余写法', () => {
    expect(sanitizeServerUri('ws://u:p@host:8080/x?y=1')).toBe('ws://host:8080/x?y=1');
    expect(sanitizeServerUri('ws://host:1')).toBe('ws://host:1');
    expect(sanitizeServerUri('  ws://u@h  ')).toBe('ws://h');
  });

  it('凭据含 / 或多个 @ 时也不泄漏', () => {
    expect(sanitizeServerUri('ws://admin:pa/ss@host:8090')).toBe('ws://host:8090');
    expect(sanitizeServerUri('ws://admin:p@ss@host:8090')).toBe('ws://host:8090');
    expect(sanitizeServerUri('ws://a@b@c:1/path')).toBe('ws://c:1/path');
  });

  it('空值返回 undefined', () => {
    expect(sanitizeServerUri()).toBeUndefined();
    expect(sanitizeServerUri('   ')).toBeUndefined();
  });

  it('畸形 URI（缺 scheme / 单斜杠 / 纯 authority）也不泄漏 userinfo', () => {
    expect(sanitizeServerUri('user:pass@host:8080')).toBe('host:8080');
    expect(sanitizeServerUri('//u:p@host:8080')).toBe('//host:8080');
    expect(sanitizeServerUri('ws:/u:p@host:8080')).toBe('host:8080');
  });

  it('path / query 中的 @ 不被误删', () => {
    expect(sanitizeServerUri('ws://host:8080/path?email=a@b.com')).toBe(
      'ws://host:8080/path?email=a@b.com',
    );
    expect(sanitizeServerUri('ws://u:p@host/api@v2')).toBe('ws://host/api@v2');
  });
});

describe('buildWorkspaceInfo', () => {
  it('0 个工程 → bootstrap，仅 3 个引导工具', () => {
    fs.mkdirSync(path.join(tmp, '.votaforge'));
    const info = buildWorkspaceInfo({
      workspaceFolders: [{ name: 'vf', fsPath: tmp }],
      descriptors: [],
    });
    expect(info.schemaVersion).toBe(1);
    expect(info.vfRoots).toEqual([tmp]);
    expect(info.workspaceFolders[0]).toMatchObject({ name: 'vf', vf: true, scheme: 'file' });
    expect(info.projects).toEqual([]);
    expect(info.mcp.mode).toBe('bootstrap');
    expect(info.mcp.tools).toEqual([...BOOTSTRAP_TOOL_NAMES]);
    expect(info.mcp.liveProjectCount).toBe(0);
    expect(info.mcp.registeredProjectCount).toBe(0);
    expect(info.mcp.reloadRequired).toBe(false);
  });

  it('1 个已注册工程 → full，18 个工具', () => {
    const d = descriptor({ projectId: 'wf:p1', displayName: 'P1' });
    const info = buildWorkspaceInfo({
      workspaceFolders: [{ name: 'wf', fsPath: tmp }],
      descriptors: [d],
      registeredProjectIds: new Set(['wf:p1']),
    });
    expect(info.mcp.mode).toBe('full');
    expect(info.mcp.tools).toHaveLength(18);
    expect(info.mcp.reloadRequired).toBe(false);
    expect(info.projects[0]).toMatchObject({
      projectId: 'wf:p1',
      displayName: 'P1',
      registered: true,
      peerProjectIds: [],
    });
  });

  it('实时发现但未注册 → reloadRequired', () => {
    const d = descriptor({ projectId: 'wf:p2' });
    const info = buildWorkspaceInfo({
      workspaceFolders: [{ name: 'wf', fsPath: tmp }],
      descriptors: [d],
      registeredProjectIds: new Set(['wf:p1']),
    });
    expect(info.mcp.mode).toBe('full'); // 注册数 >0 且实时数 >0
    expect(info.projects[0].registered).toBe(false);
    expect(info.mcp.reloadRequired).toBe(true);
  });

  it('注册表有、实时扫描已无该工程 → reloadRequired', () => {
    const info = buildWorkspaceInfo({
      workspaceFolders: [{ name: 'wf', fsPath: tmp }],
      descriptors: [],
      registeredProjectIds: new Set(['wf:gone']),
    });
    expect(info.mcp.reloadRequired).toBe(true);
    expect(info.mcp.mode).toBe('bootstrap');
  });

  it('serverUri 去凭据，输出不含 user/pwd', () => {
    const d = descriptor({
      projectId: 'wf:p1',
      projectUuid: 'uuid-1',
      serverUri: 'ws://root:secret@host:8080',
    });
    const info = buildWorkspaceInfo({
      workspaceFolders: [{ name: 'wf', fsPath: tmp }],
      descriptors: [d],
    });
    expect(info.projects[0].serverUri).toBe('ws://host:8080');
    const text = JSON.stringify(info);
    expect(text).not.toContain('secret');
    expect(text).not.toContain('"pwd"');
    expect(text).not.toContain('"user"');
  });

  it('透传重复检出标记与候选路径', () => {
    const d = descriptor({
      projectId: 'wf:p1',
      duplicateProjectUuid: 'uuid-1',
      peerProjectIds: ['wf:p2'],
    });
    const info = buildWorkspaceInfo({
      workspaceFolders: [{ name: 'wf', fsPath: tmp }],
      descriptors: [d],
    });
    expect(info.projects[0]).toMatchObject({
      duplicateProjectUuid: 'uuid-1',
      peerProjectIds: ['wf:p2'],
      workspaceFolder: tmp,
      relativePath: 'p1',
    });
  });

  it('显式 mode 覆盖推断值；与推断不一致时提示重载', () => {
    const info = buildWorkspaceInfo({
      workspaceFolders: [{ name: 'wf', fsPath: tmp }],
      descriptors: [descriptor()],
      mode: 'bootstrap',
    });
    expect(info.mcp.mode).toBe('bootstrap');
    expect(info.mcp.tools).toHaveLength(3);
    expect(info.mcp.reloadRequired).toBe(true);
  });

  it('显式 mode 与推断一致 → 不因 mode 置 reloadRequired', () => {
    const info = buildWorkspaceInfo({
      workspaceFolders: [{ name: 'wf', fsPath: tmp }],
      descriptors: [descriptor()],
      mode: 'full',
    });
    expect(info.mcp.mode).toBe('full');
    expect(info.mcp.reloadRequired).toBe(false);
  });

  it('非 VotaForge 文件夹不进入 vfRoots', () => {
    const info = buildWorkspaceInfo({
      workspaceFolders: [{ name: 'wf', fsPath: tmp }],
      descriptors: [],
    });
    expect(info.workspaceFolders[0].vf).toBe(false);
    expect(info.vfRoots).toEqual([]);
  });
});
