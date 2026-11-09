import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadDevelop, writeDevelop, SdkError } from '../src/develop';
import { validateMetadataDomainCode } from '../src/metadata';

// 密码用占位符，避免把真实凭据写进仓库（解析逻辑不依赖密码具体值）
const PWD_TOKEN = 'test-pwd-token';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bap-dev-'));
}

/** 断言同步抛出的 SdkError.code。 */
function expectSdkCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SdkError);
    expect((e as SdkError).code).toBe(code);
    return;
  }
  throw new Error(`预期抛出 SdkError(${code})，但没有抛错`);
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

describe('MetadataDomain（只读兼容）', () => {
  it('属性格式解析 MetadataDomain（大小写不敏感）', () => {
    const root = mkTmp();
    fs.writeFileSync(
      path.join(root, '.develop'),
      `<Development Project="p" Uri="ws://h:1" User="root" Password="${PWD_TOKEN}" MetadataDomain="D1"/>`,
    );
    expect(loadDevelop(root).metadataDomain).toBe('D1');
    fs.rmSync(root, { recursive: true, force: true });

    const lower = mkTmp();
    fs.writeFileSync(
      path.join(lower, '.develop'),
      `<Development Project="p" Uri="ws://h:1" User="root" Password="${PWD_TOKEN}" metadatadomain="D1b"/>`,
    );
    expect(loadDevelop(lower).metadataDomain).toBe('D1b');
    fs.rmSync(lower, { recursive: true, force: true });
  });

  it('entry-key 格式解析 MetadataDomain（大小写不敏感）', () => {
    for (const key of ['MetadataDomain', 'metadataDomain', 'METADATADOMAIN']) {
      const root = mkTmp();
      fs.writeFileSync(
        path.join(root, '.develop'),
        `<properties><entry key="project">p</entry><entry key="uri">ws://h:1</entry><entry key="${key}">D2</entry></properties>`,
      );
      expect(loadDevelop(root).metadataDomain).toBe('D2');
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('空值 MetadataDomain 视为未配置（属性与 entry 两种格式）', () => {
    const attrRoot = mkTmp();
    fs.writeFileSync(
      path.join(attrRoot, '.develop'),
      `<Development Project="p" Uri="ws://h:1" User="root" Password="${PWD_TOKEN}" MetadataDomain="   "/>`,
    );
    expect(loadDevelop(attrRoot).metadataDomain).toBeUndefined();
    fs.rmSync(attrRoot, { recursive: true, force: true });

    const entryRoot = mkTmp();
    fs.writeFileSync(
      path.join(entryRoot, '.develop'),
      `<properties><entry key="project">p</entry><entry key="uri">ws://h:1</entry><entry key="MetadataDomain"></entry></properties>`,
    );
    expect(loadDevelop(entryRoot).metadataDomain).toBeUndefined();
    fs.rmSync(entryRoot, { recursive: true, force: true });
  });

  it('注释里的 MetadataDomain 不解析；entry 文本里的伪属性也不解析', () => {
    const root = mkTmp();
    fs.writeFileSync(
      path.join(root, '.develop'),
      `<!-- MetadataDomain="FAKE" --><Development Project="p" Uri="ws://h:1" User="root" Password="${PWD_TOKEN}"/>`,
    );
    expect(loadDevelop(root).metadataDomain).toBeUndefined();
    fs.rmSync(root, { recursive: true, force: true });

    const entry = mkTmp();
    fs.writeFileSync(
      path.join(entry, '.develop'),
      `<properties><entry key="project">p</entry><entry key="uri">ws://h:1</entry><entry key="note">MetadataDomain="FAKE"</entry></properties>`,
    );
    expect(loadDevelop(entry).metadataDomain).toBeUndefined();
    fs.rmSync(entry, { recursive: true, force: true });
  });

  it('属性值内可含另一种引号（密码/域不会被截断）', () => {
    const root = mkTmp();
    fs.writeFileSync(
      path.join(root, '.develop'),
      `<Development Project="p" Uri="ws://h:1" User="root" Password="ab'cd" MetadataDomain="dealer's-domain"/>`,
    );
    const cfg = loadDevelop(root);
    expect(cfg.pwd).toBe("ab'cd");
    expect(cfg.metadataDomain).toBe("dealer's-domain");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('writeDevelop 保留原文件已有的 MetadataDomain（重定向不擦除 IDEA 写入值）', () => {
    const root = mkTmp();
    fs.writeFileSync(
      path.join(root, '.develop'),
      `<Development Project="old" Uri="ws://old:1" User="u" Password="${PWD_TOKEN}" MetadataDomain="KEEP"/>`,
    );
    writeDevelop(root, { projectUuid: 'new', uri: 'ws://new:1', user: 'u2', pwd: PWD_TOKEN });

    const cfg = loadDevelop(root);
    expect(cfg.projectUuid).toBe('new');
    expect(cfg.uri).toBe('ws://new:1');
    expect(cfg.metadataDomain).toBe('KEEP');
    expect(fs.readFileSync(path.join(root, '.develop'), 'utf8')).toContain('MetadataDomain="KEEP"');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('writeDevelop 也保留 entry-key 格式的既有 MetadataDomain', () => {
    const root = mkTmp();
    fs.writeFileSync(
      path.join(root, '.develop'),
      `<properties><entry key="project">old</entry><entry key="uri">ws://old:1</entry><entry key="user">u</entry><entry key="pwd">${PWD_TOKEN}</entry><entry key="MetadataDomain">ENTRY_KEEP</entry></properties>`,
    );
    writeDevelop(root, { projectUuid: 'new', uri: 'ws://new:1', user: 'u2', pwd: PWD_TOKEN });

    const cfg = loadDevelop(root);
    expect(cfg.projectUuid).toBe('new');
    expect(cfg.metadataDomain).toBe('ENTRY_KEEP');
    expect(fs.readFileSync(path.join(root, '.develop'), 'utf8')).toContain('MetadataDomain="ENTRY_KEEP"');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('writeDevelop 在原文件无 MetadataDomain 时不新增', () => {
    const root = mkTmp();
    fs.writeFileSync(
      path.join(root, '.develop'),
      `<Development Project="old" Uri="ws://old:1" User="u" Password="${PWD_TOKEN}"/>`,
    );
    writeDevelop(root, { projectUuid: 'new', uri: 'ws://new:1', user: 'u2', pwd: PWD_TOKEN });
    expect(fs.readFileSync(path.join(root, '.develop'), 'utf8')).not.toContain('MetadataDomain');

    // .develop 缺失时同样不写域
    const empty = mkTmp();
    writeDevelop(empty, { projectUuid: 'p', uri: 'ws://h:1', user: 'u', pwd: PWD_TOKEN });
    expect(fs.readFileSync(path.join(empty, '.develop'), 'utf8')).not.toContain('MetadataDomain');
    expect(loadDevelop(empty).metadataDomain).toBeUndefined();

    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(empty, { recursive: true, force: true });
  });

  it('.develop 缺失抛 MISSING_DEVELOP；格式非法抛 CONFIG_INCOMPLETE', () => {
    const missing = mkTmp();
    expectSdkCode(() => loadDevelop(missing), 'MISSING_DEVELOP');
    fs.rmSync(missing, { recursive: true, force: true });

    const invalid = mkTmp();
    fs.writeFileSync(path.join(invalid, '.develop'), `<properties><entry key="user">root</entry></properties>`);
    expectSdkCode(() => loadDevelop(invalid), 'CONFIG_INCOMPLETE');
    fs.rmSync(invalid, { recursive: true, force: true });
  });
});

describe('validateMetadataDomainCode', () => {
  it('合法值 trim 后返回', () => {
    expect(validateMetadataDomainCode('D1')).toBe('D1');
    expect(validateMetadataDomainCode('  D1  ')).toBe('D1');
    expect(validateMetadataDomainCode('domain_1.v2')).toBe('domain_1.v2');
  });

  it('空值/控制字符/非字符串抛 METADATA_DOMAIN_INVALID', () => {
    expectSdkCode(() => validateMetadataDomainCode(''), 'METADATA_DOMAIN_INVALID');
    expectSdkCode(() => validateMetadataDomainCode('   '), 'METADATA_DOMAIN_INVALID');
    expectSdkCode(() => validateMetadataDomainCode('D\u0000'), 'METADATA_DOMAIN_INVALID');
    expectSdkCode(() => validateMetadataDomainCode('D\u001f1'), 'METADATA_DOMAIN_INVALID');
    expectSdkCode(() => validateMetadataDomainCode('D\u007f'), 'METADATA_DOMAIN_INVALID');
    expectSdkCode(
      () => validateMetadataDomainCode(123 as unknown as string),
      'METADATA_DOMAIN_INVALID',
    );
  });
});
