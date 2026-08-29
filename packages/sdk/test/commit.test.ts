import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildCommitPackage } from '../src/commit';
import type { Change, CJavaFolderDto, RpcInvoker } from '../src/types';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bap-sdk-commit-'));
}

function makeInvoker(responses: Record<string, unknown>): RpcInvoker {
  return {
    connect: async () => ({ userCode: 'root' } as any),
    disconnect: async () => {},
    close: async () => {},
    call: (async (method: string, ..._args: any[]) => {
      if (method === 'getResFile') return responses.getResFile ?? null;
      if (method === 'getJavaCode') return responses.getJavaCode ?? null;
      throw new Error(`unexpected call ${method}`);
    }) as any,
  };
}

describe('buildCommitPackage', () => {
  it('assembles Java ADDED with owner + underscore uuid, javaPackage parsed', async () => {
    const tmp = mkTmp();
    fs.writeFileSync(path.join(tmp, 'Bar.java'), 'public class Bar {}');
    const changes: Change[] = [
      {
        relativePath: 'com/foo/Bar.java',
        absolutePath: path.join(tmp, 'Bar.java'),
        folder: 'core',
        status: 'ADDED',
        isResource: false,
        fullClass: 'com.foo.Bar',
        md5: 'x',
      },
    ];
    const folders: CJavaFolderDto[] = [{ uuid: 'F1', name: 'core' }];
    const pkg = await buildCommitPackage({
      projectUuid: 'uuid',
      changes,
      comments: 'msg',
      folders,
      invoker: makeInvoker({}),
    });

    const code = pkg.mapFolder2Codes['core']?.[0];
    expect(code).toBeDefined();
    expect(code!.owner).toBe('F1');
    expect(code!.mainClass).toBe('Bar');
    expect(code!.javaPackage).toBe('com.foo');
    expect(code!.code).toBe('public class Bar {}');
    // ADDED: uuid 是下划线格式
    expect(code!.uuid).toMatch(/^[0-9a-f_]+$/);
    expect(code!.uuid).not.toContain('-');
  });

  it('reuses cloud uuid for MODIFIED and strips package for delete', async () => {
    const tmp = mkTmp();
    fs.writeFileSync(path.join(tmp, 'Bar.java'), 'public class Bar {}');
    const changes: Change[] = [];
    // Java MODIFIED
    changes.push({
      relativePath: 'com/foo/Bar.java', absolutePath: path.join(tmp, 'Bar.java'), folder: 'core',
      status: 'MODIFIED', isResource: false, fullClass: 'com.foo.Bar', md5: 'x',
    });
    // Java DELETED
    changes.push({
      relativePath: 'Old.java', absolutePath: path.join(tmp, 'Old.java'), folder: 'core',
      status: 'DELETED_LOCALLY', isResource: false, fullClass: 'Old', md5: '',
    });

    const pkg = await buildCommitPackage({
      projectUuid: 'uuid',
      changes,
      comments: '',
      folders: [{ uuid: 'F1', name: 'core' }],
      invoker: makeInvoker({ getJavaCode: { uuid: 'OLD-UUID' } }),
    });

    expect(pkg.mapFolder2Codes['core']?.[0].uuid).toBe('OLD-UUID');
    expect(pkg.deleteCodeMap['core']).toContain('Old');
  });

  it('assembles resource MODIFIED with base64 fileBin, owner res, and /-prefixed delete', async () => {
    const tmp = mkTmp();
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'hello');
    const changes: Change[] = [
      {
        relativePath: 'sub/a.txt', absolutePath: path.join(tmp, 'a.txt'), folder: 'res',
        status: 'MODIFIED', isResource: true, md5: 'x',
      },
      {
        relativePath: 'gone.txt', absolutePath: '/gone.txt', folder: 'res',
        status: 'DELETED_LOCALLY', isResource: true, md5: '',
      },
    ];
    const pkg = await buildCommitPackage({
      projectUuid: 'uuid',
      changes,
      comments: '',
      folders: [{ uuid: 'F2', name: 'res' }],
      invoker: makeInvoker({ getResFile: { uuid: 'RES-UUID' } }),
    });

    const file = pkg.mapFolder2Files['res']?.[0];
    expect(file).toBeDefined();
    expect(file!.owner).toBe('F2');
    expect(file!.fileBin).toBe(Buffer.from('hello').toString('base64'));
    expect(file!.size).toBe(5);
    expect(file!.filePackage).toBe('sub');
    expect(file!.uuid).toBe('RES-UUID');
    expect(pkg.deleteFileMap['res']).toContain('/gone.txt'); // 前缀 /
  });
});
