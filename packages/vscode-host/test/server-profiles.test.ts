import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readActiveBusDomainCode } from '../src/projects/server-profiles';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bap-sp-'));
  fs.mkdirSync(path.join(tmp, '.votaforge'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** 写 server-profiles.json；value 为字符串时按原文写入（用于非法 JSON）。 */
function writeProfiles(value: unknown): string {
  const file = path.join(tmp, '.votaforge', 'server-profiles.json');
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  return file;
}

describe('readActiveBusDomainCode', () => {
  it('1) activeProfileId + profiles[] 返回命中 profile 的 busDomainCode', () => {
    writeProfiles({
      activeProfileId: 'prod',
      profiles: [
        { id: 'dev', busDomainCode: 'D_DEV' },
        { id: 'prod', busDomainCode: 'D_PROD' },
      ],
    });
    expect(readActiveBusDomainCode(tmp)).toBe('D_PROD');
  });

  it('2) 无 activeProfileId 返回 undefined（不猜测第一个 profile）', () => {
    writeProfiles({ profiles: [{ id: 'dev', busDomainCode: 'D_DEV' }] });
    expect(readActiveBusDomainCode(tmp)).toBeUndefined();
  });

  it('3) profiles 非数组 / JSON 非法 / 文件缺失一律 undefined，不抛错', () => {
    writeProfiles({ activeProfileId: 'prod', profiles: 'not-an-array' });
    expect(readActiveBusDomainCode(tmp)).toBeUndefined();

    writeProfiles('{ not-json');
    expect(readActiveBusDomainCode(tmp)).toBeUndefined();

    fs.rmSync(path.join(tmp, '.votaforge'), { recursive: true, force: true });
    expect(readActiveBusDomainCode(tmp)).toBeUndefined();
  });

  it('4) 文件超过 256 KiB 返回 undefined', () => {
    writeProfiles({
      activeProfileId: 'prod',
      profiles: [{ id: 'prod', busDomainCode: 'D_PROD' }],
      padding: 'x'.repeat(256 * 1024 + 64),
    });
    expect(readActiveBusDomainCode(tmp)).toBeUndefined();
  });

  it('5) 命中 profile 无 busDomainCode 返回 undefined', () => {
    writeProfiles({
      activeProfileId: 'prod',
      profiles: [{ id: 'prod', name: '生产' }],
    });
    expect(readActiveBusDomainCode(tmp)).toBeUndefined();
  });

  it('6) 只读：读取前后文件内容一致', () => {
    const file = writeProfiles({
      activeProfileId: 'prod',
      profiles: [{ id: 'prod', busDomainCode: 'D_PROD' }],
    });
    const before = fs.readFileSync(file, 'utf8');
    expect(readActiveBusDomainCode(tmp)).toBe('D_PROD');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('7) 多个 profile 时只取 activeProfileId 指向的那个，不取第一个', () => {
    writeProfiles({
      activeProfileId: 'second',
      profiles: [
        { id: 'first', busDomainCode: 'FIRST' },
        { id: 'second', busDomainCode: 'SECOND' },
        { id: 'third', busDomainCode: 'THIRD' },
      ],
    });
    expect(readActiveBusDomainCode(tmp)).toBe('SECOND');
  });

  it('8) 兼容旧 activeProfile 对象；activeProfileId 存在时优先', () => {
    writeProfiles({
      activeProfileId: 'prod',
      profiles: [{ id: 'prod', busDomainCode: 'FROM_PROFILES' }],
      activeProfile: { busDomainCode: 'FROM_LEGACY' },
    });
    expect(readActiveBusDomainCode(tmp)).toBe('FROM_PROFILES');

    writeProfiles({ activeProfile: { busDomainCode: 'FROM_LEGACY' } });
    expect(readActiveBusDomainCode(tmp)).toBe('FROM_LEGACY');
  });

  it('10) activeProfileId 存在但无法解析/无域时不回退旧 activeProfile', () => {
    writeProfiles({
      activeProfileId: 'missing',
      profiles: [{ id: 'dev', busDomainCode: 'D_DEV' }],
      activeProfile: { busDomainCode: 'FROM_LEGACY' },
    });
    expect(readActiveBusDomainCode(tmp)).toBeUndefined();

    writeProfiles({
      activeProfileId: 'prod',
      profiles: [{ id: 'prod', name: '无域 profile' }],
      activeProfile: { busDomainCode: 'FROM_LEGACY' },
    });
    expect(readActiveBusDomainCode(tmp)).toBeUndefined();
  });

  it('9) 返回值去空白后直接可用（不依赖 listDomains 候选校验）', () => {
    writeProfiles({
      activeProfileId: 'p',
      profiles: [{ id: 'p', busDomainCode: '  CUSTOM_DOMAIN_9  ' }],
    });
    const code = readActiveBusDomainCode(tmp);
    expect(code).toBe('CUSTOM_DOMAIN_9');
    // 函数不接触服务器候选列表：任何非空 busDomainCode 都原样返回。
    expect(code?.length).toBeGreaterThan(0);
  });
});
