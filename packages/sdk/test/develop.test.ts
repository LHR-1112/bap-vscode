import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadDevelop, writeDevelop, SdkError } from '../src/develop';

// 密码用占位符，避免把真实凭据写进仓库（解析逻辑不依赖密码具体值）
const PWD_TOKEN = 'test-pwd-token';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bap-dev-'));
}

describe('loadDevelop', () => {
  it('解析 entry-key 格式（Java properties XML）', () => {
    const root = mkTmp();
    fs.writeFileSync(
      path.join(root, '.develop'),
      `<properties><entry key="project">abc</entry><entry key="uri">ws://h:1</entry><entry key="user">root</entry><entry key="pwd">${PWD_TOKEN}</entry></properties>`,
    );
    const cfg = loadDevelop(root);
    expect(cfg.projectUuid).toBe('abc');
    expect(cfg.uri).toBe('ws://h:1');
    expect(cfg.user).toBe('root');
    expect(cfg.pwd).toBe(PWD_TOKEN);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('解析属性格式（<Development Project=... Uri=... />）', () => {
    const root = mkTmp();
    fs.writeFileSync(
      path.join(root, '.develop'),
      `<?xml version="1.0" encoding="UTF-8"?>\n<Development Project="2a7c333b_116e_48e8_a913_1feebcea1e5d" Uri="ws://175.178.82.117:2020" AdminTool="bap.client.BapMainFrame" User="root" Password="${PWD_TOKEN}" LocalNioPort="-1"/>`,
    );
    const cfg = loadDevelop(root);
    expect(cfg.projectUuid).toBe('2a7c333b_116e_48e8_a913_1feebcea1e5d');
    expect(cfg.uri).toBe('ws://175.178.82.117:2020');
    expect(cfg.user).toBe('root');
    expect(cfg.pwd).toBe(PWD_TOKEN);
    expect(cfg.adminTool).toBe('bap.client.BapMainFrame');
    expect(cfg.localNioPort).toBe('-1');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('缺 projectUuid / uri 抛 CONFIG_INCOMPLETE', () => {
    const root = mkTmp();
    fs.writeFileSync(path.join(root, '.develop'), `<properties><entry key="user">root</entry></properties>`);
    expect(() => loadDevelop(root)).toThrow(SdkError);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('文件不存在抛 MISSING_DEVELOP', () => {
    const root = mkTmp();
    expect(() => loadDevelop(root)).toThrow();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('writeDevelop', () => {
  it('写入后可被 loadDevelop 读回（含 XML 转义）', () => {
    const root = mkTmp();
    writeDevelop(root, {
      projectUuid: 'uuid_1',
      uri: 'ws://h:1',
      user: 'u&s<er>',
      pwd: `p"wd'#${PWD_TOKEN}`,
      adminTool: 'bap.client.BapMainFrame',
    });
    const cfg = loadDevelop(root);
    expect(cfg.projectUuid).toBe('uuid_1');
    expect(cfg.uri).toBe('ws://h:1');
    expect(cfg.user).toBe('u&s<er>');
    expect(cfg.pwd).toBe(`p"wd'#${PWD_TOKEN}`);
    expect(cfg.adminTool).toBe('bap.client.BapMainFrame');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('未传 adminTool 时写入默认值', () => {
    const root = mkTmp();
    writeDevelop(root, { projectUuid: 'uuid_2', uri: 'ws://h:2', user: 'u', pwd: PWD_TOKEN });
    const cfg = loadDevelop(root);
    expect(cfg.adminTool).toBe('bap.client.BapMainFrame');
    fs.rmSync(root, { recursive: true, force: true });
  });
});
