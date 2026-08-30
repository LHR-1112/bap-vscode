import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadRelocateHistory, saveRelocateHistory, addRelocateHistory, removeRelocateHistory, type RelocateProfile } from '../src/relocate';

const PWD_TOKEN = 'test-pwd-token';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bap-reloc-'));
}

function profile(p: Partial<RelocateProfile> = {}): RelocateProfile {
  return {
    uri: 'ws://h:1',
    user: 'root',
    pwd: PWD_TOKEN,
    projectUuid: 'uuid_a',
    projectName: 'A',
    ...p,
  };
}

describe('relocate history', () => {
  it('文件不存在返回 []', () => {
    const root = mkTmp();
    expect(loadRelocateHistory(root)).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('add 去重按 uri+projectUuid 且置顶、截断上限 10', () => {
    const root = mkTmp();
    let list: RelocateProfile[] = [];
    for (let i = 0; i < 12; i++) list = addRelocateHistory(root, profile({ uri: `ws://h:${i}`, projectUuid: `uuid_${i}` }));
    expect(list).toHaveLength(10);
    expect(list[0].uri).toBe('ws://h:11');
    // 重复 uri+projectUuid 去重并置顶
    list = addRelocateHistory(root, profile({ uri: 'ws://h:5', projectUuid: 'uuid_5' }));
    expect(list).toHaveLength(10);
    expect(list[0].uri).toBe('ws://h:5');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('save 后 load 读回且写入 .bap 目录', () => {
    const root = mkTmp();
    const list = [profile(), profile({ uri: 'ws://h:2', projectUuid: 'uuid_b', projectName: 'B' })];
    saveRelocateHistory(root, list);
    expect(fs.existsSync(path.join(root, '.bap', 'relocate-history.json'))).toBe(true);
    expect(loadRelocateHistory(root)).toHaveLength(2);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('remove 按 uri+projectUuid 移除一条', () => {
    const root = mkTmp();
    addRelocateHistory(root, profile({ uri: 'ws://h:1', projectUuid: 'uuid_1' }));
    addRelocateHistory(root, profile({ uri: 'ws://h:2', projectUuid: 'uuid_2' }));
    expect(loadRelocateHistory(root)).toHaveLength(2);
    removeRelocateHistory(root, profile({ uri: 'ws://h:1', projectUuid: 'uuid_1' }));
    const rest = loadRelocateHistory(root);
    expect(rest).toHaveLength(1);
    expect(rest[0].uri).toBe('ws://h:2');
    fs.rmSync(root, { recursive: true, force: true });
  });
});
