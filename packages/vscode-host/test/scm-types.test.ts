import { describe, it, expect } from 'vitest';
import {
  fileDecoFor,
  scmDecoFor,
  iconFor,
  statusIconFile,
  relToFullClass,
  relToResPath,
  bapOriginalUriSpec,
  parseBapOriginalUri,
  groupToStatus,
} from '../src/scm/types';

describe('scm/types 纯函数', () => {
  it('fileDecoFor 映射 M/A/D 徽标，NORMAL 无', () => {
    expect(fileDecoFor('MODIFIED')).toMatchObject({ badge: 'M' });
    expect(fileDecoFor('ADDED')).toMatchObject({ badge: 'A' });
    expect(fileDecoFor('DELETED_LOCALLY')).toMatchObject({ badge: 'D' });
    expect(fileDecoFor('NORMAL')).toBeUndefined();
    expect(fileDecoFor('MODIFIED')?.color).toBe('charts.yellow');
  });

  it('scmDecoFor 行内装饰：MODIFIED tooltip、ADDED faded、DELETED strikeThrough', () => {
    expect(scmDecoFor('MODIFIED')?.tooltip).toBe('M 已修改');
    expect(scmDecoFor('ADDED')?.faded).toBe(true);
    expect(scmDecoFor('DELETED_LOCALLY')?.strikeThrough).toBe(true);
    expect(scmDecoFor('NORMAL')).toBeUndefined();
  });

  it('iconFor 映射 M/A/D 到 codicon 图标', () => {
    expect(iconFor('MODIFIED')).toBe('edit');
    expect(iconFor('ADDED')).toBe('add');
    expect(iconFor('DELETED_LOCALLY')).toBe('circle-outline');
  });

  it('groupToStatus 映射组 id 到状态', () => {
    expect(groupToStatus('added')).toBe('ADDED');
    expect(groupToStatus('modified')).toBe('MODIFIED');
    expect(groupToStatus('deleted')).toBe('DELETED_LOCALLY');
    expect(groupToStatus('unknown')).toBeUndefined();
  });

  it('statusIconFile 返回 M/A/D 状态的 SVG 文件名', () => {
    expect(statusIconFile('MODIFIED')).toBe('status-modified.svg');
    expect(statusIconFile('ADDED')).toBe('status-added.svg');
    expect(statusIconFile('DELETED_LOCALLY')).toBe('status-deleted.svg');
    expect(statusIconFile('NORMAL')).toBeUndefined();
  });

  it('relToFullClass 剥 java 扩展名转包路径', () => {
    expect(relToFullClass('com/foo/Bar.java', false)).toBe('com.foo.Bar');
    expect(relToFullClass('a.txt', true)).toBeUndefined();
  });

  it('relToResPath 补 / 前缀', () => {
    expect(relToResPath('a/b.txt')).toBe('/a/b.txt');
    expect(relToResPath('/a/b.txt')).toBe('/a/b.txt');
  });

  it('bapOriginalUriSpec 生成可被 parse 反推的 URI', () => {
    const spec = bapOriginalUriSpec('/ws', 'com/foo/Bar.java', 'core', false);
    // 解析
    const u = new URL(spec);
    const query: Record<string, string> = {};
    u.searchParams.forEach((v, k) => (query[k] = v));
    const parsed = parseBapOriginalUri(u.pathname, query);
    expect(parsed.folder).toBe('core');
    expect(parsed.isResource).toBe(false);
    // pathname 是 encoded rel（含 / 前缀 bap/）
    expect(parsed.relativePath).toBe('com/foo/Bar.java');
  });

  it('parseBapOriginalUri 资源/路径正确', () => {
    const spec = bapOriginalUriSpec('/ws', 'a/b.txt', 'res', true);
    const u = new URL(spec);
    const query: Record<string, string> = {};
    u.searchParams.forEach((v, k) => (query[k] = v));
    const parsed = parseBapOriginalUri(u.pathname, query);
    expect(parsed.isResource).toBe(true);
    expect(parsed.folder).toBe('res');
    expect(parsed.relativePath).toBe('a/b.txt');
  });

  it('parseBapOriginalUri 优先 query.rel（path 段可能是 workspace 相对路径，勿用于定位云端）', () => {
    // openDiff/quickDiff 生成的 URI：path 段是相对 workspace（含 src/res 前缀），query.rel 才是相对 src/res 的权威路径
    const q = new URLSearchParams();
    q.set('folder', 'res');
    q.set('res', 'true');
    q.set('rel', 'pt/config/QyWxNoticeConfig.json');
    const uri = `bap-original://bap/${encodeURIComponent('src/res/pt/config/QyWxNoticeConfig.json')}?${q.toString()}`;
    const u = new URL(uri);
    const query: Record<string, string> = {};
    u.searchParams.forEach((v, k) => (query[k] = v));
    const parsed = parseBapOriginalUri(u.pathname, query);
    expect(parsed.relativePath).toBe('pt/config/QyWxNoticeConfig.json');
    expect(parsed.isResource).toBe(true);
    expect(parsed.folder).toBe('res');
  });
});
