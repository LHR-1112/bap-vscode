import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveProjectLayout } from '../src/compile';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bap-compile-'));
}

describe('resolveProjectLayout', () => {
  it('.classpath 解析 src/lib/output（忽略 con）', () => {
    const root = mkTmp();
    fs.mkdirSync(path.join(root, 'src', 'core'), { recursive: true });
    fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(root, 'lib', 'x.jar'), 'x');
    fs.writeFileSync(
      path.join(root, '.classpath'),
      `<classpath><classpathentry kind="src" path="src/core"/><classpathentry kind="lib" path="lib/x.jar"/><classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/><classpathentry kind="output" path="target/build"/></classpath>`,
    );
    const layout = resolveProjectLayout(root);
    expect(layout.mode).toBe('eclipse');
    expect(layout.sourceRoots).toContain(path.join(root, 'src', 'core'));
    expect(layout.libraryFiles).toContain(path.join(root, 'lib', 'x.jar'));
    expect(layout.outputDir).toBe(path.join(root, 'target', 'build'));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('约定：src 子目录 + lib/** 递归 jar/zip + 输出 bin', () => {
    const root = mkTmp();
    fs.mkdirSync(path.join(root, 'src', 'core'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src', 'res'), { recursive: true });
    fs.mkdirSync(path.join(root, 'lib', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'lib', 'a.jar'), 'a');
    fs.writeFileSync(path.join(root, 'lib', 'sub', 'b.zip'), 'b');
    fs.writeFileSync(path.join(root, 'lib', 'c.txt'), 'c');
    const layout = resolveProjectLayout(root);
    expect(layout.mode).toBe('convention');
    expect(layout.sourceRoots).toEqual(
      expect.arrayContaining([path.join(root, 'src', 'core'), path.join(root, 'src', 'res')]),
    );
    // lib 递归留 jar/zip，忽略 txt；且不包含上层的 src/lib
    const libNames = layout.libraryFiles.map((p) => path.basename(p));
    expect(libNames).toContain('a.jar');
    expect(libNames).toContain('b.zip');
    expect(libNames).not.toContain('c.txt');
    expect(layout.outputDir).toBe(path.join(root, 'bin'));
    expect(layout.classpathFile).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });
});
