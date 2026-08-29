import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { refreshChanges, isNoFolderException } from '../src/refresh';
import type { JavaDto, RpcInvoker } from '../src/types';

// ---- fixture 工具 ----
const tmpDirs: string[] = [];
function mkTmp(): string {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'bap-sdk-test-'));
  tmpDirs.push(p);
  return p;
}
afterEach(() => {
  while (tmpDirs.length) {
    const p = tmpDirs.pop()!;
    fs.rmSync(p, { recursive: true, force: true });
  }
});

function writeFile(abs: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** 造一个含 .develop + src/core + src/res 的工程。 */
function makeProject(): string {
  const root = mkTmp();
  writeFile(path.join(root, '.develop'), `<properties><entry key="project">uuid</entry><entry key="uri">ws://x</entry><entry key="user">root</entry></properties>`);
  writeFile(path.join(root, 'src', 'core', 'com', 'foo', 'Bar.java'), 'public class Bar {}');
  writeFile(path.join(root, 'src', 'core', 'New.java'), 'public class New {}');
  writeFile(path.join(root, 'src', 'res', 'a.txt'), 'hello');
  writeFile(path.join(root, 'src', 'core', '.DS_Store'), 'junk');
  return root;
}

function makeInvoker(cloud: Partial<Record<string, Record<string, JavaDto>>>): RpcInvoker {
  return {
    connect: async () => ({ userCode: 'root' } as any),
    disconnect: async () => {},
    close: async () => {},
    call: (async (method: string, ...args: any[]) => {
      if (method === 'queryCodeFile') return cloud[args[1]] ?? {};
      if (method === 'queryAllFileMap') return cloud['res'] ?? {};
      if (method === 'getJavaCode') return { code: 'public class Bar {}' };
      throw new Error(`unexpected call ${method}`);
    }) as any,
  };
}

describe('refreshChanges', () => {
  it('returns NORMAL for identical Java, ADDED for local-only, DELETED for cloud-only', async () => {
    const root = makeProject();
    const invoker = makeInvoker({
      core: {
        'com/foo/Bar.java': { md5: 'unchanged-hash', fullClass: 'com.foo.Bar' },
        'Old.java': { md5: 'x', fullClass: 'Old' },
      },
      res: { 'a.txt': { md5: 'wrong-md5' } },
    });
    // computeJavaStatus 走 loose 兜底：本地 'public class Bar {}' 与 remote code 'public class Bar {}' loose 一致 -> NORMAL
    const changes = await refreshChanges('uuid', path.join(root, 'src'), invoker);
    const byRel = Object.fromEntries(changes.map((c) => [c.relativePath, c]));

    expect(byRel['com/foo/Bar.java'].status).toBe('NORMAL');
    expect(byRel['New.java'].status).toBe('ADDED');
    expect(byRel['Old.java'].status).toBe('DELETED_LOCALLY');
    expect(byRel['a.txt'].status).toBe('MODIFIED'); // 云端 md5 与本地字节不一致
    // 忽略 .DS_Store
    expect(byRel['.DS_Store']).toBeUndefined();
  });

  it('marks empty Java (cloud exists) as DELETED_LOCALLY', async () => {
    const root = makeProject();
    // 覆盖 Bar.java 为空内容，云端存在
    writeFile(path.join(root, 'src', 'core', 'com', 'foo', 'Bar.java'), '');
    const invoker = makeInvoker({
      core: { 'com/foo/Bar.java': { md5: 'x', fullClass: 'com.foo.Bar' } },
    });
    const changes = await refreshChanges('uuid', path.join(root, 'src'), invoker);
    expect(changes.find((c) => c.relativePath === 'com/foo/Bar.java')?.status).toBe('DELETED_LOCALLY');
  });

  it('treats NoFolderException as empty cloud (all local ADDED)', async () => {
    const root = makeProject();
    const invoker: RpcInvoker = {
      connect: async () => ({ userCode: 'root' } as any),
      disconnect: async () => {},
      close: async () => {},
      call: (async (method: string) => {
        if (method === 'queryCodeFile') throw { name: 'bap.java.NoFolderException', message: 'NoFolderException' };
        if (method === 'queryAllFileMap') throw { name: 'bap.java.NoFolderException', message: 'NoFolderException' };
        throw new Error('unexpected');
      }) as any,
    };
    const changes = await refreshChanges('uuid', path.join(root, 'src'), invoker);
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.every((c) => c.status === 'ADDED')).toBe(true);
    expect(changes.some((c) => c.status === 'DELETED_LOCALLY')).toBe(false);
  });
});

describe('isNoFolderException', () => {
  it('detects NoFolderException by name/message', () => {
    expect(isNoFolderException({ name: 'bap.java.NoFolderException' })).toBe(true);
    expect(isNoFolderException({ message: 'oops NoFolderException' })).toBe(true);
    expect(isNoFolderException({ name: 'OtherException' })).toBe(false);
  });
});
