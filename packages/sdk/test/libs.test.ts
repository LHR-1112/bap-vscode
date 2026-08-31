import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanLibMd5 } from '../src/libs';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bap-libs-'));
}

describe('scanLibMd5', () => {
  it('按子目录归类 md5，读 dao_model.tag', () => {
    const root = mkTmp();
    const platform = path.join(root, 'lib', 'platform');
    const project = path.join(root, 'lib', 'project');
    const plugin = path.join(root, 'lib', 'plugin');
    const model = path.join(root, 'lib', 'model');
    fs.mkdirSync(platform, { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(plugin, { recursive: true });
    fs.mkdirSync(model, { recursive: true });

    fs.writeFileSync(path.join(platform, 'p.jar'), 'plat-bytes');
    fs.mkdirSync(path.join(project, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(project, 'sub', 'pr.jar'), 'proj-bytes');
    fs.writeFileSync(path.join(plugin, 'pl.jar'), 'plug-bytes');
    fs.writeFileSync(path.join(model, 'dao_model.tag'), '123');

    const md5 = scanLibMd5(root);
    expect(md5.daoTag).toBe(123);
    expect(Object.keys(md5.platformMd5)).toEqual(['p.jar']);
    expect(Object.keys(md5.projectMd5)).toEqual(['sub/pr.jar']); // 相对路径含子目录
    expect(Object.keys(md5.pluginMd5)).toEqual(['pl.jar']); // 扁平文件名
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('无 dao_model.tag 时 daoTag=-1；无 lib 目录时各 map 空', () => {
    const root = mkTmp();
    const md5 = scanLibMd5(root);
    expect(md5.daoTag).toBe(-1);
    expect(md5.platformMd5).toEqual({});
    expect(md5.projectMd5).toEqual({});
    expect(md5.pluginMd5).toEqual({});
    fs.rmSync(root, { recursive: true, force: true });
  });
});
