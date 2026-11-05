import { describe, it, expect } from 'vitest';
import * as path from 'path';
import {
  pathKey,
  isSamePath,
  isPathInside,
  projectRelativePath,
  isInProjectSrc,
  isIgnoredProjectPath,
  deriveFullClass,
  normalizeServerUri,
  workspaceRelative,
} from '../src/projects/project-paths';

const ROOT = path.resolve('/ws/oa');

describe('project-paths', () => {
  it('isPathInside 按路径段匹配（/ws/p1 不含 /ws/p10）', () => {
    expect(isPathInside('/ws/p1', '/ws/p1/src/A.java')).toBe(true);
    expect(isPathInside('/ws/p1', '/ws/p1')).toBe(true);
    expect(isPathInside('/ws/p1', '/ws/p10/src/A.java')).toBe(false);
    expect(isPathInside('/ws/p1', '/ws/p1x')).toBe(false);
    expect(isPathInside('/ws/p1', '/ws')).toBe(false);
  });

  it('pathKey / isSamePath 同平台大小写归一', () => {
    expect(isSamePath('/ws/A', '/ws/a')).toBe(process.platform === 'darwin' || process.platform === 'win32');
    expect(pathKey('/ws/A')).toBe(pathKey('/ws/A'));
  });

  it('projectRelativePath 返回 POSIX 相对路径，越界为 undefined', () => {
    expect(projectRelativePath(ROOT, path.join(ROOT, 'src', 'core', 'A.java'))).toBe('src/core/A.java');
    expect(projectRelativePath(ROOT, ROOT)).toBe('');
    expect(projectRelativePath(ROOT, '/ws/other/A.java')).toBeUndefined();
  });

  it('isInProjectSrc 仅 src/ 下为真', () => {
    expect(isInProjectSrc(ROOT, path.join(ROOT, 'src', 'A.java'))).toBe(true);
    expect(isInProjectSrc(ROOT, path.join(ROOT, 'lib', 'A.jar'))).toBe(false);
    expect(isInProjectSrc(ROOT, ROOT)).toBe(false);
  });

  it('isIgnoredProjectPath 忽略隐藏目录/构建产物/依赖目录', () => {
    for (const rel of ['.vscode/settings.json', 'bin/A.class', 'target/x', 'lib/a.jar', 'node_modules/x', 'src/.cache/x']) {
      expect(isIgnoredProjectPath(ROOT, path.join(ROOT, rel))).toBe(true);
    }
    expect(isIgnoredProjectPath(ROOT, path.join(ROOT, 'src', 'core', 'A.java'))).toBe(false);
    expect(isIgnoredProjectPath(ROOT, '/ws/other/A.java')).toBe(true);
  });

  it('deriveFullClass 剥 src/ 与一级 folder', () => {
    expect(deriveFullClass(ROOT, path.join(ROOT, 'src', 'core', 'com', 'foo', 'Bar.java'))).toBe('com.foo.Bar');
    expect(deriveFullClass(ROOT, path.join(ROOT, 'src', 'res', 'com', 'foo', 'Bar.java'))).toBe('com.foo.Bar');
    // 缺少 folder 层级
    expect(deriveFullClass(ROOT, path.join(ROOT, 'src', 'Bar.java'))).toBeUndefined();
    expect(deriveFullClass(ROOT, path.join(ROOT, 'lib', 'com', 'foo', 'Bar.java'))).toBeUndefined();
    expect(deriveFullClass(ROOT, path.join(ROOT, 'src', 'core', 'com', 'foo', 'Bar.txt'))).toBeUndefined();
    expect(deriveFullClass(ROOT, '/ws/other/src/core/A.java')).toBeUndefined();
  });

  it('normalizeServerUri 小写 scheme/host、去查询与尾斜杠', () => {
    expect(normalizeServerUri('WS://BAP.Example.COM:2020/')).toBe('ws://bap.example.com:2020');
    expect(normalizeServerUri('ws://h:1?x=1#f')).toBe('ws://h:1');
    expect(normalizeServerUri('  ')).toBe('');
  });

  it('workspaceRelative 越界时返回绝对路径的 POSIX 形式', () => {
    expect(workspaceRelative(ROOT, path.join(ROOT, 'src', 'A.java'))).toBe('src/A.java');
    expect(workspaceRelative(ROOT, '/ws/other/A.java')).toBe('/ws/other/A.java');
  });
});
