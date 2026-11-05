import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  scanBackendProjectRoots,
  isBackendProjectRoot,
  isVfWorkspaceRoot,
  sanitizeProjectDirName,
  resolveDownloadTargetDir,
  directoryHasEntries,
} from '../src/backend-projects';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bap-loc-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** 建一个含 .develop 的工程目录。 */
function mkProject(dir: string, marker = true): string {
  fs.mkdirSync(dir, { recursive: true });
  if (marker) fs.writeFileSync(path.join(dir, '.develop'), '<Development/>', 'utf8');
  return dir;
}

describe('scanBackendProjectRoots', () => {
  it('workspace 根本身是后端工程', () => {
    mkProject(tmp);
    const found = scanBackendProjectRoots([tmp]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      root: tmp,
      name: path.basename(tmp),
      workspaceFolder: tmp,
      relativePath: '.',
    });
  });

  it('vf 容器工作区：在子目录发现后端工程', () => {
    fs.writeFileSync(path.join(tmp, 'votaforge.workspace.json'), '{}', 'utf8');
    fs.mkdirSync(path.join(tmp, 'web'), { recursive: true });
    mkProject(path.join(tmp, 'backend', 'gpf_a'));

    const found = scanBackendProjectRoots([tmp]);
    expect(found).toHaveLength(1);
    expect(found[0].root).toBe(path.join(tmp, 'backend', 'gpf_a'));
    expect(found[0].relativePath).toBe('backend/gpf_a');
  });

  it('发现工程根后不再下探嵌套 .develop', () => {
    mkProject(path.join(tmp, 'backend'));
    mkProject(path.join(tmp, 'backend', 'nested'));

    const found = scanBackendProjectRoots([tmp]);
    expect(found.map((p) => p.root)).toEqual([path.join(tmp, 'backend')]);
  });

  it('跳过依赖、构建产物、隐藏目录和 vf 私有目录', () => {
    for (const d of ['node_modules', 'target', 'build', 'out', 'dist', 'bin', 'api', 'coverage', '.git', '.votaforge', '.cache']) {
      mkProject(path.join(tmp, d, 'proj'));
    }
    expect(scanBackendProjectRoots([tmp])).toHaveLength(0);
  });

  it('默认深度 4，可用 maxDepth 放宽', () => {
    const deep = path.join(tmp, 'a', 'b', 'c', 'd', 'e');
    mkProject(deep);

    expect(scanBackendProjectRoots([tmp])).toHaveLength(0);
    expect(scanBackendProjectRoots([tmp], { maxDepth: 5 })).toHaveLength(1);
  });

  it('多工程按路径稳定排序', () => {
    mkProject(path.join(tmp, 'b_proj'));
    mkProject(path.join(tmp, 'a_proj'));

    const found = scanBackendProjectRoots([tmp]);
    expect(found.map((p) => p.name)).toEqual(['a_proj', 'b_proj']);
  });

  it('父目录与子目录同时是 workspace folder 时去重', () => {
    mkProject(path.join(tmp, 'backend'));

    const found = scanBackendProjectRoots([tmp, path.join(tmp, 'backend')]);
    expect(found).toHaveLength(1);
    expect(found[0].root).toBe(path.join(tmp, 'backend'));
  });

  it('不存在的 workspace folder 不报错', () => {
    expect(scanBackendProjectRoots([path.join(tmp, 'missing')])).toHaveLength(0);
  });
});

describe('isBackendProjectRoot', () => {
  it('只认 .develop 普通文件', () => {
    expect(isBackendProjectRoot(tmp)).toBe(false);
    mkProject(tmp);
    expect(isBackendProjectRoot(tmp)).toBe(true);

    const dirAsMarker = path.join(tmp, 'dir-marker');
    fs.mkdirSync(path.join(dirAsMarker, '.develop'), { recursive: true });
    expect(isBackendProjectRoot(dirAsMarker)).toBe(false);
  });
});

describe('isVfWorkspaceRoot', () => {
  it('识别 votaforge.workspace.json 或 .votaforge/，不解析内容', () => {
    expect(isVfWorkspaceRoot(tmp)).toBe(false);

    fs.writeFileSync(path.join(tmp, 'votaforge.workspace.json'), '{not json', 'utf8');
    expect(isVfWorkspaceRoot(tmp)).toBe(true);

    fs.rmSync(path.join(tmp, 'votaforge.workspace.json'));
    fs.mkdirSync(path.join(tmp, '.votaforge'));
    expect(isVfWorkspaceRoot(tmp)).toBe(true);
  });
});

describe('sanitizeProjectDirName', () => {
  it('替换非法字符、去掉首尾点与空格', () => {
    expect(sanitizeProjectDirName('gpf/a:b*c?')).toBe('gpf_a_b_c_');
    expect(sanitizeProjectDirName('  .hidden  ')).toBe('hidden');
    expect(sanitizeProjectDirName('a..')).toBe('a');
  });

  it('空名 / 相对路径名回退为 bap-project', () => {
    expect(sanitizeProjectDirName('')).toBe('bap-project');
    expect(sanitizeProjectDirName('   ')).toBe('bap-project');
    expect(sanitizeProjectDirName('.')).toBe('bap-project');
    expect(sanitizeProjectDirName('..')).toBe('bap-project');
  });

  it('截断过长名称', () => {
    const name = sanitizeProjectDirName('x'.repeat(200));
    expect(name.length).toBeLessThanOrEqual(80);
  });
});

describe('resolveDownloadTargetDir', () => {
  it('独立 BAP 工作区：默认工作区根，requested 落到子目录', () => {
    expect(resolveDownloadTargetDir(tmp, 'gpf_a')).toBe(tmp);
    expect(resolveDownloadTargetDir(tmp, 'gpf_a', 'sub')).toBe(path.join(tmp, 'sub'));
  });

  it('vf 工作区：默认 <root>/<工程名>，允许指定子目录', () => {
    fs.writeFileSync(path.join(tmp, 'votaforge.workspace.json'), '{}', 'utf8');

    expect(resolveDownloadTargetDir(tmp, 'gpf_a')).toBe(path.join(tmp, 'gpf_a'));
    expect(resolveDownloadTargetDir(tmp, 'gpf_a', 'backend/one')).toBe(
      path.join(tmp, 'backend', 'one'),
    );
  });

  it('vf 工作区禁止落到工作区根、禁止越界和绝对路径', () => {
    fs.writeFileSync(path.join(tmp, 'votaforge.workspace.json'), '{}', 'utf8');

    expect(() => resolveDownloadTargetDir(tmp, 'gpf_a', '.')).toThrow(/子目录/);
    expect(() => resolveDownloadTargetDir(tmp, 'gpf_a', '..')).toThrow(/工作区内/);
    expect(() => resolveDownloadTargetDir(tmp, 'gpf_a', path.join(tmp, 'abs'))).toThrow(/相对工作区根/);
  });
});

describe('directoryHasEntries', () => {
  it('不存在或空目录返回 false，有条目返回 true', () => {
    expect(directoryHasEntries(path.join(tmp, 'missing'))).toBe(false);

    const empty = path.join(tmp, 'empty');
    fs.mkdirSync(empty);
    expect(directoryHasEntries(empty)).toBe(false);

    fs.writeFileSync(path.join(empty, 'a.txt'), 'x');
    expect(directoryHasEntries(empty)).toBe(true);
  });
});
